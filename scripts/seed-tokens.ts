// Run via Electron (not plain node — keytar needs the Electron runtime):
//   npx electron scripts/seed-tokens.ts
//
// Seeds companies + imports QBO tokens into keytar so the app skips OAuth on
// first launch. Edit the CONFIG block below with the realm IDs, then run.

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

type SeedEntry = {
  label: string;
  initials: string;
  color: string;
  tokenPath: string;
  realmId: string;
  env: 'sandbox' | 'production';
};

const HOME = process.env.HOME ?? '';
const CONFIG: SeedEntry[] = [
  {
    label: 'Altitude 233 Inc.',
    initials: 'A2',
    color: '#2e4d39',
    tokenPath: path.join(HOME, 'Documents/Claude/Projects/Altitude 233/.qbo_token_altitude.json'),
    realmId: process.env.QBO_REALM_ALTITUDE ?? '9130356334134926',
    env: 'production',
  },
  {
    label: 'TDL Construction',
    initials: 'TD',
    color: '#7a5a2a',
    tokenPath: path.join(HOME, 'Documents/Claude/Projects/Altitude 233/.qbo_token_tdl.json'),
    realmId: process.env.QBO_REALM_TDL ?? '9341455571180198',
    env: 'production',
  },
];

app.whenReady().then(async () => {
  const { Companies } = await import('../src/main/db/repo');
  const { Secrets } = await import('../src/main/secrets');

  for (const entry of CONFIG) {
    if (!entry.realmId) {
      console.warn(`[skip] ${entry.label} — realmId manquant`);
      continue;
    }
    if (!fs.existsSync(entry.tokenPath)) {
      console.warn(`[skip] ${entry.label} — fichier token introuvable: ${entry.tokenPath}`);
      continue;
    }

    const existing = Companies.list().find((c) => c.label === entry.label);
    const company = existing ?? Companies.add({
      label: entry.label,
      initials: entry.initials,
      color: entry.color,
      qbo_env: entry.env,
    });

    const raw = JSON.parse(fs.readFileSync(entry.tokenPath, 'utf-8')) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
      expires_at?: number;
      x_refresh_token_expires_in?: number;
    };
    const now = Date.now();
    const expiresAtMs =
      typeof raw.expires_at === 'number' && raw.expires_at < 1e12
        ? Math.round(raw.expires_at * 1000)
        : typeof raw.expires_at === 'number'
        ? raw.expires_at
        : now + (raw.expires_in ?? 3600) * 1000;
    const refreshExpiresAtMs = now + (raw.x_refresh_token_expires_in ?? 8726400) * 1000;

    await Secrets.setQbo(company.key, {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: expiresAtMs,
      refresh_expires_at: refreshExpiresAtMs,
      realm_id: entry.realmId,
      env: entry.env,
    });
    Companies.update(company.key, {
      qbo_realm_id: entry.realmId,
      qbo_env: entry.env,
      qbo_connected: 1,
    });

    console.log(`[ok] ${entry.label} → realm ${entry.realmId} (key=${company.key})`);
  }

  app.quit();
});
