import fs from 'node:fs';
import path from 'node:path';
import { app, type WebContents } from 'electron';
import type { BudgetRow, ExtractionStatus } from '../../types/domain';
import { type QboBill } from '../qbo/client';
import { createQboClient, type QboLike } from '../qbo/factory';
import { isProxyMode, getProxyConfig } from '../qbo/proxy-client';
import {
  claimExtraction,
  heartbeatExtraction,
  releaseExtraction,
} from '../qbo/extraction-lock';
import { Companies, Runs, RunRows, RunRowCandidates, Settings, type RunRow, type RunRowRow } from '../db/repo';
import { Secrets } from '../secrets';
import { applyTemplate, applyFolderTemplate, extensionFromContentType } from './naming';
import { log } from '../logger';
import { normalizeEntity } from '../../shared/entity';

// Matching tolerances from design handoff:
//   amount: ±0.50 $
//   date:   ±7 days
const AMOUNT_TOLERANCE = 0.5;
const DATE_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000;

export type ExtractionUpdate = {
  runId: string;
  rowId: string;
  // Persisted run_rows.id — used by the renderer to fetch the saved
  // candidates from `run_row_candidates` when status === 'amb'. Optional
  // (empty for the run-finished sentinel update).
  runRowId?: string;
  status: ExtractionStatus;
  filePath?: string;
  // QBO transaction the engine resolved this row to (when applicable).
  // The Review screen uses this to deep-link straight to the matching
  // bill/expense in QBO so the user can attach a missing PJ without
  // re-searching.
  txnId?: string;
  txnType?: 'Bill' | 'Purchase' | 'Invoice';
  error?: string;
  counts: { ok: number; amb: number; nf: number; nopj: number; total: number; done: number };
  finished?: boolean;
};

type Controller = {
  runId: string;
  companyKey: string;
  state: 'running' | 'paused' | 'stopped';
  counts: { ok: number; amb: number; nf: number; nopj: number };
  total: number;
  done: number;
  wake?: () => void;
  // Heartbeat timer that keeps the proxy-side extraction lock alive while
  // this run is in progress. Cleared on stop/finish/error.
  heartbeatTimer?: NodeJS.Timeout;
};

export class ExtractionEngine {
  private current: Controller | null = null;

  constructor(private getWebContents: () => WebContents | null) {}

  isRunning(): boolean {
    return this.current !== null && this.current.state !== 'stopped';
  }

  pause(): void {
    if (this.current && this.current.state === 'running') this.current.state = 'paused';
  }

  resume(): void {
    if (this.current && this.current.state === 'paused') {
      this.current.state = 'running';
      this.current.wake?.();
    }
  }

  stop(): void {
    if (this.current) {
      this.current.state = 'stopped';
      this.current.wake?.();
    }
  }

  // Single cleanup path — clears the heartbeat timer, releases the
  // proxy lock, and zeroes `current`. Called from start()'s .finally
  // so it runs whether the loop completed, errored, or was cancelled.
  private cleanupRun(companyKey: string): void {
    if (this.current?.heartbeatTimer) {
      clearInterval(this.current.heartbeatTimer);
    }
    this.current = null;
    void releaseExtraction(companyKey);
  }

  async start(
    companyKey: string,
    rows: BudgetRow[],
  ): Promise<
    | { runId: string }
    | { error: string }
    | {
        busy: {
          api_key_label: string;
          total_rows: number;
          estimated_requests: number;
          started_at: number;
          last_heartbeat: number;
          eta_seconds: number;
        };
      }
  > {
    if (this.isRunning()) return { error: 'Une extraction est déjà en cours.' };

    const company = Companies.get(companyKey);
    if (!company) return { error: 'Entreprise introuvable.' };
    if (!company.qbo_realm_id) return { error: 'QuickBooks non connecté pour cette entreprise.' };
    if (isProxyMode(companyKey)) {
      const cfg = await getProxyConfig(companyKey);
      if (!cfg) return { error: 'Mode proxy actif mais API key absente pour cette compagnie — configure-la dans Connect.' };
    } else {
      const token = await Secrets.getQbo(companyKey);
      if (!token) return { error: 'Token QBO manquant — reconnecter QuickBooks.' };
    }

    // Reserve the proxy-side lock for this realm before we start writing
    // rows to the DB. If another teammate is already running, we surface
    // their context to the caller without committing any local state.
    const claim = await claimExtraction(companyKey, rows.length);
    if (!claim.ok) {
      if ('busy' in claim) return { busy: claim.busy };
      return { error: claim.error };
    }

    log.info('extraction', 'start', {
      companyKey,
      rowCount: rows.length,
      env: company.qbo_env,
      realmId: company.qbo_realm_id,
      sampleDocNumbers: rows.slice(0, 5).map((r) => r.docNumber),
    });

    const baseFolder = Settings.get('base_folder') ?? path.join(app.getPath('documents'), 'QBO Extracts');
    const template = Settings.get('naming_template') ?? 'Depense_{num}_{fournisseur}_{date}_{montant}';
    const folderTemplate = Settings.get('folder_template') ?? '';
    // Folder name follows the actual QBO CompanyName (authoritative) rather
    // than the local company.label (which is whatever the user typed when
    // creating the company in the desktop app and often diverges — e.g.
    // "Altitude" locally vs. "Altitude 233 Inc" in QBO). Falls back to the
    // local label if the ping fails so we never block extraction on it.
    const client = createQboClient(companyKey, company.qbo_realm_id, company.qbo_env);
    let folderName = company.label;
    try {
      const info = await client.ping();
      if (info.ok && info.companyName) folderName = info.companyName;
    } catch {
      /* keep label fallback */
    }
    const companyFolder = path.join(baseFolder, sanitizeFolder(folderName));
    fs.mkdirSync(companyFolder, { recursive: true });

    const run = Runs.create(companyKey, rows.length, companyFolder);

    // Persist queued rows keyed by idx so the engine can update them by id later.
    const rowIds: string[] = [];
    RunRows.bulkInsert(
      run.id,
      rows.map((r, i) => {
        rowIds.push(r.id);
        return {
          row_idx: i,
          doc_number: r.docNumber,
          vendor: r.vendor,
          booking_entity: r.bookingEntity ?? null,
          amount: r.amount,
          date: r.date,
          sheet: r.sheet,
          building: r.building ?? null,
          status: 'queue' as const,
        };
      }),
    );
    // Read back to get generated ids keyed by row_idx.
    const persisted = RunRows.listByRun(run.id);

    this.current = {
      runId: run.id,
      companyKey,
      state: 'running',
      counts: { ok: 0, amb: 0, nf: 0, nopj: 0 },
      total: rows.length,
      done: 0,
    };

    // Heartbeat the lock every 60s. Server TTL is 5 min, so a single
    // missed beat (network blip) doesn't drop the lock.
    if (isProxyMode(companyKey)) {
      this.current.heartbeatTimer = setInterval(() => {
        void heartbeatExtraction(companyKey);
      }, 60_000);
    }

    // (client already created above for the CompanyName lookup)

    // Fire and forget; progress streams via IPC.
    this.runLoop(run, rows, persisted, client, companyFolder, template, folderTemplate)
      .catch((err) => {
        console.error('[extraction] fatal', err);
        Runs.setStatus(run.id, 'cancelled');
        this.emitUpdate({
          runId: run.id,
          rowId: '',
          status: 'nf',
          error: err instanceof Error ? err.message : String(err),
          counts: { ...this.current!.counts, total: this.current!.total, done: this.current!.done },
          finished: true,
        });
      })
      .finally(() => {
        this.cleanupRun(companyKey);
      });

    return { runId: run.id };
  }

  private async runLoop(
    run: RunRow,
    rows: BudgetRow[],
    persisted: RunRowRow[],
    client: QboLike,
    companyFolder: string,
    template: string,
    folderTemplate: string,
  ) {
    for (let i = 0; i < rows.length; i++) {
      if (!this.current) return;
      // Pause cooperatively
      while (this.current.state === 'paused') {
        await new Promise<void>((resolve) => {
          this.current!.wake = resolve;
        });
      }
      if (this.current.state === 'stopped') {
        Runs.setStatus(run.id, 'cancelled');
        this.emitUpdate({
          runId: run.id,
          rowId: rows[i]?.id ?? '',
          status: 'nf',
          counts: { ...this.current.counts, total: this.current.total, done: this.current.done },
          finished: true,
        });
        // cleanupRun (in .finally) clears the heartbeat timer + releases
        // the lock — don't null `current` here or the cleanup loses the
        // timer reference and leaks the interval.
        return;
      }

      const budgetRow = rows[i];
      const dbRow = persisted.find((r) => r.row_idx === i);
      if (!dbRow) continue;

      this.emitUpdate({
        runId: run.id,
        rowId: budgetRow.id,
        runRowId: dbRow.id,
        status: 'run',
        counts: { ...this.current.counts, total: this.current.total, done: this.current.done },
      });

      const outcome = await this.processRow(budgetRow, client, companyFolder, template, folderTemplate, dbRow.id);

      RunRows.updateStatus(dbRow.id, {
        status: outcome.status,
        qbo_txn_id: outcome.txnId ?? null,
        qbo_txn_type: outcome.txnType ?? null,
        file_path: outcome.filePath ?? null,
        error: outcome.error ?? null,
      });

      this.current.counts[outcome.status as keyof Controller['counts']] += 1;
      this.current.done += 1;
      Runs.updateCounts(run.id, {
        ok_count: this.current.counts.ok,
        amb_count: this.current.counts.amb,
        nf_count: this.current.counts.nf,
        nopj_count: this.current.counts.nopj,
      });

      this.emitUpdate({
        runId: run.id,
        rowId: budgetRow.id,
        runRowId: dbRow.id,
        status: outcome.status,
        filePath: outcome.filePath,
        txnId: outcome.txnId,
        txnType: outcome.txnType as 'Bill' | 'Purchase' | 'Invoice' | undefined,
        error: outcome.error,
        counts: { ...this.current.counts, total: this.current.total, done: this.current.done },
      });
    }

    Runs.setStatus(run.id, 'done');
    this.emitUpdate({
      runId: run.id,
      rowId: '',
      status: 'ok',
      counts: { ...this.current!.counts, total: this.current!.total, done: this.current!.done },
      finished: true,
    });
    // cleanupRun (in .finally) handles `current = null` + heartbeat clear
    // + lock release.
  }

  private async processRow(
    row: BudgetRow,
    client: QboLike,
    companyFolder: string,
    template: string,
    folderTemplate: string,
    runRowId: string,
  ): Promise<{
    status: ExtractionStatus;
    filePath?: string;
    error?: string;
    txnId?: string;
    txnType?: string;
  }> {
    try {
      log.info('extraction', 'row:start', {
        docNumber: row.docNumber,
        vendor: row.vendor,
        amount: row.amount,
        date: row.date,
        sheet: row.sheet,
      });
      // Build the list of candidate invoice numbers to search for. The primary is
      // the row's docNumber column, but real QBO DocNumbers sometimes differ —
      // e.g. the budget shows "486" while QBO stores "F-486", or "7117609" vs
      // "7117609-01". Those richer tokens usually appear in the comment column,
      // after "facture" or as standalone alphanumeric tokens.
      const candidates = buildSearchCandidates(row.docNumber, row.comment, row.rawDocNumber);
      log.info('extraction', 'row:candidates', {
        docNumber: row.docNumber,
        comment: row.comment,
        candidates,
      });

      let hits: QboBill[] = [];
      let matchedNum = row.docNumber;
      for (const n of candidates) {
        const r = await client.searchByDocNumber(n);
        log.info('extraction', 'row:hits', {
          tried: n,
          hitCount: r.length,
          hits: r.map((h) => ({
            id: h.Id,
            type: h._type,
            docNumber: h.DocNumber,
            amount: h.TotalAmt,
            date: h.TxnDate,
            vendor: h._partyName,
          })),
        });
        if (r.length > 0) {
          hits = r;
          matchedNum = n;
          break;
        }
      }

      if (hits.length === 0) {
        log.warn('extraction', 'row:nf:no-hits', {
          docNumber: row.docNumber,
          triedCandidates: candidates,
        });
        return {
          status: 'nf',
          error: `Aucune facture trouvée dans QBO (candidats essayés : ${candidates.join(', ')}).`,
        };
      }

      // Apply amount + date + vendor checks uniformly, even on a single
      // hit. DocNumber is not unique in QBO — a lone result can still be
      // the wrong txn (different supplier reused the number), so we never
      // trust an unverified one. Split-sibling rows share a single Excel
      // amount across multiple invoices, so per-row amount isn't a
      // meaningful filter for them.
      const isSplit = (row.splitGroupSize ?? 1) > 1;
      const filtered = hits.filter(
        (h) => (isSplit || matchesAmount(h, row.amount)) && matchesDate(h, row.date),
      );
      log.info('extraction', 'row:filter', {
        matchedNum,
        targetAmount: row.amount,
        targetDate: row.date,
        isSplit,
        hitCount: hits.length,
        filteredCount: filtered.length,
      });

      let candidate: QboBill | null = null;
      const targetVendor = normalizeEntity(row.vendor);

      // Single survivor of amount/date filter — accept only if vendor
      // matches (or vendor unknown). This catches the DocNumber-collision
      // case where a Purchase from supplier A shares its number with the
      // budget's intended Bill from supplier B.
      if (filtered.length === 1) {
        const lone = filtered[0];
        if (!targetVendor || normalizeEntity(lone._partyName ?? '') === targetVendor) {
          candidate = lone;
        }
      }

      // Vendor tie-break across the broader pool — covers split-sibling
      // rows whose individual amount/date aren't meaningful, and cases
      // where multiple txns share a DocNumber but only one's vendor
      // matches the budget. When filtered narrowed to a single hit that
      // failed the vendor check above, expand to the full hit list — the
      // vendor-correct alternate likely failed amt/date (off-tolerance
      // date, allocated amount) and would otherwise be unreachable here.
      if (!candidate && targetVendor) {
        const vendorPool = filtered.length > 1 ? filtered : hits;
        const vendorMatches = vendorPool.filter(
          (h) => normalizeEntity(h._partyName ?? '') === targetVendor,
        );
        if (vendorMatches.length === 1) {
          log.info('extraction', 'row:vendor-tiebreak', {
            matchedNum,
            vendor: row.vendor,
            pickedTxn: vendorMatches[0].Id,
            pickedType: vendorMatches[0]._type,
          });
          candidate = vendorMatches[0];
        }
      }

      if (!candidate) {
        log.warn('extraction', 'row:amb', {
          matchedNum,
          hitCount: hits.length,
          candidates: hits.map((h) => ({
            id: h.Id,
            type: h._type,
            amount: h.TotalAmt,
            date: h.TxnDate,
            vendor: h._partyName,
          })),
        });
        // Persist candidates with their attachable summary so the resolver
        // UI can render the cards offline. Cap at 8 to bound latency / cost.
        // Show all hits (not just `filtered`) — when our auto tie-break
        // rejected the lone survivor on a vendor mismatch, showing only
        // that rejected hit would leave the user nothing else to pick.
        const top = hits.slice(0, 8);
        const enriched = await Promise.all(
          top.map(async (h) => {
            try {
              const atts = await client.getAttachables(h.Id, h._type);
              const kinds = atts
                .map((a) => extKind(a.FileName, a.ContentType))
                .filter(Boolean) as string[];
              return { hit: h, count: atts.length, kinds };
            } catch {
              return { hit: h, count: 0, kinds: [] as string[] };
            }
          }),
        );
        // Replace any prior candidates for this row (re-runs / resync).
        RunRowCandidates.deleteByRow(runRowId);
        RunRowCandidates.bulkInsert(
          runRowId,
          enriched.map((e) => ({
            run_row_id: runRowId,
            qbo_txn_id: e.hit.Id,
            qbo_txn_type: e.hit._type,
            vendor_name: e.hit._partyName ?? null,
            txn_date: e.hit.TxnDate ?? null,
            total_amount: typeof e.hit.TotalAmt === 'number' ? e.hit.TotalAmt : null,
            subtotal_amount: typeof e.hit._subtotalAmount === 'number' ? e.hit._subtotalAmount : null,
            doc_number: e.hit.DocNumber ?? null,
            attachable_count: e.count,
            attachable_kinds: JSON.stringify(e.kinds),
          })),
        );
        return { status: 'amb' };
      }

      // Single unambiguous candidate — download.
      return await this.downloadAndSave(
        client,
        candidate,
        row,
        companyFolder,
        template,
        folderTemplate,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('extraction', 'row:error', { docNumber: row.docNumber, error: msg });
      return {
        status: 'nf',
        error: msg,
      };
    }
  }

  // Download the primary attachable for a chosen QBO transaction and save it
  // under the company folder using the configured folder + naming templates.
  // Used by the run-loop for unambiguous matches AND by the AmbiguousResolver
  // when the user manually picks a candidate.
  async downloadAndSave(
    client: QboLike,
    txn: QboBill,
    row: BudgetRow,
    companyFolder: string,
    template: string,
    folderTemplate: string,
  ): Promise<{
    status: ExtractionStatus;
    filePath?: string;
    error?: string;
    txnId?: string;
    txnType?: string;
  }> {
    const attachables = await client.getAttachables(txn.Id, txn._type);
    log.info('extraction', 'row:attachables', {
      docNumber: row.docNumber,
      txnId: txn.Id,
      txnType: txn._type,
      count: attachables.length,
      names: attachables.map((a) => a.FileName ?? '(no-name)'),
    });
    if (attachables.length === 0) {
      return { status: 'nopj', txnId: txn.Id, txnType: txn._type };
    }

    // Pick the most relevant attachable. Bills sometimes carry several
    // PDFs — the original supplier invoice, plus accounting cross-refs
    // (rebilling docs, payment proof, etc). Heuristic, in priority order:
    //   1. A filename that mentions the row's docNumber (e.g. "4701" or
    //      "F-4701") — strongest signal it's the original supplier PJ.
    //   2. A filename that mentions the vendor name (Conteneur Davinci…).
    //   3. The first attachable that has any FileName.
    //   4. Fallback to the first attachable in the response.
    const primary = pickPrimaryAttachable(attachables, row);
    log.info('extraction', 'row:attachable:picked', {
      docNumber: row.docNumber,
      pickedFileName: primary.FileName,
      pickedId: primary.Id,
    });
    const dl = await client.downloadAttachment(primary);

    const ext = inferExtension(primary.FileName, dl.contentType);
    // Prefer the QBO transaction's authoritative date + total when shaping
    // the filename / folder path. The budget's row.amount is often a
    // per-entity allocation (e.g. $8.99 of a $1,539.06 supplier invoice
    // split across companies), and row.date can be off by a few days from
    // the actual TxnDate. Using QBO's values keeps the file metadata in
    // sync with the PDF the user sees inside, which matches accounting
    // intuition when scanning a folder of extracts.
    const txnAmount = typeof txn.TotalAmt === 'number' ? txn.TotalAmt : row.amount;
    const txnDate = txn.TxnDate || row.date;
    const base = applyTemplate(template, {
      num: row.docNumber,
      fournisseur: row.vendor,
      date: txnDate,
      montant: txnAmount,
      batiment: row.building,
      sheet: row.sheet,
    });
    const subPath = applyFolderTemplate(folderTemplate, {
      date: txnDate,
      sheet: row.sheet,
      fournisseur: row.vendor,
      batiment: row.building,
    });
    const targetDir = subPath ? path.join(companyFolder, subPath) : companyFolder;
    fs.mkdirSync(targetDir, { recursive: true });
    const dest = uniquePath(path.join(targetDir, base + ext));
    fs.writeFileSync(dest, dl.buffer);
    log.info('extraction', 'row:ok', { docNumber: row.docNumber, dest, contentType: dl.contentType });

    return { status: 'ok', filePath: dest, txnId: txn.Id, txnType: txn._type };
  }

  private emitUpdate(update: ExtractionUpdate) {
    const wc = this.getWebContents();
    wc?.send('extraction:update', update);
  }

  // Manually resolve an ambiguous row: download the user-chosen QBO
  // transaction's attachment under the company folder, update run_rows,
  // and clean up the saved candidates. Returns a stable outcome the
  // renderer can apply to its store.
  async resolveAmbiguous(params: {
    runRowId: string;
    txnId: string;
    txnType: 'Bill' | 'Purchase' | 'Invoice';
    row: BudgetRow;
    // Optional override: which company's QBO realm to fetch the txn /
    // attachable from. Cross-company refacturation pattern — the row
    // belongs to (e.g.) TDL but the supplier Bill with the original PJ
    // lives in Altitude's books. The destination folder + naming still
    // come from the run's own company so the file lands in the right
    // place; only the QBO source is swapped.
    fetchFromCompanyKey?: string;
  }): Promise<{
    ok: boolean;
    status?: ExtractionStatus;
    filePath?: string;
    error?: string;
    txnId?: string;
    txnType?: string;
  }> {
    const runRow = RunRows.get(params.runRowId);
    if (!runRow) return { ok: false, error: 'Ligne introuvable.' };
    const run = Runs.get(runRow.run_id);
    if (!run) return { ok: false, error: 'Run introuvable.' };
    const runCompany = Companies.get(run.company_key);
    if (!runCompany) {
      return { ok: false, error: 'Entreprise du run introuvable.' };
    }
    const fetchKey = params.fetchFromCompanyKey ?? runCompany.key;
    const fetchCompany = Companies.get(fetchKey);
    if (!fetchCompany || !fetchCompany.qbo_realm_id) {
      return { ok: false, error: 'Entreprise source / connexion QBO indisponible.' };
    }
    if (isProxyMode(fetchCompany.key)) {
      const cfg = await getProxyConfig(fetchCompany.key);
      if (!cfg) return { ok: false, error: 'Mode proxy actif mais API key absente pour la compagnie source.' };
    } else {
      const token = await Secrets.getQbo(fetchCompany.key);
      if (!token) return { ok: false, error: 'Token QBO manquant pour la compagnie source.' };
    }

    const baseFolder = Settings.get('base_folder') ?? path.join(app.getPath('documents'), 'QBO Extracts');
    const template = Settings.get('naming_template') ?? 'Depense_{num}_{fournisseur}_{date}_{montant}';
    const folderTemplate = Settings.get('folder_template') ?? '';
    const companyFolder = run.folder ?? path.join(baseFolder, sanitizeFolder(runCompany.label));
    fs.mkdirSync(companyFolder, { recursive: true });

    const client = createQboClient(fetchCompany.key, fetchCompany.qbo_realm_id, fetchCompany.qbo_env);
    const txn: QboBill = {
      Id: params.txnId,
      _type: params.txnType,
      DocNumber: params.row.docNumber,
    };

    try {
      const outcome = await this.downloadAndSave(
        client,
        txn,
        params.row,
        companyFolder,
        template,
        folderTemplate,
      );
      RunRows.updateStatus(params.runRowId, {
        status: outcome.status,
        qbo_txn_id: outcome.txnId ?? null,
        qbo_txn_type: outcome.txnType ?? null,
        file_path: outcome.filePath ?? null,
        error: outcome.error ?? null,
      });
      // Clean up candidates once resolved.
      if (outcome.status === 'ok') RunRowCandidates.deleteByRow(params.runRowId);
      return { ok: true, ...outcome };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('extraction', 'resolve:error', { runRowId: params.runRowId, error: msg });
      return { ok: false, error: msg };
    }
  }
}


function matchesAmount(hit: QboBill, target: number): boolean {
  // Match against both TTC and HT — budget conventions vary (some sheets
  // are HT, others TTC) and QBO always returns TotalAmt as TTC. A
  // single-axis match would miss the candidate the moment the budget
  // convention diverges from QBO's. Accept either side within tolerance.
  if (typeof hit.TotalAmt === 'number') {
    if (Math.abs(hit.TotalAmt - target) <= AMOUNT_TOLERANCE) return true;
  }
  if (typeof hit._subtotalAmount === 'number') {
    if (Math.abs(hit._subtotalAmount - target) <= AMOUNT_TOLERANCE) return true;
  }
  return false;
}

function matchesDate(hit: QboBill, target: string): boolean {
  if (!hit.TxnDate || !target) return false;
  const a = Date.parse(hit.TxnDate);
  const b = Date.parse(target);
  if (isNaN(a) || isNaN(b)) return false;
  return Math.abs(a - b) <= DATE_TOLERANCE_MS;
}

function inferExtension(fileName: string | undefined, contentType: string): string {
  if (fileName) {
    const ext = path.extname(fileName);
    if (ext) return ext.toLowerCase();
  }
  return extensionFromContentType(contentType);
}

function uniquePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  let i = 2;
  while (fs.existsSync(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

// Pick the attachable most likely to be the supplier's original PJ when a
// QBO transaction carries several files. The accounting team often staples
// extra cross-refs (rebilling docs, payment proofs) — without this we'd
// silently grab whichever was attached first.
function pickPrimaryAttachable(
  attachables: import('../qbo/client').QboAttachable[],
  row: BudgetRow,
): import('../qbo/client').QboAttachable {
  const docNum = row.docNumber.toLowerCase();
  // Drop the F- prefix when comparing — "F-4701" should also match "4701".
  const docNumBare = docNum.replace(/^f[-\s]*/, '');
  const vendorTokens = row.vendor
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter((t) => t.length >= 4);

  // 1. Filename mentions the docNumber.
  const byDoc = attachables.find((a) => {
    const n = (a.FileName ?? '').toLowerCase();
    return n.includes(docNum) || n.includes(docNumBare);
  });
  if (byDoc) return byDoc;

  // 2. Filename mentions one of the vendor tokens.
  if (vendorTokens.length > 0) {
    const byVendor = attachables.find((a) => {
      const n = (a.FileName ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
      return vendorTokens.some((t) => n.includes(t));
    });
    if (byVendor) return byVendor;
  }

  // 3 / 4. First named, else first overall.
  return attachables.find((a) => a.FileName) ?? attachables[0];
}

// Coarse "kind" tag for an attachable so the resolver UI can show a stack
// of mini-thumbnails (PDF / JPG / PNG / etc) without downloading the file.
function extKind(fileName: string | undefined, contentType: string | undefined): string | null {
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

function sanitizeFolder(s: string): string {
  // POSIX (macOS / Linux) preserves trailing dots and spaces. Win32
  // silently drops them, which would desync the mkdir target ("Altitude
  // 233 Inc") from later path.join lookups (still with the dot) — strip
  // there only.
  let out = s
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (process.platform === 'win32') out = out.replace(/[. ]+$/, '');
  return out;
}

// Build the list of invoice-number candidates to query QBO with. The primary is
// always the budget's docNumber column. If that fails, QBO's DocNumber can live
// inside the comment — e.g. "VSL; 160; L2V4 Electrique inc F-486" → "F-486".
//
// Strategy:
//   1. docNumber as-is.
//   2. Tokens after "facture" / "fact." / "#" in the comment (QBO-style IDs).
//   3. Remaining alphanumeric tokens in the comment that look like invoice IDs:
//      at least 3 chars, contains a digit, not a short sheet/building code
//      (which are pure 3-digit numbers like 093, 154, 160, 1310).
// Duplicates are removed, and tokens matching the primary docNumber are skipped.
export function buildSearchCandidates(
  docNumber: string,
  comment?: string,
  rawDocNumber?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string | undefined) => {
    if (!s) return;
    const t = s.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
    // Variant emission (F- / bare) used to live here, but it now happens
    // inside QboClient.searchByDocNumber so each candidate atomically
    // probes both forms server-side and the dedup is single-pass.
  };

  // Tokenize the comment first so trigger-based hits ("facture 440") can be
  // prioritized over the docNumber column. Refacturation rows put the
  // re-billing number in column B and the supplier's original invoice
  // number after "facture" in the comment; without comment-first priority
  // the engine breaks on the (PJ-less) re-billing match and never tries
  // the supplier's actual invoice.
  const triggerHits: string[] = [];
  const alphaHits: string[] = [];
  if (comment) {
    // Collapse standalone hyphens (e.g. "facture - 440") so the trigger
    // lookahead lands on the ID, not '-'. Hyphens inside tokens (F-486)
    // are preserved by the splitting regex.
    const tokens = comment
      .replace(/\s-\s/g, ' ')
      .split(/[\s,;:/()\[\]]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const triggers = new Set(['facture', 'factures', 'fact', 'fact.', '#', 'no', 'n°', 'numéro']);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (triggers.has(tokens[i].toLowerCase().replace(/\.$/, ''))) {
        if (looksLikeInvoiceId(tokens[i + 1])) triggerHits.push(tokens[i + 1]);
      }
    }

    for (const t of tokens) {
      if (looksLikeInvoiceId(t) && !isSheetOrBuildingCode(t)) alphaHits.push(t);
    }
  }

  // Priority: trigger-tagged comment IDs first, then docNumber column,
  // then other comment tokens, then rawDocNumber as last resort.
  for (const t of triggerHits) push(t);
  push(docNumber);
  for (const t of alphaHits) push(t);
  push(rawDocNumber);

  return out;
}

function looksLikeInvoiceId(t: string): boolean {
  if (t.length < 3) return false;
  if (!/\d/.test(t)) return false;
  if (!/^[A-Za-z0-9\-._]+$/.test(t)) return false;
  return true;
}

function isSheetOrBuildingCode(t: string): boolean {
  // Pure 3-digit codes (030, 093, 154, 160...) are sheet prefixes.
  // Pure 4-digit codes that start with 13/14 are building codes (1310, 1310VSL).
  if (/^\d{3}$/.test(t)) return true;
  if (/^(VSL|TDL)$/i.test(t)) return true;
  if (/^13\d{2}(VSL|TDL)?$/i.test(t)) return true;
  return false;
}
