// dsp/zplane.ts against scipy's answers (tests/dsp/vectors/zplane.json, scripts/dsp/oracle.py).
import { describe, expect, it } from 'vitest';
import vectors from './dsp/vectors/zplane.json';
import { convolve, filter, gainAt, impulse, isStable, pairCoeffs, phaseAt, polyFromRoots, polyRoots, poleRadius } from '../src/dsp/zplane';

const near = (got: number[], want: number[], tol: number, what: string) => {
  expect(got.length, what).toBe(want.length);
  got.forEach((v, i) => expect(Math.abs(v - want[i]) <= tol * Math.max(1, Math.abs(want[i])), `${what}[${i}]: ${v} against ${want[i]}`).toBe(true));
};

describe('against scipy', () => {
  for (const f of vectors.filters) {
    it(f.name, () => {
      near(impulse(f.b, f.a, 32), f.impulse, 1e-9, 'impulse');
      near(filter(f.b, f.a, vectors.x), f.lfilter, 1e-8, 'lfilter');
      near(vectors.fs.map((x) => gainAt(f.b, f.a, x)), f.gain, 1e-9, 'gain');
      vectors.fs.forEach((x, i) => {
        // a phase of ±π is one angle; a gain of nearly 0 has none
        if (f.gain[i] < 1e-9) return;
        const d = Math.abs(phaseAt(f.b, f.a, x) - f.phase[i]) % (2 * Math.PI);
        expect(Math.min(d, 2 * Math.PI - d), `phase at ${x}`).toBeLessThan(1e-8);
      });
    });
    // scipy pads the shorter polynomial with roots at the origin: only the non-trivial ones are the filter's
    it(`${f.name}: poles and zeros`, () => {
      const poles = polyRoots(f.a), want = f.poles.map(([re, im]) => ({ re, im }));
      for (const w of want.filter((x) => Math.hypot(x.re, x.im) > 1e-9)) expect(poles.some((p) => Math.hypot(p.re - w.re, p.im - w.im) < 1e-4), `pole ${w.re} ${w.im}`).toBe(true);
      const zeros = polyRoots(f.b), wz = f.zeros.map(([re, im]) => ({ re, im }));
      // repeated roots are only found to about the fourth root of machine precision, by both sides
      for (const w of wz.filter((x) => Math.hypot(x.re, x.im) > 1e-9)) expect(zeros.some((p) => Math.hypot(p.re - w.re, p.im - w.im) < 5e-3), `zero ${w.re} ${w.im}`).toBe(true);
    });
  }
  it('convolution', () => near(convolve(vectors.convolve.x, vectors.convolve.h), vectors.convolve.y, 1e-12, 'y'));
});

describe('poles', () => {
  it('a polynomial rebuilt from its roots is the polynomial', () => {
    for (const c of [[1, -1.5, 0.7], [1, 4, 6, 4, 1], [1, 0, 0, -0.5], [1, -0.5]]) near(polyFromRoots(polyRoots(c)), c, 1e-4, c.join());
  });
  it('FIR5 is four zeros at −1', () => {
    for (const z of polyRoots([1, 4, 6, 4, 1])) expect(Math.hypot(z.re + 1, z.im)).toBeLessThan(5e-3);
  });
  it('stability is the pole radius, and the impulse response agrees', () => {
    expect(poleRadius(pairCoeffs(0.97, 0.25))).toBeCloseTo(0.97, 9);
    expect(isStable(pairCoeffs(0.97, 0.25))).toBe(true);
    expect(isStable(pairCoeffs(1, 0.25))).toBe(false);
    expect(isStable([1, -1.1])).toBe(false);
    const late = (a: number[]) => Math.max(...impulse([1], a, 4000).slice(-100).map(Math.abs));
    expect(late(pairCoeffs(0.97, 0.25))).toBeLessThan(1e-20);
    expect(late([1, -1.1])).toBeGreaterThan(1e20);
  });
});
