// Babbage's carry in 3D (loaded on demand, modelhost.ts): the figure-wheel column of Difference Engine No. 2 on the studio
// renderer (babbage3dkit.ts: toothed wheels with their numerals, the three-limbed carry levers, the helix of carry arms, the
// whole engine as a layer) with its successive carriage, and, on a switch, the anticipating carriage's effect as Babbage states
// it for the Analytical Engine (Passages, ch. VIII). The numbers (which latch arms, which arm fires when, the run length) are the
// DOM-free model's (babbage3dparts.ts); the motion between them is a drawing.

import '../styles/babbage3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage, type StudioStage } from './studiostage';
import { fitView } from '../gl/kit/scene';
import { BEAT_LAYERS, ENGINE_BOX, FRAME_GROUPS, HOME, babbageModel, type BabLayer, type BabbageLook } from './babbage3dkit';
import {
  ADD_UNITS, ARMS, CASES, DIGITS, carryUnits, predictVerdict, runCase, columnReads, digitGroups, PER_COLUMN, TURN_MAX, advanceTo, anticipate, finishCarry, begin, finished, fromValue, gateRows, giveOff,
  nextFiring, sweep, valueOf, type Carry, type Case, type Column,
} from './babbage3dparts';

export function babbageView(): Widget {
  let cs = CASES[1], base: Column = fromValue(cs.start), s: Carry = begin(base), phase: 'ready' | 'carry' | 'done' = 'ready';
  let anticipating = false, goal: 'next' | 'all' | null = null, target = 0, said = '', guess = 0, verdictDone = false, verdict = '';

  const panel = h('div', { class: 'panel bb3d' });
  /** The reader's layers (the chip); the tour's beats lend their own while they play and give these back at its end. */
  const mine = new Set<BabLayer>();
  let shown: ReadonlySet<BabLayer> = mine, stageRef: StudioStage | null = null, flatAt = 0;
  /** Until the stage resolves the theme's colours (the first build runs inside studioStage). */
  const FALLBACK: BabbageLook['rgb'] = { brass: [0.78, 0.6, 0.3], warn: [0.95, 0.62, 0.2], nine: [1, 0.45, 0.65], live: [0.3, 0.85, 0.5], ink: [0.1, 0.1, 0.12] };
  const rgb = (): BabbageLook['rgb'] => {
    const t = stageRef;
    return t ? { brass: t.rgb('--bb-wheel'), warn: t.rgb('--bb-warn'), nine: t.rgb('--bb-nine'), live: t.rgb('--m3-charge'), ink: t.rgb('--bb-tick') } : FALLBACK;
  };
  const foresee = (): boolean[] | null => anticipating && phase === 'carry' ? anticipate(s.col).carryIn : null;
  const stage = studioStage({
    aria: 'One column of Difference Engine No. 2 in 3D: thirty-one toothed figure wheels with their numerals, a three-limbed carry lever behind each on the warning axis, and the carry axis with its helix of thirty carry arms; a layer shows the whole engine with a person beside it',
    home: HOME,
    homeFrame: ['colbox'],
    hidden: [...FRAME_GROUPS],
    limits: { minDist: 150, maxDist: 9000, maxPan: 3000 },
    onBeat: (i) => { shown = i >= 0 ? new Set(BEAT_LAYERS[i] ?? []) : mine; syncChip(); stage.refresh(); },
    note: 'One column of eight is drawn. Its parts are the Technical Description’s (Swade, 2020, A/171): figure wheels of 40 teeth with four decades of numerals, 9° a unit; three-limbed carry levers on the warning axis at 12 o’clock to the wheels; the carry axis with thirty arms in a helix. Their sizes and the axes’ positions are illustrative: the sources read give none. The sector drive, the locks and the detent springs are left out, and the motion is a drawing of the mechanism’s states, not a kinematic model. The anticipating carriage was not fitted to this engine: its effect is drawn (every carry of a run at once), its linkage is not; the look-ahead bar is that effect only. The order the arms are swept in is derived from the pitch, the gap and the two turns the model takes, not quoted. The whole engine’s outline is the Computer History Museum’s 7 ft × 11 ft × 18 in; the other columns’ places in it are illustrative. On the time bars the nine units to add and the one to carry are Babbage’s (Passages, ch. VIII, for the anticipating carriage); the successive carriage is drawn at one unit per turn of the carry axis, the model’s scale, not a measurement.',
    build: (detail) => babbageModel({ detail, col: s.col, carry: phase === 'ready' ? null : s, foresee: foresee(), lookAhead: anticipating, layers: shown, rgb: rgb() }),
  });
  stageRef = stage;
  /** The flat drawing is redrawn at most every 150 ms while the axis turns (its SVG is costly). */
  function paint(frame = false): void { const now = performance.now(); if (!(frame && stage.isFlat() && now - flatAt < 150)) { flatAt = now; stage.refresh(); } }
  const engineChip = h('button', { type: 'button', class: 'btn sm', title: 'The whole engine’s outline, the other seven columns and a person for scale', 'aria-pressed': 'false' }, 'The whole engine') as HTMLButtonElement;
  engineChip.addEventListener('click', () => {
    if (shown !== mine) { mine.clear(); for (const l of shown) mine.add(l); }
    if (mine.has('engine')) mine.delete('engine'); else mine.add('engine');
    shown = mine; syncChip(); stage.refresh();
    // the whole engine comes with its own view: the outline and the person, the column a strip at its end
    const st = stage.studio(), cv = stage.el.querySelector('canvas');
    if (!st || !cv) return;
    if (!shown.has('engine')) { st.camera.reset(); st.invalidate(); return; }
    const yaw = -0.35, pitch = 0.18, f = fitView(ENGINE_BOX, yaw, pitch, st.camera.fov, cv.clientWidth / Math.max(1, cv.clientHeight), 0.06), c = st.camera;
    c.target = f.target; c.yaw = yaw; c.pitch = pitch; c.dist = f.dist;
    st.invalidate();
  });
  function syncChip(): void { const on = shown.has('engine'); engineChip.classList.toggle('on', on); engineChip.setAttribute('aria-pressed', String(on)); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), digits = h('div', { class: 'bb-digits', role: 'img' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  const gates = h('table', { class: 'bb-gates' });
  const bars = h('div', { class: 'bb-bars', role: 'img', 'aria-label': 'Time on one axis: nine units to add, then the carriage' });
  const verdictEl = h('p', { class: 'bb-verdict', 'aria-live': 'polite' });
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
      return h('span', { class: `bb-d${s.col.w[i] === 9 ? ' nine' : ''}${s.col.warn[i] ? ' armed' : ''}${fs?.[i] ? ' recv' : ''}` }, d);
    }))));
    const v = valueOf(s.col), flag = s.col.warn[DIGITS - 1] ? ' with the overflow flag set' : '';
    digits.setAttribute('aria-label', `Column reads ${columnReads(v)}${flag}; ${armed} warning lever${armed === 1 ? '' : 's'} armed`);
    const runLen = plan.longest;
    // one axis for both carriages: Babbage's nine units to add, then the carriage in units (successive: the carry axis's turns)
    const uS = carryUnits(false, plan.lastT, plan.fired.length), uA = carryUnits(true, plan.lastT, plan.fired.length), f1 = (x: number) => +x.toFixed(2);
    const unit = `${phase === 'done' ? 'axis turned to' : `axis at ${Math.round(s.theta)}° of ${TURN_MAX}° (two turns); last carry at`} ${Math.round(plan.lastT)}°${plan.lastT >= 360 ? ' (second rotation)' : ''}`;
    const rows: [string, string][] = [
      ['Case', cs.blurb],
      ['Warning latches armed', String(armed)],
      ['Carries fired so far', String(s.fired.length)],
      ['Longest run of carries', phase === 'ready' ? '–' : String(runLen)],
      [anticipating ? 'Carry axis (not used)' : 'Carry axis', phase === 'ready' ? '–' : plan.fired.length === 0 ? 'nothing to carry' : anticipating ? 'the look-ahead replaces it' : unit],
      ['Time, successive', phase === 'ready' ? '–' : `${ADD_UNITS} + ${f1(uS)} = ${f1(ADD_UNITS + uS)} units`],
      ['Time, anticipating', phase === 'ready' ? '–' : `${ADD_UNITS} + ${uA} = ${ADD_UNITS + uA} units`],
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
    bars.replaceChildren(...([['Successive', uS, !anticipating], ['Anticipating', uA, anticipating]] as [string, number, boolean][]).map(([name, u, on]) => h('div', { class: `bb-bar${on ? ' on' : ''}`, title: `${name}: ${ADD_UNITS} units to add, then ${f1(u)} to carry` },
      h('span', { class: 'bb-bn' }, name), h('span', { class: 'bb-track' }, h('i', { class: 'add', style: `width:${(ADD_UNITS / 11) * 100}%` }), phase === 'ready' ? null : h('i', { class: 'car', style: `width:${(u / 11) * 100}%` })))));
    if (cs.id === 'custom' && phase === 'done' && !verdictDone) { verdictDone = true; verdict = predictVerdict(guess, plan.fired.length); }
    verdictEl.textContent = cs.id === 'custom' ? (phase === 'done' ? verdict : `Guess how many arms fire when ${runN} nines get a 1 added, then Add and Run carry.`) : '';
    predictRow.style.display = cs.id === 'custom' ? '' : 'none';
    const text = phase === 'ready' ? 'Press Add: every wheel advances, and a wheel passing 9 to 0 arms its warning lever without carrying.'
      : phase === 'carry' ? `${armed} warning lever${armed === 1 ? ' is' : 's are'} armed. ${anticipating ? 'The anticipating carriage settles every carry of a run in one unit.' : 'The carry axis turns and its arms poll the wheels from below.'}`
      : `Carried: the column reads ${columnReads(v)}${flag}.`;
    if (!goal && text !== said) { said = text; live.textContent = text; }
  }
  const settle = () => { if (phase === 'carry' && goal === null && finished(s)) { phase = 'done'; s = finishCarry(s); } };
  const repaint = () => { settle(); readout(); paint(); loop.kick(); };

  const loop = frameLoop((_now, dt) => {
    if (goal) {
      const want = goal === 'next' ? target : TURN_MAX, speed = goal === 'next' ? Math.max(200, (target - s.theta) / 0.35) : 170;
      s = advanceTo(s, Math.min(want, s.theta + speed * dt));
      if (goal === 'next' ? s.theta >= target : finished(s) || s.theta >= TURN_MAX) goal = null;
      settle();
    }
    readout(); paint(true);
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

  const sel = h('select', { id: 'bb-case', 'aria-label': 'Case' }, ...CASES.map((c) => h('option', { value: c.id }, c.label)), h('option', { value: 'custom' }, 'Your own run of 9s (predict)')) as HTMLSelectElement;
  sel.value = cs.id;
  sel.addEventListener('change', () => { cs = pick(); reset(); });
  let runN = 12;
  const pick = (): Case => (sel.value === 'custom' ? runCase(runN) : CASES.find((c) => c.id === sel.value)!);
  function reset(): void { verdictDone = false; verdict = ''; base = fromValue(cs.start); s = begin(base); phase = 'ready'; goal = null; repaint(); }
  const addBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Add') as HTMLButtonElement;
  addBtn.addEventListener('click', addAction);
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Next carry') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => carryAction(false));
  const runBtn = h('button', { type: 'button', class: 'btn sm' }, 'Run carry') as HTMLButtonElement;
  runBtn.addEventListener('click', () => carryAction(true));
  const modeBtn = h('button', { type: 'button', class: 'btn sm bb-mode', 'aria-pressed': 'false' }, 'Anticipating carriage') as HTMLButtonElement;
  modeBtn.addEventListener('click', () => { anticipating = !anticipating; repaint(); });
  const runOut = h('output', null, String(runN)), guessIn = h('input', { type: 'number', min: 0, max: ARMS, step: 1, value: 0, 'aria-label': 'Your guess: arms that fire' }) as HTMLInputElement;
  const runIn = h('input', { type: 'range', min: 1, max: ARMS, step: 1, value: runN, 'aria-label': 'Nines in the run' }) as HTMLInputElement;
  runIn.addEventListener('input', () => { runN = Number(runIn.value); runOut.textContent = String(runN); if (cs.id === 'custom') { cs = runCase(runN); reset(); } });
  guessIn.addEventListener('input', () => { guess = Math.round(Number(guessIn.value)); verdictDone = false; });
  const predictRow = h('div', { class: 'bb-predict' }, h('label', { class: 'r3-sl' }, h('span', null, 'Nines in the run'), runIn, runOut),
    h('label', { class: 'bb-guess' }, h('span', null, 'Your guess: arms that fire'), guessIn));
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Start over') as HTMLButtonElement;
  resetBtn.addEventListener('click', reset);

  panel.append(
    h('h3', { class: 'm3-title' }, 'Babbage’s carry, in brass'),
    h('p', { class: 'm3-sub' }, 'Babbage’s Difference Engine No. 2 (designed 1847 to 1849; its calculating section built by the Science Museum, completed 1991): one column of 31 figure wheels, units wheel at the bottom. Adding gives every wheel its digit; a wheel that passes 9 to 0 arms its warning lever and carries nothing yet. Then the carry axis turns and its helix of 30 arms polls the levers from below, 22° apart: an armed lever advances the wheel above, and if that wheel passes 9 to 0 its own lever arms for the next arm, still to come. That is successive carriage: a run of 9s ripples one arm at a time, like a ripple-carry adder. Switch to the anticipating carriage and the whole run carries in one unit, as Babbage describes it for the Analytical Engine.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('label', { class: 'bb-case' }, h('span', null, 'Case'), sel), h('div', { class: 'r3-btns' }, addBtn, stepBtn, runBtn, modeBtn, resetBtn, engineChip)),
        digits, predictRow, stage.el, live, verdictEl, bars),
      h('div', { class: 'r3-side' }, h('h4', null, 'This column ', h('span', { class: 'r3-badge' }, 'model')), kv,
        h('h4', null, 'The site’s adders, NAND delays'), gates)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
