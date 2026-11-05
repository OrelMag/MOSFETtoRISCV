// Converters: the models against closed forms, the identity on the loop's own error, and the gates against the model every clock.

import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { enob, flashComparators, flashConvert, idealSqnrDb, jitterLimitDb, jitterMeasuredDb, ladderErrors, ladderOutput, linearity, mismatchedWeights, sarConvert, SD_GUARD, SD_OVERLOAD, sdBitstream, sdLinearModelDb, SdLoop, sdMeasuredDb, sndrDb } from '../src/dsp/converters';
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
  it('an imperfect ladder is worst at the MSB step, and tolerances set when it stops being monotonic', () => {
    const lv = (s: number) => linearity(Array.from({ length: 256 }, (_, c) => ladderOutput(c, 8, ladderErrors(8, s, 5))));
    expect(lv(0.001).monotonic).toBe(true);
    expect(lv(0.03).monotonic).toBe(false);
    const t = lv(0.01), at = t.dnl.reduce((m, v, i) => (Math.abs(v) > Math.abs(t.dnl[m]) ? i : m), 0);
    expect(at).toBe(127);
  });
});

describe('jitter', () => {
  it('the measured limit follows −20 log(2π f σ) for any bits', () => {
    for (const [f, s] of [[1e6, 1e-9], [10e6, 1e-10], [70e6, 1e-12]] as const) expect(Math.abs(jitterMeasuredDb(f, 3.3 * f, s, 3, 16384) - jitterLimitDb(f, s))).toBeLessThan(0.5);
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
  it('each doubling of the rate gives about 9 dB at order 1 and 15 at order 2', () => {
    const gain = (o: 1 | 2) => (sdMeasuredDb(o, 128, 0.5) - sdMeasuredDb(o, 16, 0.5)) / 3;
    expect(gain(1)).toBeGreaterThan(7.5); expect(gain(1)).toBeLessThan(10.5);
    expect(gain(2)).toBeGreaterThan(13.5); expect(gain(2)).toBeLessThan(16.5);
  });
  it('the linear model has the slope and misses the level: the stated gap', () => {
    for (const osr of [32, 64, 128]) {
      const gap = sdLinearModelDb(2, osr, 0.5) - sdMeasuredDb(2, osr, 0.5);
      expect(gap).toBeGreaterThan(6); expect(gap).toBeLessThan(12);
      const gap1 = sdLinearModelDb(1, osr, 0.5) - sdMeasuredDb(1, osr, 0.5);
      expect(Math.abs(gap1)).toBeLessThan(5);
    }
  });
  it('the guard bits hold up to the overload, and past it the loop falls apart', () => {
    for (const level of [0.1, 0.5, SD_OVERLOAD]) {
      const m = new SdLoop(2, 16); let peak = 0;
      for (let i = 0; i < 60000; i++) { m.edge(Math.round(level * m.fs * Math.sin((i * 2 * Math.PI) / 1024))); peak = Math.max(peak, Math.abs(m.y1), Math.abs(m.y2)); }
      expect(peak).toBeLessThan(2 ** (m.word - 1));
    }
    expect(sdMeasuredDb(2, 64, SD_OVERLOAD)).toBeGreaterThan(60);
    expect(sdMeasuredDb(2, 64, 0.95)).toBeLessThan(25);
  });
});

describe('the gates', () => {
  it('the loop equals the model every clock, at both orders', () => {
    for (const order of [1, 2] as const) {
      const w = 12, def = sdModulator(order, w), sim = new BitSim(flatten(def)), m = new SdLoop(order, w), W = w + SD_GUARD;
      for (let i = 0; i < 6000; i++) {
        const u = Math.round(0.7 * m.fs * Math.sin(i * 0.0213) * (i % 700 < 350 ? 1 : 0.4));
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
