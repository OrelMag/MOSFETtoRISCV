// What "The z-plane" claims, on dsp/zplane.ts.
import { describe, expect, it } from 'vitest';
import { chZplane } from '../src/chapters/ch-dsp-zplane';
import { numOf } from '../src/chapters/order';
import { convolve, filter, gainAt, groupDelay, impulse, pairCoeffs, pairsPoly, polyRoots } from '../src/dsp/zplane';
import { binomialGain } from '../src/comm/signals';
import { CONV_H, CONV_X, inner, outer, settleSamples } from '../src/widgets/dspzplane';

const rounded = (c: number[]) => c.map((v) => Math.round(v * 1e9) / 1e9 + 0);

describe('the numbers in the text', () => {
  it('follows Numbers that fit', () => expect(numOf('zplane')).toBe(numOf('fixed') + 1));
  it('y[3] of the one-pole quiz', () => expect(filter([0.1], [1, -0.9], [1, 0, 0, 0])[3]).toBeCloseTo(0.0729, 9));
  it('the convolution quiz', () => {
    const y = convolve(CONV_X, CONV_H);
    expect(y[2]).toBe(1.25); expect(y.length).toBe(CONV_X.length + CONV_H.length - 1);
    expect(new Set([y[2], CONV_X[2], CONV_X[1] * CONV_H[1], y[3]]).size, 'four different options').toBe(4);
  });
  it('FIR5 on the circle is cos⁴', () => {
    for (const f of [0, 0.1, 0.25, 0.4]) expect(gainAt([1, 4, 6, 4, 1], [1], f) / 16).toBeCloseTo(binomialGain(f), 9);
    expect(gainAt([1, 4, 6, 4, 1], [1], 0.5)).toBeCloseTo(0, 9);
  });
  it('a zero pair at a quarter of a cycle is 1, 0, 1, and each wrong option is what its why says', () => {
    expect(rounded(pairCoeffs(1, Math.PI / 2))).toEqual([1, 0, 1]);
    expect(rounded(pairCoeffs(1, (2 * Math.PI) / 3))).toEqual([1, 1, 1]);
    expect(rounded(pairCoeffs(1, 0))).toEqual([1, -2, 1]);
    expect(rounded(pairCoeffs(1, Math.PI))).toEqual([1, 2, 1]);
  });
  it('settling, and a pole really falls that far by then', () => {
    expect(settleSamples(0.99)).toBe(459); expect(settleSamples(0.999)).toBeGreaterThan(4500);
    for (const r of [0.8, 0.97, 0.99]) {
      const n = settleSamples(r), ir = impulse([1], [1, -r], n + 1);
      expect(Math.abs(ir[n])).toBeLessThanOrEqual(0.01); expect(Math.abs(ir[n - 1])).toBeGreaterThan(0.01);
    }
  });
  it('the stability quiz: radius √0.7', () => {
    for (const z of polyRoots([1, -1.5, 0.7])) expect(Math.hypot(z.re, z.im)).toBeCloseTo(Math.sqrt(0.7), 9);
  });
  it('the mirror: same gain everywhere, delays that add to the length', () => {
    const a = inner(0.7, 1), b = outer(0.7, 1), both = convolve(a, b);
    for (const f of [0.02, 0.1, 0.2, 0.3, 0.45]) {
      expect(gainAt(b, [1], f)).toBeCloseTo(gainAt(a, [1], f), 9);
      expect(groupDelay(both, [1], f)).toBeCloseTo(2, 9);
      expect(groupDelay(a, [1], f), 'inside has less delay').toBeLessThan(groupDelay(b, [1], f));
    }
    both.forEach((v, i) => expect(v).toBeCloseTo(both[both.length - 1 - i], 12));
  });
  it('a notch: null at its angle, near 1 away from it', () => {
    const t = 0.4 * Math.PI, b = pairsPoly([{ r: 1, t }]), a = pairsPoly([{ r: 0.95, t }]);
    expect(gainAt(b, a, 0.2)).toBeCloseTo(0, 9);
    expect(gainAt(b, a, 0.05)).toBeGreaterThan(0.9);
    expect(gainAt(b, a, 0.45)).toBeGreaterThan(0.9);
  });
  it('symmetric taps delay by half the length', () => {
    const b = new Array<number>(101).fill(0).map((_, i) => 1 + Math.abs(i - 50));
    expect(groupDelay(b, [1], 0.13)).toBeCloseTo(50, 9);
  });
});

describe('the text', () => {
  it('every step has words and something to do', () => {
    for (const s of chZplane.steps) { expect(s.body.length, s.title).toBeGreaterThan(300); expect(!!s.widget || !!s.scene, s.title).toBe(true); expect(s.challenge, s.title).toBeTruthy(); }
  });
  it('links only to chapters in the book', () => {
    for (const s of chZplane.steps) for (const m of s.body.matchAll(/#\/c\/([a-z0-9-]+)\//g)) expect(numOf(m[1] as never), m[1]).toBeDefined();
  });
});
