// Load times and jumping UI in headless Chrome (ship review, track D). No dependency: Chrome over the DevTools Protocol.
//   node node_modules/vite-node/vite-node.mjs scripts/perf-probe.ts [--url <site>] [--port n] [--throttle n] [--only s]
//     [--switch] (route switches in one page after the first) [--act] (each route's actions: Run, menus …) [--json out.json]
// A fresh browser context per route (first load: cold cache) and, with --switch, one page that moves through the routes by
// hash. Per load: DOMContentLoaded, LCP, settled (no request, long task or DOM change for QUIET ms), JS bytes, long tasks,
// CLS and the elements that moved. With --act a route's actions are played after it settles and the shifts and resizes
// they cause are listed by element: a box that changes size when its text changes is the "jumping UI".
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (k: string) => process.argv.includes(k);
const THROTTLE = Number(arg('--throttle') ?? 1);
const QUIET = 800;
const MAX_MS = 15_000;

interface Act { name: string; js: string; wait: number }
interface Route { name: string; hash: string; acts?: Act[]; phone?: boolean }

const click = (sel: string, text?: string) => `(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
  .filter((e) => ${text ? `(e.textContent || e.getAttribute('aria-label') || e.title || '').trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())})` : 'true'})
  .filter((e) => e.offsetParent !== null); if (!els[0]) return 'missing ' + ${JSON.stringify(sel + ' ' + (text ?? ''))}; els[0].click(); return 'ok'; })()`;

const RUN: Act[] = [
  { name: 'pulse', js: click('button', 'pulse'), wait: 1500 },
  { name: 'run', js: click('button', 'run'), wait: 4000 },
  { name: 'pause', js: click('button', 'pause'), wait: 800 },
];
const CPU_RUN: Act[] = [
  { name: 'step', js: click('button', 'step'), wait: 1200 },
  { name: 'run to halt', js: click('button', 'run to halt'), wait: 5000 },
];

const ROUTES: Route[] = [
  { name: 'ch registers 1 (clocked)', hash: '#/c/registers/1', acts: RUN },
  { name: 'home', hash: '#/' },
  { name: 'ch basics 0', hash: '#/c/basics/0' },
  { name: 'ch mosfet 0', hash: '#/c/mosfet/0' },
  { name: 'ch gates 2', hash: '#/c/gates/2' },
  { name: 'ch adder 3', hash: '#/c/adders/3' },
  { name: 'ch latches 2 (clocked)', hash: '#/c/latches/2', acts: RUN },
  { name: 'ch single-cycle cpu', hash: '#/c/cpu/0', acts: CPU_RUN },
  { name: 'ch pipeline', hash: '#/c/pipeline/0', acts: CPU_RUN },
  { name: 'ch gpu pipeline (big)', hash: '#/c/graphics/0' },
  { name: 'workbench alu', hash: '#/workbench/alu' },
  { name: 'workbench stats', hash: '#/workbench/stats' },
  { name: 'workbench bench', hash: '#/workbench/bench' },
  { name: 'sandbox', hash: '#/sandbox' },
  { name: 'campaign', hash: '#/campaign' },
  { name: 'campaign codex', hash: '#/campaign/codex' },
  { name: 'path', hash: '#/path' },
  { name: 'notes', hash: '#/notes' },
  { name: 'notes visited20', hash: '?visit=basics,map,relays,tubes,mosfet,inverter,nand,gates,binary,adders,routing,latches,registers,memory,alu,regfile,isa,cpu,python,pipeline#/notes' },
  { name: 'phone ch gates 2', hash: '#/c/gates/2', phone: true },
];

// ---- page instrumentation, before any of the page's scripts ----
const INSTRUMENT = `(() => {
  const P = window.__perf = { shifts: [], longs: [], lcp: 0, lastMut: 0, resizes: [], marks: [] };
  const desc = (n) => { if (!n || !n.nodeType) return '?'; if (n.nodeType !== 1) n = n.parentElement; const parts = [];
    for (let e = n, i = 0; e && i < 4 && e !== document.body; e = e.parentElement, i++) {
      let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id;
      const c = typeof e.className === 'string' ? e.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3) : [];
      if (c.length) s += '.' + c.join('.'); const t = (e.getAttribute && (e.getAttribute('aria-label') || '')).slice(0, 20); if (t && i === 0) s += '[' + t + ']';
      parts.unshift(s); }
    return parts.join(' > '); };
  P.desc = desc;
  const r = (x) => x ? [Math.round(x.x), Math.round(x.y), Math.round(x.width), Math.round(x.height)].join(',') : '';
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) continue;
    P.shifts.push({ t: Math.round(e.startTime), v: e.value, src: (e.sources || []).map((s) => '@' + Math.round(e.startTime) + ' ' + desc(s.node) + ' [' + r(s.previousRect) + ' -> ' + r(s.currentRect) + ']') }); } })
    .observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longs.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); })
    .observe({ type: 'longtask', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lcp = Math.round(e.startTime); })
    .observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  const mo = new MutationObserver((rs) => { for (const r of rs) { const t = r.target.nodeType === 1 ? r.target : r.target.parentElement; if (t && t.closest && t.closest('svg, .hint-badge')) continue; P.lastMut = performance.now(); return; } });
  const start = () => mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  // Resize watch over the chrome around a circuit: bars, panels, crumbs, toasts, menus (not the circuit, not the prose).
  P.watch = () => { const sizes = new Map(); const ro = new ResizeObserver((es) => { for (const e of es) {
      const el = e.target; const w = Math.round(e.borderBoxSize?.[0]?.inlineSize ?? el.offsetWidth), h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
      const old = sizes.get(el); sizes.set(el, [w, h]); if (old && (old[0] !== w || old[1] !== h)) P.resizes.push({ t: Math.round(performance.now()), el: desc(el), from: old.join('x'), to: w + 'x' + h }); } });
    const sel = '.stage-bar, .stage-bar *, [class*=crumb], [class*=crumb] *, .panel, .panel button, .panel [class*=stat], .panel [class*=count], [class*=toast], [role=menu], [class*=runbar], [class*=run-row], [class*=controls] *, [class*=status]';
    const seen = new Set(); const add = () => { for (const el of document.querySelectorAll(sel)) if (!seen.has(el)) { seen.add(el); ro.observe(el); } };
    add(); setInterval(add, 300); };
})()`;

// ---- Chrome ----
function findChrome(): string {
  const c = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`, '/usr/bin/google-chrome'].filter(Boolean) as string[];
  const f = c.find((p) => existsSync(p)); if (!f) throw new Error('no Chrome'); return f;
}
function launch(): Promise<{ proc: ChildProcess; ws: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'perf-chrome-'));
  const proc = spawn(findChrome(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--headless=new', '--window-size=1400,900',
    '--disable-extensions', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((res, rej) => { let err = ''; proc.stderr!.on('data', (d: Buffer) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res({ proc, ws: m[1] }); });
    proc.on('exit', (c) => rej(new Error('chrome exited ' + c + err))); });
}
type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };
class Cdp {
  private n = 1; private pend = new Map<number, [(v: any) => void, (e: Error) => void]>(); private ls = new Map<string, (m: Msg) => void>();
  constructor(private ws: WebSocket) { ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as Msg;
    if (m.id !== undefined) { const p = this.pend.get(m.id)!; this.pend.delete(m.id); m.error ? p[1](new Error(m.error.message)) : p[0](m.result); }
    else if (m.sessionId) this.ls.get(m.sessionId)?.(m); }; }
  static connect(u: string) { return new Promise<Cdp>((r, j) => { const ws = new WebSocket(u); ws.onopen = () => r(new Cdp(ws)); ws.onerror = () => j(new Error('ws')); }); }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> { const id = this.n++; this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((r, j) => this.pend.set(id, [r, j])); }
  listen(s: string, f: (m: Msg) => void) { this.ls.set(s, f); }
  close() { this.ws.close(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Tab {
  s = ''; inflight = new Set<string>(); lastNet = 0; bytes = { js: 0, css: 0, json: 0, other: 0 }; errors: string[] = [];
  constructor(private cdp: Cdp) {}
  async open(phone = false) {
    const { browserContextId } = await this.cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    this.s = (await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    this.cdp.listen(this.s, (m) => this.ev(m));
    for (const d of ['Page', 'Runtime', 'Network']) await this.send(`${d}.enable`);
    if (THROTTLE > 1) await this.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    if (phone) await this.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    // First-run coach marks would cover the page and count as shifts of their own.
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { const k = 'mosfet2riscv:v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); if (!s.coachDone || !Object.keys(s.coachDone).length) { s.coachDone = { stage: true, sandbox: true }; if (location.search.includes('visit=')) { const ids = new URLSearchParams(location.search).get('visit').split(','); s.visited = Object.fromEntries(ids.map((c) => [c, [0]])); } localStorage.setItem(k, JSON.stringify(s)); } } catch (e) {}` });
  }
  send(m: string, p: object = {}) { return this.cdp.send(m, p, this.s); }
  ev({ method, params: p }: Msg) {
    if (method === 'Network.requestWillBeSent') { this.inflight.add(p.requestId); this.lastNet = Date.now(); }
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') { this.inflight.delete(p.requestId); this.lastNet = Date.now();
      if (method === 'Network.loadingFinished') { const t = this.types.get(p.requestId) ?? 'other'; (this.bytes as any)[t] += p.encodedDataLength; } }
    else if (method === 'Network.responseReceived') { const u: string = p.response.url; const t = /\.js(\?|$)/.test(u) ? 'js' : /\.css(\?|$)/.test(u) ? 'css' : /\.json(\?|$)/.test(u) ? 'json' : 'other';
      this.types.set(p.requestId, t); if (p.response.status >= 400) this.errors.push(`HTTP ${p.response.status} ${u}`); }
    else if (method === 'Runtime.exceptionThrown') this.errors.push('exception: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split('\n')[0]);
  }
  types = new Map<string, string>();
  async eval<T = any>(js: string): Promise<T> { const r = await this.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }); return r.result?.value; }
  /** Waits until no request, long task or DOM change for QUIET ms; returns ms since `t0` (page clock) of the last activity. */
  async settle(t0: number): Promise<{ settled: number; timedOut: boolean }> {
    const start = Date.now();
    for (;;) {
      await sleep(200);
      const st = await this.eval<{ now: number; mut: number; long: number }>(`(() => { const P = window.__perf; if (!P) return { now: 0, mut: 0, long: 0 }; const l = P.longs[P.longs.length - 1]; return { now: performance.now(), mut: P.lastMut, long: l ? l.t + l.d : 0 }; })()`).catch(() => null);
      if (!st) continue;
      const last = Math.max(st.mut, st.long);
      const netQuiet = this.inflight.size === 0 && Date.now() - this.lastNet > QUIET;
      if (netQuiet && st.now - last > QUIET) return { settled: Math.round(Math.max(last, 0) - t0), timedOut: false };
      if (Date.now() - start > MAX_MS) return { settled: Math.round(st.now - t0), timedOut: true };
    }
  }
}

const fmtShift = (sh: { v: number; src: string[] }[]) => {
  const by = new Map<string, number>();
  for (const s of sh) for (const src of s.src.length ? s.src : ['(no source)']) { const k = src.replace(/ \[.*$/, ''); by.set(k, (by.get(k) ?? 0) + s.v / Math.max(1, s.src.length)); }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v.toFixed(3)} ${k}`);
};

async function serve(): Promise<{ url: string; close(): Promise<void> }> {
  const port = Number(arg('--port') ?? 4914);
  const { preview } = await import('vite');
  const server = await preview({ appType: 'mpa', preview: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'warn' });
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

async function main() {
  const only = arg('--only');
  const routes = ROUTES.filter((r) => !only || r.name.includes(only) || r.hash.includes(only));
  const srv = arg('--url') ? { url: arg('--url')!, close: async () => {} } : await serve();
  const chrome = await launch();
  const cdp = await Cdp.connect(chrome.ws);
  const out: any[] = [];
  try {
    for (const r of routes) {
      const tab = new Tab(cdp); await tab.open(r.phone);
      await tab.send('Page.navigate', { url: srv.url + r.hash });
      const s = await tab.settle(0);
      const nav = await tab.eval(`(() => { const n = performance.getEntriesByType('navigation')[0]; const P = window.__perf;
        return { dcl: Math.round(n ? n.domContentLoadedEventEnd : 0), lcp: P.lcp, longs: P.longs.length, longMs: P.longs.reduce((a, l) => a + l.d, 0), maxLong: P.longs.reduce((a, l) => Math.max(a, l.d), 0),
          cls: P.shifts.reduce((a, x) => a + x.v, 0), shifts: P.shifts }; })()`);
      const row: any = { route: r.name, ...s, dcl: nav.dcl, lcp: nav.lcp, longTasks: nav.longs, longMs: nav.longMs, maxLong: nav.maxLong,
        cls: +nav.cls.toFixed(4), kb: Object.fromEntries(Object.entries(tab.bytes).map(([k, v]) => [k, Math.round(v / 1024)])), loadShifts: fmtShift(nav.shifts), errors: tab.errors };
      if (has('--act') && r.acts) {
        await tab.eval(`(() => { const P = window.__perf; P.shifts.length = 0; P.resizes.length = 0; P.watch(); })()`);
        await sleep(700);
        row.acts = [];
        for (const a of r.acts) {
          const res = await tab.eval(a.js); await sleep(a.wait);
          const got = await tab.eval(`(() => { const P = window.__perf; const s = P.shifts.splice(0), z = P.resizes.splice(0); return { s, z }; })()`);
          const rz = new Map<string, { n: number; ex: string }>(); for (const z of got.z) { const e = rz.get(z.el) ?? { n: 0, ex: '' }; e.n++; e.ex = `${z.from} -> ${z.to}`; rz.set(z.el, e); }
          row.acts.push({ act: a.name, result: res, cls: +got.s.reduce((x: number, y: any) => x + y.v, 0).toFixed(4), shifts: fmtShift(got.s),
            resizes: [...rz].sort((x, y) => y[1].n - x[1].n).slice(0, 10).map(([k, v]) => `${v.n}x ${k} (${v.ex})`) });
        }
      }
      out.push(row);
      console.log(JSON.stringify(row, null, 1));
      await cdp.send('Target.closeTarget', { targetId: (await tab.send('Target.getTargetInfo')).targetInfo.targetId }).catch(() => {});
    }
    if (has('--switch')) {
      const tab = new Tab(cdp); await tab.open();
      await tab.send('Page.navigate', { url: srv.url + routes[0].hash }); await tab.settle(0);
      for (const r of routes.slice(1).filter((x) => !x.phone)) {
        const t0 = await tab.eval<number>(`(() => { location.hash = ${JSON.stringify(r.hash)}; return performance.now(); })()`);
        const s = await tab.settle(t0);
        const lt = await tab.eval(`(() => { const L = window.__perf.longs.filter((l) => l.t >= ${t0}); return { n: L.length, ms: L.reduce((a, l) => a + l.d, 0), max: L.reduce((a, l) => Math.max(a, l.d), 0) }; })()`);
        const row = { switchTo: r.name, ...s, longTasks: lt.n, longMs: lt.ms, maxLong: lt.max };
        out.push(row); console.log(JSON.stringify(row));
      }
    }
  } finally {
    cdp.close(); chrome.proc.kill(); await srv.close();
  }
  if (arg('--json')) writeFileSync(arg('--json')!, JSON.stringify(out, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
