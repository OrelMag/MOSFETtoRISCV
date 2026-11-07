// Group A of the Signal processing level's codex entries (numbers that fit, the z-plane): every number they quote equal to dsp/ and the library,
// or to the chapter step that prints it. Completeness and form are tests/content-codexdsp.test.ts's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { fracMul, guardBits, wordMax, wordMin } from '../src/dsp/fixed';
import { chainSnr, overflowRun, runningSum } from '../src/dsp/fixeddemos';
import { convolve, gainAt, gainByDistances, groupDelay, impulse, polyRoots, settleOfPair } from '../src/dsp/zplane';
import { rca } from '../src/lib/combinational';
import { clampWord, satAdder } from '../src/lib/fixedpt';
import { stats } from '../src/sim/stats';
import { SUM_SETS } from '../src/widgets/dspfixed';
import { inner, outer, settleSamples } from '../src/widgets/dspzplane';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};
const minus = (x: number, d: number) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);

describe('group A: numbers that fit', () => {
  it('Q format: range, step, and the product\'s shift', () => {
    expect(wordMax(16)).toBe(32767);
    expect(wordMin(8)).toBe(-128);
    expect(wordMax(8)).toBe(127);
    expect(fracMul(96, 64, 8)).toBe(48);
    expect(48 / 128).toBe(0.375);
    expect((127 / 128).toFixed(4)).toBe('0.9922');
    expect((96 * 64) >> 7).toBe(48);
    expect((96 * 64) >> 8).toBe(24);
    expect(96 * 64).toBe(6144);
    expect(fracMul(-128, -128, 8)).toBe(127);
    quotes('qformat', '32 767 / 32 768', '127 / 128', '0.9922', '6 144', '48', '0.375', '24', '127');
    says('fixed', 3, 'Q1.7 words');
    says('fixed', 3, '48 (0.375)');
  });

  it('saturating arithmetic: the price in NANDs and the dB at +6 dB', () => {
    const rows = [8, 16, 24].map((w) => [w, nands(satAdder(w)), nands(rca(w))]);
    quotes('saturate', rows[0][1], rows[0][2], rows[1][1], rows[1][2], rows[2][1], rows[2][2]);
    expect(rows.map((r) => r[1] - r[2])).toEqual([46, 78, 110]);
    quotes('saturate', 46, 78, 110);
    expect(nands(rca(9)) + nands(clampWord(8))).toBe(nands(satAdder(8)));
    quotes('saturate', nands(rca(9)), nands(clampWord(8)));
    const w = overflowRun(6, 16, 'wrap').snrDb, s = overflowRun(6, 16, 'sat').snrDb, d = overflowRun(6, 16, 'scale').snrDb;
    quotes('saturate', minus(w, 1), f1(s), f1(d), '1.8 × full scale');
    expect((0.9 * 10 ** (6 / 20)).toFixed(1)).toBe('1.8');
    says('fixed', 1, `${f1(s)} dB`);
    says('fixed', 2, `${nands(satAdder(8))} NANDs`);
  });

  it('guard bits: log₂ n, and the eight words', () => {
    expect([guardBits(256), guardBits(512), guardBits(1024)]).toEqual([8, 9, 10]);
    quotes('guardbits', 8, 10, '42 bits', '40-bit', '32 for a Q2.30');
    expect(32 + guardBits(1024)).toBe(42);
    const xs = SUM_SETS[0].xs;
    expect(xs).toEqual([90, 80, 70, -60, -90, -50, 20, 15]);
    const r = runningSum(xs, 8);
    quotes('guardbits', ...r.truth.map((v) => minus(v, 0)), ...r.wrapped.map((v) => minus(v, 0)), ...r.clamped.map((v) => minus(v, 0)));
    quotes('guardbits', Math.max(...r.truth));
    expect(r.wrapped.at(-1)).toBe(75);
    expect(r.clamped.at(-1)).toBe(-38);
    says('fixed', 5, `${guardBits(256)} guard bits for 256`);
    expect(guardBits(512)).toBe(9);
  });

  it('headroom: down first against up first, and the bound', () => {
    const d = chainSnr(0.1, 3, 16, 'down first'), u = chainSnr(0.1, 3, 16, 'up first');
    quotes('headroom', f1(d), f1(u), '3.2', '1 / 4');
    expect(Math.ceil(Math.log2(3.2))).toBe(2);
    expect(1 / 4).toBeLessThan(1 / 3.2);
    expect(1 / 4).toBeGreaterThan(1 / 5.5);
    expect(1 / 8).toBeLessThan(1 / 5.5);
    expect(Math.ceil(Math.log2(5.5))).toBe(3);
    expect((1 / 5.5).toFixed(2)).toBe('0.18');
    quotes('headroom', '0.18', '0.125', '0.25');
    says('fixed', 6, `${f1(d)} dB`);
    says('fixed', 6, `${f1(u)} dB`);
  });
});

describe('group A: the z-plane', () => {
  it('difference equation: the stepped pole and the costs', () => {
    const y = impulse([0.1], [1, -0.9], 4);
    expect(y[3]).toBeCloseTo(0.0729, 12);
    quotes('diffeq', '0.1', '0.09', '0.081', '0.0729');
    expect(y[1]).toBeCloseTo(0.09, 12);
    const h = impulse([1], [1, -0.5], 3);
    expect(h[2]).toBe(0.25);
    quotes('diffeq', '0.25');
    // 5 coefficients: 5 multiplications, 4 additions, 4 delays
    const b = 3, a = 2;
    expect([b + a, b + a - 1, b - 1 + a]).toEqual([5, 4, 4]);
    quotes('diffeq', '5 multiplications, 4 additions, 4 words');
    says('zplane', 0, 'one multiplication for each coefficient');
    says('zplane', 0, 'one word of memory for each delay');
  });

  it('convolution: lengths, costs and the example', () => {
    const x = [1, 2, 0, -1, 3, 1], h = [1, 0.5, 0.25];
    const y = convolve(x, h);
    expect(y).toEqual([1, 2.5, 1.25, -0.5, 2.5, 2.25, 1.25, 0.25]);
    expect(y.length).toBe(8);
    expect(x.length * h.length).toBe(18);
    quotes('convolution', '1.25', '2.5', '−0.5', '2.25', '0.25', '8 samples', '18 multiplications');
    expect(convolve([1, 1], [1, -1])).toEqual([1, 0, -1]);
    expect(convolve([1, 1], [1, 1])).toEqual([1, 2, 1]);
    expect(10 + 4 - 1).toBe(13);
    expect(10 * 4).toBe(40);
    expect(1000 * 101).toBe(101000);
    quotes('convolution', '13 samples, 40 multiplications', '101 000');
    says('zplane', 1, `${x.length} samples through ${h.length} taps gives ${y.length}`);
  });

  it('z-transform: FIR5 as a polynomial', () => {
    const b = [1, 4, 6, 4, 1];
    expect(convolve(convolve(convolve([1, 1], [1, 1]), [1, 1]), [1, 1])).toEqual(b);
    expect(gainAt(b, [1], 0)).toBeCloseTo(16, 9);
    expect(gainAt(b, [1], 0.25)).toBeCloseTo(4, 9);
    expect(gainAt(b, [1], 0.25) / 16).toBeCloseTo(0.25, 9);
    expect(Math.cos(Math.PI * 0.25) ** 4).toBeCloseTo(0.25, 12);
    expect(gainAt(b, [1], 0.5)).toBeLessThan(1e-9);
    expect(gainAt([1, 2, 1], [1], 0)).toBeCloseTo(4, 9);
    expect(gainAt([1, 2, 1], [1], 0.5)).toBeLessThan(1e-9);
    quotes('ztransform', '1, 4, 6, 4, 1', '16', '0.25', '4');
    says('zplane', 2, `${(gainAt(b, [1], 0.25) / 16).toFixed(3)} of the DC gain`);
    expect(Math.cos(Math.PI / 2)).toBeCloseTo(0, 12);
  });

  it('poles and zeros: the ring, the notch and the test', () => {
    const fall = [0.9, 0.97, 0.99].map((r) => settleSamples(r));
    expect(fall).toEqual([44, 152, 459]);
    expect(settleOfPair({ r: 0.97, t: 0.04 * 2 * Math.PI })).toBe(152);
    expect(settleOfPair({ r: 0.99, t: 0.04 * 2 * Math.PI })).toBe(459);
    quotes('polezero', ...fall);
    says('zplane', 4, String(fall[1]));
    expect(Math.round((4.6 / (1 - 0.9)))).toBe(46);
    const nt = 0.2 * 2 * Math.PI;
    const g = (r: number, f: number) => gainByDistances([{ r: 1, t: nt }], [{ r, t: nt }], f);
    expect(g(0.8, 0.2)).toBeCloseTo(0, 9);
    expect(g(0.98, 0.2)).toBeCloseTo(0, 9);
    for (const [r, f, want] of [[0.8, 0.21, '0.34'], [0.98, 0.21, '0.97'], [0.8, 0.25, '1.01'], [0.98, 0.25, '1.02']] as const) expect(f2(g(r, f)), `${r} ${f}`).toBe(want);
    quotes('polezero', '0.34', '0.97', '1.01', '1.02', '0.8', '0.98');
    const roots = polyRoots([1, -1.2 + 0.0, 0.5]);
    expect(Math.hypot(roots[0].re, roots[0].im)).toBeCloseTo(Math.sqrt(0.5), 9);
    expect(Math.sqrt(0.5).toFixed(2)).toBe('0.71');
    const r2 = polyRoots([1, -1.5, 0.7]);
    expect(f2(r2[0].re)).toBe('0.75');
    expect(f2(Math.abs(r2[0].im))).toBe('0.37');
    expect(Math.sqrt(0.7).toFixed(2)).toBe('0.84');
    quotes('polezero', '0.75 ± 0.37j', '0.84', '0.71');
  });

  it('minimum phase: the mirror pair, the delays and linear phase', () => {
    const a = inner(0.7, 1), b = outer(0.7, 1), both = convolve(a, b);
    expect(a.map((v) => minus(v, 2))).toEqual(['1.00', '−0.76', '0.49']);
    quotes('minphase', '1, −0.76, 0.49', '0.49, −0.76, 1');
    expect(b).toEqual([...a].reverse());
    expect(both.map((v) => minus(v, 2))).toEqual(['0.49', '−1.13', '1.81', '−1.13', '0.49']);
    quotes('minphase', '0.49, −1.13, 1.81, −1.13, 0.49');
    for (const f of [0.05, 0.16, 0.4]) expect(gainAt(a, [1], f)).toBeCloseTo(gainAt(b, [1], f), 9);
    expect(minus(groupDelay(a, [1], 0.16), 2)).toBe('−1.96');
    expect(minus(groupDelay(b, [1], 0.16), 2)).toBe('3.96');
    for (const f of [0.05, 0.16, 0.4]) expect(groupDelay(both, [1], f)).toBeCloseTo(2, 9);
    expect(groupDelay([1, 4, 6, 4, 1], [1], 0.1)).toBeCloseTo(2, 9);
    quotes('minphase', '−1.96', '3.96', '2 samples', '(5 − 1) / 2');
    expect((200 / 2)).toBe(100);
    expect((101 - 1) / 2).toBe(50);
    expect(((50 / 48000) * 1000).toFixed(2)).toBe('1.04');
    expect((115 - 1) / 2).toBe(57);
    quotes('minphase', '1.04 ms', '50 samples', '57 samples', '100');
    says('zplane', 6, '57 samples');
    says('zplane', 6, '(N − 1) / 2 samples');
  });
});

