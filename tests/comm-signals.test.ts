// The signals chapter's models, and its FIR filter in gates against the model every cycle.

import { describe, expect, it } from 'vitest';
import {
  aliasOf, amplitudes, bandHolding, binomialGain, BLOCK, FIR_TAPS, firFilter, firGain, FirModel, measuredSqnrDb, mixed, mixedBySum, movingAverage, quantize, samplesOf, signedOf, SIGNALS, sqnrDb, windowedSinc, wordOf,
} from '../src/comm/signals';
import { FIR5, arrayMul } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { out, set, tick as clock } from './util';

const sig = (id: string) => SIGNALS.find((s) => s.id === id)!;

describe('spectra', () => {
  it('a tone reads its amplitude at its bin and nothing elsewhere', () => {
    const a = amplitudes(samplesOf(sig('two')));
    expect(a[8]).toBeCloseTo(0.7, 9);
    expect(a[40]).toBeCloseTo(0.3, 9);
    a.forEach((v, k) => { if (k !== 8 && k !== 40) expect(v).toBeLessThan(1e-9); });
  });
  it('a square wave has its odd harmonics, near 4 / πk', () => {
    const a = amplitudes(samplesOf(sig('square')));
    expect(a[8]).toBeCloseTo(4 / Math.PI, 2);
    expect(a[24]).toBeCloseTo(4 / (3 * Math.PI), 1);
    expect(a[16]).toBeLessThan(1e-9);
  });
  it('a shorter pulse takes a wider band', () => {
    const pulse = (len: number) => Array.from({ length: BLOCK }, (_, i) => (i < len ? 1 : 0));
    expect(bandHolding(pulse(4), 0.9)).toBeGreaterThan(3 * bandHolding(pulse(16), 0.9));
  });
});

describe('filters', () => {
  it('the binomial taps have the closed-form response, 1 at DC and 0 at half the sample rate', () => {
    for (const f of [0, 0.05, 0.13, 0.25, 0.4, 0.5]) expect(firGain(FIR_TAPS, f)).toBeCloseTo(binomialGain(f), 9);
    expect(firGain(FIR_TAPS, 0.5)).toBeLessThan(1e-9);
  });
  it('filtering a tone scales it by the response', () => {
    const f = 8 / BLOCK, x = Array.from({ length: BLOCK }, (_, i) => Math.sin(2 * Math.PI * f * i));
    const y = firFilter([...FIR_TAPS].map((h) => h / 16), x).slice(8);
    expect(Math.max(...y)).toBeCloseTo(firGain(FIR_TAPS, f), 2);
  });
  it('a moving average has zeros at multiples of 1 / n', () => {
    expect(firGain(movingAverage(5), 0.2)).toBeLessThan(1e-9);
    expect(firGain(movingAverage(5), 0.4)).toBeLessThan(1e-9);
  });
  it('the windowed sinc passes below its cut-off and stops well above it', () => {
    const t = windowedSinc(31, 0.1);
    expect(firGain(t, 0.05)).toBeGreaterThan(0.98);
    expect(firGain(t, 0.1)).toBeGreaterThan(0.4);
    expect(firGain(t, 0.1)).toBeLessThan(0.6);
    expect(firGain(t, 0.2)).toBeLessThan(0.01);
  });
});

describe('the filter in gates', () => {
  it('equals the model every cycle, the extremes included, and the output never overflows', () => {
    const sim = simulate(FIR5), m = new FirModel();
    set(sim, { clk: 0, x: 0 });
    sim.reset('zero');
    let seed = 12345;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) & 255; };
    const script = [127, 127, 127, 127, 127, 127, 128, 128, 128, 128, 128, 128, ...Array.from({ length: 400 }, next)];
    for (const v of script) {
      set(sim, { x: v }); clock(sim);
      m.edge(signedOf(v, 8));
      expect(signedOf(out(sim, 'y'), 12)).toBe(m.y);
    }
  });
  it('its response is the closed form on a real tone', () => {
    const sim = simulate(FIR5);
    set(sim, { clk: 0, x: 0 });
    sim.reset('zero');
    const f = 16 / BLOCK;
    const ys: number[] = [];
    for (let i = 0; i < BLOCK; i++) {
      set(sim, { x: wordOf(Math.round(100 * Math.sin(2 * Math.PI * f * i)), 8) }); clock(sim);
      ys.push(signedOf(out(sim, 'y'), 12) / 16);
    }
    expect(Math.max(...ys.slice(8)) / 100).toBeCloseTo(binomialGain(f), 2);
  });
  it('what it costs against five general multipliers', () => {
    const fir = stats(FIR5).nands, mul = stats(arrayMul(8)).nands;
    expect(fir).toBeLessThan(5 * mul);
    expect(fir).toBeGreaterThan(1000);
  });
});

describe('sampling', () => {
  it('a tone folds into the band under half the sample rate', () => {
    expect(aliasOf(3, 10)).toBe(3);
    expect(aliasOf(7, 10)).toBe(3);
    expect(aliasOf(13, 10)).toBe(3);
    expect(aliasOf(10, 10)).toBe(0);
    expect(aliasOf(5, 10)).toBe(5);
  });
  it('samples of a tone and of its alias are the same numbers', () => {
    for (let i = 0; i < 20; i++) expect(Math.cos(2 * Math.PI * 7 * i / 10)).toBeCloseTo(Math.cos(2 * Math.PI * 3 * i / 10), 9);
  });
  it('quantizing costs about 6 dB a bit, measured against the closed form', () => {
    for (const b of [4, 8, 12]) expect(Math.abs(measuredSqnrDb(b) - sqnrDb(b))).toBeLessThan(0.6);
  });
  it('the quantizer stays in range', () => {
    for (const x of [-2, -1, 0, 1, 2]) expect(Math.abs(quantize(x, 4))).toBeLessThan(1);
  });
  it('a mixer gives the sum and the difference', () => {
    for (let i = 0; i < 40; i++) expect(mixed(3, 11, i / 37)).toBeCloseTo(mixedBySum(3, 11, i / 37), 9);
    const a = amplitudes(Array.from({ length: BLOCK }, (_, i) => mixed(8, 40, i / BLOCK)));
    expect(a[32]).toBeCloseTo(0.5, 9);
    expect(a[48]).toBeCloseTo(0.5, 9);
    expect(a[8]).toBeLessThan(1e-9);
  });
});
