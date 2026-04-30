import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { SCHEMA, CURRENT_VERSION, MIGRATIONS } from './schema';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const userData = app.getPath('userData');
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, 'qbo-extractor.db');
  db = new Database(dbPath);

  // Bootstrap PRAGMAs and the version table so migrate() can read it on
  // both fresh installs and upgrades.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `);

  // Migrate FIRST so existing DBs reach CURRENT_VERSION shape before the
  // SCHEMA pass runs. SCHEMA contains CREATE INDEX clauses that reference
  // columns added by recent migrations (e.g. companies.project_id from v5);
  // running SCHEMA before the migration would error with "no such column".
  migrate(db);

  // SCHEMA acts as the source of truth for fresh installs (creates every
  // table/index from scratch) and as an idempotent safety net for upgrades
  // (CREATE TABLE / CREATE INDEX IF NOT EXISTS are no-ops once the migration
  // has brought the DB to the current shape).
  db.exec(SCHEMA);

  // Defaults — INSERT OR IGNORE makes this safe to call every boot.
  seedDefaultSettings(db);

  return db;
}

function migrate(conn: Database.Database) {
  const row = conn.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  if (!row) {
    // Fresh install — SCHEMA (run after this) will create everything.
    // Just stamp the version so future upgrades know where to start.
    conn.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_VERSION);
    return;
  }
  let current = row.version;
  for (const m of MIGRATIONS) {
    if (m.to > current) {
      try {
        conn.exec(m.sql);
      } catch (err) {
        // ALTER TABLE ADD COLUMN fails if the column already exists (fresh
        // installs get the final shape from SCHEMA). Ignore that specific
        // error; surface anything else.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
      current = m.to;
    }
  }
  if (current !== row.version) {
    conn.prepare('UPDATE schema_version SET version = ?').run(current);
  }
}

function seedDefaultSettings(conn: Database.Database) {
  const defaults: Record<string, string> = {
    base_folder: path.join(app.getPath('documents'), 'QBO Extracts'),
    naming_template: 'Depense_{num}_{fournisseur}_{date}_${montant}',
    language: 'fr',
    telemetry: 'false',
  };
  const stmt = conn.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) stmt.run(k, v);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
