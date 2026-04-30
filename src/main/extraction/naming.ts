// Template vars: {num} {fournisseur} {date} {montant} {batiment} {sheet}
// Also supports legacy ${montant} form (dollar-prefixed) used in default settings.

export type NamingVars = {
  num: string;
  fournisseur: string;
  date: string;
  montant: number;
  batiment?: string;
  sheet?: string;
};

const UNSAFE = /[\\/:*?"<>|\n\r\t]/g;
// Win32 silently strips trailing dots / spaces from path components, which
// breaks the rest of the pipeline: mkdir succeeds with "Altitude 233 Inc"
// but path.join("Altitude 233 Inc.", "file.pdf") later targets a folder
// that doesn't exist. Strip them up front so what we ask for == what
// actually lands on disk on every platform.
const TRAILING_DOTS_OR_SPACES = /[. ]+$/;

function sanitize(s: string): string {
  return s
    .replace(UNSAFE, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_DOTS_OR_SPACES, '');
}

function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // US-style formatting: comma thousands separator, period decimal —
  // "$4,507.03" instead of "$4507,03". Round dollars stay terse: $4,507
  // (the .00 is stripped) while non-round preserve the cents.
  const s = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return s.replace(/\.00$/, '');
}

export function applyTemplate(template: string, vars: NamingVars): string {
  const map: Record<string, string> = {
    num: sanitize(vars.num),
    fournisseur: sanitize(vars.fournisseur),
    date: sanitize(vars.date || ''),
    montant: fmtAmount(vars.montant),
    batiment: sanitize(vars.batiment ?? ''),
    sheet: sanitize(vars.sheet ?? ''),
  };
  let out = template;
  for (const [k, v] of Object.entries(map)) {
    // Replace the bare {k} form FIRST so that "${montant}" leaves a literal
    // "$" in place — the user expects the $ to read as a currency sign,
    // matching the live preview shown in Settings. If we matched
    // "${montant}" first the $ would be consumed and "${montant}" would
    // expand to "977,29" instead of "$977,29".
    out = out.replaceAll(`{${k}}`, v);
    out = out.replaceAll(`\${${k}}`, v);
  }
  // collapse any leftover empty segments like "__"
  return out.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
}

export function extensionFromContentType(ct: string): string {
  const lower = ct.toLowerCase();
  if (lower.includes('pdf')) return '.pdf';
  if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg';
  if (lower.includes('png')) return '.png';
  if (lower.includes('heic')) return '.heic';
  if (lower.includes('tiff')) return '.tiff';
  if (lower.includes('gif')) return '.gif';
  return '.bin';
}

export function monthFolder(date: string): string {
  // Expects YYYY-MM-DD; falls back to "sans-date".
  const m = date.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : 'sans-date';
}

// Folder template — produces a relative path under the company folder.
// Supported variables:
//   {year}        2025
//   {month}       12
//   {day}         31
//   {date}        2025-12-31
//   {date-month}  2025-12
//   {sheet}       154-PLOMBERIE
//   {fournisseur} Vendor name
//   {batiment}    Building
// Path separators ('/' or '\\') split the template into nested directories.
export function applyFolderTemplate(
  template: string,
  vars: { date: string; sheet?: string; fournisseur?: string; batiment?: string },
): string {
  const m = vars.date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const year = m?.[1] ?? '';
  const month = m?.[2] ?? '';
  const day = m?.[3] ?? '';
  const dateMonth = year && month ? `${year}-${month}` : '';
  const map: Record<string, string> = {
    year: year || 'sans-date',
    month: month || 'sans-date',
    day: day || 'sans-date',
    date: vars.date || 'sans-date',
    'date-month': dateMonth || 'sans-date',
    sheet: sanitize(vars.sheet ?? ''),
    fournisseur: sanitize(vars.fournisseur ?? ''),
    batiment: sanitize(vars.batiment ?? ''),
  };
  let out = template;
  for (const [k, v] of Object.entries(map)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  // Sanitize each path segment individually so slashes remain as separators.
  return out
    .split(/[\\/]/)
    .map((seg) => seg.replace(UNSAFE, '_').replace(/\s+/g, ' ').trim())
    .filter((seg) => seg.length > 0)
    .join('/');
}
