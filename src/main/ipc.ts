import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import type { BudgetRow } from '../types/domain';
import { Companies, Settings, Runs, RunRows, RunRowCandidates, BudgetCache, VendorAliases, type NewCompany } from './db/repo';
import { Secrets, type QboToken } from './secrets';
import { connectQbo, disconnectQbo } from './oauth-qbo';
import { connectGoogle, getGoogleClient } from './oauth-google';
import { listWorkbooks, listSharedDrives, readBudget } from './budget/gsheets';
import {
  getSpreadsheetMeta,
  readRange,
  updateRange,
  appendRange,
  clearRange,
  batchUpdateValues,
  batchUpdateSpreadsheet,
  addSheet,
  deleteSheet,
  findReplace,
  getDriveFile,
  copyDriveFile,
  renameDriveFile,
  type CellRow,
  type ValueInputOption,
  type InsertDataOption,
} from './budget/gsheets-write';
import type { sheets_v4 } from 'googleapis';
import { readExcelBudget } from './budget/excel';
import { normalizeVendors } from './budget/normalize';
import { ExtractionEngine } from './extraction/engine';
import { onQboRequest } from './qbo/client';

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null) {
  const engine = new ExtractionEngine(() => getMainWindow()?.webContents ?? null);

  // Forward every QBO HTTP request (v3 API only — signed-URL CDN downloads
  // don't count toward Intuit's rate limit, so they're filtered upstream)
  // to the renderer so the Extraction screen can show real req/min cadence.
  onQboRequest((evt) => {
    const wc = getMainWindow()?.webContents;
    wc?.send('qbo:request', evt);
  });

  ipcMain.handle('companies:list', async () => {
    return Companies.list().map(toClientCompany);
  });

  ipcMain.handle('companies:add', async (_evt, payload: NewCompany) => {
    try {
      const company = Companies.add(payload);
      return { ok: true, company: toClientCompany(company) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(
    'companies:update',
    async (_evt, key: string, patch: Record<string, unknown>) => {
      const updated = Companies.update(key, patch as never);
      return updated ? toClientCompany(updated) : null;
    },
  );

  ipcMain.handle('companies:delete', async (_evt, key: string) => {
    await Secrets.deleteQbo(key).catch(() => undefined);
    await Secrets.deleteGoogle(key).catch(() => undefined);
    Companies.delete(key);
    return { ok: true };
  });

  ipcMain.handle('settings:get', async () => Settings.all());
  ipcMain.handle('settings:update', async (_evt, patch: Record<string, string>) => {
    Settings.setMany(patch);
    return Settings.all();
  });

  ipcMain.handle('qbo:connect', async (_evt, companyKey: string, env: 'sandbox' | 'production' = 'sandbox') => {
    try {
      const { realmId } = await connectQbo(companyKey, env);
      return { ok: true, realmId };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('qbo:disconnect', async (_evt, companyKey: string) => {
    await disconnectQbo(companyKey);
    return { ok: true };
  });

  ipcMain.handle('qbo:test', async (_evt, companyKey: string) => {
    const company = Companies.get(companyKey);
    if (!company || !company.qbo_realm_id) {
      return { ok: false, error: 'QBO non connecté pour cette entreprise.' };
    }
    const token = await Secrets.getQbo(companyKey);
    if (!token) return { ok: false, error: 'Token QBO manquant.' };
    const expiresInMs = token.expires_at - Date.now();
    const { QboClient } = await import('./qbo/client');
    const client = new QboClient(companyKey, company.qbo_realm_id, company.qbo_env);
    const res = await client.ping();
    return {
      ...res,
      realmId: company.qbo_realm_id,
      env: company.qbo_env,
      tokenExpiresInSec: Math.round(expiresInMs / 1000),
    };
  });

  ipcMain.handle('qbo:getAppCredsStatus', async () => {
    const creds = await Secrets.getQboAppCreds();
    return {
      configured: !!creds,
      clientIdPreview: creds ? creds.client_id.slice(0, 6) + '…' + creds.client_id.slice(-4) : null,
    };
  });

  ipcMain.handle(
    'qbo:setAppCreds',
    async (_evt, clientId: string, clientSecret: string) => {
      try {
        const id = (clientId ?? '').trim();
        const secret = (clientSecret ?? '').trim();
        if (!id || !secret) return { ok: false, error: 'client_id et client_secret requis.' };
        await Secrets.setQboAppCreds({ client_id: id, client_secret: secret });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle('qbo:deleteAppCreds', async () => {
    await Secrets.deleteQboAppCreds();
    return { ok: true };
  });

  ipcMain.handle('qbo:pickTokenFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Sélectionner un fichier token QBO (.json)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle(
    'qbo:importToken',
    async (
      _evt,
      companyKey: string,
      filePath: string,
      realmId: string,
      env: 'sandbox' | 'production' = 'production',
    ) => {
      try {
        if (!realmId) return { ok: false, error: 'Realm ID (Company ID) manquant.' };
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as {
          access_token: string;
          refresh_token: string;
          expires_in?: number;
          expires_at?: number;
          x_refresh_token_expires_in?: number;
        };
        if (!parsed.access_token || !parsed.refresh_token) {
          return { ok: false, error: 'Fichier token invalide (access_token/refresh_token manquant).' };
        }
        const now = Date.now();
        // expires_at is seconds-since-epoch in the test files; convert if small enough.
        const expiresAtMs =
          typeof parsed.expires_at === 'number' && parsed.expires_at < 1e12
            ? Math.round(parsed.expires_at * 1000)
            : typeof parsed.expires_at === 'number'
            ? parsed.expires_at
            : now + (parsed.expires_in ?? 3600) * 1000;
        const refreshExpiresAtMs = now + (parsed.x_refresh_token_expires_in ?? 8726400) * 1000;

        const token: QboToken = {
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token,
          expires_at: expiresAtMs,
          refresh_expires_at: refreshExpiresAtMs,
          realm_id: realmId,
          env,
        };
        await Secrets.setQbo(companyKey, token);
        Companies.update(companyKey, {
          qbo_realm_id: realmId,
          qbo_env: env,
          qbo_connected: 1,
        });
        return { ok: true };
      } catch (err) {
        console.error('[qbo:importToken] failed', err);
        return { ok: false, error: detailedErrMsg(err) };
      }
    },
  );

  ipcMain.handle('google:connect', async (_evt, companyKey: string) => {
    try {
      const { email } = await connectGoogle(companyKey);
      Companies.update(companyKey, { gsheets_connected: 1, gsheets_account_email: email });
      return { ok: true, email };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('google:disconnect', async (_evt, companyKey: string) => {
    await Secrets.deleteGoogle(companyKey);
    Companies.update(companyKey, { gsheets_connected: 0, gsheets_account_email: null });
    return { ok: true };
  });

  ipcMain.handle('google:listWorkbooks', async (_evt, companyKey: string, driveId?: string) => {
    try {
      return { ok: true, workbooks: await listWorkbooks(companyKey, driveId) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('google:listSharedDrives', async (_evt, companyKey: string) => {
    try {
      return { ok: true, drives: await listSharedDrives(companyKey) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(
    'google:pickWorkbook',
    async (_evt, companyKey: string, workbookId: string, workbookName: string) => {
      Companies.update(companyKey, {
        budget_source: 'gsheets',
        gsheets_workbook_id: workbookId,
        gsheets_workbook_name: workbookName,
      });
      return { ok: true };
    },
  );

  // ---- Sheets manipulation ----------------------------------------------

  ipcMain.handle(
    'google:sheetsGetMeta',
    async (_evt, companyKey: string, spreadsheetId: string) => {
      try {
        return { ok: true, meta: await getSpreadsheetMeta(companyKey, spreadsheetId) };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsRead',
    async (_evt, companyKey: string, spreadsheetId: string, range: string) => {
      try {
        return { ok: true, values: await readRange(companyKey, spreadsheetId, range) };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsUpdate',
    async (
      _evt,
      companyKey: string,
      spreadsheetId: string,
      range: string,
      values: CellRow[],
      valueInputOption?: ValueInputOption,
    ) => {
      try {
        const result = await updateRange(
          companyKey,
          spreadsheetId,
          range,
          values,
          valueInputOption,
        );
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsAppend',
    async (
      _evt,
      companyKey: string,
      spreadsheetId: string,
      range: string,
      values: CellRow[],
      valueInputOption?: ValueInputOption,
      insertDataOption?: InsertDataOption,
    ) => {
      try {
        const result = await appendRange(
          companyKey,
          spreadsheetId,
          range,
          values,
          valueInputOption,
          insertDataOption,
        );
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsClear',
    async (_evt, companyKey: string, spreadsheetId: string, range: string) => {
      try {
        const result = await clearRange(companyKey, spreadsheetId, range);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsBatchUpdateValues',
    async (
      _evt,
      companyKey: string,
      spreadsheetId: string,
      data: { range: string; values: CellRow[] }[],
      valueInputOption?: ValueInputOption,
    ) => {
      try {
        const result = await batchUpdateValues(companyKey, spreadsheetId, data, valueInputOption);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsBatchUpdate',
    async (
      _evt,
      companyKey: string,
      spreadsheetId: string,
      requests: sheets_v4.Schema$Request[],
    ) => {
      try {
        const replies = await batchUpdateSpreadsheet(companyKey, spreadsheetId, requests);
        return { ok: true, replies };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsAddSheet',
    async (
      _evt,
      companyKey: string,
      spreadsheetId: string,
      title: string,
      rowCount?: number,
      columnCount?: number,
    ) => {
      try {
        const result = await addSheet(companyKey, spreadsheetId, title, rowCount, columnCount);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsDeleteSheet',
    async (_evt, companyKey: string, spreadsheetId: string, sheetId: number) => {
      try {
        await deleteSheet(companyKey, spreadsheetId, sheetId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:sheetsFindReplace',
    async (
      _evt,
      companyKey: string,
      spreadsheetId: string,
      find: string,
      replacement: string,
      options?: {
        sheetId?: number;
        matchCase?: boolean;
        matchEntireCell?: boolean;
        searchByRegex?: boolean;
        allSheets?: boolean;
      },
    ) => {
      try {
        const result = await findReplace(companyKey, spreadsheetId, find, replacement, options);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // ---- Drive helpers ----------------------------------------------------

  ipcMain.handle(
    'google:driveGetFile',
    async (_evt, companyKey: string, fileId: string) => {
      try {
        return { ok: true, file: await getDriveFile(companyKey, fileId) };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:driveCopyFile',
    async (
      _evt,
      companyKey: string,
      fileId: string,
      newName?: string,
      parentFolderId?: string,
    ) => {
      try {
        const result = await copyDriveFile(companyKey, fileId, newName, parentFolderId);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    'google:driveRenameFile',
    async (_evt, companyKey: string, fileId: string, newName: string) => {
      try {
        await renameDriveFile(companyKey, fileId, newName);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle('excel:pickFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Sélectionner un fichier Excel budget',
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle('excel:setFile', async (_evt, companyKey: string, filePath: string) => {
    Companies.update(companyKey, { budget_source: 'excel', excel_path: filePath });
    return { ok: true };
  });

  ipcMain.handle('budget:read', async (_evt, companyKey: string) => {
    const company = Companies.get(companyKey);
    if (!company) return { ok: false, error: 'Entreprise introuvable.' };
    const cached = BudgetCache.get(companyKey);
    return {
      ok: true,
      rows: (cached?.rows as BudgetRow[] | undefined) ?? [],
      lastSync: cached?.syncedAt ?? null,
      source: company.budget_source,
    };
  });

  ipcMain.handle('budget:resync', async (_evt, companyKey: string) => {
    const company = Companies.get(companyKey);
    if (!company) return { ok: false, error: 'Entreprise introuvable.' };
    try {
      let rows: BudgetRow[] = [];
      if (company.budget_source === 'gsheets' && company.gsheets_workbook_id) {
        rows = await readBudget(companyKey, company.gsheets_workbook_id);
      } else if (company.budget_source === 'excel' && company.excel_path) {
        rows = readExcelBudget(company.excel_path);
      } else {
        return { ok: false, error: 'Aucune source de budget configurée.' };
      }
      const aliasMap = VendorAliases.mapByCompany(companyKey);
      const { rows: normalized, clusters, unknownVendors } = normalizeVendors(rows, aliasMap);
      BudgetCache.set(companyKey, normalized);
      return { ok: true, rows: normalized, lastSync: Date.now(), clusters, unknownVendors };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('vendors:list', async (_evt, companyKey: string) => {
    const aliases = VendorAliases.listByCompany(companyKey);
    return aliases.map((a) => ({
      rawName: a.raw_name,
      canonicalName: a.canonical_name,
      updatedAt: a.updated_at,
    }));
  });

  ipcMain.handle(
    'vendors:upsert',
    async (_evt, companyKey: string, rawName: string, canonicalName: string) => {
      VendorAliases.upsert(companyKey, rawName, canonicalName);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'vendors:upsertMany',
    async (_evt, companyKey: string, entries: { rawName: string; canonicalName: string }[]) => {
      VendorAliases.upsertMany(companyKey, entries);
      return { ok: true };
    },
  );

  ipcMain.handle('vendors:delete', async (_evt, companyKey: string, rawName: string) => {
    VendorAliases.delete(companyKey, rawName);
    return { ok: true };
  });

  ipcMain.handle(
    'vendors:rename',
    async (_evt, companyKey: string, oldName: string, newName: string) => {
      VendorAliases.renameCanonical(companyKey, oldName, newName);
      return { ok: true };
    },
  );

  ipcMain.handle('extraction:start', async (_evt, companyKey: string, rowIds: string[]) => {
    const cached = BudgetCache.get(companyKey);
    if (!cached) return { ok: false, error: 'Aucun budget en cache — synchroniser d\'abord.' };
    const allRows = cached.rows as BudgetRow[];
    const selected = rowIds.length > 0 ? allRows.filter((r) => rowIds.includes(r.id)) : allRows;
    if (selected.length === 0) return { ok: false, error: 'Aucune ligne à extraire.' };
    const res = await engine.start(companyKey, selected);
    if ('error' in res) return { ok: false, error: res.error };
    return { ok: true, runId: res.runId };
  });

  ipcMain.handle('extraction:pause', async () => {
    engine.pause();
    return { ok: true };
  });
  ipcMain.handle('extraction:resume', async () => {
    engine.resume();
    return { ok: true };
  });
  ipcMain.handle('extraction:stop', async () => {
    engine.stop();
    return { ok: true };
  });

  // List the QBO candidates persisted for an ambiguous run row, decoded into
  // a renderer-friendly shape (attachable_kinds JSON expanded).
  ipcMain.handle('extraction:listCandidates', async (_evt, runRowId: string) => {
    const rows = RunRowCandidates.listByRow(runRowId);
    return rows.map((r) => ({
      id: r.id,
      runRowId: r.run_row_id,
      txnId: r.qbo_txn_id,
      txnType: r.qbo_txn_type,
      vendorName: r.vendor_name,
      txnDate: r.txn_date,
      totalAmount: r.total_amount,
      docNumber: r.doc_number,
      attachableCount: r.attachable_count,
      attachableKinds: safeJsonArray(r.attachable_kinds),
    }));
  });

  // The user picked one candidate — download its attachment, mark the row
  // resolved, and emit an extraction:update so the renderer reflects it
  // without a full reload.
  ipcMain.handle(
    'extraction:resolveCandidate',
    async (
      _evt,
      args: {
        runRowId: string;
        rowId: string;
        txnId: string;
        txnType: 'Bill' | 'Purchase' | 'Invoice';
        companyKey: string;
      },
    ) => {
      const cached = BudgetCache.get(args.companyKey);
      if (!cached) return { ok: false, error: 'Aucun budget en cache.' };
      const row = (cached.rows as BudgetRow[]).find((r) => r.id === args.rowId);
      if (!row) return { ok: false, error: 'Ligne du budget introuvable.' };
      const res = await engine.resolveAmbiguous({
        runRowId: args.runRowId,
        txnId: args.txnId,
        txnType: args.txnType,
        row,
      });
      if (!res.ok) return res;
      // Notify renderer to update the in-memory ExtractionRow.
      const wc = getMainWindow()?.webContents;
      wc?.send('extraction:update', {
        runId: '',
        rowId: args.rowId,
        runRowId: args.runRowId,
        status: res.status,
        filePath: res.filePath,
        txnId: args.txnId,
        txnType: args.txnType,
        counts: { ok: 0, amb: 0, nf: 0, nopj: 0, total: 0, done: 0 },
      });
      return res;
    },
  );

  ipcMain.handle('extraction:dismissCandidates', async (_evt, runRowId: string) => {
    RunRowCandidates.deleteByRow(runRowId);
    return { ok: true };
  });

  ipcMain.handle(
    'companies:setEntityAliases',
    async (_evt, key: string, aliases: string[]) => {
      Companies.setEntityAliases(key, aliases);
      return { ok: true };
    },
  );

  ipcMain.handle('runs:list', async (_evt, companyKey: string) => {
    return Runs.listByCompany(companyKey);
  });
  ipcMain.handle('runs:rows', async (_evt, runId: string) => {
    return RunRows.listByRun(runId);
  });

  ipcMain.handle('logs:open', async () => {
    const p = path.join(app.getPath('userData'), 'app.log');
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, '');
    }
    shell.showItemInFolder(p);
    return { ok: true, path: p };
  });

  ipcMain.handle('logs:tail', async (_evt, lines = 200) => {
    const p = path.join(app.getPath('userData'), 'app.log');
    if (!fs.existsSync(p)) return { ok: true, content: '' };
    const raw = fs.readFileSync(p, 'utf-8');
    const all = raw.split('\n');
    return { ok: true, content: all.slice(-lines).join('\n'), path: p };
  });

  ipcMain.handle('fs:openFolder', async (_evt, folderPath: string) => {
    await shell.openPath(folderPath);
    return { ok: true };
  });
  ipcMain.handle('fs:openUrl', async (_evt, url: string) => {
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle('fs:revealFile', async (_evt, filePath: string) => {
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
  ipcMain.handle('fs:openFile', async (_evt, filePath: string) => {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'Fichier introuvable.' };
    const err = await shell.openPath(filePath);
    if (err) return { ok: false, error: err };
    return { ok: true };
  });

  // List every file extracted for a company, recursively, so the Preview
  // screen can render its left-side file browser.
  ipcMain.handle('fs:listExtractedFiles', async (_evt, companyKey: string) => {
    const company = Companies.get(companyKey);
    if (!company) return { ok: false, error: 'Entreprise introuvable.' };
    const baseFolder = Settings.get('base_folder') ?? path.join(app.getPath('documents'), 'QBO Extracts');
    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim();
    const folder = path.join(baseFolder, sanitize(company.label));
    if (!fs.existsSync(folder)) return { ok: true, folder, files: [] };
    type F = { name: string; path: string; size: number; mtime: number; relDir: string };
    const files: F[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        // Hidden / OS junk we never want to surface.
        if (e.name.startsWith('.')) continue;
        if (e.name === 'Thumbs.db' || e.name === 'desktop.ini') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, rel ? path.join(rel, e.name) : e.name);
        else if (e.isFile()) {
          try {
            const st = fs.statSync(full);
            files.push({
              name: e.name,
              path: full,
              size: st.size,
              mtime: st.mtimeMs,
              relDir: rel,
            });
          } catch {
            /* skip */
          }
        }
      }
    };
    walk(folder, '');
    files.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, folder, files };
  });
  ipcMain.handle('fs:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choisir le dossier de destination',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
  });
}

function toClientCompany(c: ReturnType<typeof Companies.get> & object) {
  return {
    key: c.key,
    label: c.label,
    initials: c.initials,
    color: c.color,
    connected: !!c.qbo_connected && !!c.qbo_realm_id,
    qboEnv: c.qbo_env,
    qboRealmId: c.qbo_realm_id ?? undefined,
    budgetSource: c.budget_source,
    gsheetsWorkbookId: c.gsheets_workbook_id,
    gsheetsWorkbookName: c.gsheets_workbook_name,
    gsheetsEmail: c.gsheets_account_email,
    excelPath: c.excel_path,
    gsheetsConnected: !!c.gsheets_connected,
    entityAliases: safeJsonArray(c.entity_aliases),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function detailedErrMsg(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const parts = [err.message];
    if (code) parts.push(`[${code}]`);
    if (err.stack) parts.push(err.stack.split('\n').slice(0, 3).join(' | '));
    return parts.join(' ');
  }
  return String(err);
}
