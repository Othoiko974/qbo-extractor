import { app, BrowserWindow, shell } from 'electron';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exchangeCode } from './qbo/client';
import { Secrets, type QboToken } from './secrets';
import { Companies } from './db/repo';

// QBO OAuth — Intuit requires a fixed redirect URI whitelisted in the Intuit
// Developer dashboard. Two supported modes:
//
//   1. Custom scheme `qboextractor://oauth-callback` (requires an HTTPS bridge
//      page configured in Intuit). Used in production builds.
//   2. Loopback `http://127.0.0.1:<port>/qbo/callback`. Simpler for dev; you
//      must whitelist a specific port. We reserve port 53687 by default.

type Pending = {
  companyKey: string;
  env: 'sandbox' | 'production';
  createdAt: number;
  resolve: (payload: { code: string; realmId: string }) => void;
  reject: (err: Error) => void;
};

const pending = new Map<string, Pending>();
const LOOPBACK_PORT = Number(process.env.QBO_LOOPBACK_PORT ?? 53687);
const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/qbo/callback`;
const SCOPE = 'com.intuit.quickbooks.accounting';

async function getClientId(): Promise<string> {
  const stored = await Secrets.getQboAppCreds();
  if (stored?.client_id) return stored.client_id;
  return process.env.QBO_CLIENT_ID ?? '';
}

let loopbackServer: http.Server | null = null;

function useLoopback(): boolean {
  return process.env.QBO_OAUTH_MODE === 'loopback';
}

export function registerCustomScheme() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('qboextractor', process.execPath, [process.argv[1]]);
    }
  } else {
    app.setAsDefaultProtocolClient('qboextractor');
  }
}

export function handleDeepLink(url: string, mainWindow: BrowserWindow | null) {
  if (!url.startsWith('qboextractor://')) return;
  const u = new URL(url);
  const state = u.searchParams.get('state');
  const code = u.searchParams.get('code');
  const realmId = u.searchParams.get('realmId');
  if (!state) return;
  const entry = pending.get(state);
  if (entry && code && realmId) {
    pending.delete(state);
    entry.resolve({ code, realmId });
  }
  if (mainWindow) mainWindow.focus();
}

async function startLoopbackServer(): Promise<http.Server> {
  if (loopbackServer) return loopbackServer;
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/qbo/callback')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const u = new URL(req.url, `http://127.0.0.1:${LOOPBACK_PORT}`);
    const state = u.searchParams.get('state');
    const code = u.searchParams.get('code');
    const realmId = u.searchParams.get('realmId');
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!state || err || !code || !realmId) {
      res.end('<h1>Erreur OAuth</h1><p>Vous pouvez fermer cette fenêtre et réessayer.</p>');
      if (state) {
        const entry = pending.get(state);
        if (entry) {
          pending.delete(state);
          entry.reject(new Error(err ?? 'Réponse OAuth invalide'));
        }
      }
      return;
    }
    res.end('<h1>Connecté à QuickBooks ✓</h1><p>Vous pouvez fermer cette fenêtre et retourner à QBO Extractor.</p>');
    const entry = pending.get(state);
    if (entry) {
      pending.delete(state);
      entry.resolve({ code, realmId });
    }
  });
  server.on('close', () => {
    loopbackServer = null;
  });

  return new Promise<http.Server>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Le port ${LOOPBACK_PORT} est déjà occupé (une autre instance de QBO Extractor tourne probablement). Ferme-la et réessaie.`,
          ),
        );
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const info = server.address() as AddressInfo | null;
      if (!info) {
        reject(new Error('Loopback server failed to bind'));
        return;
      }
      loopbackServer = server;
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(LOOPBACK_PORT, '127.0.0.1');
  });
}

export async function connectQbo(
  companyKey: string,
  env: 'sandbox' | 'production' = 'sandbox',
): Promise<{ realmId: string }> {
  const clientId = await getClientId();
  if (!clientId) {
    throw new Error("QBO_CLIENT_ID non configuré — renseigne-le dans Réglages → Credentials Intuit.");
  }

  const state = crypto.randomBytes(24).toString('hex');
  const redirectUri = useLoopback()
    ? LOOPBACK_REDIRECT
    : process.env.QBO_REDIRECT_URI ?? 'https://qbo-extractor-oauth.vercel.app/qbo/callback';

  if (useLoopback()) await startLoopbackServer();

  const authUrl =
    'https://appcenter.intuit.com/connect/oauth2' +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&state=${state}`;

  shell.openExternal(authUrl);

  const { code, realmId } = await new Promise<{ code: string; realmId: string }>((resolve, reject) => {
    pending.set(state, {
      companyKey,
      env,
      createdAt: Date.now(),
      resolve,
      reject,
    });
    setTimeout(() => {
      if (pending.has(state)) {
        pending.delete(state);
        reject(new Error('Délai OAuth dépassé (10 min).'));
      }
    }, 10 * 60 * 1000);
  });

  const tokens = await exchangeCode(code, redirectUri);
  const qboToken: QboToken = {
    ...tokens,
    realm_id: realmId,
    env,
  };
  await Secrets.setQbo(companyKey, qboToken);
  Companies.update(companyKey, {
    qbo_realm_id: realmId,
    qbo_env: env,
    qbo_connected: 1,
  });
  return { realmId };
}

export async function disconnectQbo(companyKey: string): Promise<void> {
  await Secrets.deleteQbo(companyKey);
  Companies.update(companyKey, { qbo_realm_id: null, qbo_connected: 0 });
}
