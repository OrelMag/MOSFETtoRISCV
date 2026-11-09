// README screenshots and GIFs: the plan (SHOTS) and a runner for them. Each is taken from a build of the site in a fresh browser
// context (nothing stored but what the shot seeds), 1440 × 900 unless it says otherwise, 1x, the site's default theme (no `theme`
// setting), into docs/images/ under the README's name for it. Every image in the README is here but silicon.jpg (a layout render
// with no page around it), so a new header or look is one run.
//
//   node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port <free port> --strictPort
//   node scripts/doom/fetch-wad.mjs --public, and copy public/doom/freedoom* into dist/doom/ (doom.png plays the game)
//   node node_modules/vite-node/vite-node.mjs scripts/readme-shots.ts --url http://localhost:<port>/ [--only sdr,cpu] [--headful]
//
// Written to be read as much as run: `why` says what the picture has to show, `wait` is the condition that the scene is built
// (a big gate-level scene says "building" for seconds), `then` the clicks after it, `dwell` the quiet time after those.
// A GIF (`gif`) is frames of a clip below the top bar, each after its own snippet, encoded by scripts/gif.ts.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { CAMPAIGN_KEY } from '../src/campaign/progress';
import { solveChallenge } from '../src/editor/challenges';
import { EXAMPLES, addExample } from '../src/editor/examples';
import { emptyWorkspace } from '../src/editor/model';
import { KEY as SANDBOX_KEY } from '../src/editor/store';
import { decodePng, encodeGif, type Rgb } from './gif';

const SETTINGS_KEY = 'mosfet2riscv:v1';
// no theme: the default one; the coach-mark tours count as seen so they do not dim the page
const SETTINGS = { coachDone: { stage: true, sandbox: true } };

interface Frame {
  /** Page-side snippet run (and awaited) before the frame is taken. */
  js?: string;
  /** ms to wait after it, before the frame. */
  after: number;
  /** How long the frame shows in the GIF, ms. */
  delay: number;
}

interface Shot {
  name: string; // docs/images/<name>.png, or .gif with `gif`
  route: string; // hash route
  why: string;
  /** Viewport, when not 1440 × 900 (the GIFs are narrower, to stay small). */
  w?: number;
  h?: number;
  /** Settings over SETTINGS (wide: the side panes hidden; speed: slow motion's rate). */
  settings?: Record<string, unknown>;
  storage?: Record<string, string>;
  /** Page-side expression that turns truthy when the scene is built. */
  wait: string;
  /** Page-side snippets run in order after `wait` (each awaited), to open a menu. */
  then?: string[];
  dwell: number;
  /** An animated GIF instead of a PNG: frames of `clip` (page pixels), taken after `then` and `dwell`. */
  gif?: { clip: { x: number; y: number; width: number; height: number }; frames: Frame[] };
}

/** A scene is built when the progress card is gone and the stage has drawn its SVG. */
const BUILT = `!document.querySelector('.load-bar, .load-phases') && document.querySelector('#view .stage svg.schematic, #view svg.schematic')`;
/** The page has settled into a route: no route or scene progress shown, and the main view has content. */
const SHOWN = `!document.querySelector('.route-loading, .load-bar, .load-phases') && document.querySelector('#view')?.childElementCount`;

/** Page-side: click the first visible button (or role=button) whose text or aria-label is `name`; waits up to 20 s for it. */
const press = (name: string, nth = 0) => `(async () => {
  for (let i = 0; i < 80; i++) {
    const all = [...document.querySelectorAll('button, [role=button], a.btn')].filter((x) => (x.innerText || x.getAttribute('aria-label') || '').trim() === ${JSON.stringify(name)} && x.offsetParent && !x.disabled);
    if (all[${nth}]) { all[${nth}].click(); return true; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no button ' + ${JSON.stringify(name)});
})()`;
/** Page-side: wait until the page's text matches `re` (up to `ms`). */
const untilText = (re: string, ms = 60000) => `(async () => {
  for (const t0 = Date.now(); Date.now() - t0 < ${ms};) { if (new RegExp(${JSON.stringify(re)}).test(document.body.innerText)) return true; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error('text ' + ${JSON.stringify(re)} + ' did not appear');
})()`;
const repeat = (n: number, f: Frame): Frame[] => Array.from({ length: n }, () => f);

function sandboxExample(id: string): { storage: Record<string, string>; chip: string } {
  const ex = EXAMPLES.find((e) => e.id === id)!;
  const r = addExample(emptyWorkspace(), ex);
  return { storage: { [SANDBOX_KEY]: JSON.stringify(r.ws) }, chip: r.id };
}
const counter = sandboxExample('counter7');
const computer = sandboxExample('computer');

/** Campaign progress for the map: act 0 to the full adder solved at par, as a learner a few evenings in. */
const UNDER_WAY: Record<string, Record<string, number>> = {
  intro: {}, t_inv: { transistors: 2 }, t_nand: { transistors: 4 }, l_bool: { mistakes: 2 }, n_bin: { mistakes: 2 }, g_not: { nand: 1, depth: 1 },
  g_and: { nand: 2, depth: 2 }, g_or: { nand: 3, depth: 2 }, g_xor: { nand: 4, depth: 3 }, d_kmap: { mistakes: 2 }, g_sop: { nand: 8, depth: 5 },
  g_wide: { nand: 46, depth: 9 }, g_dec: { nand: 30, depth: 5 }, n_twos: { mistakes: 2 }, a_ha: { nand: 5, depth: 3 }, a_fa: { nand: 9, depth: 6 },
};
const progress = JSON.stringify({
  schema: 1,
  nodes: Object.fromEntries(Object.entries(UNDER_WAY).map(([id, best], i) => [id, { seen: true, status: 'solved', at: 1700000000000 + i, ...(id === 'intro' ? {} : { best, stars: 3 }) }])),
});
/** The 4-bit adder level with its reference answer drawn in (the learner's chip u_ch_cp_a_add4 and the full adder it places). */
const add4 = { [CAMPAIGN_KEY]: progress, [SANDBOX_KEY]: JSON.stringify(solveChallenge(emptyWorkspace(), levelChallenge(nodeById('a_add4')!)!).ws) };

export const SHOTS: Shot[] = [
  {
    name: 'sdr', route: '#/c/sdr/8',
    why: 'A DSP chapter: the software radio, step 8 "Turn the dial" (steps are counted from 0: 3 is "The mixer in gates", a gate-level scene, the alternative). The widget draws its plot once the band is synthesized; check by eye that the dial is set on a station and the spectrum shows it.',
    wait: `document.querySelector('#view canvas, #view .widget svg') && !document.querySelector('.route-loading, .load-bar')`, dwell: 3500,
  },
  {
    name: 'cap_tune', route: '#/campaign/play/cap_tune',
    why: 'The DSP capstone Tune it: the brief, the default chain of the radio blocks, its NAND cost, and the practice band with what it decoded. Page top, nothing clicked.',
    storage: { [CAMPAIGN_KEY]: JSON.stringify({ schema: 1, nodes: {}, unlockAll: true }) },
    // the page is ui/pages/tunecap.ts: the chain starts as DEFAULT_CHAIN; Check is left alone: the default chain does not decode the practice band
    wait: `document.querySelector('.tc-chain .tc-block-head') && document.querySelector('.tc-tile')`,
dwell: 2500,
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
    name: 'wirecolours', route: `#/sandbox/${counter.chip}`,
    why: 'The sandbox on the 4-bit counter with a wire\'s right-click menu open at its colour swatches (Auto + the hue row).',
    storage: counter.storage,
    wait: `document.querySelectorAll('#view svg.ed-svg path.wire[data-wire]').length > 3`,
    // right-click (contextmenu) the middle of the longest wire; the menu's colour row is .sb-ctx-hues
    then: [`(async () => {
      // the longest wire whose middle sits in the upper canvas (x 300–900, y 380–430), so the menu opens below it without being pushed under the bar
      const mid = (w) => { const p = w.getPointAtLength(w.getTotalLength() / 2), m = w.getScreenCTM(); return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }; };
      const wires = [...document.querySelectorAll('#view svg.ed-svg path.wire[data-wire]')].filter((w) => { const q = mid(w); return q.x > 300 && q.x < 900 && q.y > 380 && q.y < 430; });
      const w = wires.sort((a, b) => b.getTotalLength() - a.getTotalLength())[0];
      const { x, y } = mid(w);
      w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
      for (let i = 0; i < 40 && !document.querySelector('.sb-ctx-hues'); i++) await new Promise((r) => setTimeout(r, 50));
    })()`],
    dwell: 800,
  },
  // ---- the README's top: drilling down ----
  {
    name: 'drill', route: '#/c/adders/3', w: 1170, h: 860, settings: { wide: true },
    why: 'Drilling from the 4-bit adder into a full adder, into one NAND, down to its four transistors: three frames, one per level, each opened through the route (one history entry per level), panes hidden.',
    wait: BUILT, dwell: 1500,
    gif: {
      clip: { x: 0, y: 56, width: 1170, height: 804 },
      frames: [
        { after: 0, delay: 1700 },
        { js: `location.hash = '#/c/adders/3/fa0'`, after: 1800, delay: 1700 },
        { js: `location.hash = '#/c/adders/3/fa0/g1'`, after: 1800, delay: 2200 },
      ],
    },
  },
  // ---- the journey, a picture per chapter ----
  {
    name: 'relay3d', route: '#/c/relays/0',
    why: 'Prologue P1: the telephone relay in 3D on its physical model, beside its coil current and armature travel.',
    wait: `document.querySelector('#view canvas')`, dwell: 6000,
  },
  {
    name: 'triode3d', route: '#/c/tubes/0',
    why: 'Prologue P2: a 6SN7 section in 3D with its plate curve; the dwell lets the heater warm up so the plate current shows.',
    wait: `document.querySelector('#view canvas')`, dwell: 12000,
  },
  {
    name: 'mosfet', route: '#/c/mosfet/0',
    why: 'The MOSFET cross-section with the gate slider three quarters up: past the threshold, so the channel has formed.',
    wait: `document.querySelector('#view input[type=range]')`,
    then: [`(() => { const r = document.querySelector('#view input[type=range]'); r.value = String(+r.min + (+r.max - +r.min) * 0.75); r.dispatchEvent(new Event('input', { bubbles: true })); })()`],
    dwell: 1200,
  },
  {
    name: 'nand', route: '#/c/nand/0',
    why: 'The CMOS NAND at switch level: four transistors, the inputs and the output\'s value on the wires.',
    wait: BUILT, dwell: 2500,
  },
  {
    name: 'ripple', route: '#/c/adders/4', w: 1000, h: 860, settings: { wide: true, speed: 3 },
    why: 'The 8-bit adder on 0xFF + 0: slow motion on, then cin toggled, and the carry ripples one gate delay at a time (30 frames, 100 ms apart, shown 260 ms each).',
    wait: BUILT, dwell: 1500,
    then: [`(() => { document.querySelector('.slow-btn')?.click(); })()`],
    gif: {
      clip: { x: 0, y: 56, width: 1000, height: 804 },
      frames: [
        { after: 300, delay: 260 },
        { js: `(() => { const g = document.querySelector('g[data-pin=cin]'); const t = g.querySelector('.pin-knob') ?? g; for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(k, { bubbles: true })); })()`, after: 100, delay: 260 },
        ...repeat(29, { after: 100, delay: 260 }),
      ],
    },
  },
  {
    name: 'cpu', route: '#/c/cpu/5',
    why: 'The single-cycle RV32I after Run to halt on Fibonacci: the CPU panel at the halt, matching the golden model.',
    wait: BUILT, then: [press('Run to halt'), untilText('Halted after')], dwell: 2000,
  },
  {
    name: 'python', route: '#/c/python/3',
    why: 'Python on the gate-level CPU, Sum 1..10 well into its loop: Step line until total is 15 (the automatic clock off, so the steps alone set the state); the panel shows the line running, its instructions, cycles and toggles, the variables.',
    settings: { autoClock: false },
    wait: BUILT,
    then: [`(async () => {
      const total = () => /total\\s*s0\\s*(\\d+)/.exec(document.body.innerText)?.[1];
      for (let i = 0; i < 40 && total() !== '15'; i++) { await ${press('Step line')}; await new Promise((r) => setTimeout(r, 700)); }
      if (total() !== '15') throw new Error('total is ' + total());
    })()`],
    dwell: 1500,
  },
  {
    name: 'pipeline', route: '#/c/pipeline/3', w: 1170, h: 860, settings: { wide: true },
    why: 'The five-stage pipeline stepped 14 cycles, a frame a cycle, its diagram filling with forwards and stalls.',
    wait: BUILT, dwell: 2000,
    gif: {
      clip: { x: 0, y: 56, width: 1170, height: 804 },
      frames: [{ after: 0, delay: 800 }, ...repeat(14, { js: press('Step'), after: 500, delay: 800 })],
    },
  },
  {
    name: 'cache', route: '#/c/cache/8',
    why: 'The cache explorer on the column-major matrix sum, played To the end: the hit rate and the 3C misses.',
    wait: SHOWN, then: [press('To the end')], dwell: 2500,
  },
  {
    name: 'ooo', route: '#/c/ooo/11',
    why: 'The out-of-order core on bubble sort, stepped 22 cycles so the reorder buffer, issue queue and rename table are full.',
    wait: BUILT,
    then: [...Array.from({ length: 22 }, () => `${press('Step')}.then(() => new Promise((r) => setTimeout(r, 150)))`)],
    dwell: 1500,
  },
  {
    name: 'drawpad', route: '#/c/pixels/5',
    why: 'The drawing pad\'s house sent to the gate-level GPU: the screen panel shows it drawn and checked.',
    wait: BUILT, then: [press('Send to the GPU')], dwell: 30000,
  },
  {
    name: 'dram', route: '#/c/dram/1',
    why: 'The 4 × 4 DRAM array at switch level, each cell\'s charge drawn.',
    wait: BUILT, dwell: 3000,
  },
  {
    name: 'ping', route: '#/c/network/8',
    why: 'Two computers and a switch in gates: Run until console A shows the echo reply, the frames at the switch listed.',
    wait: BUILT,
    then: [press('Run'), `(async () => { for (let i = 0; i < 120; i++) { const t = document.body.innerText.split('CONSOLE A')[1]?.slice(0, 200) ?? ''; if (/(reply|bytes from|time=)/i.test(t)) return; await new Promise((r) => setTimeout(r, 1000)); } throw new Error('no reply'); })()`],
    dwell: 3000,
  },
  {
    name: 'eye', route: '#/c/serial/5',
    why: 'The eye diagram with its rate, bandwidth and noise sliders and the computed eye height and error rate.',
    wait: SHOWN, dwell: 3000,
  },
  {
    name: 'enigma', route: '#/c/secret/0',
    why: 'The Enigma M4 in 3D, lid open, its parts labelled.',
    wait: `document.querySelector('#view canvas')`, dwell: 5000,
  },
  {
    name: 'wifi', route: '#/c/wifi/3',
    why: 'Three stations in gates, the hidden terminal: Run for nine seconds so the two hidden stations\' frames overlap on the timeline.',
    wait: BUILT, then: [press('Run')], dwell: 9000,
  },
  {
    name: 'path', route: '#/c/path/5',
    why: 'One packet, all the way: the table of every hop with its light, bits, queue and engine delays.',
    wait: SHOWN, dwell: 3000,
  },
  {
    name: 'bench', route: '#/c/bench/6',
    why: 'The expert\'s bench on Case A: the report, link budget, access point counters, sniffer list and the four causes.',
    wait: SHOWN, then: [press('Case A')], dwell: 1000,
  },
  {
    name: 'm6502', route: '#/c/appendix-6502/6',
    why: 'The NMOS 6502 at transistor level after a few seconds of Run, its bus cycles listed.',
    wait: BUILT, then: [press('Run')], dwell: 2500,
  },
  {
    name: 'doom', route: '#/c/appendix-doom/3',
    why: 'Doom on the RV32IM, playing Freedoom (served from dist/doom/, see the header) for 45 s: the demo loop on screen, the live profile and instruction mix.',
    wait: SHOWN, then: [press('Play Freedoom (29 MB)')], dwell: 45000,
  },
  // ---- the campaign ----
  {
    name: 'campaign', route: '#/campaign',
    why: 'The campaign map with the first acts under way (UNDER_WAY: act 0 to the full adder solved, three stars each).',
    storage: { [CAMPAIGN_KEY]: progress }, wait: `document.querySelector('#view svg')`, dwell: 2500,
  },
  {
    name: 'level', route: '#/campaign/play/a_add4',
    why: 'The 4-bit adder level with its answer drawn, after Check: passed at par, the alternatives and its copies in the finished CPU.',
    storage: add4, wait: `document.querySelector('#view svg.ed-svg')`, then: [press('Check')], dwell: 2500,
  },
  // ---- the sandbox ----
  {
    name: 'sandbox', route: `#/sandbox/${counter.chip}`, w: 1280, h: 860,
    why: 'The 4-bit counter on its 7-segment digit, counting at the automatic clock: 16 frames 380 ms apart.',
    storage: counter.storage, wait: `document.querySelectorAll('#view svg.ed-svg path.wire[data-wire]').length > 3`,
    then: [press('Fit to screen')], dwell: 400,
    gif: { clip: { x: 0, y: 56, width: 1280, height: 804 }, frames: repeat(16, { after: 380, delay: 500 }) },
  },
  {
    name: 'computer', route: `#/sandbox/${computer.chip}`,
    why: 'Examples ▸ Computer after Run to halt: the core, ROM, memory side, the 64 × 64 screen\'s picture and the devices, with the CPU drawer.',
    storage: computer.storage, wait: `document.querySelectorAll('#view svg.ed-svg path.wire[data-wire]').length > 3`,
    then: [press('Run to halt')], dwell: 25000,
  },
  {
    name: 'hall', route: '#/c/silicon/8',
    why: 'The single-cycle RV32I as racks of relays in a machine hall, a person for scale.',
    wait: SHOWN, dwell: 6000,
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
  const names = only?.split(',');
  const failed: string[] = [];
  try {
    for (const shot of SHOTS.filter((s) => !names || names.includes(s.name))) {
      const { browserContextId } = await send('Target.createBrowserContext');
      try {
        const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const page = (m: string, p: object = {}) => send(m, p, sessionId);
        const evalJs = async (expression: string) => {
          const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(`${shot.name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
          return r.result?.value;
        };
        const w = shot.w ?? 1440, h = shot.h ?? 900;
        await page('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await page('Page.enable');
        // the settings and the shot's storage are in place before the app starts
        const seed = { [SETTINGS_KEY]: JSON.stringify({ ...SETTINGS, ...(shot.settings ?? {}) }), ...(shot.storage ?? {}) };
        await page('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason)));
          try { for (const [k, v] of Object.entries(${JSON.stringify(seed)})) localStorage.setItem(k, v); } catch {}` });
        await page('Page.navigate', { url: new URL(shot.route, url).href.replace('%23', '#') });
        for (let i = 0; i < 240 && !(await evalJs(`Boolean(${shot.wait})`)); i++) await sleep(250);
        if (!(await evalJs(`Boolean(${shot.wait})`))) throw new Error(`${shot.name}: the scene was not built within 60 s`);
        for (const step of shot.then ?? []) await evalJs(step);
        await sleep(shot.dwell);
        let file: string;
        if (shot.gif) {
          const frames: Rgb[] = [];
          for (const f of shot.gif.frames) {
            if (f.js) await evalJs(f.js);
            await sleep(f.after);
            const { data } = await page('Page.captureScreenshot', { format: 'png', clip: { ...shot.gif.clip, scale: 1 } });
            frames.push(decodePng(Buffer.from(data, 'base64')));
          }
          file = `${shot.name}.gif`;
          writeFileSync(new URL(`../docs/images/${file}`, import.meta.url), encodeGif(frames, shot.gif.frames.map((f) => f.delay)));
        } else {
          const { data } = await page('Page.captureScreenshot', { format: 'png' });
          file = `${shot.name}.png`;
          writeFileSync(new URL(`../docs/images/${file}`, import.meta.url), Buffer.from(data, 'base64'));
        }
        const errs: string[] = await evalJs('window.__errs');
        console.log(`${shot.name}: docs/images/${file}${errs.length ? `  page errors: ${errs.slice(0, 3).join(' | ')}` : ''}`);
      } catch (e) {
        failed.push(shot.name);
        console.error(String(e));
      } finally {
        await send('Target.disposeBrowserContext', { browserContextId });
      }
    }
  } finally {
    ws.close();
    proc.kill();
  }
  if (failed.length) throw new Error(`not taken: ${failed.join(', ')}`);
}

if (!process.env.VITEST) main().catch((e) => { console.error(e); process.exit(1); });
