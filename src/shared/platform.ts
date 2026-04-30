// Native-name lookups for platform-conditional UI copy. Replaces the
// hardcoded "Finder" string that was confusing on Windows: instead the
// translation files use {fm} as a placeholder and the call site
// substitutes via fileManagerName().

type Lang = 'fr' | 'en';

// "Finder" / "Explorateur" — the OS's file-browser app. The FR variant
// includes the leading article so it slots into "Afficher dans le {fm}"
// without the renderer needing to inflect.
export function fileManagerName(
  platform: string | undefined,
  lang: Lang = 'fr',
): string {
  if (platform === 'win32') return lang === 'fr' ? "l'Explorateur" : 'Explorer';
  if (platform === 'darwin') return lang === 'fr' ? 'le Finder' : 'Finder';
  return lang === 'fr' ? 'le gestionnaire de fichiers' : 'the file manager';
}

// Bare name (no article) — for places that already supply the article
// in surrounding text or want it as a noun phrase ("ouvrir Explorer").
export function fileManagerShortName(
  platform: string | undefined,
  lang: Lang = 'fr',
): string {
  if (platform === 'win32') return lang === 'fr' ? 'Explorateur' : 'Explorer';
  if (platform === 'darwin') return 'Finder';
  return lang === 'fr' ? 'fichiers' : 'files';
}

// Cmd on darwin, Ctrl elsewhere — drives the keyboard-shortcut overlay.
export function modifierKeyLabel(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl';
}
