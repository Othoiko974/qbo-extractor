import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// Keep Vite output + native modules (and their runtime deps) in the packaged app.
// Everything else is stripped to keep the bundle small.
// Packages to preserve in the packaged app's node_modules (everything else is
// stripped by the custom `ignore` below). Includes native modules + their
// runtime deps, and pure-JS modules that rely on dynamic `require()` (xlsx).
const NATIVE_KEEP = [
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
  'xlsx',
];

const config: ForgeConfig = {
  packagerConfig: {
    name: 'QBO Extractor',
    executableName: 'qbo-extractor',
    asar: true,
    appBundleId: 'com.altitude233.qboextractor',
    protocols: [
      {
        name: 'QBO Extractor OAuth',
        schemes: ['qboextractor'],
      },
    ],
    // Ad-hoc signing (identity '-') — gives the .app a self-signed
    // signature without needing a paid Apple Developer ID. Without this
    // Gatekeeper labels every download as "endommagé / damaged" and
    // refuses to launch even with right-click → Open. With ad-hoc the
    // worst the user sees is the "Unidentified Developer" prompt that
    // bypasses on the first right-click → Open. Skipped entirely on
    // non-darwin runners (linux/windows) where osxSign is a no-op.
    osxSign: {
      identity: '-',
      optionsForFile: () => ({
        // Hardened runtime + entitlements would require a real cert; skip
        // them so the ad-hoc signature still validates against Gatekeeper
        // at the basic level.
        hardenedRuntime: false,
      }),
    },
    ignore: (file) => {
      if (!file) return false;
      if (file.startsWith('/.vite')) return false;
      if (file === '/package.json') return false;
      if (file === '/node_modules') return false;
      if (file.startsWith('/node_modules/')) {
        const parts = file.split('/');
        const pkg = parts[2];
        if (!pkg) return false;
        return !NATIVE_KEEP.includes(pkg);
      }
      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'qbo-extractor', setupExe: 'QBO-Extractor-Setup.exe' }),
    new MakerDMG({ name: 'QBO Extractor' }, ['darwin']),
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      // FusesPlugin runs AFTER osxSign and rewrites bytes in the Electron
      // binary; without re-applying the signature the bundle launches
      // straight into "Code Signature Invalid" SIGKILL on macOS. This
      // flag tells @electron/fuses to re-do the ad-hoc codesign on
      // darwin runners after the fuse flip.
      resetAdHocDarwinSignature: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
