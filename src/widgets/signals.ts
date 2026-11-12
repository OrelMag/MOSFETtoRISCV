// The signals chapter's explorers: a block and its spectrum, a pulse's width against its band, FIR filters and the filter in gates, a tone
// folding when sampled, quantizing, and a mixer. Every number is comm/signals.ts's or comm/fourier.ts's.

import { type Arrow, arrow, binChain, cosinePair, expj, product } from '../comm/arrows';
import { fft, cx } from '../comm/fourier';
import {
  aliasOf, amplitudes, bandHolding, BLOCK, FIR_TAPS, firGain, FirModel, measuredSqnrDb, mixed, movingAverage, quantize, samplesOf, signedOf, SIGNALS, sqnrDb, windowedSinc, wordOf,
} from '../comm/signals';
import { FIR5 } from '../lib/fir';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { line, mkChips, num, plotOf, type Plot } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';

const stems = (p: Plot, xs: readonly number[], ys: readonly number[], cls = '') => {
  xs.forEach((x, i) => { if (Math.abs(ys[i]) > 1e-6) p.layer.append(s('line', { x1: p.X(x), x2: p.X(x), y1: p.Y(0), y2: p.Y(ys[i]), class: `sg-stem ${cls}` })); });
};
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ---- a block and its spectrum ---------------------------------------------------------------------------------------------------------

export function spectrumWidget(): Widget {
  let pick = 2;
  const time = plotOf({ W: 640, H: 170, x: [0, BLOCK], y: [-1.4, 1.4], yTicks: [-1, 0, 1], xLabel: 'samples', yLabel: 'level', aria: 'The chosen signal over one block of samples' });
  const spec = plotOf({ W: 640, H: 170, x: [0, BLOCK / 2], y: [0, 1.4], yTicks: [0, 1], xLabel: 'cycles per block', yLabel: 'amplitude', aria: 'The same signal as the amplitude of each frequency' });
  const sel = h('select', { 'aria-label': 'Signal' }, ...SIGNALS.map((x, i) => h('option', { value: String(i), selected: i === pick }, x.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { pick = Number(sel.value); paint(); });
  const chips = mkChips(2);
  function paint() {
    const x = samplesOf(SIGNALS[pick]), a = amplitudes(x);
    time.clear(); line(time, range(BLOCK), x, 'ln-s real');
    spec.clear(); stems(spec, range(a.length), a);
    chips.set(0, String(bandHolding(x, 0.9)), 'cycles per block hold 90 % of the power');
    chips.set(1, String(bandHolding(x, 0.99)), 'hold 99 %');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'In time'), time.el),
      h('div', { class: 'panel' }, h('h3', null, 'The same numbers in frequency'), spec.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Signal'), sel))),
  };
}

// ---- a pulse and its band -------------------------------------------------------------------------------------------------------------

/** A block through an ideal low-pass that keeps `bins` cycles per block. */
export function lowPassed(x: readonly number[], bins: number): number[] {
  const X = fft(cx(x)), N = x.length;
  for (let k = 0; k < N; k++) if (Math.min(k, N - k) > bins) { X.re[k] = 0; X.im[k] = 0; }
  return Array.from(fft(X, true).re);
}

export function bandwidthWidget(): Widget {
  let width = 16, keep = 20;
  const time = plotOf({ W: 640, H: 170, x: [0, 128], y: [-0.3, 1.3], yTicks: [0, 1], xLabel: 'samples', yLabel: 'level', aria: 'A pulse, and the same pulse with its high frequencies removed' });
  const chips = mkChips(3);
  function paint() {
    const x = range(BLOCK).map((i) => (i >= 32 && i < 32 + width ? 1 : 0)), y = lowPassed(x, keep);
    time.clear();
    line(time, range(128), x.slice(0, 128), 'ln-s lump');
    line(time, range(128), y.slice(0, 128), 'ln-s real');
    const band = bandHolding(x, 0.9);
    chips.set(0, String(band), 'cycles per block hold 90 % of the pulse\'s power');
    chips.set(1, num((band * width) / BLOCK, 2), 'band × width: it changes little as the pulse does');
    chips.set(2, y.some((v) => v > 0.5) ? 'yes' : 'no', 'still crosses the half-way level after the filter', y.some((v) => v > 0.5) ? '' : 'bad');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Narrow in time, wide in frequency'), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'the pulse'), h('span', { class: 'k-far' }, 'what the band leaves')), time.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Pulse', 2, 48, 2, width, (v) => `${v} samples`, (v) => { width = v; paint(); }).el,
        slider('Band', 1, 64, 1, keep, (v) => `${v} cycles / block`, (v) => { keep = v; paint(); }).el))),
  };
}

// ---- a filter's taps and response -------------------------------------------------------------------------------------------------------

const DESIGNS: { name: string; taps: (n: number, fc: number) => number[] }[] = [
  { name: 'Moving average', taps: (n) => movingAverage(n) },
  { name: 'Binomial 1 4 6 4 1', taps: () => [...FIR_TAPS] },
  { name: 'Windowed sinc', taps: (n, fc) => windowedSinc(n, fc) },
];

export function filterWidget(): Widget {
  let design = 0, n = 5, fc = 0.1;
  const tapsP = plotOf({ W: 300, H: 150, x: [0, 31], y: [-0.4, 1.1], yTicks: [0, 1], xLabel: 'tap', yLabel: '', aria: 'The filter\'s taps, scaled to the largest' });
  const resp = plotOf({ W: 640, H: 180, x: [0, 0.5], y: [0, 1.1], yTicks: [0, 0.5, 1], xLabel: 'cycles a sample', yLabel: 'gain', aria: 'The filter\'s gain at each frequency', xFmt: (v) => num(v, 2) });
  const sel = h('select', { 'aria-label': 'Filter design' }, ...DESIGNS.map((d, i) => h('option', { value: String(i) }, d.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { design = Number(sel.value); paint(); });
  const chips = mkChips(3);
  function paint() {
    const t = DESIGNS[design].taps(n, fc), peak = Math.max(...t.map(Math.abs));
    tapsP.setX(Math.max(4, t.length - 1));
    tapsP.clear(); stems(tapsP, range(t.length), t.map((v) => v / peak));
    const fs = range(201).map((i) => (i / 200) * 0.5);
    resp.clear(); line(resp, fs, fs.map((f) => firGain(t, f)), 'ln-s real');
    chips.set(0, String(t.length), 'taps: one multiplication each, every sample');
    chips.set(1, num(firGain(t, 0.05), 2), 'gain at 0.05 cycles a sample');
    chips.set(2, num(firGain(t, 0.25), 3), 'gain at 0.25');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The taps'), tapsP.el),
      h('div', { class: 'panel' }, h('h3', null, 'What they do to each frequency'), resp.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Design'), sel), h('div', { class: 'mos-row' },
        slider('Taps', 3, 31, 2, n, (v) => String(v), (v) => { n = v; paint(); }).el,
        slider('Cut-off', 0.02, 0.45, 0.01, fc, (v) => `${v.toFixed(2)} cycles a sample`, (v) => { fc = v; paint(); }).el))),
  };
}

// ---- the filter in gates ----------------------------------------------------------------------------------------------------------------

/** What the panel keeps per stage, for the challenge. */
export const firApi = new WeakMap<Stage, { lastPeak: () => number; lastTone: () => number; agrees: () => boolean; runTone: (f: number) => void }>();

/** Half the sample rate: the sign alternates at every clock. */
export const FIR_FASTEST = 1 / 2;
const TONES: [string, number][] = [['Slow: 32 samples a cycle', 1 / 32], ['A quarter of the rate', 1 / 4], ['The fastest: + − + −', FIR_FASTEST]];

const pulseClock = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };

const firPanel: ScenePanel = (stage: Stage): Widget => {
  const N = 96, AMP = 100;
  let f = TONES[0][1], peak = 0, ok = true, xs: number[] = [], ys: number[] = [];
  const plot = plotOf({ W: 380, H: 170, x: [0, N], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'clock', yLabel: '', aria: 'The input samples and the filter\'s output divided by its gain of 16' });
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const m = new FirModel();
  const paint = () => {
    plot.clear();
    if (xs.length) { line(plot, range(xs.length), xs, 'ln-s lump'); line(plot, range(ys.length), ys, 'ln-s real'); }
    read.replaceChildren(h('span', null, 'tone ', h('b', null, `${num(f, 3)} cycles a sample`)), h('span', null, 'output peak ÷ input ', h('b', null, num(peak, 3))));
    note.textContent = xs.length ? (ok ? 'Every output of the gates matched the model at every clock.' : 'The gates and the model disagreed.') : 'Pick a tone: the samples go in at the clock, the gates compute, and the model runs beside them.';
  };
  const run = (cycles: number) => {
    stage.checkpoint();
    xs = []; ys = []; ok = true; peak = 0;
    m.regs = [0, 0, 0, 0, 0];
    const sim = stage.sim!;
    // flush what the filter held, so the run starts from zeros
    sim.setInput('x', 0); sim.settle();
    for (let i = 0; i < 5; i++) pulseClock(stage);
    for (let i = 0; i < cycles; i++) {
      const v = Math.round(AMP * Math.cos(2 * Math.PI * f * i));
      sim.setInput('x', wordOf(v, 8)); sim.settle();
      pulseClock(stage);
      m.edge(v);
      const y = signedOf(stage.value('y'), 12);
      if (y !== m.y) ok = false;
      xs.push(v / AMP); ys.push(y / 16 / AMP);
      if (i >= 5) peak = Math.max(peak, Math.abs(y / 16 / AMP));
    }
    stage.refresh();
    paint();
  };
  firApi.set(stage, { lastPeak: () => peak, lastTone: () => (xs.length ? f : -1), agrees: () => ok && xs.length > 0, runTone: (fr) => { f = fr; run(N); } });
  const btn = ([label, fr]: [string, number]) => h('button', { type: 'button', class: 'btn sm', onclick: () => { f = fr; run(N); } }, label);
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'A tone through the gates'),
    h('div', { class: 'dram-ops' }, ...TONES.map(btn)), plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'input'), h('span', { class: 'k-far' }, 'output ÷ 16')), read, note);
  stage.resetHooks.add(() => { xs = []; ys = []; peak = 0; paint(); });
  paint();
  return { el, update: () => {} };
};

export function firScene(): Scene {
  return { root: FIR5, inputs: { x: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [firPanel] };
}

// ---- sampling -----------------------------------------------------------------------------------------------------------------------------

export function aliasWidget(): Widget {
  let f = 3, fs = 10;
  const WIN = 2;
  const plot = plotOf({ W: 640, H: 200, x: [0, WIN], y: [-1.3, 1.3], yTicks: [-1, 0, 1], xLabel: 'seconds', yLabel: 'level', aria: 'A tone, its samples, and the slower tone the same samples also fit' });
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  function paint() {
    const ts = range(601).map((i) => (i / 600) * WIN), al = aliasOf(f, fs);
    // a cosine and its alias agree exactly at the sample times
    plot.clear();
    line(plot, ts, ts.map((t) => Math.cos(2 * Math.PI * f * t)), 'ln-s lump');
    line(plot, ts, ts.map((t) => Math.cos(2 * Math.PI * al * t)), 'ln-s real');
    for (let k = 0; k <= WIN * fs; k++) plot.layer.append(s('circle', { cx: plot.X(k / fs), cy: plot.Y(Math.cos(2 * Math.PI * f * (k / fs))), r: 4, class: 'sg-pt' }));
    const under = f < fs / 2;
    chips.set(0, `${num(f, 1)} Hz`, 'the tone');
    chips.set(1, `${num(fs / 2, 1)} Hz`, 'half the sample rate');
    chips.set(2, `${num(al, 1)} Hz`, 'what the samples say', under ? '' : 'bad');
    note.textContent = under ? 'Under half the rate: the samples fit one tone in this band, and it is the right one.' : f === fs / 2 ? 'Exactly half the rate: what the samples read depends on the phase, so this frequency is not safe either.' : `Over half the rate: the same samples fit a ${num(al, 1)} Hz tone exactly, and nothing after the sampler can tell them apart.`;
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A tone, sampled'), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'the tone'), h('span', { class: 'k-far' }, 'what the samples say'), h('span', { class: 'k-near' }, 'samples')), plot.el, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Tone', 0, 30, 0.5, f, (v) => `${num(v, 1)} Hz`, (v) => { f = v; paint(); }).el,
        slider('Sample rate', 4, 40, 1, fs, (v) => `${v} Hz`, (v) => { fs = v; paint(); }).el))),
  };
}

export function quantizeWidget(): Widget {
  let bits = 3;
  const N = 400;
  const plot = plotOf({ W: 640, H: 200, x: [0, 1], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'one cycle', yLabel: 'level', aria: 'A sine and the nearest levels a converter of this many bits can write', xFmt: (v) => num(v, 1) });
  const err = plotOf({ W: 640, H: 100, x: [0, 1], y: [-0.3, 0.3], yTicks: [-0.2, 0, 0.2], xLabel: 'one cycle', yLabel: 'error', aria: 'The difference between the sine and its rounded form', xFmt: (v) => num(v, 1) });
  const chips = mkChips(3);
  function paint() {
    const ts = range(N + 1).map((i) => i / N), x = ts.map((t) => Math.sin(2 * Math.PI * t)), q = x.map((v) => quantize(v, bits));
    plot.clear(); line(plot, ts, x, 'ln-s lump'); line(plot, ts, q, 'ln-s real');
    err.clear(); line(err, ts, x.map((v, i) => v - q[i]), 'ln-s near');
    chips.set(0, String(2 ** bits), 'levels');
    chips.set(1, `${sqnrDb(bits).toFixed(1)} dB`, 'signal to rounding error, 6.02 b + 1.76');
    chips.set(2, `${measuredSqnrDb(bits).toFixed(1)} dB`, 'the same measured on 65 536 samples');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Rounding to a number'), plot.el, err.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, slider('Bits', 1, 12, 1, bits, (v) => String(v), (v) => { bits = v; paint(); }).el)),
  };
}

// ---- a mixer --------------------------------------------------------------------------------------------------------------------------------

export function mixerWidget(): Widget {
  let tone = 4, carrier = 40, again = false;
  const time = plotOf({ W: 640, H: 150, x: [0, BLOCK], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'samples', yLabel: 'level', aria: 'The tone multiplied by the carrier' });
  const spec = plotOf({ W: 640, H: 160, x: [0, 96], y: [0, 1.1], yTicks: [0, 0.5, 1], xLabel: 'cycles per block', yLabel: 'amplitude', aria: 'The spectrum before and after the mixer' });
  const chips = mkChips(2), box = h('input', { type: 'checkbox', 'aria-label': 'Multiply by the carrier a second time' }) as HTMLInputElement;
  box.addEventListener('change', () => { again = box.checked; paint(); });
  function paint() {
    const y = range(BLOCK).map((i) => { const t = i / BLOCK, m = mixed(tone, carrier, t); return again ? m * Math.cos(2 * Math.PI * carrier * t) * 2 : m; });
    time.clear(); line(time, range(BLOCK), y, 'ln-s real');
    spec.clear();
    const inA = new Array<number>(97).fill(0); inA[tone] = 1;
    stems(spec, range(97), inA, 'out');
    stems(spec, range(97), amplitudes(y).slice(0, 97));
    chips.set(0, `${carrier - tone} and ${carrier + tone}`, 'cycles per block after one mixer: carrier − tone, carrier + tone');
    chips.set(1, again ? `${tone}, ${2 * carrier - tone}, ${2 * carrier + tone}` : '—', 'after a second mixer: the tone is back, and the rest is for a filter to remove');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A tone times a carrier'), time.el),
      h('div', { class: 'panel' }, h('h3', null, 'Moved up the band'), h('div', { class: 'ln-key' }, h('span', { class: 'k-near' }, 'the tone'), h('span', { class: 'k-far' }, 'after the mixer')), spec.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Tone', 1, 16, 1, tone, (v) => String(v), (v) => { tone = v; paint(); }).el,
        slider('Carrier', 24, 56, 1, carrier, (v) => String(v), (v) => { carrier = v; paint(); }).el),
        h('label', { class: 'mos-sl' }, box, h('span', null, 'Multiply by the carrier again (a receiver)')))),
  };
}

// ---- arrows that turn: complex numbers --------------------------------------------------------------------------------------------------------

export type ArrowTab = 'multiply' | 'turn' | 'two' | 'bin';
const TAB_NAMES: Record<ArrowTab, string> = { multiply: 'Multiply', turn: 'Turn', two: 'Two arrows', bin: 'A bin' };
export const ARROW_TABS: readonly ArrowTab[] = ['multiply', 'turn', 'two', 'bin'];

/** a + jb as text: 2 + j, 1 + 3j, −1, 0.5 − 0.5j. */
export function fmtArrow(a: Arrow, d = 2): string {
  const r = num(a.re, d), i = num(Math.abs(a.im), d), neg = a.im < -1e-9;
  if (Math.abs(a.im) < 1e-9) return r.replace('-', '−');
  const im = `${i === '1' ? '' : i}j`;
  return Math.abs(a.re) < 1e-9 ? `${neg ? '−' : ''}${im}` : `${r.replace('-', '−')} ${neg ? '−' : '+'} ${im}`;
}
const wrapDeg = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
const deg1 = (x: number) => `${num(x === 0 ? 0 : x, 1).replace('-', '−')}°`;

/**
 * Chapter signals' arrows: four tabs on one plane (Multiply, Turn, Two arrows, A bin), arithmetic only, every number from comm/arrows.ts.
 * `tabs` and `start` let a later chapter mount a subset.
 */
export function arrowWidget(opts: { tabs?: readonly ArrowTab[]; start?: ArrowTab } = {}): Widget {
  const tabs = opts.tabs ?? ARROW_TABS;
  let tab: ArrowTab = opts.start && tabs.includes(opts.start) ? opts.start : tabs[0];
  let z = arrow(2, 1), w = arrow(1, 1), theta = 30, mirror = false, pick = 0, k = 8, timer: ReturnType<typeof setInterval> | null = null;
  const WIDE = 640, NARROW = 340, H = 300, CX = 170, CY = 150, RPX = 125;
  const svg = s('svg', { class: 'sg-plane', role: 'group' }) as SVGSVGElement;
  const chips = mkChips(3), live = h('div', { 'aria-live': 'polite' }, chips.el), note = h('p', { class: 'sub mos-note' });
  const controls = h('div', { class: 'panel mos-ctl' });
  const tabRow = h('div', { class: 'fb-tabs', role: 'group', 'aria-label': 'Which picture' });
  const runBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => toggleRun() }, 'Run');

  const el_ = (tag: 'line' | 'path' | 'circle' | 'text' | 'polygon', a: Record<string, string | number>, text?: string) => svg.appendChild(s(tag, a, ...(text === undefined ? [] : [text])));
  let labels: { l: number; r: number; t: number; b: number }[] = [];
  /** An arrow from the centre (or `from`) to a point, in plane units; `px` = pixels a unit. */
  const draw = (a: Arrow, px: number, cls: string, label?: string, from: Arrow = arrow(0), cx0 = CX, cy0 = CY, width = 2.5) => {
    const x0 = cx0 + from.re * px, y0 = cy0 - from.im * px, x1 = cx0 + (from.re + a.re) * px, y1 = cy0 - (from.im + a.im) * px;
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L < 1) return;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L, hl = Math.min(10, L * 0.6);
    el_('line', { x1: x0, y1: y0, x2: x1 - ux * hl * 0.8, y2: y1 - uy * hl * 0.8, class: `sg-arrow ${cls}`, 'stroke-width': width });
    el_('polygon', { points: `${x1},${y1} ${x1 - ux * hl - uy * hl * 0.45},${y1 - uy * hl + ux * hl * 0.45} ${x1 - ux * hl + uy * hl * 0.45},${y1 - uy * hl - ux * hl * 0.45}`, class: `sg-head ${cls}` });
    if (!label) return;
    // two tips close together (2 + j beside 1 + j) would print their names over each other: step the later one a line away
    const x = x1 + (ux >= 0 ? 6 : -6), wd = label.length * 7, left = ux >= 0 ? x : x - wd;
    let y = y1 + (uy > 0 ? 14 : -6);
    for (let k = 0; k < 6 && labels.some((b) => left < b.r && b.l < left + wd && y - 12 < b.b && b.t < y + 2); k++) y += uy > 0 ? 14 : -14;
    labels.push({ l: left, r: left + wd, t: y - 12, b: y + 2 });
    el_('text', { x, y, 'text-anchor': ux >= 0 ? 'start' : 'end', class: `sg-lab ${cls}` }, label);
  };
  const axes = (px: number, R: number, cx0 = CX, cy0 = CY) => {
    el_('line', { x1: cx0 - R * px, y1: cy0, x2: cx0 + R * px, y2: cy0, class: 'sg-ax' });
    el_('line', { x1: cx0, y1: cy0 - R * px, x2: cx0, y2: cy0 + R * px, class: 'sg-ax' });
    el_('text', { x: cx0 + R * px, y: cy0 + 14, 'text-anchor': 'end', class: 'sg-tick' }, 'real');
    el_('text', { x: cx0 + 6, y: cy0 - R * px + 10, class: 'sg-tick' }, 'imaginary');
    for (let u = 1; u <= R; u++) for (const sgn of [-1, 1]) { el_('line', { x1: cx0 + sgn * u * px, y1: cy0 - 3, x2: cx0 + sgn * u * px, y2: cy0 + 3, class: 'sg-ax' }); el_('line', { x1: cx0 - 3, y1: cy0 - sgn * u * px, x2: cx0 + 3, y2: cy0 - sgn * u * px, class: 'sg-ax' }); }
  };
  const arc = (deg: number, r: number, cls: string, cx0 = CX, cy0 = CY) => {
    if (Math.abs(deg) < 0.5) return;
    const t = (deg * Math.PI) / 180;
    el_('path', { d: `M${cx0 + r},${cy0} A${r},${r} 0 ${Math.abs(deg) > 180 ? 1 : 0} ${deg > 0 ? 0 : 1} ${cx0 + r * Math.cos(t)},${cy0 - r * Math.sin(t)}`, class: `sg-arc ${cls}` });
  };
  const cosTrace = (X0: number, X1: number, px: number) => `M${range(73).map((i) => `${X0 + (i / 72) * (X1 - X0)},${CY - Math.cos((i * 5 * Math.PI) / 180) * px}`).join(' L')}`;

  function paintMultiply() {
    const r = product(z, w), R = Math.max(3, Math.ceil(Math.max(...r.lengths))), px = RPX / R;
    svg.setAttribute('viewBox', `0 0 ${NARROW} ${H}`);
    axes(px, R);
    arc(r.angles[0], 30, 'za'); arc(r.angles[1], 42, 'wa'); arc(r.angles[2], 54, 'pa');
    draw(r.z, px, 'za', `z = ${fmtArrow(z)}`); draw(r.w, px, 'wa', `w = ${fmtArrow(w)}`); draw(r.p, px, 'pa', `zw = ${fmtArrow(r.p)}`, arrow(0), CX, CY, 3);
    const sum = wrapDeg(r.angles[0] + r.angles[1]);
    chips.set(0, `${num(r.lengths[0], 2)} × ${num(r.lengths[1], 2)} = ${num(r.lengths[2], 2)}`, 'the lengths multiply');
    chips.set(1, `${deg1(r.angles[0])} + ${deg1(r.angles[1])} = ${deg1(r.lengths[2] < 1e-9 ? 0 : sum)}`, 'the angles add');
    chips.set(2, fmtArrow(r.p), '(a + jb)(c + jd) = (ac − bd) + j(ad + bc)');
    note.textContent = 'z is blue, w orange, and their product green. An arrow of length 1 only turns what it multiplies; a real number only stretches it.';
    svg.setAttribute('aria-label', `z = ${fmtArrow(z)}, w = ${fmtArrow(w)}, their product ${fmtArrow(r.p)}: length ${num(r.lengths[2], 2)}, angle ${deg1(r.angles[2])}`);
  }

  function paintTurn() {
    const t = (theta * Math.PI) / 180, e = expj(t), px = 100, cx0 = 130, X0 = 300, X1 = 610;
    svg.setAttribute('viewBox', `0 0 ${WIDE} ${H}`);
    axes(px, 1.3, cx0, CY);
    el_('circle', { cx: cx0, cy: CY, r: px, class: 'sg-unit' });
    arc(theta, 24, 'za', cx0, CY);
    // the trace: cos of every angle, with the arrow's shadow on the real axis carried across to it
    const xs = (a: number) => X0 + (a / 360) * (X1 - X0), ys = (v: number) => CY - v * px;
    el_('line', { x1: X0, y1: CY, x2: X1, y2: CY, class: 'sg-ax' }); el_('line', { x1: X0, y1: CY - px, x2: X0, y2: CY + px, class: 'sg-ax' });
    el_('text', { x: X1, y: CY + 16, 'text-anchor': 'end', class: 'sg-tick' }, 'angle θ, 0° to 360°');
    el_('text', { x: X0 + 6, y: CY - px + 4, class: 'sg-tick' }, 'cos θ');
    el_('path', { d: cosTrace(X0, X1, px), class: 'sg-trace' });
    el_('line', { x1: cx0 + e.re * px, y1: CY - e.im * px, x2: xs(theta), y2: ys(e.re), class: 'sg-shadow' });
    el_('line', { x1: cx0 + e.re * px, y1: CY - e.im * px, x2: cx0 + e.re * px, y2: CY, class: 'sg-shadow' });
    el_('circle', { cx: xs(theta), cy: ys(e.re), r: 4, class: 'sg-pt' });
    draw(e, px, 'za', undefined, arrow(0), cx0, CY);
    chips.set(0, `cos ${theta}° + j sin ${theta}° = ${fmtArrow(e)}`, 'the arrow of length 1 at θ, written e^(jθ)');
    chips.set(1, num(e.re, 3).replace('-', '−'), 'its shadow on the real axis: cos θ');
    chips.set(2, num(e.im, 3).replace('-', '−'), 'its shadow on the imaginary axis: sin θ');
    note.textContent = 'At 0° the arrow is 1, at 90° it is j, at 180° it is −1. Run it, and the shadow draws a cosine.';
    svg.setAttribute('aria-label', `The arrow e^jθ at θ = ${theta} degrees, ${fmtArrow(e)}, and the cosine its shadow draws`);
  }

  function paintTwo() {
    const t = (theta * Math.PI) / 180, c = cosinePair(t), px = 200, cx0 = 130, X0 = 300, X1 = 610;
    svg.setAttribute('viewBox', `0 0 ${WIDE} ${H}`);
    axes(px, 0.65, cx0, CY);
    draw(c.plus, px, 'za', '+f', arrow(0), cx0, CY);
    if (mirror) { draw(c.minus, px, 'wa', '−f', arrow(0), cx0, CY); draw(c.sum, px, 'pa', 'sum', arrow(0), cx0, CY, 4); }
    el_('line', { x1: X0, y1: CY, x2: X1, y2: CY, class: 'sg-ax' });
    el_('text', { x: X0 + 6, y: CY - 104, class: 'sg-tick' }, 'cos θ, the real part of the sum');
    el_('path', { d: cosTrace(X0, X1, 100), class: 'sg-trace' });
    if (mirror) el_('circle', { cx: X0 + (theta / 360) * (X1 - X0), cy: CY - c.sum.re * 100, r: 4, class: 'sg-pt' });
    chips.set(0, '½ + ½', 'two arrows of length ½, turning opposite ways');
    chips.set(1, mirror ? num(c.sum.im, 3).replace(/^-0$/, '0') : '—', 'imaginary part of their sum: the upward parts cancel', mirror ? '' : 'bad');
    chips.set(2, mirror ? num(c.sum.re, 3).replace('-', '−') : '—', 'real part: the sideways parts add, cos θ');
    note.textContent = mirror ? 'Their upward parts cancel at every instant and the sideways parts add, so the sum never leaves the real axis. A real cosine needs both.' : 'One arrow alone leaves the real axis. Switch the mirror arrow on.';
    svg.setAttribute('aria-label', `The arrows e^jθ/2 and e^−jθ/2 at θ = ${theta} degrees${mirror ? `; their sum is ${num(c.sum.re, 3)}, on the real axis` : ''}`);
  }

  function paintBin() {
    const sigDef = SIGNALS[pick], b = binChain(samplesOf(sigDef), k), half = b.N / 2;
    svg.setAttribute('viewBox', `0 0 ${NARROW} ${H}`);
    const pts = b.partial;
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (const p of pts) { x0 = Math.min(x0, p.re); x1 = Math.max(x1, p.re); y0 = Math.min(y0, p.im); y1 = Math.max(y1, p.im); }
    const span = Math.max(x1 - x0, y1 - y0, 1e-9), px = 240 / span, cx0 = 170 - ((x0 + x1) / 2) * px, cy0 = 150 + ((y0 + y1) / 2) * px;
    el_('line', { x1: 10, y1: cy0, x2: NARROW - 10, y2: cy0, class: 'sg-ax' }); el_('line', { x1: cx0, y1: 10, x2: cx0, y2: H - 10, class: 'sg-ax' });
    el_('path', { d: `M${pts.map((p) => `${(cx0 + p.re * px).toFixed(1)},${(cy0 - p.im * px).toFixed(1)}`).join(' L')}`, class: 'sg-chain' });
    const closed = b.length < 1e-6 * Math.max(1, half);
    if (!closed) draw(b.total, px, 'ra', undefined, arrow(0), cx0, cy0, 3);
    el_('circle', { cx: cx0, cy: cy0, r: 3.5, class: 'sg-pt' });
    chips.set(0, num(b.length, 1), `|X[${k}]|: ${closed ? 'the chain closes' : 'the arrow from start to end'}`, closed ? 'bad' : '');
    chips.set(1, closed ? '0' : num(b.amplitude, 3), `÷ ${half}: the amplitude the spectrum reads`);
    chips.set(2, closed ? '—' : deg1(b.phase), 'its angle: the phase');
    note.textContent = closed ? `${sigDef.name} has nothing at bin ${k}: the products go round and close up.` : `The ${b.N} products x[n]·e^(−j2π${k}n/${b.N}), added head to tail. Where the signal has a tone the turning cancels and they pile up; elsewhere they curl round.`;
    svg.setAttribute('aria-label', `${sigDef.name}, bin ${k}: ${closed ? 'the chain of products closes to zero' : `an arrow of length ${num(b.length, 1)} at ${deg1(b.phase)}`}`);
  }

  let syncSlider: () => void = () => {};
  function stop() { if (timer) { clearInterval(timer); timer = null; } runBtn.textContent = 'Run'; }
  function toggleRun() {
    if (timer) { stop(); return; }
    runBtn.textContent = 'Stop';
    timer = setInterval(() => { theta = (theta + 3) % 360; syncSlider(); paint(); }, 40);
  }

  function buildControls() {
    stop();
    controls.replaceChildren();
    const row = (...kids: HTMLElement[]) => controls.append(h('div', { class: 'mos-row' }, ...kids));
    const reim = (label: string, get: () => Arrow, set: (a: Arrow) => void) => [
      slider(`${label} real`, -3, 3, 0.5, get().re, (v) => num(v, 1).replace('-', '−'), (v) => { set(arrow(v, get().im)); paint(); }).el,
      slider(`${label} imaginary`, -3, 3, 0.5, get().im, (v) => num(v, 1).replace('-', '−'), (v) => { set(arrow(get().re, v)); paint(); }).el,
    ];
    if (tab === 'multiply') { row(...reim('z', () => z, (a) => { z = a; })); row(...reim('w', () => w, (a) => { w = a; })); return; }
    if (tab === 'turn' || tab === 'two') {
      const sl = slider('θ', 0, 360, 5, theta, (v) => `${v}°`, (v) => { theta = v; paint(); });
      syncSlider = () => sl.set(theta);
      row(sl.el, runBtn);
      if (tab === 'two') {
        const box = h('input', { type: 'checkbox', 'aria-label': 'Show the mirror arrow at −f' }) as HTMLInputElement;
        box.checked = mirror;
        box.addEventListener('change', () => { mirror = box.checked; paint(); });
        controls.append(h('label', { class: 'mos-sl' }, box, h('span', null, 'The mirror arrow, turning the other way (−f)')));
      }
      return;
    }
    const sel = h('select', { 'aria-label': 'Signal' }, ...SIGNALS.map((x, i) => h('option', { value: String(i), selected: i === pick }, x.name))) as HTMLSelectElement;
    sel.addEventListener('change', () => { pick = Number(sel.value); paint(); });
    row(h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Signal'), sel), slider('Bin k', 0, BLOCK / 2, 1, k, (v) => String(v), (v) => { k = v; paint(); }).el);
  }

  function paint() {
    svg.replaceChildren();
    labels = [];
    ({ multiply: paintMultiply, turn: paintTurn, two: paintTwo, bin: paintBin })[tab]();
  }
  const mark = () => tabBtns.forEach((b, i) => { b.classList.toggle('on', tabs[i] === tab); b.setAttribute('aria-pressed', String(tabs[i] === tab)); });
  const tabBtns: HTMLButtonElement[] = tabs.map((t) => h('button', { type: 'button', class: 'btn sm', onclick: () => { tab = t; mark(); buildControls(); paint(); } }, TAB_NAMES[t]));
  mark();
  if (tabs.length > 1) tabRow.append(...tabBtns);
  buildControls(); paint();
  return {
    el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, tabs.length > 1 ? tabRow : '', h('div', { class: 'sg-planebox' }, svg), live, note), controls),
    destroy: stop,
  };
}
