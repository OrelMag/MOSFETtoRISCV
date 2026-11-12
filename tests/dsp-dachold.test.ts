import { describe, expect, it } from 'vitest';
import { butterDb, butterOrder, CD, dacRow, holdDb, linesOf, measuredHold } from '../src/dsp/dachold';

describe('the DAC hold (converters, "The way out: hold and smooth")', () => {
  it('a staircase\'s spectrum is the tone and its images under sin x / x: closed form against an FFT', () => {
    const n = 256, over = 64;
    for (const cycles of [13, 40, 77, 115]) {
      const f = cycles / n, at = [f, 1 - f, 1 + f, 2 - f, 2 + f, 3 - f];
      const got = measuredHold(n, cycles, over, at);
      at.forEach((g, i) => expect(got[i], `${cycles} cycles, line at ${g}`).toBeCloseTo(holdDb(g, 1), 1));
    }
  });

  it('droop: −0.91 dB at a quarter of the rate, −3.92 dB at half', () => {
    expect(holdDb(0.25, 1)).toBeCloseTo(-0.91, 2);
    expect(holdDb(0.5, 1)).toBeCloseTo(-3.92, 2);
  });

  it('the tone and its images, in order', () => {
    expect(linesOf(0.3, 1, 2.5).map((l) => +l.f.toFixed(2))).toEqual([0.3, 0.7, 1.3, 1.7, 2.3]);
  });

  it('the table: CD audio needs order 59 at its own rate, 9, 5 and 3 when oversampled 2, 4 and 8 times', () => {
    const rows = [1, 2, 4, 8].map((L) => dacRow(L));
    expect(rows.map((r) => r.order)).toEqual([59, 9, 5, 3]);
    expect(rows[0].droopDb).toBeCloseTo(-3.17, 2);
    expect(rows[0].image).toBe(24_100);
    expect(rows[0].imageRelDb).toBeCloseTo(-1.6, 1);
    expect(rows[2].image).toBe(4 * CD.fs - CD.band);
    // the order found is the smallest that reaches the need
    for (const r of rows) {
      expect(-butterDb(r.image, CD.band, r.order)).toBeGreaterThanOrEqual(r.needDb);
      expect(-butterDb(r.image, CD.band, r.order - 1)).toBeLessThan(r.needDb);
    }
    expect(butterOrder(0, 1, 1)).toBe(0);
  });
});
