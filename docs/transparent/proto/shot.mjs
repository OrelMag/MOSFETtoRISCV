// Full-page screenshots of a static page in headless Chrome: node shot.mjs <dir> <page> <out-prefix> [width,theme ...]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const [dir, page, prefix, ...cases] = process.argv.slice(2);
const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
  const f = join(dir, p);
  if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const chrome = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && existsSync(p));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tb-'))}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res) => proc.stderr.on('data', (d) => { const m = /ws:\/\/\S+/.exec(String(d)); if (m) res(m[0]); }));
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waits = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
for (const c of cases) {
  const [w, theme] = c.split(',');
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: 900, deviceScaleFactor: 1, mobile: Number(w) < 600 }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${page}` }, sessionId);
  await new Promise((r) => setTimeout(r, 3500));
  const m = await send('Page.getLayoutMetrics', {}, sessionId);
  const h = Math.ceil(m.result.cssContentSize.height);
  await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: h, deviceScaleFactor: 1, mobile: Number(w) < 600 }, sessionId);
  await new Promise((r) => setTimeout(r, 800));
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(`${prefix}-${w}-${theme}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`${prefix}-${w}-${theme}.png ${w}×${h}`);
  await send('Target.closeTarget', { targetId });
}
ws.close(); proc.kill(); server.close();
