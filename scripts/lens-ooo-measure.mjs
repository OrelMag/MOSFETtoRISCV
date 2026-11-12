// Phase 2f (docs/transparent/DESIGN.md): how long the zoom lens takes to open on each box of the out-of-order core,
// on the built site (any scene: the single-cycle CPU's for comparison). For every openable part of the level, `runs` times: Fit, wheel
// onto it until it is 110 px, wait for the lens (or its hint), then read the lens's own build time (data-build-ms: the
// sub-simulation, the inside's drawing, its placement) and the longest task the page ran meanwhile (PerformanceObserver).
//   node scripts/lens-ooo-measure.mjs <dist> <hash of the scene> [runs] [out.json]
// It serves <dist> itself on a port the OS picks. Run it on a quiet machine: the numbers are main-thread time.
// PARTS=a,b only those parts; LENS_OFF=1 the same zooms with the setting off (the page's own long tasks, for comparison).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, loadavg, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const [dist, scene, runsArg = '3', outFile] = process.argv.slice(2);
const runs = Number(runsArg);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/json' };
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const f = join(dist, p);
  if (!existsSync(f) || p.endsWith('/')) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const chrome = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && existsSync(p));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tb-'))}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res) => proc.stderr.on('data', (d) => { const m = /ws:\/\/\S+/.exec(String(d)); if (m) res(m[0]); }));
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waits = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
});
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const ev = async (s, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId: s } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, s);
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, s);
await send('Page.navigate', { url: base }, s);
await sleep(800);
await ev(s, `localStorage.setItem('mosfet2riscv:v1', JSON.stringify({ theme: 'dark', autoClock: false, zoomOpen: ${process.env.LENS_OFF ? 'false' : 'true'}, coachDone: { stage: true, sandbox: true } }))`);
await send('Page.navigate', { url: 'about:blank' }, s);
await sleep(200);
await send('Page.navigate', { url: `${base}#${scene}` }, s);
for (let i = 0; i < 600; i++) { await sleep(200); if (await ev(s, `!!document.querySelector('.canvas > svg.schematic [data-inst]') && !document.querySelector('.load-card')`)) break; }
await sleep(3000);

const only = process.env.PARTS?.split(',');
const parts0 = await ev(s, `[...document.querySelectorAll('.canvas > svg.schematic > * > g.inst.openable[data-inst], .canvas > svg.schematic g.inst.openable[data-inst]')].filter((g) => !g.closest('.lens')).map((g) => g.dataset.inst).filter((v, i, a) => a.indexOf(v) === i)`);
const parts = only ?? parts0;
console.log(`${parts.length} openable parts: ${parts.join(' ')}`);

const once = (part) => ev(s, `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  esc(); await wait(100);
  document.querySelector('.lens-hint')?.remove();
  const fit = [...document.querySelectorAll('.stage-bar button')].find((b) => /fit to screen/i.test(b.title + ' ' + (b.getAttribute('aria-label') ?? '')));
  fit?.click(); await wait(400);
  const svg = document.querySelector('.canvas > svg.schematic');
  const box = () => svg.querySelector('g.inst[data-inst="${part}"]')?.getBoundingClientRect();
  if (!box()) return { part: '${part}', error: 'not drawn' };
  for (let k = 0; k < 60 && Math.min(box().width, box().height) < 110; k++) {
    const r = box();
    svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true }));
    await wait(15);
  }
  const long = [];
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); });
  po.observe({ type: 'longtask', buffered: false });
  const t0 = performance.now();
  let lens = null, hint = null;
  while (performance.now() - t0 < 8000) {
    await wait(50);
    lens = document.querySelector('.lens'); hint = document.querySelector('.lens-hint');
    if (lens || hint) break;
  }
  await wait(300);
  po.disconnect();
  const r = box();
  const out = { part: '${part}', px: r ? Math.round(Math.min(r.width, r.height)) : 0, opened: !!lens, hint: hint?.textContent ?? null,
    buildMs: lens ? Number(lens.dataset.buildMs) : null, longMs: Math.round(Math.max(0, ...long)),
    nodes: lens ? lens.querySelectorAll('*').length : 0, tag: lens?.querySelector('.lens-tag')?.textContent ?? null };
  esc(); await wait(100);
  return out;
})()`);

const rows = [];
for (const part of parts) {
  const rs = [];
  for (let i = 0; i < runs; i++) rs.push(await once(part));
  const ok = rs.filter((r) => r.opened);
  const med = (xs) => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const row = { part, px: rs[0].px, opened: ok.length, of: rs.length, hint: rs.find((r) => r.hint)?.hint ?? null, error: rs.find((r) => r.error)?.error ?? null,
    buildMs: med(ok.map((r) => r.buildMs)), buildMax: ok.length ? Math.max(...ok.map((r) => r.buildMs)) : null, longMs: med(rs.map((r) => r.longMs)), nodes: ok[0]?.nodes ?? 0, tag: ok[0]?.tag ?? null };
  rows.push(row);
  console.log(`${part.padEnd(10)} ${row.opened}/${row.of} build ${row.buildMs ?? '-'} ms (max ${row.buildMax ?? '-'}) long ${row.longMs} ms nodes ${row.nodes} ${row.hint ?? row.error ?? ''}`);
}
const info = { scene, runs, cpus: cpus().length, loadavg: loadavg(), date: new Date().toISOString(), errors };
if (outFile) writeFileSync(outFile, JSON.stringify({ info, rows }, null, 1));
console.log(errors.length ? errors.join('\n') : 'no page errors');
ws.close(); proc.kill(); server.close();
