// Kelvin's tide predictor in 3D (loaded on demand, modelhost.ts), driven by the chapter's own harmonics: the cranks turn
// comm/fourier.ts's series for the chosen pattern, and the pen's height is read off the cord's constant length
// (tide3dparts.ts penTip), not from the sum. The readout sets the pen against the chapter's sumAt.

import '../styles/tide3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { gibbsPeak, PATTERNS } from '../comm/fourier';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { N_CRANKS, PEN_SCALE, angleOf, levelOf, offsetsAt, penTip, tideAnchors, tideOf, tideParts, type TidePalette } from './tide3dparts';
import type { OrbitView } from '../gl/camera';

/** Seconds a period takes on Run, and the stepped part of a period; a reduced-motion run steps every STEP_S. */
const PERIOD_S = 14, STEP_FRAC = 1 / 20, STEP_S = 0.6;
const VIEW: OrbitView = { target: [31, 46, 0], yaw: 0.16, pitch: 0.24, dist: 242 };
/** Signed to d places, with no '−0.000': a value that rounds to zero has no sign. */
const sg = (v: number, d = 3) => (v < 0 && Math.abs(v) >= 0.5 * 10 ** -d ? '−' : '') + Math.abs(v).toFixed(d);

export function tideView(): Widget {
  let pat = 0, td = tideOf(0), t = 0, running = false, tauStep = 0;
  const on: boolean[] = Array(N_CRANKS).fill(true);

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'Kelvin’s tide predictor in 3D: ten cranks, each moving a pulley up and down on a slider, one cord running under every movable pulley and over a fixed pulley between them, and a pen at its end drawing on a moving band of paper',
    camera: { ...VIEW },
    limits: { minDist: 60, maxDist: 700 },
    note: 'Only the overall box (1820 × 1000 × 770 mm) and the ten cranks are Thomson’s; pulley sizes, the crank-and-yoke drive, the layout and the pen scale are drawn, not measured. The cranks turn the chapter’s harmonics, not tidal constituents, the cord is thicker than a real one, the paper moves at a rate chosen to show two periods, and a year of tide takes hours on the real machine, not seconds. A crank switched off is drawn disengaged (grey) and its pulley stays at rest.',
    draw: () => paint(),
  });
  const palette = (): TidePalette => ({
    iron: stage.rgb('--td-iron'), brass: stage.rgb('--td-brass'), wood: stage.rgb('--td-wood'), steel: stage.rgb('--td-steel'), cord: stage.rgb('--td-cord'),
    paper: stage.rgb('--td-paper'), ink: stage.rgb('--td-trace'), off: stage.rgb('--td-off'), glass: stage.rgba('--td-glass', 0.55), live: stage.rgb('--m3-charge'),
  });
  function paint(): void { stage.paint(tideParts(td, on, t, palette(), stage.isFlat()), tideAnchors(td)); }

  const kv = h('div', { class: 'r3-kv' }), tab = h('table', { class: 'td-tab' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  const chip = h('span', { class: 'r3-chip' });
  stage.chips.append(chip);
  const count = () => on.filter(Boolean).length;

  function readout(announce = false): void {
    const d = offsetsAt(td, on, t), tip = penTip(d, td.dc), level = levelOf(tip);
    // The chapter's sum for the same cranks: sumAt takes a prefix, so add the engaged harmonics one by one (dc included).
    let sum = td.dc;
    td.harms.forEach((hm, i) => { if (on[i]) sum += hm.amp * Math.cos(angleOf(hm, td.n, t)); });
    const rows: [string, string][] = [
      ['Time', `${(t / td.n).toFixed(2)} periods (${t.toFixed(2)} bits)`],
      ['Cranks engaged', `${count()} of ${N_CRANKS}`],
      ['Pen, from the cord', `${sg(level, 4)}`],
      ['Chapter’s sum', `${sg(sum, 4)}`],
    ];
    const pre = on.every((v, i) => v === (i < count()));
    if (pre && pat === 0 && count() > 0) rows.push([`Peak of ${count()} harmonics`, `${gibbsPeak(count()).toFixed(4)} (Gibbs)`]);
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    chip.textContent = `${count()} of ${N_CRANKS} cranks · pen ${sg(level, 3)}`;
    chip.className = 'r3-chip good';
    tab.replaceChildren(
      h('thead', null, h('tr', null, ...['k', 'A', 'φ°', 'crank angle°', 'slide'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, ...td.harms.map((hm, i) => h('tr', { class: on[i] ? '' : 'off' },
        h('td', null, String(hm.k)), h('td', null, hm.amp.toFixed(3)), h('td', null, ((hm.phase * 180) / Math.PI).toFixed(0)),
        h('td', null, String(Math.round((((angleOf(hm, td.n, t) * 180) / Math.PI) % 360 + 360) % 360))), h('td', null, sg(d[i] / (PEN_SCALE / 2), 3))))));
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = `${(t / td.n).toFixed(2)} periods, ${count()} of ${N_CRANKS} cranks engaged. Pen at ${sg(level, 3)}; the chapter’s sum is ${sg(sum, 3)}.`;
    if (live.textContent !== text) live.textContent = text;
  }

  const loop = frameLoop((_now, dt) => {
    if (running) {
      if (reducedMotion()) { tauStep += dt; if (tauStep >= STEP_S) { tauStep = 0; t += td.n * STEP_FRAC; } } // steps, no smooth turning
      else t += (dt * td.n) / PERIOD_S;
    }
    readout(); paint();
  }, () => running);
  const kick = () => { readout(); paint(); loop.kick(); };

  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; tauStep = 0; if (!running) readout(true); kick(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step 1/20 period');
  stepBtn.addEventListener('click', () => { running = false; t += td.n * STEP_FRAC; readout(true); kick(); });
  const startBtn = h('button', { type: 'button', class: 'btn sm' }, 'Start over');
  startBtn.addEventListener('click', () => { running = false; t = 0; readout(true); kick(); });

  const crankBtns = td.harms.map((hm, i) => {
    const b = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'true', 'aria-label': `Crank ${i + 1}, harmonic ${hm.k}`, title: `Harmonic ${hm.k}: engage or disengage this crank` }, String(hm.k)) as HTMLButtonElement;
    b.addEventListener('click', () => { on[i] = !on[i]; syncBtns(); readout(true); kick(); });
    return b;
  });
  function syncBtns(): void {
    crankBtns.forEach((b, i) => { b.classList.toggle('on', on[i]); b.setAttribute('aria-pressed', String(on[i])); });
  }
  const setFirst = (c: number) => { on.forEach((_, i) => { on[i] = i < c; }); syncBtns(); readout(true); kick(); };
  const allBtn = h('button', { type: 'button', class: 'btn sm' }, 'All');
  allBtn.addEventListener('click', () => setFirst(N_CRANKS));
  const oneBtn = h('button', { type: 'button', class: 'btn sm' }, 'Fundamental only');
  oneBtn.addEventListener('click', () => setFirst(1));

  const sel = h('select', { class: 'td-sel', 'aria-label': 'Bit pattern, as in the step’s widget' }, ...PATTERNS.map((p, i) => h('option', { value: String(i) }, p.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => {
    pat = Number(sel.value); td = tideOf(pat); t = 0; running = false;
    crankBtns.forEach((b, i) => { b.textContent = String(td.harms[i].k); b.setAttribute('aria-label', `Crank ${i + 1}, harmonic ${td.harms[i].k}`); });
    readout(true); kick();
  });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The sum as a machine'),
    h('p', { class: 'm3-sub' }, 'Kelvin’s tide predictor, 1872–73, built for Thomson by A. Légé & Co. Each of its ten cranks turned at its own rate and moved a pulley up and down on a slider; one cord, fixed at one end, ran under each movable pulley and over a fixed one, and a pen hung from its other end. A pulley that moves d takes up 2d of cord, so the pen moves by the sum of the pulleys’ motions, 2 Σ dᵢ. Here the ten cranks are the first ten harmonics of the step’s own pattern, and the pen is the sum above, drawn on paper.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'td-lbl' }, 'Pattern ', sel),
          h('div', { class: 'r3-btns' }, runBtn, stepBtn, startBtn, stage.resetBtn)),
        h('div', { class: 'r3-ctl' },
          h('span', { class: 'td-lbl', id: 'td-cranks-l' }, 'Cranks (harmonic k)'),
          h('div', { class: 'td-cranks', role: 'group', 'aria-labelledby': 'td-cranks-l' }, ...crankBtns, allBtn, oneBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'The pen ', h('span', { class: 'r3-badge' }, 'the chapter’s sum')), kv, h('h4', null, 'The cranks'), tab,
        h('p', { class: 'r3-hint' }, 'k: cycles a period · A: amplitude · φ: phase · slide: the pulley’s motion in units of A. The machine is a mechanical inverse DFT: a sum of cosines at set rates, phases and amplitudes.'))));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
