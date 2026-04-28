import { Searcher } from 'fast-fuzzy';
import type { BudgetRow, VendorCluster } from '../../types/domain';
import { looksLikePayrollPeriod } from './parser';

// Second pass after parser.ts produces BudgetRow[]: collapse vendor spelling
// variants to a single canonical name.
//
// Step 1 — apply known aliases (raw_name -> canonical_name) from the
//   vendor_aliases table. Sets row.rawVendor to the pre-normalization value
//   when it differs from the canonical.
// Step 2 — for rows whose raw vendor has no alias, cluster near-duplicates via
//   fast-fuzzy (Damerau-Levenshtein similarity). Clusters surface to the UI
//   where the user confirms which canonical name to keep; confirmations then
//   go back into vendor_aliases.
//
// We do NOT auto-write aliases here — clustering is advisory only. The user
// decides the canonical; this module just hands them candidate groups.

const CLUSTER_THRESHOLD = 0.85;

export type NormalizeResult = {
  rows: BudgetRow[];
  clusters: VendorCluster[];
  unknownVendors: string[];
};

export function normalizeVendors(
  rows: BudgetRow[],
  aliasMap: Map<string, string>,
): NormalizeResult {
  const appliedRows = rows.map((r) => applyAliasAndUtilities(r, aliasMap));

  const unknownRawNames = new Set<string>();
  for (const row of appliedRows) {
    const key = keyOf(row.vendor);
    if (!key) continue;
    if (aliasMap.has(row.vendor)) continue;
    // Date-range / payroll-period strings are not real merchants — never
    // surface them in the cluster modal.
    if (looksLikePayrollPeriod(row.vendor)) continue;
    unknownRawNames.add(row.vendor);
  }

  const clusters = clusterNames(Array.from(unknownRawNames));
  return {
    rows: appliedRows,
    clusters,
    unknownVendors: Array.from(unknownRawNames).sort((a, b) => a.localeCompare(b)),
  };
}

// Built-in canonicals for Quebec utility/telco providers. The Fournisseur
// column for utility bills routinely puts a meter / account ID in parens —
// "Hydro(708)", "Energir (906)", "Bell(123)" — which makes each meter look
// like a distinct supplier. They're ALL the same legal entity, so we collapse
// them to a single canonical name. Applied to BOTH `vendor` and
// `bookingEntity` (utility bills tend to put the provider in Fournisseur
// rather than the booking-entity company).
const UTILITY_CANONICALS: { test: RegExp; canonical: string }[] = [
  { test: /^\s*hydro[\s-]?qu[ée]bec\b/i, canonical: 'Hydro-Québec' },
  { test: /^\s*hydro\b/i, canonical: 'Hydro-Québec' },
  { test: /^\s*[ée]nergir\b/i, canonical: 'Énergir' },
  { test: /^\s*bell\b/i, canonical: 'Bell' },
  { test: /^\s*vid[ée]otron\b/i, canonical: 'Vidéotron' },
  { test: /^\s*telus\b/i, canonical: 'Telus' },
  { test: /^\s*rogers\b/i, canonical: 'Rogers' },
];

function applyUtilityCanonical(name: string): string {
  if (!name) return name;
  for (const { test, canonical } of UTILITY_CANONICALS) {
    if (test.test(name)) return canonical;
  }
  return name;
}

function applyAliasAndUtilities(row: BudgetRow, aliasMap: Map<string, string>): BudgetRow {
  const raw = row.vendor;
  // 1) User-defined alias takes priority (the Vendors screen).
  const userCanonical = aliasMap.get(raw);
  if (userCanonical && userCanonical !== raw) {
    return {
      ...row,
      vendor: userCanonical,
      rawVendor: row.rawVendor ?? raw,
      bookingEntity: applyUtilityCanonical(row.bookingEntity),
    };
  }
  // 2) Built-in utility canonicalization (Hydro/Énergir/Bell/...).
  const utilityVendor = applyUtilityCanonical(raw);
  const utilityEntity = applyUtilityCanonical(row.bookingEntity);
  if (utilityVendor !== raw || utilityEntity !== row.bookingEntity) {
    return {
      ...row,
      vendor: utilityVendor,
      rawVendor: utilityVendor !== raw ? row.rawVendor ?? raw : row.rawVendor,
      bookingEntity: utilityEntity,
    };
  }
  return row;
}

// Quebec numbered companies — the digits ARE the legal identifier (NEQ-style:
// "9405-8773 Qc inc.", "9486 6647 Quebec Inc"). Two such names whose digit
// sequences differ by even ONE digit are completely different legal entities;
// fuzzy similarity will (incorrectly) score them ≥ 0.9. We extract the 8-digit
// signature and use it as a hard "do not merge" key during clustering.
const NUMBERED_CO_RE = /\b(\d{4})[\s-]?(\d{4})\b[\s\S]{0,30}?\b(qc|qu[ée]bec|quebec)\b/i;
function numberedCoKey(name: string): string | null {
  const m = name.match(NUMBERED_CO_RE);
  if (!m) return null;
  return `${m[1]}${m[2]}`;
}

// Are these two names allowed to live in the same cluster?
function compatibleForClustering(a: string, b: string): boolean {
  const ka = numberedCoKey(a);
  const kb = numberedCoKey(b);
  if (ka && kb && ka !== kb) return false;
  // One side numbered, other not — also reject (e.g. "9405-8773 Qc inc" vs
  // "Altitude 233 Inc" only "match" because both end in "Inc"; we want them
  // treated as distinct entities).
  if ((ka && !kb) || (!ka && kb)) return false;
  return true;
}

// Cluster raw vendor names by fuzzy similarity. Uses a single-pass greedy
// approach: for each name, search against names already placed in clusters;
// if match ≥ threshold AND passes the compatibility check, join that cluster,
// else start a new one. Canonical = longest member (most likely fully spelled),
// alphabetical tie-break for determinism.
function clusterNames(names: string[]): VendorCluster[] {
  if (names.length === 0) return [];

  const buckets: string[][] = [];
  const scores: number[][] = [];
  const searcher = new Searcher<string, { threshold: number; returnMatchData: true }>([], {
    threshold: CLUSTER_THRESHOLD,
    returnMatchData: true,
  });

  const indexOfName = new Map<string, number>();

  for (const name of names) {
    const matches = searcher.search(name, { returnMatchData: true, threshold: CLUSTER_THRESHOLD });
    let placed = false;
    for (const match of matches) {
      const bucketIdx = indexOfName.get(match.item);
      if (bucketIdx == null) continue;
      // Reject if any existing bucket member fails the compatibility check
      // (NEQ digits, in particular). We check ALL members, not just the best
      // match, so a candidate can't sneak in via one fuzzy-close neighbor.
      const compatible = buckets[bucketIdx].every((m) => compatibleForClustering(m, name));
      if (!compatible) continue;
      buckets[bucketIdx].push(name);
      scores[bucketIdx].push(match.score);
      indexOfName.set(name, bucketIdx);
      searcher.add(name);
      placed = true;
      break;
    }
    if (!placed) {
      buckets.push([name]);
      scores.push([1]);
      indexOfName.set(name, buckets.length - 1);
      searcher.add(name);
    }
  }

  const clusters: VendorCluster[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const members = buckets[i];
    if (members.length < 2) continue;
    const canonical = pickCanonical(members);
    const aliases = members.filter((m) => m !== canonical);
    const avgScore = scores[i].reduce((a, b) => a + b, 0) / scores[i].length;
    clusters.push({ canonical, aliases, score: avgScore });
  }
  clusters.sort((a, b) => b.aliases.length - a.aliases.length || b.score - a.score);
  return clusters;
}

// Canonical pick heuristic: prefer the longest name (most likely the fully
// spelled-out form: "The Home Depot" over "Home Depot"), tie-break by
// alphabetical order so the result is deterministic.
function pickCanonical(members: string[]): string {
  return [...members].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

function keyOf(s: string): string {
  return s.trim().toLowerCase();
}
