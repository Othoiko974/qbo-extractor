import { app, shell, BrowserWindow } from 'electron';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { Secrets, type GoogleToken } from './secrets';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export class GoogleOAuthError extends Error {}

export async function connectGoogle(companyKey: string): Promise<{ email: string }> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new GoogleOAuthError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET non configurés.');
  }

  const { server, port } = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${port}/gauth/callback`;

  const oauth2 = new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri });
  const state = crypto.randomBytes(24).toString('hex');
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });

  shell.openExternal(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new GoogleOAuthError('Délai OAuth Google dépassé'));
    }, 5 * 60 * 1000);

    server.on('request', (req, res) => {
      if (!req.url?.startsWith('/gauth/callback')) return;
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const gotState = url.searchParams.get('state');
      const gotCode = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err || gotState !== state || !gotCode) {
        res.end('<h1>Erreur</h1><p>Vous pouvez fermer cette fenêtre et réessayer.</p>');
        clearTimeout(timeout);
        server.close();
        reject(new GoogleOAuthError(err ?? 'Réponse OAuth Google invalide'));
        return;
      }
      res.end('<h1>Connecté ✓</h1><p>Vous pouvez fermer cette fenêtre et retourner à QBO Extractor.</p>');
      clearTimeout(timeout);
      server.close();
      resolve(gotCode);
    });
  });

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new GoogleOAuthError('Réponse Google incomplète (pas de refresh_token).');
  }
  oauth2.setCredentials(tokens);
  const userInfo = await oauth2.request<{ email: string }>({
    url: 'https://www.googleapis.com/oauth2/v2/userinfo',
  });

  const token: GoogleToken = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope ?? SCOPES.join(' '),
    token_type: tokens.token_type ?? 'Bearer',
    expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
  };
  await Secrets.setGoogle(companyKey, token);

  return { email: userInfo.data.email };
}

export async function getGoogleClient(companyKey: string): Promise<OAuth2Client> {
  const token = await Secrets.getGoogle(companyKey);
  if (!token) throw new GoogleOAuthError('Compte Google non connecté');
  const oauth2 = new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  oauth2.setCredentials({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    token_type: token.token_type,
    expiry_date: token.expiry_date,
  });
  oauth2.on('tokens', async (t) => {
    const next: GoogleToken = {
      ...token,
      access_token: t.access_token ?? token.access_token,
      refresh_token: t.refresh_token ?? token.refresh_token,
      expiry_date: t.expiry_date ?? token.expiry_date,
    };
    await Secrets.setGoogle(companyKey, next);
  });
  return oauth2;
}

async function startLoopbackServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}
