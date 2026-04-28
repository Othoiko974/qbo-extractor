// Smoke test: run the real parser + normalizer against BUDGET Global VSL.xlsx
// without booting Electron.
//
// We bundle parser.ts + normalize.ts with esbuild (marking `electron` external)
// then run the bundle. A shim for `electron.app` is injected at the top of
// the bundled output so parser.ts's debug-log write does something harmless.
//
// Usage:  node scripts/smoke-parse.mjs "/path/to/BUDGET Global VSL.xlsx"

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const XLSX = require('xlsx');
const esbuild = require('esbuild');

const xlsxPath = process.argv[2] || '/Users/owenmaillot/Downloads/BUDGET Global VSL.xlsx';
if (!fs.existsSync(xlsxPath)) {
  console.error(`File not found: ${xlsxPath}`);
  process.exit(1);
}

// Build an entry file that re-exports both modules.
const entryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
const entry = path.join(entryDir, 'entry.ts');
const parserPath = path.join(__dirname, '..', 'src', 'main', 'budget', 'parser.ts');
const normalizePath = path.join(__dirname, '..', 'src', 'main', 'budget', 'normalize.ts');
fs.writeFileSync(
  entry,
  `export { parseBudgetSheets } from ${JSON.stringify(parserPath)};
   export { normalizeVendors } from ${JSON.stringify(normalizePath)};`,
);

// Shim for 'electron' module — resolves `app.getPath(k)` to tmp/docs.
const shim = path.join(entryDir, 'electron-shim.ts');
fs.writeFileSync(
  shim,
  `import * as os from 'os';
   import * as path from 'path';
   export const app = {
     getPath: (k: string) => {
       if (k === 'userData') return os.tmpdir();
       if (k === 'documents') return path.join(os.homedir(), 'Documents');
       return os.tmpdir();
     },
   };`,
);

const out = path.join(entryDir, 'bundle.cjs');
await esbuild.build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: { electron: shim },
  logLevel: 'error',
});

const { parseBudgetSheets, normalizeVendors } = require(out);

const wb = XLSX.readFile(xlsxPath, { cellDates: true });
const sheets = wb.SheetNames.map((name) => {
  const sheet = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
  return { name, rows };
});

const rows = parseBudgetSheets(sheets);
console.log(`\n=== Parsed ${rows.length} rows across ${sheets.length} sheets ===\n`);

// Normalization
const { rows: normalized, clusters, unknownVendors } = normalizeVendors(rows, new Map());

const bySheet = new Map();
for (const r of normalized) {
  const s = bySheet.get(r.sheet) ?? { count: 0, withVendor: 0, splits: 0, entities: new Set() };
  s.count++;
  if (r.vendor && r.vendor !== r.bookingEntity) s.withVendor++;
  if (r.splitGroupId) s.splits++;
  s.entities.add(r.bookingEntity);
  bySheet.set(r.sheet, s);
}
console.log('Per-sheet summary (POST-normalization):');
for (const [sheet, s] of bySheet) {
  console.log(
    `  ${sheet.padEnd(32).slice(0, 32)} rows=${String(s.count).padStart(4)}  merchantExtracted=${String(s.withVendor).padStart(4)}  splits=${String(s.splits).padStart(3)}  entities=${[...s.entities].join(', ')}`,
  );
}
console.log(`\n=== Normalization ===`);
console.log(`  unknown raw vendor names: ${unknownVendors.length}`);
console.log(`  clusters suggested: ${clusters.length}`);
for (const c of clusters.slice(0, 25)) {
  console.log(
    `    canonical="${c.canonical}"  score=${c.score.toFixed(2)}  aliases=[${c.aliases.join(' | ')}]`,
  );
}

console.log(`\n=== First 20 unknown raw vendors (for eyeballing) ===`);
for (const v of unknownVendors.slice(0, 20)) console.log(`    ${v}`);

console.log(`\n=== Sample rows (first 12) ===`);
for (const r of rows.slice(0, 12)) {
  console.log(
    `  [${r.sheet.slice(0, 14).padEnd(14)}] date=${r.date} N°=${String(r.docNumber).padEnd(18)} vendor="${r.vendor}" entity="${r.bookingEntity}" amount=${r.amount}`,
  );
}

const splitGroups = new Map();
for (const r of rows) {
  if (!r.splitGroupId) continue;
  const g = splitGroups.get(r.splitGroupId) ?? [];
  g.push(r);
  splitGroups.set(r.splitGroupId, g);
}
console.log(`\n=== Split groups: ${splitGroups.size} ===`);
let shown = 0;
for (const [gid, members] of splitGroups) {
  if (shown >= 6) break;
  members.sort((a, b) => (a.splitIndex ?? 0) - (b.splitIndex ?? 0));
  console.log(`  group ${gid.slice(0, 8)} (${members.length} invoices, sheet=${members[0].sheet}):`);
  for (const m of members) {
    console.log(`    - ${String(m.docNumber).padEnd(22)} vendor="${m.vendor}"  amount=${m.amount}`);
  }
  shown++;
}

console.log(`\nOK  smoke test complete.`);
