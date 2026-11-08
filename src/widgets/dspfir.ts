// "FIR design": symmetric taps and their zeros, the window method, Parks–McClellan against a mask, taps as words, three structures, constants in signed
// digits and one multiplier in gates. Every curve and number is dsp/firdesign.ts's, and every cost is counted from the gates in lib/firmac.ts.

import {
  binaryDigits, csdAdders, csdOf, deltaPass, deltaStop, dB, directFir, fewestFrac, fewestNear, fewestOdd, fewestTaps, firwinLowpass, foldedFir, foldedMults, gainOf, guardFor,
  isSymmetric, kaiserDesign, kaiserord, linearDelay, MacModel, magnitudeGrid, MASK, maskReport, remez, remezLowpass, sceneMac, tapValues, tapWords,
  transposedFir, widestFrac, WINDOW_NAMES, type Mask, type MacConfig, type WindowKind,
} from '../dsp/firdesign';
import { bitsToHold } from '../dsp/fixed';
import { csdMultiplier, csdWidth, firCosts, firMac } from '../lib/firmac';
import { treeMul } from '../lib/muldiv';
import { polyFromRoots, polyRoots } from '../dsp/zplane';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { analyzeTiming, CLK_TO_Q, PS_NOTE, PS_PER_NAND, SETUP } from '../sim/timing';
import { rca } from '../lib/combinational';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { signedOf, wordOf } from '../comm/signals';
import { clipButton } from './clip';
import { hline, line, mkChips, num, plotOf, type Plot } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/dsp.css';

/** The sliders' ranges, one place: the tests read these, so a Try box can be checked against what its slider can reach. */
export const RANGES = {
  symTaps: [7, 31], windowTaps: [11, 501], beta: [0, 10], remezTaps: [60, 130], weight: [-1, 1], frac: [8, 20], structTaps: [16, 120], clock: [10, 500],
} as const;

/** A small number as a power of ten the way the page writes it: 2 × 10⁻¹⁶, not 2e-16. */
const pow10 = (v: number): string => { const [m, e] = v.toExponential(0).split('e'); return `${m} × 10${[...String(Number(e))].map((c) => '⁻⁰¹²³⁴⁵⁶⁷⁸⁹'['-0123456789'.indexOf(c)]).join('')}`; };
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const sp = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const stems = (p: Plot, ys: readonly number[], cls = '') => {
  ys.forEach((y, i) => p.layer.append(s('line', { x1: p.X(i), x2: p.X(i), y1: p.Y(0), y2: p.Y(y), class: `fir-stem ${cls}` })));
};

// ---- the designs the chapter keeps coming back to ------------------------------------------------------------------------------------------

const pmCache = new Map<number, number[]>();
/** Parks–McClellan to the chapter's mask, memoized by length. */
export const pmTaps = (n: number): number[] => { let t = pmCache.get(n); if (!t) pmCache.set(n, (t = remezLowpass(n).taps)); return t; };

let chapterMemo: { n: number; taps: number[]; kaiser: { numtaps: number; beta: number; taps: number[] }; fewestOddPm: number; hwN: number; hwTaps: number[] } | null = null;
/**
 * The fewest taps that meet the mask (found by search), the fewest odd length, the Kaiser design, and the fewest taps that still meet it once the
 * taps are rounded to 16-bit words (hw): the multiplier in the gates is 16 × 16.
 */
export function chapterDesign() {
  if (!chapterMemo) {
    const f = fewestTaps(pmTaps, MASK, 90, 140)!;
    let hwN = f.n;
    for (;; hwN++) { const c = macOf(pmTaps(hwN)); if (maskReport(tapValues(c.taps, c.frac)).ok) break; }
    chapterMemo = { n: f.n, taps: f.taps, kaiser: kaiserDesign(MASK), fewestOddPm: fewestOdd(pmTaps, MASK, 90, 141)!, hwN, hwTaps: pmTaps(hwN) };
  }
  return chapterMemo;
}

/** The words the gates hold for a design: as many bits after the point as a 16-bit word allows, and the guard bits its worst case needs. */
export function macOf(taps: readonly number[], w = 16): MacConfig {
  const frac = widestFrac(taps, w), words = tapWords(taps, frac, w);
  return { taps: words, w, frac, guard: guardFor(words, w) };
}

// ---- a response against its mask ----------------------------------------------------------------------------------------------------

const DB_LO = -100;
/** Shade what the mask forbids: the stopband above −stopDb, and the lines at the two edges. */
function drawMask(p: Plot, m: Mask): void {
  p.layer.append(
    s('rect', { x: p.X(m.stop), y: p.Y(5), width: Math.max(0, p.X(0.5) - p.X(m.stop)), height: Math.max(0, p.Y(-m.stopDb) - p.Y(5)), class: 'fir-forbid' }),
    s('line', { x1: p.X(m.pass), x2: p.X(m.pass), y1: p.Y(5), y2: p.Y(DB_LO), class: 'fir-edge' }),
    s('line', { x1: p.X(m.stop), x2: p.X(m.stop), y1: p.Y(5), y2: p.Y(DB_LO), class: 'fir-edge' }));
}
/** |H| in dB at every 20th point of the freqz grid, 0 … 0.5. */
function dbCurve(taps: readonly number[], count = 410): { f: number[]; db: number[] } {
  const mag = magnitudeGrid(taps), step = Math.floor(mag.length / (count - 1));
  const f = range(count).map((i) => (i * step) / (2 * mag.length));
  return { f, db: range(count).map((i) => Math.max(DB_LO, dB(mag[i * step]))) };
}
/** The passband chip, in the measure the mask and its colour use: the largest distance of the gain from 1, against the most the mask allows. */
const passChip = (chips: ReturnType<typeof mkChips>, i: number, r: ReturnType<typeof maskReport>) =>
  chips.set(i, `± ${num(r.passDev, 4)}`, `largest |gain − 1| in the passband; the mask allows ± ${num(deltaPass(MASK), 4)}, which is 0.1 dB peak to peak centred on 1`, r.passOk ? '' : 'bad');
const dbs = (v: number) => `${v.toFixed(1)} dB`;

function responsePlot(label: string) {
  return plotOf({ W: 640, H: 230, x: [0, 0.5], y: [DB_LO, 5], yTicks: [0, -20, -40, -60, -80], xLabel: 'cycles a sample', yLabel: 'dB', aria: label, xFmt: (v) => num(v, 2), yFmt: (v) => num(v, 0) });
}

// ---- symmetric taps and their zeros ------------------------------------------------------------------------------------------------------

export function symmetryWidget(): Widget {
  let n = 15;
  const taps = plotOf({ W: 380, H: 150, x: [0, 14], y: [-0.4, 1.15], yTicks: [0, 1], xLabel: 'tap number', yLabel: 'tap, ÷ largest', aria: 'The taps of the design: mirror images of each other' });
  const Z = 250, C = Z / 2, plane = s('svg', { viewBox: `0 0 ${Z} ${Z}`, class: 'dsp-plane fir-plane', role: 'img', 'aria-label': 'The zeros of the design on the z-plane' }) as SVGSVGElement;
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const t = remez(n, [0, 0.1, 0.2, 0.5], [1, 0]).taps, big = Math.max(...t.map(Math.abs));
    taps.setX(Math.max(4, n - 1));
    taps.clear(); stems(taps, t.map((v) => v / big));
    const roots = polyRoots(t), back = polyFromRoots(roots).map((v) => v * t[0]);
    const err = Math.max(...back.map((v, i) => Math.abs(v - t[i]))) / big;
    const circle = roots.filter((r) => Math.abs(Math.hypot(r.re, r.im) - 1) < 1e-6), off = roots.length - circle.length;
    // the frame holds every zero, however far out a 1 / r partner sits
    const U = (C - 12) / Math.max(1.1, ...roots.map((r) => Math.hypot(r.re, r.im)));
    plane.replaceChildren(
      s('circle', { cx: C, cy: C, r: U, class: 'circle' }), s('line', { x1: 8, x2: Z - 8, y1: C, y2: C, class: 'axis' }), s('line', { x1: C, x2: C, y1: 8, y2: Z - 8, class: 'axis' }),
      ...roots.map((r) => s('circle', { cx: C + r.re * U, cy: C - r.im * U, r: 3.6, class: Math.abs(Math.hypot(r.re, r.im) - 1) < 1e-6 ? 'zero' : 'zero off' })),
      s('text', { x: Z - 6, y: C + 14, 'text-anchor': 'end' }, 'z = 1'), s('text', { x: 6, y: C + 14 }, 'z = −1'));
    const odd = n % 2 === 1;
    chips.set(0, isSymmetric(t) ? 'yes' : 'no', 'taps are mirror images of each other');
    chips.set(1, `${num(linearDelay(n), 1)} samples`, 'delay at every frequency: (N − 1) / 2');
    chips.set(2, `${circle.length} on the circle, ${off} off it`, 'zeros; those off it come in sets: r and 1 / r on the real axis, or four at r e^±jθ and e^±jθ / r');
    chips.set(3, odd ? 'odd length' : 'even length', odd ? 'a whole number of samples of delay' : 'a whole number and a half of delay; a zero at z = −1');
    note.textContent = `The roots, multiplied back together, give the taps to ${pow10(err)} of the largest.${odd ? '' : ' With an even length the delay is a whole number and a half, so the filter cannot pass half the sample rate: z = −1 is always a zero.'}`;
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Taps and zeros of an equiripple low-pass'), h('div', { class: 'dsp-zgrid' }, taps.el, plane), chips.el, note),
      h('div', { class: 'panel mos-ctl' }, slider('Taps', RANGES.symTaps[0], RANGES.symTaps[1], 1, n, (v) => String(v), (v) => { n = v; paint(); }).el)),
  };
}

// ---- the window method -----------------------------------------------------------------------------------------------------------------

const WINDOWS: WindowKind[] = ['rectangular', 'hann', 'hamming', 'blackman', 'kaiser'];
export const windowDesign = (kind: WindowKind, n: number, beta: number): number[] => firwinLowpass(n, (MASK.pass + MASK.stop) / 2, kind, kind === 'kaiser' ? beta : 0);
/** The fewest odd length each window needs to meet the mask (β as kaiserord gives it), and the fewest of either parity just below it. */
export function windowTable(): { kind: WindowKind; n: number | null; any: number | null }[] {
  const { beta } = kaiserord(-dB(Math.min(deltaPass(MASK), deltaStop(MASK))), (MASK.stop - MASK.pass) / 0.5);
  return WINDOWS.map((kind) => {
    const design = (len: number) => windowDesign(kind, len, beta), n = fewestOdd(design, MASK, 11, 1001);
    return { kind, n, any: n === null ? null : fewestNear(design, MASK, n) };
  });
}

/** The clip of the design at work: a tone in the passband and one in the stopband, through the taps. Levels come from the taps' gain. */
function toneClip(taps: readonly number[], rate = 8000, seconds = 2) {
  const f1 = 0.05, f2 = 0.2, n = rate * seconds, x = range(n).map((i) => Math.sin(2 * Math.PI * f1 * i) + Math.sin(2 * Math.PI * f2 * i));
  return { y: directFir(taps, x), f1, f2, g1: gainOf(taps, f1), g2: gainOf(taps, f2), rate };
}

export function windowWidget(): Widget {
  let kind: WindowKind = 'hamming', n = 61, beta = kaiserord(60, 0.05).beta;
  const plot = responsePlot('Gain of the window design against frequency, with the mask');
  const chips = mkChips(4), table = h('div', { class: 'fir-table' });
  const sel = h('select', { 'aria-label': 'Window' }, ...WINDOWS.map((k) => h('option', { value: k, selected: k === kind }, WINDOW_NAMES[k]))) as HTMLSelectElement;
  sel.addEventListener('change', () => { kind = sel.value as WindowKind; paint(); });
  const find = h('button', { type: 'button', class: 'btn sm' }, 'Find the fewest taps each window needs');
  find.addEventListener('click', () => {
    const rows = windowTable();
    table.replaceChildren(h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, 'Window'), h('th', { class: 'num' }, 'Fewest odd length'), h('th', { class: 'num' }, 'Fewest, odd or even'))),
      h('tbody', null, ...rows.map((r) => h('tr', null, h('td', null, WINDOW_NAMES[r.kind]), h('td', { class: 'num' }, r.n === null ? 'none up to 1 001' : String(r.n)), h('td', { class: 'num' }, r.any === null ? '–' : String(r.any)))))));
  });
  const paint = () => {
    const t = windowDesign(kind, n, beta), c = dbCurve(t), r = maskReport(t);
    plot.clear(); drawMask(plot, MASK);
    line(plot, c.f, c.db, 'real');
    chips.set(0, String(n), 'taps');
    passChip(chips, 1, r);
    chips.set(2, dbs(r.stopDb), 'stopband peak (the mask needs −60 dB)', r.stopOk ? '' : 'bad');
    chips.set(3, r.ok ? 'meets the mask' : 'misses the mask', kind === 'kaiser' ? `β = ${num(beta, 2)}` : 'a fixed window: its shape sets its sidelobes', r.ok ? '' : 'bad');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'An ideal low-pass cut short and shaped'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'gain'), h('span', { class: 'fir-key' }, 'what the mask forbids')), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Window'), sel),
        slider('Taps', RANGES.windowTaps[0], RANGES.windowTaps[1], 2, n, (v) => String(v), (v) => { n = v; paint(); }).el,
        slider('Kaiser β', RANGES.beta[0], RANGES.beta[1], 0.1, beta, (v) => num(v, 1), (v) => { beta = v; paint(); }).el), find, table)),
  };
}

// ---- Parks–McClellan -------------------------------------------------------------------------------------------------------------------

export function remezWidget(): Widget {
  let n = 114, k = 0;
  const plot = responsePlot('Gain of the equiripple design against frequency, with the mask');
  const pass = plotOf({ W: 640, H: 150, x: [0, 0.12], y: [-70, 70], yTicks: [-50, 0, 50], xLabel: 'cycles a sample', yLabel: '', aria: 'The passband gain in thousandths of a dB, with the mask\'s band', xFmt: (v) => num(v, 2), yFmt: (v) => num(v, 0) });
  const chips = mkChips(5), note = h('p', { class: 'sub mos-note' });
  const fewest = h('button', { type: 'button', class: 'btn sm' }, 'Find the fewest taps');
  fewest.addEventListener('click', () => { n = chapterDesign().n; nIn.set(n); paint(); });
  const design = () => {
    const wp = 1 / deltaPass(MASK), ws = (10 ** k) / deltaStop(MASK);
    return remez(n, [0, MASK.pass, MASK.stop, 0.5], [1, 0], [wp, ws]);
  };
  let last = design();
  const paint = () => {
    last = design();
    const t = last.taps, c = dbCurve(t), r = maskReport(t);
    plot.clear(); drawMask(plot, MASK);
    line(plot, c.f, c.db, 'real');
    last.extremal.forEach((f) => { const g = Math.max(DB_LO, dB(gainOf(t, f))); plot.layer.append(s('circle', { cx: plot.X(f), cy: plot.Y(g), r: 2.6, class: 'fir-ext' })); });
    pass.clear();
    const dp = dB(1 + deltaPass(MASK)), fs = range(241).map((i) => (i / 240) * 0.12);
    hline(pass, dp * 1000, '', 'th'); hline(pass, dB(1 - deltaPass(MASK)) * 1000, '', 'th');
    line(pass, fs, fs.map((f) => dB(gainOf(t, f)) * 1000), 'real');
    chips.set(0, String(n), n % 2 ? 'taps (odd: type I)' : 'taps (even: type II)');
    passChip(chips, 1, r);
    chips.set(2, dbs(r.stopDb), 'stopband peak', r.stopOk ? '' : 'bad');
    chips.set(3, k === 0 ? num(last.delta, 3) : '–', k === 0 ? `weighted error at the extremal frequencies of the exchange's grid, found in ${last.iterations} passes: 1 or less meets the mask on that grid; the verdict beside it checks 8 192 points` : 'weights moved: the error is no longer measured against the mask');
    chips.set(4, r.ok ? 'meets the mask' : 'misses the mask', k === 0 ? 'weights from the mask: 1 / δp and 1 / δs' : `stopband weight × ${num(10 ** k, 2)}`, r.ok ? '' : 'bad');
    note.textContent = r.ok ? '' : r.stopOk && !r.passOk ? 'The stopband has room and the passband does not: move weight to the passband.' : r.passOk && !r.stopOk ? 'The passband has room and the stopband does not: move weight to the stopband, or add taps.' : 'Neither band fits at this length.';
  };
  const nIn = slider('Taps', RANGES.remezTaps[0], RANGES.remezTaps[1], 1, n, (v) => String(v), (v) => { n = v; paint(); });
  const kIn = slider('Weight on the stopband', RANGES.weight[0], RANGES.weight[1], 0.1, k, (v) => `× ${num(10 ** v, 2)}`, (v) => { k = v; paint(); });
  paint();
  const clip = clipButton('Play a tone in the passband with one in the stopband', () => {
    const c = toneClip(last.taps);
    return { samples: c.y, rate: c.rate, source: 'model', note: `${n} taps, tones at ${num(c.f1 * c.rate, 0)} and ${num(c.f2 * c.rate, 0)} Hz; the second comes out ${dbs(dB(c.g2))}` };
  });
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Equal ripple, and as few taps as the mask lets (the lower plot is the passband gain in thousandths of a dB)'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'gain'), h('span', { class: 'fir-ext-key' }, 'extremal frequencies'), h('span', { class: 'fir-key' }, 'what the mask forbids')), plot.el, pass.el, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, nIn.el, kIn.el), fewest, clip.el)),
  };
}

// ---- taps as words ---------------------------------------------------------------------------------------------------------------------

export function wordsWidget(): Widget {
  let frac = 15;
  const plot = plotOf({ W: 640, H: 220, x: [0, 0.5], y: [-90, -40], yTicks: [-80, -60, -40], xLabel: 'cycles a sample', yLabel: '', aria: 'The stopband of the design with real taps and with rounded taps, gain in dB', xFmt: (v) => num(v, 2), yFmt: (v) => num(v, 0) });
  const chips = mkChips(5), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const { taps } = chapterDesign(), words = tapWords(taps, frac, 40), q = tapValues(words, frac), r = maskReport(q);
    const fl = dbCurve(taps), qc = dbCurve(q);
    const from = fl.f.findIndex((f) => f >= MASK.stop - 0.01);
    plot.clear();
    plot.layer.append(s('rect', { x: plot.X(MASK.stop), y: plot.Y(-40), width: plot.X(0.5) - plot.X(MASK.stop), height: plot.Y(-60) - plot.Y(-40), class: 'fir-forbid' }));
    line(plot, fl.f.slice(from), fl.db.slice(from), 'near');
    line(plot, qc.f.slice(from), qc.db.slice(from), 'real');
    const big = Math.max(...words.map(Math.abs)), bits = bitsToHold(big), sum = words.reduce((a, c) => a + Math.abs(c), 0);
    chips.set(0, `${frac}`, 'bits after the point');
    chips.set(1, `${bits} bits`, `to hold the largest tap, ${sp(big)}`);
    chips.set(2, dbs(r.stopDb), 'stopband peak after rounding (the mask needs −60 dB)', r.stopOk ? '' : 'bad');
    passChip(chips, 3, r);
    const hw = macOf(chapterDesign().hwTaps), hwSum = hw.taps.reduce((a, c) => a + Math.abs(c), 0) / 2 ** hw.frac;
    chips.set(4, `${guardFor(words, 16, bits)} guard bits`, `above a 16-bit sample times a ${bits}-bit tap: Σ|tap| = ${num(sum / 2 ** frac, 3)} for this ${words.length}-tap design (${num(hwSum, 3)} for the ${hw.taps.length}-tap one the gates use); log₂ N would say ${Math.ceil(Math.log2(words.length))}`);
    const f = fewestFrac(taps);
    note.textContent = r.ok ? 'The rounded taps still meet the mask.' : `The rounded taps miss it. ${f ? `${f.frac} bits after the point is the fewest that meet it, in a word of ${f.bits} bits.` : ''}`;
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The stopband before and after rounding the taps (gain in dB)'), h('div', { class: 'ln-key' }, h('span', { class: 'k-near' }, 'real taps'), h('span', { class: 'k-far' }, 'rounded taps'), h('span', { class: 'fir-key' }, 'what the mask forbids')), plot.el, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, slider('Bits after the point', RANGES.frac[0], RANGES.frac[1], 1, frac, (v) => String(v), (v) => { frac = v; paint(); }).el)),
  };
}

// ---- three structures ------------------------------------------------------------------------------------------------------------------

type Struct = 'direct' | 'folded' | 'transposed';
const STRUCT: [Struct, string][] = [['direct', 'Direct form'], ['folded', 'Folded'], ['transposed', 'Transposed']];
/**
 * The block diagram of a 6-tap filter in each form (the filter itself has N: the figures beside it are for N). Wires are collected first and drawn under the
 * parts; where a horizontal wire crosses a vertical one it hops over it.
 */
function diagram(kind: Struct): SVGSVGElement {
  const N = 6, W = 90 + 70 * N, H = 230, svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fir-diagram', role: 'img', 'aria-label': `${kind} form of a six-tap filter` }) as SVGSVGElement;
  const X = (i: number) => 60 + 70 * i;
  const add = (x: number, y: number) => s('g', null, s('circle', { cx: x, cy: y, r: 9, class: 'fd-node' }), s('text', { x, y: y + 4, 'text-anchor': 'middle' }, '+'));
  const mul = (x: number, y: number, t: string) => s('g', null, s('circle', { cx: x, cy: y, r: 11, class: 'fd-node' }), s('text', { x, y: y + 4, 'text-anchor': 'middle' }, t));
  const del = (x: number, y: number) => s('g', null, s('rect', { x: x - 14, y: y - 9, width: 28, height: 18, rx: 3, class: 'fd-box' }), s('text', { x, y: y + 4, 'text-anchor': 'middle' }, 'z⁻¹'));
  const shapes: SVGElement[] = [], V: [number, number, number][] = [], Hz: [number, number, number][] = [];
  const v = (x: number, y1: number, y2: number) => V.push([x, y1, y2]);
  const hz = (y: number, x1: number, x2: number) => Hz.push([y, Math.min(x1, x2), Math.max(x1, x2)]);
  const dot = (x: number, y: number) => shapes.push(s('circle', { cx: x, cy: y, r: 2.6, class: 'fd-dot' }));
  const label = (x: number, y: number, t: string) => shapes.push(s('text', { x, y }, t));
  const SUM = 190;
  if (kind === 'direct') {
    hz(30, 10, X(N - 1)); label(6, 22, 'x');
    for (let i = 0; i < N; i++) {
      if (i) shapes.push(del(X(i) - 35, 30));
      dot(X(i), 30); v(X(i), 30, 89); shapes.push(mul(X(i), 100, `h${i}`)); v(X(i), 111, i ? SUM - 9 : SUM);
    }
    hz(SUM, X(0), X(N - 1) + 40);
    for (let i = 1; i < N; i++) shapes.push(add(X(i), SUM));
    label(X(N - 1) + 44, SUM + 4, 'y');
  } else if (kind === 'folded') {
    hz(30, 10, X(N - 1)); label(6, 22, 'x');
    for (let i = 0; i < N; i++) { if (i) shapes.push(del(X(i) - 35, 30)); dot(X(i), 30); }
    // the outer pair goes deepest, so the pairs nest and cross nothing but the delay chain's drops
    const cx = (X(2) + X(3)) / 2, xm = [cx - 70, cx, cx + 70];
    for (let i = 0; i < N / 2; i++) {
      const xa = X(i), xb = X(N - 1 - i), ya = 110 - 22 * i, m = xm[i];
      v(xa, 30, ya); hz(ya, xa, m - 9); v(xb, 30, ya + 12); hz(ya + 12, xb, m + 9);
      shapes.push(add(m, ya + 6)); v(m, ya + 15, 136); shapes.push(mul(m, 146, `h${i}`)); v(m, 157, i ? SUM - 9 : SUM);
    }
    hz(SUM, xm[0], xm[2] + 40);
    shapes.push(add(xm[1], SUM), add(xm[2], SUM)); label(xm[2] + 44, SUM + 4, 'y');
  } else {
    hz(30, 10, X(N - 1)); label(6, 22, 'x');
    for (let i = 0; i < N; i++) {
      dot(X(i), 30); v(X(i), 30, 89); shapes.push(mul(X(i), 100, `h${i}`)); v(X(i), 111, i < N - 1 ? SUM - 9 : SUM);
      if (i < N - 1) shapes.push(add(X(i), SUM), del(X(i) + 35, SUM));
    }
    hz(SUM, X(0) - 40, X(N - 1)); label(6, SUM + 4, 'y');
  }
  // wires: verticals as they are, horizontals with a hop over each vertical they cross
  const wires: SVGElement[] = V.map(([x, y1, y2]) => s('line', { x1: x, y1, x2: x, y2, class: 'fd-wire' }));
  for (const [y, x1, x2] of Hz) {
    const cross = V.filter(([x, a, b]) => x > x1 + 6 && x < x2 - 6 && y > a && y < b).map(([x]) => x).sort((p, q) => p - q);
    let d = `M${x1},${y}`;
    for (const x of cross) d += `L${x - 4},${y}A4,4 0 0 1 ${x + 4},${y}`;
    wires.push(s('path', { d: `${d}L${x2},${y}`, class: 'fd-wire', fill: 'none' }));
  }
  svg.append(...wires, ...shapes);
  return svg;
}

export function structureWidget(): Widget {
  let kind: Struct = 'direct', n = 115;
  const holder = h('div', { class: 'fir-diagram-box' }), chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const sel = h('select', { 'aria-label': 'Form' }, ...STRUCT.map(([k, t]) => h('option', { value: k }, t))) as HTMLSelectElement;
  sel.addEventListener('change', () => { kind = sel.value as Struct; paint(); });
  const paint = () => {
    holder.replaceChildren(diagram(kind), h('p', { class: 'sub' }, `Drawn for 6 taps. The figures below are for the ${n}-tap filter.`));
    // the same integer taps and samples through all three forms
    const taps = tapWords(pmTaps(n), 17, 20), xs = range(300).map((i) => Math.round(1000 * Math.sin(i * 0.3) + 600 * Math.sin(i * 1.9)));
    const ref = directFir(taps, xs), out = kind === 'direct' ? ref : kind === 'folded' ? foldedFir(taps, xs) : transposedFir(taps, xs);
    const diff = Math.max(...ref.map((v, i) => Math.abs(v - out[i])));
    const cfg = macOf(pmTaps(n)), rows = firCosts(cfg), row = rows[kind === 'direct' ? 0 : kind === 'folded' ? 1 : 3];
    chips.set(0, String(kind === 'direct' ? n : foldedMults(n)), kind === 'transposed' ? 'multiplications for each output (one product serves two mirror taps); drawn with 6 for clarity' : 'multiplications for each output');
    chips.set(1, sp(row.nands), 'NANDs, all parallel: multipliers, adders and registers counted from the gates');
    chips.set(2, kind === 'transposed' ? `${n - 1} × ${cfg.w * 2 + cfg.guard} bits` : `${n - 1} × ${cfg.w} bits`, kind === 'transposed' ? 'registers: each holds a partial sum, the full accumulator width' : 'registers: each holds a sample');
    chips.set(3, diff === 0 ? 'identical' : `differs by ${diff}`, 'output against the direct form, on 300 samples of the same integers', diff === 0 ? '' : 'bad');
    note.textContent = kind === 'direct' ? 'The input enters one end of a delay line, and each multiplier reads a different register along it. The products are added in one long chain or in a tree, and that adder is the end of the longest path.'
      : kind === 'folded' ? 'Taps mirror each other, so h₀(x[n] + x[n−5]) needs one multiplication where the direct form needs two. Half the multipliers, at the price of an adder one bit wider in front of each, so each multiplier is 17 × 17 (our tree multiplier is square).'
        : 'The input reaches every multiplier at once and nothing waits behind a long adder chain: each register adds one product and passes it on. The registers hold sums, so they are wide.';
  };
  const nIn = slider('Taps', RANGES.structTaps[0], RANGES.structTaps[1], 1, n, (v) => String(v), (v) => { n = v; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The same filter, three ways'), holder, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Form'), sel), nIn.el))),
  };
}

// ---- constants in signed digits (the scene's panel) --------------------------------------------------------------------------------------

/** The tap the constant multiplier scene draws: the one of the scene filter's whose signed digits save the most over binary. */
export const csdTap = (): number => sceneMac().words.reduce((a, c) => (binaryDigits(c) - csdOf(c).length > binaryDigits(a) - csdOf(a).length ? c : a), sceneMac().words[0]);
export const csdScene = (): Scene => ({ root: csdMultiplier(csdTap(), 16), inputs: { a: 1000 }, panels: [csdPanel] });
export const csdApi = new WeakMap<Stage, { checked: () => number; agrees: () => boolean; run: () => void }>();

/** Totals for the chapter's own design: digits in binary and in canonical signed digits, and what the shifts and adders cost against general multipliers. */
export function csdTotals() {
  const words = macOf(chapterDesign().hwTaps).taps, half = words.slice(0, Math.ceil(words.length / 2));
  const bin = half.reduce((a, c) => a + binaryDigits(c), 0), csd = half.reduce((a, c) => a + csdOf(c).length, 0), adders = half.reduce((a, c) => a + csdAdders(c), 0);
  const nandsCsd = half.reduce((a, c) => a + stats(csdMultiplier(c, 16)).nands, 0), tree = stats(treeMul(16, true)).nands;
  return { distinct: half.length, bin, csd, adders, nandsCsd, nandsTree: half.length * tree, tree };
}

function csdPanel(stage: Stage): Widget {
  const c = csdTap();
  let checked = 0, ok = true;
  const t = csdOf(c), tot = csdTotals();
  const m = csdMultiplier(c, 16), mine = stats(m).nands, tree = tot.tree;
  const bin = Math.abs(c).toString(2);
  const note = h('p', { class: 'sub' });
  const run = () => {
    stage.checkpoint();
    const sim = stage.sim!;
    ok = true; checked = 0;
    let seed = 99;
    const ow = csdWidth(c, 16);
    for (let i = 0; i < 200; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const a = i === 0 ? -32768 : i === 1 ? 32767 : (seed % 65536) - 32768;
      sim.setInput('a', wordOf(a, 16)); sim.settle();
      if (signedOf(stage.value('y'), ow) !== c * a) ok = false;
      checked++;
    }
    stage.refresh();
    paint();
  };
  const paint = () => { note.textContent = checked ? (ok ? `${checked} inputs, including both extremes: every output of the gates was ${c} × the input.` : 'The gates and the arithmetic disagreed.') : 'Press the button to push 200 inputs through the gates.'; };
  csdApi.set(stage, { checked: () => checked, agrees: () => ok && checked > 0, run });
  paint();
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, `× ${c} in shifts and adders`),
    h('table', { class: 'dsp-table' }, h('tbody', null,
      h('tr', null, h('td', null, 'binary'), h('td', { class: 'num' }, bin), h('td', { class: 'num' }, `${binaryDigits(c)} ones`)),
      h('tr', null, h('td', null, 'signed digits'), h('td', { class: 'num' }, t.map((d) => `${d.neg ? '−' : '+'}2^${d.pos}`).join(' ')), h('td', { class: 'num' }, `${t.length} digits`)),
      h('tr', null, h('td', null, 'adders'), h('td', { class: 'num' }, ''), h('td', { class: 'num' }, String(csdAdders(c)))),
      h('tr', null, h('td', null, 'this multiplier, NANDs'), h('td', { class: 'num' }, ''), h('td', { class: 'num' }, sp(mine))),
      h('tr', null, h('td', null, 'general 16 × 16, NANDs'), h('td', { class: 'num' }, ''), h('td', { class: 'num' }, sp(tree))))),
    h('button', { type: 'button', class: 'btn sm', onclick: run }, 'Check 200 inputs'), note);
  stage.resetHooks.add(() => { checked = 0; ok = true; paint(); });
  return { el, update: () => {} };
}

// ---- the filter on one multiplier ---------------------------------------------------------------------------------------------------------

const pulseClock = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };
export const macApi = new WeakMap<Stage, { lastTone: () => number; lastGain: () => number; agrees: () => boolean; cycles: () => number; runTone: (f: number) => void }>();
/** The tones the panel offers, in cycles a sample. */
export const MAC_TONES: [string, number][] = [['Passband: 0.04', 0.04], ['Edge of the stopband: 0.2', 0.2], ['Stopband: 0.35', 0.35]];

export const MAC_FRAMES = 40, MAC_AMP = 8000;
/**
 * A tone through the filter, N clocks a sample: the ring is flushed with N clocks of zeros, then FRAMES samples go in, the sample at the end of each frame.
 * `clock(x)` moves the gates one rising edge; the model takes the same edge, and `check(model)` compares after it. The gain is the output's peak once the ring is full.
 */
export function macTone(cfg: MacConfig, f: number, hooks: { clock(x: number): void; check(m: MacModel): void }) {
  const N = cfg.taps.length, m = new MacModel(cfg), xs: number[] = [], ys: number[] = [];
  let peak = 0, cycles = 0;
  for (let i = 0; i < N; i++) { hooks.clock(0); m.edge(0); }
  for (let n = 0; n < MAC_FRAMES; n++) {
    const v = Math.round(MAC_AMP * Math.sin(2 * Math.PI * f * n));
    for (let c = 0; c < N; c++, cycles++) {
      const x = c === N - 1 ? v : 0;
      hooks.clock(x); m.edge(x); hooks.check(m);
    }
    xs.push(v / MAC_AMP); ys.push(m.y / MAC_AMP);
    if (n >= N + 1) peak = Math.max(peak, Math.abs(m.y / MAC_AMP));
  }
  return { xs, ys, gain: peak, cycles };
}

function macPanel(stage: Stage): Widget {
  const { cfg } = sceneMac(), N = cfg.taps.length, A = 2 * cfg.w + cfg.guard, FRAMES = MAC_FRAMES;
  let bad = '', f = MAC_TONES[0][1], ok = true, cycles = 0, gain = 0, xs: number[] = [], ys: number[] = [], stale = false, running = false;
  const plot = plotOf({ W: 380, H: 170, x: [0, FRAMES], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'sample', yLabel: '', aria: 'The input samples and the filter\'s output, divided by the input amplitude' });
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    plot.clear();
    if (xs.length) { line(plot, range(xs.length), xs, 'ln-s lump'); line(plot, range(ys.length), ys, 'ln-s real'); }
    read.replaceChildren(h('span', null, 'tone ', h('b', null, `${num(f, 2)} cycles a sample`)), h('span', null, 'output ÷ input ', h('b', null, xs.length ? num(gain, 3) : '–')),
      h('span', null, 'the taps say ', h('b', null, num(gainOf(cfg.taps.map((v) => v / 2 ** cfg.frac), f), 3))));
    note.textContent = xs.length && stale ? 'The clock has been stepped by hand since this run, so the plot and the check no longer describe the gates. Press a tone to run again.' : xs.length ? (ok ? `${cycles} clocks: y, the tap number and the accumulator matched the model at every one.`   : `The gates and the model disagreed at ${bad}.`) : `Pick a tone: ${FRAMES} samples go in, ${N} clocks each, and the model runs beside the gates.`;
  };
  const run = () => {
    stage.checkpoint();
    const sim = stage.sim!;
    ok = true; bad = ''; stale = false; running = true; let n = 0;
    // from power-on, so that the gates' ring, counter and accumulator start where the model's do
    sim.setInput('x', 0); sim.setInput('clk', 0); sim.reset('zero'); sim.settle();
    const r = macTone(cfg, f, {
      clock: (x) => { sim.setInput('x', wordOf(x, cfg.w)); sim.settle(); pulseClock(stage); },
      check: (m) => {
        const got = { y: signedOf(stage.value('y'), cfg.w), k: stage.value('k'), acc: signedOf(stage.value('acc'), A) };
        if (ok && (got.y !== m.y || got.k !== m.k || got.acc !== m.acc)) { ok = false; bad = `clock ${n++}: gates y ${got.y}, k ${got.k}, acc ${got.acc}; model y ${m.y}, k ${m.k}, acc ${m.acc}`; } else n++;
      },
    });
    xs = r.xs; ys = r.ys; gain = r.gain; cycles = r.cycles;
    running = false;
    stage.refresh();
    paint();
  };
  macApi.set(stage, { lastTone: () => (xs.length ? f : -1), lastGain: () => gain, agrees: () => ok && xs.length > 0, cycles: () => cycles, runTone: (fr) => { f = fr; run(); } });
  const btn = ([label, fr]: [string, number]) => h('button', { type: 'button', class: 'btn sm', onclick: () => { f = fr; run(); } }, label);
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'A tone through one multiplier'),
    h('div', { class: 'dram-ops' }, ...MAC_TONES.map(btn)), plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'input'), h('span', { class: 'k-far' }, `output, ${1 + linearDelay(N)} samples later: one frame, and the ${linearDelay(N)} samples of linear-phase delay`)), read, note);
  stage.resetHooks.add(() => { xs = []; ys = []; gain = 0; ok = true; stale = false; paint(); });
  stage.edgeHooks.add({ after: () => { if (xs.length && !running) { stale = true; paint(); } } });
  paint();
  return { el, update: () => {} };
}

export const macScene = (): Scene => ({ root: firMac(sceneMac().cfg), inputs: { x: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [macPanel] as ScenePanel[] });

// ---- one specification, several designs --------------------------------------------------------------------------------------------------

export interface DesignRow {
  design: string; structure: string; taps: number; nands: number; mults: number; cycles: number; ok: boolean;
  /** The clock period in NAND delays, and how it was found: 'analysed' (static timing of the gates as built) or 'sum of parts' (a build the page does not draw). */
  period: number; basis: 'analysed' | 'sum of parts';
  /** The fastest clock, MHz, at PS_PER_NAND ps a NAND delay. */
  maxMhz: number;
}
let rowsMemo: DesignRow[] | null = null;
const treeLevels = (terms: number) => Math.ceil(Math.log2(terms));
/**
 * Each design in each structure: the multipliers and cycles it needs, NANDs counted from the gates, whether the 16-bit words still meet the mask, and the
 * fastest clock. The shared build is built and timed by analyzeTiming. The parallel builds are not drawn, so their period is a sum of parts from the gates
 * of each: clock to q, the pre-adder where there is one, the multiplier (or the slowest constant multiplier), the adder tree's levels each counted as a full
 * ripple adder in series (an upper bound: ripple carries overlap between levels, so the real path is shorter), and setup.
 */
export function designRows(): DesignRow[] {
  if (rowsMemo) return rowsMemo;
  const ch = chapterDesign(), out: DesignRow[] = [];
  for (const [design, taps] of [['Parks–McClellan', ch.hwTaps], ['Kaiser window', ch.kaiser.taps]] as const) {
    const cfg = macOf(taps), q = maskReport(tapValues(cfg.taps, cfg.frac)), rows = firCosts(cfg), N = taps.length, A = 2 * cfg.w + cfg.guard, half = Math.ceil(N / 2);
    const d = (def: Parameters<typeof logicDepth>[0]) => logicDepth(def) ?? 0;
    const mul = d(treeMul(cfg.w, true)), mul1 = d(treeMul(cfg.w + 1, true)), add = d(rca(A)), pre = d(rca(cfg.w + 1));
    const csd = Math.max(...cfg.taps.slice(0, half).map((c) => d(csdMultiplier(c, cfg.w + 1))));
    for (const r of rows) {
      if (r.name.startsWith('Transposed')) continue;
      let period: number, basis: DesignRow['basis'] = 'sum of parts';
      if (r.cycles > 1) { period = analyzeTiming(flatten(firMac(cfg), { mode: 'gate' }))!.period; basis = 'analysed'; }
      else if (r.name.startsWith('Direct')) period = CLK_TO_Q + mul + treeLevels(N) * add + SETUP;
      else if (r.name.startsWith('Folded:')) period = CLK_TO_Q + pre + mul1 + treeLevels(half) * add + SETUP;
      else period = CLK_TO_Q + pre + csd + treeLevels(half) * add + SETUP;
      out.push({ design, structure: r.name, taps: N, nands: r.nands, mults: r.mults, cycles: r.cycles, ok: q.ok, period, basis, maxMhz: 1e6 / (period * PS_PER_NAND) });
    }
  }
  return (rowsMemo = out);
}

const rate = (khz: number) => (khz >= 1000 ? `${num(khz / 1000, 1)} MHz` : `${num(khz, 0)} kHz`);

export function designsWidget(): Widget {
  let mhz = 100;
  const body = h('tbody'), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const rows = designRows(), maxN = Math.max(...rows.map((r) => r.nands));
    body.replaceChildren(...rows.map((r) => {
      const clock = Math.min(mhz, r.maxMhz);
      return h('tr', null,
        h('td', null, r.design), h('td', null, r.structure), h('td', { class: 'num' }, `${r.taps} (${r.taps % 2 ? 'odd' : 'even'})`), h('td', { class: 'num' }, r.mults ? String(r.mults) : 'none'), h('td', { class: 'num' }, sp(r.nands)),
        h('td', { class: 'dsp-barcell' }, h('i', { style: `width:${Math.max(1, (r.nands / maxN) * 100).toFixed(1)}%` })),
        h('td', { class: 'num', title: `${r.period} NAND delays (${r.basis})` }, `${num(r.maxMhz, 0)} MHz${r.basis === 'analysed' ? '' : ' *'}`),
        h('td', { class: 'num' }, `${rate((clock * 1000) / r.cycles)}${clock < mhz ? ' †' : ''}`));
    }));
    const k = rows.find((r) => r.design === 'Kaiser window')!;
    note.textContent = `Words of 16 bits: the Parks–McClellan taps ${rows[0].ok ? 'meet' : 'miss'} the mask, and the Kaiser taps ${k.ok ? 'meet' : 'miss'} it. * A sum of parts from the gates (the build is not drawn); the one-multiplier clock is the static timing of the gates. † Held to the build's fastest clock. ${PS_NOTE}`;
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'One mask, two designs, four ways to build them'),
        h('div', { class: 'fir-scroll' }, h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, 'Design'), h('th', null, 'Built as'), h('th', { class: 'num' }, 'Taps'), h('th', { class: 'num' }, 'Multipliers'), h('th', { class: 'num' }, 'NANDs'), h('th', null, ''), h('th', { class: 'num' }, 'Fastest clock'), h('th', { class: 'num' }, 'Samples a second'))), body)), note),
      h('div', { class: 'panel mos-ctl' }, slider('Clock', RANGES.clock[0], RANGES.clock[1], 10, mhz, (v) => `${v} MHz`, (v) => { mhz = v; paint(); }).el)),
  };
}
