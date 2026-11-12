// "Converters"'s explorers: flash against SAR, a ladder's linearity, jitter, the sigma-delta loop's spectrum, and the loop and its CIC in gates. Analogue parts are labelled models; the loop's arithmetic is exact.

import { signedOf, wordOf } from '../comm/signals';
import { prepareClip, type Clip } from '../dsp/clip';
import { enob, flashComparators, jitterHolds, jitterLimitDb, jitterMeasuredDb, ladderErrors, ladderOutput, linearity, mismatchedWeights, powerSpectrum, sarConvert, sdBand, sdBitstream, SD_LIMIT, sdLinearModelDb, SdLoop, sdMeasuredDb, sndrDb } from '../dsp/converters';
import { butterDb, CD, holdDb, linesOf } from '../dsp/dachold';
import { CicModel, cicWidth } from '../dsp/multirate';
import { sdConverter } from '../lib/sigmadelta';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { clipButton } from './clip';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const minus = (t: string) => t.replace('-', '−');
const dbs = (x: number, d = 1) => `${minus(x.toFixed(d))} dB`;

// ---- flash and SAR ----------------------------------------------------------------------------------------------------------------------------

export function sarWidget(): Widget {
  let bits = 8, v = 0.3, sigma = 0;
  const chips = mkChips(4), host = h('div');
  const paint = () => {
    const w = sigma ? mismatchedWeights(bits, sigma, 5) : undefined, r = sarConvert(v, bits, w), ideal = Math.min(2 ** bits - 1, Math.floor(((v + 1) / 2) * 2 ** bits));
    host.replaceChildren(h('table', { class: 'mini' }, h('tr', null, h('th', null, 'Clock'), h('th', null, 'Bit tried'), h('th', null, 'DAC says'), h('th', null, 'Input above it?')),
      ...r.steps.map((s, i) => h('tr', null, h('td', null, String(i + 1)), h('td', null, String(s.bit)), h('td', null, num(s.tried, 4)), h('td', null, s.keep ? 'yes: keep it' : 'no: clear it')))));
    chips.set(0, String(r.code), `the code${sigma ? `, against ${ideal} if the capacitors were right` : ''}`);
    chips.set(1, String(bits), 'comparisons, one a clock, on one comparator');
    chips.set(2, String(flashComparators(bits)), 'comparators a flash would need, deciding in one clock');
    chips.set(3, String(2 ** bits), 'matched steps either way');
  };
  const sb = slider('Bits', 4, 12, 1, bits, (x) => String(x), (x) => { bits = x; paint(); });
  const sv = slider('Input', -1, 1, 0.001, v, (x) => num(x, 3), (x) => { v = x; paint(); });
  const ss = slider('Capacitor error', 0, 0.03, 0.001, sigma, (x) => `${(x * 100).toFixed(1)} %`, (x) => { sigma = x; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'A search, one bit a clock'), host, chips.el), h('div', { class: 'panel mos-ctl' }, sb.el, sv.el, ss.el)) };
}

// ---- a ladder ---------------------------------------------------------------------------------------------------------------------------------------

export function ladderWidget(): Widget {
  const BITS = 8;
  let sigma = 0.01, seed = 5;
  const plot = plotOf({ W: 640, H: 200, x: [0, 2 ** BITS], y: [-8, 8], yTicks: [-8, -4, 0, 4, 8], xLabel: 'code', yLabel: 'LSB off the line', aria: 'How far each code\'s output sits from the straight line between the ends' });
  const chips = mkChips(4);
  const paint = () => {
    const levels = range(2 ** BITS).map((c) => ladderOutput(c, BITS, ladderErrors(BITS, sigma, seed))), q = linearity(levels);
    plot.clear(); line(plot, range(levels.length), q.inl.map((v) => Math.max(-8, Math.min(8, v))), 'ln-s real');
    chips.set(0, `${num(q.worstDnl, 2)} LSB`, 'worst step: how far from 1 LSB (DNL)');
    chips.set(1, `${num(q.worstInl, 2)} LSB`, 'worst distance from the line');
    chips.set(2, q.monotonic ? 'yes' : 'no', 'monotonic: does it only ever go up?');
    chips.set(3, String(q.dnl.reduce((m, v, i, a) => (Math.abs(v) > Math.abs(a[m]) ? i : m), 0)), 'the code before the worst step');
  };
  const ss = slider('Resistor error, σ', 0, 0.03, 0.001, sigma, (x) => `${(x * 100).toFixed(1)} %`, (x) => { sigma = x; paint(); });
  const sd = slider('Which ladder', 1, 20, 1, seed, (x) => String(x), (x) => { seed = x; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, `An ${BITS}-bit R-2R ladder, solved node by node`), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, ss.el, sd.el)) };
}

// ---- the way out: hold and smooth ------------------------------------------------------------------------------------------------------------

const OVERS = [1, 2, 4, 8] as const;
const kHz = (f: number) => `${num(f / 1e3, 1)} kHz`;
export function dacHoldWidget(): Widget {
  let fTone = 20e3, oi = 0, order = 5, correct = false;
  const time = plotOf({ W: 640, H: 170, x: [0, 150], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'time, µs', yLabel: 'level', aria: 'The tone, the DAC\'s held staircase of it, and the smoothed output half a sample later' });
  const spec = plotOf({ W: 640, H: 230, x: [0, 120], y: [-120, 0], yTicks: [-120, -80, -40, 0], xLabel: 'frequency, kHz', yLabel: 'dB under the tone', aria: 'The staircase\'s spectrum: the tone and its images under the hold\'s sin x / x, the smoothing filter, and what is left of each image after it' });
  const chips = mkChips(4);
  const paint = () => {
    const L = OVERS[oi], fs = CD.fs * L, T = 1e6 / fs, corr = correct ? -holdDb(fTone, fs) : 0;
    // time: three periods of the tone, the samples at the DAC's rate held, and what a perfect smoothing filter leaves of them
    const span = 3e6 / fTone, steps = Math.ceil(span / T);
    time.setX(span); time.clear();
    const ts = range(301).map((i) => (i / 300) * span), g = 10 ** (corr / 20);
    line(time, ts, ts.map((t) => Math.sin(2 * Math.PI * fTone * t * 1e-6)), 'lump');
    const sx: number[] = [], sy: number[] = [];
    for (let k = 0; k < steps; k++) { const v = g * Math.sin(2 * Math.PI * fTone * k * T * 1e-6); sx.push(k * T, (k + 1) * T); sy.push(v, v); }
    line(time, sx, sy, 'real');
    const gain = 10 ** ((holdDb(fTone, fs) + corr) / 20);
    line(time, ts, ts.map((t) => gain * Math.sin(2 * Math.PI * fTone * (t - T / 2) * 1e-6)), 'drv');
    // spectrum: up to two and a half DAC rates
    const top = 2.5 * fs;
    spec.setX(top / 1e3); spec.clear();
    const fx = range(801).map((i) => (i / 800) * top);
    line(spec, fx.map((f) => f / 1e3), fx.map((f) => Math.max(-120, holdDb(f, fs) - holdDb(fTone, fs))), 'lump');
    line(spec, fx.map((f) => f / 1e3), fx.map((f) => Math.max(-120, butterDb(f, CD.band, order))), 'drv');
    const ls = linesOf(fTone, fs, top), ref = holdDb(fTone, fs);
    for (const l of ls) {
      const rel = l.holdDb - ref, after = rel + butterDb(l.f, CD.band, order), x = l.f / 1e3;
      line(spec, [x, x], [-120, Math.max(-120, rel)], l.image ? 'wire' : 'real');
      if (l.image) line(spec, [x - top / 1e3 / 120, x + top / 1e3 / 120], [Math.max(-120, after), Math.max(-120, after)], 'near');
    }
    const first = ls.find((l) => l.image)!, rel1 = first.holdDb - ref, after1 = rel1 + butterDb(first.f, CD.band, order);
    chips.set(0, correct ? dbs(0, 2) : dbs(holdDb(fTone, fs), 2), correct ? `droop at the tone, lifted by ${dbs(-holdDb(fTone, fs), 2)} before the DAC` : 'droop at the tone: the hold\'s sin x / x');
    chips.set(1, `${kHz(first.f)}, ${dbs(rel1)}`, 'the first image, before the filter, under the tone');
    chips.set(2, dbs(after1), `the first image after an order-${order} filter`);
    chips.set(3, after1 <= -CD.keepDb ? 'yes' : 'no', `${CD.keepDb} dB under the tone, 16 bits' worth?`);
  };
  const sf = slider('Tone', 1000, 20000, 100, fTone, kHz, (x) => { fTone = x; paint(); });
  const so = slider('Oversampling', 0, 3, 1, oi, (x) => `${OVERS[x]} × (DAC at ${kHz(CD.fs * OVERS[x])})`, (x) => { oi = x; paint(); });
  const sn = slider('Filter order', 1, 10, 1, order, (x) => `${x} (Butterworth, corner at 20 kHz)`, (x) => { order = x; paint(); });
  const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  cb.addEventListener('change', () => { correct = cb.checked; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'CD audio, held and smoothed'), time.el, spec.el, chips.el),
    h('div', { class: 'panel mos-ctl' }, sf.el, so.el, sn.el, h('label', { class: 'mos-row' }, cb, ' Lift the droop before the DAC'))) };
}

// ---- jitter --------------------------------------------------------------------------------------------------------------------------------------------

export function jitterWidget(): Widget {
  let lf = 7, ls = -11;
  const chips = mkChips(3);
  const paint = () => {
    const f = 10 ** lf, sig = 10 ** ls, lim = jitterLimitDb(f, sig), got = jitterMeasuredDb(f, 3.3 * f, sig, 7, 16384);
    const holds = jitterHolds(f, sig);
    chips.set(0, holds ? dbs(lim) : 'no limit', holds ? '−20 log₁₀(2π f σ)' : '−20 log₁₀(2π f σ) is a small-error sum, and this jitter is a good share of the wave\'s period');
    chips.set(1, dbs(got), 'measured, on a full-scale sine');
    chips.set(2, holds ? num(enob(lim), 1) : 'none', 'effective bits that leaves, however many the converter has');
  };
  const sf = slider('Input frequency', 3, 9, 0.1, lf, (x) => { const v = 10 ** x; return v >= 1e6 ? `${num(v / 1e6, 1)} MHz` : `${num(v / 1e3, 0)} kHz`; }, (x) => { lf = x; paint(); });
  const ss = slider('Clock jitter, RMS', -13, -8, 0.1, ls, (x) => { const v = 10 ** x; return v < 1e-9 ? `${num(v * 1e12, 1)} ps` : `${num(v * 1e9, 1)} ns`; }, (x) => { ls = x; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'What a shaky clock leaves'), chips.el), h('div', { class: 'panel mos-ctl' }, sf.el, ss.el)) };
}

// ---- the loop's spectrum ----------------------------------------------------------------------------------------------------------------------------------

const SD_N = 1 << 15;
/** The spectrum's axis, as log₁₀ of cycles a sample: from the lowest bin drawn to half the rate. */
const LOG_LO = Math.log10(2 / SD_N), LOG_HI = Math.log10(0.5);
export function sdWidget(): Widget {
  let order: 1 | 2 = 2, osrLog = 6, level = 0.5;
  const plot = plotOf({ W: 640, H: 220, x: [LOG_LO, LOG_HI], y: [-120, 0], yTicks: [-120, -80, -40, 0], xLabel: 'frequency, cycles a sample', yLabel: 'dB', xFmt: (v) => (v === -3 ? '10⁻³' : v === -2 ? '10⁻²' : v === -1 ? '10⁻¹' : ''), aria: 'The spectrum of the one-bit output: a tone, and noise rising with frequency' });
  const chips = mkChips(4);
  const paint = () => {
    const osr = 2 ** osrLog, k = Math.max(3, Math.round(SD_N / osr / 8)) | 1, x = sdBitstream(order, SD_N, k, level), p = powerSpectrum(x);
    // bins grouped more widely as they go up, the largest of each, so a log axis reads as a curve
    const fs: number[] = [], ys: number[] = [];
    for (let i = 2; i < p.length; i = Math.max(i + 1, Math.floor(i * 1.04))) { const e = Math.min(p.length, Math.max(i + 1, Math.floor(i * 1.04))); let s = 0; for (let j = i; j < e; j++) s = Math.max(s, p[j]); fs.push(Math.log10(i / SD_N)); ys.push(Math.max(-120, 10 * Math.log10(s + 1e-14))); }
    plot.clear();
    line(plot, fs, ys, 'ln-s real');
    const edge = Math.log10(sdBand(osr));
    line(plot, [edge, edge], [-120, 0], 'ln-s lump');
    const got = sndrDb(x, k, sdBand(osr)), model = sdLinearModelDb(order, osr, level), next = sdMeasuredDb(order, osr * 2 > 256 ? osr : osr * 2, level, SD_N);
    chips.set(0, dbs(got), `measured, in the band: ${num(enob(got), 1)} effective bits at this level, more against a full-scale tone`);
    chips.set(1, dbs(model), 'the textbook\'s linear model');
    chips.set(2, dbs(model - got), 'how far the model is out');
    chips.set(3, osr * 2 > 256 ? '—' : dbs(next - got), 'gained by doubling the rate, at this setting');
  };
  const so = slider('Order', 1, 2, 1, order, (x) => String(x), (x) => { order = x as 1 | 2; paint(); });
  const sr = slider('Rate ×', 4, 8, 1, osrLog, (x) => String(2 ** x), (x) => { osrLog = x; paint(); });
  const sl = slider('Input level', 0.05, SD_LIMIT, 0.05, level, (x) => num(x, 2), (x) => { level = x; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'One bit, at a high rate'), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, so.el, sr.el, sl.el)) };
}

// ---- the chain, and what it sounds like ------------------------------------------------------------------------------------------------------------------

export const CHAIN = { order: 2 as const, w: 16, N: 3, R: 64 };
/** Words at the low rate from the loop and its CIC, as fractions: the model of sdConverter. */
export function chainPcm(n: number, k: number, level: number, o = CHAIN, lead = 0): number[] {
  const m = new SdLoop(o.order, o.w), c = new CicModel(o.N, o.R, cicWidth(o.N, o.R, 2)), gain = o.R ** o.N, out: number[] = [], period = n * o.R, total = (n + lead) * o.R;
  for (let i = 0; i < total; i++) {
    c.edge(m.bit ? 1 : -1);
    m.edge(Math.round(level * m.fs * Math.sin((2 * Math.PI * k * i) / period)));
    if (c.valid) out.push(c.y / gain);
  }
  return out.slice(lead);
}
/** What the chain measures, once it has filled: whole cycles in the block, so nothing leaks. */
const enobMemo = new Map<number, number>();
export function chainEnob(R = CHAIN.R, n = 2048, k = 67, level = 0.5): number {
  let v = enobMemo.get(R);
  if (v === undefined) { v = enob(sndrDb(chainPcm(n, k, level, { ...CHAIN, R }, 64), k)); enobMemo.set(R, v); }
  return v;
}

/** A second of a tone at the low rate, from the same bitstream two ways: every 64th bit, and through the CIC. */
export function chainClip(useCic: boolean): Clip {
  const n = 8000, k = 440, level = 0.5;
  if (useCic) return { samples: prepareClip(chainPcm(n, k, level)), rate: 8000, source: 'model', note: 'through the CIC' };
  const b = sdBitstream(2, n * CHAIN.R, k, level);
  return { samples: prepareClip(b.filter((_, i) => i % CHAIN.R === 0)), rate: 8000, source: 'model', note: 'every 64th bit, nothing else' };
}
export function clipWidget(): Widget {
  const chips = mkChips(3);
  [64, 128, 256].forEach((R, i) => chips.set(i, num(chainEnob(R), 1), `effective bits at ÷ ${R}, measured from the words`));
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'The same bits, kept two ways'), chips.el), h('div', { class: 'panel mos-ctl' }, clipButton('Hear every 64th bit', () => chainClip(false)).el, clipButton('Hear them through the CIC', () => chainClip(true)).el)) };
}

// ---- in gates ------------------------------------------------------------------------------------------------------------------------------------------------------

export const SCENE_CHAIN = { order: 2 as const, w: 12, N: 3, R: 32 };
export const adcApi = new WeakMap<Stage, { agrees: () => boolean; clocks: () => number; run: () => void }>();
const pulse = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };

const adcPanel: ScenePanel = (stage: Stage): Widget => {
  const { w, N, R, order } = SCENE_CHAIN, OUT = 64, CLOCKS = OUT * R, W = cicWidth(N, R, 2), gain = R ** N;
  let ys: number[] = [], bits: number[] = [], ok = true, ran = 0;
  const plot = plotOf({ W: 380, H: 150, x: [0, OUT], y: [-1.1, 1.1], yTicks: [-1, 0, 1], xLabel: 'output sample', yLabel: '', aria: 'Words leaving the CIC: a tone, recovered from one-bit samples' });
  const strip = plotOf({ W: 380, H: 70, x: [0, 128], y: [-1.3, 1.3], yTicks: [], xLabel: 'clocks at the end', yLabel: '', aria: 'The last of the bits from the loop' });
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    plot.clear(); strip.clear();
    if (ys.length) line(plot, range(ys.length), ys, 'ln-s real');
    if (bits.length) line(strip, range(bits.length), bits, 'ln-s lump');
    read.replaceChildren(h('span', null, 'clocks ', h('b', null, String(ran))), h('span', null, 'words ', h('b', null, String(ys.length))));
    note.textContent = ran ? (ok ? 'At every clock the gates matched the loop\'s model feeding the CIC\'s.' : 'The gates and the models disagreed.') : `A tone at half of full scale goes in as ${w}-bit words. Bits leave the loop, and words leave the CIC at 1/${R} of the rate.`;
  };
  const run = () => {
    stage.checkpoint();
    const sim = stage.sim!, m = new SdLoop(order, w), c = new CicModel(N, R, W);
    sim.reset('zero'); sim.setInput('clk', 0); sim.settle();
    ys = []; bits = []; ok = true; ran = 0;
    for (let i = 0; i < CLOCKS; i++) {
      const u = Math.round(0.5 * m.fs * Math.sin((2 * Math.PI * 2 * i) / CLOCKS));
      sim.setInput('u', wordOf(u, w)); sim.settle();
      pulse(stage);
      c.edge(m.bit ? 1 : -1);
      m.edge(u);
      const y = signedOf(stage.value('y'), W), v = stage.value('valid');
      if (y !== c.y || v !== (c.valid ? 1 : 0)) ok = false;
      if (c.valid) ys.push(y / gain);
      bits.push(stage.value('bit') ? 1 : -1);
      ran++;
    }
    bits = bits.slice(-128);
    stage.refresh();
    paint();
  };
  adcApi.set(stage, { agrees: () => ok && ran > 0, clocks: () => ran, run });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'One bit in, many out'),
    h('div', { class: 'dram-ops' }, h('button', { type: 'button', class: 'btn sm', onclick: run }, 'Run a tone')), plot.el, strip.el, read, note);
  stage.resetHooks.add(() => { ys = []; bits = []; ran = 0; paint(); });
  paint();
  return { el, update: () => {} };
};

export function adcScene(): Scene {
  const { order, w, N, R } = SCENE_CHAIN;
  return { root: sdConverter(order, w, N, R), inputs: { u: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [adcPanel] };
}
