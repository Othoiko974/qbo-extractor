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

// True when the row "belongs to" the active company under the
// "mes entreprises" filter — i.e. the booking entity directly matches
// one of active's aliases. Rows whose entity doesn't match any
// company (Hydro-Québec, SATCOM…) belong to the project's virtual
// Compte, not to active, so they're excluded here. The launch flow
// also relies on this: refusing to query a fallback row against a
// specific company's QBO realm avoids guaranteed "not found" hits.
export function rowBelongsToActiveCompany(
  bookingEntity: string | null | undefined,
  activeCompany: { label: string; entityAliases?: string[] },
): boolean {
  if (!bookingEntity) return true; // unknown → don't penalize
  return bookingEntityMatchesCompany(bookingEntity, activeCompany);
}

// True when the row belongs to the active project's virtual Compte —
// i.e. its booking entity doesn't match any real company in the
// project. Used for the Dashboard's "mes entreprises" filter when the
// user has clicked Compte in the sidebar; rows here are exactly the
// ones that show the "Compte [project]" chip.
export function rowBelongsToActiveCompte(
  bookingEntity: string | null | undefined,
  projectCompanies: Array<{ label: string; entityAliases?: string[] }>,
): boolean {
  if (!bookingEntity) return true; // empty also routes to Compte chip
  for (const c of projectCompanies) {
    if (bookingEntityMatchesCompany(bookingEntity, c)) return false;
  }
  return true;
}

// Returns the label shown on the Dashboard's entity chip — i.e. which
// entity *logically owns* this row. Direct match on any company wins
// (Altitude / TDL keep their own labels; a row literally tagged "VSL"
// shows "VSL"). Everything else (external suppliers like Hydro-Québec
// / SATCOM that no company has aliased) falls back to a virtual
// "Compte [project name]" label — the project-owner bucket. That
// matches the user's mental model: external bills are charged to the
// project, not to any specific connected sister.
//
// Note: this is purely a *display* rule. The actual QBO query for
// extraction still runs against the active company's realm — see the
// engine's refacturation routing for that side.
export function rowDestinationLabel(
  bookingEntity: string | null | undefined,
  activeCompany: { label: string; projectId?: string | null; entityAliases?: string[] },
  allCompanies: Array<{
    label: string;
    entityAliases?: string[];
  }>,
  projects: Array<{ id: string; name: string }>,
): string {
  // Direct match on any company (connected or not) wins — so a row
  // tagged "VSL" displays "VSL" without going through the fallback.
  if (bookingEntity) {
    for (const c of allCompanies) {
      if (bookingEntityMatchesCompany(bookingEntity, c)) return c.label;
    }
  }
  // Fallback: virtual "Compte [project name]" — the project-owner
  // bucket for external suppliers and unmatched bookings.
  if (activeCompany.projectId) {
    const project = projects.find((p) => p.id === activeCompany.projectId);
    if (project) return `Compte ${project.name}`;
  }
  // Degenerate: company without project — keep active's label.
  return activeCompany.label;
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
