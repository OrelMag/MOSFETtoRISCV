// Converters: the models against closed forms, the identity on the loop's own error, and the gates against the model every clock.

import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { enob, flashComparators, flashConvert, idealSqnrDb, jitterHolds, jitterLimitDb, jitterMeasuredDb, ladderErrors, ladderOutput, linearity, mismatchedWeights, sarConvert, SD_GUARD, SD_LIMIT, sdBitstream, sdErrorPower, sdLinearModelDb, SdLoop, sdMeasuredDb, sdPeak, sndrDb } from '../src/dsp/converters';
import { CicModel, cicWidth } from '../src/dsp/multirate';
import { sdConverter, sdModulator } from '../src/lib/sigmadelta';
import { chainEnob } from '../src/widgets/dspconverters';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';

describe('what a converter is judged by', () => {
  it('a rounded sine measures what 6.02 b + 1.76 says', () => {
    const n = 4096, k = 67;
    for (const bits of [8, 10, 12]) {
      const q = 2 ** (bits - 1) - 1, x = Array.from({ length: n }, (_, i) => Math.round(q * Math.sin((2 * Math.PI * k * i) / n)) / q);
      expect(Math.abs(sndrDb(x, k) - idealSqnrDb(bits))).toBeLessThan(1.5);
      expect(Math.abs(enob(sndrDb(x, k)) - bits)).toBeLessThan(0.25);
    }
  });
});

describe('flash, SAR and a ladder', () => {
  it('flash and SAR give the ideal code, and flash pays in comparators', () => {
    for (const v of [-0.97, -0.3, 0, 0.21, 0.5, 0.99]) {
      const want = Math.floor(((v + 1) / 2) * 256);
      expect(flashConvert(v, 8)).toBe(want);
      expect(sarConvert(v, 8).code).toBe(want);
    }
    expect(flashComparators(8)).toBe(255);
    expect(sarConvert(0.1, 8).steps).toHaveLength(8);
  });
  it('a mismatched MSB makes a SAR miss codes', () => {
    const levels = new Set<number>();
    const w = mismatchedWeights(8, 0.02, 3);
    for (let i = 0; i < 4000; i++) levels.add(sarConvert(-1 + (2 * i) / 4000, 8, w).code);
    expect(levels.size).toBeLessThan(256);
    const ideal = new Set<number>();
    for (let i = 0; i < 4000; i++) ideal.add(sarConvert(-1 + (2 * i) / 4000, 8).code);
    expect(ideal.size).toBe(256);
  });
  it('an ideal ladder steps by exactly 2^−bits, solved from its nodes', () => {
    for (let c = 0; c < 256; c++) expect(ladderOutput(c, 8)).toBeCloseTo(c / 256, 12);
    expect(linearity(Array.from({ length: 256 }, (_, c) => ladderOutput(c, 8))).worstDnl).toBeLessThan(1e-9);
  });
  it('an imperfect ladder is usually worst at the MSB step, some 2 LSBs at 1 %, and tolerances set when it stops being monotonic', () => {
    const lv = (s: number, seed = 5) => linearity(Array.from({ length: 256 }, (_, c) => ladderOutput(c, 8, ladderErrors(8, s, seed))));
    expect(lv(0.001).monotonic).toBe(true);
    expect(lv(0.03).monotonic).toBe(false);
    let atMiddle = 0; const worst: number[] = [];
    for (let seed = 1; seed <= 200; seed++) { const t = lv(0.01, seed); if (t.dnl.reduce((m, v, i) => (Math.abs(v) > Math.abs(t.dnl[m]) ? i : m), 0) === 127) atMiddle++; worst.push(Math.abs(t.dnl[127])); }
    expect(atMiddle).toBeGreaterThan(100);
    const median = worst.sort((a, b) => a - b)[100];
    expect(median).toBeGreaterThan(1.2); expect(median).toBeLessThan(2.8);
  });
});

describe('jitter', () => {
  it('the measured limit follows −20 log(2π f σ) for any bits', () => {
    for (const [f, s] of [[1e6, 1e-9], [10e6, 1e-10], [70e6, 1e-12]] as const) expect(Math.abs(jitterMeasuredDb(f, 3.3 * f, s, 3, 16384) - jitterLimitDb(f, s))).toBeLessThan(0.5);
  });
  it('the formula holds as far as the widget quotes it, and not where it refuses', () => {
    const atEdge = 10 ** (-10 / 20) / (2 * Math.PI * 1e7);
    expect(jitterHolds(1e7, atEdge * 0.99)).toBe(true);
    expect(Math.abs(jitterMeasuredDb(1e7, 3.3e7, atEdge * 0.99, 3, 16384) - 10)).toBeLessThan(1);
    expect(jitterHolds(1e9, 1e-8)).toBe(false);
    expect(jitterLimitDb(1e9, 1e-8) - jitterMeasuredDb(1e9, 3.3e9, 1e-8, 3, 16384)).toBeLessThan(-20);
  });
});

describe('the loop', () => {
  it('its output is z⁻¹U + (1 − z⁻¹)^N E, exactly, on the error it recorded', () => {
    for (const order of [1, 2] as const) {
      const m = new SdLoop(order, 12), us: number[] = [], es: number[] = [], vs: number[] = [];
      for (let i = 0; i < 3000; i++) {
        const u = Math.round(0.5 * m.fs * Math.sin(i * 0.031));
        const b = m.decide, v = b ? m.fs : -m.fs;
        m.edge(u);
        us.push(u); es.push(m.e); vs.push(v);
      }
      for (let i = 4; i < vs.length; i++) {
        const shaped = order === 1 ? es[i] - es[i - 1] : es[i] - 2 * es[i - 1] + es[i - 2];
        expect(vs[i]).toBe(us[i - 1] + shaped);
      }
    }
  });
  it('the average of the bits is the input', () => {
    const b = sdBitstream(2, 8192, 0, 0);
    expect(Math.abs(b.reduce((a, v) => a + v, 0) / 8192)).toBeLessThan(0.01);
    const m = new SdLoop(2, 12); let sum = 0;
    for (let i = 0; i < 8192; i++) { m.edge(Math.round(0.3 * m.fs)); sum += m.bit ? 1 : -1; }
    expect(sum / 8192).toBeCloseTo(0.3, 2);
  });
  it('each doubling of the rate gives what the chapter says: order 2 from 13 to 16 dB, order 1 from 6 to 11', () => {
    const rates = [16, 32, 64, 128, 256], steps = (o: 1 | 2) => rates.slice(1).map((r, i) => sdMeasuredDb(o, r, 0.5) - sdMeasuredDb(o, rates[i], 0.5));
    for (const g of steps(2)) { expect(g).toBeGreaterThan(12.5); expect(g).toBeLessThan(16.5); }
    for (const g of steps(1)) { expect(g).toBeGreaterThan(5.5); expect(g).toBeLessThan(11); }
  });
  it('the linear model has the slope, and the measured error power closes most of its gap', () => {
    expect(sdLinearModelDb(2, 64, 0.5)).toBeCloseTo(1.76 + 20 * Math.log10(0.5) - 10 * Math.log10(Math.PI ** 4 / 5) + 50 * Math.log10(64), 2);
    const pw = sdErrorPower(2, 0.5);
    expect(pw).toBeGreaterThan(0.45); expect(pw).toBeLessThan(0.65);
    expect(Math.abs(sdErrorPower(1, 0.5) - 1 / 3)).toBeLessThan(0.03);
    for (const osr of [32, 64, 128]) {
      const got = sdMeasuredDb(2, osr, 0.5), gap = sdLinearModelDb(2, osr, 0.5) - got, left = sdLinearModelDb(2, osr, 0.5, pw) - got;
      expect(gap).toBeGreaterThan(1.5); expect(gap).toBeLessThan(6);
      expect(Math.abs(left)).toBeLessThan(Math.abs(gap));
      expect(Math.abs(left)).toBeLessThan(3);
    }
  });
  it('the guard bits hold the peak up to the limit, tones and a steady input alike, and three would not', () => {
    for (const level of [0.5, 0.8, SD_LIMIT]) expect(sdPeak(2, level)).toBeLessThan(2 ** SD_GUARD);
    expect(sdPeak(2, 0.8)).toBeGreaterThan(8);
    expect(sdPeak(2, SD_LIMIT)).toBeGreaterThan(16);
    for (const osr of [64, 256]) expect(sdMeasuredDb(2, osr, 0.8)).toBeGreaterThan(55);
  });
  it('a hard step is worse than a tone: the square wave the chapter names reaches the wrap', () => {
    class Wide extends SdLoop { override get word() { return 44; } }
    const peak = (level: number, per = 1500) => { const m = new Wide(2, 16); let p = 0; for (let i = 0; i < 120000; i++) { m.edge(Math.round(level * m.fs * (i % per < per / 2 ? 1 : -1))); p = Math.max(p, Math.abs(m.y1), Math.abs(m.y2)); } return p / m.fs; };
    for (const per of [100, 300, 1000, 1500, 3000, 10000]) expect(peak(0.8, per)).toBeLessThan(2 ** SD_GUARD);
    expect(peak(0.85, 3000)).toBeGreaterThan(2 ** SD_GUARD);
  });
  it('the measure falls near the top, and nothing wraps to cause it', () => {
    expect(sdMeasuredDb(2, 64, SD_LIMIT)).toBeLessThan(sdMeasuredDb(2, 64, 0.5) - 10);
    expect(sdMeasuredDb(2, 64, SD_LIMIT)).toBeGreaterThan(40);
  });
});

describe('the gates', () => {
  it('the loop equals the model every clock, at both orders', () => {
    for (const order of [1, 2] as const) {
      const w = 12, def = sdModulator(order, w), sim = new BitSim(flatten(def)), m = new SdLoop(order, w), W = w + SD_GUARD;
      for (let i = 0; i < 6000; i++) {
        const u = Math.round(SD_LIMIT * m.fs * Math.sin(i * 0.0213) * (i % 700 < 350 ? 1 : 0.4));
        sim.setInput('u', [wordOf(u, w)]);
        sim.cycle();
        m.edge(u);
        const got = [sim.get('bit', 1)[0], signedOf(sim.get('y1', 1)[0], W), order === 2 ? signedOf(sim.get('y2', 1)[0], W) : 0];
        if (got[0] !== m.bit || got[1] !== m.y1 || got[2] !== m.y2) expect([i, ...got]).toEqual([i, m.bit, m.y1, m.y2]);
      }
    }
  }, 60_000);
  it('the whole converter equals the loop feeding the CIC, every clock', () => {
    const w = 12, N = 3, R = 32, def = sdConverter(2, w, N, R), sim = new BitSim(flatten(def)), m = new SdLoop(2, w), c = new CicModel(N, R, cicWidth(N, R, 2));
    for (let i = 0; i < 8000; i++) {
      const u = Math.round(0.5 * m.fs * Math.sin(i * 0.004));
      sim.setInput('u', [wordOf(u, w)]);
      sim.cycle();
      // the CIC takes the bit the loop's register held before this edge
      c.edge(m.bit ? 1 : -1);
      m.edge(u);
      const got = [signedOf(sim.get('y', 1)[0], cicWidth(N, R, 2)), sim.get('valid', 1)[0]];
      if (got[0] !== c.y || got[1] !== (c.valid ? 1 : 0)) expect([i, ...got]).toEqual([i, c.y, c.valid ? 1 : 0]);
    }
  }, 60_000);
});

describe('what the chapter says of the chain', () => {
  it('its effective bits, at each rate it names', () => {
    expect(chainEnob(64)).toBeGreaterThan(11.5); expect(chainEnob(64)).toBeLessThan(13);
    expect(chainEnob(256)).toBeGreaterThan(16);
    expect(chainEnob(128) - chainEnob(64)).toBeGreaterThan(2);
  });
  it('the chapter\'s rough sums', () => {
    expect(mismatchedWeights(8, 0, 1)[0]).toBe(0.5);
    expect(0.01 * 0.5 * 256).toBeCloseTo(1.28, 9); // a 1 % error in the MSB, in codes
    expect(jitterLimitDb(1e6, 1e-12)).toBeCloseTo(104, 0);
    expect(jitterLimitDb(1e8, 1e-12)).toBeCloseTo(64, 0);
  });
});
