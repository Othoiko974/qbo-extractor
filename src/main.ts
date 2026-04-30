import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './main/ipc';
import { registerCustomScheme, handleDeepLink } from './main/oauth-qbo';
import { handlePairDeepLink } from './main/qbo/proxy-pair';

// Custom scheme to expose extracted files to the sandboxed renderer for
// inline preview (PDF iframe, <img> for images). file:// URLs are blocked
// by Chromium's sandbox; this protocol streams the local file with the
// right mime type via net.fetch.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'qbo-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

// Single-instance lock so Windows deep-links route back to the running app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function dispatchDeepLink(url: string): void {
  if (url.startsWith('qboextractor://pair')) {
    void handlePairDeepLink(url, mainWindow);
    return;
  }
  // OAuth callback (legacy local-mode flow) and any other qboextractor://*.
  handleDeepLink(url, mainWindow);
}

app.on('second-instance', (_event, argv) => {
  const deepLink = argv.find((a) => a.startsWith('qboextractor://'));
  if (deepLink) dispatchDeepLink(deepLink);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  dispatchDeepLink(url);
});

const createWindow = () => {
  // Cap the initial size to ~92% of the work area so the dashboard table
  // (10 columns) is comfortably visible on any modern Mac without forcing
  // the user to resize, while still leaving the window manageable on
  // smaller displays (older 13" MacBook = 1440×900).
  const display = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const initialWidth = Math.min(1480, Math.max(1200, Math.floor(display.width * 0.92)));
  const initialHeight = Math.min(960, Math.max(800, Math.floor(display.height * 0.92)));

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 1100,
    minHeight: 700,
    center: true,
    backgroundColor: '#faf8f3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.on('ready', () => {
  registerCustomScheme();
  // Map qbo-file://local/<absolute-path> to the local file. We read the
  // bytes directly and set an explicit Content-Type so Chromium's PDF
  // viewer (used by <iframe>) and <img> render the response inline
  // instead of treating it as opaque bytes.
  protocol.handle('qbo-file', async (request) => {
    try {
      const u = new URL(request.url);
      let filePath = decodeURIComponent(u.pathname);
      // Win32: pathname round-trips as "/C:/Users/Owen/x.pdf". Node's fs
      // accepts forward-slash paths but the leading slash before the
      // drive letter is interpreted as a UNC share root and breaks
      // existsSync. Strip it on win32 only — macOS / linux paths
      // genuinely start with "/".
      if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) return new Response('Is directory', { status: 400 });
      const buffer = await fs.promises.readFile(filePath);
      const mime = mimeFromPath(filePath);
      return new Response(buffer, {
        status: 200,
        headers: {
          'content-type': mime,
          'content-length': String(buffer.length),
          'content-disposition': 'inline',
          'cache-control': 'no-cache',
        },
      });
    } catch (err) {
      console.error('[qbo-file] handler error', err);
      return new Response(String(err), { status: 500 });
    }
  });
  registerIpcHandlers(() => mainWindow);
  createWindow();
});

function mimeFromPath(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'tiff':
    case 'tif':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
