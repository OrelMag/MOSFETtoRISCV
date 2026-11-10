// Device puzzles in the sandbox (puzzles/devpuzzles.ts): the Puzzles drawer's Devices group (puzzleui.ts calls
// deviceGroup), the start dialog (an empty chip with the device and a clock, or a copy of one of your chips with the device
// beside it), and, while a device puzzle chip is open, the strip under the canvas: the brief, the tests (a click plays one
// on the circuit, a world step at a time, the device's face large beside the player and every step's pins as a timeline),
// Check, the NANDs against the reference circuit's, Show answer and Do it for me (the reference circuit as the chip).
// Outside the player, the device holds the selected test's world whenever the circuit powers on, so Run plays that test.

import '../styles/sbchallenges.css';
import '../styles/sbpuzzles.css';
import '../styles/devices.css';
import { groupDigits } from '../sim/numfmt';
import { h, icon, undoKey } from '../ui/dom';
import { DEVICES, type DeviceTest, type VendTest, type CrossingTest, type MazeTest } from '../puzzles/devices';
import {
  type DevicePuzzle, DEVICE_PUZZLES, devicePuzzleChipId, devicePuzzleOfChip, type DeviceRun, deviceStars, type DeviceStars, deviceTests, findDevice, parNands, runDevicePuzzle,
} from '../puzzles/devpuzzles';
import { copyWithDevice, emptyDeviceChip, referenceChip } from '../puzzles/devrefs';
import { DeviceReplay } from '../puzzles/devreplay';
import { puzzleProgress } from '../puzzles/grade';
import { hardwareNands, programRoms } from '../puzzles/run';
import { lookOf } from './chipfaults';
import { deviceFaceSvg } from './devface';
import { deviceState, type DeviceState } from './devparts';
import { type Editor, registerEditorPlugin } from './editor';
import { uniqueName } from './model';
import { isError, partDef } from './parts';
import { openChip } from './session';
import { symbolGeom } from '../sim/geometry';
import type { Sim } from '../sim/sim';

const progress = puzzleProgress;
let listToggle: ((ed: Editor) => void) | null = null;
/** puzzleui.ts hands over how to open the Puzzles drawer (no import cycle). */
export const setDeviceListToggle = (f: (ed: Editor) => void) => { listToggle = f; };
const starText = (s: number) => '★'.repeat(s) + '☆'.repeat(3 - s);
const fmtN = groupDigits;

const uis = new WeakMap<Editor, DeviceUi>();

/** What a test sets up, in a few words (the tests table). */
function scenario(p: DevicePuzzle, t: DeviceTest): string {
  if (p.dev === 'crossing') { const x = t as CrossingTest; return x.presses.length ? `press at ${x.presses.join(', ')}` : 'no press'; }
  if (p.dev === 'maze') { const m = (t as MazeTest).maze; return `${(m[0].length - 1) / 2} × ${(m.length - 1) / 2}, limit ${t.steps}`; }
  return (t as VendTest).script.map(([s, e]) => `${s}: ${e.replace(/^c(\d+)/, '$1¢')}`).join(' · ');
}

class DeviceUi {
  private panel = h('section', { class: 'sb-chal sb-pz sb-dev', 'aria-label': 'Device puzzle' });
  private results = new Map<string, { r: DeviceRun; key: string; nands: number | null; stars: DeviceStars | null; reference: boolean }>();
  private collapsed = false;
  private checking = false;
  private confirming = false;
  private key = '';
  private version = 0;
  private lastChip = '';
  private sel = 0;
  private replay: DeviceReplay | null = null;
  private loadedOn: { sim: Sim | null; resets: number } = { sim: null, resets: -1 };
  private big: ReturnType<typeof deviceFaceSvg> | null = null;
  private dlg: HTMLElement | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private ed: Editor) {
    ed.slots.bottom.append(this.panel);
    this.cleanup.push(ed.onChange(() => this.sync()));
    this.cleanup.push(ed.onSimChange(() => { this.replay?.resync(); this.autoload(); }));
    const paint = () => { this.autoload(); if (this.replay) this.render(true); };
    ed.paintHooks.add(paint);
    this.cleanup.push(() => ed.paintHooks.delete(paint));
    this.sync();
  }

  destroy(): void {
    this.closePlayer();
    for (const f of this.cleanup) f();
    this.panel.remove();
    this.dlg?.remove();
    uis.delete(this.ed);
  }

  private get puzzle(): DevicePuzzle | undefined {
    return devicePuzzleOfChip(this.ed.chipId);
  }

  private stateKey(): string {
    const ed = this.ed;
    return `${ed.compiled?.connKey ?? ''}|${JSON.stringify(programRoms(ed.doc, ed.ws.chips).map((r) => (r.part.ref as { rom: { src: string } }).rom.src))}`;
  }

  private sync(): void {
    const ed = this.ed;
    if (ed.chipId !== this.lastChip) {
      this.closePlayer();
      this.lastChip = ed.chipId;
      this.confirming = false;
      this.sel = 0;
      this.loadedOn = { sim: null, resets: -1 };
    }
    this.autoload();
    this.render();
  }

  /** Whenever the circuit powers on (a new simulation, Reset), the device gets the selected test's world. */
  private autoload(): void {
    const p = this.puzzle, es = this.ed.sim, sim = es.sim;
    if (!p || this.replay || !sim) return;
    if (this.loadedOn.sim === sim && this.loadedOn.resets === es.resets) return;
    this.loadedOn = { sim, resets: es.resets };
    const f = findDevice(es, p);
    if (Array.isArray(f)) return;
    const st = sim.leafState(f.li) as DeviceState;
    if (st.n || st.test === this.sel) return; // already this test, or carried over from before an edit
    es.pokeLeaf(f.li, deviceState(p.dev, this.sel, st));
  }

  // ---- the strip ---------------------------------------------------------------------------------------------------

  private render(force = false): void {
    const p = this.puzzle, ed = this.ed;
    const res = p ? this.results.get(ed.chipId) : undefined;
    const stale = !!res && res.key !== this.stateKey();
    const rec = p ? progress().get(p.id) : undefined;
    const key = JSON.stringify([ed.chipId, !!p, this.collapsed, this.confirming, this.checking, this.version, stale, rec, this.sel, !!this.replay]);
    if (key === this.key && !force) return;
    this.key = key;
    this.panel.hidden = !p;
    this.panel.replaceChildren();
    if (!p) return;
    const actions = this.confirming
      ? [h('span', { class: 'sb-chal-ask' }, 'Replace this chip with the reference circuit?'),
        h('button', { class: 'btn sm primary', onclick: () => this.solve(p) }, 'Replace'),
        h('button', { class: 'btn sm ghost', onclick: () => { this.confirming = false; this.render(); } }, 'Cancel')]
      : [h('button', { class: 'btn sm primary', 'data-pz': 'check', title: 'Play every test on the circuit\'s gates', disabled: this.checking, onclick: () => this.check() }, icon('check', 14), this.checking ? 'Checking…' : 'Check'),
        h('button', { class: 'btn sm ghost', 'data-pz': 'answer', title: 'How the reference circuit works', onclick: () => this.showAnswer(p) }, 'Show answer'),
        h('button', { class: 'btn sm ghost', 'data-pz': 'solve', title: `Replace this chip with the reference circuit (${undoKey()} brings yours back)`, onclick: () => { this.confirming = true; this.render(); } }, 'Do it for me'),
        h('button', { class: 'btn sm ghost', title: 'Start this puzzle again (this chip is replaced; Ctrl+Z brings it back)', onclick: () => this.openStart(p, true) }, 'Start over…'),
        h('button', { class: 'btn ghost icon-only', title: 'All puzzles', 'aria-label': 'All puzzles', onclick: () => listToggle?.(ed) }, icon('menu', 15))];
    this.panel.append(h('header', { class: 'sb-chal-head' },
      h('button', { class: `btn ghost icon-only sb-chal-fold${this.collapsed ? '' : ' open'}`, title: this.collapsed ? 'Show the brief' : 'Hide the brief', 'aria-expanded': String(!this.collapsed),
        onclick: () => { this.collapsed = !this.collapsed; this.render(); } }, icon('chevR', 14)),
      h('span', { class: `sb-chal-flag${rec ? ' solved' : ''}` }, icon(rec ? 'check' : 'puzzle', 13), 'Puzzle · Devices'),
      h('h3', null, p.title),
      rec && !rec.shown ? h('span', { class: 'sb-chal-stars', title: `Best: ${rec.stars} of 3 stars` }, starText(rec.stars)) : null,
      h('span', { class: 'sb-chal-actions' }, ...actions)));
    if (!this.collapsed) {
      const brief = h('p', { class: 'sb-chal-brief' });
      brief.innerHTML = p.brief;
      this.panel.append(h('div', { class: 'sb-chal-body sb-pz-body' },
        h('div', { class: 'sb-pz-left' }, brief, this.testsEl(p, res?.r, stale)),
        this.scoreEl(p, res, stale)));
    }
    if (this.replay?.test) this.panel.append(this.playerEl(p));
  }

  private testsEl(p: DevicePuzzle, r: DeviceRun | undefined, stale: boolean): HTMLElement {
    const rows = deviceTests(p).map((t, i) => {
      const x = r?.results[i];
      return h('tr', { class: `${i === this.sel ? 'cur' : ''}${x && !x.ok ? ' bad' : ''}`, title: 'Play this test on the circuit', 'data-test': String(i), onclick: () => this.openPlayer(p, i) },
        h('td', { class: 'st' }, x ? (x.ok ? '✓' : '✗') : ''),
        h('td', { class: 'n' }, t.name),
        h('td', { class: 'w', title: scenario(p, t) }, scenario(p, t)),
        h('td', { class: `w${x && !x.ok ? ' wrong' : ''}` }, x ? (x.ok ? x.status : x.why!) : ''),
        h('td', { class: 'c' }, x ? fmtN(x.steps) : ''));
    });
    const fail = r?.results.find((x) => !x.ok);
    return h('div', { class: `sb-pz-tests${stale ? ' stale' : ''}` },
      r?.problems.length ? h('ul', { class: 'sb-chal-fails' }, r.problems.map((x) => h('li', null, x))) : null,
      h('div', { class: 'sb-tp-table' }, h('table', null,
        h('thead', null, h('tr', null, h('th', { class: 'st' }), h('th', { class: 'n' }, 'test'), h('th', null, 'the world'), h('th', null, 'result'), h('th', null, 'steps'))),
        h('tbody', null, rows))),
      fail ? h('p', { class: 'sb-tp-note err' }, `${fail.name}: ${fail.why}. Click the test to play it.`) : null,
      stale ? h('p', { class: 'sb-tp-note' }, 'Edited since the last Check: check again.') : null);
  }

  private scoreEl(p: DevicePuzzle, res: { r: DeviceRun; nands: number | null; stars: DeviceStars | null; reference: boolean } | undefined, stale: boolean): HTMLElement {
    const par = parNands(p.dev);
    const out = h('div', { class: `sb-pz-score${stale ? ' stale' : ''}` });
    const item = (k: string, v: string, note = '', good?: boolean) => [h('span', { class: 'k' }, k), h('b', { class: 'v' }, v), h('small', { class: good === undefined ? 'p' : good ? 'p par' : 'p over' }, note)];
    if (res?.r.ok && res.nands !== null) {
      out.append(h('div', { class: 'sb-pz-grid' },
        ...item('NANDs', fmtN(res.nands), `par ${fmtN(par)}`, res.nands <= par),
        ...item('Tests', `${res.r.results.length} / ${res.r.results.length}`),
        ...item('Cycles (mean)', fmtN(res.r.cycles))));
      if (res.reference) out.append(h('p', { class: 'sb-pz-hint' }, 'The reference circuit as loaded: it earns no stars. Change it, then Check again.'));
      else if (res.stars) out.append(h('p', { class: 'sb-pz-grade' }, h('span', { class: 'sb-chal-stars' }, starText(res.stars)), ' ',
        res.stars === 3 ? 'at or below the reference circuit\'s NANDs' : res.stars === 2 ? 'within 1.5 × the reference\'s NANDs' : 'passes: under 1.5 × the reference\'s NANDs earns ★★'));
    } else {
      out.append(h('p', { class: 'sb-pz-hint' }, res ? 'Not yet: every test must pass to be scored.' : `Check plays every test on the gates and counts your NANDs (the device is free). The reference circuit: ${fmtN(par)} NANDs.`),
        h('p', { class: 'sb-pz-hint' }, '★ pass · ★★ within 1.5 × the reference\'s NANDs · ★★★ at or below them'));
    }
    return out;
  }

  // ---- Check, the answer -----------------------------------------------------------------------------------------------

  check(): void {
    const p = this.puzzle, ed = this.ed;
    if (!p || this.checking) return;
    this.closePlayer();
    this.checking = true;
    this.render();
    setTimeout(() => {
      try {
        const c = ed.compiled;
        const r = runDevicePuzzle(p, c, ed.doc.pins, { doc: ed.doc, look: lookOf(ed.ws, ed.lib), deps: ed.lib.deps(ed.chipId) });
        const nands = r.ok ? hardwareNands(c.def) : null;
        const reference = r.ok && JSON.stringify(stripIds(ed.doc)) === JSON.stringify(stripIds(referenceChip(p.dev, ed.chipId, ed.doc.name)));
        const stars = nands !== null && !reference ? deviceStars(nands, parNands(p.dev)) : null;
        this.results.set(ed.chipId, { r, key: this.stateKey(), nands, stars, reference });
        if (reference) {
          progress().shown(p.id);
          ed.toast('This is the reference circuit: it passes, but earns no stars. Change it to beat it');
        } else if (nands !== null && stars) {
          const { best, first } = progress().record(p.id, { cycles: r.cycles, nands, words: null }, stars);
          ed.toast(first ? `Solved: ${starText(stars)}` : best ? `New best: ${starText(stars)}` : 'Passes (not better than your best)');
        } else {
          const bad = r.results.findIndex((x) => !x.ok);
          if (bad >= 0) this.sel = bad;
        }
      } finally {
        this.checking = false;
        this.version++;
        this.render();
      }
    }, 20);
  }

  private solve(p: DevicePuzzle): void {
    this.confirming = false;
    const ed = this.ed;
    const doc = referenceChip(p.dev, ed.chipId, ed.doc.name);
    ed.edit(() => doc);
    progress().shown(p.id);
    ed.toast('The reference circuit is on the chip: Check it, then try to beat it');
  }

  private showAnswer(p: DevicePuzzle): void {
    this.dialog(`Answer: ${p.title}`, [
      h('p', { class: 'sb-dlg-lead' }, p.idea),
      h('p', { class: 'sb-dlg-lead' }, `The reference circuit: ${fmtN(parNands(p.dev))} NANDs. Do it for me puts it on this chip (${undoKey()} brings yours back).`),
    ]);
  }

  // ---- the player ----------------------------------------------------------------------------------------------------

  private openPlayer(p: DevicePuzzle, k: number): void {
    this.sel = k;
    // loading pauses and resets the simulation, which repaints: the player is drawn only once it holds its test
    const rp = this.replay ?? new DeviceReplay(this.ed.sim, p);
    rp.load(k);
    this.replay = rp;
    this.version++;
    this.render(true);
  }

  private closePlayer(): void {
    const r = this.replay;
    if (!r) return;
    this.replay = null;
    this.big = null;
    r.end();
    this.loadedOn = { sim: this.ed.sim.sim, resets: this.ed.sim.resets };
  }

  private playerEl(p: DevicePuzzle): HTMLElement {
    const rp = this.replay!;
    const v = rp.read();
    const t = rp.test!;
    const res = this.results.get(this.ed.chipId)?.r.results[rp.k];
    const end = Math.max(v.step, res?.steps ?? 0, t.steps);
    const btn = (ic: string, title: string, run: () => void) => h('button', { class: 'btn ghost icon-only', title, 'aria-label': title, onclick: () => { run(); this.render(true); } }, icon(ic, 15));
    const scrub = h('input', { type: 'range', min: '0', max: String(end), value: String(v.step), 'aria-label': 'World step' }) as HTMLInputElement;
    scrub.addEventListener('input', () => { rp.goto(Number(scrub.value)); this.render(true); });
    const marks = h('div', { class: 'sb-tp-marks' }, res?.at !== undefined && !res.ok ? h('i', { style: `left:${(100 * Math.min(res.at, end)) / end}%`, title: `step ${res.at}: ${res.why}` }) : null);
    if (!this.big) this.big = deviceFaceSvg(p.dev);
    this.big.paint({ st: v.st, drive: v.st?.frames.at(-1)?.drive ?? null });
    const verdict = v.verdict;
    return h('div', { class: 'sb-chal-tests sb-pz-player sb-dev-player' },
      h('div', { class: 'sb-tp-bar' },
        h('span', { class: 'sb-tp-name' }, icon('play', 12), `Test: ${t.name}`),
        h('span', { class: 'sb-tp-nav' },
          btn('reset', 'Back to power-on (step 0)', () => rp.goto(0)),
          btn('stepBack', 'One step back', () => rp.step(-1)),
          btn('step', 'One step forward', () => rp.step(1)),
          btn('play', 'Run to the end of the test', () => rp.toEnd()),
          res?.at !== undefined && !res.ok ? h('button', { class: 'btn sm ghost', title: 'Go to the step before the fault', onclick: () => { rp.goto(Math.max(0, res.at! )); this.render(true); } }, 'To the fault') : null),
        h('span', { class: 'sb-tp-pos' }, 'step ', h('b', null, fmtN(v.step)), ` / ${t.steps} · cycle ${fmtN(v.cycles)}`),
        verdict ? h('b', { class: verdict.ok ? 'ok' : 'bad' }, verdict.ok ? '✓ passes' : `✗ ${verdict.why}`) : null,
        h('span', { class: 'sb-tp-tools' }, h('button', { class: 'btn sm ghost', title: 'Stop playing: the circuit goes back to how it was', onclick: () => { this.closePlayer(); this.version++; this.render(true); } }, icon('close', 13), 'Done'))),
      v.problems.length ? h('p', { class: 'sb-tp-note err' }, v.problems.join(' · ')) : h('div', { class: 'sb-tp-scrub' }, scrub, marks),
      h('div', { class: 'sb-dev-stage' }, h('div', { class: 'sb-dev-big' }, this.big.svg, h('p', { class: 'sb-tp-note' }, v.st ? DEVICES[p.dev].status(v.st.w) : '')),
        timeline(p, v.st, end)));
  }

  // ---- starting ------------------------------------------------------------------------------------------------------

  open(p: DevicePuzzle): void {
    const id = devicePuzzleChipId(p);
    if (this.ed.ws.chips[id]) this.ed.openChip(id);
    else this.openStart(p, false);
  }

  openStart(p: DevicePuzzle, replace: boolean): void {
    const ed = this.ed;
    type Choice = { kind: 'circuit' } | { kind: 'chip'; chip: string; en: boolean };
    const cands: { choice: Choice; name: string; tag: string; detail: string }[] = [
      { choice: { kind: 'circuit' }, name: 'A circuit', tag: 'recommended', detail: 'an empty chip with the device and a clock: draw the controller (gates, flip-flops, a state machine chip)' },
    ];
    for (const [id, doc] of Object.entries(ed.ws.chips)) {
      if (id.startsWith('u_pz_') || id.startsWith('u_ch_')) continue;
      const roms = programRoms(doc, ed.ws.chips).length;
      cands.push({ choice: { kind: 'chip', chip: id, en: roms > 0 }, name: doc.name, tag: roms ? 'your CPU' : 'your chip',
        detail: roms ? 'a copy with the device beside it, its en pin for the program to pulse once a step' : 'a copy with the device placed beside it, unwired' });
    }
    let pick = cands[0].choice;
    const list = h('div', { class: 'sb-pz-opts', role: 'radiogroup', 'aria-label': 'Start from' }, cands.map((c, i) => {
      const el = h('label', { class: `sb-pz-opt${i === 0 ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'sb-dev-start', checked: i === 0 }),
        h('span', null, h('b', null, c.name), h('span', { class: 'sb-pz-tag' }, c.tag), h('small', null, c.detail)));
      el.querySelector('input')!.addEventListener('change', () => { pick = c.choice; list.querySelectorAll('.sb-pz-opt').forEach((o) => o.classList.toggle('on', o === el)); });
      return el;
    }));
    const d = this.dialog(`Start “${p.title}”`, [
      h('p', { class: 'sb-dlg-lead' }, 'The puzzle gets a chip of its own, ', h('code', null, devicePuzzleChipId(p)), ', with the device on it.',
        replace ? h('b', null, ` The puzzle chip you have now is replaced (${undoKey()} brings it back).`) : null),
      list,
    ], [
      h('button', { class: 'btn ghost sm', onclick: () => d.close() }, 'Cancel'),
      h('button', { class: 'btn primary sm', 'data-pz': 'start', onclick: () => { d.close(); this.start(p, pick); } }, replace ? 'Start over' : 'Start'),
    ]);
  }

  private start(p: DevicePuzzle, choice: { kind: 'circuit' } | { kind: 'chip'; chip: string; en: boolean }): void {
    const ed = this.ed;
    const id = devicePuzzleChipId(p);
    const widthOf = (q: { ref: Parameters<typeof partDef>[0] }) => { const d = partDef(q.ref, (c) => ed.lib.defOf(c)); return d && !isError(d) ? symbolGeom(d).w : 6; };
    let err: string | null = null;
    ed.editWs((ws) => {
      const name = uniqueName(`Puzzle: ${p.title}`, Object.values(ws.chips).filter((c) => c.id !== id).map((c) => c.name));
      try {
        const src = choice.kind === 'chip' ? ws.chips[choice.chip] : undefined;
        if (choice.kind === 'chip' && !src) throw new Error('no such chip');
        const doc = choice.kind === 'circuit' ? emptyDeviceChip(p.dev, id, name) : copyWithDevice(src!, p.dev, id, name, choice.en, widthOf);
        return openChip({ ...ws, chips: { ...ws.chips, [id]: doc } }, id);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
        return ws;
      }
    });
    if (err) return void ed.toast(`Cannot start: ${err}`, 'err');
    this.results.delete(id);
    ed.toast(choice.kind === 'circuit' ? `Draw the controller: drive the ${DEVICES[p.dev].title.toLowerCase()}'s pins on its left from those on its right, then Check` : 'Wire the device to your chip, then Check');
    ed.fitView();
  }

  private dialog(title: string, body: (Node | string | null)[], foot: HTMLElement[] = []): { close: () => void } {
    this.dlg?.remove();
    const close = () => { ov.remove(); if (this.dlg === ov) this.dlg = null; this.ed.view.svg.focus({ preventScroll: true }); };
    const ov = h('div', { class: 'sb-help sb-dlg sb-pz-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e: Event) => { if (e.target === ov) close(); } },
      h('div', { class: 'panel' },
        h('div', { class: 'sb-help-head' }, h('h3', null, title), h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
        h('div', { class: 'sb-dlg-body' }, body),
        h('div', { class: 'sb-dlg-foot' }, foot.length ? foot : h('button', { class: 'btn primary sm', onclick: close }, 'OK'))));
    ov.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    this.ed.el.append(ov);
    this.dlg = ov;
    (ov.querySelector('.sb-dlg-foot .primary') as HTMLButtonElement | null)?.focus();
    return { close };
  }
}

/** A chip document without its ids and positions' noise: what Check compares with the reference to see Do it for me. */
const stripIds = (d: { parts: unknown[]; wires: unknown[]; pins: unknown[] }) => ({ parts: d.parts, wires: d.wires, pins: d.pins });

/** Every step's pins as lanes: what the circuit drove and what the world sensed, the fault marked. */
function timeline(p: DevicePuzzle, st: DeviceState | null, end: number): HTMLElement {
  const m = DEVICES[p.dev];
  const lanes = [...m.sense.map((x, i) => ({ name: x.name, of: (f: { sense: number[] }) => f.sense[i], w: x.width, kind: 'sense' })),
    ...m.drive.map((x, i) => ({ name: x.name, of: (f: { drive: number[] }) => f.drive[i], w: x.width, kind: 'drive' }))];
  const W = 640, L = 58, rowH = 15, H = lanes.length * rowH + 16;
  const dx = (W - L - 6) / Math.max(1, end);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'sb-dev-lanes');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Every step: the pins the world sensed and the circuit drove');
  const add = (tag: string, a: Record<string, string | number>, text?: string) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
  lanes.forEach((ln, i) => {
    const y = 4 + i * rowH;
    add('text', { x: L - 6, y: y + 10, 'text-anchor': 'end', class: `lbl ${ln.kind}` }, ln.name);
    add('line', { x1: L, x2: W - 6, y1: y + 12, y2: y + 12, class: 'base' });
    for (const f of st?.frames ?? []) {
      const v = ln.of(f);
      if (!v) continue;
      add('rect', { x: L + f.step * dx + 0.5, y: y + 2, width: Math.max(1, dx - 1), height: 9, rx: 1.5, class: `on ${ln.kind}${v < 0 ? ' x' : ''}` });
      if (ln.w > 1 && dx > 9) add('text', { x: L + f.step * dx + dx / 2, y: y + 9.5, 'text-anchor': 'middle', class: 'val' }, v < 0 ? 'X' : String(v));
    }
  });
  const bad = st?.frames.find((f) => f.fault);
  if (bad) add('rect', { x: L + bad.step * dx, y: 1, width: Math.max(2, dx), height: H - 14, class: 'fault' });
  if (st) add('rect', { x: L + Math.min(st.n, end) * dx - 1, y: 1, width: 2, height: H - 14, class: 'cur' });
  for (let s = 0; s <= end; s += end > 60 ? 20 : 10) add('text', { x: L + s * dx, y: H - 2, class: 'tick' }, String(s));
  return h('div', { class: 'sb-dev-lanes-wrap' }, svg);
}

/** The Devices group of the Puzzles drawer (puzzleui.ts renders it after the stream groups). */
export function deviceGroup(ed: Editor, close: () => void): HTMLElement[] {
  const pg = progress();
  const head = h('h4', null, h('span', null, 'Devices'), h('small', { class: 'n' }, `${DEVICE_PUZZLES.filter((p) => pg.solved(p.id)).length}/${DEVICE_PUZZLES.length}`));
  return [head, ...DEVICE_PUZZLES.map((p) => {
    const rec = pg.get(p.id);
    const id = devicePuzzleChipId(p);
    const started = !!ed.ws.chips[id], cur = ed.chipId === id;
    const pins = DEVICES[p.dev].drive.length + DEVICES[p.dev].sense.length;
    return h('button', {
      class: `sb-chal-item${rec ? ' solved' : ''}${cur ? ' cur' : ''}`, 'data-puzzle': p.id,
      title: started ? 'Open it' : 'Start: a circuit or one of your chips', onclick: () => { const ui = uis.get(ed); if (!ui) return; if (started) close(); ui.open(p); },
    },
    h('span', { class: 'tick', 'aria-label': rec ? 'solved' : started ? 'started' : 'not started' }, rec ? icon('check', 13) : h('i', { class: started ? 'started' : '' })),
    h('span', { class: 'sb-dev-pins', 'aria-hidden': 'true', title: `${pins} pins` }, ...Array.from({ length: pins }, () => h('b'))),
    h('span', { class: 'name' }, p.title, h('small', { class: 'sb-pz-short' }, p.short)),
    rec ? h('span', { class: 'sb-chal-stars', title: rec.shown ? 'Answer shown' : `Best: ${rec.stars} of 3 stars` }, rec.shown ? '·' : starText(rec.stars)) : null,
    h('span', { class: 'go' }, cur ? 'open' : started ? 'Open' : 'Start'));
  })];
}

/** Device puzzles solved (the drawer's count). */
export const devicesSolved = () => DEVICE_PUZZLES.filter((p) => progress().solved(p.id)).length;

registerEditorPlugin((ed) => {
  if (ed.level) return;
  const ui = new DeviceUi(ed);
  uis.set(ed, ui);
  return () => ui.destroy();
});
