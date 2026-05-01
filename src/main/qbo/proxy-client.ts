import { Settings } from '../db/repo';
import { Secrets } from '../secrets';
import { QboApiError, type QboAttachable, type QboBill } from './client';

// Server-proxy variant of QboClient. Same public surface, but every method
// hits the Vercel-hosted proxy instead of Intuit directly. The proxy holds
// the OAuth token and refreshes it transparently — this client only carries
// an API key so the server can identify which realm it's allowed to talk to.
//
// API keys are stored per-company (matching the per-company tokens of local
// mode) because each server-side key is bound to a single realm. Switching
// active company swaps the key seamlessly.

const DEFAULT_PROXY_URL = 'https://qbo-extractor-oauth.vercel.app';

export type ProxyConfig = {
  url: string;
  apiKey: string;
};

export async function getProxyConfig(companyKey: string): Promise<ProxyConfig | null> {
  const apiKey = await Secrets.getQboProxyApiKey(companyKey);
  if (!apiKey) return null;
  const url = Settings.get('qbo_proxy_url') ?? DEFAULT_PROXY_URL;
  return { url: url.replace(/\/$/, ''), apiKey };
}

// Per-company proxy mode: each company decides independently whether it
// uses the centralized server proxy or the local OAuth flow. This is the
// right granularity because pairing is per-company too — global toggle
// previously caused "I enabled proxy for Altitude and now TDL is broken
// because it doesn't have a key yet."
//
// Setting key: `qbo_proxy_enabled:{companyKey}` = '1' | '0'
export function isProxyMode(companyKey: string): boolean {
  return Settings.get(`qbo_proxy_enabled:${companyKey}`) === '1';
}

async function callProxy<T>(
  config: ProxyConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.url}${path}`;
  // 30 s timeout — search-by-doc-number can take a few seconds on a busy
  // realm (3 parallel QBO queries) but anything past 30 s is a network
  // hang we want to surface as an error instead of freezing the run loop.
  const res = await fetch(url, {
    method,
    headers: {
      'X-API-Key': config.apiKey,
      'Accept': 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string; error?: string };
      detail = j.detail ?? j.error ?? detail;
    } catch {
      detail = `${res.status} ${await res.text()}`;
    }
    throw new QboApiError(`Proxy: ${detail}`, res.status);
  }
  return (await res.json()) as T;
}

export class QboProxyClient {
  // realmId/env aren't used on this side — the server resolves them from
  // the API key. We keep the signature aligned with QboClient so the
  // factory swap is transparent to callers.
  constructor(
    private companyKey: string,
    _realmId: string,
    _env: 'sandbox' | 'production',
    _region: 'us' | 'ca' = 'us',
  ) {
    void _realmId;
    void _env;
    void _region;
  }

  private async config(): Promise<ProxyConfig> {
    const c = await getProxyConfig(this.companyKey);
    if (!c) {
      throw new QboApiError(
        `Mode proxy activé mais aucune API key configurée pour cette compagnie. Va dans Connect → QBO Server Proxy.`,
      );
    }
    return c;
  }

  async ping(): Promise<
    | { ok: true; companyName: string; legalName?: string }
    | { ok: false; status?: number; error: string; body?: string }
  > {
    try {
      const c = await this.config();
      const res = await callProxy<{ companyName: string; legalName?: string }>(c, 'GET', '/api/qbo/companyinfo');
      return { ok: true, companyName: res.companyName, legalName: res.legalName };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof QboApiError ? err.status : undefined;
      return { ok: false, status, error: msg };
    }
  }

  async searchByDocNumber(docNumber: string): Promise<QboBill[]> {
    const c = await this.config();
    const r = await callProxy<{ results: QboBill[] }>(c, 'POST', '/api/qbo/search-by-doc-number', { docNumber });
    return r.results;
  }

  async getAttachables(
    txnId: string,
    txnType: 'Bill' | 'Purchase' | 'Invoice',
  ): Promise<QboAttachable[]> {
    const c = await this.config();
    const r = await callProxy<{ results: QboAttachable[] }>(c, 'POST', '/api/qbo/attachables', { txnId, txnType });
    return r.results;
  }

  async getAttachmentDownloadUrl(attachableId: string): Promise<string> {
    void attachableId;
    throw new QboApiError(
      'getAttachmentDownloadUrl indisponible en mode proxy — utilise downloadAttachment.',
    );
  }

  async downloadAttachment(
    attachable: QboAttachable,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const c = await this.config();
    const fileName = encodeURIComponent(attachable.FileName ?? `attachment-${attachable.Id}`);
    const url = `${c.url}/api/qbo/attachments/${attachable.Id}/download?fileName=${fileName}`;
    // 60 s — large PDF/JPEG attachments stream through the proxy and can
    // legitimately take a while on slow connections.
    const res = await fetch(url, {
      headers: { 'X-API-Key': c.apiKey },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new QboApiError(`Téléchargement proxy a échoué (${res.status})`, res.status);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType =
      res.headers.get('content-type') ?? attachable.ContentType ?? 'application/octet-stream';
    return { buffer, contentType };
  }
}

export async function pingProxyHealth(
  companyKey: string,
): Promise<
  | { ok: true; connected: boolean; realm_id?: string; refresh_expires_in_days?: number }
  | { ok: false; error: string }
> {
  const c = await getProxyConfig(companyKey);
  if (!c) return { ok: false, error: 'API key proxy non configurée pour cette compagnie.' };
  try {
    const r = await callProxy<{
      connected: boolean;
      realm_id?: string;
      refresh_expires_in_days?: number;
    }>(c, 'GET', '/api/qbo/status');
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
