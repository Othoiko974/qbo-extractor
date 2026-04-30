// Booking-entity matching shared by renderer (Dashboard filter) and main
// (engine pre-flight). Normalizes the budget's "Fournisseur" cell so
// "Altitude 233 Inc." ≈ "altitude 233" ≈ "Altitude233 INC" all match.

const LEGAL_SUFFIX_RE =
  /\b(inc|inc\.|incorporated|ltd|ltée|ltee|ltd\.|enr|enr\.|s\.?a\.?|sarl|llc|llp|corp|co|corporation|company)\b/gi;

// Matches the Unicode combining-diacritics block (U+0300 – U+036F) that
// `String.prototype.normalize('NFD')` exposes for accented letters like
// "é" → "e" + COMBINING ACUTE ACCENT. Stripping it leaves bare ASCII.
const DIACRITIC_RE = /[̀-ͯ]/g;

export function normalizeEntity(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITIC_RE, '')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// True when the row's bookingEntity belongs to the given company. If the
// company has no aliases configured (legacy), fall back to a single alias
// = company.label so the migration's backfill is still respected.
export function bookingEntityMatchesCompany(
  bookingEntity: string | null | undefined,
  company: { label: string; entityAliases?: string[] },
): boolean {
  if (!bookingEntity) return true; // unknown → don't penalize
  const norm = normalizeEntity(bookingEntity);
  if (!norm) return true;
  const aliases =
    company.entityAliases && company.entityAliases.length > 0
      ? company.entityAliases
      : [company.label];
  return aliases.some((a) => normalizeEntity(a) === norm);
}

// True when the row "belongs to" the active company's QBO realm under the
// refacturation routing rule: a direct match wins, but rows whose
// bookingEntity doesn't match any *other* connected sister company also
// belong to active by fallback. This catches the case where the
// Fournisseur column says "VSL" or "Hydro-Québec" or any external
// supplier — those bills live in the active project's QBO, not in a
// sister's, so the Dashboard should keep showing them with their real
// bookingEntity (e.g. "VSL") in the Entity column.
export function rowBelongsToActiveCompany(
  bookingEntity: string | null | undefined,
  activeCompany: { label: string; entityAliases?: string[] },
  allCompanies: Array<{
    label: string;
    entityAliases?: string[];
    connected?: boolean;
  }>,
): boolean {
  if (!bookingEntity) return true;
  if (bookingEntityMatchesCompany(bookingEntity, activeCompany)) return true;
  // Belongs elsewhere only if some OTHER connected sister claims it.
  // Unconnected sisters (e.g. VSL with no QBO link yet) don't count —
  // their rows fall back to the active company by definition.
  for (const c of allCompanies) {
    if (normalizeEntity(c.label) === normalizeEntity(activeCompany.label)) continue;
    if (c.connected === false) continue;
    if (bookingEntityMatchesCompany(bookingEntity, c)) return false;
  }
  return true;
}

// Distinct booking entities surfaced from a list of rows, useful for the
// "Hors entreprise" KPI tooltip and the Settings auto-suggest.
export function distinctEntities(
  rows: Array<{ bookingEntity?: string | null }>,
): string[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const v = (r.bookingEntity ?? '').trim();
    if (!v) continue;
    const k = normalizeEntity(v);
    if (k && !seen.has(k)) seen.set(k, v);
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}
