// "The z-plane": a difference equation stepped by hand, convolution sliding, the plane itself with its roots to drag (pointer, or the sliders below it),
// and two filters with one gain and different delays. Every number is dsp/zplane.ts's, which tests/dsp-zplane.test.ts holds to scipy.

import { convolve, filter, gainAt, gainByDistances, groupDelay, impulse, pairCoeffs, pairsPoly, settleOfPair, stateOfPoles, type Cx, type Pair, type PoleState } from '../dsp/zplane';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { clipButton } from './clip';
import { line, mkChips, num, plotOf, type Plot } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';
import '../styles/dsp.css';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const stems = (p: Plot, ys: readonly number[], cls = '') => {
  ys.forEach((y, i) => { if (Math.abs(y) > 1e-9) p.layer.append(s('line', { x1: p.X(i), x2: p.X(i), y1: p.Y(0), y2: p.Y(y), class: `sg-stem ${cls}` })); });
};
const coeff = (v: number) => num(v, 3);

/** White noise, seeded: what the plane's filter plays. */
export function noiseBlock(n: number, seed = 12345): number[] {
  let x = seed;
  return Array.from({ length: n }, () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 31 - 1; });
}

// ---- an equation with a memory --------------------------------------------------------------------------------------------------------

const EQS: { name: string; b: number[]; a: number[] }[] = [
  { name: 'Moving average of 4', b: [0.25, 0.25, 0.25, 0.25], a: [1] },
  { name: 'FIR5, gain 16 removed', b: [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16], a: [1] },
  { name: 'One pole: y[n] = 0.1 x[n] + 0.9 y[n−1]', b: [0.1], a: [1, -0.9] },
  { name: 'A resonator', b: [0.06], a: pairCoeffs(0.97, 0.5) },
];
const INPUTS: { name: string; at: (n: number) => number }[] = [
  { name: 'An impulse', at: (n) => (n === 0 ? 1 : 0) },
  { name: 'A step', at: () => 1 },
  { name: 'A tone', at: (n) => Math.sin(2 * Math.PI * 0.08 * n) },
];

export function equationWidget(): Widget {
  let e = 0, inp = 0, now = 6;
  const N = 48, plot = plotOf({ W: 640, H: 200, x: [0, N], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'n', yLabel: 'level', aria: 'The input and the output sample by sample, up to the current sample' });
  const eq = h('div', { class: 'dsp-eq' }), chips = mkChips(2);
  const pick = (name: string, opts: { name: string }[], set: (i: number) => void) => {
    const sel = h('select', { 'aria-label': name }, ...opts.map((x, i) => h('option', { value: String(i) }, x.name))) as HTMLSelectElement;
    sel.addEventListener('change', () => { set(Number(sel.value)); paint(); });
    return h('label', { class: 'mos-sl ln-sel' }, h('span', null, name), sel);
  };
  const paint = () => {
    const { b, a } = EQS[e], x = range(N).map(INPUTS[inp].at), y = filter(b, a, x);
    const top = Math.max(1.2, ...y.map((v) => Math.abs(v) * 1.1));
    plot.setY(-top, top);
    plot.clear();
    stems(plot, x.slice(0, now + 1), 'out');
    line(plot, range(now + 1), y.slice(0, now + 1), 'real');
    const term = (v: number, w: number) => ({ v, t: `${coeff(Math.abs(v))} × ${coeff(w)}` });
    const terms = [...b.map((v, k) => term(v, x[now - k] ?? 0)), ...a.slice(1).map((v, k) => term(-v, y[now - k - 1] ?? 0))];
    eq.textContent = `y[${now}] = ${terms.map((u, i) => `${i ? (u.v < 0 ? ' − ' : ' + ') : u.v < 0 ? '−' : ''}${u.t}`).join('')} = ${coeff(y[now])}`;
    chips.set(0, String(b.length + a.length - 1), 'multiplications a sample, at most');
    chips.set(1, String(b.length - 1 + a.length - 1), 'old values it has to remember');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'One sample at a time'), h('div', { class: 'ln-key' }, h('span', { class: 'k-near' }, 'x[n], in'), h('span', { class: 'k-far' }, 'y[n], out')), plot.el, eq, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, pick('Filter', EQS, (i) => { e = i; }), pick('Input', INPUTS, (i) => { inp = i; }),
        slider('Sample', 0, N - 1, 1, now, (v) => `n = ${v}`, (v) => { now = v; paint(); }).el))),
  };
}

// ---- convolution ------------------------------------------------------------------------------------------------------------------------

export const CONV_X = [1, 2, 0, -1, 3, 1];
export const CONV_H = [1, 0.5, 0.25];

export function convolutionWidget(): Widget {
  let at = 2;
  const y = convolve(CONV_X, CONV_H), L = y.length;
  const grid = h('div', { class: 'dsp-conv', style: `grid-template-columns: max-content repeat(${L}, minmax(30px, 1fr))` }), chips = mkChips(2);
  const plot = plotOf({ W: 640, H: 150, x: [0, L - 1], y: [-1.5, 4], yTicks: [0, 2, 4], xLabel: 'n', yLabel: 'y[n]', aria: 'The output built so far' });
  const cell = (t: string, cls = '') => h('span', { class: cls }, t);
  const paint = () => {
    const shifted = range(L).map((n) => CONV_H[at - n]);
    const kids: HTMLElement[] = [cell('x[n]', 'lab'), ...range(L).map((n) => cell(CONV_X[n] === undefined ? '' : num(CONV_X[n], 2), shifted[n] !== undefined && CONV_X[n] !== undefined ? 'hit' : ''))];
    kids.push(cell('h, reversed, at n', 'lab'), ...range(L).map((n) => cell(shifted[n] === undefined ? '' : num(shifted[n], 2), shifted[n] !== undefined ? 'hit' : '')));
    kids.push(cell('products', 'lab'), ...range(L).map((n) => cell(shifted[n] !== undefined && CONV_X[n] !== undefined ? num(shifted[n] * CONV_X[n], 2) : '')));
    grid.replaceChildren(...kids);
    plot.clear();
    stems(plot, y.slice(0, at + 1));
    chips.set(0, num(y[at], 3), `y[${at}], the sum of the products`);
    chips.set(1, `${CONV_X.length} + ${CONV_H.length} − 1 = ${L}`, 'samples in the output');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Slide, multiply, add'), grid, plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, slider('n', 0, L - 1, 1, at, (v) => String(v), (v) => { at = v; paint(); }).el)),
  };
}

// ---- the plane -----------------------------------------------------------------------------------------------------------------------------

export interface PlaneOpts {
  zeros: Pair[];
  poles: Pair[];
  presets?: { name: string; zeros: Pair[]; poles: Pair[] }[];
  /** A point walking the circle, with its distances drawn. */
  probe?: boolean;
  /** Noise through it, on a click. */
  sound?: boolean;
  /** Show the coefficients as a list. */
  taps?: boolean;
  /** One pole pair in a register: its feedback coefficients are rounded to a word of this many bits (Q2.(b−2), as lib/biquad.ts holds them). The lattice of words
   *  the register can hold is drawn up to LATTICE_MAX_BITS, the pole asked for is a ring, the pole held a cross, and gain, impulse, state and sound are the held one's. */
  coeffBits?: { min: number; max: number; start: number };
}

// ---- a pole in a register ---------------------------------------------------------------------------------------------------------------------

export const LATTICE_MAX_BITS = 6;
export interface Held {
  /** The word's step, 2^−(b−2), and its range −2 … 2 − step. */
  step: number;
  /** What the pole asks for, a₁ = −2 r cos θ and a₂ = r², and what the register holds. */
  asked: { a1: number; a2: number };
  a1: number; a2: number;
  /** The roots of z² + a₁ z + a₂, and the verdict on them, read off the triangle |a₂| < 1, |a₁| < 1 + a₂ on the integers, which is exact. */
  roots: Cx[];
  radius: number;
  state: PoleState;
  /** The word's two integers. */
  words: [number, number];
}
export function heldPair(p: Pair, bits: number): Held {
  const S = 2 ** (bits - 2), step = 1 / S, lim = (v: number) => Math.max(-2 * S, Math.min(2 * S - 1, Math.floor(v * S + 0.5)));
  const asked = { a1: -2 * p.r * Math.cos(p.t), a2: p.r * p.r }, A1 = lim(asked.a1), A2 = lim(asked.a2), a1 = A1 * step, a2 = A2 * step;
  const d = a1 * a1 - 4 * a2;
  const roots: Cx[] = d < 0 ? [{ re: -a1 / 2, im: Math.sqrt(-d) / 2 }, { re: -a1 / 2, im: -Math.sqrt(-d) / 2 }] : [{ re: (-a1 + Math.sqrt(d)) / 2, im: 0 }, { re: (-a1 - Math.sqrt(d)) / 2, im: 0 }];
  const inside = Math.abs(A2) < S && Math.abs(A1) < S + A2, edge = Math.abs(A2) <= S && Math.abs(A1) <= S + A2;
  const state: PoleState = inside ? 'stable' : edge ? (Math.abs(A2) === S && Math.abs(A1) === 2 * S ? 'unstable' : 'on the circle') : 'unstable';
  return { step, asked, a1, a2, roots, radius: Math.max(...roots.map((q) => Math.hypot(q.re, q.im))), state, words: [A1, A2] };
}
/** The poles a word can hold, upper half-plane: every complex pair a₁ = k·step, a₂ = j·step inside the plotted square. */
export function latticeDots(bits: number): { re: number; im: number }[] {
  const S = 2 ** (bits - 2), out: { re: number; im: number }[] = [];
  for (let j = 0; j <= Math.floor(1.3 * S); j++) for (let k = -2 * S; k < 2 * S; k++) {
    const a1 = k / S, a2 = j / S;
    if (a1 * a1 >= 4 * a2) continue;
    const re = -a1 / 2, im = Math.sqrt(4 * a2 - a1 * a1) / 2;
    if (Math.abs(re) <= 1.2 && im <= 1.2) out.push({ re, im });
  }
  return out;
}
const SIZE = 300, U = 118, C = SIZE / 2, PX = (x: number) => C + x * U, PY = (y: number) => C - y * U;
const DB_FLOOR = -60;

export function planeWidget(o: PlaneOpts): Widget {
  const zeros = o.zeros.map((p) => ({ ...p })), poles = o.poles.map((p) => ({ ...p }));
  let f = 0.1, drag: Pair | null = null, isPole = false;
  const plane = s('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'dsp-plane', role: 'group', 'aria-label': 'The z-plane. Drag a pole or a zero, or use the sliders below.' }) as SVGSVGElement;
  const gain = plotOf({ W: 380, H: 170, x: [0, 0.5], y: [DB_FLOOR, 6], yTicks: [0, -20, -40, -60], xLabel: 'cycles a sample', yLabel: 'gain, dB from the peak', aria: 'Gain against frequency', yFmt: (v) => num(v, 0) });
  const imp = plotOf({ W: 380, H: 130, x: [0, 40], y: [-1.1, 1.1], yTicks: [-1, 0, 1], xLabel: 'n', yLabel: 'impulse, scaled', aria: 'The impulse response, scaled to fit' });
  const word = o.coeffBits;
  if (word && (poles.length !== 1 || o.probe)) throw new Error('coeffBits is for one pole pair, without the probe');
  let bits = word?.start ?? 0;
  const held = (): Held | null => (word ? heldPair(poles[0], bits) : null);
  const chips = mkChips((o.probe ? 4 : 3) + (word ? 1 : 0)), taps = h('p', { class: 'sub mos-note' });
  const coeffs = () => { const k = held(); return { b: pairsPoly(zeros), a: k ? [1, k.a1, k.a2] : pairsPoly(poles) }; };
  const sliders: { set(v: number): void; read: () => number }[] = [];
  // the word's legend names the dots only while there are dots: rebuilt in paint
  const wordKey = h('span', { class: 'fr-k' });
  const paint = () => {
    const { b, a } = coeffs(), k = held(), state = k ? k.state : stateOfPoles(poles), ok = state === 'stable' || state === 'none', rad = k ? k.radius : Math.max(0, ...poles.map((p) => p.r));
    const nodes: SVGElement[] = [
      s('line', { x1: 8, x2: SIZE - 8, y1: C, y2: C, class: 'axis' }), s('line', { x1: C, x2: C, y1: 8, y2: SIZE - 8, class: 'axis' }),
      s('circle', { cx: C, cy: C, r: U, class: 'circle' }), s('text', { x: SIZE - 6, y: C - 5, 'text-anchor': 'end' }, '1'), s('text', { x: 6, y: C - 5 }, '−1'),
    ];
    if (o.probe) {
      const x = Math.cos(2 * Math.PI * f), y = Math.sin(2 * Math.PI * f);
      for (const p of [...zeros, ...poles]) for (const g of [1, -1]) nodes.push(s('line', { x1: PX(x), y1: PY(y), x2: PX(p.r * Math.cos(p.t)), y2: PY(g * p.r * Math.sin(p.t)), class: 'reach' }));
      nodes.push(s('circle', { cx: PX(x), cy: PY(y), r: 5, class: 'probe' }));
    }
    for (const z of zeros) for (const g of [1, -1]) nodes.push(s('circle', { cx: PX(z.r * Math.cos(z.t)), cy: PY(g * z.r * Math.sin(z.t)), r: 6, class: 'zero' }));
    // roots on one spot show how many: FIR5's four at −1 would otherwise read as one
    const spots = new Map<string, { x: number; y: number; n: number }>();
    for (const p of [...zeros, ...poles]) for (const g of [1, -1]) {
      const x = PX(p.r * Math.cos(p.t)), y = PY(g * p.r * Math.sin(p.t)), k = `${Math.round(x)},${Math.round(y)}`, e = spots.get(k);
      if (e) e.n++; else spots.set(k, { x, y, n: 1 });
    }
    for (const e of spots.values()) if (e.n > 1) nodes.push(s('text', { x: e.x + 9, y: e.y - 8, class: 'count' }, `×${e.n}`));
    const cross = (x: number, y: number, out: boolean) => { const X = PX(x), Y = PY(y), m = 6; return s('path', { d: `M${X - m} ${Y - m}L${X + m} ${Y + m}M${X - m} ${Y + m}L${X + m} ${Y - m}`, class: `pole${out ? ' out' : ''}` }); };
    if (k) {
      if (bits <= LATTICE_MAX_BITS) nodes.splice(5, 0, s('path', { d: latticeDots(bits).map((q) => `M${PX(q.re).toFixed(1)} ${PY(q.im).toFixed(1)}h.01M${PX(q.re).toFixed(1)} ${PY(-q.im).toFixed(1)}h.01`).join(''), class: 'lattice' }));
      for (const g of [1, -1]) nodes.push(s('circle', { cx: PX(poles[0].r * Math.cos(poles[0].t)), cy: PY(g * poles[0].r * Math.sin(poles[0].t)), r: 8, class: 'asked' }));
      for (const q of k.roots) nodes.push(cross(q.re, q.im, Math.hypot(q.re, q.im) >= 1 - 1e-12));
      // a double root held on one spot (4 bits: both at z = 1) shows how many
      const spotsHeld = new Map<string, { x: number; y: number; n: number }>();
      for (const q of k.roots) { const x = PX(q.re), y = PY(q.im), key = `${Math.round(x)},${Math.round(y)}`, e = spotsHeld.get(key); if (e) e.n++; else spotsHeld.set(key, { x, y, n: 1 }); }
      for (const e of spotsHeld.values()) if (e.n > 1) nodes.push(s('text', { x: e.x + 9, y: e.y - 8, class: 'count' }, `×${e.n}`));
      wordKey.textContent = `◯ pole asked for · × pole held${bits <= LATTICE_MAX_BITS ? ' · dots: every pole a word can hold' : ` · no dots above ${LATTICE_MAX_BITS} bits: too many to draw`}`;
    } else {
      for (const p of poles) for (const g of [1, -1]) nodes.push(cross(p.r * Math.cos(p.t), g * p.r * Math.sin(p.t), p.r >= 1));
    }
    plane.replaceChildren(...nodes);
    // a pole on the circle at a point of this grid is a gain with no finite value: the top of the plot
    const fs = range(961).map((i) => (i / 960) * 0.5), gs = fs.map((x) => gainAt(b, a, x)), top = Math.max(...gs.filter(Number.isFinite), 1e-12);
    gain.clear();
    line(gain, fs, gs.map((g) => Math.max(DB_FLOOR, 20 * Math.log10(Math.max((Number.isFinite(g) ? Math.min(g, top) : top) / top, 1e-9)))), 'real');
    if (o.probe) { const g = gainAt(b, a, f); gain.layer.append(s('circle', { cx: gain.X(f), cy: gain.Y(Math.max(DB_FLOOR, 20 * Math.log10(Math.max((Number.isFinite(g) ? Math.min(g, top) : top) / top, 1e-9)))), r: 4, class: 'sg-pt' })); }
    const ir = impulse(b, a, 41), big = Math.max(1e-9, ...ir.map(Math.abs));
    imp.clear(); stems(imp, ir.map((v) => v / big), ok ? '' : 'out');
    chips.set(0, ok ? 'stable' : state === 'unstable' ? 'unstable: it grows' : 'on the circle: it never dies', poles.length ? 'largest pole radius ' + num(rad, 3) : 'no feedback, so always stable', ok ? '' : 'bad');
    chips.set(1, num(Math.max(0, ...poles.map((p) => p.t / (2 * Math.PI))), 3), poles.length ? 'pole\'s angle, in cycles a sample' : 'no poles');
    chips.set(2, ok ? String(Math.max(0, ...poles.map(settleOfPair))) : 'never', 'samples to fall to 1 %');
    if (!poles.length) chips.set(2, String(b.length - 1), 'samples of memory');
    if (k) {
      const asked = poles[0].r, ang = Math.abs(k.roots[0].im) > 0 ? Math.atan2(Math.abs(k.roots[0].im), k.roots[0].re) / (2 * Math.PI) : null;
      chips.set(0, ok ? 'stable' : state === 'unstable' ? 'unstable: it grows' : 'on the circle: it never dies', `largest pole radius held ${num(rad, 4)}, asked ${num(asked, 4)}`, ok ? '' : 'bad');
      chips.set(1, ang === null ? 'real poles' : num(ang, 4), `held pole's angle in cycles a sample, asked ${num(poles[0].t / (2 * Math.PI), 4)}`);
      chips.set(2, ok ? String(rad <= 0 ? 1 : Math.ceil(Math.log(0.01) / Math.log(rad))) : 'never', 'samples to fall to 1 %');
      chips.set(3 + (o.probe ? 1 : 0), `a₁ ${num(k.a1, 5)}, a₂ ${num(k.a2, 5)}`, `words ${k.words[0]} and ${k.words[1]} of step 2^−${bits - 2}; asked ${num(k.asked.a1, 5)} and ${num(k.asked.a2, 5)}`);
    }
    if (o.probe) {
      const g = gainByDistances(zeros, poles, f);
      chips.set(3, Number.isFinite(g) ? num(g, 3) : '∞', `|H| at ${num(f, 3)}: distances to the zeros over those to the poles`);
    }
    clip?.reset();
    if (o.taps) taps.textContent = `b = ${b.map((v) => num(v, 3)).join('  ')}${poles.length ? `    a = ${a.map((v) => num(v, 3)).join('  ')}` : ''}`;
  };
  // roots: nearest in the upper half-plane
  const toPlane = (e: PointerEvent): [number, number] => {
    const r = plane.getBoundingClientRect();
    return [(((e.clientX - r.left) / r.width) * SIZE - C) / U, -(((e.clientY - r.top) / r.height) * SIZE - C) / U];
  };
  const syncSliders = () => sliders.forEach((x) => x.set(x.read()));
  plane.addEventListener('pointerdown', (e) => {
    const [x, y0] = toPlane(e), y = Math.abs(y0);
    let best = Infinity;
    const look = (p: Pair, pole: boolean) => { const d = Math.hypot(x - p.r * Math.cos(p.t), y - p.r * Math.sin(p.t)); if (d < best) { best = d; drag = p; isPole = pole; } };
    zeros.forEach((p) => look(p, false)); poles.forEach((p) => look(p, true));
    if (drag) { plane.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  plane.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = toPlane(e);
    drag.r = Math.min(isPole ? 1.1 : 1.5, Math.hypot(x, y)); drag.t = Math.atan2(Math.abs(y), x);
    syncSliders(); paint();
  });
  const end = () => { drag = null; };
  plane.addEventListener('pointerup', end); plane.addEventListener('pointercancel', end);
  const rootCtl = (p: Pair, name: string, pole: boolean) => {
    const R = slider(`${name} radius`, 0, pole ? 1.1 : 1.5, 0.005, p.r, (v) => num(v, 3), (v) => { p.r = v; paint(); });
    const T = slider(`${name} angle, cycles`, 0, 0.5, 0.0025, p.t / (2 * Math.PI), (v) => num(v, 3), (v) => { p.t = v * 2 * Math.PI; paint(); });
    sliders.push({ set: (v) => R.set(v), read: () => p.r }, { set: (v) => T.set(v), read: () => p.t / (2 * Math.PI) });
    return [R.el, T.el];
  };
  const multi = (a: Pair[], one: string) => a.flatMap((p, i) => rootCtl(p, a.length > 1 ? `${one} ${i + 1}` : one, one === 'Pole'));
  const ctl = [...multi(poles, 'Pole'), ...multi(zeros, 'Zero')];
  if (word) ctl.unshift(slider('Coefficient word', word.min, word.max, 1, bits, (v) => `${v} bits`, (v) => { bits = v; paint(); }).el);
  const presets = (o.presets ?? []).map((pr) => h('button', { type: 'button', class: 'btn sm', onclick: () => {
    pr.zeros.forEach((z, i) => { if (zeros[i]) Object.assign(zeros[i], z); });
    pr.poles.forEach((z, i) => { if (poles[i]) Object.assign(poles[i], z); });
    syncSliders(); paint();
  } }, pr.name));
  const clip = o.sound ? clipButton('Play noise through it', () => {
    const { b, a } = coeffs();
    const st = held()?.state ?? stateOfPoles(poles);
    return st === 'stable' || !poles.length ? { samples: filter(b, a, noiseBlock(24000)), rate: 16000, source: 'model' as const, note: 'noise at 16 kHz through this filter' } : null;
  }, 'Refused: this filter would not stop growing') : null;
  if (o.probe) ctl.unshift(slider('Point on the circle', 0, 0.5, 0.0025, f, (v) => num(v, 3), (v) => { f = v; paint(); }).el);
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel dsp-zgrid' }, h('div', null, plane, h('div', { class: 'ln-key' }, h('span', { class: 'k-near' }, '○ zero'), h('span', { class: 'k-far' }, '× pole'), h('span', { class: 'fr-k' }, 'each with its mirror image below the axis'), word ? wordKey : '')), h('div', null, gain.el, imp.el)),
      h('div', { class: 'panel' }, chips.el, o.taps ? taps : ''),
      h('div', { class: 'panel mos-ctl' }, presets.length ? h('div', { class: 'dram-ops' }, ...presets) : '', h('div', { class: 'mos-row' }, ...ctl), clip ? clip.el : '')),
  };
}

/** n with r^n = 0.01. */
export const settleSamples = (r: number): number => (r <= 0 ? 1 : r >= 1 ? Infinity : Math.ceil(Math.log(0.01) / Math.log(r)));

// ---- same gain, different delay ----------------------------------------------------------------------------------------------------------

/** A zero pair inside the circle, and its mirror image outside: the same gain at every frequency. */
export const inner = (r: number, t: number): number[] => pairCoeffs(r, t);
export const outer = (r: number, t: number): number[] => [...pairCoeffs(r, t)].reverse();

export function delayWidget(): Widget {
  let r = 0.7, t = 1.0;
  const imp = plotOf({ W: 640, H: 150, x: [0, 2.5], y: [-2, 2], yTicks: [-1, 0, 1], xLabel: 'n', yLabel: 'impulse response', aria: 'The two impulse responses' });
  const del = plotOf({ W: 640, H: 170, x: [0, 0.5], y: [-2, 6], yTicks: [0, 2, 4], xLabel: 'cycles a sample', yLabel: 'delay, samples', aria: 'The group delay of the two filters, and of their product' });
  const chips = mkChips(3);
  const paint = () => {
    const a = inner(r, t), b = outer(r, t), both = convolve(a, b), xs = range(201).map((i) => (i / 200) * 0.5 * 0.995 + 0.001);
    imp.clear();
    stems(imp, a);
    b.forEach((v, i) => imp.layer.append(s('circle', { cx: imp.X(i + 0.15), cy: imp.Y(v), r: 4, class: 'sg-pt' })));
    del.clear();
    const da = xs.map((f) => groupDelay(a, [1], f)), db = xs.map((f) => groupDelay(b, [1], f));
    del.setY(Math.min(-2, ...da) * 1.05, Math.max(4, ...db) * 1.05);
    line(del, xs, da, 'real');
    line(del, xs, db, 'near');
    line(del, xs, xs.map((f) => groupDelay(both, [1], f)), 'lump');
    const f0 = t / (2 * Math.PI);
    chips.set(0, `${num(gainAt(a, [1], f0 * 0.5), 3)} and ${num(gainAt(b, [1], f0 * 0.5), 3)}`, `gain of each at ${num(f0 * 0.5, 3)} cycles a sample: the same, as at every frequency`);
    chips.set(1, both.map((v) => num(v, 2)).join('  '), 'the product\'s taps: symmetric');
    chips.set(2, `${num(groupDelay(both, [1], f0 * 0.5), 3)} samples`, 'the product\'s delay, at every frequency');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The same size, mirrored'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'zeros inside'), h('span', { class: 'k-near' }, 'zeros outside'), h('span', { class: 'fr-k' }, 'both together')), imp.el, del.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Zero radius', 0.3, 0.95, 0.01, r, (v) => num(v, 2), (v) => { r = v; paint(); }).el,
        slider('Zero angle, cycles', 0.3, 2.8, 0.01, t, (v) => num(v / (2 * Math.PI), 3), (v) => { t = v; paint(); }).el))),
  };
}
