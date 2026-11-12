// Group D of the Signal processing level's codex entries (converters, filters that learn, pictures): every number they quote equal to the dsp/ models and the library,
// or to the chapter step that prints it. Completeness and form are tests/content-codexdsp.test.ts's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { sqnrDb } from '../src/comm/signals';
import { levinson, peakEnergy, runEcho } from '../src/dsp/adaptive';
import { ECHO_RUN, ROOM_NOISE, TALK, voiceEcho } from '../src/dsp/echofigs';
import {
  enob, flashComparators, idealSqnrDb, jitterLimitDb, jitterMeasuredDb, ladderErrors, ladderOutput, linearity, mismatchedWeights, sarConvert, SD_GUARD, sdBand, sdErrorPower, sdLinearModelDb, sdMeasuredDb, sdPeak,
} from '../src/dsp/converters';
import {
  AC_LUMA, category, DC_LUMA, DCT_K, encodeJpeg, extraBits, fdct, filter1d, filter2d, filterCost, grow, huffCodes, blockAt, KERNELS, psnr, qualityTable, scene, shrink, ZIGZAG, zonePlate, decimationTaps,
} from '../src/dsp/pictures';
import { csdDigits } from '../src/lib/fft';
import { dctStage } from '../src/lib/dct';
import { treeMul } from '../src/lib/muldiv';
import { lmsFilter, lmsTap, sdConverter, sdModulator } from '../src/lib/sigmadelta';
import { stats } from '../src/sim/stats';
import { CHAIN, chainEnob } from '../src/widgets/dspconverters';
import { CHANNELS, ECHO_N, ECHO_TAPS, LMS_SPEC } from '../src/widgets/dspadaptive';
import { wavSamples } from './dsp/wav';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
const c = (n: number) => n.toLocaleString('en-US');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};
const f1 = (x: number) => x.toFixed(1);
const minus = (x: number, d: number) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const db = (x: number) => 10 * Math.log10(x);
/** "Filters that learn"'s echo canceller exactly as step 3 and its widget run it (dsp/echofigs.ts, widgets/dspadaptive.ts). */
const voice = voiceEcho(wavSamples('public/dsp/voice-8k.wav').x);
const echoRun = (o: { taps?: number; talk?: boolean; freeze?: boolean; mu?: number; normalized?: boolean } = {}) =>
  runEcho({ n: ECHO_RUN, seed: 3, taps: o.taps ?? ECHO_TAPS, mu: o.mu ?? 0.5, normalized: o.normalized ?? true, x: voice.x, near: voice.near, noise: ROOM_NOISE,
    ...(o.talk ? { talkFrom: TALK.from, talkTo: TALK.to, freeze: o.freeze } : {}) }).erle;

describe('group D: converters', () => {
  it('SNR and ENOB: the ideal figure, the inverse, the chain', () => {
    expect([8, 12, 16].map((b) => f1(idealSqnrDb(b)))).toEqual(['49.9', '74.0', '98.1']);
    expect(f1(sqnrDb(8))).toBe('49.9');
    expect(f1(sqnrDb(16))).toBe('98.1');
    expect(f1(enob(74))).toBe('12.0');
    expect(f1(enob(62))).toBe('10.0');
    expect(f1(enob(jitterLimitDb(1e6, 1e-12)))).toBe('17.0');
    expect(f1(enob(jitterLimitDb(1e8, 1e-12)))).toBe('10.3');
    // a half-scale tone reads exactly a bit lower
    expect(Math.abs(20 * Math.log10(0.5) / 6.02 + 1)).toBeLessThan(0.002);
    // the quiz: nine effective bits
    expect(f1(6.02 * 9 + 1.76)).toBe('55.9');
    expect(f1(6.02 * 10 + 1.76)).toBe('62.0');
    expect(f1(6.02 * 9)).toBe('54.2');
    const ch = [64, 128, 256].map((r) => f1(chainEnob(r)));
    expect(ch).toEqual(['12.1', '14.7', '17.2']);
    quotes('enob', '49.9', '74.0', '98.1', '12.0', '10.0', '17.0', '10.3', '104.0', '64.0', ...ch, '55.9', '62.0', '54.2', '6.02');
    says('converters', 0, '(SNDR − 1.76) / 6.02');
    says('converters', 0, `${f1(idealSqnrDb(12))} dB`);
    says('converters', 4, `${jitterLimitDb(1e6, 1e-12).toFixed(0)} dB`);
    says('converters', 7, `${f1(chainEnob())} effective bits`);
    says('converters', 7, `${f1(chainEnob(128))}`);
    says('converters', 7, `${f1(chainEnob(256))}`);
    says('signals', 7, 'effective number of bits');
    says('signals', 7, `${f1(sqnrDb(8))} dB at 8 bits and ${f1(sqnrDb(16))} dB at 16`);
  });

  it('successive approximation: the search, the flash count, the capacitor error', () => {
    const r = sarConvert(0.3, 8);
    expect(r.code).toBe(166);
    expect(Math.floor(((0.3 + 1) / 2) * 256)).toBe(166);
    expect(r.steps.map((s) => s.tried)).toEqual([0, 0.5, 0.25, 0.375, 0.3125, 0.28125, 0.296875, 0.3046875]);
    expect(r.steps.map((s) => (s.keep ? 1 : 0)).join('')).toBe('10100110');
    const w = Array.from({ length: 8 }, (_, i) => 2 ** (7 - i) / 256);
    w[0] *= 1.01;
    const bad = sarConvert(0.3, 8, w);
    expect(bad.code).toBe(165);
    expect(bad.steps.map((s) => (s.keep ? 1 : 0)).join('')).toBe('10100101');
    expect(f1(128 * 0.01)).toBe('1.3');
    expect(flashComparators(8)).toBe(255);
    expect(flashComparators(12)).toBe(4095);
    expect(flashComparators(12) / flashComparators(8)).toBeGreaterThan(16);
    expect(8 / 12).toBeCloseTo(2 / 3, 12);
    quotes('sar', '255', c(4095), '1.3', '166', '165', '10100110', '10100101', '1.28', '0.3046875', 'sixteen times');
    says('converters', 1, '1.3 codes at 8 bits');
    says('converters', 1, '255 comparators');
    // mismatchedWeights is the widget's: a zero error is the ideal search
    expect(sarConvert(0.3, 8, mismatchedWeights(8, 0, 5)).code).toBe(166);
  });

  it('R-2R: the staircase, the middle step, the resistor count', () => {
    expect(ladderOutput(128, 8)).toBe(0.5);
    expect(ladderOutput(1, 8)).toBeCloseTo(1 / 256, 12);
    expect(ladderOutput(127, 8)).toBeCloseTo(127 / 256, 12);
    expect(ladderOutput(255, 8)).toBeCloseTo(255 / 256, 12);
    expect((255 / 256).toFixed(3)).toBe('0.996');
    expect((1 / 256).toFixed(4)).toBe('0.0039');
    expect((127 / 256).toFixed(4)).toBe('0.4961');
    expect(8 + (8 - 1) + 1).toBe(16);
    const lv = (s: number, seed: number) => linearity(Array.from({ length: 256 }, (_, k) => ladderOutput(k, 8, ladderErrors(8, s, seed))));
    let mid = 0;
    const worst: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const t = lv(0.01, seed);
      if (t.dnl.reduce((m, v, i) => (Math.abs(v) > Math.abs(t.dnl[m]) ? i : m), 0) === 127) mid++;
      worst.push(Math.abs(t.dnl[127]));
    }
    worst.sort((a, b) => a - b);
    expect(mid).toBe(130);
    expect(f1(worst[100])).toBe('1.2');
    expect(f1(Math.abs(lv(0.01, 5).dnl[127]))).toBe('1.9');
    const bad = lv(0.03, 1);
    expect(f1(bad.worstDnl)).toBe('2.2');
    expect(bad.monotonic).toBe(false);
    quotes('r2r', '0.5', '0.996', '0.0039', '0.4961', '130', '1.2', '1.9', '2.2', '16 resistors');
    says('converters', 2, '1 to 2 LSBs off at 8 bits: the median over 200 such ladders is 1.2 LSBs');
    // the quiz: a DNL of −1.3 is a step of −0.3 LSB
    expect(-1.3 + 1).toBeCloseTo(-0.3, 12);
  });

  it('jitter: the limit and the measurement', () => {
    expect([1e6, 1e8].map((f) => f1(jitterLimitDb(f, 1e-12)))).toEqual(['104.0', '64.0']);
    expect([1e6, 1e7, 1e8].map((f) => f1(jitterLimitDb(f, 1e-11)))).toEqual(['84.0', '64.0', '44.0']);
    const m = [1e6, 1e7, 1e8].map((f) => f1(jitterMeasuredDb(f, 1e9, 1e-11, 3)));
    expect(m).toEqual(['83.9', '63.9', '43.9']);
    expect(f1(jitterLimitDb(7e6, 1e-12) - jitterLimitDb(7e7, 1e-12))).toBe('20.0');
    expect(f1(jitterLimitDb(1e7, 1e-12))).toBe('84.0');
    expect(2 * Math.PI * 1e7 * 1e-12).toBeCloseTo(6.28e-5, 7);
    expect(f1(20 * Math.log10(2))).toBe('6.0');
    quotes('jitter', '104.0', '64.0', '84.0', '44.0', ...m, '20.0', '10.3', '17.0', '6.3 × 10⁻⁵');
    says('converters', 4, '−20 log₁₀(2π f σ)');
    says('converters', 4, `${jitterLimitDb(1e8, 1e-12).toFixed(0)} dB`);
  });

  it('sigma-delta: the model against the loop, the gates, the peak', () => {
    const a = sdMeasuredDb(2, 64, 0.5), mdl = sdLinearModelDb(2, 64, 0.5), pw = sdErrorPower(2, 0.5), m2 = sdLinearModelDb(2, 64, 0.5, pw);
    expect([a, mdl, m2].map(f1)).toEqual(['69.9', '73.2', '71.0']);
    expect(pw.toFixed(2)).toBe('0.55');
    expect(f1(mdl - a)).toBe('3.2');
    // a one-bit quantizer alone: power 1/2 over 1/3 is 1.76 dB, and the model is that plus the shaping term
    expect(f1(db(0.5 / (1 / 3)))).toBe('1.8');
    expect(db(0.5 / (1 / 3))).toBeCloseTo(1.76, 2);
    for (const L of [1, 2]) for (const osr of [16, 64]) {
      const term = -db(Math.PI ** (2 * L) / (2 * L + 1)) + (20 * L + 10) * Math.log10(osr);
      expect(sdLinearModelDb(L, osr, 1)).toBeCloseTo(db(0.5 / (1 / 3)) + term, 9);
    }
    const o2 = [16, 32, 64, 128, 256].map((r) => sdMeasuredDb(2, r, 0.5)), o1 = [16, 32, 64, 128, 256].map((r) => sdMeasuredDb(1, r, 0.5));
    expect(o2.map(f1)).toEqual(['39.9', '55.7', '69.9', '83.8', '96.6']);
    expect(o1.map(f1)).toEqual(['30.3', '40.5', '49.8', '56.1', '63.6']);
    expect([0.5, 0.8, 0.95].map((x) => f1(sdPeak(2, x)))).toEqual(['4.2', '8.3', '20.2']);
    expect([0.8, 0.95].map((x) => f1(sdMeasuredDb(2, 64, x)))).toEqual(['65.5', '50.0']);
    const n12 = nands(sdModulator(2, 12)), n16 = nands(sdModulator(2, 16)), whole = nands(sdConverter(CHAIN.order, CHAIN.w, CHAIN.N, CHAIN.R));
    expect([n12, n16, whole]).toEqual([1283, 1579, 5181]);
    expect(SD_GUARD).toBe(5);
    quotes('sigmadelta', '69.9', '73.2', '71.0', '0.55', '3.2', '1.76', ...o2.map(f1), ...o1.map(f1), '4.2', '8.3', '20.2', '65.5', '50.0', c(n12), c(n16), c(whole), '12.1', '14.7', '17.2');
    says('converters', 5, `${f1(mdl)} dB`);
    says('converters', 5, `loop measures ${f1(a)}`);
    says('converters', 5, `${pw.toFixed(2)}`);
    says('converters', 5, `the sum gives ${f1(m2)}`);
    says('converters', 5, '9 dB at order 1, 15 at order 2');
    says('converters', 6, `is ${n12} NANDs`);
    says('converters', 6, `it is ${n16}`);
    says('converters', 5, 'V = z⁻¹ U + (1 − z⁻¹)² E');
  });

  it('noise shaping: the filter, the power, the gain a doubling', () => {
    const ntf = (L: number, w: number) => 20 * Math.log10((2 * Math.sin(w / 2)) ** L);
    expect(f1(ntf(2, 2 * Math.PI * sdBand(64)))).toBe('−52.4'.replace('−', '-'));
    expect(f1(ntf(2, Math.PI))).toBe('12.0');
    expect([1, -2, 1].reduce((s, v) => s + v * v, 0)).toBe(6);
    expect([1, -1].reduce((s, v) => s + v * v, 0)).toBe(2);
    expect(f1(db(6))).toBe('7.8');
    expect(f1(db(2))).toBe('3.0');
    expect([1, 2].map((L) => f1((2 * L + 1) * 10 * Math.log10(2)))).toEqual(['9.0', '15.1']);
    const rates = [16, 32, 64, 128, 256], o2 = rates.map((r) => sdMeasuredDb(2, r, 0.5)), o1 = rates.map((r) => sdMeasuredDb(1, r, 0.5));
    const d2 = o2.slice(1).map((v, i) => v - o2[i]), d1 = o1.slice(1).map((v, i) => v - o1[i]);
    expect(d2.map(f1)).toEqual(['15.8', '14.2', '13.9', '12.7']);
    for (const d of d2) { expect(d).toBeGreaterThan(12.5); expect(d).toBeLessThan(16.5); }
    for (const d of d1) { expect(d).toBeGreaterThan(6); expect(d).toBeLessThan(11); }
    expect(f1(sdLinearModelDb(2, 128, 1) - sdLinearModelDb(2, 64, 1))).toBe('15.1');
    quotes('noiseshaping', '−52.4', '+12.0', '12.0', '7.8', '3.0', '9.0', '15.1', ...d2.map(f1), '13 to 16', '6 and 11', 'six-fold');
    says('converters', 5, '13 to 16');
    says('converters', 5, 'between 6 and 11');
    says('converters', 5, '(1 − z⁻¹)²');
  });
});

describe('group D: filters that learn', () => {
  it('Wiener filter: the two-tap solution and the cost', () => {
    const w = levinson([1, 0.5], [0.8, 0.1]);
    expect(w[0]).toBeCloseTo(1.0, 12);
    expect(w[1]).toBeCloseTo(-0.4, 12);
    // by hand: R⁻¹ p
    const det = 1 - 0.25;
    expect((0.8 - 0.5 * 0.1) / det).toBeCloseTo(w[0], 12);
    expect((1 * 0.1 - 0.5 * 0.8) / det).toBeCloseTo(w[1], 12);
    expect(1 - (0.8 * w[0] + 0.1 * w[1])).toBeCloseTo(0.24, 12);
    expect(128 ** 2).toBe(16384);
    expect(128 ** 3).toBe(2097152);
    expect(128 ** 3 / 128 ** 2).toBe(128);
    const lo = echoRun({ taps: 32 });
    quotes('wiener', c(16384), c(2097152), '8 places', '0.24', '[1.0, −0.4]', '128 times', f1(lo));
    says('adaptive', 1, 'agrees to 8 places');
    says('adaptive', 1, 'R w = p');
  });

  it('LMS and NLMS: the step limits and what a tap costs', () => {
    const fe = voice.x, sig = fe.reduce((m, v) => m + v * v, 0) / fe.length, top = peakEnergy(fe, ECHO_TAPS);
    const avg = 2 / (ECHO_TAPS * sig), loud = 2 / top;
    expect(avg.toFixed(2)).toBe('1.87');
    expect(loud.toFixed(3)).toBe('0.176');
    // the loudest-stretch limit is a guarantee, not the edge: plain LMS still converges at 1.3 times it, has diverged at 1.4, and at the average's limit
    const plain = (mu: number) => { const e = echoRun({ mu, normalized: false }); return Number.isFinite(e) ? e : -Infinity; };
    expect(plain(1.3 * loud)).toBeGreaterThan(20);
    expect(plain(1.4 * loud)).toBeLessThan(-3);
    expect(plain(avg)).toBeLessThan(-3);
    const mul = nands(treeMul(LMS_SPEC.w, true)), tap = nands(lmsTap(LMS_SPEC)), four = nands(lmsFilter(LMS_SPEC));
    expect([tap, 2 * mul, four]).toEqual([4580, 4172, 19188]);
    expect(LMS_SPEC.w).toBe(12);
    expect(LMS_SPEC.n).toBe(4);
    expect(2 ** (LMS_SPEC.s - 1)).toBe(64);
    expect(LMS_SPEC.s).toBe(7);
    expect(Math.round(avg / loud)).toBe(11);
    quotes('lms', avg.toFixed(2), loud.toFixed(3), c(tap), c(2 * mul), c(four), 'from −64 to +63', '1960', 'recorded voice', 'converges at 1.3 times', 'diverged at 1.4 times');
    says('adaptive', 3, 'still converges at 1.3 times it and has fallen apart at 1.4 times it');
    says('adaptive', 3, `${avg.toFixed(2)}`);
    says('adaptive', 3, `${loud.toFixed(3)}`);
    says('adaptive', 5, `${c(tap).replace(/,/g, ' ')} NANDs`);
    says('adaptive', 5, `from −${2 ** (LMS_SPEC.s - 1)} to +${2 ** (LMS_SPEC.s - 1) - 1}`);
    says('adaptive', 2, 'In 1960');
    // the quiz: ten times the amplitude is a hundred times the power
    expect(10 ** 2).toBe(100);
  });

  it('echo canceller: ERLE, the cost, the talk', () => {
    const full = echoRun(), short = echoRun({ taps: 32 }), on = echoRun({ talk: true }), frozen = echoRun({ talk: true, freeze: true });
    expect([full, short, on, frozen].map(f1)).toEqual(['35.4', '14.6', '25.1', '33.9']);
    const gap = Math.round(frozen - on);
    expect(gap).toBe(9);
    expect(ECHO_N).toBe(ECHO_RUN);
    expect(TALK.to - TALK.from).toBe(7000);
    expect(ECHO_TAPS * 2).toBe(256);
    expect(256 * 8000).toBe(2048000);
    expect(ECHO_TAPS / 8000 * 1000).toBe(16);
    expect((2048000 / 1e6).toFixed(2)).toBe('2.05');
    expect(ECHO_N).toBe(32000);
    quotes('echocancel', ...[full, short, on, frozen].map(f1), '256', '2.05', c(2048000), '16 ms', `about ${gap} dB`, 'G.168', c(32000), 'over the last second', 'LibriVox');
    // the quiz's right option is the computed gap, and a distractor is what is left with learning on
    expect(CHECKS.echocancel[1].options[CHECKS.echocancel[1].answer]).toBe(`About ${gap} dB`);
    expect(CHECKS.echocancel[1].options).toContain(`About ${Math.round(on)} dB`);
    says('adaptive', 3, `${full.toFixed(0)} dB`);
    says('adaptive', 3, `${short.toFixed(0)} dB with 32 taps`);
    says('adaptive', 3, `${on.toFixed(0)} dB with learning left on, against ${frozen.toFixed(0)} dB when learning was stopped`);
    says('adaptive', 3, 'Over the last second of the run');
    says('adaptive', 3, 'G.168');
    says('adaptive', 3, `${ECHO_TAPS * 2} multiplications a sample`);
    says('adaptive', 0, 'The room is a filter');
    expect(CHANNELS.length).toBe(3);
  });
});

describe('group D: pictures', () => {
  it('separable 2-D filter: the costs and the test', () => {
    expect(filterCost(3)).toEqual({ full: 9, separable: 6 });
    expect(filterCost(15)).toEqual({ full: 225, separable: 30 });
    expect(filterCost(9)).toEqual({ full: 81, separable: 18 });
    expect(225 / 30).toBe(7.5);
    const p = scene(), whole = filter2d(p, KERNELS.blur.k), two = filter1d(filter1d(p, [0.25, 0.5, 0.25], 'x'), [0.25, 0.5, 0.25], 'y');
    let worst = 0;
    for (let i = 0; i < whole.px.length; i++) worst = Math.max(worst, Math.abs(whole.px[i] - two.px[i]));
    expect(worst).toBeLessThan(1e-9);
    // the blur is the outer product [1 2 1]ᵀ [1 2 1] / 16; Sobel is [1 2 1]ᵀ [−1 0 1]; the sharpening plus has rank 2
    const col = [1, 2, 1];
    expect(col.map((a) => [1, 2, 1].map((b) => (a * b) / 16))).toEqual(KERNELS.blur.k);
    expect(col.map((a) => [-1, 0, 1].map((b) => a * b))).toEqual(KERNELS.edges.k);
    const s = KERNELS.sharpen.k;
    expect(s[0][0] * s[1][1] - s[0][1] * s[1][0]).not.toBe(0);
    expect(64 * 64).toBe(4096);
    expect(16 * 64).toBe(1024);
    expect(16 * 22).toBe(352);
    quotes('separable', '[1 2 1]', '7.5', '225', '4,096', '1,024', '352', '81', '18');
    says('pictures', 1, `${filterCost(15).full}`);
    says('pictures', 1, 'separable');
    says('pictures', 3, 'The transform is separable');
    says('pictures', 4, '22 products by constants');
  });

  it('resizing: the cutoff, the taps, the numbers', () => {
    expect([2, 3, 4].map((m) => (1 / (2 * m)).toFixed(3))).toEqual(['0.250', '0.167', '0.125']);
    expect(decimationTaps(3).length).toBe(25);
    expect(8 * 3 + 1).toBe(25);
    const z = zonePlate(), raw = shrink(z, 3, false), fil = shrink(z, 3, true);
    expect(raw.w).toBe(64);
    const zr = psnr(z, grow(raw, 3, 'nearest')), zf = psnr(z, grow(fil, 3, 'nearest'));
    expect([zr, zf].map(f1)).toEqual(['7.8', '10.4']);
    const sc = scene(), sh = shrink(sc, 3, true), rep = psnr(sc, grow(sh, 3, 'nearest')), bil = psnr(sc, grow(sh, 3, 'bilinear'));
    expect([rep, bil].map(f1)).toEqual(['17.1', '18.0']);
    expect(f1(bil - rep)).toBe('0.9');
    expect(filterCost(25)).toEqual({ full: 625, separable: 50 });
    quotes('resampling', '0.125', '0.167', '0.25', '25', '7.8', '10.4', '17.1', '18.0', '0.9', '625', '50 multiplications', '192 × 192', '64 × 64');
    says('pictures', 2, `${f1(zr)} dB`);
    says('pictures', 2, `${f1(zf)}`);
    says('pictures', 2, 'windowed sinc cut at 1/(2m)');
  });

  it('DCT: the blocks, the energy, the stage', () => {
    const sc = scene();
    const info = ([['sky', 4, 3], ['stripes', 2, 18], ['checks', 18, 19], ['rings', 10, 19], ['sun', 16, 3]] as const).map(([name, bx, by]) => {
      const b = blockAt(sc, bx, by), S = fdct(b), e = Array.from(S).reduce((a, v) => a + v * v, 0), big = Array.from(S).filter((v) => Math.abs(v) >= 10).length;
      const eb = Array.from(b).reduce((a, v) => a + v * v, 0), top = Math.max(...Array.from(S).map((v) => v * v));
      expect(e / eb, `${name}: orthonormal`).toBeCloseTo(1, 9);
      return { name, S, big, share: (100 * top) / e };
    });
    expect(info.map((i) => i.big)).toEqual([2, 5, 28, 46, 53]);
    expect(info.map((i) => f1(i.share))).toEqual(['99.0', '81.7', '17.7', '48.3', '45.2']);
    const sky = info[0].S, mean = Array.from(blockAt(sc, 4, 3)).reduce((a, v) => a + v, 0) / 64;
    expect(sky[0]).toBeCloseTo(8 * mean, 9);
    expect(f1(sky[0])).toBe('-353.9');
    expect(f1(mean)).toBe('-44.2');
    const stage = nands(dctStage());
    expect([stage, 16 * stage]).toEqual([24721, 395536]);
    expect(DCT_K[3]).toBe(1703);
    expect(csdDigits(DCT_K[3]).length - 1).toBe(5);
    expect(DCT_K[6]).toBe(784);
    expect(csdDigits(DCT_K[6]).length - 1).toBe(2);
    quotes('dct', '2', '53', '5', '28', '46', ...info.map((i) => i.share.toFixed(1)), minus(sky[0], 1), minus(mean, 1), c(stage), c(16 * stage), '4,096', '1,024', '352', '1703', '784', '22 products');
    says('pictures', 3, 'the sky gets by on two');
    says('pictures', 3, 'S(0, 0) is then eight times the block');
    says('pictures', 4, `${c(stage).replace(/,/g, ' ')} NANDs`);
    says('pictures', 4, `${DCT_K[3]} is ${csdDigits(DCT_K[3]).length - 1} adders`);
    says('pictures', 3, 'to 12');
  });

  it('quantization table: the scale, the sizes', () => {
    const t = (q: number) => qualityTable(q);
    expect([10, 50, 90].map((q) => t(q)[0])).toEqual([80, 16, 3]);
    expect([10, 50, 90].map((q) => t(q)[63])).toEqual([255, 99, 20]);
    expect(Math.floor(5000 / 10)).toBe(500);
    expect(200 - 2 * 90).toBe(20);
    expect(Math.floor((99 * 500 + 50) / 100)).toBeGreaterThan(255);
    expect(t(25)[0]).toBe(32);
    expect(Math.floor((16 * 150 + 50) / 100)).toBe(24);
    expect(Math.floor((16 * 25 + 50) / 100)).toBe(4);
    expect(Math.floor((16 * 50 + 50) / 100)).toBe(8);
    expect(200 - 2 * 75).toBe(50);
    expect(Math.floor(5000 / 25)).toBe(200);
    expect(Math.floor((37 / 16) + 0.5) * 16).toBe(32);
    expect((37 / 16).toFixed(1)).toBe('2.3');
    const sc = scene(), enc = [10, 50, 90].map((q) => encodeJpeg(sc, q));
    expect(enc.map((e) => e.bytes.length)).toEqual([1920, 3932, 10250]);
    expect(enc.map((e) => f1(psnr(sc, e.out)))).toEqual(['24.5', '31.0', '39.3']);
    const zs = enc.map((e) => f1((100 * e.zeros) / (e.levels.length * 64)));
    expect(zs).toEqual(['94.9', '88.0', '65.5']);
    expect(sc.w * sc.h).toBe(36864);
    quotes('quanttable', '80', '16', '3', '255', '99', '20', '500 %', '100 %', '20 %', c(1920), c(3932), c(10250), c(36864), '24.5', '31.0', '39.3', ...zs, '5000 / q', '200 − 2q', '32', '24', '2.3');
    says('pictures', 5, `${c(1920).replace(/,/g, ' ')} bytes at ${f1(psnr(sc, enc[0].out))} dB`);
    says('pictures', 5, '5000 / q percent');
    says('pictures', 5, '200 − 2q');
    says('pictures', 5, 'nine qualities from 1 to 100');
    says('pictures', 5, 'Table K.1');
  });

  it('zig-zag and run lengths: the order and a worked block', () => {
    expect(ZIGZAG.slice(0, 10)).toEqual([0, 1, 8, 16, 9, 2, 3, 10, 17, 24]);
    const ac = huffCodes(AC_LUMA);
    expect(category(5)).toBe(3);
    expect(extraBits(5, 3).toString(2)).toBe('101');
    expect(category(-2)).toBe(2);
    expect(extraBits(-2, 2).toString(2).padStart(2, '0')).toBe('01');
    const lens = [ac.get(0x03)!.len, ac.get(0x22)!.len, ac.get(0x00)!.len];
    expect(lens).toEqual([3, 8, 4]);
    expect(lens.reduce((s, v) => s + v, 0) + 3 + 2).toBe(20);
    expect(ac.get(0xf0)!.len).toBe(11);
    const sc = scene(), e50 = encodeJpeg(sc, 50);
    expect(e50.zeros).toBe(32435);
    quotes('zigzag', '0, 1, 8, 16, 9, 2, 3, 10, 17, 24', '0xF0', '0x00', '0x03', '0x22', '101', '01', '20 bits', '63', c(32435), c(36864), '16');
    says('pictures', 6, 'ZRL');
    says('pictures', 6, 'EOB');
    says('pictures', 6, 'Figure A.6');
  });

  it('Huffman code: the lists, the codes, the bits', () => {
    const ac = huffCodes(AC_LUMA), dc = huffCodes(DC_LUMA);
    expect(AC_LUMA.vals.length).toBe(162);
    expect(DC_LUMA.vals.length).toBe(12);
    expect(AC_LUMA.bits.join(', ')).toBe('0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125');
    expect(AC_LUMA.vals.slice(0, 6).map((v) => '0x' + v.toString(16).padStart(2, '0'))).toEqual(['0x01', '0x02', '0x03', '0x00', '0x04', '0x11']);
    const bin = (s: number) => ac.get(s)!.code.toString(2).padStart(ac.get(s)!.len, '0');
    expect([0x01, 0x02, 0x03, 0x00, 0x04, 0x11].map(bin)).toEqual(['00', '01', '100', '1010', '1011', '1100']);
    expect([0x01, 0x02].map((s) => ac.get(s)!.len)).toEqual([2, 2]);
    expect(ac.get(0xf0)!.len).toBe(11);
    expect(AC_LUMA.bits[15]).toBe(125);
    expect(Math.max(...[...ac.values()].map((v) => v.len))).toBe(16);
    let kraft = 0;
    for (const v of ac.values()) kraft += 2 ** -v.len;
    expect(kraft).toBeCloseTo(1 - 2 ** -16, 12);
    expect(kraft.toFixed(5)).toBe('0.99998');
    expect(dc.get(0)!.len).toBe(2);
    const e = encodeJpeg(scene(), 50).bits;
    expect([(e.dcCodes + e.acCodes) / 8, (e.dcExtra + e.acExtra) / 8, e.header / 8].map((v) => c(Math.round(v)))).toEqual(['2,465', '1,094', '326']);
    expect(e.stuffed).toBe(368);
    expect(ac.get(0x03)!.len + category(5)).toBe(6);
    quotes('huffman', '162', '12 symbols', '2,465', '1,094', '326', '368', '0.99998', '125', '1010', '1011', '1100', '100', '101', '6 bits', '0xF0');
    says('pictures', 6, `${c(Math.round((e.dcCodes + e.acCodes) / 8)).replace(/,/g, ' ')}`);
    says('pictures', 6, 'Tables K.3 and K.5');
    says('pictures', 6, 'two short lists');
  });

  it('baseline JPEG: the sizes, the ratios, the file', () => {
    const sc = scene(), enc = [10, 50, 90].map((q) => encodeJpeg(sc, q)), raw = sc.w * sc.h;
    expect(sc.w).toBe(192);
    expect(enc.map((e) => f1(raw / e.bytes.length))).toEqual(['19.2', '9.4', '3.6']);
    expect(Math.round((100 * enc[1].bits.header) / 8 / enc[1].bytes.length)).toBe(8);
    expect(f1(raw / 3932)).toBe('9.4');
    expect((3932 / raw).toFixed(2)).toBe('0.11');
    // the file's markers: SOI, JFIF, DQT, SOF0, DHT, SOS, ... EOI
    const b = enc[1].bytes, marks: number[] = [];
    for (let i = 0; i < b.length - 1 && marks.length < 6; ) { if (b[i] === 0xff && b[i + 1] !== 0 && b[i + 1] !== 0xff) { marks.push(b[i + 1]); i += b[i + 1] === 0xd8 ? 2 : 2 + ((b[i + 2] << 8) | b[i + 3]); } else i++; }
    expect(marks).toEqual([0xd8, 0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    expect([b[b.length - 2], b[b.length - 1]]).toEqual([0xff, 0xd9]);
    quotes('jpeg', c(36864), c(3932), c(1920), c(10250), '9.4', '19.2', '3.6', '24.5', '31.0', '39.3', '2,465', '1,094', '326', '8 %', '192 × 192', 'SOI', 'SOF0', 'EOI');
    says('pictures', 7, `${c(3932).replace(/,/g, ' ')} bytes`);
    says('pictures', 7, 'libjpeg through Pillow');
    says('pictures', 7, 'within one level');
    says('pictures', 5, 'The quality setting is not in T.81 at all');
  });
});
