// The signals chapter's explorers: a block and its spectrum, a pulse's width against its band, FIR filters and the filter in gates, a tone
// folding when sampled, quantizing, and a mixer. Every number is comm/signals.ts's or comm/fourier.ts's.

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
  const spec = plotOf({ W: 640, H: 170, x: [0, 64], y: [0, 1.4], yTicks: [0, 1], xLabel: 'cycles per block', yLabel: 'amplitude', aria: 'The same signal as the amplitude of each frequency' });
  const sel = h('select', { 'aria-label': 'Signal' }, ...SIGNALS.map((x, i) => h('option', { value: String(i), selected: i === pick }, x.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { pick = Number(sel.value); paint(); });
  const chips = mkChips(2);
  function paint() {
    const x = samplesOf(SIGNALS[pick]), a = amplitudes(x);
    time.clear(); line(time, range(BLOCK), x, 'ln-s real');
    spec.clear(); stems(spec, range(65), a.slice(0, 65));
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
    chips.set(1, num((band * width) / BLOCK, 2), 'band × width: about the same for any pulse');
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
    const under = f <= fs / 2;
    chips.set(0, `${num(f, 1)} Hz`, 'the tone');
    chips.set(1, `${num(fs / 2, 1)} Hz`, 'half the sample rate');
    chips.set(2, `${num(al, 1)} Hz`, 'what the samples say', under ? '' : 'bad');
    note.textContent = under ? 'Under half the rate: the samples fit one tone in this band, and it is the right one.' : `Over half the rate: the same samples fit a ${num(al, 1)} Hz tone exactly, and nothing after the sampler can tell them apart.`;
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
    chips.set(2, `${measuredSqnrDb(bits).toFixed(1)} dB`, 'the same measured on 65 536 samples');
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
