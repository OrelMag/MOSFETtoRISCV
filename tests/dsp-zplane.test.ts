// dsp/zplane.ts against scipy's answers (tests/dsp/vectors/zplane.json, scripts/dsp/oracle.py).
import { describe, expect, it } from 'vitest';
import vectors from './dsp/vectors/zplane.json';
import { convolve, filter, gainAt, gainByDistances, groupDelay, impulse, isStable, pairCoeffs, pairsPoly, phaseAt, polyFromRoots, polyRoots, poleRadius, settleOfPair, stateOfPoles } from '../src/dsp/zplane';

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
        if (f.gain[i] > 1e-6) expect(Math.abs(groupDelay(f.b, f.a, x) - f.delay[i]), `delay at ${x}`).toBeLessThan(1e-6);
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

describe('reading the plane', () => {
  it('distances give the gain the polynomials give', () => {
    const z = [{ r: 1, t: 0.8 }, { r: 0.9, t: 2.1 }], p = [{ r: 0.95, t: 0.8 }, { r: 0.5, t: 1.7 }];
    for (const f of [0.02, 0.1, 0.2, 0.33, 0.48]) expect(gainByDistances(z, p, f)).toBeCloseTo(gainAt(pairsPoly(z), pairsPoly(p), f), 9);
  });
  it('two pairs at π are FIR5', () => {
    expect(pairsPoly([{ r: 1, t: Math.PI }, { r: 1, t: Math.PI }]).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 4, 6, 4, 1]);
  });
  it('group delay against the phase\'s slope, and a symmetric FIR is half its length', () => {
    const b = pairsPoly([{ r: 0.8, t: 1 }]), a = pairsPoly([{ r: 0.7, t: 0.5 }]), f = 0.13, e = 1e-5;
    const slope = -(phaseAt(b, a, f + e) - phaseAt(b, a, f - e)) / (2 * e * 2 * Math.PI);
    expect(groupDelay(b, a, f)).toBeCloseTo(slope, 5);
    for (const x of [0.03, 0.1, 0.2]) expect(groupDelay([1, 4, 6, 4, 1], [1], x)).toBeCloseTo(2, 9);
  });
});

describe('a pole pair on the circle', () => {
  it('at 0 or π it is a double real root and grows, elsewhere it rings for ever', () => {
    expect(stateOfPoles([{ r: 1, t: 0 }])).toBe('unstable');
    expect(stateOfPoles([{ r: 1, t: Math.PI }])).toBe('unstable');
    expect(stateOfPoles([{ r: 1, t: 1 }])).toBe('on the circle');
    expect(stateOfPoles([{ r: 1.01, t: 1 }])).toBe('unstable');
    expect(stateOfPoles([{ r: 0.99, t: 0 }])).toBe('stable');
    expect(stateOfPoles([])).toBe('none');
    const peak = (t: number, from: number, to: number) => Math.max(...impulse([1], pairCoeffs(1, t), to).slice(from).map(Math.abs));
    expect(peak(Math.PI, 500, 1000), 'grows like n').toBeGreaterThan(5 * peak(Math.PI, 0, 100));
    expect(peak(1, 900, 1000)).toBeCloseTo(peak(1, 0, 100), 0);
  });
  it('how long a pair takes: rⁿ when it rings, (n + 1) rⁿ when it is a double real root, against the impulse response', () => {
    for (const p of [{ r: 0.9, t: 1 }, { r: 0.97, t: 0.25 }]) expect(settleOfPair(p)).toBe(Math.ceil(Math.log(0.01) / Math.log(p.r)));
    for (const p of [{ r: 0.9, t: 0 }, { r: 0.8, t: Math.PI }]) {
      const n = settleOfPair(p), ir = impulse([1], pairCoeffs(p.r, p.t), n + 2).map(Math.abs);
      expect(ir[n]).toBeLessThanOrEqual(0.01); expect(ir[n - 1]).toBeGreaterThan(0.01);
    }
    expect(settleOfPair({ r: 1, t: 1 })).toBe(Infinity);
  });
  it('the gain is not a number exactly there, which is what the plot has to guard against', () => {
    expect(Number.isFinite(gainAt([1], pairCoeffs(1, 0), 0))).toBe(false);
    expect(Number.isFinite(gainAt([1], pairCoeffs(1, Math.PI), 0.5))).toBe(false);
  });
});
