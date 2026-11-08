// README screenshots: the plan (SHOTS) and a runner for them. Each is taken from a build of the site in a fresh browser
// context (nothing stored but what the shot seeds), 1440 × 900, 1x, the site's default theme (no `theme` setting: auto, so light in
// headless Chrome), PNG into docs/images/ under the README's name for it, like the ones already there.
//
//   node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port <free port> --strictPort
//   node node_modules/vite-node/vite-node.mjs scripts/readme-shots.ts --url http://localhost:<port>/ [--only sdr] [--headful]
//
// Written to be read as much as run: `why` says what the picture has to show, `wait` is the condition that the scene is built
// (a big gate-level scene says "building" for seconds), `then` the clicks that open a menu, `dwell` the quiet time after.
// The README references these files already (docs/images/sdr.png, cap_tune.png, warps.png, control.png, wirecolours.png).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMPAIGN_KEY } from '../src/campaign/progress';
import { EXAMPLES, addExample } from '../src/editor/examples';
import { emptyWorkspace } from '../src/editor/model';
import { KEY as SANDBOX_KEY } from '../src/editor/store';

const SETTINGS_KEY = 'mosfet2riscv:v1';
// no theme: the default one; the coach-mark tours count as seen so they do not dim the page
const SETTINGS = JSON.stringify({ coachDone: { stage: true, sandbox: true } });

interface Shot {
  name: string; // docs/images/<name>.png
  route: string; // hash route; `{chip}` is the id of the seeded sandbox example
  why: string;
  storage?: Record<string, string>;
  /** Page-side expression that turns truthy when the scene is built. */
  wait: string;
  /** Page-side snippets run in order after `wait` (each awaited), to open a menu. */
  then?: string[];
  dwell: number;
}

/** A scene is built when the progress card is gone and the stage has drawn its SVG. */
const BUILT = `!document.querySelector('.load-bar, .load-phases') && document.querySelector('#view .stage svg.schematic, #view svg.schematic')`;

function sandboxCounter(): { storage: Record<string, string>; chip: string } {
  const ex = EXAMPLES.find((e) => e.id === 'counter7')!;
  const r = addExample(emptyWorkspace(), ex);
  return { storage: { [SANDBOX_KEY]: JSON.stringify(r.ws) }, chip: r.id };
}
const counter = sandboxCounter();

export const SHOTS: Shot[] = [
  {
    name: 'sdr', route: '#/c/sdr/9',
    why: 'A DSP chapter: the software radio at "Turn the dial". Check by eye that this step shows the spectrum and the dial; sdr/4 (the mixer in gates) is the alternative.',
    wait: `document.querySelector('#view .widget, #view canvas, #view svg')`, dwell: 2500,
  },
  {
    name: 'cap_tune', route: '#/campaign/play/cap_tune',
    why: 'The DSP capstone Tune it on the level screen: the brief, the radio blocks it unlocks, the canvas. Unlock all so the capstone is open on a fresh profile.',
    storage: { [CAMPAIGN_KEY]: JSON.stringify({ schema: 1, nodes: {}, unlockAll: true }) },
    wait: `document.querySelector('#view .sb-canvas, #view svg')`, dwell: 3000,
  },
  {
    name: 'warps', route: '#/c/warps/0',
    why: 'The warp core drawn as blocks (lanes, issue and scoreboard, memory). A big scene: wait for the build, then the camera fit.',
    wait: BUILT, dwell: 6000,
  },
  {
    name: 'control', route: '#/c/alu/5',
    why: 'The CPU control unit drawn as blocks: the decoder and the signal groups it drives.',
    wait: BUILT, dwell: 2500,
  },
  {
    name: 'wirecolours', route: `#/sandbox/{chip}`,
    why: 'The sandbox on the 4-bit counter with a wire\'s right-click menu open at its colour swatches (Auto + the hue row).',
    storage: counter.storage,
    wait: `document.querySelectorAll('#view path.wire[data-wire]').length > 3`,
    // right-click (contextmenu) the middle of the longest wire; the menu's colour row is .sb-ctx-hues
    then: [`(async () => {
      const wires = [...document.querySelectorAll('#view path.wire[data-wire]')];
      const w = wires.sort((a, b) => b.getTotalLength() - a.getTotalLength())[0];
      const p = w.getPointAtLength(w.getTotalLength() / 2), m = w.getScreenCTM();
      const x = p.x * m.a + p.y * m.c + m.e, y = p.x * m.b + p.y * m.d + m.f;
      w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
      for (let i = 0; i < 40 && !document.querySelector('.sb-ctx-hues'); i++) await new Promise((r) => setTimeout(r, 50));
    })()`],
    dwell: 800,
  },
];

// ---- runner: Chrome over the DevTools protocol, as scripts/smoke.ts does -----------------------------------------------------
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findChrome(): string {
  const c = [process.env.CHROME ?? '', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
  if (!c) throw new Error('Chrome not found: set CHROME');
  return c;
}

async function main(): Promise<void> {
  const url = arg('--url');
  if (!url) throw new Error('--url <site> is required (a build served by vite preview)');
  const only = arg('--only');
  const profile = mkdtempSync(join(tmpdir(), 'readme-shots-'));
  const proc = spawn(findChrome(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', ...(process.argv.includes('--headful') ? [] : ['--headless=new']), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((res, rej) => {
    let err = '';
    proc.stderr!.on('data', (d: Buffer) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res(m[1]); });
    proc.on('exit', () => rej(new Error(`Chrome exited:\n${err}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id) pending.get(m.id)?.(m); };
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res, rej) => {
    const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  try {
    for (const shot of SHOTS.filter((s) => !only || s.name.includes(only))) {
      const { browserContextId } = await send('Target.createBrowserContext');
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const page = (m: string, p: object = {}) => send(m, p, sessionId);
      const evalJs = async (expression: string) => (await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
      await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await page('Page.enable');
      // the settings and the shot's storage are in place before the app starts
      const seed = { [SETTINGS_KEY]: SETTINGS, ...(shot.storage ?? {}) };
      await page('Page.addScriptToEvaluateOnNewDocument', { source: `try { for (const [k, v] of Object.entries(${JSON.stringify(seed)})) localStorage.setItem(k, v); } catch {}` });
      await page('Page.navigate', { url: new URL(shot.route.replace('{chip}', counter.chip), url).href.replace('%23', '#') });
      for (let i = 0; i < 240 && !(await evalJs(`Boolean(${shot.wait})`)); i++) await sleep(250);
      if (!(await evalJs(`Boolean(${shot.wait})`))) throw new Error(`${shot.name}: the scene was not built within 60 s`);
      for (const step of shot.then ?? []) await evalJs(step);
      await sleep(shot.dwell);
      const { data } = await page('Page.captureScreenshot', { format: 'png' });
      writeFileSync(new URL(`../docs/images/${shot.name}.png`, import.meta.url), Buffer.from(data, 'base64'));
      console.log(`${shot.name}: docs/images/${shot.name}.png`);
      await send('Target.disposeBrowserContext', { browserContextId });
    }
  } finally {
    ws.close();
    proc.kill();
  }
}

if (!process.env.VITEST) main().catch((e) => { console.error(e); process.exit(1); });
