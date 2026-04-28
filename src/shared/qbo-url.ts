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
