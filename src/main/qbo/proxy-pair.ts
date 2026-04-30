import { randomBytes } from 'node:crypto';
import { shell, type BrowserWindow } from 'electron';
import { Settings } from '../db/repo';
import { Secrets } from '../secrets';

// Browser-based pairing flow:
//   1. Desktop calls startPairing(companyKey) → generates a state, opens
//      the pair page in the user's default browser, returns immediately.
//   2. Browser collects the claim code, redeems it server-side, redirects
//      to qboextractor://pair?state=XXX. The deep-link handler wakes us up.
//   3. handlePairDeepLink fetches the staged API key via /api/pair/poll
//      with that state, persists it under the companyKey we opened with.
//
// State is held in memory (per-launch). 5-min TTL matches the server's
// staging TTL — if the user closes the app mid-pair, we won't be there
// to receive the deep link anyway.

type Pending = {
  companyKey: string;
  createdAt: number;
  resolve: (result: { realmId: string; label: string }) => void;
  reject: (err: Error) => void;
};

const pending = new Map<string, Pending>();
const DEFAULT_PROXY_URL = 'https://qbo-extractor-oauth.vercel.app';

function proxyUrl(): string {
  return (Settings.get('qbo_proxy_url') ?? DEFAULT_PROXY_URL).replace(/\/$/, '');
}

export async function startPairing(
  companyKey: string,
): Promise<{ realmId: string; label: string }> {
  // 32 bytes → 43-char base64url; matches the server's `[a-zA-Z0-9_-]{20,}` regex.
  const state = randomBytes(32).toString('base64url');
  const url = `${proxyUrl()}/pair?state=${encodeURIComponent(state)}`;
  await shell.openExternal(url);

  return new Promise<{ realmId: string; label: string }>((resolve, reject) => {
    pending.set(state, {
      companyKey,
      createdAt: Date.now(),
      resolve,
      reject,
    });
    // 5-min wait window — same as the server's pair stage TTL.
    setTimeout(() => {
      if (pending.has(state)) {
        pending.delete(state);
        reject(new Error('Délai de pairing dépassé (5 min) — recommence depuis Connect.'));
      }
    }, 5 * 60 * 1000);
  });
}

// Called by main.ts when a qboextractor://pair?state=XXX deep link arrives.
export async function handlePairDeepLink(
  url: string,
  mainWindow: BrowserWindow | null,
): Promise<void> {
  if (!url.startsWith('qboextractor://pair')) return;
  let state: string | null = null;
  try {
    state = new URL(url).searchParams.get('state');
  } catch {
    /* malformed URL — ignore */
  }
  if (!state) return;
  const entry = pending.get(state);
  if (!entry) return;
  pending.delete(state);
  if (mainWindow) mainWindow.focus();

  try {
    const res = await fetch(`${proxyUrl()}/api/pair/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Poll proxy a échoué (${res.status}): ${detail}`);
    }
    const j = (await res.json()) as { api_key: string; realm_id: string; label: string };
    if (!j.api_key) throw new Error('Réponse du proxy sans api_key.');
    await Secrets.setQboProxyApiKey(entry.companyKey, j.api_key);
    Settings.set('qbo_proxy_enabled', '1');
    if (!Settings.get('qbo_proxy_url')) Settings.set('qbo_proxy_url', proxyUrl());
    entry.resolve({ realmId: j.realm_id, label: j.label });
  } catch (err) {
    entry.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
