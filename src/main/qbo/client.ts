import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { Secrets, type QboToken } from '../secrets';

async function getClientCreds(): Promise<{ id: string; secret: string } | null> {
  const stored = await Secrets.getQboAppCreds();
  if (stored?.client_id && stored?.client_secret) {
    return { id: stored.client_id, secret: stored.client_secret };
  }
  const envId = process.env.QBO_CLIENT_ID ?? '';
  const envSecret = process.env.QBO_CLIENT_SECRET ?? '';
  if (envId && envSecret) return { id: envId, secret: envSecret };
  return null;
}

function qboLog(msg: string): void {
  try {
    const p = path.join(app.getPath('userData'), 'qbo-api.log');
    fs.appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
  console.log('[qbo]', msg);
}

// External observers (e.g. IPC bridge → Extraction screen cadence counter)
// register here to receive a tick each time we hit Intuit's v3 API. The
// download of a signed CDN URL is intentionally NOT reported because it
// doesn't count toward Intuit's per-minute rate limit.
export type QboRequestEvent = {
  ts: number;
  method: string;
  status: number;
  endpoint: string; // e.g. "/v3/.../query" — never contains the token
};
type QboRequestListener = (e: QboRequestEvent) => void;
const qboRequestListeners = new Set<QboRequestListener>();
export function onQboRequest(cb: QboRequestListener): () => void {
  qboRequestListeners.add(cb);
  return () => qboRequestListeners.delete(cb);
}
function emitQboRequest(method: string, url: string, status: number): void {
  if (qboRequestListeners.size === 0) return;
  // Strip query string and host so we never leak the realm or tokens.
  let endpoint = url;
  try {
    const u = new URL(url);
    endpoint = u.pathname;
  } catch {
    /* keep raw */
  }
  const evt: QboRequestEvent = { ts: Date.now(), method, status, endpoint };
  for (const l of qboRequestListeners) {
    try {
      l(evt);
    } catch {
      /* listener errors must not break the API call */
    }
  }
}

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function apiBase(env: 'sandbox' | 'production', region: 'us' | 'ca' = 'us'): string {
  if (env === 'sandbox') {
    return region === 'ca'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
  }
  return region === 'ca'
    ? 'https://quickbooks-ca.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

export class QboApiError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
  }
}

export type QboBill = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  // Bill uses VendorRef, Purchase uses EntityRef (Vendor/Customer/Employee),
  // Invoice uses CustomerRef. We surface a unified party name via _partyName
  // so callers can compare against the budget's vendor regardless of txn type.
  VendorRef?: { value: string; name?: string };
  EntityRef?: { value: string; name?: string; type?: string };
  CustomerRef?: { value: string; name?: string };
  _type: 'Bill' | 'Purchase' | 'Invoice';
  _partyName?: string;
};

export type QboAttachable = {
  Id: string;
  FileName?: string;
  FileAccessUri?: string;
  TempDownloadUri?: string;
  ContentType?: string;
};

export async function exchangeCode(code: string, redirectUri: string): Promise<Omit<QboToken, 'realm_id' | 'env'>> {
  const creds_ = await getClientCreds();
  if (!creds_) throw new QboApiError('QBO_CLIENT_ID / SECRET non configurés — renseigne-les dans Réglages.');
  const creds = Buffer.from(`${creds_.id}:${creds_.secret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new QboApiError(`Exchange a échoué (${res.status})`, res.status, await res.text());
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
  };
  const now = Date.now();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: now + json.expires_in * 1000,
    refresh_expires_at: now + json.x_refresh_token_expires_in * 1000,
  };
}

async function refreshToken(token: QboToken, companyKey: string): Promise<QboToken> {
  const creds_ = await getClientCreds();
  if (!creds_) {
    throw new QboApiError(
      'Impossible de rafraîchir le token : QBO_CLIENT_ID / SECRET non configurés. Renseigne-les dans Réglages.',
    );
  }
  const creds = Buffer.from(`${creds_.id}:${creds_.secret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
  });
  if (!res.ok) throw new QboApiError(`Refresh a échoué (${res.status})`, res.status, await res.text());
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
  };
  const now = Date.now();
  const next: QboToken = {
    ...token,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: now + json.expires_in * 1000,
    refresh_expires_at: now + json.x_refresh_token_expires_in * 1000,
  };
  await Secrets.setQbo(companyKey, next);
  return next;
}

async function authedFetch(
  companyKey: string,
  url: string,
  init?: RequestInit,
  attempt = 0,
): Promise<Response> {
  let token = await Secrets.getQbo(companyKey);
  if (!token) throw new QboApiError('Compte QBO non connecté');
  if (Date.now() > token.expires_at - 60_000) {
    const creds_ = await getClientCreds();
    if (!creds_) {
      throw new QboApiError(
        'Access token expiré et QBO_CLIENT_ID/SECRET non configurés — impossible de rafraîchir. Renseigne-les dans Réglages ou ré-importe un token frais.',
      );
    }
    token = await refreshToken(token, companyKey);
  }
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token.access_token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const res = await fetch(url, { ...init, headers });
  const method = init?.method ?? 'GET';
  qboLog(`${method} ${url} → ${res.status}`);
  emitQboRequest(method, url, res.status);
  if (res.status === 401 && attempt === 0) {
    const creds_ = await getClientCreds();
    if (!creds_) {
      throw new QboApiError(
        '401 Unauthorized — token probablement expiré, et QBO_CLIENT_ID/SECRET non configurés pour refresh.',
      );
    }
    token = await refreshToken(token, companyKey);
    return authedFetch(companyKey, url, init, attempt + 1);
  }
  return res;
}

export class QboClient {
  constructor(
    private companyKey: string,
    private realmId: string,
    private env: 'sandbox' | 'production',
    private region: 'us' | 'ca' = 'us',
  ) {}

  private base(): string {
    return `${apiBase(this.env, this.region)}/v3/company/${this.realmId}`;
  }

  async ping(): Promise<{ ok: true; companyName: string; legalName?: string } | { ok: false; status?: number; error: string; body?: string }> {
    const url = `${this.base()}/companyinfo/${this.realmId}?minorversion=73`;
    try {
      const res = await authedFetch(this.companyKey, url);
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, status: res.status, error: `HTTP ${res.status}`, body };
      }
      const json = (await res.json()) as {
        CompanyInfo?: { CompanyName?: string; LegalName?: string };
      };
      return {
        ok: true,
        companyName: json.CompanyInfo?.CompanyName ?? '(inconnu)',
        legalName: json.CompanyInfo?.LegalName,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof QboApiError ? err.status : undefined;
      return { ok: false, status, error: msg };
    }
  }

  async query<T = unknown>(sql: string): Promise<T[]> {
    const url = `${this.base()}/query?query=${encodeURIComponent(sql)}&minorversion=73`;
    qboLog(`QUERY ${sql}`);
    const res = await authedFetch(this.companyKey, url);
    if (!res.ok) {
      const body = await res.text();
      qboLog(`QUERY FAIL ${res.status} body=${body.slice(0, 500)}`);
      throw new QboApiError(`Query a échoué (${res.status})`, res.status, body);
    }
    const json = (await res.json()) as { QueryResponse?: Record<string, T[]> };
    const key = Object.keys(json.QueryResponse ?? {}).find((k) => Array.isArray((json.QueryResponse as Record<string, unknown>)[k]));
    const out = key ? ((json.QueryResponse as Record<string, T[]>)[key] ?? []) : [];
    qboLog(`QUERY RESULT count=${out.length}`);
    return out;
  }

  async searchByDocNumber(docNumber: string): Promise<QboBill[]> {
    // Query Purchase, Bill, and Invoice in parallel and merge. DocNumber
    // is not unique in QBO — different suppliers can reuse the same number,
    // and the accountant sometimes staples a supplier PDF to a re-billing
    // Invoice (e.g. Altitude 233 → TDL Construction) so the original PJ
    // only lives on that Invoice. Stopping at the first non-empty table
    // would silently bypass the engine's vendor / amount / date tie-break.
    //
    // Variant search via `WHERE DocNumber IN (…)`: budgets often write
    // Home Depot / Rona receipts as "F-7124 00061 68264" but QBO stores
    // the Bill under "7124 00061 68264" — the F- is a budget convention.
    // Same logical receipt sometimes has a Bill (supplier facture, bare)
    // AND an Invoice (re-billing imputation, with F-). Both variants go
    // into one IN-clause per table so the call cost stays at 3 requests
    // — splitting into 2 separate queries per variant + 3 tables drove
    // the request count to 6 per candidate and tripped Intuit's
    // 500/min/realm rate limit on real budgets.
    const variants = new Set<string>();
    variants.add(docNumber);
    if (/^F-/i.test(docNumber)) {
      const bare = docNumber.replace(/^F-/i, '').trim();
      if (bare) variants.add(bare);
    } else if (/^[A-Za-z0-9]/.test(docNumber)) {
      variants.add(`F-${docNumber}`);
    }
    const inClause = [...variants]
      .map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
      .join(', ');
    const entities = ['Purchase', 'Bill', 'Invoice'] as const;
    const results = await Promise.all(
      entities.map(async (entity) => {
        const rows = await this.query<Record<string, unknown>>(
          `SELECT * FROM ${entity} WHERE DocNumber IN (${inClause}) MAXRESULTS 10`,
        );
        return rows.map((r): QboBill => {
          const vendorRef = r.VendorRef as { value: string; name?: string } | undefined;
          const entityRef = r.EntityRef as { value: string; name?: string; type?: string } | undefined;
          const customerRef = r.CustomerRef as { value: string; name?: string } | undefined;
          const partyName =
            entityRef?.name ?? vendorRef?.name ?? customerRef?.name;
          return {
            Id: String(r.Id),
            DocNumber: r.DocNumber as string | undefined,
            TxnDate: r.TxnDate as string | undefined,
            TotalAmt: typeof r.TotalAmt === 'number' ? r.TotalAmt : Number(r.TotalAmt),
            VendorRef: vendorRef,
            EntityRef: entityRef,
            CustomerRef: customerRef,
            _type: entity,
            _partyName: partyName,
          };
        });
      }),
    );
    return results.flat();
  }

  async getAttachables(txnId: string, txnType: 'Bill' | 'Purchase' | 'Invoice'): Promise<QboAttachable[]> {
    // Attachable filter uses capital "Type" (not "type") for EntityRef in the query DSL.
    const sql = `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${txnType}' AND AttachableRef.EntityRef.value = '${txnId}'`;
    return (await this.query<QboAttachable>(sql)) ?? [];
  }

  async getAttachmentDownloadUrl(attachableId: string): Promise<string> {
    const url = `${this.base()}/download/${attachableId}?minorversion=73`;
    const res = await authedFetch(this.companyKey, url, { redirect: 'manual' });
    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get('location');
      if (!loc) throw new QboApiError('Redirect sans Location header');
      return loc;
    }
    if (res.ok) return (await res.text()).trim();
    throw new QboApiError(`Download URL a échoué (${res.status})`, res.status, await res.text());
  }

  async downloadAttachment(attachable: QboAttachable): Promise<{ buffer: Buffer; contentType: string }> {
    // Prefer TempDownloadUri (already in the Attachable payload), fall back to
    // the /download endpoint which 302s to a signed URL.
    let signedUrl = attachable.TempDownloadUri;
    if (!signedUrl || !signedUrl.startsWith('https://')) {
      signedUrl = await this.getAttachmentDownloadUrl(attachable.Id);
    }
    const res = await fetch(signedUrl);
    if (!res.ok) throw new QboApiError(`Téléchargement a échoué (${res.status})`, res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType =
      res.headers.get('content-type') ?? attachable.ContentType ?? 'application/octet-stream';
    return { buffer, contentType };
  }
}
