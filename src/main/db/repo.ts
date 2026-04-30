import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type CompanyRow = {
  key: string;
  label: string;
  initials: string;
  color: string;
  qbo_realm_id: string | null;
  qbo_env: 'sandbox' | 'production';
  // Budget fields below are deprecated in v5 — projects own them now —
  // but the columns are kept nullable on the company table for back-
  // compat with v0.1.x installs that haven't run the v5 migration yet.
  budget_source: 'gsheets' | 'excel' | null;
  gsheets_workbook_id: string | null;
  gsheets_workbook_name: string | null;
  gsheets_account_email: string | null;
  excel_path: string | null;
  qbo_connected: 0 | 1;
  gsheets_connected: 0 | 1;
  sort_order: number;
  created_at: number;
  updated_at: number;
  entity_aliases: string; // JSON array of strings
  project_id: string | null;
};

export type ProjectRow = {
  id: string;
  name: string;
  budget_source: 'gsheets' | 'excel' | null;
  gsheets_workbook_id: string | null;
  gsheets_workbook_name: string | null;
  excel_path: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export type NewProject = {
  name: string;
  budget_source?: 'gsheets' | 'excel' | null;
};

export type NewCompany = Pick<CompanyRow, 'label' | 'initials' | 'color'> & {
  budget_source?: 'gsheets' | 'excel' | null;
  qbo_env?: 'sandbox' | 'production';
};

export const Companies = {
  list(): CompanyRow[] {
    return getDb()
      .prepare('SELECT * FROM companies ORDER BY sort_order, created_at')
      .all() as CompanyRow[];
  },
  get(key: string): CompanyRow | undefined {
    return getDb().prepare('SELECT * FROM companies WHERE key = ?').get(key) as CompanyRow | undefined;
  },
  add(c: NewCompany & { project_id?: string | null }): CompanyRow {
    const now = Date.now();
    const key = slugify(c.label) + '-' + randomUUID().slice(0, 6);
    // New companies attach to the first project by default — there's
    // typically just one in the post-v5 model. Caller can override
    // via the project_id field on c.
    const projectId =
      c.project_id ??
      (getDb()
        .prepare('SELECT id FROM projects ORDER BY sort_order, created_at LIMIT 1')
        .get() as { id?: string } | undefined)?.id ??
      null;
    getDb()
      .prepare(
        `INSERT INTO companies (key, label, initials, color, qbo_env, budget_source, sort_order, created_at, updated_at, entity_aliases, project_id)
         VALUES (@key, @label, @initials, @color, @qbo_env, @budget_source, @sort_order, @created_at, @updated_at, @entity_aliases, @project_id)`,
      )
      .run({
        key,
        label: c.label,
        initials: c.initials,
        color: c.color,
        qbo_env: c.qbo_env ?? 'sandbox',
        budget_source: c.budget_source ?? null,
        sort_order: now,
        created_at: now,
        updated_at: now,
        // Default: company owns rows whose Fournisseur cell matches its label.
        entity_aliases: JSON.stringify([c.label]),
        project_id: projectId,
      });
    return Companies.get(key)!;
  },
  setEntityAliases(key: string, aliases: string[]): void {
    const cleaned = Array.from(
      new Set(aliases.map((s) => s.trim()).filter((s) => s.length > 0)),
    );
    getDb()
      .prepare('UPDATE companies SET entity_aliases = ?, updated_at = ? WHERE key = ?')
      .run(JSON.stringify(cleaned), Date.now(), key);
  },
  update(key: string, patch: Partial<CompanyRow>): CompanyRow | undefined {
    const existing = Companies.get(key);
    if (!existing) return undefined;
    const merged = { ...existing, ...patch, key, updated_at: Date.now() };
    getDb()
      .prepare(
        `UPDATE companies SET
          label=@label, initials=@initials, color=@color,
          qbo_realm_id=@qbo_realm_id, qbo_env=@qbo_env,
          budget_source=@budget_source,
          gsheets_workbook_id=@gsheets_workbook_id, gsheets_workbook_name=@gsheets_workbook_name,
          gsheets_account_email=@gsheets_account_email, excel_path=@excel_path,
          qbo_connected=@qbo_connected, gsheets_connected=@gsheets_connected,
          sort_order=@sort_order, updated_at=@updated_at,
          project_id=@project_id
         WHERE key=@key`,
      )
      .run(merged);
    return Companies.get(key);
  },
  delete(key: string): void {
    getDb().prepare('DELETE FROM companies WHERE key = ?').run(key);
  },
};

export const Settings = {
  get(key: string): string | undefined {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  },
  all(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  set(key: string, value: string): void {
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  },
  setMany(patch: Record<string, string>): void {
    const stmt = getDb().prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const tx = getDb().transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) stmt.run(k, v);
    });
    tx(Object.entries(patch));
  },
};

export type RunRow = {
  id: string;
  company_key: string;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'paused' | 'done' | 'cancelled';
  total: number;
  ok_count: number;
  amb_count: number;
  nf_count: number;
  nopj_count: number;
  folder: string | null;
  sheet_label: string | null;
};

export const Runs = {
  create(companyKey: string, total: number, folder: string, sheetLabel?: string): RunRow {
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO runs (id, company_key, started_at, status, total, folder, sheet_label)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, companyKey, Date.now(), total, folder, sheetLabel ?? null);
    return Runs.get(id)!;
  },
  get(id: string): RunRow | undefined {
    return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  },
  listByCompany(companyKey: string): RunRow[] {
    return getDb()
      .prepare('SELECT * FROM runs WHERE company_key = ? ORDER BY started_at DESC')
      .all(companyKey) as RunRow[];
  },
  updateCounts(id: string, counts: Partial<Pick<RunRow, 'ok_count' | 'amb_count' | 'nf_count' | 'nopj_count'>>) {
    const existing = Runs.get(id);
    if (!existing) return;
    const merged = { ...existing, ...counts };
    getDb()
      .prepare(
        `UPDATE runs SET ok_count=?, amb_count=?, nf_count=?, nopj_count=? WHERE id=?`,
      )
      .run(merged.ok_count, merged.amb_count, merged.nf_count, merged.nopj_count, id);
  },
  setStatus(id: string, status: RunRow['status']) {
    const finished = status === 'done' || status === 'cancelled' ? Date.now() : null;
    getDb().prepare('UPDATE runs SET status=?, finished_at=? WHERE id=?').run(status, finished, id);
  },
};

export type RunRowRow = {
  id: string;
  run_id: string;
  row_idx: number;
  doc_number: string | null;
  vendor: string | null;
  booking_entity: string | null;
  amount: number | null;
  date: string | null;
  sheet: string | null;
  building: string | null;
  status: 'queue' | 'run' | 'ok' | 'amb' | 'nf' | 'nopj';
  qbo_txn_id: string | null;
  qbo_txn_type: string | null;
  file_path: string | null;
  error: string | null;
  updated_at: number | null;
};

export const RunRows = {
  bulkInsert(runId: string, rows: Array<Omit<RunRowRow, 'id' | 'run_id' | 'updated_at' | 'qbo_txn_id' | 'qbo_txn_type' | 'file_path' | 'error'>>) {
    const stmt = getDb().prepare(
      `INSERT INTO run_rows (id, run_id, row_idx, doc_number, vendor, booking_entity, amount, date, sheet, building, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = getDb().transaction(() => {
      for (const r of rows) {
        stmt.run(randomUUID(), runId, r.row_idx, r.doc_number, r.vendor, r.booking_entity, r.amount, r.date, r.sheet, r.building, r.status);
      }
    });
    tx();
  },
  listByRun(runId: string): RunRowRow[] {
    return getDb()
      .prepare('SELECT * FROM run_rows WHERE run_id = ? ORDER BY row_idx')
      .all(runId) as RunRowRow[];
  },
  get(id: string): RunRowRow | undefined {
    return getDb().prepare('SELECT * FROM run_rows WHERE id = ?').get(id) as
      | RunRowRow
      | undefined;
  },
  updateStatus(id: string, patch: Partial<Pick<RunRowRow, 'status' | 'qbo_txn_id' | 'qbo_txn_type' | 'file_path' | 'error'>>) {
    const existing = getDb().prepare('SELECT * FROM run_rows WHERE id = ?').get(id) as RunRowRow | undefined;
    if (!existing) return;
    const merged = { ...existing, ...patch, updated_at: Date.now() };
    getDb()
      .prepare(
        `UPDATE run_rows SET status=?, qbo_txn_id=?, qbo_txn_type=?, file_path=?, error=?, updated_at=? WHERE id=?`,
      )
      .run(merged.status, merged.qbo_txn_id, merged.qbo_txn_type, merged.file_path, merged.error, merged.updated_at, id);
  },
};

export type RunRowCandidateRow = {
  id: number;
  run_row_id: string;
  qbo_txn_id: string;
  qbo_txn_type: string; // 'Bill' | 'Purchase' | 'Invoice'
  vendor_name: string | null;
  txn_date: string | null;
  total_amount: number | null;
  doc_number: string | null;
  attachable_count: number;
  attachable_kinds: string; // JSON array of strings
  created_at: number;
};

export type NewCandidate = Omit<RunRowCandidateRow, 'id' | 'created_at'>;

export const RunRowCandidates = {
  bulkInsert(runRowId: string, candidates: NewCandidate[]): void {
    if (candidates.length === 0) return;
    const stmt = getDb().prepare(
      `INSERT INTO run_row_candidates
        (run_row_id, qbo_txn_id, qbo_txn_type, vendor_name, txn_date, total_amount,
         doc_number, attachable_count, attachable_kinds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const tx = getDb().transaction(() => {
      for (const c of candidates) {
        stmt.run(
          runRowId,
          c.qbo_txn_id,
          c.qbo_txn_type,
          c.vendor_name,
          c.txn_date,
          c.total_amount,
          c.doc_number,
          c.attachable_count,
          c.attachable_kinds,
          now,
        );
      }
    });
    tx();
  },
  listByRow(runRowId: string): RunRowCandidateRow[] {
    return getDb()
      .prepare('SELECT * FROM run_row_candidates WHERE run_row_id = ? ORDER BY id')
      .all(runRowId) as RunRowCandidateRow[];
  },
  listByRowKey(rowKey: string): RunRowCandidateRow[] {
    // run_rows.id is what the engine emits as rowId in updates.
    return RunRowCandidates.listByRow(rowKey);
  },
  deleteByRow(runRowId: string): void {
    getDb().prepare('DELETE FROM run_row_candidates WHERE run_row_id = ?').run(runRowId);
  },
};

export type VendorAliasRow = {
  company_key: string;
  raw_name: string;
  canonical_name: string;
  updated_at: number;
};

export const VendorAliases = {
  listByCompany(companyKey: string): VendorAliasRow[] {
    return getDb()
      .prepare('SELECT * FROM vendor_aliases WHERE company_key = ? ORDER BY canonical_name, raw_name')
      .all(companyKey) as VendorAliasRow[];
  },
  mapByCompany(companyKey: string): Map<string, string> {
    const rows = VendorAliases.listByCompany(companyKey);
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.raw_name, r.canonical_name);
    return m;
  },
  upsert(companyKey: string, rawName: string, canonicalName: string): void {
    getDb()
      .prepare(
        `INSERT INTO vendor_aliases (company_key, raw_name, canonical_name, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(company_key, raw_name) DO UPDATE SET canonical_name = excluded.canonical_name, updated_at = excluded.updated_at`,
      )
      .run(companyKey, rawName, canonicalName, Date.now());
  },
  upsertMany(companyKey: string, entries: { rawName: string; canonicalName: string }[]): void {
    const stmt = getDb().prepare(
      `INSERT INTO vendor_aliases (company_key, raw_name, canonical_name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(company_key, raw_name) DO UPDATE SET canonical_name = excluded.canonical_name, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    const tx = getDb().transaction(() => {
      for (const e of entries) stmt.run(companyKey, e.rawName, e.canonicalName, now);
    });
    tx();
  },
  delete(companyKey: string, rawName: string): void {
    getDb()
      .prepare('DELETE FROM vendor_aliases WHERE company_key = ? AND raw_name = ?')
      .run(companyKey, rawName);
  },
  renameCanonical(companyKey: string, oldName: string, newName: string): void {
    getDb()
      .prepare('UPDATE vendor_aliases SET canonical_name = ?, updated_at = ? WHERE company_key = ? AND canonical_name = ?')
      .run(newName, Date.now(), companyKey, oldName);
  },
};

// Project-keyed budget cache (v5+). Several companies on the same
// project hit the same cached rows, so switching company in the
// sidebar doesn't trigger a re-fetch from gsheets/excel.
export const BudgetCache = {
  get(projectId: string): { rows: unknown[]; syncedAt: number } | null {
    const row = getDb()
      .prepare('SELECT rows_json, synced_at FROM budget_cache WHERE project_id = ?')
      .get(projectId) as { rows_json: string; synced_at: number } | undefined;
    if (!row) return null;
    return { rows: JSON.parse(row.rows_json), syncedAt: row.synced_at };
  },
  set(projectId: string, rows: unknown[]) {
    getDb()
      .prepare(
        `INSERT INTO budget_cache (project_id, rows_json, synced_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET rows_json=excluded.rows_json, synced_at=excluded.synced_at`,
      )
      .run(projectId, JSON.stringify(rows), Date.now());
  },
};

// Projects = top-level grouping of companies that share a budget. A
// project owns the gsheets workbook / excel path; the companies it
// contains route extraction queries to their respective QBO realms.
export const Projects = {
  list(): ProjectRow[] {
    return getDb()
      .prepare('SELECT * FROM projects ORDER BY sort_order, created_at')
      .all() as ProjectRow[];
  },
  get(id: string): ProjectRow | undefined {
    return getDb()
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
  },
  add(p: NewProject): ProjectRow {
    const now = Date.now();
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO projects (id, name, budget_source, sort_order, created_at, updated_at)
         VALUES (@id, @name, @budget_source, @sort_order, @created_at, @updated_at)`,
      )
      .run({
        id,
        name: p.name,
        budget_source: p.budget_source ?? null,
        sort_order: now,
        created_at: now,
        updated_at: now,
      });
    return Projects.get(id)!;
  },
  update(id: string, patch: Partial<ProjectRow>): ProjectRow | undefined {
    const existing = Projects.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...patch, id, updated_at: Date.now() };
    getDb()
      .prepare(
        `UPDATE projects SET
          name=@name, budget_source=@budget_source,
          gsheets_workbook_id=@gsheets_workbook_id,
          gsheets_workbook_name=@gsheets_workbook_name,
          excel_path=@excel_path,
          sort_order=@sort_order, updated_at=@updated_at
         WHERE id=@id`,
      )
      .run(merged);
    return Projects.get(id);
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
  // Companies belonging to the project — convenience for the sidebar.
  companies(projectId: string): CompanyRow[] {
    return getDb()
      .prepare(
        'SELECT * FROM companies WHERE project_id = ? ORDER BY sort_order, created_at',
      )
      .all(projectId) as CompanyRow[];
  },
};

function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}
