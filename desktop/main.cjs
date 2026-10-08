// MOSFET → RISC-V as a desktop program: the built site (app/) served from inside the executable
// on a private app:// origin, in a window of its own. Nothing is fetched from the network.
const { app, BrowserWindow, Menu, nativeTheme, protocol, shell } = require('electron');
const { existsSync, mkdirSync, accessSync, constants } = require('node:fs');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://mosfet`;
const ROOT = path.join(__dirname, 'app');

// A portable program keeps its data (progress, sandbox chips, settings) next to the .exe, so a copy on
// a USB stick carries them along. Falls back to the usual per-user folder when that place is read-only.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDir) {
  const data = path.join(portableDir, 'MOSFET-to-RISCV-data');
  try {
    if (!existsSync(data)) mkdirSync(data);
    accessSync(data, constants.W_OK);
    app.setPath('userData', data);
  } catch { /* keep the default */ }
}

// One window: localStorage is shared by all of them, and a second instance could not open it anyway.
if (!app.requestSingleInstanceLock()) app.quit();

// A standard, secure scheme behaves like https: a stable origin (localStorage survives restarts),
// ES modules and fetch() work, unlike file://.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.pdf': 'application/pdf', '.gz': 'application/gzip', '.v': 'text/plain; charset=utf-8', '.sv': 'text/plain; charset=utf-8',
};

async function serve(request) {
  const { pathname } = new URL(request.url);
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const body = await readFile(file);
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 720, minHeight: 480, show: false,
    title: 'MOSFET → RISC-V',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c12' : '#f5f6fa',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());

  // Links that leave the site (GitHub, references) open in the default browser, never inside the program.
  const external = (url) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ORIGIN + '/')) external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN + '/')) return;
    e.preventDefault();
    external(url);
  });

  // Without a menu bar these are the few browser keys worth keeping. The site uses none of them.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools(); e.preventDefault();
    }
  });

  win.on('closed', () => { win = null; });
  void win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
