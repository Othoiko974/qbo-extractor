export type Company = {
  key: string;
  label: string;
  initials: string;
  color: string;
  connected: boolean;
  qboEnv?: 'sandbox' | 'production';
  qboRealmId?: string;
  // Project the company belongs to (v5+). Budget config is read from
  // there; per-company budget fields below are kept on the type for
  // back-compat with renderer callers but mirror the project's values.
  projectId?: string | null;
  budgetSource?: 'gsheets' | 'excel';
  gsheetsWorkbookId?: string;
  gsheetsWorkbookName?: string;
  gsheetsEmail?: string;
  excelPath?: string;
  gsheetsConnected?: boolean;
  // Strings the user expects to see in the budget's "Fournisseur" (booking
  // entity) column for this company. Default at creation = [label]. Used to
  // route rows to the right QBO instance and to filter the dashboard.
  entityAliases?: string[];
};

export type Project = {
  id: string;
  name: string;
  budgetSource: 'gsheets' | 'excel' | null;
  gsheetsWorkbookId: string | null;
  gsheetsWorkbookName: string | null;
  excelPath: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type BudgetRow = {
  id: string;
  sheet: string;
  date: string;
  docNumber: string;
  // Canonical vendor name (real merchant, e.g. "The Home Depot"), after alias
  // normalization. When no alias is known, equals the raw extracted name.
  vendor: string;
  // Booking entity from the Excel "Fournisseur" column — who recorded the
  // purchase in its books (Altitude 233 Inc., TDL Construction Inc., VSL…).
  // Routes to the right QBO account; distinct from the real merchant above.
  bookingEntity: string;
  amount: number;
  building?: string;
  comment?: string;
  // When the parser derives docNumber / vendor from the comment column, the
  // original Excel values are preserved here so the engine can fall back to
  // them if the preferred lookup fails.
  rawDocNumber?: string;
  // Raw vendor as extracted from the comment/N° cell, before alias normalization.
  // Only set when different from `vendor`.
  rawVendor?: string;
  splitGroupId?: string;
  splitGroupSize?: number;
  splitIndex?: number;
  hasAttachment: boolean;
};

export type VendorAlias = {
  rawName: string;
  canonicalName: string;
  updatedAt: number;
};

export type VendorCluster = {
  canonical: string;
  aliases: string[];
  score: number;
};

export type ExtractionStatus =
  | 'queue'
  | 'run'
  | 'ok'
  | 'amb'
  | 'nf'
  | 'nopj';

export type ExtractionRow = BudgetRow & {
  status: ExtractionStatus;
  resultFileName?: string;
  resultFilePath?: string;
  // Persisted run_rows.id for this row — needed to look up its QBO candidates
  // from `run_row_candidates` when the row is ambiguous.
  runRowId?: string;
  // QBO transaction the engine matched for this row (when status is 'ok'
  // or 'nopj'). Lets the Review screen open the exact bill/expense in
  // QBO instead of dumping the user on a global search page.
  qboTxnId?: string;
  qboTxnType?: 'Bill' | 'Purchase' | 'Invoice';
};

// QBO candidate persisted alongside an ambiguous run_row. Surfaced to the
// AmbiguousResolver UI so the user can pick the right transaction without
// the engine re-querying QBO.
export type RunRowCandidate = {
  id: number;
  runRowId: string;
  txnId: string;
  txnType: 'Bill' | 'Purchase' | 'Invoice';
  vendorName: string | null;
  txnDate: string | null;
  totalAmount: number | null;
  docNumber: string | null;
  attachableCount: number;
  attachableKinds: string[];
};

// Candidate fetched live from a sister company's QBO realm via the
// resolver's "Chercher dans les autres compagnies" action. Same shape
// as a saved candidate but without an id (not persisted) and tagged
// with which company it came from so the resolve step can override
// the QBO source for the download.
export type SisterCandidate = {
  companyKey: string;
  companyLabel: string;
  txnId: string;
  txnType: 'Bill' | 'Purchase' | 'Invoice';
  vendorName: string | null;
  txnDate: string | null;
  totalAmount: number | null;
  docNumber: string | null;
  attachableCount: number;
  attachableKinds: string[];
};

export type Screen =
  | 'onboarding'
  | 'dashboard'
  | 'extraction'
  | 'review'
  | 'resolver'
  | 'gsheets'
  | 'connect'
  | 'history'
  | 'preview'
  | 'vendors'
  | 'settings';
