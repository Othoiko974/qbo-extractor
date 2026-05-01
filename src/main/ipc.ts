import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import type { BudgetRow } from '../types/domain';
import {
  Companies,
  Projects,
  Settings,
  Runs,
  RunRows,
  RunRowCandidates,
  BudgetCache,
  VendorAliases,
  type NewCompany,
  type ProjectRow,
} from './db/repo';
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
import { createQboClient } from './qbo/factory';
import { isProxyMode, pingProxyHealth } from './qbo/proxy-client';
import { startPairing } from './qbo/proxy-pair';
import {
  estimateRequests,
  estimateDurationSec,
  inspectExtraction,
} from './qbo/extraction-lock';
import {
  exportQboConnection,
  importQboConnection,
  peekPortableMeta,
} from './qbo-portable';
// unpdf is a Node-native PDF text extractor (no DOMMatrix / browser DOM
// dependency, unlike pdf-parse@2 → pdfjs-dist which crashes Electron's
// main process at module load with "ReferenceError: DOMMatrix is not
// defined"). Imported lazily so the bundled main starts without paying
// the parse-time cost.

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
    let tokenExpiresInSec: number | undefined;
    if (isProxyMode(companyKey)) {
      const health = await pingProxyHealth(companyKey);
      if (!health.ok) return { ok: false, error: health.error };
      if (!health.connected) return { ok: false, error: 'Proxy joignable mais aucun realm connecté.' };
      // refresh_expires_in_days → seconds for backward-compat with the UI.
      tokenExpiresInSec = (health.refresh_expires_in_days ?? 0) * 86_400;
    } else {
      const token = await Secrets.getQbo(companyKey);
      if (!token) return { ok: false, error: 'Token QBO manquant.' };
      tokenExpiresInSec = Math.round((token.expires_at - Date.now()) / 1000);
    }
    const client = createQboClient(companyKey, company.qbo_realm_id, company.qbo_env);
    const res = await client.ping();
    return {
      ...res,
      realmId: company.qbo_realm_id,
      env: company.qbo_env,
      tokenExpiresInSec,
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

  ipcMain.handle('qbo:proxy:getConfig', async (_evt, companyKey: string) => {
    const apiKey = companyKey ? await Secrets.getQboProxyApiKey(companyKey) : null;
    return {
      enabled: companyKey ? isProxyMode(companyKey) : false,
      url: Settings.get('qbo_proxy_url') ?? '',
      hasApiKey: !!apiKey,
      apiKeyPreview: apiKey ? apiKey.slice(0, 8) + '…' + apiKey.slice(-4) : null,
    };
  });

  ipcMain.handle(
    'qbo:proxy:setConfig',
    async (
      _evt,
      config: { companyKey: string; enabled: boolean; url: string; apiKey?: string },
    ) => {
      try {
        // Per-company toggle. URL stays global (one Vercel deployment shared
        // by every company on the machine).
        if (config.companyKey) {
          Settings.set(`qbo_proxy_enabled:${config.companyKey}`, config.enabled ? '1' : '0');
        }
        Settings.set('qbo_proxy_url', (config.url ?? '').trim());
        if (
          config.companyKey &&
          typeof config.apiKey === 'string' &&
          config.apiKey.trim().length > 0
        ) {
          await Secrets.setQboProxyApiKey(config.companyKey, config.apiKey.trim());
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle('qbo:proxy:clearKey', async (_evt, companyKey: string) => {
    if (companyKey) await Secrets.deleteQboProxyApiKey(companyKey);
    return { ok: true };
  });

  ipcMain.handle('qbo:proxy:test', async (_evt, companyKey: string) => {
    return pingProxyHealth(companyKey);
  });

  ipcMain.handle('extraction:estimate', async (_evt, rowCount: number) => {
    return {
      requests: estimateRequests(rowCount),
      duration_sec: estimateDurationSec(rowCount),
      requests_per_minute_cap: 500,
    };
  });

  ipcMain.handle('extraction:lockStatus', async (_evt, companyKey: string) => {
    return inspectExtraction(companyKey);
  });

  ipcMain.handle('qbo:proxy:pair', async (_evt, companyKey: string) => {
    if (!companyKey) return { ok: false, error: 'companyKey requis.' };
    try {
      const r = await startPairing(companyKey);
      return { ok: true, realmId: r.realmId, label: r.label };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
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
      const company = Companies.get(companyKey);
      if (!company) return { ok: false, error: 'Entreprise introuvable.' };
      const project = projectForCompany(company);
      if (!project) return { ok: false, error: 'Aucun projet rattaché.' };
      // Write to the project so every company in it sees the same
      // workbook on next budget read. Mirror onto the company too,
      // for back-compat with any legacy reader that still hits the
      // company columns directly.
      Projects.update(project.id, {
        budget_source: 'gsheets',
        gsheets_workbook_id: workbookId,
        gsheets_workbook_name: workbookName,
      });
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
    const company = Companies.get(companyKey);
    if (!company) return { ok: false, error: 'Entreprise introuvable.' };
    const project = projectForCompany(company);
    if (!project) return { ok: false, error: 'Aucun projet rattaché.' };
    // Excel path is technically per-machine (it points to a local
    // file) so writing to the project means all companies see the
    // same path. That's correct for a single-user project workflow
    // but won't survive a portable export — the path stays out of
    // .qboconnect bundles.
    Projects.update(project.id, { budget_source: 'excel', excel_path: filePath });
    Companies.update(companyKey, { budget_source: 'excel', excel_path: filePath });
    return { ok: true };
  });

  ipcMain.handle('budget:read', async (_evt, companyKey: string) => {
    const company = Companies.get(companyKey);
    if (!company) return { ok: false, error: 'Entreprise introuvable.' };
    const project = projectForCompany(company);
    const cached = project ? BudgetCache.get(project.id) : null;
    return {
      ok: true,
      rows: (cached?.rows as BudgetRow[] | undefined) ?? [],
      lastSync: cached?.syncedAt ?? null,
      // Source comes from the project now — every company in the same
      // project shares it. The legacy company.budget_source is the
      // back-compat fallback for v0.1.x DBs that haven't migrated.
      source: project?.budget_source ?? company.budget_source,
    };
  });

  ipcMain.handle('budget:resync', async (_evt, companyKey: string) => {
    const company = Companies.get(companyKey);
    if (!company) return { ok: false, error: 'Entreprise introuvable.' };
    const project = projectForCompany(company);
    if (!project) {
      return {
        ok: false,
        error:
          'Aucun projet rattaché à cette compagnie — recrée la compagnie ou lance la migration v5.',
      };
    }
    try {
      let rows: BudgetRow[] = [];
      if (project.budget_source === 'gsheets' && project.gsheets_workbook_id) {
        // Google OAuth tokens still live per-company (each user
        // connects their own Google account). The fetcher takes the
        // company key so it can pick the right token, even though the
        // workbook id comes from the project.
        rows = await readBudget(companyKey, project.gsheets_workbook_id);
      } else if (project.budget_source === 'excel' && project.excel_path) {
        rows = readExcelBudget(project.excel_path);
      } else {
        return { ok: false, error: 'Aucune source de budget configurée pour ce projet.' };
      }
      const aliasMap = VendorAliases.mapByCompany(companyKey);
      const { rows: normalized, clusters, unknownVendors } = normalizeVendors(rows, aliasMap);
      BudgetCache.set(project.id, normalized);
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
    // Budget cache is keyed by project_id — every company in a project
    // shares the same source workbook. Look up the project first instead
    // of indexing the cache by companyKey (the projects refactor moved
    // this and this call site was missed).
    const company = Companies.get(companyKey);
    if (!company) return { ok: false, error: 'Entreprise introuvable.' };
    const project = projectForCompany(company);
    const cached = project ? BudgetCache.get(project.id) : null;
    if (!cached) return { ok: false, error: 'Aucun budget en cache — synchroniser d\'abord.' };
    const allRows = cached.rows as BudgetRow[];
    const selected = rowIds.length > 0 ? allRows.filter((r) => rowIds.includes(r.id)) : allRows;
    if (selected.length === 0) return { ok: false, error: 'Aucune ligne à extraire.' };
    const res = await engine.start(companyKey, selected);
    if ('error' in res) return { ok: false, error: res.error };
    if ('busy' in res) return { ok: false, busy: res.busy };
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
  // without a full reload. fetchFromCompanyKey overrides which QBO realm
  // to download from (cross-company refacturation: row in TDL's run,
  // supplier Bill in Altitude's books).
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
        fetchFromCompanyKey?: string;
      },
    ) => {
      const company = Companies.get(args.companyKey);
      if (!company) return { ok: false, error: 'Entreprise introuvable.' };
      const project = projectForCompany(company);
      if (!project) return { ok: false, error: 'Aucun projet rattaché à cette compagnie.' };
      const cached = BudgetCache.get(project.id);
      if (!cached) return { ok: false, error: 'Aucun budget en cache.' };
      const row = (cached.rows as BudgetRow[]).find((r) => r.id === args.rowId);
      if (!row) return { ok: false, error: 'Ligne du budget introuvable.' };
      const res = await engine.resolveAmbiguous({
        runRowId: args.runRowId,
        txnId: args.txnId,
        txnType: args.txnType,
        row,
        fetchFromCompanyKey: args.fetchFromCompanyKey,
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

  // Export the current QBO realm + tokens as a passphrase-encrypted file
  // so the OAuth-admin can hand the connection to a non-admin teammate
  // (Intuit only allows admins to complete OAuth, so this side-step is
  // the practical way to share a connection without elevating every
  // employee). The renderer wraps this in a save dialog.
  ipcMain.handle(
    'qbo:exportConnection',
    async (
      _evt,
      args: { companyKey: string; passphrase: string },
    ) => {
      const res = await exportQboConnection(args.companyKey, args.passphrase);
      if (!res.ok || !res.data) return { ok: false, error: res.error ?? 'Échec de l\'export.' };
      const dialogRes = await dialog.showSaveDialog({
        title: 'Exporter la connexion QuickBooks',
        defaultPath: `qbo-connection-${args.companyKey}-${new Date().toISOString().slice(0, 10)}.qboconnect`,
        filters: [{ name: 'QBO Connection', extensions: ['qboconnect', 'json'] }],
      });
      if (dialogRes.canceled || !dialogRes.filePath) {
        return { ok: false, error: 'Export annulé.' };
      }
      try {
        fs.writeFileSync(dialogRes.filePath, res.data, 'utf8');
        return { ok: true, filePath: dialogRes.filePath };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Show a file picker, peek the meta (no decryption needed) so the
  // renderer can confirm the target company before asking for the
  // passphrase. The actual decryption + persistence happens in
  // qbo:importConnection once the user types the passphrase.
  ipcMain.handle('qbo:peekImportFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choisir un fichier de connexion',
      properties: ['openFile'],
      filters: [{ name: 'QBO Connection', extensions: ['qboconnect', 'json'] }],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, error: 'Import annulé.' };
    }
    const filePath = res.filePaths[0];
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    const meta = peekPortableMeta(content);
    if (!meta) {
      return { ok: false, error: 'Fichier non reconnu (format ou version invalide).' };
    }
    return { ok: true, filePath, content, meta };
  });

  ipcMain.handle(
    'qbo:importConnection',
    async (
      _evt,
      args: { companyKey: string; fileContent: string; passphrase: string },
    ) => {
      return importQboConnection(args.companyKey, args.fileContent, args.passphrase);
    },
  );

  // Quick-look style preview of the first attachable on a candidate's txn.
  // Fetches the file via QBO's signed-URL endpoint, drops it in
  // userData/preview-cache, and returns the path so the renderer can
  // load it through the qbo-file:// protocol. Two API calls per preview
  // (getAttachables + downloadAttachment) — payable manually since each
  // click is a deliberate disambiguation step that saves a round-trip
  // through the QBO web app.
  ipcMain.handle(
    'qbo:previewAttachable',
    async (_evt, args: { companyKey: string; txnId: string; txnType: 'Bill' | 'Purchase' | 'Invoice' }) => {
      const company = Companies.get(args.companyKey);
      if (!company || !company.qbo_realm_id) {
        return { ok: false, error: 'Compagnie introuvable.' };
      }
      if (!isProxyMode(company.key)) {
        const token = await Secrets.getQbo(company.key);
        if (!token) return { ok: false, error: 'Token QBO manquant.' };
      }
      try {
        const client = createQboClient(company.key, company.qbo_realm_id, company.qbo_env);
        const attachables = await client.getAttachables(args.txnId, args.txnType);
        if (attachables.length === 0) {
          return { ok: false, error: 'Aucune pièce jointe sur cette transaction.' };
        }
        const att = attachables[0];
        const dl = await client.downloadAttachment(att);
        const fileNameRaw = att.FileName || `attachment_${args.txnId}`;
        const safeName = fileNameRaw.replace(/[\\/:*?"<>|\n\r\t]/g, '_');
        const ext = path.extname(safeName) || extFromContentType(dl.contentType);
        const baseName = path.basename(safeName, path.extname(safeName));
        const tempDir = path.join(app.getPath('userData'), 'preview-cache');
        fs.mkdirSync(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, `${args.txnId}_${baseName}${ext}`);
        fs.writeFileSync(tempPath, dl.buffer);

        // Refacturation detection: if the PDF text matches QBO's standard
        // outgoing-invoice template, this is the user's own re-billing
        // imputation, not the supplier's original facture. The user wants
        // a clear visual signal because the filename alone is ambiguous.
        let isRefacturation = false;
        if (ext === '.pdf') {
          try {
            const userCompanyLabels = Companies.list().map((c) => c.label);
            const { extractText, getDocumentProxy } = await import('unpdf');
            const pdf = await getDocumentProxy(new Uint8Array(dl.buffer));
            const { text } = await extractText(pdf, { mergePages: true });
            isRefacturation = looksLikeQboInternalInvoice(
              Array.isArray(text) ? text.join('\n') : text,
              userCompanyLabels,
            );
          } catch {
            // PDF parse failures are non-fatal — fall through with the file
            // displayed and no banner. Common cause: scanned PDFs without
            // an embedded text layer.
          }
        }

        return {
          ok: true,
          filePath: tempPath,
          contentType: dl.contentType,
          fileName: fileNameRaw,
          isRefacturation,
        };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Cross-company candidate search: when a row's active-company candidates
  // include only the re-billing imputation (Invoice without PJ) but the
  // supplier facture lives in a sister company's books (refacturation
  // pattern: bought under Altitude, billed to TDL), the user can ask the
  // resolver to query every other connected QBO realm for the same
  // DocNumber. User-triggered so it doesn't multiply the per-row API
  // budget on the run loop.
  ipcMain.handle(
    'qbo:searchInSisters',
    async (_evt, args: { activeCompanyKey: string; docNumber: string }) => {
      const sisters = Companies.list().filter(
        (c) => c.key !== args.activeCompanyKey && !!c.qbo_realm_id && c.qbo_connected === 1,
      );
      const out: Array<{
        companyKey: string;
        companyLabel: string;
        txnId: string;
        txnType: 'Bill' | 'Purchase' | 'Invoice';
        vendorName: string | null;
        txnDate: string | null;
        totalAmount: number | null;
        docNumber: string | null;
        attachableCount: number;
        attachableKinds: string[];
      }> = [];
      for (const sister of sisters) {
        if (!isProxyMode(sister.key)) {
          const token = await Secrets.getQbo(sister.key);
          if (!token) continue;
        }
        try {
          const client = createQboClient(sister.key, sister.qbo_realm_id!, sister.qbo_env);
          const hits = await client.searchByDocNumber(args.docNumber);
          const top = hits.slice(0, 8);
          const enriched = await Promise.all(
            top.map(async (h) => {
              try {
                const atts = await client.getAttachables(h.Id, h._type);
                const kinds = atts
                  .map((a) => sniffExtKind(a.FileName, a.ContentType))
                  .filter(Boolean) as string[];
                return { hit: h, count: atts.length, kinds };
              } catch {
                return { hit: h, count: 0, kinds: [] as string[] };
              }
            }),
          );
          for (const e of enriched) {
            out.push({
              companyKey: sister.key,
              companyLabel: sister.label,
              txnId: e.hit.Id,
              txnType: e.hit._type,
              vendorName: e.hit._partyName ?? null,
              txnDate: e.hit.TxnDate ?? null,
              totalAmount: typeof e.hit.TotalAmt === 'number' ? e.hit.TotalAmt : null,
              docNumber: e.hit.DocNumber ?? null,
              attachableCount: e.count,
              attachableKinds: e.kinds,
            });
          }
        } catch {
          // Token expired, network error, etc. — skip this sister without
          // failing the whole search; user still benefits from the others.
        }
      }
      return { ok: true, results: out };
    },
  );

  // User reviewed all candidates in the resolver and decided none of them
  // matches the budget row. Mark the row as 'nf' so it leaves the Ambigus
  // tab, clear the captured candidates, and notify the renderer.
  ipcMain.handle(
    'extraction:rejectAmbiguous',
    async (_evt, args: { runRowId: string; rowId: string }) => {
      RunRows.updateStatus(args.runRowId, {
        status: 'nf',
        error: 'Rejeté manuellement : aucune correspondance dans QBO.',
      });
      RunRowCandidates.deleteByRow(args.runRowId);
      const wc = getMainWindow()?.webContents;
      wc?.send('extraction:update', {
        runId: '',
        rowId: args.rowId,
        runRowId: args.runRowId,
        status: 'nf',
        counts: { ok: 0, amb: 0, nf: 0, nopj: 0, total: 0, done: 0 },
      });
      return { ok: true };
    },
  );

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
  // Used by the in-app update-checker. The version stays the bundled
  // package.json one — reading process.env in the renderer wouldn't
  // reflect the production app's version anyway.
  ipcMain.handle('app:version', async () => {
    return app.getVersion();
  });

  // Update check — runs in main rather than the renderer because the
  // renderer's CSP only allows connections to *.intuit.com and
  // *.googleapis.com (we don't want to widen it for a single
  // GitHub-API hit). Returns `{ latest: { version, url, publishedAt } }`
  // when a strictly newer tag exists on
  // https://github.com/Othoiko974/qbo-extractor/releases/latest, or
  // `{ latest: null }` otherwise. Network failures are reported as
  // `{ latest: null, offline: true }` so the renderer can stay quiet.
  ipcMain.handle('app:checkForUpdate', async () => {
    try {
      const r = await fetch(
        'https://api.github.com/repos/Othoiko974/qbo-extractor/releases/latest',
        {
          headers: { Accept: 'application/vnd.github+json' },
          // Reasonable timeout so the boot-time check doesn't hang the
          // renderer's banner state if GitHub is slow / unreachable.
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!r.ok) return { latest: null, error: `HTTP ${r.status}` };
      const data = (await r.json()) as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
      };
      const tag = (data.tag_name ?? '').replace(/^v/, '');
      if (!tag) return { latest: null };
      const current = app.getVersion();
      if (!semverGt(tag, current)) return { latest: null };
      return {
        latest: {
          version: tag,
          url:
            data.html_url ??
            'https://github.com/Othoiko974/qbo-extractor/releases/latest',
          publishedAt: data.published_at ?? '',
        },
      };
    } catch (err) {
      return { latest: null, offline: true, error: errMsg(err) };
    }
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

  // ---- Projects --------------------------------------------------------
  // Each project owns the budget config (gsheets workbook / excel path)
  // shared by every company that belongs to it. The renderer uses these
  // for the sidebar's project switcher and for Settings' project-level
  // CRUD; per-company budget reads still go through budget:read which
  // resolves the active company's project transparently.

  ipcMain.handle('projects:list', async () => {
    return Projects.list().map((p) => ({
      id: p.id,
      name: p.name,
      budgetSource: p.budget_source,
      gsheetsWorkbookId: p.gsheets_workbook_id,
      gsheetsWorkbookName: p.gsheets_workbook_name,
      excelPath: p.excel_path,
      sortOrder: p.sort_order,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));
  });

  ipcMain.handle(
    'projects:create',
    async (_evt, args: { name: string }) => {
      const trimmed = args.name?.trim();
      if (!trimmed) return { ok: false, error: 'Nom de projet requis.' };
      const project = Projects.add({ name: trimmed });
      return { ok: true, projectId: project.id };
    },
  );

  ipcMain.handle(
    'projects:rename',
    async (_evt, args: { projectId: string; name: string }) => {
      const trimmed = args.name?.trim();
      if (!trimmed) return { ok: false, error: 'Nom requis.' };
      const updated = Projects.update(args.projectId, { name: trimmed });
      return { ok: !!updated, error: updated ? undefined : 'Projet introuvable.' };
    },
  );

  ipcMain.handle(
    'projects:delete',
    async (_evt, projectId: string) => {
      // Safety: refuse to delete a project that still has REAL
      // companies pointing at it (the auto-created owner / Compte
      // doesn't count — it's a project artefact and gets cascaded out
      // when the project goes away).
      const companies = Projects.companies(projectId);
      const realCompanies = companies.filter((c) => c.is_project_owner !== 1);
      if (realCompanies.length > 0) {
        return {
          ok: false,
          error: `Le projet a ${realCompanies.length} compagnie(s) rattachée(s). Migre-les vers un autre projet d'abord.`,
        };
      }
      // Cascade-delete the owner so it doesn't dangle.
      const owner = Projects.owner(projectId);
      if (owner) Companies.delete(owner.key);
      Projects.delete(projectId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'companies:setProject',
    async (_evt, args: { companyKey: string; projectId: string }) => {
      const company = Companies.get(args.companyKey);
      if (!company) return { ok: false, error: 'Compagnie introuvable.' };
      const project = Projects.get(args.projectId);
      if (!project) return { ok: false, error: 'Projet introuvable.' };
      Companies.update(args.companyKey, { project_id: args.projectId });
      return { ok: true };
    },
  );
}

function toClientCompany(c: ReturnType<typeof Companies.get> & object) {
  // Budget config is owned by the project from v5 onwards. The
  // company-level columns are kept for legacy callers but the
  // renderer should treat the project's values as authoritative —
  // they're surfaced via the project repo / IPC.
  const project = c.project_id ? Projects.get(c.project_id) : null;
  return {
    key: c.key,
    label: c.label,
    initials: c.initials,
    color: c.color,
    connected: !!c.qbo_connected && !!c.qbo_realm_id,
    qboEnv: c.qbo_env,
    qboRealmId: c.qbo_realm_id ?? undefined,
    projectId: c.project_id ?? null,
    isProjectOwner: c.is_project_owner === 1,
    budgetSource: project?.budget_source ?? c.budget_source,
    gsheetsWorkbookId: project?.gsheets_workbook_id ?? c.gsheets_workbook_id,
    gsheetsWorkbookName: project?.gsheets_workbook_name ?? c.gsheets_workbook_name,
    gsheetsEmail: c.gsheets_account_email,
    excelPath: project?.excel_path ?? c.excel_path,
    gsheetsConnected: !!c.gsheets_connected,
    entityAliases: safeJsonArray(c.entity_aliases),
  };
}

// Tiny semver compare used by the update checker. Splits into numeric
// segments and compares element-wise; pre-release suffixes are ignored
// so a stable v0.2.0 doesn't trigger an upgrade prompt for someone on
// v0.2.0-rc1. Returns true iff `a` is strictly greater than `b`.
function semverGt(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((s) => parseInt(s, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Resolve the project a company belongs to. Falls back to the first
// project in the DB when a company hasn't been linked yet (defensive —
// shouldn't happen post-migration v5 but keeps things working if a
// fresh-install company gets created before any project does).
function projectForCompany(company: { project_id: string | null }): ProjectRow | null {
  if (company.project_id) {
    const p = Projects.get(company.project_id);
    if (p) return p;
  }
  const fallback = Projects.list()[0];
  return fallback ?? null;
}

// Detect QuickBooks Online's outgoing-invoice template. When the user
// downloads what they think is a supplier facture but the PJ is
// actually their own re-billing imputation (the accountant stapled it
// to the wrong txn), this flag drives a "⚠ Refacturation interne"
// banner in the preview overlay. Two independent text signatures —
// the exact-string footer and the payment-instruction line — keep
// false positives near zero (they only appear together on QBO-
// generated invoices in the FR-CA template).
function looksLikeQboInternalInvoice(text: string, userCompanyLabels: string[]): boolean {
  if (!text) return false;
  // Strong signal: QBO's exact French Canadian footer phrase. Highly
  // specific to the template — a real supplier's facture would never
  // word it this way.
  const qboFooter = /par\s+ch[èe]que\s+ou\s+faire\s+un\s+d[ée]p[ôo]t\s+direct\s+au\s+compte/i;
  if (qboFooter.test(text)) return true;
  // Secondary: payment-instruction line names one of the user's own
  // companies — the issuer is the user's QBO realm so the file is by
  // definition outgoing (Invoice/imputation), not a supplier Bill.
  for (const label of userCompanyLabels) {
    if (!label) continue;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `veuillez\\s+[ée]mettre\\s+votre\\s+paiement\\s+[àa]\\s*:?\\s*${escaped}`,
      'i',
    );
    if (re.test(text)) return true;
  }
  return false;
}

// Best-effort content-type to extension map for files where QBO didn't
// give a usable FileName. Falls back to .bin so we always end with a
// concrete suffix the renderer can sniff for type.
function extFromContentType(ct: string): string {
  const lower = ct.toLowerCase();
  if (lower.includes('pdf')) return '.pdf';
  if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg';
  if (lower.includes('png')) return '.png';
  if (lower.includes('heic')) return '.heic';
  if (lower.includes('tiff')) return '.tiff';
  if (lower.includes('gif')) return '.gif';
  if (lower.includes('webp')) return '.webp';
  return '.bin';
}

// Coarse "kind" tag for an attachable so the resolver UI can stack thumbs
// without downloading. Mirrors the local helper in extraction/engine.ts —
// kept inline to avoid widening engine's exported surface.
function sniffExtKind(fileName: string | undefined, contentType: string | undefined): string | null {
  const candidates = [fileName, contentType].filter(Boolean) as string[];
  for (const s of candidates) {
    const lower = s.toLowerCase();
    if (lower.includes('pdf')) return 'pdf';
    if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
    if (lower.includes('png')) return 'png';
    if (lower.includes('heic')) return 'heic';
    if (lower.includes('tiff')) return 'tiff';
    if (lower.includes('gif')) return 'gif';
    if (lower.includes('webp')) return 'webp';
  }
  return null;
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
