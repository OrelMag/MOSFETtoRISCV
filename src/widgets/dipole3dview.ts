// The dipole in 3D (loaded on demand, modelhost.ts). Frequency, length and pattern are the radio chapter's own
// (dipole3dparts.ts); the motion is a drawing of a standing wave and of the near field's loops.

import '../styles/dipole3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { ANTENNA_GHZ } from './radio';
import {
  DEFICIT, DRAW_RATE, DipoleRun, END_EFFECT, FEED_W, FREQ_HZ, LAMBDA, L_HALF, L_MAX, L_MIN, REAL_DIAMETER, DRAWN_SCALE, SLOWDOWN, STEP_PHASE, Z0_COAX,
  cutLength, dipoleAnchors, dipoleParts, feedDrive, feedResistance, gainDbi, halfPower, mismatch,
  type DipolePalette, type DipoleView, type Feed, type PatternMode,
} from './dipole3dparts';

const STEP_MS = 380;
/** One decimal, with no '-0.0': anything under 0.05 reads 0.0. */
const f1 = (x: number) => (Math.abs(x) < 0.05 ? 0 : x).toFixed(1);
const sci = (x: number) => { const e = Math.floor(Math.log10(x)); return `${(x / 10 ** e).toFixed(1)} × 10${String(e).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)])}`; };
const fmtR = (r: number) => (!Number.isFinite(r) || r > 2000 ? 'very high (a current null at the feed)' : `${r < 100 ? r.toFixed(0) : Math.round(r / 5) * 5} Ω`);
const FEEDS: [Feed, string][] = [['balanced', 'Feed: leads'], ['coax', 'Feed: coax, no balun'], ['balun', 'Feed: coax + sleeve']];

export function dipoleView(): Widget {
  const run = new DipoleRun();
  const view: DipoleView = { mode: 'power', feed: 'balanced' };
  let running = false, showPattern = true, target: number | null = null, lastRead = 0;
  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'A dipole antenna in 3D: two copper rods with an insulated feed gap in the middle, the standing-wave current and voltage along them, electric field loops leaving it, magnetic circles round the arms and the doughnut-shaped radiation pattern around it, which a length slider reshapes',
    camera: { target: [0, 0, 0], yaw: 0.5, pitch: 0.38, dist: 36 },
    limits: { minDist: 14, maxDist: 200 },
    note: `Scaled or drawn, not solved: the rods are drawn at the cut length (the half wave is ${f1(LAMBDA / 2)} cm electrical, ${f1(cutLength(L_HALF))} cm cut: the end effect shortens a thin wire by about ${Math.round((1 - END_EFFECT) * 100)} %, taken as a constant ${(DEFICIT / 2).toFixed(2)} cm a tip at every slider length) and the ${f1(LAMBDA)} cm wavelength is to scale; the ${REAL_DIAMETER * 10} mm copper wire is drawn ${DRAWN_SCALE}x thicker, and the height of the current and voltage curves is arbitrary. Current and voltage are the sinusoidal standing waves of a thin centre-fed dipole (Balanis, Antenna Theory, ch. 4); the field loops and the magnetic circles are a cartoon of the near field, not a solution of Maxwell's equations; the doughnut is the exact far-field shape of that current but drawn close in (a half-wave dipole's far field starts about a wavelength out). The impedances are the resistive part only, from the same current model; the reactance (+42.5 Ω at λ/2) is not computed. Time runs ${sci(SLOWDOWN)} times slower than real (${DRAW_RATE} periods a second against ${f1(ANTENNA_GHZ)} GHz), and the loops travel at c in that slowed scale: one wavelength per period. The coax is drawn to scale (2.2 mm), the sleeve a quarter wave in air. The coax row's SWR takes the feed resistance alone, as if the reactance were tuned out (a cut half wave is close to that; other lengths need a matching network).`,
    draw: () => paint(),
  });
  const palette = (): DipolePalette => ({
    rod: stage.rgb('--dp-cu'), ins: stage.rgb('--dp-ins'), pos: stage.rgb('--dp-pos'), neg: stage.rgb('--dp-neg'), e1: stage.rgb('--dp-e1'), e2: stage.rgb('--dp-e2'),
    pat: stage.rgb('--dp-pat'), src: stage.rgb('--dp-src'), ghost: stage.rgba('--dp-ghost', 0.7), volt: stage.rgb('--dp-volt'), hfield: stage.rgb('--dp-h'),
  });
  function paint(): void { stage.paint(dipoleParts(run, showPattern, palette(), view), dipoleAnchors(run, showPattern, view)); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const sense = (v: number) => (Math.abs(v) < 0.05 ? 'zero' : v > 0 ? 'up the upper arm' : 'down the upper arm');
  function status(): string {
    const v = run.feed;
    return `Phase ${run.degrees}°, length ${run.lwl.toFixed(2)} λ: feed current ${f1(v)} of the wave's peak, ${sense(v)}; tip current ${f1(run.tip)}.${Math.abs(Math.cos(run.phase)) < 0.05 ? ' The charge at the tips is at its peak: a new field loop forms.' : ''}`;
  }
  function readout(announce = false): void {
    const v = run.feed, L = run.lwl, half = Math.abs(L - L_HALF) < 1e-9, hp = halfPower(L), rin = feedResistance(L);
    chip.textContent = `Phase ${run.degrees}°`;
    chip.className = `r3-chip ${Math.abs(v) < 0.05 ? 'warn' : 'good'}`;
    const rows: [string, string][] = [
      ['Frequency', `${f1(ANTENNA_GHZ)} GHz`], ['Wavelength λ', `${f1(LAMBDA)} cm`],
      ['Electrical length', `${L.toFixed(2)} λ = ${f1(L * LAMBDA)} cm`], ['Cut length', `${f1(cutLength(L))} cm${half ? ' (end effect, 0.95)' : ''}`],
      ['Period (real)', `${(1e9 / FREQ_HZ).toFixed(3)} ns`], ['Feed current', `${f1(v)} of peak`], ['Tip current', f1(run.tip)],
      ['Feed resistance', fmtR(rin)], ['Gain (power)', `${gainDbi(L).toFixed(2)} dBi`],
      ['Half-power width', `${Math.round((hp.width * 180) / Math.PI)}° (−3 dB)`],
    ];
    if (Number.isFinite(rin) && rin < 2000) {
      const d = feedDrive(rin), m = mismatch(rin);
      rows.push([`${FEED_W} W drive`, `${d.amps.toFixed(3)} A, ${d.volts.toFixed(0)} V peak`], [`On ${Z0_COAX} Ω coax (tuned)`, `SWR ${m.swr.toFixed(2)}, ${m.returnLoss.toFixed(1)} dB return loss`]);
    }
    rows.push(['Loop front', 'λ per period (c)']);
    kv.replaceChildren(...rows.flatMap(([k, x]) => [h('span', null, k), h('span', { class: 'v' }, x)]));
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    lenOut.textContent = `${L.toFixed(2)} λ`;
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = status();
    if (live.textContent !== text) live.textContent = text;
  }

  const loop = frameLoop((now, dt) => {
    if (running) run.advance(dt * DRAW_RATE);
    else if (target !== null) {
      run.t += (dt * 1000 * STEP_PHASE) / STEP_MS;
      if (run.t >= target - 1e-9) { run.t = target; target = null; readout(true); }
    }
    // A running readout refreshes ten times a second at most (the numbers, not the picture).
    if (!running || now - lastRead > 100) { lastRead = now; readout(); }
    paint();
  }, () => running || target !== null);
  const kick = () => { readout(); paint(); loop.kick(); };

  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  const syncMotion = () => {
    const still = reducedMotion();
    runBtn.disabled = still;
    runBtn.title = still ? 'Reduced motion is on: use Step a phase' : '';
    if (still && running) { running = false; readout(true); }
  };
  runBtn.addEventListener('click', () => { if (reducedMotion()) return; running = !running; target = null; if (!running) readout(true); kick(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step a phase (45°)');
  stepBtn.addEventListener('click', () => {
    running = false;
    const next = (target ?? Math.round(run.t / STEP_PHASE) * STEP_PHASE) + STEP_PHASE;
    if (reducedMotion()) { run.t = next; target = null; } else target = next;
    readout(true); kick();
  });
  const patBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'true' }, 'Pattern') as HTMLButtonElement;
  patBtn.addEventListener('click', () => { showPattern = !showPattern; patBtn.classList.toggle('on', showPattern); patBtn.setAttribute('aria-pressed', String(showPattern)); kick(); });
  const modeBtn = h('button', { type: 'button', class: 'btn sm', title: 'The doughnut as the power (the field squared: what the gain describes) or as the field amplitude' }, 'Doughnut: power') as HTMLButtonElement;
  modeBtn.addEventListener('click', () => {
    view.mode = (view.mode === 'power' ? 'field' : 'power') as PatternMode;
    modeBtn.textContent = view.mode === 'power' ? 'Doughnut: power' : 'Doughnut: field';
    kick();
  });
  const feedBtn = h('button', { type: 'button', class: 'btn sm', title: 'Cycle: balanced leads, a bare coax (current on the braid), a coax with a quarter-wave sleeve balun' }, FEEDS[0][1]) as HTMLButtonElement;
  feedBtn.addEventListener('click', () => {
    const i = (FEEDS.findIndex(([k]) => k === view.feed) + 1) % FEEDS.length;
    view.feed = FEEDS[i][0]; feedBtn.textContent = FEEDS[i][1]; kick();
  });
  const lenIn = h('input', { type: 'range', min: Math.round(L_MIN * 100), max: Math.round(L_MAX * 100), step: 5, value: Math.round(L_HALF * 100), 'aria-label': 'Electrical length of the dipole in wavelengths' }) as HTMLInputElement;
  const lenOut = h('output', null, '');
  lenIn.addEventListener('input', () => { run.lwl = Number(lenIn.value) / 100; kick(); });
  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)'), onMq = () => { syncMotion(); kick(); };
  mq?.addEventListener?.('change', onMq);
  syncMotion();

  panel.append(
    h('h3', { class: 'm3-title' }, 'The dipole'),
    h('p', { class: 'm3-sub' }, `Two copper arms joined across an insulator at the feed, λ/2 = ${f1(LAMBDA / 2)} cm electrical (${f1(cutLength(L_HALF))} cm cut) at ${f1(ANTENNA_GHZ)} GHz. The current is a standing wave, cos(kz) for the half wave: largest at the feed, zero at the tips where the wire ends, reversing every half period (red up, blue down). The voltage (teal curve, tip charge) is its quadrature twin: zero at the feed, largest at the tips; the magnetic field circles the current. Each time the current passes through zero the charge at the tips is at its peak and a field loop forms; it detaches and travels out at c, a wavelength per period. Far away the field follows cos(π/2·cosθ) / sinθ and the power its square: the doughnut shows either (power by default, 78° between the amber half-power rings, 2.15 dBi): most broadside, nothing along the rods. Drag the Length slider up to 1.5 λ and the doughnut splits into lobes. Drag to orbit.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns dp-btns' }, runBtn, stepBtn, patBtn, modeBtn, feedBtn, stage.resetBtn)),
        h('div', { class: 'r3-ctl' }, h('label', { class: 'r3-sl' }, h('span', null, 'Length'), lenIn, lenOut)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This dipole ', h('span', { class: 'r3-badge' }, 'the chapter’s numbers')), kv)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { mq?.removeEventListener?.('change', onMq); loop.stop(); stage.destroy(); } };
}
