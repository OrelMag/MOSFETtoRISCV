// The Williams tube in 3D (loaded on demand, modelhost.ts): the beam visits the 1 024 spots in the store's own order (a line at
// a time, digit 0 on the left), and the pick-up plate's signal shows as the plate and amplifier light for the spot being read.
// Time is counted in digits (Kilburn's 1947 design: 8.5 us a digit; the replica manual gives 10 us; here the speed is a slider).

import '../styles/crt3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { cellOf, deflectionOf, DIGITS, LINES, poseParts, staticParts, WGEOM, williamsAnchors, type WilliamsDetail } from './williams3dparts';
import type { CrtPalette } from './crt3dparts';
import type { OrbitView } from '../gl/camera';

const VIEWS: Record<string, OrbitView> = {
  three: { target: [120, 0, 0], yaw: 0.7, pitch: 0.3, dist: 800 },
  front: { target: [WGEOM.FACE_X, 0, 0], yaw: 1.25, pitch: 0.12, dist: 620 },
  side: { target: [100, 0, 0], yaw: 0.05, pitch: 0.12, dist: 900 },
  plates: { target: [-20, 0, 0], yaw: 0.6, pitch: 0.35, dist: 230 },
};
const isNarrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;

/** `words`: the 32 words the store shows (bit i = digit i, digit 0 on the left); default a pattern. */
export function williamsView(words: number[] = Array.from({ length: LINES }, (_, i) => (0x0f0f0f0f >>> (i % 8)) | (i & 1 ? 1 : 0))): Widget {
  const bits = Array.from({ length: LINES * DIGITS }, (_, i) => (words[Math.floor(i / DIGITS)] >>> i % DIGITS) & 1);
  const last = new Float64Array(LINES * DIGITS).fill(-1e9);
  let t = 0, visited = -1, running = false, rate = 64, detail: WilliamsDetail = 'overview';
  const panel = h('div', { class: 'panel crt3d' });
  const stage = modelStage(panel, {
    aria: 'A Williams-Kilburn storage tube in 3D: an electron gun, electrostatic deflection plates, a face carrying 32 by 32 dots and dashes, and a wire-mesh pick-up plate in front of it with its lead to an amplifier',
    camera: isNarrow() ? { ...VIEWS.side, dist: VIEWS.side.dist * 1.25 } : VIEWS.three,
    limits: { minDist: 100, maxDist: 2000 },
    note: 'Drawn, not modelled: electrodes as plates, one smooth bend in the deflection plates, 6 mm between spots, a dot and a dash as boxes. Sizes are estimates. The tube is drawn as a 12-inch (300 mm) CV1131 after Lavington; the University’s Computer50 pages put the Baby’s store on a 6-inch tube, so the sources differ. The pick-up plate was at first a wire mesh (Digital60). It covered the face, so the stored pattern could not be seen on the store tube itself: the operators read it on a separate display tube that copied the store (Computer50, Digital60). The pattern is drawn on this tube’s face so that you can see it.',
    draw: () => paint(),
  });
  const palette = (): CrtPalette => ({
    glass: stage.rgb('--crt-glass'), aquadag: stage.rgb('--crt-aquadag'), copper: stage.rgb('--crt-copper'), ferrite: stage.rgb('--crt-ferrite'),
    metal: stage.rgb('--crt-metal'), pin: stage.rgb('--crt-pin'), cellOff: stage.rgb('--crt-off'), mask: stage.rgb('--crt-mask'),
    heater: stage.rgb('--crt-heater'), ghost: stage.rgb('--crt-ghost'), bezel: stage.rgb('--crt-bezel'),
  });
  const here = () => ({ line: Math.floor(t / DIGITS) % LINES, digit: Math.floor(t) % DIGITS });
  const TAU = 3 * DIGITS; // the phosphor fades over a few lines
  function visit(upto: number): void {
    for (let k = Math.floor(visited) + 1; k <= Math.floor(upto); k++) last[k % (LINES * DIGITS)] = k;
    visited = upto;
  }
  function paint(): void {
    const b = here(), i = cellOf(b.line, b.digit), d = deflectionOf(b.line, b.digit), P = palette();
    const sig = bits[i] ? 1 : -1, age = t - last[i];
    stage.paint([...staticParts(P, d.vx, d.vy), ...poseParts(P, {
      beam: { line: b.line, digit: b.digit }, bit: (k) => bits[k],
      glow: (k) => Math.exp(-Math.max(0, t - last[k]) / TAU), plate: age < 1 ? sig : 0,
    })], williamsAnchors(detail, isNarrow()));
  }
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  function readout(): void {
    const b = here();
    live.textContent = `Line ${b.line}, digit ${b.digit}: the beam is on a ${bits[cellOf(b.line, b.digit)] ? 'dash (1)' : 'dot (0)'}; the pick-up plate tells the regenerator which, and it writes it back.`;
  }
  function setT(v: number): void { t = v; visit(t); }
  const loop = frameLoop((_now, dt) => { if (running) setT(t + (reducedMotion() ? dt * 4 : dt * rate)); readout(); paint(); }, () => running);
  const kick = () => { readout(); paint(); loop.kick(); };
  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; runBtn.textContent = running ? 'Pause' : 'Run'; runBtn.setAttribute('aria-pressed', String(running)); kick(); });
  const stepD = h('button', { type: 'button', class: 'btn sm' }, 'Step one digit');
  stepD.addEventListener('click', () => { running = false; runBtn.textContent = 'Run'; setT(Math.floor(t) + 1); kick(); });
  const stepL = h('button', { type: 'button', class: 'btn sm' }, 'Step one line');
  stepL.addEventListener('click', () => { running = false; runBtn.textContent = 'Run'; setT((Math.floor(t / DIGITS) + 1) * DIGITS); kick(); });
  const speed = h('input', { type: 'range', min: 2, max: 10, step: 0.1, value: Math.log2(rate), 'aria-label': 'Speed in digits a second' }) as HTMLInputElement;
  const speedOut = h('output', null, `${rate}/s`);
  speed.addEventListener('input', () => { rate = 2 ** Number(speed.value); speedOut.textContent = `${Math.round(rate)}/s`; });
  const views = ['three', 'front', 'side', 'plates'].map((name) => ({
    label: name === 'three' ? '3/4 view' : name[0].toUpperCase() + name.slice(1), view: () => ({ ...VIEWS[name], dist: VIEWS[name].dist * (isNarrow() ? 1.25 : 1) }),
    on: name === (isNarrow() ? 'side' : 'three'), pick: () => { detail = name === 'plates' ? 'plates' : name === 'front' ? 'face' : 'overview'; paint(); },
  }));
  panel.append(
    h('h3', { class: 'm3-title' }, 'A tube that remembers'),
    h('p', { class: 'm3-sub' }, 'A cathode-ray tube used as a memory: the beam draws a dot or a dash on each of 32 × 32 spots, and the charge it leaves is read back by a plate in front of the glass. Digit 0 is on the left.'),
    h('div', { class: 'r3' }, h('div', { class: 'r3-main' },
      h('div', { class: 'r3-ctl' }, h('label', { class: 'r3-sl' }, h('span', null, 'Speed'), speed, speedOut), h('div', { class: 'r3-btns' }, runBtn, stepD, stepL), stage.viewBar(views)),
      stage.el, stage.hint, live)));
  readout(); paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
