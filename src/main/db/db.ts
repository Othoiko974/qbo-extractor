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
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(conn: Database.Database) {
  const row = conn.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  if (!row) {
    conn.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_VERSION);
    seedDefaultSettings(conn);
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
