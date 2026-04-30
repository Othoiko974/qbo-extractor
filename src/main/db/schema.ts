export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- v5: Project = "Building" / construction project. Several companies
-- (Altitude / TDL / VSL …) work on the same project and need to look
-- at the same budget. Budget config (gsheets / excel) lives at the
-- project level so switching the active company in the sidebar keeps
-- the same budget loaded — only the QBO routing + entity-alias filter
-- changes per company.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  budget_source TEXT CHECK(budget_source IN ('gsheets', 'excel')),
  gsheets_workbook_id TEXT,
  gsheets_workbook_name TEXT,
  excel_path TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  initials TEXT NOT NULL,
  color TEXT NOT NULL,
  qbo_realm_id TEXT,
  qbo_env TEXT NOT NULL DEFAULT 'sandbox' CHECK(qbo_env IN ('sandbox', 'production')),
  -- Budget columns kept nullable for back-compat with v0.1.x DBs that
  -- still have data here. New code reads from projects.
  budget_source TEXT CHECK(budget_source IN ('gsheets', 'excel')),
  gsheets_workbook_id TEXT,
  gsheets_workbook_name TEXT,
  gsheets_account_email TEXT,
  excel_path TEXT,
  qbo_connected INTEGER NOT NULL DEFAULT 0,
  gsheets_connected INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- JSON array of strings: every booking-entity label (Excel "Fournisseur"
  -- column) the user expects to belong to this company. Used to filter
  -- the Dashboard and refuse extraction of rows belonging to another
  -- company's QBO. Default at creation = ["{label}"].
  entity_aliases TEXT NOT NULL DEFAULT '[]',
  -- v5: each company belongs to exactly one project. Migration
  -- backfills every existing row with the same default project id so
  -- the sidebar stays coherent for users upgrading from v0.1.x.
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_project ON companies(project_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  company_key TEXT NOT NULL REFERENCES companies(key) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  amb_count INTEGER NOT NULL DEFAULT 0,
  nf_count INTEGER NOT NULL DEFAULT 0,
  nopj_count INTEGER NOT NULL DEFAULT 0,
  folder TEXT,
  sheet_label TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_company ON runs(company_key);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS run_rows (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  row_idx INTEGER NOT NULL,
  doc_number TEXT,
  vendor TEXT,
  booking_entity TEXT,
  amount REAL,
  date TEXT,
  sheet TEXT,
  building TEXT,
  status TEXT NOT NULL DEFAULT 'queue',
  qbo_txn_id TEXT,
  qbo_txn_type TEXT,
  file_path TEXT,
  error TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_rows_run ON run_rows(run_id);

-- v5: budget cache rekeyed from company_key to project_id. The cache
-- is a pure derived store (re-fetched from gsheets/excel on demand),
-- so the migration just drops the old shape and any cached rows the
-- next budget load will rebuild it.
CREATE TABLE IF NOT EXISTS budget_cache (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  rows_json TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vendor_aliases (
  company_key TEXT NOT NULL REFERENCES companies(key) ON DELETE CASCADE,
  raw_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (company_key, raw_name)
);
CREATE INDEX IF NOT EXISTS idx_vendor_aliases_canon ON vendor_aliases(company_key, canonical_name);

-- When the engine resolves an invoice number to multiple QBO transactions
-- (Bill / Purchase) and the amount + date filter still leaves ≥ 2 candidates,
-- the row is marked 'amb'. We persist the candidates here so the user can
-- pick the right one from the resolver UI without re-querying QBO.
CREATE TABLE IF NOT EXISTS run_row_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_row_id TEXT NOT NULL REFERENCES run_rows(id) ON DELETE CASCADE,
  qbo_txn_id TEXT NOT NULL,
  qbo_txn_type TEXT NOT NULL,
  vendor_name TEXT,
  txn_date TEXT,
  total_amount REAL,
  doc_number TEXT,
  attachable_count INTEGER NOT NULL DEFAULT 0,
  attachable_kinds TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_row ON run_row_candidates(run_row_id);
`;

export const CURRENT_VERSION = 5;

// Per-version migrations. Applied in order for any version < CURRENT_VERSION.
// Each migration must be idempotent and self-contained (the "CREATE TABLE IF
// NOT EXISTS" in SCHEMA handles fresh installs; migrations handle upgrades
// from an existing DB that has the old shape).
export const MIGRATIONS: { to: number; sql: string }[] = [
  {
    to: 2,
    sql: `
      ALTER TABLE run_rows ADD COLUMN booking_entity TEXT;
      CREATE TABLE IF NOT EXISTS vendor_aliases (
        company_key TEXT NOT NULL REFERENCES companies(key) ON DELETE CASCADE,
        raw_name TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (company_key, raw_name)
      );
      CREATE INDEX IF NOT EXISTS idx_vendor_aliases_canon ON vendor_aliases(company_key, canonical_name);
    `,
  },
  {
    to: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS run_row_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_row_id TEXT NOT NULL REFERENCES run_rows(id) ON DELETE CASCADE,
        qbo_txn_id TEXT NOT NULL,
        qbo_txn_type TEXT NOT NULL,
        vendor_name TEXT,
        txn_date TEXT,
        total_amount REAL,
        doc_number TEXT,
        attachable_count INTEGER NOT NULL DEFAULT 0,
        attachable_kinds TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_row ON run_row_candidates(run_row_id);
    `,
  },
  {
    to: 4,
    sql: `
      ALTER TABLE companies ADD COLUMN entity_aliases TEXT NOT NULL DEFAULT '[]';
      -- Backfill: assume every existing company owns rows whose Fournisseur
      -- column literally matches its label, until the user customizes.
      UPDATE companies SET entity_aliases = json_array(label) WHERE entity_aliases = '[]';
    `,
  },
  {
    to: 5,
    // Introduce projects. Existing single-project installations get one
    // default project that inherits the budget config of whichever
    // company first set it up; every company is then linked to that
    // project. Budget cache is rekeyed from company to project — its
    // contents are throwaway (re-fetched from gsheets/excel on demand)
    // so the migration just drops + recreates.
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        budget_source TEXT CHECK(budget_source IN ('gsheets', 'excel')),
        gsheets_workbook_id TEXT,
        gsheets_workbook_name TEXT,
        excel_path TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      ALTER TABLE companies ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_companies_project ON companies(project_id);

      -- Seed: pick the company that has budget config (workbook id or
      -- excel path) — there's typically only one in a v0.1.x install.
      -- Fall back to a blank project if none does.
      INSERT INTO projects (id, name, budget_source, gsheets_workbook_id, gsheets_workbook_name, excel_path, created_at, updated_at)
      SELECT
        lower(hex(randomblob(8))),
        COALESCE(gsheets_workbook_name, 'Projet par défaut'),
        budget_source,
        gsheets_workbook_id,
        gsheets_workbook_name,
        excel_path,
        strftime('%s', 'now') * 1000,
        strftime('%s', 'now') * 1000
      FROM companies
      WHERE gsheets_workbook_id IS NOT NULL OR excel_path IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1;

      -- Empty fallback if nothing seeded above.
      INSERT INTO projects (id, name, created_at, updated_at)
      SELECT
        lower(hex(randomblob(8))),
        'Projet par défaut',
        strftime('%s', 'now') * 1000,
        strftime('%s', 'now') * 1000
      WHERE NOT EXISTS (SELECT 1 FROM projects);

      UPDATE companies SET project_id = (SELECT id FROM projects ORDER BY created_at ASC LIMIT 1);

      -- Rebuild budget_cache keyed by project. Its contents are derived
      -- so dropping is safe.
      DROP TABLE IF EXISTS budget_cache;
      CREATE TABLE budget_cache (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        rows_json TEXT NOT NULL,
        synced_at INTEGER NOT NULL
      );
    `,
  },
];
