// Kelvin's tide predictor in 3D (loaded on demand, modelhost.ts), driven by the chapter's own harmonics: the cranks turn
// comm/fourier.ts's series for the chosen pattern, and the pen's height is read off the cord's constant length
// (tide3dparts.ts penTip), not from the sum. The readout sets the pen against the chapter's sumAt. A last preset swaps the
// harmonics for ten tidal constituents at their true speeds, where the spring-neap beat appears by itself.

import '../styles/tide3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { gibbsPeak, PATTERNS } from '../comm/fourier';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import {
  N_CRANKS, PEN_SCALE, TIDE_PRESET, angleOf, beatHours, levelOf, offsetsAt, penTip, ratioOf, throwMm, tideAnchors, tideOf, tideParts, type TidePalette,
} from './tide3dparts';
import type { OrbitView } from '../gl/camera';

/** Seconds a period (a spring-neap cycle on the tide) takes on Run; a reduced-motion run steps every STEP_S. */
const PERIOD_S = 14, STEP_S = 0.6;
const VIEW: OrbitView = { target: [31, 46, 0], yaw: 0.16, pitch: 0.24, dist: 242 };
/** Signed to d places, with no '−0.000': a value that rounds to zero has no sign. */
const sg = (v: number, d = 3) => (v < 0 && Math.abs(v) >= 0.5 * 10 ** -d ? '−' : '') + Math.abs(v).toFixed(d);
const deg = (r: number) => (((r * 180) / Math.PI) % 360 + 360) % 360;

export function tideView(): Widget {
  let pat = 0, td = tideOf(0), t = 0, running = false, tauStep = 0, tuned = false, cal = 0;
  const on: boolean[] = Array(N_CRANKS).fill(true);
  const isTide = () => td.kind === 'tide';

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'Kelvin’s tide predictor in 3D: ten slotted cranks driven by one hand crank through a gear each, every crank moving a pulley up and down on a slider, one cord running under every movable pulley and over a fixed pulley between them, and a pen at its end drawing on a moving band of paper between two rollers',
    camera: { ...VIEW },
    limits: { minDist: 60, maxDist: 700 },
    note: 'Sources: Science Museum Group object 1876-1129 (the 1872 machine by A. Légé & Co. for Thomson: 1820 × 1000 × 770 mm, 86 kg, ten components); W. Thomson, “The tide gauge, tidal harmonic analyser, and tide predicter”, Proc. Inst. Civil Eng. 65 (1881); Parker, Tide Analysis and Prediction (NOAA, 2007). The record gives the count of components, not their list or the machine’s gear trains. Drawn, not measured: the layout, the Scotch-yoke cranks (the throw is a slot and scale here), the change wheels (pitch circles sized by the speed ratio, no teeth, one pair on a 48 mm centre distance), the pulleys (44 and 56 mm across, about 50 mm on the machine) and the cord, which is much thicker than a real one; the pen scale and the paper speed are chosen to show the curve. The default cranks turn the chapter’s harmonics (integer rates, so the curve repeats); “Real tide” runs ten constituents at their IHO speeds with illustrative amplitudes and phases of no real port. A crank switched off is drawn disengaged (grey) and its pulley stays at rest. A year of tide took the real machine about four hours of hand cranking.',
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
  const when = (x: number) => (isTide() ? `${(x / 24).toFixed(2)} days (${x.toFixed(1)} h)` : `${(x / td.n).toFixed(2)} periods (${x.toFixed(2)} bits)`);

  function readout(announce = false): void {
    const d = offsetsAt(td, on, t), tip = penTip(d, td.dc), level = levelOf(tip), u = isTide() ? ' m' : '';
    // The chapter's sum for the same cranks: sumAt takes a prefix, so add the engaged harmonics one by one (dc included).
    let sum = td.dc;
    td.harms.forEach((hm, i) => { if (on[i]) sum += hm.amp * Math.cos(angleOf(hm, td.n, t)); });
    const rows: [string, string][] = [
      ['Time', when(t)],
      ['Cranks engaged', `${count()} of ${N_CRANKS}`],
      ['Pen, from the cord', `${sg(level, 4)}${u}`],
      [isTide() ? 'Sum of the constituents' : tuned ? 'Sum of the cranks as set' : 'Chapter’s sum', `${sg(sum, 4)}${u}`],
    ];
    const pre = on.every((v, i) => v === (i < count()));
    if (pre && pat === 0 && !tuned && count() > 0) rows.push([`Peak of ${count()} harmonics`, `${gibbsPeak(count()).toFixed(4)} (Gibbs)`]);
    if (isTide()) {
      const [m2, s2] = td.harms, beat = beatHours(m2.k, s2.k);
      rows.push(['M2 against S2: spring-neap beat', `${beat.toFixed(1)} h = ${(beat / 24).toFixed(2)} days`]);
      if (on[0] && on[1]) {
        const dl = angleOf(s2, td.n, t) - angleOf(m2, td.n, t), env = Math.hypot(m2.amp + s2.amp * Math.cos(dl), s2.amp * Math.sin(dl)), dd = deg(dl);
        rows.push(['M2 + S2 amplitude', `${env.toFixed(3)} m · ${dd < 45 || dd > 315 ? 'springs' : dd > 135 && dd < 225 ? 'neaps' : 'between'}`]);
      }
    }
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    chip.textContent = `${count()} of ${N_CRANKS} cranks · pen ${sg(level, 3)}${u}`;
    chip.className = 'r3-chip good';
    const head = isTide() ? ['', '°/h', 'A m', 'φ°', 'throw mm', 'gear', 'angle°', 'slide'] : ['k', 'A', 'φ°', 'throw mm', 'gear', 'angle°', 'slide'];
    tab.replaceChildren(
      h('thead', null, h('tr', null, ...head.map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, ...td.harms.map((hm, i) => {
        const r = ratioOf(td, hm), cells = [
          td.names[i], ...(isTide() ? [hm.k.toFixed(3)] : []), hm.amp.toFixed(3), String(Math.round(deg(hm.phase))), throwMm(hm).toFixed(0),
          `${r.toFixed(r < 10 ? 3 : 2)}:1`, String(Math.round(deg(angleOf(hm, td.n, t)))), sg(d[i] / (PEN_SCALE / 2), 3),
        ];
        return h('tr', { class: on[i] ? '' : 'off' }, ...cells.map((c) => h('td', null, c)));
      })));
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = `${when(t)}, ${count()} of ${N_CRANKS} cranks engaged. Pen at ${sg(level, 3)}${u}; the ${isTide() ? 'sum of the constituents' : 'chapter’s sum'} is ${sg(sum, 3)}.`;
    if (live.textContent !== text) live.textContent = text;
  }

  const loop = frameLoop((_now, dt) => {
    if (running) {
      if (reducedMotion()) { tauStep += dt; if (tauStep >= STEP_S) { tauStep = 0; t += td.stepT; } } // steps, no smooth turning
      else t += (dt * td.runT) / PERIOD_S;
    }
    readout(); paint();
  }, () => running);
  const kick = () => { readout(); paint(); loop.kick(); };

  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; tauStep = 0; if (!running) readout(true); kick(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step 1/20 period');
  stepBtn.addEventListener('click', () => { running = false; t += td.stepT; readout(true); kick(); });
  const startBtn = h('button', { type: 'button', class: 'btn sm' }, 'Start over');
  startBtn.addEventListener('click', () => { running = false; t = 0; readout(true); kick(); });

  const crankBtns = td.harms.map((_, i) => {
    const b = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'true' }) as HTMLButtonElement;
    b.addEventListener('click', () => { on[i] = !on[i]; syncBtns(); readout(true); kick(); });
    return b;
  });
  function syncBtns(): void {
    crankBtns.forEach((b, i) => {
      b.classList.toggle('on', on[i]); b.setAttribute('aria-pressed', String(on[i]));
      b.textContent = td.names[i];
      b.setAttribute('aria-label', `Crank ${i + 1}, ${isTide() ? `constituent ${td.names[i]}` : `harmonic ${td.names[i]}`}`);
      b.title = `${isTide() ? `${td.names[i]}, ${td.harms[i].k.toFixed(4)} °/h` : `Harmonic ${td.names[i]}`}: engage or disengage this crank`;
    });
  }
  const setFirst = (c: number) => { on.forEach((_, i) => { on[i] = i < c; }); syncBtns(); readout(true); kick(); };
  const allBtn = h('button', { type: 'button', class: 'btn sm' }, 'All');
  allBtn.addEventListener('click', () => setFirst(N_CRANKS));
  const oneBtn = h('button', { type: 'button', class: 'btn sm' }, 'Fundamental only');
  oneBtn.addEventListener('click', () => setFirst(1));
  const crankLbl = h('span', { class: 'td-lbl', id: 'td-cranks-l' }, 'Cranks (harmonic k)');

  // Calibration: the throw (amplitude) and phase of one crank, as the machine's operator set them.
  const calSel = h('select', { class: 'td-sel', 'aria-label': 'Crank to calibrate' }) as HTMLSelectElement;
  const ampIn = h('input', { type: 'range', min: '0', max: '1.4', step: '0.01', 'aria-label': 'Amplitude of this crank (its throw)' }) as HTMLInputElement;
  const phIn = h('input', { type: 'range', min: '0', max: '359', step: '1', 'aria-label': 'Phase of this crank, degrees' }) as HTMLInputElement;
  const ampOut = h('span', { class: 'td-val' }), phOut = h('span', { class: 'td-val' });
  const resetCal = h('button', { type: 'button', class: 'btn sm' }, 'Reset cranks') as HTMLButtonElement;
  function syncCal(): void {
    const hm = td.harms[cal];
    calSel.replaceChildren(...td.names.map((n, i) => h('option', { value: String(i) }, isTide() ? n : `k = ${n}`)));
    calSel.value = String(cal);
    ampIn.value = String(hm.amp); phIn.value = String(Math.round(deg(hm.phase)));
    ampOut.textContent = `${hm.amp.toFixed(2)}${isTide() ? ' m' : ''} · throw ${throwMm(hm).toFixed(0)} mm`;
    phOut.textContent = `${Math.round(deg(hm.phase))}°`;
    resetCal.disabled = !tuned;
  }
  calSel.addEventListener('change', () => { cal = Number(calSel.value); syncCal(); });
  const edit = () => {
    td.harms[cal] = { ...td.harms[cal], amp: Number(ampIn.value), phase: (Number(phIn.value) * Math.PI) / 180 };
    tuned = true; syncCal(); readout(true); kick();
  };
  ampIn.addEventListener('input', edit); phIn.addEventListener('input', edit);
  resetCal.addEventListener('click', () => { td = tideOf(pat); tuned = false; syncCal(); readout(true); kick(); });

  const sel = h('select', { class: 'td-sel', 'aria-label': 'Cranks: a bit pattern, as in the step’s widget, or the real tide' },
    ...PATTERNS.map((p, i) => h('option', { value: String(i) }, p.name)), h('option', { value: String(TIDE_PRESET) }, 'Real tide: 10 constituents')) as HTMLSelectElement;
  function load(): void {
    td = tideOf(pat); t = 0; running = false; tuned = false; cal = 0;
    stepBtn.textContent = isTide() ? 'Step 1 day' : 'Step 1/20 period';
    crankLbl.textContent = isTide() ? 'Cranks (constituent)' : 'Cranks (harmonic k)';
    syncBtns(); syncCal();
  }
  sel.addEventListener('change', () => { pat = Number(sel.value); load(); readout(true); kick(); });
  load();

  panel.append(
    h('h3', { class: 'm3-title' }, 'The sum as a machine'),
    h('p', { class: 'm3-sub' }, 'Kelvin’s tide predictor, 1872–73, built for Thomson by A. Légé & Co. One hand crank turned a main shaft; a change wheel on it drove each of ten cranks at its own rate, and each crank’s slot set its throw and its phase. A crank moved a pulley up and down on a slider (a Scotch yoke); one cord, fixed at one end, ran under each movable pulley and over a fixed one, and a pen hung from its other end on a band of paper that the same shaft carried past. A pulley that moves d takes up 2d of cord, so the pen moves by the sum of the pulleys’ motions, 2 Σ dᵢ. Here the ten cranks are the first ten harmonics of the step’s own pattern, and the pen is the sum above, drawn on paper. Choose “Real tide” for ten tidal constituents at their true speeds: they are not multiples of one another, so the curve never repeats, and M2 against S2 beats every 14.77 days.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'td-lbl' }, 'Cranks ', sel),
          h('div', { class: 'r3-btns' }, runBtn, stepBtn, startBtn, stage.resetBtn)),
        h('div', { class: 'r3-ctl' },
          crankLbl,
          h('div', { class: 'td-cranks', role: 'group', 'aria-labelledby': 'td-cranks-l' }, ...crankBtns, allBtn, oneBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'The pen ', h('span', { class: 'r3-badge' }, 'the sum of the cranks')), kv,
        h('h4', null, 'Calibrate a crank'),
        h('div', { class: 'td-cal' }, h('label', { class: 'td-lbl' }, 'Crank ', calSel),
          h('label', { class: 'td-lbl' }, 'Throw ', ampIn, ampOut), h('label', { class: 'td-lbl' }, 'Phase ', phIn, phOut), resetCal),
        h('h4', null, 'The cranks'), h('div', { class: 'td-tabwrap' }, tab),
        h('p', { class: 'r3-hint' }, 'k: cycles a period, or the speed in °/h · A: amplitude · φ: phase · throw: the crank slot’s radius (30 mm an A) · gear: crank turns per hand-crank turn (a turn is one period, or one day on the tide) · slide: the pulley’s motion in units of A. The machine is a mechanical inverse DFT: a sum of cosines at set rates, phases and amplitudes.'))));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
