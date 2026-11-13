// The Williams tube in 3D on the studio renderer (loaded on demand, modelhost.ts; the model is williams3dkit.ts). The view
// keeps the store: each spot's patch (a dot or a dash) and when it was last written. The beam visits the spots in the
// store's own order, a line at a time, digit 0 on the left; at each it reads (which leaves a dot, whatever was there) and
// the regenerator writes back what it read. Two clocks, both shown: the beam's, in digits (8.5 µs each, the figure the
// chapter quotes from Kilburn's 1947 design), and the tube's own time, in which the charge leaks (0.2 s, the chapter's
// figure; Computer50 says about a second). While the beam runs the tube's time is the digits' time, far too short to leak;
// "Let it leak" stops the beam and runs the tube's time at a twentieth of real time.

import '../styles/crt3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { DIGITS, LINES } from './williams3dparts';
import { fill, newTex, stamp, staticFace, williamsModel, WILLIAMS_HOME, type ChassisKey, type Shape, type WilliamsState } from './williams3dkit';

/** A digit's time (s): the chapter quotes 8.5 µs from Kilburn's 1947 design (the replica's manual gives 10 µs). */
export const DIGIT_S = 8.5e-6;
/** How long a patch takes to leak to 1/e (s): the chapter's 0.2 s; Computer50 says about a second. */
export const LEAK_S = 0.2;
/** Below this share of its charge a dash reads as a dot: the discriminator's threshold (drawn). */
export const THRESH = 0.35;
/** "Let it leak": the tube's time runs at this fraction of real time. */
const SLOW = 0.05;
const N = LINES * DIGITS;

/** The store as the view keeps it (DOM-free, tested): each spot's shape, its last write in tube time, and the beam's place. */
export class Store {
  shape: Shape[]; wrote: Float64Array; shown: Shape[];
  /** Tube time (s), and the beam's digit count (its fraction: where in the digit it is). */
  tau = 0; t = 0; rewrite = true;
  constructor(bits: number[]) { this.shape = bits.map((b) => (b ? 'dash' : 'dot')); this.shown = [...this.shape]; this.wrote = new Float64Array(N); }
  amp(i: number): number { return Math.exp(-Math.max(0, this.tau - this.wrote[i]) / LEAK_S); }
  /** What the discriminator makes of spot i now: a dash with enough of its charge left reads 1. */
  reads(i: number): 0 | 1 { return this.shape[i] === 'dash' && this.amp(i) >= THRESH ? 1 : 0; }
  /** The beam's visit to spot i: read (a dot is left), then, with the rewrite on, the regenerator writes what was read. */
  visit(i: number): 0 | 1 {
    const r = this.reads(i);
    this.shape[i] = this.rewrite && r ? 'dash' : 'dot';
    this.wrote[i] = this.tau;
    this.shown[i] = this.shape[i];
    return r;
  }
  /** Advance the beam by `d` digits, visiting every spot whose digit ends; returns the spots visited. */
  scan(d: number): number[] {
    const out: number[] = [], to = this.t + d;
    for (let k = Math.floor(this.t); k < Math.floor(to + 1e-9); k++) { this.tau += DIGIT_S; this.visit(k % N); out.push(k % N); }
    this.t = to;
    return out;
  }
  ones(): number { let n = 0; for (let i = 0; i < N; i++) n += this.reads(i); return n; }
}

/** `words`: the 32 words the store holds (bit i = digit i, digit 0 on the left); default a pattern. */
export function williamsView(words: number[] = Array.from({ length: LINES }, (_, i) => (0x0f0f0f0f >>> (i % 8)) | (i & 1 ? 1 : 0))): Widget {
  const bits = Array.from({ length: N }, (_, i) => (words[Math.floor(i / DIGITS)] >>> i % DIGITS) & 1);
  let store = new Store(bits);
  let mode: 'paused' | 'scan' | 'leak' = 'paused', rate = 64, pickup: 'mesh' | 'plate' = 'mesh', started = false;
  const charge = newTex('emit'), display = newTex('emit');
  const acc = staticFace([0x5a5a5a5a], newTex('emit')), ctl = staticFace([0x00000013, 0x6000e004], newTex('emit'));
  const lastSeen = new Float64Array(N).fill(-1e9);
  const chargeAll = () => fill(charge, (l, d) => { const i = l * DIGITS + d; return { shape: store.shape[i], amp: store.amp(i) }; }, 'charge');
  const paintAll = () => {
    chargeAll();
    fill(display, (l, d) => { const i = l * DIGITS + d; return { shape: store.shown[i], amp: 0.55 + 0.45 * Math.exp(-Math.max(0, store.t - lastSeen[i]) / (2 * DIGITS)) }; }, 'light');
  };
  /** The spot under the beam, and where in its digit the beam is: reading for the first half, writing back for the second. */
  const here = () => { const k = Math.floor(store.t), f = store.t - k; return { i: k % N, f }; };
  const beamOn = () => started && mode !== 'leak';
  function state(): WilliamsState {
    const { i, f } = here(), on = beamOn();
    const active: ChassisKey | null = !on ? null : f < 0.25 ? 'amp' : f < 0.5 ? 'disc' : 'ctl';
    return { cell: on ? i : null, plate: on && f < 0.5 ? (store.reads(i) ? 1 : -1) : 0, active, pickup, charge, display, acc, ctl };
  }
  const stage = studioStage({
    aria: 'A Williams-Kilburn store tube in 3D in its screening box: an electron gun, deflection plates, the face carrying 32 by 32 patches of charge, the pick-up plate in front, the regenerator under it, and beside it the display tube and the other two store tubes',
    home: WILLIAMS_HOME,
    // home: the store tube alone, cut open; the screening box and the other three tubes come in the tour's last beat
    homeFrame: ['tube', 'gun', 'plates', 'face', 'pickup'],
    hidden: ['box', 'display', 'stores'],
    knobs: { cut: 1 },
    limits: { minDist: 150, maxDist: 6000 },
    note: 'Drawn at 12 inches (300 mm) as a CV1131 after Lavington; the University’s Computer50 pages put the Baby’s store on a 6-inch tube: the sources differ. Every dimension inside the tube is drawn, not measured, as are the box, the regenerator’s chassis and the 6 mm between spots. The face is drawn as its charge, amber where positive and blue where negative: a map, not light (the store tube’s own phosphor was hidden behind the plate). The pattern on the display tube beside it is light. Time: the beam is slowed thousands of times; “Let it leak” runs the tube’s own time at a twentieth.',
    build: (detail) => williamsModel(state(), detail),
  });

  // ---- the frame: the beam, the charge under it, the display copying it
  function onVisits(vs: number[]): void {
    for (const i of vs) { lastSeen[i] = store.t; stamp(charge, Math.floor(i / DIGITS), i % DIGITS, store.shape[i], 1, 'charge'); stamp(display, Math.floor(i / DIGITS), i % DIGITS, store.shown[i], 1, 'light'); }
    charge.rev++; display.rev++;
  }
  /** The spot under the beam mid-digit: the read leaves a dot until the write-back (the digit's second half). */
  function underBeam(): void {
    if (!beamOn()) return;
    const { i, f } = here(), shape: Shape = f < 0.5 ? 'dot' : store.rewrite && store.reads(i) ? 'dash' : 'dot';
    stamp(charge, Math.floor(i / DIGITS), i % DIGITS, shape, 1, 'charge'); charge.rev++;
  }
  const chip = h('span', { class: 'r3-chip' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip);
  function readout(): void {
    const { i, f } = here(), l = Math.floor(i / DIGITS), d = i % DIGITS, r = store.reads(i);
    const ones = store.ones(), want = bits.reduce((a, b) => a + b, 0);
    const rows: [string, string][] = [
      ['Beam', mode === 'leak' ? 'off: nothing is written back' : !started ? 'not started' : `line ${l}, digit ${d}: ${f < 0.5 ? 'reading' : 'writing back'}`],
      ['Read', !beamOn() ? '—' : `${r ? 'a dash: 1' : 'a dot: 0'}${f >= 0.5 ? (store.rewrite ? ', written back' : ', not written back: a dot is left') : ''}`],
      ['Tube time', `${(store.tau * 1e3).toFixed(store.tau < 0.01 ? 3 : 1)} ms${mode === 'leak' ? ' (running at 1/20)' : mode === 'scan' ? ` (a second here is ${(rate * DIGIT_S * 1e3).toFixed(2)} ms of the tube’s)` : ''}`],
      ['Ones still readable', `${ones} of ${want}`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    chip.textContent = mode === 'leak' ? 'Leaking' : mode === 'scan' ? (store.rewrite ? 'Regenerating' : 'Reading only') : 'Paused';
    chip.className = `r3-chip ${mode === 'leak' || !store.rewrite ? 'warn' : 'good'}`;
    const text = mode === 'leak' ? `The beam is off: ${ones} of ${want} ones still readable.` : !store.rewrite && ones < want ? `Reading without writing back: ${ones} of ${want} ones left.` : '';
    if (text && live.textContent !== text) live.textContent = text;
  }
  const loop = frameLoop((_now, dt) => {
    if (mode === 'scan') { onVisits(store.scan(reducedMotion() ? Math.min(dt * rate, 1) : dt * rate)); underBeam(); }
    else if (mode === 'leak') { store.tau += dt * SLOW; chargeAll(); }
    readout(); stage.refresh();
  }, () => mode !== 'paused');
  const kick = () => { readout(); stage.refresh(); loop.kick(); };

  // ---- controls
  const btn = (label: string, fn: () => void, cls = 'btn sm') => { const b = h('button', { type: 'button', class: cls }, label) as HTMLButtonElement; b.addEventListener('click', fn); return b; };
  const setMode = (m: typeof mode) => {
    if (m === 'scan') started = true;
    mode = m; runBtn.textContent = m === 'scan' ? 'Pause' : 'Run the beam'; runBtn.setAttribute('aria-pressed', String(m === 'scan')); leakBtn.setAttribute('aria-pressed', String(m === 'leak'));
    if (m !== 'leak') chargeAll();
    kick();
  };
  const runBtn = btn('Run the beam', () => setMode(mode === 'scan' ? 'paused' : 'scan'), 'btn sm primary');
  const step = (n: number) => { setMode('paused'); started = true; onVisits(store.scan(n)); underBeam(); kick(); };
  const stepD = btn('Step one digit', () => step(Math.floor(store.t) + 1 - store.t));
  const stepL = btn('Step one line', () => step((Math.floor(store.t / DIGITS) + 1) * DIGITS - store.t));
  const leakBtn = btn('Let it leak', () => setMode(mode === 'leak' ? 'paused' : 'leak'));
  leakBtn.setAttribute('aria-pressed', 'false');
  const rwBtn = btn('Write back after reading', () => { store.rewrite = !store.rewrite; rwBtn.setAttribute('aria-pressed', String(store.rewrite)); kick(); });
  rwBtn.setAttribute('aria-pressed', 'true');
  const pickBtn = btn('Pick-up: wire mesh', () => { pickup = pickup === 'mesh' ? 'plate' : 'mesh'; pickBtn.textContent = pickup === 'mesh' ? 'Pick-up: wire mesh' : 'Pick-up: metal plate'; kick(); });
  const resetBtn = btn('Reset', () => { store = new Store(bits); store.rewrite = rwBtn.getAttribute('aria-pressed') === 'true'; started = false; lastSeen.fill(-1e9); live.textContent = 'The store is full again.'; setMode('paused'); paintAll(); kick(); });
  const speed = h('input', { type: 'range', min: 2, max: 10, step: 0.1, value: Math.log2(rate), 'aria-label': 'Beam speed, digits a second' }) as HTMLInputElement;
  const speedOut = h('output', null, `${rate}/s`);
  speed.addEventListener('input', () => { rate = 2 ** Number(speed.value); speedOut.textContent = `${Math.round(rate)}/s`; readout(); });

  const panel = h('div', { class: 'panel crt3d' });
  panel.append(
    h('h3', { class: 'm3-title' }, 'A tube that remembers'),
    h('p', { class: 'm3-sub' }, 'A cathode-ray tube used as a store: the beam leaves a patch of charge on each of 32 × 32 spots, a dot or a dash. A plate in front picks up a pulse when the beam comes back, and the regenerator writes back what it read, because reading leaves a dot. The patches leak away, so the beam never stops going round.'),
    h('div', { class: 'r3' }, h('div', { class: 'r3-main' }, stage.el, live), h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'The store'), kv))));
  stage.slot.append(h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, runBtn, stepD, stepL, leakBtn, resetBtn),
    h('label', { class: 'r3-sl' }, h('span', null, 'Beam'), speed, speedOut), h('div', { class: 'r3-btns' }, rwBtn, pickBtn)));
  paintAll(); readout(); stage.refresh();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
