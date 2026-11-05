// "Numbers that fit": a word and its point, a sum past full scale with sound, rounding's drift, a running sum by each rule, where the gain goes, and
// what fixed and floating cost. Every number is dsp/fixed.ts's or dsp/fixeddemos.ts's, and every cost is counted from the gates.

import { bitsToHold, qName, wordMax, wordMin, type Rounding } from '../dsp/fixed';
import { chainSnr, overflowRun, roundingRun, runningSum, TONES_RATE, type PastFull } from '../dsp/fixeddemos';
import { fracMultiplier, satAdder } from '../lib/fixedpt';
import { rca } from '../lib/combinational';
import { fpAdd, fpMul } from '../lib/fpu';
import { treeMul } from '../lib/muldiv';
import { stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { Scene, Widget } from '../view/stage';
import { clipButton } from './clip';
import { hline, line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/dsp.css';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const db = (v: number) => (v > 200 ? 'above 200 dB' : `${Math.abs(v) < 0.05 ? '0.0' : v.toFixed(1).replace('-', '−')} dB`);

// ---- a word and its point -------------------------------------------------------------------------------------------------------------

export function qWidget(): Widget {
  let w = 8, f = 7, raw = 96;
  const bits = h('div', { class: 'dsp-bits', role: 'img' }), chips = mkChips(4);
  const paint = () => {
    f = Math.min(f, w - 1);
    raw = Math.max(wordMin(w), Math.min(wordMax(w), raw));
    const u = raw < 0 ? raw + 2 ** w : raw;
    bits.setAttribute('aria-label', `${w} bits, ${f} of them after the point`);
    bits.replaceChildren(...range(w).map((i) => {
      const k = w - 1 - i, on = Math.floor(u / 2 ** k) % 2 === 1;
      return h('div', { class: `dsp-bit${on ? ' on' : ''}${k === w - 1 ? ' sign' : ''}${k === f ? ' before-point' : ''}` }, h('b', null, on ? '1' : '0'), h('span', null, `${k === w - 1 ? '−' : ''}2^${k - f}`));
    }));
    chips.set(0, qName({ w, f }), 'the format');
    chips.set(1, num(raw / 2 ** f, f), 'this word means');
    chips.set(2, `${num(wordMin(w) / 2 ** f, 0)} to ${num(wordMax(w) / 2 ** f, f)}`, 'the range');
    chips.set(3, f ? `2^−${f}` : '1', 'the step');
    wordIn.el.querySelector('input')!.setAttribute('min', String(wordMin(w)));
    wordIn.el.querySelector('input')!.setAttribute('max', String(wordMax(w)));
    wordIn.set(raw);
  };
  const wordIn = slider('The word', -128, 127, 1, raw, (v) => String(v), (v) => { raw = v; paint(); });
  const wide = slider('Bits', 2, 16, 1, w, (v) => String(v), (v) => { w = v; if (f > w - 1) fIn.set((f = w - 1)); paint(); });
  const fIn = slider('After the point', 0, 15, 1, f, (v) => String(v), (v) => { f = Math.min(v, w - 1); fIn.set(f); paint(); });
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The same adder, a different meaning'), bits, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, wide.el, fIn.el, wordIn.el))),
  };
}

// ---- past full scale -----------------------------------------------------------------------------------------------------------------

export function overflowWidget(): Widget {
  let g = 6, b = 16, mode: PastFull = 'wrap', run = overflowRun(g, b, mode);
  const SHOW = 160, plot = plotOf({ W: 640, H: 220, x: [0, SHOW / (TONES_RATE / 1000)], y: [-2, 2], yTicks: [-1, 0, 1], xLabel: 'ms', yLabel: 'level', aria: 'The stored word against the signal it should hold, over ten milliseconds' });
  const chips = mkChips(3), scaled = h('p', { class: 'sub mos-note' });
  const sel = h('select', { 'aria-label': 'Past full scale' }, h('option', { value: 'wrap' }, 'Wrap'), h('option', { value: 'sat' }, 'Saturate'), h('option', { value: 'scale' }, 'Scale down first')) as HTMLSelectElement;
  sel.addEventListener('change', () => { mode = sel.value as PastFull; paint(); });
  const paint = () => {
    run = overflowRun(g, b, mode);
    const top = Math.max(1.2, 0.9 * 10 ** (g / 20) * 1.2), ms = range(SHOW + 1).map((i) => i / (TONES_RATE / 1000));
    plot.setY(-top, top);
    plot.clear();
    hline(plot, 1, '', 'th'); hline(plot, -1, '', 'th');
    line(plot, ms, ms.map((_, i) => run.ideal[i]), 'lump');
    line(plot, ms, ms.map((_, i) => run.out[i]), 'real');
    scaled.textContent = mode === 'scale' && run.shift ? `Drawn shifted back up by ${run.shift} bit${run.shift === 1 ? '' : 's'}, to compare with the signal: the word itself stays between the dashed rails.` : '';
    chips.set(0, db(run.snrDb), 'signal to error', run.snrDb < 20 ? 'bad' : '');
    chips.set(1, `${(100 * run.overShare).toFixed(1)} %`, 'of the samples would not fit');
    chips.set(2, mode === 'scale' ? `${run.shift}` : `${(6.02 * b + 1.76).toFixed(1)} dB`, mode === 'scale' ? 'bits spent shifting down' : 'the ceiling for a full-scale sine at this width');
  };
  paint();
  const clip = clipButton('Play', () => ({ samples: run.out, rate: TONES_RATE, source: 'model', note: `${mode === 'wrap' ? 'wrapped' : mode === 'sat' ? 'saturated' : 'scaled'}, ${b} bits` }));
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Two tones in a word'), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'what it should hold'), h('span', { class: 'k-far' }, 'what the word holds')), plot.el, scaled, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Gain', -6, 18, 1, g, (v) => `${v > 0 ? '+' : ''}${v} dB`, (v) => { g = v; paint(); }).el,
        slider('Word', 3, 16, 1, b, (v) => `${v} bits`, (v) => { b = v; paint(); }).el,
        h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Past full scale'), sel)), clip.el)),
  };
}

// ---- rounding ---------------------------------------------------------------------------------------------------------------------------

const MODES: [Rounding, string, string][] = [['trunc', 'Truncate', 'near'], ['half-up', 'Round half up', 'real'], ['convergent', 'Ties to even', 'drv']];

export function roundingWidget(): Widget {
  let s = 3;
  const N = 4000, plot = plotOf({ W: 640, H: 210, x: [0, N], y: [-14000, 2000], yTicks: [-10000, 0], xLabel: 'samples', yLabel: 'summed error', aria: 'The running sum of the rounding error under each rule', yFmt: (v) => (Math.abs(v) >= 1000 ? `${num(v / 1000, 1)}k` : num(v, 0)).replace('-', '−') });
  const rows = h('tbody');
  const paint = () => {
    const xs = range(N), runs = MODES.map(([m]) => roundingRun(m, s, N));
    const lo = Math.min(...runs.flatMap((r) => r.drift)), hi = Math.max(...runs.flatMap((r) => r.drift));
    plot.setY(Math.min(-1, lo * 1.05), Math.max(1, hi * 1.2));
    plot.clear();
    runs.forEach((r, i) => line(plot, xs, r.drift, MODES[i][2]));
    rows.replaceChildren(...runs.map((r, i) => h('tr', null, h('td', null, MODES[i][1]), h('td', { class: 'num' }, num(r.mean, 3)), h('td', { class: 'num' }, num(r.variance, 2)))));
    want.textContent = `q² / 12 with q = ${2 ** s} steps is ${num(4 ** s / 12, 2)}; on integers it is exactly (q² − 1) / 12 = ${num((4 ** s - 1) / 12, 2)} for a busy signal.`;
  };
  const want = h('p', { class: 'sub mos-note' });
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'What a dropped bit leaves behind'), h('div', { class: 'ln-key' }, ...MODES.map(([, name, c]) => h('span', { class: c === 'near' ? 'k-near' : c === 'real' ? 'k-far' : 'dsp-k3' }, name))), plot.el,
        h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, 'Rule'), h('th', { class: 'num' }, 'Mean error'), h('th', { class: 'num' }, 'Its variance'))), rows), want),
      h('div', { class: 'panel mos-ctl' }, slider('Bits dropped', 2, 6, 1, s, (v) => String(v), (v) => { s = v; paint(); }).el)),
  };
}

// ---- a running sum --------------------------------------------------------------------------------------------------------------------

export const SUM_SETS: { name: string; xs: number[] }[] = [
  { name: 'Up past full scale, then back', xs: [90, 80, 70, -60, -90, -50, 20, 15] },
  { name: 'Down past the bottom, then back', xs: [-100, -70, -60, 80, 70, 40, -5, 25] },
  { name: 'Ends past full scale', xs: [90, 80, 70, 60, -40, 20, 10, 30] },
];

export function wrapOrderWidget(): Widget {
  let pick = 0, w = 8;
  const plot = plotOf({ W: 640, H: 220, x: [0, 8], y: [-300, 300], yTicks: [-128, 0, 127], xLabel: 'words added', yLabel: 'sum', aria: 'The running sum with no limit, wrapped and saturated', yFmt: (v) => num(v, 0) });
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const sel = h('select', { 'aria-label': 'The words' }, ...SUM_SETS.map((x, i) => h('option', { value: String(i) }, x.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { pick = Number(sel.value); paint(); });
  const paint = () => {
    const r = runningSum(SUM_SETS[pick].xs, w), xs = range(9), last = (a: number[]) => a[a.length - 1], t = last(r.truth);
    const span = Math.max(300, ...r.truth.map(Math.abs)) * 1.1;
    plot.setY(-span, span);
    plot.clear();
    hline(plot, wordMax(w), String(wordMax(w)), 'th'); hline(plot, wordMin(w), String(wordMin(w)).replace('-', '−'), 'th');
    line(plot, xs, r.truth, 'lump'); line(plot, xs, r.wrapped, 'real'); line(plot, xs, r.clamped, 'near');
    const fits = t <= wordMax(w) && t >= wordMin(w);
    chips.set(0, String(t), 'the true sum');
    chips.set(1, String(last(r.wrapped)), 'wrapping', last(r.wrapped) === t ? '' : 'bad');
    chips.set(2, String(last(r.clamped)), 'saturating at each step', last(r.clamped) === t ? '' : 'bad');
    const satRight = last(r.clamped) === t;
    note.textContent = satRight && fits ? 'The accumulator is wide enough now that nothing ever left it, so the two rules agree: these are guard bits doing their job.' : fits ? 'The true sum fits, so wrapping ends exactly right however far it strayed. Saturating threw away what it clipped and never gets it back.' : `The true sum needs more than ${w} bits, so neither can hold it. Saturating at least ends at the right end of the range. ${bitsToHold(t)} bits would hold it: guard bits.`;
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Eight words, added one at a time'), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'no limit'), h('span', { class: 'k-far' }, 'wrapped'), h('span', { class: 'k-near' }, 'saturated'), h('span', { class: 'fr-k' }, 'level lines: the accumulator\'s limits')), plot.el, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'The words'), sel),
        slider('Width', 8, 11, 1, w, (v) => `${v} bits`, (v) => { w = v; paint(); }).el))),
  };
}

// ---- where the gain goes ---------------------------------------------------------------------------------------------------------------

export function chainWidget(): Widget {
  let lv = -20, s = 3, w = 16;
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const level = 10 ** (lv / 20), down = chainSnr(level, s, w, 'down first'), up = chainSnr(level, s, w, 'up first'), alone = chainSnr(level, 0, w, 'up first');
    chips.set(0, db(alone), 'the word alone, no gain stages');
    chips.set(1, db(down), `÷ ${2 ** s} first, then × ${2 ** s}`, down < alone - 3 ? 'bad' : '');
    chips.set(2, db(up), `× ${2 ** s} first, then ÷ ${2 ** s}`, up < alone - 3 ? 'bad' : '');
    const clip = level * 2 ** s > 1;
    note.textContent = clip ? `At this level × ${2 ** s} would pass full scale, so going up first clips, and a clip costs far more than a rounding. The headroom ran out.` : `Going up first loses nothing while the peak stays under full scale: ${num(level * 2 ** s, 2)} of it here. Going down first costs ${s} bits, about ${(6.02 * s).toFixed(0)} dB of signal to noise, at any level, and buys headroom this signal does not need.`;
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The same gain of 1, in two orders'), chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Signal peak', -40, 0, 1, lv, (v) => `${v} dBFS`, (v) => { lv = v; paint(); }).el,
        slider('Shift', 1, 8, 1, s, (v) => `${v} bits`, (v) => { s = v; paint(); }).el,
        slider('Word', 8, 24, 1, w, (v) => `${v} bits`, (v) => { w = v; paint(); }).el))),
  };
}

// ---- what it costs --------------------------------------------------------------------------------------------------------------------

export const FLOAT32 = { E: 8, M: 23 };
export const costRows = (): [string, number][] => [
  ['16-bit adder that wraps', stats(rca(16)).nands],
  ['16-bit saturating adder', stats(satAdder(16)).nands],
  ['24-bit saturating adder', stats(satAdder(24)).nands],
  ['float32 adder', stats(fpAdd(FLOAT32)).nands],
  ['16 × 16 signed multiplier', stats(treeMul(16, true)).nands],
  ['Q1.15 multiplier: rounded and clamped', stats(fracMultiplier(16)).nands],
  ['Q1.23 multiplier: rounded and clamped', stats(fracMultiplier(24)).nands],
  ['float32 multiplier', stats(fpMul(FLOAT32)).nands],
];

export function costWidget(): Widget {
  const rows = costRows(), max = Math.max(...rows.map((r) => r[1]));
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Counted from the gates'),
        h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', { class: 'num' }, 'NANDs'), h('th', null, ''))),
          h('tbody', null, ...rows.map(([n, v]) => h('tr', null, h('td', null, n), h('td', { class: 'num' }, String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')), h('td', { class: 'dsp-barcell' }, h('i', { style: `width:${Math.max(1, (v / max) * 100).toFixed(1)}%` })))))))),
  };
}

// ---- the scenes -----------------------------------------------------------------------------------------------------------------------

export const SAT_W = 8;
export const satScene = (): Scene => ({ root: satAdder(SAT_W), inputs: { a: 100, b: 20 } });
export const mulScene = (): Scene => ({ root: fracMultiplier(SAT_W), inputs: { a: 96, b: 64 } });
