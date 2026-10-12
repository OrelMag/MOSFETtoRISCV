// Renders the site's favicon (index.html) to icon.png, 256 × 256: run with `npx electron scripts/icon.cjs`.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const href = html.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)"/)[1];
const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length)).replace('<svg ', '<svg width="256" height="256" ');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = (await win.webContents.capturePage()).resize({ width: 256, height: 256, quality: 'best' });
  writeFileSync(path.join(__dirname, '..', 'icon.png'), img.toPNG());
  app.quit();
});
