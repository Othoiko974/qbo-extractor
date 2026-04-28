import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { BudgetRow } from '../../types/domain';

// Budget sheets come from Google Sheets or Excel. The user's real spreadsheet
// has 20+ worksheets (030-Béton, 040-Maçon, 154-Plomberie, etc.) and each row
// is a billed expense. Column variants we tolerate:
//
//   Date       | "Date"
//   Num        | "N°", "No", "Numéro", "Facture", "N° facture", "Numero de Facture"
//   Fournisseur| "Fournisseur", "Vendor", "Nom" — THIS IS THE BOOKING ENTITY
//              | (Altitude 233 Inc. / TDL Construction Inc. / VSL), NOT the
//              | real merchant. The real vendor (Home Depot, Rona, Pont Masson)
//              | is usually embedded in the Comment column.
//   Montant    | "Montant", "Total", "Amount", "$"
//   Bâtiment   | "Bâtiment", "Batiment", "Building"
//   PJ         | "PJ", "Pièce jointe", "Attachment", "Téléchargé"
//   Commentaire| "Commentaire", "Description", "Note", "Libellé"
//
// Rows are parsed one *line* at a time from the N°/Comment cells, because a
// single Excel row often lists several invoices from several different
// merchants, separated by newlines — e.g.:
//   "030; CTRE RENOVATIONS; F-201533531
//    030; Rona; F-053879"
// The old parser treated the whole cell as one blob and mis-attributed both
// invoices to the first-seen vendor.

const COLS = {
  date: ['date'],
  num: ['num', 'no', 'n°', 'numéro', 'numero', 'facture', 'n° facture', 'n de facture', 'n. facture', 'invoice', 'doc', 'numero de facture', 'invoice no', 'invoice no.', 'invoice number', 'invoice #'],
  vendor: ['fournisseur', 'vendor', 'nom', 'fournisseur / vendor', 'supplier', 'payee'],
  amount: ['montant', 'total', 'amount', '$', 'montant ($)', 'total ($)'],
  building: ['bâtiment', 'batiment', 'building', 'immeuble'],
  pj: ['pj', 'pièce jointe', 'piece jointe', 'attachment', 'téléchargé', 'telecharge', 'pièce', 'piece'],
  comment: ['commentaire', 'commentaires', 'description', 'note', 'notes', 'détail', 'detail', 'détails', 'details', 'libellé', 'libelle', 'remarque', 'remarques'],
};

function normalizeHeader(h: string): string {
  return h.toString().trim().toLowerCase();
}

function findColumn(sample: Record<string, unknown>, candidates: string[]): string | undefined {
  const keys = Object.keys(sample);
  for (const k of keys) {
    const n = normalizeHeader(k);
    if (candidates.includes(n)) return k;
  }
  for (const k of keys) {
    const n = normalizeHeader(k);
    if (candidates.some((c) => n.includes(c))) return k;
  }
  return undefined;
}

function parseAmount(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/\s/g, '').replace(/[$€£]/g, '');
  const neg = /^\((.+)\)$/.test(s);
  if (neg) s = s.replace(/^\(|\)$/g, '');
  s = s.replace(/,/g, '.');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

function parsePj(v: unknown): boolean {
  if (v == null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  if (s === 'non' || s === 'no' || s === '0' || s === 'false' || s === 'manquant' || s === 'manquante') return false;
  return true;
}

// Google Sheets stores invoice attachments as inline images. When the sheet
// is exported to xlsx (or pulled as a snippet via the API), each image
// collapses to a string containing its file name — e.g. "Rona 57071.pdf".
// There's typically no dedicated PJ column, so we scan every cell of the row
// and treat it as having an attachment if any value contains a file
// extension. The `s + ' '` pad lets the trailing-space lookahead also match
// when the extension is at the very end of the cell.
const ATTACHMENT_EXT_RE = /\.(pdf|jpe?g|png|heic|tiff?|gif|webp)(?:\s|$)/i;
function rowHasAttachmentFile(r: Record<string, unknown>): boolean {
  for (const v of Object.values(r)) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v : String(v);
    if (ATTACHMENT_EXT_RE.test(s + ' ')) return true;
  }
  return false;
}

// Parse "2025-08-05", "05-08-2025", "8/5/25", "17-04-2025". Produces
// YYYY-MM-DD. Uses "first-group > 12 means day" heuristic to disambiguate;
// falls back to convention (DMY for dashes, MDY for slashes) otherwise.
function parseDate(v: unknown): string {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = v.getMonth() + 1;
    const d = v.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const y = iso[1];
    let a = parseInt(iso[2], 10);
    let b = parseInt(iso[3], 10);
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return `${y}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }
  const other = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (other) {
    const y4 = other[3].length === 2 ? '20' + other[3] : other[3];
    const a = parseInt(other[1], 10);
    const b = parseInt(other[2], 10);
    if (a > 12 && b <= 12) return `${y4}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    if (b > 12 && a <= 12) return `${y4}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
    const dmy = s.includes('-');
    if (dmy) return `${y4}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    return `${y4}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }
  return s;
}

// --- Line-level extraction -------------------------------------------------

// Strip leading project/sheet/building codes ("VSL; 010;", "030;", "1310VSL;",
// "010 / VSL;") that prefix the real vendor text. Returns the cleaned line.
function stripPrefixCodes(s: string): string {
  let t = s.trim();
  while (true) {
    const m = t.match(/^([A-Za-z0-9]{2,7}(?:\s*\/\s*[A-Za-z0-9]{2,7})?)\s*[;,:]\s*(.+)$/);
    if (!m) break;
    const parts = m[1].split(/\s*\/\s*/);
    if (!parts.every(isPrefixCode)) break;
    t = m[2];
  }
  return t;
}

function isPrefixCode(t: string): boolean {
  if (/^\d{3}$/.test(t)) return true;
  if (/^(VSL|TDL)$/i.test(t)) return true;
  if (/^13\d{2}(VSL|TDL)?$/i.test(t)) return true;
  if (/^1\d{3}$/.test(t)) return true;
  return false;
}

function isInvoiceIdLike(t: string): boolean {
  if (t.length < 3) return false;
  if (!/\d/.test(t)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9\-._/]*$/.test(t)) return false;
  return true;
}

// Detect payroll-period descriptions like "Salaire du 01 fév. au 14 fév.",
// "Sal. du 22 juin au 28 juin", "10 juillet - 20 aout", "du 04 Octobre au 17",
// "1 juillet 2025 - 20 aout". The labour-management sheets (200/230) put these
// in the N° column, so without this guard the parser treats them as vendor
// names and the clusterer surfaces dozens of bogus "groupes". Returns true
// when the cell is essentially nothing but a date range (period only).
const MONTH_RE = /\b(janvier|janv\.?|f[ée]vrier|f[ée]v\.?|mars|avril|avr\.?|mai|juin|juillet|juil\.?|ao[uû]t|septembre|sept?\.?|octobre|oct\.?|novembre|nov\.?|d[ée]cembre|d[ée]c\.?)\b/i;
const MONTH_RE_G = /\b(janvier|janv\.?|f[ée]vrier|f[ée]v\.?|mars|avril|avr\.?|mai|juin|juillet|juil\.?|ao[uû]t|septembre|sept?\.?|octobre|oct\.?|novembre|nov\.?|d[ée]cembre|d[ée]c\.?)\b/gi;
export function looksLikePayrollPeriod(s: string): boolean {
  const raw = s.trim();
  if (!raw) return false;
  if (raw.length > 80) return false; // a real comment is usually longer
  if (/\bsal(aire)?\.?\s+du\b/i.test(raw)) return true;
  // Insert spaces between digits and letters so "20aout" / "2 mai2025" still
  // get caught by the word-boundary month regex.
  const t = raw.replace(/(\d)([A-Za-zÀ-ÿ])/g, '$1 $2').replace(/([A-Za-zÀ-ÿ])(\d)/g, '$1 $2');
  // Pure date range with month words: "X juin au Y juin", "10 juillet - 20 aout",
  // "du 04 Octobre au 17", "1 juillet 2025 - 20 aout", "19 juin au 20aout".
  if (MONTH_RE.test(t)) {
    const stripped = t
      .replace(MONTH_RE_G, '')
      .replace(/\b(du|au|le|de)\b/gi, '')
      .replace(/[\d\s\-–—.,/]+/g, '')
      .trim();
    // After removing months, connectors, and digits/punct, almost nothing left.
    if (stripped.length <= 3) return true;
  }
  return false;
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type LineExtraction = {
  vendor?: string;
  invoices: string[];
};

// Extract (vendor, invoices[]) from a single line. Patterns, in order:
//   E) "<vendor> F- 7146 00061 85508"     — Home Depot spaced receipt
//   B) "<vendor> F-XXX, F-YYY, F-ZZZ"     — comma/semicolon list
//   A) "<vendor> F-XXX"                    — single F-token
//   D) "<vendor> facture X facture Y"     — multiple "facture N" triggers
//   C) "<vendor> facture XXX"              — single trigger
// Falls back to last-token-looks-like-invoice, else returns vendor-only.
export function extractFromLine(line: string): LineExtraction {
  // Collapse standalone hyphens between words (e.g. "facture - 440") so the
  // trigger-based regex below sees "facture 440" and lands on the ID. Hyphens
  // inside tokens (F-486, CA6V-FNK) are not affected because they have no
  // surrounding spaces.
  const cleaned = stripPrefixCodes(line).replace(/\s-\s/g, ' ');
  if (!cleaned) return { invoices: [] };
  if (looksLikePayrollPeriod(cleaned)) return { invoices: [] };

  const hdSpaced = cleaned.match(/^(.+?)\s+F-\s*(\d{3,}(?:\s+\d{2,}){1,5})\b/i);
  if (hdSpaced) {
    const v = cleanVendor(hdSpaced[1]);
    return { vendor: v || undefined, invoices: [`F-${normalizeSpacedReceipt(hdSpaced[2])}`] };
  }

  // F-id list with `,`, `;`, or `/` separators. The `F-` prefix is mandatory
  // on the FIRST id but optional on subsequent ones (Amazon-style cells:
  // "Amazon F- CA6VFNKNNII / CA6U6NKNNII / CA6U8NKNNII / ..."). Tolerates
  // a space between `F-` and the id.
  const fListRe = /^(.+?)\s+F-\s*([A-Za-z0-9][A-Za-z0-9\-._]*(?:\s*[,;/]\s*(?:F-\s*)?[A-Za-z0-9][A-Za-z0-9\-._]*)+)\s*[,;/]?\s*$/i;
  const fListMatch = cleaned.match(fListRe);
  if (fListMatch) {
    const v = cleanVendor(fListMatch[1]);
    const invoices = fListMatch[2]
      .split(/\s*[,;/]\s*/)
      .map((t) => t.trim().replace(/^F-\s*/i, ''))
      .filter(Boolean)
      .map((id) => `F-${id}`);
    return { vendor: v || undefined, invoices };
  }

  const fSingle = cleaned.match(/^(.+?)\s+F-\s*([A-Za-z0-9][A-Za-z0-9\-._]*)\b/i);
  if (fSingle) {
    return { vendor: cleanVendor(fSingle[1]) || undefined, invoices: [`F-${fSingle[2].trim()}`] };
  }

  const factRe = /\b(?:facture|factures|fact\.?|#|no\.?|n[°o]|numéro)\s+([A-Za-z0-9][A-Za-z0-9\-._/]*)/gi;
  const factHits: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = factRe.exec(cleaned)) !== null) {
    if (isInvoiceIdLike(m[1])) factHits.push(m);
  }
  if (factHits.length > 0) {
    const vendor = cleanVendor(cleaned.slice(0, factHits[0].index));
    const invoices = factHits.map((h) => h[1].trim());
    return { vendor: vendor || undefined, invoices };
  }

  const tail = cleaned.match(/^(.+?)\s+([A-Za-z0-9][A-Za-z0-9\-._/]*)\s*$/);
  if (tail && isInvoiceIdLike(tail[2]) && !isPrefixCode(tail[2])) {
    return { vendor: cleanVendor(tail[1]) || undefined, invoices: [tail[2].trim()] };
  }

  return { vendor: cleanVendor(cleaned) || undefined, invoices: [] };
}

function normalizeSpacedReceipt(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cleanVendor(s: string): string {
  let t = s
    .replace(/\s+/g, ' ')
    .replace(/^[;,:\s]+|[;,:\s]+$/g, '')
    .trim();
  // Strip trailing dangling invoice-trigger tokens: "Plomberie Phénix F-",
  // "Construction Soleil CF-", "Intermat facture". These leak when a multi-line
  // cell shoves the ID onto the next line.
  t = t.replace(/\s+(F-|CF-|C?F\.?|facture|factures|fact\.?|no\.?|n[°o]|numéro|#)\s*$/i, '').trim();
  return t;
}

// Extract all invoice tokens from free text. Kept for the extraction engine
// so its buildSearchCandidates fallback still works on the whole comment.
export function extractInvoiceTokens(raw: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const fSpaced = /\bF-\s*(\d{3,}(?:\s+\d{2,}){1,5})/gi;
  let m: RegExpExecArray | null;
  while ((m = fSpaced.exec(raw)) !== null) push(`F-${normalizeSpacedReceipt(m[1])}`);
  const fRe = /\bF-\s*([A-Za-z0-9][A-Za-z0-9\-._]*)/gi;
  while ((m = fRe.exec(raw)) !== null) {
    const num = m[1].trim();
    if (num) push(`F-${num}`);
  }
  const trigRe = /(?:facture|factures|fact\.?|#|no\.?|n[°o]|numéro)\s+([A-Za-z0-9][A-Za-z0-9\-._/]*)/gi;
  while ((m = trigRe.exec(raw)) !== null) {
    const num = m[1].trim();
    if (!num) continue;
    if (/^f-/i.test(num)) continue;
    if (isInvoiceIdLike(num) && !isPrefixCode(num)) push(num);
  }
  return out;
}

export function extractFromComment(raw: string): { vendor?: string; num?: string } {
  for (const line of splitLines(raw)) {
    const ex = extractFromLine(line);
    if (ex.vendor && ex.invoices.length > 0) return { vendor: ex.vendor, num: ex.invoices[0] };
  }
  return {};
}

export function extractVendorFromDocCell(raw: string): string | undefined {
  if (!raw) return undefined;
  const ex = extractFromLine(stripPrefixCodes(raw));
  return ex.vendor;
}

// --- Header detection ------------------------------------------------------

type InputSheet = { name: string; rows: Record<string, unknown>[] };

function detectHeaderRow(rows: Record<string, unknown>[]): {
  headerIndex: number;
  col: {
    date?: string;
    num?: string;
    vendor?: string;
    amount?: string;
    building?: string;
    pj?: string;
    comment?: string;
  };
} | null {
  const MAX_SCAN = Math.min(15, rows.length);
  for (let i = 0; i < MAX_SCAN; i++) {
    const rowAsHeaders: Record<string, unknown> = {};
    for (const v of Object.values(rows[i])) {
      if (v == null || v === '') continue;
      rowAsHeaders[String(v)] = v;
    }
    const col = {
      date: findColumn(rowAsHeaders, COLS.date),
      num: findColumn(rowAsHeaders, COLS.num),
      vendor: findColumn(rowAsHeaders, COLS.vendor),
      amount: findColumn(rowAsHeaders, COLS.amount),
      building: findColumn(rowAsHeaders, COLS.building),
      pj: findColumn(rowAsHeaders, COLS.pj),
      comment: findColumn(rowAsHeaders, COLS.comment),
    };
    if (col.num && col.vendor && col.amount) return { headerIndex: i, col };
  }
  if (rows.length > 0) {
    const col = {
      date: findColumn(rows[0], COLS.date),
      num: findColumn(rows[0], COLS.num),
      vendor: findColumn(rows[0], COLS.vendor),
      amount: findColumn(rows[0], COLS.amount),
      building: findColumn(rows[0], COLS.building),
      pj: findColumn(rows[0], COLS.pj),
      comment: findColumn(rows[0], COLS.comment),
    };
    if (col.num && col.vendor && col.amount) return { headerIndex: -1, col };
  }
  return null;
}

// When the date column wasn't detected by header name (e.g. a sheet uses a
// generic "Colonne 1" header instead of "Date"), scan the first ~12 data
// rows looking for any unbound column whose values are predominantly date-
// shaped. Returns the column key, or undefined.
function detectDateColumnByContent(
  dataRows: Record<string, unknown>[],
  alreadyBound: Set<string>,
): string | undefined {
  if (dataRows.length === 0) return undefined;
  const SAMPLE = Math.min(12, dataRows.length);
  const candidates = Object.keys(dataRows[0] ?? {}).filter((k) => !alreadyBound.has(k));
  let best: { key: string; score: number } | null = null;
  for (const k of candidates) {
    let hits = 0;
    let nonEmpty = 0;
    for (let i = 0; i < SAMPLE; i++) {
      const v = dataRows[i]?.[k];
      if (v == null || v === '') continue;
      nonEmpty++;
      if (looksLikeDate(v)) hits++;
    }
    if (nonEmpty < 3) continue;
    if (hits / nonEmpty < 0.6) continue;
    if (!best || hits > best.score) best = { key: k, score: hits };
  }
  return best?.key;
}

function looksLikeDate(v: unknown): boolean {
  if (v instanceof Date) return true;
  if (typeof v === 'number') return false;
  const s = String(v).trim();
  if (!s) return false;
  // YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY, M/D/YY, etc.
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(s);
}

// --- Main pipeline ---------------------------------------------------------

type ParsedInvoice = {
  docNumber: string;
  vendor?: string;
  source: 'num' | 'comment';
};

function extractFromCell(rawCell: string, source: 'num' | 'comment'): ParsedInvoice[] {
  const out: ParsedInvoice[] = [];
  for (const line of splitLines(rawCell)) {
    const ex = extractFromLine(line);
    for (const inv of ex.invoices) out.push({ docNumber: inv, vendor: ex.vendor, source });
  }
  return out;
}

// Merge two invoice lists, dedupe by docNumber (case-insensitive). Prefers
// the first occurrence's vendor, but upgrades to a better one if we find a
// non-empty vendor for an entry that had none.
function mergeInvoices(primary: ParsedInvoice[], secondary: ParsedInvoice[]): ParsedInvoice[] {
  const byNum = new Map<string, ParsedInvoice>();
  const pushAll = (arr: ParsedInvoice[]) => {
    for (const inv of arr) {
      const k = inv.docNumber.toLowerCase();
      const existing = byNum.get(k);
      if (!existing) byNum.set(k, inv);
      else if (!existing.vendor && inv.vendor) byNum.set(k, inv);
    }
  };
  pushAll(primary);
  pushAll(secondary);
  return Array.from(byNum.values());
}

export function parseBudgetSheets(sheets: InputSheet[]): BudgetRow[] {
  const out: BudgetRow[] = [];
  const diag: string[] = [];
  for (const { name: sheetName, rows } of sheets) {
    if (rows.length === 0) {
      diag.push(`[${sheetName}] empty`);
      continue;
    }
    const det = detectHeaderRow(rows);
    if (!det) {
      diag.push(`[${sheetName}] no header row — first-row keys: ${JSON.stringify(Object.keys(rows[0]).slice(0, 8))}`);
      continue;
    }
    const { headerIndex, col } = det;

    let dataRows: Record<string, unknown>[];
    if (headerIndex === -1) {
      dataRows = rows;
    } else {
      const headerRow = rows[headerIndex];
      const keyByHeader: Record<string, string> = {};
      for (const [k, v] of Object.entries(headerRow)) {
        if (v != null && v !== '') keyByHeader[String(v)] = k;
      }
      dataRows = rows.slice(headerIndex + 1).map((r) => {
        const remapped: Record<string, unknown> = {};
        for (const [headerLabel, originalKey] of Object.entries(keyByHeader)) {
          remapped[headerLabel] = r[originalKey];
        }
        return remapped;
      });
    }

    // Fallback: if the date column wasn't named "Date" / "DATE" / etc., look
    // for an unbound column whose values are predominantly date-shaped.
    // Handles sheets where the user renamed the date header to something
    // generic like "Colonne 1".
    if (!col.date) {
      const bound = new Set(
        [col.num, col.vendor, col.amount, col.building, col.pj, col.comment].filter(
          (x): x is string => !!x,
        ),
      );
      const inferredDate = detectDateColumnByContent(dataRows, bound);
      if (inferredDate) col.date = inferredDate;
    }

    let kept = 0;
    let splits = 0;
    for (const r of dataRows) {
      const rawNum = r[col.num!]?.toString().trim() ?? '';
      const bookingEntity = r[col.vendor!]?.toString().trim() ?? '';
      const amount = parseAmount(r[col.amount!]);
      if (!rawNum || !bookingEntity || amount == null) continue;

      const commentRaw = col.comment ? r[col.comment]?.toString().trim() || undefined : undefined;
      const date = col.date ? parseDate(r[col.date]) : '';
      const building = col.building ? r[col.building]?.toString().trim() || undefined : undefined;
      const pjFromCol = col.pj ? parsePj(r[col.pj]) : false;
      const pjFromFile = rowHasAttachmentFile(r);
      const hasAttachment = pjFromCol || pjFromFile;

      // Prefer comment extraction (richer vendor info) over N° cell extraction.
      const commentExtracts = commentRaw ? extractFromCell(commentRaw, 'comment') : [];
      const numExtracts = extractFromCell(rawNum, 'num');
      const merged = mergeInvoices(commentExtracts, numExtracts);

      if (merged.length === 0) {
        out.push({
          id: randomUUID(),
          sheet: sheetName,
          date,
          docNumber: rawNum,
          vendor: bookingEntity,
          bookingEntity,
          amount,
          building,
          comment: commentRaw,
          hasAttachment,
        });
        kept++;
        continue;
      }

      if (merged.length === 1) {
        const inv = merged[0];
        const rawExtractedVendor = inv.vendor?.trim();
        const vendor = rawExtractedVendor || bookingEntity;
        out.push({
          id: randomUUID(),
          sheet: sheetName,
          date,
          docNumber: inv.docNumber,
          vendor,
          bookingEntity,
          amount,
          building,
          comment: commentRaw,
          rawDocNumber: inv.docNumber !== rawNum ? rawNum : undefined,
          hasAttachment,
        });
        kept++;
        continue;
      }

      // Multiple invoices — split siblings. First keeps the amount, others 0.
      const splitGroupId = randomUUID();
      for (let i = 0; i < merged.length; i++) {
        const inv = merged[i];
        const rawExtractedVendor = inv.vendor?.trim();
        const vendor = rawExtractedVendor || bookingEntity;
        out.push({
          id: randomUUID(),
          sheet: sheetName,
          date,
          docNumber: inv.docNumber,
          vendor,
          bookingEntity,
          amount: i === 0 ? amount : 0,
          building,
          comment: commentRaw,
          rawDocNumber: rawNum,
          splitGroupId,
          splitGroupSize: merged.length,
          splitIndex: i,
          hasAttachment,
        });
      }
      kept += merged.length;
      splits++;
    }
    diag.push(`[${sheetName}] headerRow=${headerIndex} cols=${JSON.stringify(col)} kept=${kept}/${dataRows.length} splits=${splits}`);
  }

  try {
    const dbgPath = path.join(app.getPath('userData'), 'budget-parser.log');
    const firstSheet = sheets[0];
    const firstRowsDump = firstSheet
      ? JSON.stringify(firstSheet.rows.slice(0, 8), null, 2)
      : '(no sheets)';
    fs.writeFileSync(
      dbgPath,
      `parseBudgetSheets @ ${new Date().toISOString()}\n` +
        `sheets: ${sheets.map((s) => `${s.name}(${s.rows.length})`).join(', ')}\n\n` +
        diag.join('\n') +
        `\n\n--- first sheet "${firstSheet?.name}" first 8 rows ---\n` +
        firstRowsDump,
    );
  } catch {
    // Ignore logging failures.
  }
  console.log('[parseBudgetSheets]\n  ' + diag.join('\n  '));
  return out;
}
