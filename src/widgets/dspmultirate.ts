// "Changing the rate"'s explorers: samples thrown away and what folds, polyphase's branches, a CIC's response and growth, the whole cascade priced, and the two decimators in gates. Every number is dsp/multirate.ts's or the gates'.

import { amplitudes, firFilter, firGain, signedOf, windowedSinc, wordOf } from '../comm/signals';
import { prepareClip, type Clip } from '../dsp/clip';
import { cicAliasDb, cicDcGain, cicGrowth, CicModel, cicResponse, cicWidth, directCost, downsample, halfBand, nonZero, polyphaseCost, PolyModel, tapsFor, upsample } from '../dsp/multirate';
import { cicDecimator, POLY_SPEC, polyDecimator } from '../lib/multirate';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { clipButton } from './clip';
import { line, mkChips, num, plotOf, type Plot } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';
import { groupNum } from '../sim/numfmt';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-6));
const spaced = (x: number) => groupNum(Math.round(x));
const stems = (p: Plot, xs: readonly number[], ys: readonly number[], cls = '') => {
  xs.forEach((x, i) => { if (Math.abs(ys[i]) > 1e-3) p.layer.append(s('line', { x1: p.X(x), x2: p.X(x), y1: p.Y(0), y2: p.Y(ys[i]), class: `sg-stem ${cls}` })); });
};

// ---- throwing samples away ------------------------------------------------------------------------------------------------------------

export const ALIAS_R = 4;
const N_BLOCK = 256;
/** The filter that decimation by 4 wants: passes to 0.1 of the input's rate, stops from 0.15. */
export const antiAlias = (): number[] => windowedSinc(63, 0.125);

/** A rising tone across the whole of a band, at 16 kHz: thrown down to 4 kHz with or without the filter, as sound. */
export function sweepClip(filtered: boolean): Clip {
  const rate = 16000, n = rate * 4;
  let ph = 0;
  const x = Array.from({ length: n }, (_, i) => { ph += (2 * Math.PI * (200 + (7600 * i) / n)) / rate; return Math.sin(ph); });
  const y = downsample(filtered ? firFilter(antiAlias(), x) : x, ALIAS_R);
  return { samples: prepareClip(y), rate: rate / ALIAS_R, source: 'model', note: filtered ? 'filtered, then every fourth sample' : 'every fourth sample, nothing else' };
}

export function dropWidget(): Widget {
  let f = 0.32 * N_BLOCK;
  const before = plotOf({ W: 640, H: 150, x: [0, N_BLOCK / 2], y: [0, 1.2], yTicks: [0, 1], xLabel: 'cycles per block, at the input\'s rate', yLabel: '', aria: 'The input tone in frequency, with the new half-rate marked' });
  const after = plotOf({ W: 640, H: 150, x: [0, N_BLOCK / 2], y: [0, 1.2], yTicks: [0, 1], xLabel: 'where it lands, on the same scale', yLabel: '', aria: 'What is left after keeping every fourth sample, with and without a filter' });
  const chips = mkChips(3);
  const paint = () => {
    const k = Math.round(f), x = range(N_BLOCK).map((i) => Math.cos((2 * Math.PI * k * i) / N_BLOCK));
    const edge = N_BLOCK / 2 / ALIAS_R;
    before.clear(); stems(before, range(N_BLOCK / 2), amplitudes(x).slice(0, N_BLOCK / 2));
    before.layer.append(s('line', { x1: before.X(edge), x2: before.X(edge), y1: before.Y(0), y2: before.Y(1.2), class: 'ln-s lump' }));
    const raw = amplitudes(downsample(x, ALIAS_R)), shown = range(raw.length).map((i) => i * 1), g = firGain(antiAlias(), k / N_BLOCK);
    after.clear();
    stems(after, shown, raw.map((v) => v * 1), 'out');
    stems(after, shown.map((v) => v + 0.6), raw.map((v) => v * g));
    const land = shown[raw.findIndex((v) => v === Math.max(...raw))];
    chips.set(0, `${k} → ${land}`, k > edge ? 'it folded: a new tone, not there before' : 'in band: it keeps its place');
    chips.set(1, `${num(db(g), 0)} dB`, 'what the filter leaves of it');
    chips.set(2, `${edge}`, 'the new half-rate, in these units');
  };
  const sf = slider('Input tone', 2, N_BLOCK / 2 - 2, 1, f, (v) => String(Math.round(v)), (v) => { f = v; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Before: the tone, and the new half-rate'), before.el),
      h('div', { class: 'panel' }, h('h3', null, 'After keeping every fourth sample'), after.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'with nothing before it'), h('span', { class: 'fr-k' }, 'with the filter first')), chips.el),
      h('div', { class: 'panel mos-ctl' }, sf.el,
        clipButton('Hear a sweep: no filter', () => sweepClip(false)).el, clipButton('Hear a sweep: with the filter', () => sweepClip(true)).el)),
  };
}

// ---- the branches ------------------------------------------------------------------------------------------------------------------------

export function branchWidget(): Widget {
  let R = 4, taps = 16;
  const chips = mkChips(3), host = h('div');
  const paint = () => {
    const n = taps - (taps % R), M = n / R;
    const table = h('table', { class: 'mini' }, h('tr', null, h('th', null, 'Branch'), h('th', null, 'Taps it holds'), h('th', null, 'Samples it sees'), h('th', null, 'Runs')),
      ...range(R).map((p) => h('tr', null, h('td', null, String(p)), h('td', null, range(Math.min(M, 5)).map((j) => `h${p + R * j}`).join(' ') + (M > 5 ? ' …' : '')), h('td', null, range(Math.min(M, 3)).map((j) => `x[t−${p + R * j}]`).join(' ') + (M > 3 ? ' …' : '')), h('td', null, `once in every ${R}`))));
    host.replaceChildren(table);
    chips.set(0, String(directCost(n)), `multiplications an input sample, direct, for ${n} taps`);
    chips.set(1, num(polyphaseCost(n, R), 2), 'the same, by branches');
    chips.set(2, String(M), 'multipliers enough if one branch runs a clock');
  };
  const sr = slider('R', 2, 8, 1, R, (v) => String(v), (v) => { R = v; paint(); });
  const st = slider('Taps', 8, 64, 8, taps, (v) => String(v), (v) => { taps = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'A filter cut into R'), host, chips.el), h('div', { class: 'panel mos-ctl' }, sr.el, st.el)) };
}

// ---- going up -----------------------------------------------------------------------------------------------------------------------------

export function upWidget(): Widget {
  let k = 9;
  const L = 4, N = 64, hLong = windowedSinc(63, 1 / (2 * L));
  const stuffed = plotOf({ W: 640, H: 140, x: [0, (N * L) / 2], y: [0, 0.7], yTicks: [0, 0.5], xLabel: 'cycles per block, at the new rate', yLabel: '', aria: 'After zeros: the tone and its images' });
  const clean = plotOf({ W: 640, H: 140, x: [0, (N * L) / 2], y: [0, 1.2], yTicks: [0, 1], xLabel: 'cycles per block, at the new rate', yLabel: '', aria: 'After the filter: only the tone' });
  const chips = mkChips(2);
  const paint = () => {
    const x = range(N).map((i) => Math.cos((2 * Math.PI * k * i) / N)), up = upsample(x, L);
    const a = amplitudes(up).slice(0, (N * L) / 2);
    stuffed.clear(); stems(stuffed, range(a.length), a, 'out');
    const y = firFilter(hLong.map((v) => v * L), [...up, ...up, ...up]).slice(2 * N * L), b = amplitudes(y).slice(0, (N * L) / 2);
    clean.clear(); stems(clean, range(b.length), b);
    chips.set(0, String(a.filter((v) => v > 0.1).length - 1), 'images the zeros made');
    chips.set(1, `${num(db(Math.max(...b.filter((_, i) => i !== k), 1e-6)), 0)} dB`, 'the largest left of them, after the filter');
  };
  const sk = slider('Tone', 2, 30, 1, k, (v) => String(v), (v) => { k = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Zeros between the samples'), stuffed.el), h('div', { class: 'panel' }, h('h3', null, 'After the filter'), clean.el, chips.el), h('div', { class: 'panel mos-ctl' }, sk.el)) };
}

// ---- the CIC -----------------------------------------------------------------------------------------------------------------------------------

export function cicWidget(): Widget {
  let N = 3, R = 8;
  const plot = plotOf({ W: 640, H: 210, x: [0, 0.5], y: [-120, 5], yTicks: [-120, -80, -40, 0], xLabel: 'frequency, cycles an input sample', yLabel: 'dB', aria: 'The CIC\'s response in frequency, with nulls at each multiple of the new rate' });
  const chips = mkChips(4);
  const paint = () => {
    plot.clear();
    const fs = range(801).map((i) => i * 0.000625);
    line(plot, fs, fs.map((f) => Math.max(-120, db(cicResponse(N, R, f)))), 'ln-s real');
    for (let k = 1; k <= R / 2; k++) plot.layer.append(s('line', { x1: plot.X(k / R), x2: plot.X(k / R), y1: plot.Y(-120), y2: plot.Y(5), class: 'ln-s lump' }));
    chips.set(0, `${cicGrowth(N, R)} bits`, 'the registers grow by N log₂ R');
    chips.set(1, spaced(cicDcGain(N, R)), 'gain at DC, R^N');
    chips.set(2, `${num(db(cicResponse(N, R, 0.25 / R)), 2)} dB`, 'droop at a quarter of the new rate');
    chips.set(3, `${num(cicAliasDb(N, R, 0.125), 0)} dB`, 'the worst alias, onto an eighth of the new rate');
  };
  const sn = slider('Order N', 1, 5, 1, N, (v) => String(v), (v) => { N = v; paint(); });
  const sr = slider('R', 2, 64, 2, R, (v) => String(v), (v) => { R = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'A CIC\'s response'), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, sn.el, sr.el)) };
}

/** A run at the worst input a word can hold: the output's value against what it should be, for a register width. */
export function worstRun(N: number, R: number, wIn: number, w: number, clocks = 200): { ys: number[]; ints: number[]; want: number; got: number; wraps: number } {
  const m = new CicModel(N, R, w), worst = -(2 ** (wIn - 1)), ys: number[] = [], ints: number[] = [];
  let wraps = 0, last = 0;
  for (let i = 0; i < clocks; i++) {
    m.edge(worst);
    const v = m.ints[N - 1];
    if (Math.abs(v - last) > 2 ** (w - 1)) wraps++;
    last = v;
    ints.push(v / 2 ** (w - 1));
    ys.push(m.y / 2 ** (w - 1));
  }
  return { ys, ints, want: worst * cicDcGain(N, R), got: m.y, wraps };
}

export function growthWidget(): Widget {
  const N = 3, R = 8, wIn = 8, full = cicWidth(N, R, wIn);
  let short = 0;
  const plot = plotOf({ W: 640, H: 190, x: [0, 200], y: [-1.1, 1.1], yTicks: [-1, 0, 1], xLabel: 'clock', yLabel: 'share of the word', aria: 'The last integrator wrapping around, and the CIC\'s output' });
  const chips = mkChips(3);
  const paint = () => {
    const w = full - short, r = worstRun(N, R, wIn, w);
    plot.clear();
    line(plot, range(r.ints.length), r.ints, 'ln-s lump');
    line(plot, range(r.ys.length), r.ys, 'ln-s real');
    chips.set(0, `${w} bits`, short ? `${short} short of ${wIn} + ${cicGrowth(N, R)}` : `${wIn} + ${cicGrowth(N, R)}, as the formula says`);
    chips.set(1, String(r.wraps), 'times the last integrator wrapped');
    chips.set(2, `${spaced(r.got)}`, r.got === r.want ? `output: exactly the ${spaced(r.want)} it should be` : `output: wrong, it should be ${spaced(r.want)}`);
  };
  const ss = slider('Bits short', 0, 3, 1, short, (v) => String(v), (v) => { short = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'The largest input, held'), plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'last integrator'), h('span', { class: 'k-far' }, 'output')), chips.el), h('div', { class: 'panel mos-ctl' }, ss.el)) };
}

// ---- the whole cascade -------------------------------------------------------------------------------------------------------------------------

export const CASCADE_R = 64;
/** The order that fits the job: order 2 lets too much alias through, and order 4 droops past the band's limit (tests/dsp-chapters-c.test.ts). */
export const CIC_ORDER = 3;
export interface CascadeRow { name: string; mults: number; note: string }
/** ÷ 64: keep to 0.4 of the new rate, hold back 50 dB from 0.6. The taps come from the chapter's windowed design, so they are measured, not estimated. */
export function cascade(): CascadeRow[] {
  const pass = 0.4 / CASCADE_R, stop = 0.6 / CASCADE_R, direct = tapsFor(pass, stop, 50).n, last = tapsFor(0.4 / 4, 0.6 / 4, 50).n;
  // each halving folds onto the kept band only from its own far edge, so the early ones have room: 0.4 / 64 of the input's rate, doubling as the rate falls
  const halving = [1, 2, 3, 4, 5, 6].map((i) => { const p = (0.4 / CASCADE_R) * 2 ** (i - 1), t = tapsFor(p, 0.5 - p, 50).n; return { taps: t, mults: ((nonZero(halfBand(t)) - 1) / 2 + 1) / 2 ** i }; });
  const alias = cicAliasDb(CIC_ORDER, 16, 0.1), droop = db(cicResponse(CIC_ORDER, 16, 0.4 / CASCADE_R));
  return [
    { name: 'One filter, at the input\'s rate', mults: directCost(direct), note: `${direct} taps` },
    { name: 'The same filter, by branches', mults: polyphaseCost(direct, CASCADE_R), note: `${direct} taps, one output in ${CASCADE_R}` },
    { name: 'Halving six times', mults: halving.reduce((a, b) => a + b.mults, 0), note: `${halving[0].taps} taps at the first, ${halving[5].taps} at the last, each folded with its zeros left out` },
    { name: `CIC of order ${CIC_ORDER} ÷ 16, then a filter ÷ 4`, mults: polyphaseCost(last, 4) / 16, note: `the CIC multiplies nothing (aliases ${num(Math.abs(alias), 0)} dB down, droop ${num(Math.abs(droop), 2)} dB, inside the mask); ${last} taps at a sixteenth of the rate` },
  ];
}

export function cascadeWidget(): Widget {
  const rows = cascade(), first = rows[0].mults;
  const table = h('table', { class: 'mini' }, h('tr', null, h('th', null, 'Design'), h('th', null, 'Multiplications an input sample'), h('th', null, 'Share of the first'), h('th', null, 'How')),
    ...rows.map((r) => h('tr', null, h('td', null, r.name), h('td', null, num(r.mults, 2)), h('td', null, r.mults === first ? '1' : `1 / ${Math.round(first / r.mults)}`), h('td', null, r.note))));
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'One job, four ways: ÷ 64 with 50 dB'), table)) };
}

// ---- the decimators in gates ---------------------------------------------------------------------------------------------------------------------

export interface RateApi { agrees: () => boolean; lastTone: () => number; peak: () => number; runTone: (f: number) => void }
export const rateApi = new WeakMap<Stage, RateApi>();
const pulse = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };

interface RateModel { edge(x: number): void; y: number; valid: boolean }
/** Runs tones through a decimator's gates beside its model, and plots what leaves. */
function ratePanel(o: { title: string; wIn: number; wOut: number; gain: number; clocks: number; tones: [string, number][]; make: () => RateModel; intro: string }): ScenePanel {
  return (stage: Stage): Widget => {
    let f = o.tones[0][1], peak = 0, ok = true, ys: number[] = [], ran = false;
    const AMP = 2 ** (o.wIn - 1) - 1;
    const plot = plotOf({ W: 380, H: 170, x: [0, o.clocks], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'clock', yLabel: '', aria: 'The output of the decimator, as a share of its input\'s size' });
    const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
    const paint = () => {
      plot.clear();
      if (ys.length) {
        const xs = ys.map((_, i) => (i * o.clocks) / ys.length);
        line(plot, xs, ys, 'ln-s real');
      }
      read.replaceChildren(h('span', null, 'tone ', h('b', null, `${num(f, 4)} cycles a sample`)), h('span', null, 'output peak ÷ input ', h('b', null, num(peak, 3))), h('span', null, 'outputs ', h('b', null, String(ys.length))));
      note.textContent = ran ? (ok ? 'Every output of the gates matched the model at every clock.' : 'The gates and the model disagreed.') : o.intro;
    };
    const run = (fr: number) => {
      stage.checkpoint();
      f = fr; ys = []; ok = true; peak = 0; ran = true;
      const sim = stage.sim!, m = o.make();
      // the model starts from zeros, so the gates do too
      sim.reset('zero');
      sim.setInput('clk', 0); sim.settle();
      for (let i = 0; i < o.clocks; i++) {
        const v = Math.round(AMP * Math.cos(2 * Math.PI * fr * i));
        sim.setInput('x', wordOf(v, o.wIn)); sim.settle();
        pulse(stage);
        m.edge(v);
        const y = signedOf(stage.value('y'), o.wOut), val = stage.value('valid');
        if (y !== m.y || val !== (m.valid ? 1 : 0)) ok = false;
        if (m.valid) { const u = y / o.gain / AMP; ys.push(u); if (i > o.clocks / 3) peak = Math.max(peak, Math.abs(u)); }
      }
      stage.refresh();
      paint();
    };
    rateApi.set(stage, { agrees: () => ok && ran, lastTone: () => (ran ? f : -1), peak: () => peak, runTone: run });
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, o.title),
      h('div', { class: 'dram-ops' }, ...o.tones.map(([label, fr]) => h('button', { type: 'button', class: 'btn sm', onclick: () => run(fr) }, label))), plot.el, read, note);
    stage.resetHooks.add(() => { ys = []; peak = 0; ran = false; paint(); });
    paint();
    return { el, update: () => {} };
  };
}

export const CIC_N = 3, CIC_R = 8, CIC_IN = 8;
/** A tone at a multiple of the new rate: the moving averages add it up to exactly nothing. */
export const CIC_NULL = 1 / CIC_R;
export function cicScene(): Scene {
  const panel = ratePanel({
    title: 'A tone through the CIC', wIn: CIC_IN, wOut: cicWidth(CIC_N, CIC_R, CIC_IN), gain: cicDcGain(CIC_N, CIC_R), clocks: 320,
    tones: [['In band: 1 / 128', 1 / 128], ['On the first null: 1 / 8', CIC_NULL], ['Between nulls: 3 / 16', 3 / 16]],
    make: () => new CicModel(CIC_N, CIC_R, cicWidth(CIC_N, CIC_R, CIC_IN)),
    intro: 'Pick a tone. Samples go in at every clock, and an output leaves at every eighth.',
  });
  return { root: cicDecimator(CIC_N, CIC_R, CIC_IN), inputs: { x: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [panel] };
}
export function polyScene(): Scene {
  const { R, M, w } = POLY_SPEC, sum = POLY_SPEC.taps.reduce((a, b) => a + b, 0);
  const panel = ratePanel({
    title: 'A tone through the branches', wIn: w, wOut: 2 * w + Math.round(Math.log2(R * M)), gain: sum, clocks: 240,
    tones: [['In band: 1 / 32', 1 / 32], ['Past the new half-rate: 3 / 8', 3 / 8]],
    make: () => new PolyModel(POLY_SPEC),
    intro: 'Pick a tone. One sample a clock, one branch a clock, and an output every fourth.',
  });
  return { root: polyDecimator(POLY_SPEC), inputs: { x: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [panel] };
}
