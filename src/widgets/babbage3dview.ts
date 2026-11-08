// Babbage's carry in 3D (loaded on demand, modelhost.ts): the figure-wheel column of Difference Engine No. 2 (31 wheels, 30 carry
// arms, Swade's technical description) with its successive carriage, and, on a switch, the anticipating carriage's effect as
// Babbage states it for the Analytical Engine (Passages, ch. VIII). The numbers (which latch arms, which arm fires when, the run
// length) are the DOM-free model's (babbage3dparts.ts); the motion between them is a drawing.

import '../styles/babbage3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import {
  ARMS, DIGITS, MOD, digitGroups, PER_COLUMN, TURN_MAX, advanceTo, anticipate, babbageAnchors, babbageParts, begin, finished, fromValue, gateRows, giveOff,
  nextFiring, sweep, valueOf, type BabbagePalette, type Carry, type Column, type Pose,
} from './babbage3dparts';

interface Case { id: string; label: string; start: bigint; add: bigint; blurb: string }
const nines = (n: number) => 10n ** BigInt(n) - 1n;
/** Starting columns and what is added to them; the third crosses the 15th / 16th arm, the last runs the whole column. */
export const CASES: Case[] = [
  { id: 'apart', label: 'Two separate carries', start: 4259n, add: 6332n, blurb: '4 259 + 6 332: wheels 0 and 3 pass 9 to 0, no 9 above either to carry on' },
  { id: 'run', label: 'A run of 9s', start: 7999999n, add: 1n, blurb: '7 999 999 + 1: wheel 0 passes 9 to 0, six wheels above stand at 9' },
  { id: 'gap', label: 'A run across wheel 15 to 16', start: nines(20), add: 1n, blurb: '20 nines + 1: the carry crosses the 45° gap in the helix and waits for the second rotation' },
  { id: 'full', label: 'All 31 wheels at 9', start: nines(DIGITS), add: 1n, blurb: '31 nines + 1: every arm fires, the top wheel only flags the overflow' },
];

export function babbageView(): Widget {
  let cs = CASES[1], base: Column = fromValue(cs.start), s: Carry = begin(base), phase: 'ready' | 'carry' | 'done' = 'ready';
  let anticipating = false, goal: 'next' | 'all' | null = null, target = 0, said = '';

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'One column of Difference Engine No. 2 in 3D: thirty-one figure wheels, a warning lever on each, and a carry axis with a helix of thirty carry arms',
    camera: { target: [-4, 52, 0], yaw: -0.6, pitch: 0.28, dist: 215 },
    limits: { minDist: 60, maxDist: 500 },
    note: 'One column of eight is drawn, still except for the carry axis; the sector drive, the locks, the three-limbed carry levers and the helix of arms are simplified to a block lever and thirty rods, and the motion is a drawing, not a kinematic model. The anticipating carriage was not fitted to this engine: its effect is drawn (every carry of a run at once), its linkage is not.',
    draw: () => paint(),
  });
  const palette = (): BabbagePalette => ({
    frame: stage.rgb('--m3-si'), metal: stage.rgb('--m3-metal'), wheel: stage.rgb('--bb-wheel'), tick: stage.rgb('--bb-tick'),
    lever: stage.rgb('--bb-lever'), warn: stage.rgb('--bb-warn'), arm: stage.rgb('--bb-arm'), live: stage.rgb('--m3-charge'),
  });
  const foresee = (): boolean[] | null => anticipating && phase === 'carry' ? anticipate(s.col).carryIn : null;
  const pose = (): Pose => ({ col: s.col, theta: s.theta, foresee: foresee() });
  function paint(): void { const p = pose(); stage.paint(babbageParts(p, palette()), babbageAnchors(p)); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), digits = h('div', { class: 'bb-digits', role: 'img' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  const gates = h('table', { class: 'bb-gates' });
  stage.chips.append(chip);
  gates.append(h('tr', null, h('th', null, 'bits'), h('th', null, 'ripple'), h('th', null, 'Kogge–Stone')),
    ...gateRows().map((r) => h('tr', null, h('td', null, String(r.n)), h('td', null, String(r.ripple)), h('td', null, String(r.ks)))));

  function readout(): void {
    const fs = foresee(), armed = s.col.warn.slice(0, ARMS).filter(Boolean).length;
    // The run, whichever carriage: what the successive carry would do from here.
    const plan = advanceTo(s, TURN_MAX);
    let at = DIGITS;
    digits.replaceChildren(...digitGroups(Array.from({ length: DIGITS }, (_, k) => s.col.w[DIGITS - 1 - k])).map((g) => h('span', { class: 'bb-grp' }, ...g.map((d) => {
      const i = --at;
      return h('span', { class: `bb-d${s.col.warn[i] ? ' armed' : ''}${fs?.[i] ? ' recv' : ''}` }, d);
    }))));
    const v = valueOf(s.col), flag = s.col.warn[DIGITS - 1] ? ' with the overflow flag set' : '';
    digits.setAttribute('aria-label', `Column reads ${(v % MOD).toString()}${flag}; ${armed} warning lever${armed === 1 ? '' : 's'} armed`);
    const runLen = plan.longest;
    const unit = anticipating ? '1 unit, whatever the run' : `axis turned to ${Math.round(plan.lastT)}° of ${TURN_MAX}°${plan.lastT >= 360 ? ' (second rotation)' : ''}`;
    const rows: [string, string][] = [
      ['Case', cs.blurb],
      ['Warning latches armed', String(armed)],
      ['Carries fired so far', String(s.fired.length)],
      ['Longest run of carries', phase === 'ready' ? '–' : String(runLen)],
      [anticipating ? 'Anticipating carriage' : 'Successive carriage', phase === 'ready' ? '–' : plan.fired.length === 0 ? 'nothing to carry' : unit],
      ['Carry axis', `${Math.round(s.theta)}°`],
      ['Same run, ripple-carry gates', phase === 'ready' ? '–' : `${runLen} × ${PER_COLUMN} = ${runLen * PER_COLUMN} NAND delays`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, val]) => [h('span', null, k), h('span', { class: 'v' }, val)]));
    chip.textContent = phase === 'ready' ? 'Ready' : phase === 'done' ? (s.col.warn[DIGITS - 1] ? 'Carried: overflow flag set' : 'Carried') : `Carrying: ${armed} latch${armed === 1 ? '' : 'es'} armed`;
    chip.className = `r3-chip ${phase === 'done' ? 'good' : phase === 'carry' ? 'warn' : ''}`;
    addBtn.disabled = phase === 'carry';
    stepBtn.disabled = runBtn.disabled = phase !== 'carry' || goal !== null;
    stepBtn.textContent = anticipating ? 'Carry (one unit)' : 'Next carry';
    runBtn.textContent = anticipating ? 'Carry all' : 'Run carry';
    modeBtn.setAttribute('aria-pressed', String(anticipating));
    const text = phase === 'ready' ? 'Press Add: every wheel advances, and a wheel passing 9 to 0 arms its warning lever without carrying.'
      : phase === 'carry' ? `${armed} warning lever${armed === 1 ? ' is' : 's are'} armed. ${anticipating ? 'The anticipating carriage settles every carry of a run in one unit.' : 'The carry axis turns and its arms poll the wheels from below.'}`
      : `Carried: the column reads ${(v % MOD).toString()}${flag}.`;
    if (!goal && text !== said) { said = text; live.textContent = text; }
  }
  const settle = () => { if (phase === 'carry' && goal === null && finished(s)) phase = 'done'; };
  const repaint = () => { settle(); readout(); paint(); loop.kick(); };

  const loop = frameLoop((_now, dt) => {
    if (goal) {
      const want = goal === 'next' ? target : TURN_MAX, speed = goal === 'next' ? Math.max(200, (target - s.theta) / 0.35) : 170;
      s = advanceTo(s, Math.min(want, s.theta + speed * dt));
      if (goal === 'next' ? s.theta >= target : finished(s) || s.theta >= TURN_MAX) goal = null;
      settle();
    }
    readout(); paint();
  }, () => goal !== null);

  function addAction(): void {
    if (phase === 'carry') return;
    // Giving-off: a finished column is added to again; the top latch (the overflow flag) is cleared by a fresh addition.
    const from = phase === 'done' ? { ...s.col, warn: s.col.warn.map(() => false) } : base;
    base = giveOff(from, cs.add);
    s = begin(base);
    phase = 'carry';
    goal = null;
    repaint();
  }
  function carryAction(all: boolean): void {
    if (phase !== 'carry' || goal) return;
    if (anticipating) {
      const o = anticipate(s.col);
      s = { ...s, col: o.col, fired: s.fired.concat(o.carryIn.flatMap((x, i) => (x && i > 0 ? [i - 1] : []))), longest: Math.max(s.longest, sweep(s.col).longest) };
      repaint();
      return;
    }
    const t = nextFiring(s);
    if (t === null) { repaint(); return; }
    if (reducedMotion()) { s = all ? advanceTo(s, TURN_MAX) : advanceTo(s, t); repaint(); return; }
    goal = all ? 'all' : 'next';
    target = t;
    repaint();
  }

  const sel = h('select', { id: 'bb-case', 'aria-label': 'Case' }, ...CASES.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
  sel.value = cs.id;
  sel.addEventListener('change', () => { cs = CASES.find((c) => c.id === sel.value)!; reset(); });
  function reset(): void { base = fromValue(cs.start); s = begin(base); phase = 'ready'; goal = null; repaint(); }
  const addBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Add') as HTMLButtonElement;
  addBtn.addEventListener('click', addAction);
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Next carry') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => carryAction(false));
  const runBtn = h('button', { type: 'button', class: 'btn sm' }, 'Run carry') as HTMLButtonElement;
  runBtn.addEventListener('click', () => carryAction(true));
  const modeBtn = h('button', { type: 'button', class: 'btn sm bb-mode', 'aria-pressed': 'false' }, 'Anticipating carriage') as HTMLButtonElement;
  modeBtn.addEventListener('click', () => { anticipating = !anticipating; repaint(); });
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Start over') as HTMLButtonElement;
  resetBtn.addEventListener('click', reset);

  panel.append(
    h('h3', { class: 'm3-title' }, 'Babbage’s carry, in brass'),
    h('p', { class: 'm3-sub' }, 'Babbage’s Difference Engine No. 2 (designed 1847 to 1849; its calculating section built by the Science Museum, completed 1991): one column of 31 figure wheels, units wheel at the bottom. Adding gives every wheel its digit; a wheel that passes 9 to 0 arms its warning lever and carries nothing yet. Then the carry axis turns and its helix of 30 arms polls the levers from below, 22° apart: an armed lever advances the wheel above, and if that wheel passes 9 to 0 its own lever arms for the next arm, still to come. That is successive carriage: a run of 9s ripples one arm at a time, like a ripple-carry adder. Switch to the anticipating carriage and the whole run carries in one unit, as Babbage describes it for the Analytical Engine.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('label', { class: 'bb-case' }, h('span', null, 'Case'), sel), h('div', { class: 'r3-btns' }, addBtn, stepBtn, runBtn, modeBtn, resetBtn, stage.resetBtn)),
        digits, stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This column ', h('span', { class: 'r3-badge' }, 'model')), kv,
        h('h4', null, 'The site’s adders, NAND delays'), gates)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
