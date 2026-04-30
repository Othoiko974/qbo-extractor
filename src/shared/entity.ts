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
// "mes entreprises" filter. Two cases:
//   - active is a regular sister → direct alias match only. Rows
//     whose entity doesn't match are someone else's (sister or
//     project owner), excluded here. The launch flow also relies on
//     this: refusing to query a fallback row against a specific
//     sister's QBO realm avoids guaranteed "not found" hits.
//   - active is the project owner (auto-created "Compte [name]") →
//     inverted: claim every row that no real sister in the project
//     claims. Empty / unknown booking entities also land here.
export function rowBelongsToActiveCompany(
  bookingEntity: string | null | undefined,
  activeCompany: { label: string; isProjectOwner?: boolean; entityAliases?: string[] },
  projectCompanies: Array<{ label: string; isProjectOwner?: boolean; entityAliases?: string[] }>,
): boolean {
  if (activeCompany.isProjectOwner) {
    if (!bookingEntity) return true;
    for (const c of projectCompanies) {
      if (c.isProjectOwner) continue;
      if (bookingEntityMatchesCompany(bookingEntity, c)) return false;
    }
    return true;
  }
  if (!bookingEntity) return true;
  return bookingEntityMatchesCompany(bookingEntity, activeCompany);
}

// Returns the label shown on the Dashboard's entity chip — i.e. which
// entity *logically owns* this row. Direct match on any company wins
// (Altitude / TDL keep their own labels; a row literally tagged "VSL"
// shows "VSL"). Everything else (external suppliers like Hydro-Québec
// / SATCOM that no company has aliased) falls back to the project's
// owner company — the auto-created "Compte [name]" entity. Reading
// the label from a real DB row (rather than computing it on the fly)
// means the user can rename the Compte and the chip follows.
//
// Note: this is purely a *display* rule. The actual QBO query for
// extraction still runs against the active company's realm — see the
// engine's refacturation routing for that side.
export function rowDestinationLabel(
  bookingEntity: string | null | undefined,
  activeCompany: { label: string; projectId?: string | null; entityAliases?: string[] },
  allCompanies: Array<{
    label: string;
    projectId?: string | null;
    isProjectOwner?: boolean;
    entityAliases?: string[];
  }>,
): string {
  // Direct match on any non-owner company wins. We skip owners here
  // because their entityAliases are intentionally empty (they're the
  // catch-all) — including them would make a row tagged literally
  // "Compte XYZ" match before the fallback path runs, which is fine,
  // but we want the explicit fallback rule to be the only way owners
  // win so renames don't change which rows match.
  if (bookingEntity) {
    for (const c of allCompanies) {
      if (c.isProjectOwner) continue;
      if (bookingEntityMatchesCompany(bookingEntity, c)) return c.label;
    }
  }
  // Fallback: the project's owner company. Look up by flag so the
  // chip text follows the user's rename of "Compte VSL" → "Externes".
  if (activeCompany.projectId) {
    const owner = allCompanies.find(
      (c) => c.projectId === activeCompany.projectId && c.isProjectOwner,
    );
    if (owner) return owner.label;
  }
  // Degenerate: company without project / project missing its owner.
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
