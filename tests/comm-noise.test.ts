// The noise chapter's closed forms against seeded Monte Carlo, and the published constants.

import { describe, expect, it } from 'vitest';
import { shannonBinaryDb, uncodedBer } from '../src/comm/ber';
import { dbToRatio, EBN0_MIN, ratioToDb } from '../src/comm/limits';
import {
  capacityAt, capacityCeiling, receiverFloorDbm, cascadeNfDb, decisionError, energyOf, errorAfter, johnsonVolts, measuredBer, measuredDecision, measuredReceiver, noiseDensityDbm, noiseFloorDbm, PULSES, randomCodeError, RECEIVERS, snrAfter,
} from '../src/comm/noise';

describe('thermal noise', () => {
  it('is the −174 dBm / Hz every link budget uses', () => {
    expect(noiseDensityDbm()).toBeCloseTo(-173.98, 1);
    expect(noiseFloorDbm(20e6, 6)).toBeCloseTo(-173.98 + 73.01 + 6, 1);
  });
  it('a noise figure is against a 290 K source: at 290 K the two forms agree, and cooling only the source then gains little', () => {
    expect(receiverFloorDbm(20e6, 6)).toBeCloseTo(noiseFloorDbm(20e6, 6), 9);
    expect(receiverFloorDbm(20e6, 6) - receiverFloorDbm(20e6, 6, 4)).toBeCloseTo(1.2, 1);
    expect(receiverFloorDbm(20e6, 0) - receiverFloorDbm(20e6, 0, 4)).toBeCloseTo(18.6, 1);
  });
  it('a 1 kΩ resistor over 1 Hz is about 4 nV', () => {
    expect(johnsonVolts(1000, 1) * 1e9).toBeCloseTo(4.0, 0);
  });
  it('four times the band or the resistance is twice the voltage', () => {
    expect(johnsonVolts(50, 4e6) / johnsonVolts(50, 1e6)).toBeCloseTo(2, 9);
    expect(johnsonVolts(200, 1e6) / johnsonVolts(50, 1e6)).toBeCloseTo(2, 9);
  });
});

describe('a decision', () => {
  it('the Gaussian tail against counted errors', () => {
    for (const sigma of [0.3, 0.5, 0.8]) {
      const want = decisionError(1, sigma);
      expect(measuredDecision(sigma, 400_000, 7)).toBeCloseTo(want, want < 0.01 ? 3 : 2);
    }
  });
  it('uncoded BER at Eb/N0 against counted errors', () => {
    for (const db of [0, 4, 7]) {
      const want = uncodedBer(db);
      expect(measuredBer(db, 1_000_000, 11)).toBeCloseTo(want, want < 0.01 ? 3 : 2);
    }
  });
});

describe('the matched filter', () => {
  const sigma = 1.5;
  for (const p of PULSES) {
    it(`${p.name}: weighing by the pulse gives E / σ², and no other receiver beats it`, () => {
      const [one, avg, match] = RECEIVERS.map((r) => snrAfter(p.shape, r.weights(p.shape), sigma));
      expect(match).toBeCloseTo(energyOf(p.shape) / (sigma * sigma), 9);
      expect(match).toBeGreaterThanOrEqual(avg - 1e-9);
      expect(match).toBeGreaterThan(one);
    });
    it(`${p.name}: each receiver's error rate is its SNR's, counted`, () => {
      for (const r of RECEIVERS) {
        const w = r.weights(p.shape), want = errorAfter(snrAfter(p.shape, w, sigma));
        expect(measuredReceiver(p.shape, w, sigma, 60_000, 21)).toBeCloseTo(want, 2);
      }
    });
  }
  it('on a rectangle averaging is the matched filter', () => {
    const p = PULSES[0].shape;
    expect(snrAfter(p, RECEIVERS[1].weights(p), 1)).toBeCloseTo(snrAfter(p, RECEIVERS[2].weights(p), 1), 9);
  });
});

describe('a chain', () => {
  it('the first stage sets it: an amplifier first hides the lossy cable behind it', () => {
    const lna = { name: 'amplifier', gainDb: 20, nfDb: 1 }, cable = { name: 'cable', gainDb: -10, nfDb: 10 };
    const good = cascadeNfDb([lna, cable]), bad = cascadeNfDb([cable, lna]);
    expect(good).toBeLessThan(1.5);
    expect(bad).toBeCloseTo(11, 5);
  });
  it('one stage is its own figure', () => {
    expect(cascadeNfDb([{ name: 'a', gainDb: 10, nfDb: 3 }])).toBeCloseTo(3, 9);
  });
});

describe('Shannon', () => {
  it('more band stops helping: capacity tends to P / (N0 ln 2)', () => {
    const c = capacityCeiling(1e6);
    expect(capacityAt(1e6, 1e9)).toBeLessThan(c);
    expect(capacityAt(1e6, 1e9) / c).toBeGreaterThan(0.999);
    expect(capacityAt(1e6, 1e6) / c).toBeCloseTo(Math.LN2, 9);
  });
  it('so Eb/N0 cannot go below ln 2, −1.59 dB', () => {
    expect(ratioToDb(EBN0_MIN)).toBeCloseTo(-1.59, 2);
    expect(dbToRatio(-1.59)).toBeCloseTo(Math.LN2, 3);
  });
  it('random codes: longer ones get better above the limit, and the limit is real below it', () => {
    const limit = shannonBinaryDb(0.5);
    expect(limit).toBeCloseTo(0.19, 1);
    const at = (n: number, db: number) => randomCodeError(n, n / 2, db, 400, n * 100 + Math.round(db * 10));
    // well above the limit a longer random code is better
    expect(at(20, 6)).toBeLessThan(at(8, 6));
    // far below it a longer code is worse, not better
    expect(at(20, -3)).toBeGreaterThan(at(8, -3));
  });
  it('the curves cross within about a dB of the limit, as the chapter says', () => {
    const at = (n: number, db: number) => randomCodeError(n, n / 2, db, 3000, n * 31 + Math.round(db * 10) + 5);
    expect(at(20, 0)).toBeGreaterThan(at(8, 0));
    expect(at(20, 2)).toBeLessThan(at(8, 2));
  });
});
