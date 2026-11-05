// Filters that learn: Levinson against scipy's solve_toeplitz, LMS converging to it, the echo canceller and equalizer, and the gates against the integer model every clock.

import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { correlate, echoPath, erleDb, farEnd, levinson, Lms, LmsFixed, runEcho, runEqualizer, type LmsSpec } from '../src/dsp/adaptive';
import { lmsFilter } from '../src/lib/sigmadelta';
import { rng, gaussian } from '../src/phys/line';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import V from './dsp/vectors/adaptive.json';

const SPEC: LmsSpec = { n: 4, wx: 8, w: 12, f: 8, s: 7 };

describe('the best filter', () => {
  it('Levinson matches solve_toeplitz', () => {
    expect(V.cases.length).toBeGreaterThan(2);
    for (const c of V.cases) levinson(c.r, c.p).forEach((v, i) => expect(v).toBeCloseTo(c.w[i], 8));
  });
  it('it recovers an FIR it is shown, from correlations alone', () => {
    const u = rng(4), x = Array.from({ length: 20000 }, () => gaussian(u)), h = [0.8, -0.3, 0.1, 0.05];
    const d = x.map((_, i) => h.reduce((a, t, k) => a + t * (x[i - k] ?? 0), 0));
    const { r, p } = correlate(x, d, 4);
    levinson(r, p).forEach((v, i) => expect(v).toBeCloseTo(h[i], 1));
  });
});

describe('LMS', () => {
  const u = rng(9), x = Array.from({ length: 30000 }, () => gaussian(u)), h = [0.5, -0.4, 0.25, 0.1, -0.05, 0.02];
  const d = x.map((_, i) => h.reduce((a, t, k) => a + t * (x[i - k] ?? 0), 0) + 0.01 * gaussian(u));
  it('converges to the Wiener solution', () => {
    const { r, p } = correlate(x, d, 6), want = levinson(r, p), f = new Lms(6, 0.005);
    x.forEach((v, i) => f.step(v, d[i]));
    f.w.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(0.01));
  });
  it('too large a step diverges, and the limit is near 2 / (N σ²)', () => {
    const run = (mu: number) => { const f = new Lms(6, mu); let last = 0; x.slice(0, 4000).forEach((v, i) => { last = f.step(v, d[i]).e; }); return Math.abs(last); };
    expect(run(0.05)).toBeLessThan(1);
    expect(run(2 / 6 * 1.5)).toBeGreaterThan(1e6);
  });
  it('NLMS does not care how loud the input is, and LMS does', () => {
    const loud = x.slice(0, 8000).map((v) => v * 10), dl = d.slice(0, 8000).map((v) => v * 10);
    const nl = new Lms(6, 0.5, true); let e = 0;
    loud.forEach((v, i) => { e = nl.step(v, dl[i]).e; });
    expect(Math.abs(e)).toBeLessThan(1);
    const lm = new Lms(6, 0.05); let f = 0;
    loud.forEach((v, i) => { f = lm.step(v, dl[i]).e; });
    expect(Number.isFinite(f) ? Math.abs(f) : Infinity).toBeGreaterThan(1e6);
  });
});

describe('an echo canceller', () => {
  const N = 40000, taps = 128;
  it('brings a hidden path\'s echo down by tens of dB, and it is a model in every part', () => {
    const r = runEcho({ n: N, seed: 3, taps, mu: 0.5, normalized: true });
    expect(r.erle).toBeGreaterThan(25);
    const none = runEcho({ n: N, seed: 3, taps, mu: 0, normalized: true });
    expect(Math.abs(none.erle)).toBeLessThan(0.01);
  });
  it('a filter shorter than the path leaves what it cannot reach', () => {
    const shortOne = runEcho({ n: N, seed: 3, taps: 12, mu: 0.5, normalized: true }), full = runEcho({ n: N, seed: 3, taps, mu: 0.5, normalized: true });
    expect(shortOne.erle).toBeLessThan(full.erle - 8);
  });
  it('near-end talk knocks it off, unless it stops learning while it hears any', () => {
    const talk = { talkFrom: 24000, talkTo: 32000 };
    const on = runEcho({ n: N, seed: 3, taps, mu: 0.5, normalized: true, ...talk }), held = runEcho({ n: N, seed: 3, taps, mu: 0.5, normalized: true, ...talk, freeze: true });
    expect(held.erle).toBeGreaterThan(on.erle + 5);
  });
  it('the far end is coloured, starts and stops, and the path dies away', () => {
    const x = farEnd(16000, 3);
    expect(x.filter((v) => v === 0).length).toBeGreaterThan(500);
    const h = echoPath(3);
    expect(Math.abs(h[20]) + Math.abs(h[30])).toBeLessThan(2);
    expect(h.slice(110).every((v) => Math.abs(v) < 0.1)).toBe(true);
  });
  it('erle reads what it says', () => {
    expect(erleDb([1, 1], [0.1, 0.1])).toBeCloseTo(20, 9);
  });
});

describe('an equalizer', () => {
  it('opens a shut channel, and keeps it open on its own decisions', () => {
    const r = runEqualizer({ channel: [0.35, 1, -0.6, 0.2], taps: 15, delay: 8, mu: 0.05, n: 12000, seed: 5, train: 4000 });
    expect(r.openingBefore).toBeLessThan(0);
    expect(r.opening).toBeGreaterThan(1.5);
    expect(r.wrongAfter).toBe(0);
  });
  it('cannot invert a channel with a zero on the circle', () => {
    const r = runEqualizer({ channel: [0.5, 1, 0.5], taps: 15, delay: 8, mu: 0.05, n: 12000, seed: 5, train: 4000 });
    expect(r.opening).toBeLessThan(0.2);
    expect(r.wrongAfter).toBeGreaterThan(0);
  });
});

describe('the gates', () => {
  it('the filter equals the model every clock, and learns a target', () => {
    const def = lmsFilter(SPEC), sim = new BitSim(flatten(def)), m = new LmsFixed(SPEC), u = rng(21);
    const target = [0.75, -0.5, 0.25, 0.125], hist = [0, 0, 0, 0], ds: number[] = [], es: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const x = Math.round(80 * gaussian(u) * 0.8) | 0, xx = Math.max(-128, Math.min(127, x));
      const d = Math.max(-128, Math.min(127, Math.round(target.reduce((a, t, k) => a + t * hist[k], 0))));
      sim.setInput('x', [wordOf(xx, SPEC.wx)]); sim.setInput('d', [wordOf(d, SPEC.wx)]);
      sim.cycle();
      ds.push(d); es.push(m.e(d));
      m.edge(xx, d);
      hist.pop(); hist.unshift(xx);
      const got = [signedOf(sim.get('y', 1)[0], SPEC.w), ...[0, 1, 2, 3].map((k) => signedOf(sim.get(`c${k}`, 1)[0], SPEC.w))];
      const want = [m.y, ...m.c];
      if (got.join() !== want.join()) expect([i, ...got]).toEqual([i, ...want]);
    }
    const n = ds.length;
    expect(erleDb(ds, es, n - 1500, n)).toBeGreaterThan(15);
  }, 60_000);
});
