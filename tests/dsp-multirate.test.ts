// Changing the rate: polyphase against the direct form and scipy, the CIC against its FIR and Hogenauer's growth, and the gates against the models every clock.

import { describe, expect, it } from 'vitest';
import { firFilter, firGain, signedOf, windowedSinc, wordOf } from '../src/comm/signals';
import {
  cicAliasDb, cicDcGain, cicGrowth, CicModel, cicResponse, cicTaps, cicWidth, decimateDirect, downsample, halfBand, nonZero, polyphaseDecimate, polyphaseInterpolate, PolyModel, polyTaps, tapsFor, upfirdn, upsample,
} from '../src/dsp/multirate';
import { wrapTo } from '../src/dsp/fixed';
import { cicDecimator, POLY_SPEC, polyDecimator } from '../src/lib/multirate';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import V from './dsp/vectors/multirate.json';

const noise = (n: number, seed: number) => { let s = seed; return Array.from({ length: n }, () => { s = (s * 1664525 + 1013904223) % 2 ** 32; return s / 2 ** 31 - 1; }); };
const close = (a: readonly number[], b: readonly number[], tol = 1e-9) => { expect(a.length).toBe(b.length); a.forEach((v, i) => { if (Math.abs(v - b[i]) > tol) expect([i, v]).toEqual([i, b[i]]); }); };
const words = (n: number, w: number, seed: number) => noise(n, seed).map((v) => Math.floor(((v + 1) / 2) * (2 ** w - 1e-9)) - 2 ** (w - 1));

describe('polyphase', () => {
  const x = noise(257, 3), h = windowedSinc(33, 0.08);
  it('a decimator gives exactly what filtering and throwing away gives', () => {
    for (const R of [2, 3, 4, 8]) close(polyphaseDecimate(h, R, x), decimateDirect(h, R, x), 1e-12);
  });
  it('an interpolator gives exactly what stuffing zeros and filtering gives', () => {
    for (const L of [2, 3, 5]) close(polyphaseInterpolate(h, L, x), firFilter(h, upsample(x, L)), 1e-12);
  });
  it('matches scipy, case by case', () => {
    expect(V.cases.length).toBeGreaterThan(3);
    for (const c of V.cases) close(upfirdn(c.h, c.up, c.down, c.x), c.upfirdn, 1e-8);
  });
  it('and resample_poly, which is the same with its delay taken out and its gain scaled', () => {
    for (const c of V.cases) {
      // scipy puts zeros in front of the filter so that its middle lands on sample 0, then takes as many samples as the new rate gives
      const half = (c.h.length - 1) / 2, pad = (c.down - (half % c.down)) % c.down, len = Math.ceil((c.x.length * c.up) / c.down), want = c.resample_poly;
      expect(want.length).toBe(len);
      const padded = [...new Array<number>(pad).fill(0), ...c.h.map((v: number) => v * c.up)], y = upfirdn(padded, c.up, c.down, c.x);
      close(y.slice(Math.floor((half + pad) / c.down), Math.floor((half + pad) / c.down) + len), want, 1e-8);
    }
  });
  it('half-band: every second tap away from the middle is zero', () => {
    const t = halfBand(23), m = 11;
    t.forEach((v, i) => { if (i !== m && (i - m) % 2 === 0) expect(v).toBe(0); });
    expect(nonZero(t)).toBe(13);
    // and it is 6 dB down at a quarter of the rate, with its two sides summing to the same at every f
    expect(firGain(t, 0.25)).toBeCloseTo(0.5, 2);
  });
  it('tapsFor meets the mask it was given, and one tap fewer does not', () => {
    const { n, h } = tapsFor(0.05, 0.1, 40);
    expect(20 * Math.log10(Math.abs(firGain(h, 0.1)))).toBeLessThan(-40);
    const less = windowedSinc(n - 2, 0.075), bad = Array.from({ length: 80 }, (_, i) => 20 * Math.log10(Math.abs(firGain(less, 0.1 + (0.4 * i) / 79)) + 1e-12));
    expect(Math.max(...bad)).toBeGreaterThan(-40);
  });
});

describe('the CIC', () => {
  it('its growth is Hogenauer\'s: 16 bits at order 4, ÷ 16', () => {
    expect(cicGrowth(4, 16)).toBe(16);
    expect(V.hogenauer).toEqual({ N: 4, R: 16, bits: 16 });
    expect(cicDcGain(4, 16)).toBe(2 ** 16);
  });
  it('filters exactly as its boxcars do, with a delay of one per integrator, and wrap does no harm', () => {
    const x = words(600, 8, 7);
    for (const [N, R] of [[1, 4], [2, 4], [3, 8], [4, 16]]) {
      const w = cicWidth(N, R, 8), m = new CicModel(N, R, w), out: number[] = [];
      for (const v of x) { m.edge(v); if (m.valid) out.push(m.y); }
      const fir = firFilter(cicTaps(N, R), [...new Array<number>(N).fill(0), ...x]);
      const want = downsample(fir, R, R - 1).slice(0, out.length);
      // the registers delay by one each, and the group taken at clock R − 1 reads the last of them before that edge: N in all
      expect(out).toEqual(want.map((v) => wrapTo(v, w)));
    }
  });
  it('its response is the boxcars\' FIR response', () => {
    const t = cicTaps(4, 8);
    for (const f of [0.003, 0.01, 0.05, 0.11, 0.3]) expect(cicResponse(4, 8, f)).toBeCloseTo(Math.abs(firGain(t, f)), 9);
  });
  it('one bit short and the result is wrong; at the width it is right, at the worst-case input', () => {
    const N = 3, R = 8, wIn = 8, w = cicWidth(N, R, wIn), worst = -(2 ** (wIn - 1));
    const run = (width: number) => { const m = new CicModel(N, R, width); let y = 0; for (let i = 0; i < 300; i++) { m.edge(worst); if (m.valid) y = m.y; } return y; };
    expect(run(w)).toBe(worst * cicDcGain(N, R));
    expect(run(w - 1)).not.toBe(worst * cicDcGain(N, R));
    // the integrators wrapped all along in the good run too
    const m = new CicModel(N, R, w);
    let wraps = 0, last = 0;
    for (let i = 0; i < 300; i++) { m.edge(worst); const v = m.ints[N - 1]; if (Math.abs(v - last) > 2 ** (w - 1)) wraps++; last = v; }
    expect(wraps).toBeGreaterThan(3);
  });
  it('a higher order holds aliases further down', () => {
    expect(cicAliasDb(4, 16, 0.1)).toBeLessThan(cicAliasDb(2, 16, 0.1) - 30);
    expect(cicAliasDb(4, 16, 0.1)).toBeLessThan(-60);
  });
});

describe('the gates', () => {
  it('the CIC equals the model every clock', async () => {
    for (const [N, R, wIn] of [[2, 4, 6], [3, 8, 8]]) {
      const def = cicDecimator(N, R, wIn), sim = new BitSim(flatten(def)), w = cicWidth(N, R, wIn), m = new CicModel(N, R, w);
      for (const v of words(800, wIn, N * 11)) {
        sim.setInput('x', [wordOf(v, wIn)]);
        sim.cycle();
        m.edge(v);
        const got = [signedOf(sim.get('y', 1)[0], w), sim.get('valid', 1)[0]];
        if (got[0] !== m.y || got[1] !== (m.valid ? 1 : 0)) expect(got).toEqual([m.y, m.valid ? 1 : 0]);
      }
      await Promise.resolve();
    }
  }, 60_000);
  it('the polyphase decimator equals the model every clock, and the model equals the direct form', () => {
    const def = polyDecimator(POLY_SPEC), sim = new BitSim(flatten(def)), { R, M, w, taps } = POLY_SPEC, W = 2 * w + Math.round(Math.log2(R * M)), m = new PolyModel(POLY_SPEC);
    const x = words(1200, w, 9), out: number[] = [];
    for (const v of x) {
      sim.setInput('x', [wordOf(v, w)]);
      sim.cycle();
      m.edge(v);
      const got = [signedOf(sim.get('y', 1)[0], W), sim.get('valid', 1)[0]];
      if (got[0] !== m.y || got[1] !== (m.valid ? 1 : 0)) expect(got).toEqual([m.y, m.valid ? 1 : 0]);
      if (m.valid) out.push(m.y);
    }
    // a branch is read the clock after it loads, so each output comes a group late: from there on, plain FIR decimation
    const fir = firFilter(taps, x), want = downsample(fir, R, R - 1);
    expect(out.slice(1, 200)).toEqual(want.slice(0, 199));
    expect(taps.length).toBe(R * M);
  }, 60_000);
  it('the taps are a low-pass that passes the band and holds back what would alias', () => {
    const t = polyTaps(4, 4, 8);
    expect(t.reduce((p, q) => p + q, 0)).toBeGreaterThan(120);
    expect(Math.abs(firGain(t, 0.25))).toBeLessThan(0.6);
    expect(Math.abs(firGain(t, 0.4))).toBeLessThan(0.05);
  });
});
