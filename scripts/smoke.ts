// Browser smoke test: every route of a production build opened in headless Chrome, failing on any
// runtime error. No dependency: Chrome is launched here and driven over the DevTools Protocol with
// Node's own WebSocket.
//
//   npm run build && npm run smoke                       (starts `vite preview` of dist/ itself)
//   vite-node scripts/smoke.ts --url http://host/sub/     (a site already served)
//   options: --only <substring of the route>  --tabs <n>  --headful  --timeout <s per route>
//   CHROME=<path> picks the browser (else the usual Windows / Linux / macOS locations).
//
// Routes come from the code (chapters, workbench families, campaign nodes and codex, sandbox
// examples), so new content is covered without editing a list. Every route is a fresh page load
// in a browser context of its own tab (storage isolated per tab, reset before each load), with
// the localStorage a learner would have there: a theme, Unlock all for the levels, the examples
// in the sandbox's workspace. Chapter steps run in both themes (scenes, widgets and canvases read
// theme colours from CSS); everything else in the light theme, plus the home page in dark.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chapters } from '../src/chapters';
import { families, initialParams } from '../src/lib/resolve';
import { NODES } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { CAMPAIGN_KEY } from '../src/campaign/progress';
import { CODEX } from '../src/campaign/codex';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { emptyWorkspace } from '../src/editor/model';
import { KEY as SANDBOX_KEY } from '../src/editor/store';

// ---- options ---------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const headful = argv.includes('--headful');
const only = opt('only');
const tabs = Number(opt('tabs') ?? Math.max(2, Math.min(6, cpus().length - 1)));
const routeTimeout = Number(opt('timeout') ?? 60) * 1000;
// After the load and two frames: long enough for a 2 Hz automatic clock (settings.autoClock) to tick once.
const dwell = Number(opt('dwell') ?? 600);

// ---- routes ----------------------------------------------------------------------------------

interface Route {
  hash: string;
  /** localStorage before the page loads (keys → values). */
  storage: Record<string, string>;
  label: string;
  /** An emulated screen, and the page must not be wider than it (no horizontal scroll). */
  viewport?: Viewport;
}

interface Viewport { width: number; height: number; mobile: boolean; name: string }
const VIEWPORTS: Viewport[] = [
  { width: 1280, height: 800, mobile: false, name: '1280px' },
  { width: 390, height: 844, mobile: true, name: '390px phone' },
];

const SETTINGS_KEY = 'mosfet2riscv:v1';
const themed = (theme: 'light' | 'dark') => ({ [SETTINGS_KEY]: JSON.stringify({ theme }) });
const light = themed('light');
const unlocked = { ...light, [CAMPAIGN_KEY]: JSON.stringify({ schema: 1, nodes: {}, unlockAll: true }) };

function examplesWorkspace(): { json: string; ids: string[] } {
  let ws = emptyWorkspace();
  const ids: string[] = [];
  for (const ex of EXAMPLES) {
    const r = addExample(ws, ex);
    ws = r.ws;
    ids.push(r.id);
  }
  return { json: JSON.stringify(ws), ids };
}

function routes(): Route[] {
  const out: Route[] = [];
  const add = (hash: string, storage: Record<string, string>, note = '', viewport?: Viewport) => out.push({ hash, storage, label: hash + note, viewport });
  add('#/', light);
  add('#/', themed('dark'), ' (dark)');
  for (const theme of ['light', 'dark'] as const) {
    for (const c of chapters) {
      c.steps.forEach((_, i) => add(`#/c/${c.id}/${i}`, themed(theme), theme === 'dark' ? ' (dark)' : ''));
      // the recap, one past the last step
      if (c.recap) add(`#/c/${c.id}/${c.steps.length}`, themed(theme), theme === 'dark' ? ' (dark)' : '');
    }
  }
  // The default of every workbench family (what the family picker opens first).
  for (const f of families) add(`#/workbench/${f.key(initialParams(f))}`, light);
  add('#/workbench/stats', light);
  add('#/workbench/bench', light);
  add('#/workbench/lab', light);
  add('#/campaign', light);
  add('#/campaign/intro', light);
  add('#/campaign/codex', unlocked);
  for (const e of CODEX) add(`#/campaign/codex/${e.id}`, unlocked);
  for (const n of NODES) {
    add(`#/campaign/play/${n.id}`, unlocked);
    // Lessons, drills and programs open on the map instead (pages/level.ts levelRoute).
    if (!levelChallenge(n) || n.soon) add(`#/campaign/n/${n.id}`, unlocked);
  }
  // A locked level renders its notice (fresh progress: only the first levels are open).
  add(`#/campaign/play/${NODES[NODES.length - 1].id}`, light, ' (locked)');
  add('#/sandbox', light);
  // No horizontal overflow on one page of each kind, on a desktop and on a phone.
  for (const v of VIEWPORTS) {
    for (const hash of ['#/', `#/c/${chapters[1].id}/0`, '#/workbench/rca4', '#/campaign', '#/sandbox']) add(hash, light, ` (${v.name})`, v);
  }
  // Pages whose panels a phone once lost: the GPU screen and drawing pad, the Out of order panel, the level bar.
  const phone = VIEWPORTS.find((v) => v.mobile)!;
  for (const hash of ['#/c/pixels/5', '#/c/graphics/1', '#/c/ooo/8']) add(hash, light, ` (${phone.name})`, phone);
  add(`#/campaign/play/${NODES.find((n) => n.kind === 'core')!.id}`, unlocked, ` (${phone.name})`, phone);
  // The sandbox's toolbar at the common desktop widths too (CLIPPED: no label cut, nothing scrolled out of view).
  for (const width of [1440, 1920]) add('#/sandbox', light, ` (${width}px)`, { width, height: 900, mobile: false, name: `${width}px` });
  const ex = examplesWorkspace();
  for (const id of ex.ids) add(`#/sandbox/${id}`, { ...light, [SANDBOX_KEY]: ex.json });
  return only ? out.filter((r) => r.label.includes(only)) : out;
}

// ---- requests allowed to fail -----------------------------------------------------------------

const OPTIONAL: [RegExp, string][] = [
  // The chip layout is published by the layout workflow and added to dist/ by CI's deploy job only;
  // widgets/chiplayout.ts shows a placeholder without it.
  [/\/layout\/[^/]+\.json(\?|$)/, 'layout assets'],
  // Web fonts from a third party: the CSS falls back to system fonts, and an outage there must not block a deploy.
  [/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, 'Google Fonts'],
];
const optional = (url: string) => OPTIONAL.some(([re]) => re.test(url));

// ---- Chrome and the DevTools Protocol -----------------------------------------------------------

function findChrome(): string {
  const env = process.env.CHROME;
  if (env) return env;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME to its path');
  return found;
}

function launchChrome(): Promise<{ proc: ChildProcess; ws: string; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'smoke-chrome-'));
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,900', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-extensions', '--mute-audio',
    ...(headful ? [] : ['--headless=new']),
    // GitHub's Linux runners have no user namespaces for Chrome's sandbox.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${err}`)), 30_000);
    proc.stderr!.on('data', (d: Buffer) => {
      err += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, ws: m[1], profile });
      }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${err}`)));
  });
}

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

/** One WebSocket to the browser; pages are flat sessions on it. */
class Cdp {
  private next = 1;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; method: string }>();
  private listeners = new Map<string, (m: Msg) => void>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`));
        else p?.resolve(m.result);
      } else if (m.sessionId) this.listeners.get(m.sessionId)?.(m);
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  listen(sessionId: string, f: (m: Msg) => void): void {
    this.listeners.set(sessionId, f);
  }

  close(): void {
    this.ws.close();
  }
}

// ---- one tab ---------------------------------------------------------------------------------

interface Result {
  route: Route;
  errors: string[];
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the page shows once settled: the app's own failure panels (app.ts, stage.ts), an editor's
 * error toast or error diagnostics (a broken example or level chip), an empty main view.
 */
const INSPECT = `(() => {
  const view = document.querySelector('#view');
  if (!view) return ['no #view (the app did not start)'];
  const out = [];
  const failed = [...view.querySelectorAll('h3, .pulse.warn, .status')].map((e) => (e.closest('.panel, .status') ?? e).textContent.trim())
    .filter((t) => /could not (load|start)/i.test(t));
  if (failed.length) out.push(failed[0].slice(0, 300));
  for (const e of document.querySelectorAll('.sb-toast.show.err')) out.push('error toast: ' + e.textContent.trim());
  for (const e of view.querySelectorAll('.sb-diag.error')) out.push('error diagnostic: ' + e.textContent.trim());
  if (!view.children.length || (!view.innerText.trim() && !view.querySelector('svg, canvas, img'))) out.push('the main view is empty');
  return out;
})()`;

/**
 * Wider than the window (a horizontal scroll bar, a phone page that pans sideways): the outermost
 * elements sticking out (their parent fits), furthest first, skipping those an ancestor clips or
 * scrolls. The layout viewport is documentElement.clientWidth: on a phone innerWidth is the visual
 * viewport, which Chrome zooms out to fit an overflowing page, hiding the overflow.
 */
const OVERFLOW = `(() => {
  const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth <= W + 1) return [];
  const clipped = (e) => {
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== 'visible' && a.getBoundingClientRect().right <= W + 1) return true;
    }
    return false;
  };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, 3).map((c) => '.' + c).join('');
  const sticks = (e) => e.getBoundingClientRect().right > W + 1;
  const out = [...document.body.querySelectorAll('*')].filter((e) => sticks(e) && !sticks(e.parentElement) && !clipped(e))
    .map((e) => [e, e.getBoundingClientRect().right]).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([e, r]) => name(e) + ' to ' + Math.round(r) + 'px');
  return ['page ' + document.documentElement.scrollWidth + 'px wide in a ' + W + 'px window: ' + out.join(', ')];
})()`;

/**
 * The sandbox's top bar with a label cut or scrolled out of view (at 1440 px "+ New chip" read "New chi"
 * under the autosave indicator): the actions that do not fit belong in its More menu (editor.ts fitActions).
 */
const CLIPPED = `(() => {
  const top = document.querySelector('.sb-top');
  if (!top) return [];
  const tabs = top.querySelector('.sb-tabs'), tr = tabs.getBoundingClientRect(), R = top.getBoundingClientRect().right;
  const out = [];
  for (const el of top.querySelectorAll('.sb-tab.on, .sb-open, .sb-new, .sb-top-slot > *, .sb-actions > button')) {
    const b = el.getBoundingClientRect();
    if (!b.width) continue;
    const name = (el.textContent || el.getAttribute('aria-label') || el.className).trim().slice(0, 24);
    if (el.scrollWidth > el.clientWidth + 1) out.push('toolbar label cut: ' + name);
    else if (tabs.contains(el) && (b.left < tr.left - 1 || b.right > tr.right + 1)) out.push('toolbar item scrolled out of view: ' + name);
    else if (b.right > R + 1) out.push('toolbar item past the bar: ' + name);
  }
  // the open tab slid under the sticky Open… / New chip group (many tabs: editor.ts showActiveTab)
  const on = top.querySelector('.sb-tab.on'), grp = top.querySelector('.sb-new-grp');
  if (on && grp && on.getBoundingClientRect().right > grp.getBoundingClientRect().left + 1) out.push('open tab under New chip: ' + on.textContent.trim().slice(0, 24));
  return out;
})()`;

/**
 * A chapter or workbench stage whose bars lost something: the open level's name cut on a one-row top bar (its
 * buttons belong in More: Stage.fitBar), a button past either bar's edge, the run row's buttons cut
 * (Stage.fitControls drops their labels instead). Checked on every route.
 */
const STAGE_BARS = `(() => {
  const out = [];
  for (const bar of document.querySelectorAll('.stage-bar, .stage .controls')) {
    if (!bar.offsetWidth) continue;
    const R = bar.getBoundingClientRect().right;
    const cur = bar.querySelector('.crumbs > button:last-of-type');
    if (cur && !bar.classList.contains('stacked') && cur.scrollWidth > cur.clientWidth + 1) out.push('stage bar: the open level\\'s name cut: ' + cur.textContent.trim().slice(0, 32));
    // a row that scrolls sideways (a phone's pins: app.css .ctl-pins) keeps its buttons reachable
    const scrolls = (b) => { for (let e = b.parentElement; e && e !== bar; e = e.parentElement) if (/auto|scroll/.test(getComputedStyle(e).overflowX)) return true; return false; };
    for (const b of bar.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (r.width && r.right > R + 1 && !b.closest('.pal-menu') && !scrolls(b)) out.push('stage bar: button past the bar: ' + (b.getAttribute('aria-label') || b.textContent || b.title).trim().slice(0, 32));
    }
    const run = bar.querySelector('.ctl-run');
    if (run && run.scrollWidth > run.clientWidth + 1) out.push('stage run bar cut (' + run.scrollWidth + ' px in ' + run.clientWidth + ')');
  }
  return out;
})()`;

class Tab {
  private session = '';
  private errors: string[] = [];
  private inflight = new Map<string, string>();
  /** This route's document (`?smoke=<seq>`): a request the previous page started as it was left is not this route's. */
  private doc: RegExp | null = null;
  private lastNet = 0;
  private loaded = false;
  private script = '';
  private emulated = false;

  constructor(private cdp: Cdp, private base: string) {}

  async open(): Promise<void> {
    const { browserContextId } = await this.cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    this.session = (await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    this.cdp.listen(this.session, (m) => this.event(m));
    for (const d of ['Page', 'Runtime', 'Log', 'Network']) await this.send(`${d}.enable`);
  }

  private send(method: string, params: object = {}) {
    return this.cdp.send(method, params, this.session);
  }

  private event({ method, params: p }: Msg): void {
    switch (method) {
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        this.errors.push(`exception: ${(d.exception?.description ?? d.text).split('\n').slice(0, 4).join(' | ')}`);
        break;
      }
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'assert') {
          const text = p.args.map((a: any) => a.value ?? a.description ?? a.type).join(' ');
          this.errors.push(`console.${p.type}: ${text.split('\n').slice(0, 4).join(' | ')}`);
        }
        break;
      case 'Log.entryAdded':
        // Network failures are reported (and filtered) below; the rest are the browser's own errors.
        if (p.entry.level === 'error' && p.entry.source !== 'network') this.errors.push(`log: ${p.entry.text}`);
        break;
      case 'Network.requestWillBeSent':
        if (this.doc && p.documentURL && !this.doc.test(p.documentURL)) break;
        this.inflight.set(p.requestId, p.request.url);
        this.lastNet = Date.now();
        break;
      case 'Network.responseReceived':
        if (p.response.status >= 400 && !optional(p.response.url)) this.errors.push(`HTTP ${p.response.status}: ${p.response.url}`);
        break;
      case 'Network.loadingFinished':
        this.inflight.delete(p.requestId);
        this.lastNet = Date.now();
        break;
      case 'Network.loadingFailed': {
        const url = this.inflight.get(p.requestId) ?? '?';
        this.inflight.delete(p.requestId);
        this.lastNet = Date.now();
        if (!p.canceled && !optional(url)) this.errors.push(`request failed (${p.errorText}): ${url}`);
        break;
      }
      case 'Page.loadEventFired':
        this.loaded = true;
        break;
    }
  }

  async visit(route: Route, seq: number): Promise<Result> {
    const t0 = Date.now();
    this.errors = [];
    this.inflight.clear();
    this.doc = new RegExp(`[?&]smoke=${seq}(?:[&#]|$)`);
    this.loaded = false;
    // Storage as the route wants it, set before any of the page's scripts run.
    if (this.script) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.script });
    const seed = `try { if (location.protocol.startsWith('http')) { localStorage.clear(); const s = ${JSON.stringify(route.storage)}; for (const k in s) localStorage.setItem(k, s[k]); } } catch (e) {}`;
    this.script = (await this.send('Page.addScriptToEvaluateOnNewDocument', { source: seed })).identifier;
    if (route.viewport) {
      const { width, height, mobile } = route.viewport;
      await this.send('Emulation.setDeviceMetricsOverride', { width, height, mobile, deviceScaleFactor: mobile ? 2 : 1 });
      this.emulated = true;
    } else if (this.emulated) {
      await this.send('Emulation.clearDeviceMetricsOverride');
      this.emulated = false;
    }
    // A query of its own makes every route a fresh document (a hash alone would only fire hashchange).
    const url = `${this.base}?smoke=${seq}${route.hash}`;
    try {
      const nav = await this.send('Page.navigate', { url });
      if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
      await this.settle(t0);
      const seen = (await this.send('Runtime.evaluate', { expression: INSPECT, returnByValue: true })).result.value as string[];
      for (const p of seen) this.errors.push(`page: ${p}`);
      const bars = (await this.send('Runtime.evaluate', { expression: STAGE_BARS, returnByValue: true })).result.value as string[];
      for (const p of bars) this.errors.push(p);
      if (route.viewport) {
        const wide = (await this.send('Runtime.evaluate', { expression: OVERFLOW, returnByValue: true })).result.value as string[];
        for (const p of wide) this.errors.push(`overflow: ${p}`);
        const cut = (await this.send('Runtime.evaluate', { expression: CLIPPED, returnByValue: true })).result.value as string[];
        for (const p of cut) this.errors.push(p);
      }
    } catch (e) {
      this.errors.push(String(e instanceof Error ? e.message : e));
    }
    return { route, errors: [...new Set(this.errors)], ms: Date.now() - t0 };
  }

  /** Loaded, no request for 500 ms, then two frames and `dwell` ms for work scheduled after them. */
  private async settle(t0: number): Promise<void> {
    while (!this.loaded || this.inflight.size || Date.now() - this.lastNet < 500) {
      if (Date.now() - t0 > routeTimeout) throw new Error(`timeout: ${this.loaded ? `${this.inflight.size} requests pending (${[...this.inflight.values()][0]})` : 'no load event'}`);
      await sleep(50);
    }
    const idle = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ${dwell}))))`;
    await Promise.race([
      this.send('Runtime.evaluate', { expression: idle, awaitPromise: true }),
      sleep(routeTimeout - (Date.now() - t0)).then(() => { throw new Error('timeout: the page never became idle'); }),
    ]);
  }
}

// ---- the server ------------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startPreview(): Promise<{ url: string; close(): Promise<void> }> {
  if (!existsSync('dist/index.html')) throw new Error('no dist/: run the build first (or pass --url)');
  const { preview } = await import('vite');
  const port = await freePort();
  // mpa: a missing file is a 404 (as on GitHub Pages), not index.html.
  const server = await preview({ appType: 'mpa', preview: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'warn' });
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

// ---- main ------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const list = routes();
  if (!list.length) {
    console.error(`no route matches --only ${only}`);
    return 1;
  }
  const t0 = Date.now();
  const server = opt('url') ? null : await startPreview();
  const base = (opt('url') ?? server!.url).replace(/#.*$/, '');
  const chrome = await launchChrome();
  const cdp = await Cdp.connect(chrome.ws);
  const results: Result[] = [];
  try {
    const n = Math.min(tabs, list.length);
    console.log(`smoke: ${list.length} routes on ${base} in ${n} tabs`);
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      const tab = new Tab(cdp, base);
      await tab.open();
      while (next < list.length) {
        const i = next++;
        const r = await tab.visit(list[i], i);
        results.push(r);
        if (r.errors.length) console.log(`FAIL ${r.route.label}\n${r.errors.map((e) => `     ${e}`).join('\n')}`);
        else if (results.length % 50 === 0) console.log(`  ${results.length} / ${list.length}`);
      }
    }));
  } finally {
    cdp.close();
    chrome.proc.kill();
    await server?.close();
    await sleep(500);
    try { rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a file */ }
  }

  const failed = results.filter((r) => r.errors.length);
  const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log(`\nslowest: ${slow.map((r) => `${r.route.label} ${(r.ms / 1000).toFixed(1)} s`).join(', ')}`);
  if (failed.length) {
    console.log(`\n${'route'.padEnd(48)} errors`);
    for (const r of failed.sort((a, b) => a.route.label.localeCompare(b.route.label))) {
      console.log(`${r.route.label.padEnd(48)} ${r.errors[0]}`);
      for (const e of r.errors.slice(1)) console.log(`${''.padEnd(48)} ${e}`);
    }
  }
  console.log(`\nsmoke: ${results.length} routes, ${failed.length} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(2);
});
