// The half-wave dipole in 3D (loaded on demand, modelhost.ts). Frequency, length and pattern are the radio chapter's own
// (dipole3dparts.ts); the motion is a drawing of a standing wave and of the near field's loops.

import '../styles/dipole3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { DIPOLE_DBI } from '../phys/radio';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { ANTENNA_GHZ } from './radio';
import { DRAW_RATE, DipoleRun, END_EFFECT, FREQ_HZ, HALF_LEN, LAMBDA, REAL_DIAMETER, DRAWN_SCALE, SLOWDOWN, STEP_PHASE, dipoleAnchors, dipoleParts, type DipolePalette } from './dipole3dparts';

const STEP_MS = 380;
/** One decimal, with no '-0.0': anything under 0.05 reads 0.0. */
const f1 = (x: number) => (Math.abs(x) < 0.05 ? 0 : x).toFixed(1);
const sci = (x: number) => { const e = Math.floor(Math.log10(x)); return `${(x / 10 ** e).toFixed(1)} × 10${String(e).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)])}`; };

export function dipoleView(): Widget {
  const run = new DipoleRun();
  let running = false, showPattern = true, target: number | null = null, lastRead = 0;
  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'A half-wave dipole antenna in 3D: two copper rods with an insulated feed gap in the middle, the standing-wave current along them, electric field loops leaving it and the doughnut-shaped radiation pattern around it',
    camera: { target: [0, 0, 0], yaw: 0.5, pitch: 0.38, dist: 36 },
    limits: { minDist: 14, maxDist: 200 },
    note: `Scaled or drawn, not solved: length (λ/2 = ${f1(2 * HALF_LEN)} cm, the electrical half wave; a wire cut for resonance is about ${END_EFFECT} of that, ${f1(2 * HALF_LEN * END_EFFECT)} cm, because of end effect) and the ${f1(LAMBDA)} cm wavelength are to scale; the ${REAL_DIAMETER * 10} mm copper wire is drawn ${DRAWN_SCALE}x thicker, and the current curve's height is arbitrary. The field loops are a cartoon of the near field, not a solution of Maxwell's equations; the doughnut is the exact far-field shape but drawn close in. Time runs ${sci(SLOWDOWN)} times slower than real (${DRAW_RATE} periods a second against ${f1(ANTENNA_GHZ)} GHz), and the loops travel at c in that slowed scale: one wavelength per period. No balun is drawn: a coaxial feed needs one.`,
    draw: () => paint(),
  });
  const palette = (): DipolePalette => ({
    rod: stage.rgb('--dp-cu'), ins: stage.rgb('--dp-ins'), pos: stage.rgb('--dp-pos'), neg: stage.rgb('--dp-neg'), e1: stage.rgb('--dp-e1'), e2: stage.rgb('--dp-e2'),
    pat: stage.rgb('--dp-pat'), src: stage.rgb('--dp-src'), ghost: stage.rgba('--dp-ghost', 0.7),
  });
  function paint(): void { stage.paint(dipoleParts(run, showPattern, palette()), dipoleAnchors(run, showPattern)); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const sense = (v: number) => (Math.abs(v) < 0.05 ? 'zero' : v > 0 ? 'up the upper arm' : 'down the upper arm');
  function status(): string {
    const v = run.feed;
    return `Phase ${run.degrees}°: feed current ${f1(v)} of peak, ${sense(v)}; tip current 0.${Math.abs(v) < 0.05 ? ' The charge at the tips is at its peak: a new field loop forms.' : ''}`;
  }
  function readout(announce = false): void {
    const v = run.feed;
    chip.textContent = `Phase ${run.degrees}°`;
    chip.className = `r3-chip ${Math.abs(v) < 0.05 ? 'warn' : 'good'}`;
    const rows: [string, string][] = [
      ['Frequency', `${f1(ANTENNA_GHZ)} GHz`], ['Wavelength λ', `${f1(LAMBDA)} cm`], ['Length λ/2', `${f1(2 * HALF_LEN)} cm`],
      ['Period (real)', `${(1e9 / FREQ_HZ).toFixed(3)} ns`], ['Feed current', `${f1(v)} of peak`], ['Tip current', '0'],
      ['Gain', `${DIPOLE_DBI} dBi`], ['Loop front', 'λ per period (c)'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, x]) => [h('span', null, k), h('span', { class: 'v' }, x)]));
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
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
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', () => { syncMotion(); kick(); });
  syncMotion();

  panel.append(
    h('h3', { class: 'm3-title' }, 'The half-wave dipole'),
    h('p', { class: 'm3-sub' }, `Two copper arms, λ/2 = ${f1(2 * HALF_LEN)} cm in all at ${f1(ANTENNA_GHZ)} GHz, joined across an insulator at the feed. The current is a standing wave, cos(kz): largest at the feed, zero at the tips where the wire ends, reversing every half period (red up, blue down). Each time it passes through zero the charge at the tips is at its peak and a field loop forms; it detaches and travels out at c, a wavelength per period. Far away the power follows the doughnut cos(π/2·cosθ) / sinθ: most broadside, nothing along the rods. Drag to orbit.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns dp-btns' }, runBtn, stepBtn, patBtn, stage.resetBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This dipole ', h('span', { class: 'r3-badge' }, 'the chapter’s numbers')), kv)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
