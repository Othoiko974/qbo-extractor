import { QboClient } from './client';
import { QboProxyClient, isProxyMode } from './proxy-client';

// Returns whichever client matches the current mode. Both implementations
// share the same public surface (ping, searchByDocNumber, getAttachables,
// downloadAttachment) so callers don't need to branch on mode themselves.
//
// In proxy mode the companyKey/realmId/env arguments are ignored — the
// server resolves the realm from the API key. We still take them so the
// signature matches QboClient and we can swap without touching callers.

export type QboLike = QboClient | QboProxyClient;

export function createQboClient(
  companyKey: string,
  realmId: string,
  env: 'sandbox' | 'production',
  region: 'us' | 'ca' = 'us',
): QboLike {
  if (isProxyMode()) {
    return new QboProxyClient(companyKey, realmId, env, region);
  }
  return new QboClient(companyKey, realmId, env, region);
}
