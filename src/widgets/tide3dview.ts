// Kelvin's tide predictor in 3D (loaded on demand, modelhost.ts), driven by the chapter's own harmonics: the cranks turn
// comm/fourier.ts's series for the chosen pattern, and the pen's height is read off the cord's constant length
// (tide3dparts.ts penTip), not from the sum. The readout sets the pen against the chapter's sumAt. A last preset swaps the
// harmonics for ten tidal constituents at their true speeds, where the spring-neap beat appears by itself. A switch sets the
// mechanism: the 1872 machine's pulleys on crank pins (the pen is the sum only nearly) or the later slotted yokes (exactly).

import '../styles/tide3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { gibbsPeak, PATTERNS } from '../comm/fourier';
import { frameLoop } from './mosfet';
import { refresh } from '../gl/kit/geo';
import { studioStage } from './studiostage';
import { cordAt, cordOf, newPaper, paintPaper, tideModel, tidePose, TIDE_HOME, type TideState } from './tide3dkit';
import {
  N_CRANKS, PEN_SCALE, TIDE_PRESET, angleOf, beatHours, levelOf, offsetsAt, penTip, ratioOf, sidewaysAt, throwMm, tideOf, type Mech,
} from './tide3dparts';

/** Seconds a period (a spring-neap cycle on the tide) takes on Run; a reduced-motion run steps every STEP_S. */
const PERIOD_S = 14, STEP_S = 0.6;
/** Signed to d places, with no '−0.000': a value that rounds to zero has no sign. */
const sg = (v: number, d = 3) => (v < 0 && Math.abs(v) >= 0.5 * 10 ** -d ? '−' : '') + Math.abs(v).toFixed(d);
const deg = (r: number) => (((r * 180) / Math.PI) % 360 + 360) % 360;

export function tideView(): Widget {
  let pat = 0, td = tideOf(0), t = 0, running = false, tauStep = 0, tuned = false, cal = 0, mech: Mech = 'pins';
  const on: boolean[] = Array(N_CRANKS).fill(true);
  const isTide = () => td.kind === 'tide';

  const panel = h('div', { class: 'panel m3d' });
  const paper = newPaper(), state = (): TideState => ({ td, on, t, mech, paper });
  const stage = studioStage({
    aria: 'Kelvin’s tide predictor in 3D: ten slotted cranks driven by one hand crank through a gear each, every crank carrying a pulley on its pin (or, switched, on a slotted yoke), one cord running under every movable pulley and over a fixed pulley between them, and a pen at its end drawing on a moving band of paper between two rollers',
    home: TIDE_HOME,
    // home: the ten cranks, their pulleys and the cord across the width (the cord is the idea: it adds); the paper's whole width inside at the right
    homeFrame: ['fixed', 'cord', 'paper band', ...Array.from({ length: N_CRANKS }, (_, i) => `crank${i}`)],
    aspect: 1.5,
    scaleBar: (len) => `${+(len * 10).toPrecision(3)} mm`,
    limits: { minDist: 60, maxDist: 700 },
    note: `A drawing after Thomson’s 1872 machine (Science Museum 1876-1129, ten components): the layout, cranks, gearing and pulleys are drawn, not measured, and the cord is drawn far thicker than its catgut so it can be followed. “Real tide” runs ten constituents at their IHO speeds with illustrative amplitudes and phases, of no real port. A year of tide took the real machine about four hours of cranking.`,
    noteMore: 'Sources: Science Museum Group object 1876-1129 (the 1872 machine by A. Légé & Co. for Thomson: 1820 × 1000 × 770 mm, 86 kg, ten components); W. Thomson, “The tide gauge, tidal harmonic analyser, and tide predicter”, Proc. Inst. Civil Eng. 65 (1881); Parker, Tide Analysis and Prediction (NOAA, 2007). The record gives the count of components; their list (M2, S2, N2, K2, Q1, K1, L2, P1, M4, MS4) and the mechanism are from P. L. Woodworth, An inventory of tide prediction machines (NOC Research & Consultancy Report 56, 2016), after Cartwright (1999): this machine’s pulley axles moved sideways as well as up and down, which made small errors, and all later machines moved them straight up and down. Neither gives the gear trains. Drawn, not measured: the layout, the cranks (the throw is a slot and scale here), the size of the crank pins’ error (it follows the drawn proportions), the worms and worm wheels (Légé’s machine was worm-driven, after IEEE Spectrum; no tooth counts were found, so the wheels are drawn alike and each crank’s ratio is in the table), the flywheel’s size, the pulleys (44 and 56 mm across) and the cord, drawn light and far thicker than the real catgut line so that it can be followed; the pen scale and the paper speed are chosen to show the curve. The default cranks turn the chapter’s harmonics (integer rates, so the curve repeats); “Real tide” runs ten constituents at their IHO speeds with illustrative amplitudes and phases of no real port. A crank switched off is drawn disengaged (grey) and its pulley stays at rest. A year of tide took the real machine about four hours of hand cranking.',
    build: (detail) => tideModel(state(), detail),
  });
  /** The pose: the moving parts by stage.move, the cord bent in place, the paper repainted; then a rebuild (cheap: cached geometry). */
  function paint(): void {
    const s = state();
    paintPaper(paper, td, on, t, mech);
    for (const d of ['full', 'flat'] as const) { const g = cordOf(d); if (g) refresh(g, cordAt(s, d)); }
    stage.move(tidePose(s));
    stage.refresh();
  }

  const kv = h('div', { class: 'r3-kv' }), tab = h('table', { class: 'td-tab' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  const chip = h('span', { class: 'r3-chip' });
  stage.chips.append(chip);
  const count = () => on.filter(Boolean).length;
  const when = (x: number) => (isTide() ? `${(x / 24).toFixed(2)} days (${x.toFixed(1)} h)` : `${(x / td.n).toFixed(2)} periods (${x.toFixed(2)} bits)`);

  function readout(announce = false): void {
    const d = offsetsAt(td, on, t), tip = penTip(d, td.dc, sidewaysAt(td, on, t, mech)), level = levelOf(tip), u = isTide() ? ' m' : '';
    // The chapter's sum for the same cranks: sumAt takes a prefix, so add the engaged harmonics one by one (dc included).
    let sum = td.dc;
    td.harms.forEach((hm, i) => { if (on[i]) sum += hm.amp * Math.cos(angleOf(hm, td.n, t)); });
    const rows: [string, string][] = [
      ['Time', when(t)],
      ['Cranks engaged', `${count()} of ${N_CRANKS}`],
      ['Pen, from the cord', `${sg(level, 4)}${u}`],
      [isTide() ? 'Sum of the constituents' : tuned ? 'Sum of the cranks as set' : 'Chapter’s sum', `${sg(sum, 4)}${u}`],
      [mech === 'pins' ? 'Pen − sum: the crank pins’ error' : 'Pen − sum: the yokes are exact', `${sg(level - sum, 4)}${u}`],
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
          `${r.toFixed(2)} : 1`, String(Math.round(deg(angleOf(hm, td.n, t)))), sg(d[i] / (PEN_SCALE / 2), 3),
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
    td = tideOf(pat); t = td.span; running = false; tuned = false; cal = 0;
    stepBtn.textContent = isTide() ? 'Step 1 day' : 'Step 1/20 period';
    crankLbl.textContent = isTide() ? 'Cranks (constituent)' : 'Cranks (harmonic k)';
    syncBtns(); syncCal();
  }
  sel.addEventListener('change', () => { pat = Number(sel.value); load(); readout(true); kick(); });
  // The mechanism: what the 1872 machine had, or what every later machine had.
  const mechBtns = ([['pins', '1872: pulleys on crank pins'], ['yoke', 'Later: slotted yokes']] as const).map(([m, label]) => {
    const b = h('button', { type: 'button', class: 'btn sm' }, label) as HTMLButtonElement;
    b.addEventListener('click', () => { mech = m; syncMech(); readout(true); kick(); });
    return [m, b] as const;
  });
  function syncMech(): void { for (const [m, b] of mechBtns) { b.classList.toggle('on', m === mech); b.setAttribute('aria-pressed', String(m === mech)); } }
  syncMech();
  load();

  panel.append(
    h('h3', { class: 'm3-title' }, 'The sum as a machine'),
    h('p', { class: 'm3-sub' }, 'Kelvin’s tide predictor, 1872–73, built for Thomson by A. Légé & Co. One hand crank turned a main shaft; a worm on it drove each of ten cranks at its own rate, and each crank’s slot set its throw and its phase. Each movable pulley turned on its crank’s pin, so it went round with the pin: up and down, and a little sideways, which tilts the cord and puts a small error in the sum; every later machine moved its pulleys straight up and down on a slotted yoke, which is exact (the switch shows both). One cord, fixed at one end, ran under each movable pulley and over a fixed one, and a pen hung from its other end on a band of paper that the same shaft carried past. A pulley that moves d takes up 2d of cord, so the pen moves by the sum of the pulleys’ motions, 2 Σ dᵢ. Here the ten cranks are the first ten harmonics of the step’s own pattern, and the pen is the sum above, drawn on paper; each faint line on the paper is one crank’s own term, in the colour of its crank’s mark. Choose “Real tide” for ten tidal constituents at their true speeds: they are not multiples of one another, so the curve never repeats, and M2 against S2 beats every 14.77 days.'),
    stage.el, live,
    h('div', { class: 'td-below' },
      h('div', null, h('h4', null, 'The pen ', h('span', { class: 'r3-badge' }, 'the sum of the cranks')), kv,
        h('h4', null, 'Calibrate a crank'),
        h('div', { class: 'td-cal' }, h('label', { class: 'td-lbl' }, 'Crank ', calSel),
          h('label', { class: 'td-lbl' }, 'Throw ', ampIn, ampOut), h('label', { class: 'td-lbl' }, 'Phase ', phIn, phOut), resetCal)),
      h('div', null, h('h4', null, 'The cranks'), h('div', { class: 'td-tabwrap' }, tab),
        h('p', { class: 'r3-hint' }, 'k: cycles a period, or the speed in °/h · A: amplitude · φ: phase · throw: the crank slot’s radius (30 mm an A) · gear: crank turns per hand-crank turn (a turn is one period, or one day on the tide) · slide: the pulley’s motion in units of A. The machine is a mechanical inverse DFT: a sum of cosines at set rates, phases and amplitudes.'))));
  stage.slot.append(
    h('div', { class: 'r3-ctl' }, h('label', { class: 'td-lbl' }, 'Cranks ', sel), h('div', { class: 'r3-btns' }, runBtn, stepBtn, startBtn)),
    h('div', { class: 'r3-ctl' }, h('span', { class: 'td-lbl', id: 'td-mech-l' }, 'Mechanism'),
      h('div', { class: 'r3-btns', role: 'group', 'aria-labelledby': 'td-mech-l' }, ...mechBtns.map(([, b]) => b))),
    h('div', { class: 'r3-ctl' }, crankLbl, h('div', { class: 'td-cranks', role: 'group', 'aria-labelledby': 'td-cranks-l' }, ...crankBtns, allBtn, oneBtn)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
