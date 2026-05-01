import { getProxyConfig, isProxyMode } from './proxy-client';

// Cost model: each row triggers 3 entity searches (Bill/Purchase/Invoice
// in parallel) plus a getAttachables for each candidate found. Realistic
// average is 3-5 candidates per row. We pad to 8 so the estimate covers
// the worst case without being wildly off for typical budgets.
//
// Why 8 and not measured-from-history: history would require persisting
// run telemetry server-side, which is overkill for the rate-limit gate.
// A 2x over-estimate just means the dialog says "ETA 2 min" when reality
// is 1 min — harmless.
const REQUESTS_PER_ROW = 8;
const REQUESTS_PER_SEC_THROUGHPUT = 3;

export function estimateRequests(rowCount: number): number {
  return Math.max(1, rowCount * REQUESTS_PER_ROW);
}

export function estimateDurationSec(rowCount: number): number {
  return Math.max(1, Math.round(estimateRequests(rowCount) / REQUESTS_PER_SEC_THROUGHPUT));
}

export type LockStatus =
  | { busy: false }
  | {
      busy: true;
      is_self: boolean;
      api_key_label: string;
      total_rows: number;
      estimated_requests: number;
      started_at: number;
      last_heartbeat: number;
      eta_seconds: number;
    };

export type ClaimResult =
  | { ok: true }
  | {
      ok: false;
      busy: {
        api_key_label: string;
        total_rows: number;
        estimated_requests: number;
        started_at: number;
        last_heartbeat: number;
        eta_seconds: number;
      };
    }
  | { ok: false; error: string };

async function callExtraction(
  companyKey: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const cfg = await getProxyConfig(companyKey);
  if (!cfg) {
    throw new Error('Mode proxy actif mais API key absente pour cette compagnie.');
  }
  // 10 s timeout so a network blip / DNS hang doesn't freeze the whole
  // extraction startup. The engine returns the AbortError as a regular
  // claim failure and the UI surfaces it.
  const res = await fetch(`${cfg.url}/api/qbo/extraction/${path}`, {
    method,
    headers: {
      'X-API-Key': cfg.apiKey,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  let json: unknown = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

export async function claimExtraction(
  companyKey: string,
  totalRows: number,
): Promise<ClaimResult> {
  if (!isProxyMode(companyKey)) return { ok: true }; // Local mode — no shared coordinator.
  try {
    const { status, json } = await callExtraction(companyKey, 'POST', 'claim', {
      total_rows: totalRows,
      estimated_requests: estimateRequests(totalRows),
    });
    if (status === 200) return { ok: true };
    if (status === 409 && json && typeof json === 'object' && 'busy' in json) {
      return { ok: false, busy: (json as { busy: ClaimResult extends { busy: infer B } ? B : never }).busy };
    }
    return { ok: false, error: `claim ${status}: ${JSON.stringify(json)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function heartbeatExtraction(companyKey: string): Promise<boolean> {
  if (!isProxyMode(companyKey)) return true;
  try {
    const { status } = await callExtraction(companyKey, 'POST', 'heartbeat');
    return status === 200;
  } catch {
    return false;
  }
}

export async function releaseExtraction(companyKey: string): Promise<void> {
  if (!isProxyMode(companyKey)) return;
  try {
    await callExtraction(companyKey, 'POST', 'release');
  } catch {
    // Release failures are non-fatal — the TTL will clean up server-side.
  }
}

export async function inspectExtraction(companyKey: string): Promise<LockStatus | { error: string }> {
  if (!isProxyMode(companyKey)) return { busy: false };
  try {
    const { status, json } = await callExtraction(companyKey, 'GET', 'status');
    if (status === 200 && json && typeof json === 'object') return json as LockStatus;
    return { error: `status ${status}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
