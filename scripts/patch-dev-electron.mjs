#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Patches the dev Electron's Info.plist so `npm start` runs with a
// project-specific bundle ID. macOS Launch Services binds custom URL
// schemes (qboextractor://) to bundle IDs — without this patch, dev runs
// register as the generic `com.github.electron`, which conflicts with
// the packaged app and any other Electron-based dev tool on the system.
//
// Idempotent: rewrites the same value every run. Re-applied via the
// `postinstall` script so a fresh `npm install` doesn't undo it.

const INFO_PLIST = path.resolve(
  'node_modules/electron/dist/Electron.app/Contents/Info.plist',
);
const TARGET_BUNDLE_ID = 'com.altitude233.qboextractor.dev';
const TARGET_BUNDLE_NAME = 'QBO Extractor (dev)';

if (!existsSync(INFO_PLIST)) {
  // No-op — likely a CI machine without Electron downloaded yet, or a
  // non-macOS host. The packaged build path is unaffected.
  process.exit(0);
}

function plistGet(key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, INFO_PLIST], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function plistSet(key, value) {
  // Try Set first; fall back to Add if the key doesn't exist.
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, INFO_PLIST]);
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', [
      '-c',
      `Add :${key} string ${value}`,
      INFO_PLIST,
    ]);
  }
}

const currentId = plistGet('CFBundleIdentifier');
if (currentId === TARGET_BUNDLE_ID) {
  console.log(`[patch-dev-electron] already ${TARGET_BUNDLE_ID} — no-op`);
  process.exit(0);
}

plistSet('CFBundleIdentifier', TARGET_BUNDLE_ID);
plistSet('CFBundleName', TARGET_BUNDLE_NAME);
plistSet('CFBundleDisplayName', TARGET_BUNDLE_NAME);

// Force Launch Services to re-read the bundle so the dev binary becomes
// a routable target for qboextractor:// deep links.
try {
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister',
    ['-f', path.resolve('node_modules/electron/dist/Electron.app')],
  );
} catch {
  /* lsregister failures are non-fatal — `npm start` still works, deep
     links may need a manual Launch Services kick. */
}

console.log(`[patch-dev-electron] CFBundleIdentifier → ${TARGET_BUNDLE_ID}`);
