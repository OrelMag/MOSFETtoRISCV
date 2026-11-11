// Drives the prototype in headless Chrome over the DevTools Protocol and saves what it reports.
//   node docs/transparent/proto/drive.mjs <built dir (.proto-dist)> <out-dir>
// It serves the built dir itself on a port the OS picks, so it can never measure another session's server.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const [dist, outDir] = process.argv.slice(2);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const f = join(dist, p);
  if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
const chrome = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .find((p) => p && existsSync(p));
const profile = mkdtempSync(join(tmpdir(), 'tb-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res) => proc.stderr.on('data', (d) => { const m = /ws:\/\/\S+/.exec(String(d)); if (m) res(m[0]); }));
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const waits = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

async function run(query, width, height) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: `${base}?${query}` }, sessionId);
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__out ?? {})', returnByValue: true }, sessionId);
    const o = JSON.parse(r.result?.result?.value ?? '{}');
    if (o.done || Date.now() - t0 > 600_000) { await send('Target.closeTarget', { targetId }); return o; }
  }
}

const m = await run('mode=measure&w=1200&h=800', 1200, 800);
writeFileSync(join(outDir, 'draw-levels.json'), JSON.stringify(m, null, 1));
console.log(m.error ?? `measure: ${m.rows?.length} levels`);
if (process.argv.includes('--renders-only')) m.rows = [];
for (const theme of ['light', 'dark', 'paper']) {
  // paper: the light theme with the dark board off (the circuit on the light canvas)
  const r = await run(`mode=render&theme=${theme === 'paper' ? 'light&board=off' : theme}&w=1400&h=900`, 1400, 900);
  if (r.error) { console.log(r.error); continue; }
  writeFileSync(join(outDir, `top-${theme}.svg`), r.top);
  writeFileSync(join(outDir, `alu-inside-${theme}.svg`), r.inside);
  writeFileSync(join(outDir, `geometry-${theme}.json`), JSON.stringify({ alu: r.alu, topBox: r.topBox, aluBox: r.aluBox, ports: r.ports }, null, 1));
  console.log(`render ${theme}: alu box`, JSON.stringify(r.alu));
}
ws.close();
proc.kill();
server.close();
