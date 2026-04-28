# QBO Extractor

Logiciel desktop (Electron) pour Altitude 233 Inc. Automatise l'extraction des
pièces jointes QuickBooks Online manquantes en comparant un budget
Google Sheets / Excel au contenu de QBO.

Design et spec complète : voir `../Claude Design/design_handoff_qbo_extractor/README.md`.

## Stack

- Electron Forge 7 + Vite + React 18 + TypeScript
- Zustand (state), Inter Tight + IBM Plex Mono (polices)
- Makers : DMG (macOS), Squirrel (Windows .exe), ZIP (fallback)

## Développement

```bash
npm install
npm start                 # lance l'app en mode dev (hot reload renderer)
npx tsc --noEmit          # type-check
npm run package           # produit le bundle .app / .exe dans out/
npm run make              # produit les installeurs finaux (DMG, Setup.exe)
```

Les artéfacts sortent dans `out/make/` :
- macOS : `QBO Extractor.dmg` + zip `QBO Extractor-darwin-*-*.zip`
- Windows : `make/squirrel.windows/**/QBO-Extractor-Setup.exe`

## Variables d'environnement (OAuth — à remplir avant prod)

```
QBO_CLIENT_ID=          # Intuit developer console, app prod
QBO_CLIENT_SECRET=
QBO_REDIRECT_URI=       # ex: https://auth.altitude233.com/qbo/callback
GOOGLE_CLIENT_ID=       # Google Cloud OAuth Desktop client
GOOGLE_CLIENT_SECRET=
```

Stocker en local dans `.env` (ignoré par git). En CI/prod, via GitHub Actions secrets.

## Déploiement automatique (GitHub Actions)

Workflow dans `.github/workflows/build.yml` :
- Build sur `push main` et `pull_request`
- Build matrix `macos-latest` + `windows-latest` en parallèle
- Upload des artéfacts dans l'onglet Actions
- Sur tag `vX.Y.Z` : création automatique d'une release GitHub avec .dmg + .exe attachés

**Pour publier une release :**
```bash
npm version patch   # ou minor/major
git push origin main --tags
```

## Signature / notarization (v2)

Reportés en v2 pour ship faster :
- macOS : Gatekeeper affichera "app non vérifiée" — les utilisateurs doivent
  faire `clic droit → Ouvrir` la première fois.
- Windows : SmartScreen affichera "Éditeur inconnu" — choisir "Exécuter quand même".

Pour lever ces avertissements :
- macOS : Apple Developer cert (99 $/an) + notarization via `electron-osx-sign`
- Windows : cert Authenticode EV (~300 $/an)

## Architecture

```
src/
├── main.ts              # entrée main process (single-instance, custom scheme)
├── preload.ts           # contextBridge → window.qboApi
├── main/
│   ├── ipc.ts           # ipcMain.handle stubs (OAuth, budget, extraction, fs)
│   └── oauth-qbo.ts     # flow custom scheme + exchange code/token
├── renderer.tsx         # entrée React
├── ui/
│   ├── App.tsx          # shell + router screen
│   ├── Sidebar.tsx      # navigation entreprises + écrans
│   ├── Icon.tsx         # icônes SVG + fmtCurrency
│   └── screens/         # 1 fichier par écran
├── store/
│   ├── store.ts         # zustand store (screen, companies, budget)
│   └── fixtures.ts      # données de démo
├── types/
│   ├── domain.ts        # Company, BudgetRow, ExtractionRow, Screen
│   └── bridge.d.ts      # typage window.qboApi
└── index.css            # design tokens (CSS vars) + classes globales
```

## Prochaines étapes (V2)

Dans l'ordre du handoff (`../Claude Design/.../README.md` §"Ordre d'implémentation") :
1. Écrans restants : Connect, GSheets, Review (ambigu/404/no-pj), History, Preview, Settings
2. `better-sqlite3` + `keytar` en dépendances natives (nécessite electron-rebuild)
3. OAuth QBO : finaliser exchange + stockage keytar + refresh automatique
4. OAuth Google Sheets (plus simple : loopback 127.0.0.1)
5. Moteur d'extraction : recherche QBO (Bill/Purchase/Invoice), téléchargement Attachable, renommage, organisation par mois
6. Tests manuels sur compte QBO sandbox US/CA
7. Signature + notarization
