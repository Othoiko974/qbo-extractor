// Convert an absolute filesystem path into the qbo-file:// URL the
// renderer can load via <iframe>/<img>. Cross-platform:
//   macOS: /Users/owen/x.pdf       → qbo-file://local/Users/owen/x.pdf
//   Win:   C:\Users\Owen\x.pdf     → qbo-file://local/C:/Users/Owen/x.pdf
// The main-process protocol handler strips the leading slash before
// the drive letter on win32 so Node's fs accepts it.
export function toLocalFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const withLead = normalized.startsWith('/') ? normalized : '/' + normalized;
  const encoded = withLead
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `qbo-file://local${encoded}`;
}

// Build a deep-link to a QBO transaction. QBO's web app routes per type:
//   - Bill        → /app/bill?txnId=…
//   - Invoice     → /app/invoice?txnId=…   (sales / re-billing imputation)
//   - Purchase    → /app/expense?txnId=…   (cash purchase / credit card)
// The realmId query param scopes the lookup to a specific QBO company —
// without it the browser falls back to whichever company the user's web
// session is currently logged into, which collides on internal txn IDs
// when the user is connected to multiple realms.
export function qboTxnUrl(
  txnId: string,
  txnType: 'Bill' | 'Purchase' | 'Invoice' | string | null,
  realmId?: string | null,
): string {
  const path =
    txnType === 'Bill'
      ? 'bill'
      : txnType === 'Invoice'
        ? 'invoice'
        : 'expense';
  const params = new URLSearchParams({ txnId });
  if (realmId) params.set('realmId', realmId);
  return `https://qbo.intuit.com/app/${path}?${params.toString()}`;
}
