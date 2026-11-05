// Browser smoke test: every route of a production build opened in headless Chrome, failing on any
// runtime error. No dependency: Chrome is launched here and driven over the DevTools Protocol with
// Node's own WebSocket.
//
//   npm run build && npm run smoke                       (starts `vite preview` of dist/ itself)
//   vite-node scripts/smoke.ts --url http://host/sub/     (a site already served)
//   options: --only <substring of the route> ("analogy": the asides opened, figures drawn)  --tabs <n>  --headful  --timeout <s per route>
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
import { ANALOGIES } from '../src/chapters/analogies';
import { families, initialParams } from '../src/lib/resolve';
import { NODES } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { builtCapstones } from '../src/campaign/capstone';
import { COMM_CAPSTONES } from '../src/learn/capstones';
import { TWIN_LEVELS, twinKey } from '../src/campaign/twinids';
import { CAMPAIGN_KEY } from '../src/campaign/progress';
import { CODEX } from '../src/campaign/codex';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { emptyWorkspace } from '../src/editor/model';
import { KEY as SANDBOX_KEY } from '../src/editor/store';
import { NOTES_KEY } from '../src/ui/notes';
import { LEARN_KEY } from '../src/learn/store';
import { REVIEW_KEY } from '../src/ui/review';

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
// CPU slowdown factor (Emulation.setCPUThrottlingRate): a slow phone's load takes long enough for the service worker to install mid-route.
const throttle = Number(opt('throttle') ?? 1);
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
  /** A page script run once the page is idle (awaited; returns the problems it found, as strings), then the page settles again. */
  drive?: string;
}

interface Viewport { width: number; height: number; mobile: boolean; name: string; /** a touch screen: `pointer: coarse` is true (Emulation.setTouchEmulationEnabled), which mobile emulation alone does not do */ touch?: boolean }
const VIEWPORTS: Viewport[] = [
  { width: 1280, height: 800, mobile: false, name: '1280px' },
  { width: 390, height: 844, mobile: true, name: '390px phone' },
];

// Touch screens: the (pointer: coarse) rules (40 px targets, the touch wording) apply only here. 390 and 360 px are the phones the top bar is fitted for.
const TOUCH_VIEWPORTS: Viewport[] = [
  { width: 390, height: 844, mobile: true, touch: true, name: '390px touch phone' },
  { width: 360, height: 740, mobile: true, touch: true, name: '360px touch phone' },
];

const SETTINGS_KEY = 'mosfet2riscv:v1';
// the coach-mark tours (ui/coachmarks.ts) count as seen, so they do not dim every page; two routes below play them
const themed = (theme: 'light' | 'dark') => ({ [SETTINGS_KEY]: JSON.stringify({ theme, coachDone: { stage: true, sandbox: true } }) });
const firstRun = (theme: 'light' | 'dark') => ({ [SETTINGS_KEY]: JSON.stringify({ theme }) });
const light = themed('light');
const unlocked = { ...light, [CAMPAIGN_KEY]: JSON.stringify({ schema: 1, nodes: {}, unlockAll: true }) };

/** A few notes and bookmarks, and a review history over chapters marked visited: the My notes page with something to show. */
function notesStorage(theme: 'light' | 'dark'): Record<string, string> {
  const c0 = chapters[0], c1 = chapters[1];
  const at = 1_700_000_000_000;
  const item = (id: string, o: object) => [id, { id, at, edited: at, title: '', text: '', ...o }];
  const items = Object.fromEntries([
    item('n:a', { type: 'note', place: { kind: 'step', chapter: c1.id, step: 0 }, text: 'The first note, on a step.', pin: { path: [], inst: 'nothere', inputs: { a: 1 }, cycle: 2 } }),
    item('n:b', { type: 'note', place: { kind: 'step', chapter: c0.id, step: 1 }, text: 'A second note with a longer text. '.repeat(8) }),
    item('bm:c', { type: 'bookmark', place: { kind: 'bench', id: 'rca4' }, title: 'Workbench · rca4' }),
    item('bm:d', { type: 'bookmark', place: { kind: 'chip', id: 'gone' }, title: 'Sandbox · my_alu' }),
  ]);
  const review: Record<string, object> = {};
  const quiz = c1.steps.findIndex((st) => st.challenge?.kind === 'quiz');
  if (quiz >= 0) review[`${c1.id}:${quiz}`] = { n: 1, last: at, miss: true, missed: at, streak: 0, due: at };
  return {
    [SETTINGS_KEY]: JSON.stringify({ theme, coachDone: { stage: true, sandbox: true }, visited: { [c0.id]: [0, 1], [c1.id]: [0] } }),
    [NOTES_KEY]: JSON.stringify({ schema: 1, items }),
    [REVIEW_KEY]: JSON.stringify({ schema: 1, memos: review }),
  };
}

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

/** Opens File ▸ Memory map…, checks the windows, the three views and that the dialog fits, closes it with Esc. */
const MEMMAP_DRIVE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bad = [];
  const file = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().replace(/ ▾$/, '') === 'File');
  if (!file) return ['no File button'];
  file.click(); await wait(200);
  const item = [...document.querySelectorAll('.sb-menu button')].find((b) => /Memory map/.test(b.textContent));
  if (!item) return ['no Memory map item in the File menu'];
  if (item.disabled) return ['Memory map is disabled on a chip with a bus'];
  item.click(); await wait(1500);
  const dlg = document.querySelector('.mp-dlg');
  if (!dlg) return ['the dialog did not open'];
  if (dlg.querySelectorAll('.mp-row[data-n]').length !== 16) bad.push('expected 16 windows');
  if (dlg.querySelectorAll('.mp-bar[data-i]').length !== 6) bad.push('expected 6 regions on System on a bus');
  if (!dlg.querySelector('.mp-apply[disabled]')) bad.push('Apply should be disabled with nothing changed');
  const panel = dlg.querySelector('.panel').getBoundingClientRect();
  if (panel.right > innerWidth + 1 || panel.left < -1) bad.push('the dialog is wider than the screen');
  dlg.querySelector('.mp-bar').click(); await wait(100);
  if (!dlg.querySelector('#mp-base')) bad.push('selecting a region shows no base field');
  for (const name of ['Decoder', 'Export', 'Map']) {
    [...dlg.querySelectorAll('.mp-tab')].find((b) => b.textContent === name).click(); await wait(300);
    if (name === 'Decoder' && !dlg.querySelector('.mp-table')) bad.push('no decoder table');
    if (name === 'Export' && dlg.querySelectorAll('.mp-export pre').length !== 2) bad.push('export previews missing');
  }
  dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(100);
  if (document.querySelector('.mp-dlg')) bad.push('Esc did not close the dialog');
  return bad;
})()`;

/**
 * A touch screen's own gestures on the sandbox canvas, from pointer events with pointerType 'touch' (what the
 * browser sends for a finger; the real devices are not here): a press and hold opens the right-click menu once and
 * Esc closes it, a tap and a press that strays do not; a part armed from the Parts drawer shows its pill and Cancel
 * lets it go; a wire begun from a pin shows the same pill. (ui/holdpress.ts, editor/tools.ts.)
 */
const TOUCH_DRIVE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bad = [];
  const svg = document.querySelector('svg.ed-svg');
  if (!svg) return ['no canvas'];
  // synthetic pointers are not active ones: the canvas may not capture them
  svg.setPointerCapture = () => {}; svg.releasePointerCapture = () => {}; svg.hasPointerCapture = () => false;
  const ptr = (el, type, x, y, id = 71) => el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const r = svg.getBoundingClientRect();
  let at = null;
  for (let y = r.top + 20; y < r.bottom - 20 && !at; y += 24) for (let x = r.left + 20; x < r.right - 20; x += 24) {
    const e = document.elementFromPoint(x, y);
    if (e && svg.contains(e) && !e.closest('[data-part], [data-wire], [data-pin-id], [data-label], .ed-ptr')) { at = [x, y]; break; }
  }
  if (!at) return ['no empty canvas to hold on'];
  const menu = () => document.querySelector('.sb-ctx');
  ptr(svg, 'pointerdown', at[0], at[1]); await wait(250); ptr(svg, 'pointerup', at[0], at[1]); await wait(100);
  if (menu()) bad.push('a tap opened the menu');
  ptr(svg, 'pointerdown', at[0], at[1]); await wait(250); ptr(svg, 'pointermove', at[0] + 30, at[1]); await wait(450); ptr(svg, 'pointerup', at[0] + 30, at[1]); await wait(100);
  if (menu()) bad.push('a press that strayed opened the menu');
  ptr(svg, 'pointerdown', at[0], at[1]); await wait(750);
  const m = menu();
  if (!m) bad.push('a press and hold opened no menu');
  else {
    const labels = [...m.querySelectorAll('button')].map((b) => b.textContent);
    if (!labels.some((l) => /Add a pointer here/.test(l))) bad.push('the menu is not the canvas menu: ' + labels.join(' | ').slice(0, 80));
    if (document.querySelectorAll('.sb-ctx').length !== 1) bad.push('more than one menu');
    for (const b of m.querySelectorAll('button')) if (b.getBoundingClientRect().height < 39.5) { bad.push('a menu item under 40 px: ' + b.textContent); break; }
  }
  ptr(svg, 'pointerup', at[0], at[1]); await wait(100);
  if (!menu()) bad.push('lifting the finger closed the menu');
  (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(100);
  if (menu()) bad.push('Esc did not close the menu');
  // a part armed from the drawer, and let go with Cancel
  document.querySelector('.sb-parts-btn')?.click(); await wait(300);
  const item = document.querySelector('.sb-item[data-item="basics/nand"]');
  if (!item) bad.push('no NAND in the parts drawer');
  else {
    const q = item.getBoundingClientRect();
    ptr(item, 'pointerdown', q.left + 10, q.top + 10); ptr(item, 'pointerup', q.left + 10, q.top + 10); await wait(700);
    const pill = document.querySelector('.sb-mode:not([hidden])');
    if (!pill || !/NAND/.test(pill.textContent)) bad.push('an armed part shows no pill');
    else {
      const c = pill.querySelector('.sb-mode-cancel');
      if (c.getBoundingClientRect().height < 39.5) bad.push('Cancel under 40 px');
      c.click(); await wait(200);
      if (document.querySelector('.sb-mode:not([hidden])')) bad.push('Cancel left the pill');
    }
  }
  // an input pin placed by two taps, then flipped by a tap on its knob and by its switch under the canvas
  document.querySelector('.sb-parts-btn')?.click(); await wait(300);
  const pin = document.querySelector('.sb-item[data-item="basics/in1"]');
  if (!pin) return [...bad, 'no input pin in the parts drawer'];
  const q = pin.getBoundingClientRect();
  ptr(pin, 'pointerdown', q.left + 10, q.top + 10); ptr(pin, 'pointerup', q.left + 10, q.top + 10); await wait(700);
  ptr(svg, 'pointerdown', at[0], at[1]); ptr(svg, 'pointerup', at[0], at[1]); await wait(400);
  const knob = svg.querySelector('[data-pin-id] circle');
  const tog = () => document.querySelector('.in-toggle')?.className;
  if (!knob || !tog()) return [...bad, 'tapping the canvas with an armed pin placed none'];
  const k = knob.getBoundingClientRect(), v0 = tog();
  ptr(svg, 'pointerdown', k.left + k.width / 2, k.top + k.height / 2); ptr(svg, 'pointerup', k.left + k.width / 2, k.top + k.height / 2); await wait(300);
  if (tog() === v0) bad.push('a tap on a pin's knob did not flip the input');
  const v1 = tog();
  document.querySelector('.in-toggle').click(); await wait(200);
  if (tog() === v1) bad.push('the switch under the canvas did not flip the input');
  return bad;
})()`;

/**
 * The stage on a touch screen: a tap on an input pin flips it, a press and hold on a wire opens the layout menu
 * (the stage's right-click), a tap does not.
 */
const STAGE_TOUCH_DRIVE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bad = [];
  const svg = document.querySelector('svg.schematic');
  if (!svg) return ['no stage'];
  svg.setPointerCapture = () => {}; svg.releasePointerCapture = () => {}; svg.hasPointerCapture = () => false; // synthetic pointers are not active ones
  const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 81, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const centre = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const pin = svg.querySelector('g.pin-in');
  if (!pin) return ['no input pin on the stage'];
  const v0 = pin.getAttribute('class'), [px, py] = centre(pin);
  ptr(pin, 'pointerdown', px, py); ptr(pin, 'pointerup', px, py); pin.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: px, clientY: py })); await wait(300);
  if (pin.getAttribute('class') === v0) bad.push('a tap on an input pin did not flip it');
  let wire = null;
  for (const e of svg.querySelectorAll('path[data-net]')) {
    const r = e.getBoundingClientRect();
    if (r.width < 30 && r.height < 30) continue;
    const L = e.getTotalLength(), pt = e.getPointAtLength(L / 2), m = e.getScreenCTM();
    wire = [e, pt.x * m.a + pt.y * m.c + m.e, pt.x * m.b + pt.y * m.d + m.f];
    break;
  }
  if (!wire) return [...bad, 'no wire to hold on'];
  ptr(wire[0], 'pointerdown', wire[1], wire[2]); await wait(250); ptr(wire[0], 'pointerup', wire[1], wire[2]); await wait(100);
  if (document.querySelector('.sch-menu')) bad.push('a tap opened the layout menu');
  ptr(wire[0], 'pointerdown', wire[1], wire[2]); await wait(750);
  const m = document.querySelector('.sch-menu button');
  if (!m) bad.push('a press and hold on a wire opened no layout menu');
  else if (m.getBoundingClientRect().height < 39.5) bad.push('a layout menu item under 40 px');
  ptr(wire[0], 'pointerup', wire[1], wire[2]); await wait(100);
  if (!document.querySelector('.sch-menu')) bad.push('lifting the finger closed the layout menu');
  return bad;
})()`;

/**
 * Opens the Examples gallery (behind More on a phone), checks a card per example, that the search filters and says so when nothing
 * matches, that the arrows move between the cards, that every thumbnail loads (scrolled into view), and that Esc closes the
 * dialog and gives the focus back to the button it came from.
 */
const GALLERY_DRIVE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bad = [];
  const vis = (b) => b && !b.hidden && b.offsetParent !== null;
  const find = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t && vis(b));
  let opener = find('Examples');
  if (!opener) {
    const more = document.querySelector('button.sb-more');
    if (!more || !vis(more)) return ['no Examples button and no More button'];
    more.click(); await wait(200);
    opener = [...document.querySelectorAll('.sb-more-menu button')].find((b) => /^Examples/.test(b.textContent.trim()));
    if (!opener) return ['no Examples item in More'];
  }
  opener.click(); await wait(1500);
  const dlg = document.querySelector('.ex-gallery');
  if (!dlg) return ['the gallery did not open'];
  const search = dlg.querySelector('.ex-search');
  if (document.activeElement !== search) bad.push('the search box is not focused on open');
  const shown = () => [...dlg.querySelectorAll('.ex-card')].filter((c) => !c.hidden);
  if (dlg.querySelectorAll('.ex-card').length !== ${EXAMPLES.length}) bad.push('expected ${EXAMPLES.length} cards');
  const panel = dlg.querySelector('.panel').getBoundingClientRect();
  if (panel.right > innerWidth + 1 || panel.left < -1) bad.push('the gallery is wider than the screen');
  const set = (v) => { search.value = v; search.dispatchEvent(new Event('input', { bubbles: true })); };
  set('pong'); await wait(100);
  if (shown().length !== 1 || shown()[0].dataset.example !== 'rv16pong') bad.push('searching "pong" should leave only the RV16 Pong card');
  if ([...dlg.querySelectorAll('.ex-group')].filter((g) => !g.hidden).length !== 1) bad.push('a section with no match stays visible');
  set('zzzz nothing'); await wait(100);
  if (shown().length || !/No example matches/.test(dlg.querySelector('.ex-empty').textContent)) bad.push('no "nothing matches" message');
  set(''); await wait(100);
  if (shown().length !== ${EXAMPLES.length}) bad.push('clearing the search should bring every card back');
  // every thumbnail loads: scroll each card into view (they load lazily), then none may be broken or missing
  for (const c of dlg.querySelectorAll('.ex-card')) { c.scrollIntoView({ block: 'center' }); await wait(60); }
  await wait(500);
  for (const img of dlg.querySelectorAll('.ex-thumb img')) if (!img.complete || !img.naturalWidth) bad.push('thumbnail ' + img.getAttribute('src') + ' did not load');
  search.focus();
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(50);
  if (document.activeElement !== shown()[0]) bad.push('ArrowDown from the search box should focus the first card');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await wait(50);
  if (document.activeElement !== shown()[1]) bad.push('ArrowRight should focus the next card');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(150);
  if (document.querySelector('.ex-gallery')) bad.push('Esc did not close the gallery');
  const back = document.activeElement;
  if (!back || !/Examples/.test(back.textContent) && !back.classList.contains('sb-more')) bad.push('Esc should give the focus back to the Examples button (or More)');
  return bad;
})()`;

/**
 * Opens every Analogy aside on the step (a figure loads and mounts when its aside opens), turns on the Water | Cross-section
 * views of the step's widget, and waits for the figures to draw; a figure that stays empty or says it could not load is a problem.
 */
const ANALOGY_DRIVE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bad = [];
  const asides = [...document.querySelectorAll('details.analogy')];
  if (!asides.length) return ['no Analogy aside on the step'];
  for (const d of asides) d.open = true;
  for (const b of document.querySelectorAll('.wt-seg button')) if (b.textContent.trim() === 'Water') b.click();
  for (let i = 0; i < 40; i++) {
    await wait(250);
    if ([...document.querySelectorAll('.analogy-fig')].every((f) => f.firstChild && !/Loading/.test(f.textContent)) && !document.querySelector('.wt-host')?.textContent.includes('Loading')) break;
  }
  for (const f of document.querySelectorAll('.analogy-fig')) {
    if (!f.firstChild) bad.push('an analogy figure did not draw');
    else if (/could not load/.test(f.textContent)) bad.push('an analogy figure could not load');
  }
  for (const h of document.querySelectorAll('.wt-host')) if (/did not load/.test(h.textContent)) bad.push('a water view did not load');
  await wait(400);
  return bad;
})()`;
/**
 * Print this chapter (ui/pages/print.ts): waits for the figures, then checks that every one drew (an SVG on a white board, none
 * left waiting), that the dialog was asked for exactly once (window.print is stubbed for every route: see visit()), and that a
 * wrong theme did not leak into the sheet (the page behind keeps the learner's own).
 */
const PRINT_DRIVE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bad = [];
  const page = document.querySelector('.print-view');
  if (!page) return ['no print view'];
  for (let i = 0; i < 120 && page.dataset.printReady !== 'yes'; i++) await wait(250);
  if (page.dataset.printReady !== 'yes') return ['the print view never finished building'];
  const figs = [...page.querySelectorAll('.pd-fig-body')];
  if (figs.length < 3) bad.push('only ' + figs.length + ' figures');
  for (const f of figs) {
    if (!f.querySelector('svg')) bad.push('a figure is not drawn: ' + f.textContent.trim().slice(0, 80));
    else if (f.querySelector('svg').getBoundingClientRect().width < 20) bad.push('a figure is collapsed');
  }
  if (page.querySelector('.pd-wait')) bad.push('a figure is still waiting');
  if (window.__printed !== 1) bad.push('window.print was called ' + window.__printed + ' times');
  if (!page.querySelector('.pd-q') || !page.querySelector('.pd-answers li')) bad.push('no questions and answers');
  if (document.querySelector('.topbar') && document.documentElement.getAttribute('data-palette') === 'print') bad.push('the figures left <html> in the paper palette');
  return bad;
})()`;

/**
 * Chapter 50's two-computer scene: Run until two frames are in the capture list, pick one, and check that the button follows the loop (Pause while it
 * runs, Run after) and that the capture list, the frame's hex dump and the cost table each scroll inside their own container: none may widen the page.
 */
const NET_DRIVE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bad = [];
  const btn = () => document.querySelector('.mem-panel.net-w .mc-row button');
  const run = btn();
  if (!run) return ['no Run button'];
  run.click();
  for (let i = 0; i < 200 && document.querySelectorAll('.net-frames tr[role="row"]').length < 2; i++) await wait(200);
  const rows = document.querySelectorAll('.net-frames tr[role="row"]');
  if (rows.length < 2) return ['fewer than two frames listed after 40 s (' + (document.querySelector('.mc-status')?.textContent ?? 'no readout') + ')'];
  rows[1].click(); await wait(200);
  if (btn().textContent.trim() !== 'Pause') bad.push('the button should say Pause while the loop runs');
  btn().click(); await wait(300);
  if (btn().textContent.trim() !== 'Run') bad.push('the button should say Run after Pause');
  const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1) bad.push('the page is wider than the window');
  for (const w of document.querySelectorAll('.net-wide, .net-dump')) if (w.getBoundingClientRect().right > W + 1) bad.push('a table or dump runs past the window');
  return bad;
})()`;

function routes(): Route[] {
  const out: Route[] = [];
  const add = (hash: string, storage: Record<string, string>, note = '', viewport?: Viewport, drive?: string) => out.push({ hash, storage, label: hash + note, viewport, drive });
  add('#/', light);
  add('#/', themed('dark'), ' (dark)');
  for (const theme of ['light', 'dark'] as const) {
    for (const c of chapters) {
      c.steps.forEach((_, i) => add(`#/c/${c.id}/${i}`, themed(theme), theme === 'dark' ? ' (dark)' : ''));
      // the recap, one past the last step
      if (c.recap) add(`#/c/${c.id}/${c.steps.length}`, themed(theme), theme === 'dark' ? ' (dark)' : '');
    }
  }
  // Every analogy that has a figure, or whose step has a Water view, with its aside open (ANALOGY_DRIVE), and the two Water-view
  // steps and a figure on a phone.
  const phoneVp = VIEWPORTS.find((v) => v.mobile)!;
  const analogySteps = ANALOGIES.flatMap((a) => {
    const ci = chapters.findIndex((c) => c.id === a.chapter), si = chapters[ci]?.steps.findIndex((st) => st.title === a.step) ?? -1;
    return si < 0 ? [] : [{ hash: `#/c/${a.chapter}/${si}`, water: !a.figure, chapter: a.chapter }];
  });
  for (const a of analogySteps) add(a.hash, light, ' (analogy open)', undefined, ANALOGY_DRIVE);
  for (const a of analogySteps.filter((x) => x.water || x.chapter === 'cache')) add(a.hash, light, ` (analogy open, ${phoneVp.name})`, phoneVp, ANALOGY_DRIVE);
  // The default of every workbench family (what the family picker opens first).
  for (const f of families) add(`#/workbench/${f.key(initialParams(f))}`, light);
  add('#/workbench/stats', light);
  add('#/workbench/bench', light);
  add('#/workbench/lab', light);
  // A line opened: its model's panel, not a schematic (widgets/modelleaf.ts).
  for (const [id, title] of [['serial', 'A SerDes in gates'], ['modem', 'FSK in gates']]) {
    const c = chapters.find((x) => x.id === id);
    const i = c?.steps.findIndex((st) => st.title === title) ?? -1;
    if (i < 0) continue;
    add(`#/c/${id}/${i}/line`, light, ' (the line opened)');
    add(`#/c/${id}/${i}/line`, themed('dark'), ' (the line opened, dark)');
    add(`#/c/${id}/${i}/line`, light, ` (the line opened, ${phoneVp.name})`, phoneVp);
  }
  add('#/campaign', light);
  add('#/campaign/intro', light);
  add('#/campaign/codex', unlocked);
  for (const e of CODEX) add(`#/campaign/codex/${e.id}`, unlocked);
  // The analogy index, every aside opened (each figure loads), and on a phone.
  add('#/campaign/codex/analogies', unlocked, ' (analogies open)', undefined, ANALOGY_DRIVE);
  add('#/campaign/codex/analogies', unlocked, ` (${phoneVp.name})`, phoneVp);
  for (const n of NODES) {
    add(`#/campaign/play/${n.id}`, unlocked);
    // Lessons, drills and programs open on the map instead (pages/level.ts levelRoute).
    if (!levelChallenge(n) || n.soon) add(`#/campaign/n/${n.id}`, unlocked);
  }
  // The tier capstones (campaign/capstone.ts), on the level screen's layout
  for (const c of builtCapstones()) add(`#/campaign/play/${c.id}`, light);
  for (const c of COMM_CAPSTONES) if (c.route) add(c.route, light);
  // The Verilog twins (campaign/twinids.ts): the source beside the check, never synthesized here (Yosys is 78 MB)
  for (const l of TWIN_LEVELS) add(`#/campaign/play/${twinKey(l)}`, unlocked);
  // A locked level renders its notice (fresh progress: only the first levels are open).
  add(`#/campaign/play/${NODES[NODES.length - 1].id}`, light, ' (locked)');
  add('#/sandbox', light);
  // Print this chapter: the gates chapter's figures and truth tables, from the dark theme (the sheet is paper whatever the theme) and on a phone.
  const printCh = chapters.find((c) => c.id === 'gates') ?? chapters[1];
  add(`#/c/${printCh.id}/print`, themed('dark'), ' (dark)', undefined, PRINT_DRIVE);
  add(`#/c/${printCh.id}/print`, light, ` (${VIEWPORTS[VIEWPORTS.length - 1].name})`, VIEWPORTS[VIEWPORTS.length - 1], PRINT_DRIVE);
  // The first-run coach marks over a chapter step, the workbench and the sandbox, in both themes and on a phone.
  for (const theme of ['light', 'dark'] as const) {
    for (const hash of [`#/c/${chapters[1].id}/0`, '#/workbench/rca4', '#/sandbox']) add(hash, firstRun(theme), ` (first run, ${theme})`);
  }
  add(`#/c/${chapters[1].id}/0`, firstRun('light'), ' (first run, phone)', VIEWPORTS[VIEWPORTS.length - 1]);
  // Where are you starting? and My path: fresh, and with a start, a test-out and some progress, in both themes and on a phone
  add('#/start', light);
  add('#/path', light, ' (fresh)');
  for (const theme of ['light', 'dark'] as const) add('#/path', { ...notesStorage(theme), [LEARN_KEY]: JSON.stringify({ schema: 1, start: { persona: 'software', tier: 1, at: 1_700_000_000_000 }, tested: { [chapters[0].id]: 1_700_000_000_000 } }) }, ` (started, ${theme})`);
  add('#/', { ...light, [LEARN_KEY]: JSON.stringify({ schema: 1, start: { persona: 'new', tier: 0, at: 1_700_000_000_000 }, tested: {} }) }, ' (with a path)');
  // My notes: empty, then with notes, bookmarks and a review history, in both themes and on a phone
  add('#/notes', light, ' (empty)');
  add('#/notes', notesStorage('light'));
  add('#/notes', notesStorage('dark'), ' (dark)');
  add('#/', notesStorage('light'), ' (with notes)');
  add(`#/c/${chapters[1].id}/0`, notesStorage('light'), ' (with a note)');
  // The phone top bar (ui/navfit.ts) with touch on, where the coarse-pointer rules make it tightest: no caption cut, no overflow.
  for (const v of TOUCH_VIEWPORTS) {
    for (const hash of ['#/', `#/c/${chapters[1].id}/0`, '#/workbench/rca4', '#/campaign', '#/sandbox']) add(hash, light, ` (${v.name})`, v);
    add('#/sandbox', notesStorage('dark'), ` (${v.name}, with notes, dark)`, v);
  }
  // No horizontal overflow on one page of each kind, on a desktop and on a phone.
  for (const v of VIEWPORTS) {
    for (const hash of ['#/', `#/c/${chapters[1].id}/0`, '#/workbench/rca4', '#/campaign', '#/sandbox']) add(hash, light, ` (${v.name})`, v);
    add('#/notes', notesStorage('light'), ` (${v.name})`, v);
    add('#/path', notesStorage('light'), ` (${v.name})`, v);
    add('#/start', light, ` (${v.name})`, v);
  }
  // Pages whose panels a phone once lost: the GPU screen and drawing pad, the Out of order panel, the level bar.
  const phone = VIEWPORTS.find((v) => v.mobile)!;
  for (const hash of ['#/c/pixels/5', '#/c/graphics/1', '#/c/ooo/8']) add(hash, light, ` (${phone.name})`, phone);
  // Chapter 50: the field tables and the cost table on a phone, and the two-computer scene running with a capture listed.
  const net = chapters.find((c) => c.id === 'network');
  if (net) {
    const stepOf = (t: string) => net.steps.findIndex((st) => st.title === t);
    for (const t of ['Registers and rings', 'ARP: IP address to MAC address', 'The cost of a packet']) add(`#/c/network/${stepOf(t)}`, light, ` (${phone.name})`, phone);
    for (const v of [undefined, phone]) add(`#/c/network/${stepOf('Ping across the wire')}`, light, ` (running${v ? ', ' + v.name : ''})`, v, NET_DRIVE);
  }
  add(`#/campaign/play/${NODES.find((n) => n.kind === 'core')!.id}`, unlocked, ` (${phone.name})`, phone);
  // The sandbox's toolbar at the common desktop widths too (CLIPPED: no label cut, nothing scrolled out of view).
  for (const width of [1440, 1920]) add('#/sandbox', light, ` (${width}px)`, { width, height: 900, mobile: false, name: `${width}px` });
  // The Examples gallery, opened from the toolbar (More on a phone), in both themes.
  for (const theme of ['light', 'dark'] as const) add('#/sandbox', themed(theme), ` (examples gallery, ${theme})`, undefined, GALLERY_DRIVE);
  add('#/sandbox', light, ` (examples gallery, ${phoneVp.name})`, phoneVp, GALLERY_DRIVE);
  const ex = examplesWorkspace();
  for (const id of ex.ids) add(`#/sandbox/${id}`, { ...light, [SANDBOX_KEY]: ex.json });
  add('#/sandbox', light, ` (${TOUCH_VIEWPORTS[0].name}: hold, cancel, tap a pin)`, TOUCH_VIEWPORTS[0], TOUCH_DRIVE);
  add('#/workbench/xor', light, ` (${TOUCH_VIEWPORTS[0].name}: tap a pin, hold a wire)`, TOUCH_VIEWPORTS[0], STAGE_TOUCH_DRIVE);
  // The memory-map designer on System on a bus, opened from File, in both themes.
  for (const [theme, viewport] of [['light', undefined], ['dark', undefined]] as const) {
    add(`#/sandbox/${ex.ids[EXAMPLES.findIndex((e) => e.id === 'bussystem')]}`, { ...themed(theme), [SANDBOX_KEY]: ex.json }, ` (memory map, ${theme}${viewport ? ', phone' : ''})`, viewport, MEMMAP_DRIVE);
  }
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
  // A widget collapsed by what holds it (margin: auto inside a grid) raises no error at all: a 3D stage is never this narrow.
  for (const st of view.querySelectorAll('.r3-stage')) if (st.clientWidth < 240) out.push('3D stage only ' + st.clientWidth + ' px wide');
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
 * The app's top bar on a phone (760 px and under) with a section link cut or scrolled out of its row: the row wider than its
 * room, a caption wider than its box ("Sandbox" read "Sanc" beside the search icon), or a link past the row's edge.
 * ui/navfit.ts sheds captions until none is cut, then shows icons alone (each link keeps its aria-label).
 */
const NAV_CLIPPED = `(() => {
  const out = [];
  if (document.documentElement.clientWidth > 760) return out;
  const nav = document.querySelector('.topbar .nav');
  if (!nav || !nav.offsetWidth) return out;
  const box = nav.getBoundingClientRect();
  if (nav.scrollWidth > nav.clientWidth + 1) out.push('top bar: the section links are ' + (nav.scrollWidth - nav.clientWidth) + ' px wider than their row');
  for (const a of nav.querySelectorAll('a')) {
    if (!a.offsetWidth) continue;
    const r = a.getBoundingClientRect();
    if (r.right > box.right + 1 || r.left < box.left - 1) out.push('top bar: ' + (a.getAttribute('aria-label') || a.textContent.trim()) + ' is outside the row');
    const cap = a.querySelector('.cap');
    if (cap && cap.offsetWidth && cap.scrollWidth > cap.clientWidth + 1) out.push('top bar: the caption ' + cap.textContent + ' is cut');
  }
  return out;
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
    // the autosave indicator's word is a 1 px label for screen readers on a narrow bar (editor-files.css), shown again when it is a problem
    if (el.classList.contains('sb-save') && !/error|saving/.test(el.dataset.state || '')) continue;
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
 * A schematic's fixed-size block name (view/legible.ts, .lg-name) with something painted over it: at both ends and the middle of
 * each drawn name, the topmost element at that point (its pointer-events lifted for the test) must be the name itself. A point
 * that lands on a panel above the svg is skipped, and so is one beside the circuit's own box (the name may overhang it).
 */
const NAME_COVER = `(() => {
  const out = [];
  // everything painted takes part in the hit test (decorations are pointer-events: none), and the names' layer must come last
  const lift = document.createElement('style');
  lift.textContent = 'svg.schematic * { pointer-events: auto !important }';
  document.head.append(lift);
  for (const svg of document.querySelectorAll('svg.schematic')) {
    const sr = svg.getBoundingClientRect();
    if (!sr.width) continue;
    const names = [...svg.querySelectorAll('.lg-name')].filter((t) => getComputedStyle(t).display !== 'none');
    if (names.length && svg.lastElementChild?.getAttribute('class') !== 'lg-names') out.push('names layer is not last in the svg');
    for (const t of names) {
      const r = t.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, tall = r.height > r.width;
      const pts = tall ? [[cx, r.top + 3], [cx, cy], [cx, r.bottom - 3]] : [[r.left + 3, cy], [cx, cy], [r.right - 3, cy]];
      for (const [x, y] of pts) {
        if (x < sr.left || x > sr.right || y < sr.top || y > sr.bottom) continue;
        const top = document.elementsFromPoint(x, y)[0];
        if (!top || !svg.contains(top) || top === t) continue;
        out.push('name covered: ' + t.textContent + ' by ' + (top.getAttribute('class') || top.tagName));
        break;
      }
    }
  }
  lift.remove();
  return out;
})()`;

/**
 * A chapter or workbench stage whose bars lost something: the open level's name cut on a one-row top bar (its
 * buttons belong in More: Stage.fitBar), a button past either bar's edge, the run row's buttons cut
 * (Stage.fitControls drops their labels instead), a top bar that wraps to two rows without being `stacked`, the level badge
 * over the drawing (the fit keeps it clear: SchematicView.badge), the sandbox's tab strip showing only the open tab beside
 * others (tabs shrink and More takes actions first: editor.ts fitActions), a phone's level canvas under 40 % of the
 * screen (level.css). Checked on every route.
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
    if (bar.matches('.stage-bar') && !bar.classList.contains('stacked') && bar.getBoundingClientRect().height > 64) out.push('stage bar wraps to ' + Math.round(bar.getBoundingClientRect().height) + ' px (not stacked)');
  }
  const badge = document.querySelector('.stage .canvas > .level-badge');
  const svg = document.querySelector('.stage .canvas > svg.schematic');
  if (badge && svg && badge.offsetWidth) {
    const b = badge.getBoundingClientRect();
    const under = [...svg.querySelectorAll('rect, path, polygon, circle, text')].filter((e) => {
      if (e.closest('defs')) return false;
      const q = e.getBoundingClientRect();
      return (q.width >= 1 || q.height >= 1) && q.width < 300 && q.height < 300 && q.right > b.left && q.left < b.right && q.bottom > b.top && q.top < b.bottom;
    }).length;
    if (under) out.push('level badge over the drawing (' + under + ' shapes)');
  }
  const strip = document.querySelector('.sb-top .sb-tabs');
  if (strip) {
    const tabs = [...strip.querySelectorAll('.sb-tab')], sr = strip.getBoundingClientRect(), g = strip.querySelector('.sb-new-grp');
    const end = g ? g.getBoundingClientRect().left : sr.right;
    const seen = tabs.filter((t) => { const r = t.getBoundingClientRect(); return r.left >= sr.left - 1 && r.right <= end + 1; }).length;
    if (tabs.length > 1 && seen < 2 && sr.width > 300) out.push('sandbox tab strip shows ' + seen + ' of ' + tabs.length + ' tabs');
  }
  const lvc = document.querySelector('.sb-levelmode .sb-canvas');
  if (lvc && document.documentElement.clientWidth <= 760 && lvc.getBoundingClientRect().height < 0.4 * innerHeight) out.push('phone level canvas only ' + Math.round(lvc.getBoundingClientRect().height) + ' px of ' + innerHeight);
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
    if (throttle > 1) await this.send('Emulation.setCPUThrottlingRate', { rate: throttle });
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
    // no route may open a print dialog (it would block the page): window.print only counts
    const seed = `window.__printed = 0; window.print = () => { window.__printed++; }; try { if (location.protocol.startsWith('http')) { localStorage.clear(); const s = ${JSON.stringify(route.storage)}; for (const k in s) localStorage.setItem(k, s[k]); } } catch (e) {}`;
    this.script = (await this.send('Page.addScriptToEvaluateOnNewDocument', { source: seed })).identifier;
    if (route.viewport) {
      const { width, height, mobile } = route.viewport;
      await this.send('Emulation.setDeviceMetricsOverride', { width, height, mobile, deviceScaleFactor: mobile ? 2 : 1 });
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: !!route.viewport.touch, maxTouchPoints: route.viewport.touch ? 5 : 1 });
      // the web font late or never (a slow network): the system fallback is the wider text the top bar must still fit
      await this.send('Network.setBlockedURLs', { urls: route.viewport.touch ? ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] : [] });
      this.emulated = true;
    } else if (this.emulated) {
      await this.send('Emulation.clearDeviceMetricsOverride');
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await this.send('Network.setBlockedURLs', { urls: [] });
      this.emulated = false;
    }
    // A query of its own makes every route a fresh document (a hash alone would only fire hashchange).
    const url = `${this.base}?smoke=${seq}${route.hash}`;
    try {
      const nav = await this.send('Page.navigate', { url });
      if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
      await this.settle(t0);
      if (route.drive) {
        const found = (await this.send('Runtime.evaluate', { expression: route.drive, awaitPromise: true, returnByValue: true })).result.value as string[] | undefined;
        for (const p of found ?? []) this.errors.push(`drive: ${p}`);
        await this.settle(t0);
      }
      const seen = (await this.send('Runtime.evaluate', { expression: INSPECT, returnByValue: true })).result.value as string[];
      for (const p of seen) this.errors.push(`page: ${p}`);
      const covered = (await this.send('Runtime.evaluate', { expression: NAME_COVER, returnByValue: true })).result.value as string[];
      for (const p of covered) this.errors.push(p);
      const bars = (await this.send('Runtime.evaluate', { expression: STAGE_BARS, returnByValue: true })).result.value as string[];
      for (const p of bars) this.errors.push(p);
      if (route.viewport) {
        const wide = (await this.send('Runtime.evaluate', { expression: OVERFLOW, returnByValue: true })).result.value as string[];
        for (const p of wide) this.errors.push(`overflow: ${p}`);
        const cut = (await this.send('Runtime.evaluate', { expression: CLIPPED, returnByValue: true })).result.value as string[];
        for (const p of cut) this.errors.push(p);
        const nav = (await this.send('Runtime.evaluate', { expression: NAV_CLIPPED, returnByValue: true })).result.value as string[];
        for (const p of nav) this.errors.push(p);
      }
    } catch (e) {
      this.errors.push(String(e instanceof Error ? e.message : e));
    }
    return { route, errors: [...new Set(this.errors)], ms: Date.now() - t0 };
  }

  /** Forget the pending requests the page itself has finished. */
  private async reconcile(): Promise<void> {
    try {
      const pend = [...new Set(this.inflight.values())];
      const r = await this.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const done = new Set(performance.getEntriesByType('resource').filter((e) => e.responseEnd > 0).map((e) => e.name));
        return ${JSON.stringify(pend)}.filter((u) => done.has(u));
      })()` });
      const done = new Set(r.result.value as string[]);
      let n = 0;
      for (const [id, url] of this.inflight) if (done.has(url)) { this.inflight.delete(id); n++; }
      if (n) console.log(`  note: ${n} requests the page had finished were never reported finished by CDP (${pend[0]})`);
    } catch { /* the page is gone: the timeout will say so */ }
  }

  /** What the page and its service worker look like at a timeout: told apart a page that is stuck from accounting that never emptied. */
  private async diagnose(): Promise<string> {
    try {
      const r = await Promise.race([
        this.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(async () => {
          const pend = ${JSON.stringify([...this.inflight.values()])};
          const res = performance.getEntriesByType('resource');
          const got = pend.filter((u) => res.some((e) => e.name === u && e.responseEnd > 0)).length;
          const reg = await navigator.serviceWorker?.getRegistration();
          const sw = reg ? [reg.installing && 'installing', reg.waiting && 'waiting', reg.active && 'active:' + reg.active.state].filter(Boolean).join('+') : 'none';
          return JSON.stringify({ pendingReceivedByPage: got + '/' + pend.length, ready: document.readyState, ctrl: !!navigator.serviceWorker?.controller, sw, main: (document.querySelector('main, #app')?.textContent ?? '').length, stage: !!document.querySelector('.stage svg, svg.schematic'), busy: !!document.querySelector('[aria-busy]') });
        })()` }),
        sleep(3000).then(() => ({ result: { value: 'page unresponsive' } })),
      ]);
      return ` [page ${r.result.value}; first pending: ${[...this.inflight.values()].slice(0, 3).join(', ')}]`;
    } catch (e) { return ` [no diagnosis: ${e}]`; }
  }

  /** Loaded, no request for 500 ms, then two frames and `dwell` ms for work scheduled after them. */
  private async settle(t0: number): Promise<void> {
    await this.quiet(t0);
    // The route still loading: its skeleton (index.html's shell, app.ts loadingPanel) has no text, and no request need be open while its
    // chunks are being taken up. Wait it out, then for what the page asks for once it is mounted. One stuck for good still fails, by name.
    const mounted = `new Promise((r) => { const t = setInterval(() => { if (!document.querySelector('#view .route-loading')) { clearInterval(t); r(); } }, 50); })`;
    await Promise.race([
      this.send('Runtime.evaluate', { expression: mounted, awaitPromise: true }),
      sleep(routeTimeout - (Date.now() - t0)).then(() => { throw new Error('the page never left its loading skeleton'); }),
    ]);
    await this.quiet(t0);
    // a big scene is built in slices now (Stage.load: aria-busy on its stage): wait for it as the one-piece build was
    const built = `new Promise((r) => { const t = setInterval(() => { if (!document.querySelector('.stage[aria-busy]')) { clearInterval(t); r(); } }, 50); })`;
    await Promise.race([
      this.send('Runtime.evaluate', { expression: built, awaitPromise: true }),
      sleep(routeTimeout - (Date.now() - t0)).then(() => { throw new Error('timeout: the stage never finished building its scene'); }),
    ]);
    const idle = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ${dwell}))))`;
    await Promise.race([
      this.send('Runtime.evaluate', { expression: idle, awaitPromise: true }),
      sleep(routeTimeout - (Date.now() - t0)).then(() => { throw new Error('timeout: the page never became idle'); }),
    ]);
  }

  /** The load event, and no request open for 500 ms. */
  private async quiet(t0: number): Promise<void> {
    let checked = 0;
    while (!this.loaded || this.inflight.size || Date.now() - this.lastNet < 500) {
      // A request the page has finished (a Resource Timing entry with a response end exists only once it is done) that CDP never
      // reported finished stays "pending" for ever: seen for requests a service worker answered, on a loaded 2-core runner,
      // while the page was complete. The page is the authority; a request it has no finished entry for stays pending (and times out).
      if (this.loaded && this.inflight.size && Date.now() - this.lastNet > 3000 && Date.now() - checked > 3000) {
        checked = Date.now();
        await this.reconcile();
      }
      if (Date.now() - t0 > routeTimeout) throw new Error(`timeout: ${this.loaded ? `${this.inflight.size} requests pending (${[...this.inflight.values()][0]})` : 'no load event'}${await this.diagnose()}`);
      await sleep(50);
    }
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

const TRANSIENT = /Failed to fetch dynamically imported module|^timeout: |^request failed/;
const MAX_RETRIES = 20;

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
    // A failure of the machine, not the page (one asset refused in 1 800 routes costs a 40-minute deploy): such a route gets one more
    // visit, alone. An exception or a layout failure does not; nor do many routes at once, which is a real outage.
    const again = results.filter((r) => r.errors.length && r.errors.every((e) => TRANSIENT.test(e)));
    if (again.length && again.length <= MAX_RETRIES) {
      const tab = new Tab(cdp, base);
      await tab.open();
      for (const r of again) {
        const second = await tab.visit(r.route, list.indexOf(r.route));
        console.log(`${second.errors.length ? 'FAILED AGAIN' : 'passed on a second visit'}: ${r.route.label}`);
        r.errors = second.errors;
      }
    }
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
