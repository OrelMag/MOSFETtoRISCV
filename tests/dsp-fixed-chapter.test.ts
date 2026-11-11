// What "Numbers that fit" claims, on its models and gates.
import { describe, expect, it } from 'vitest';
import { chFixed } from '../src/chapters/ch-dsp-fixed';
import { chainSnr, overflowRun, roundingRun, runningSum } from '../src/dsp/fixeddemos';
import { bitsToHold, wrapTo } from '../src/dsp/fixed';
import { SAT_W, SUM_SETS } from '../src/widgets/dspfixed';
import { fracMultiplier, satAdder } from '../src/lib/fixedpt';
import { evalOnce, simulate } from '../src/sim/harness';

describe('wrap or saturate', () => {
  it('at +6 dB and 16 bits: wrap is worst, saturate better, scaling far better', () => {
    const w = overflowRun(6, 16, 'wrap').snrDb, s = overflowRun(6, 16, 'sat').snrDb, c = overflowRun(6, 16, 'scale');
    expect(w).toBeLessThan(0); expect(s).toBeGreaterThan(w + 10); expect(c.snrDb).toBeGreaterThan(90);
    expect(c.shift).toBe(1);
  });
  it('below full scale wrap and saturate are the same', () => {
    const a = overflowRun(-6, 16, 'wrap'), b = overflowRun(-6, 16, 'sat');
    expect(a.overShare).toBe(0); expect(a.snrDb).toBeCloseTo(b.snrDb, 9);
  });
  it('the try box: at 6 bits scaling starts to beat saturating at +2 dB', () => {
    expect(overflowRun(1, 6, 'sat').snrDb).toBeGreaterThan(overflowRun(1, 6, 'scale').snrDb);
    expect(overflowRun(2, 6, 'scale').snrDb).toBeGreaterThan(overflowRun(2, 6, 'sat').snrDb);
    expect(overflowRun(0, 6, 'scale').shift).toBe(0);
    expect(overflowRun(1, 6, 'scale').shift).toBe(1);
  });
  it('a shorter word scaled down loses to rounding: each bit about 6 dB', () => {
    const d = overflowRun(0, 12, 'scale').snrDb - overflowRun(0, 8, 'scale').snrDb;
    expect(d).toBeGreaterThan(22); expect(d).toBeLessThan(26);
  });
});

describe('the challenges', () => {
  it('100 + 100 stops at 127, with sat', () => {
    expect(evalOnce(simulate(satAdder(SAT_W)), [100, 100])).toEqual([127, 1]);
  });
  it('the try box: −100 + −100 stops at −128', () => {
    const [y, sat] = evalOnce(simulate(satAdder(SAT_W)), [156, 156]);
    expect(wrapTo(y, 8)).toBe(-128); expect(sat).toBe(1);
  });
  it('96 × 64 reads 48; only 128 × 128 lights sat', () => {
    const sim = simulate(fracMultiplier(SAT_W));
    expect(evalOnce(sim, [96, 64])).toEqual([48, 0]);
    expect(evalOnce(sim, [128, 128])).toEqual([127, 1]);
    expect(evalOnce(sim, [128, 129])[1]).toBe(0);
  });
});

describe('rounding', () => {
  it('over the whole slider, ties to even stays nearest zero', () => {
    for (let s = 1; s <= 6; s++) {
      const t = Math.abs(roundingRun('trunc', s).mean), c = Math.abs(roundingRun('convergent', s).mean);
      expect(c, `${s} bits`).toBeLessThan(t);
      expect(c, `${s} bits`).toBeLessThan(1);
    }
  });
  it('truncation drifts; ties to even barely; the variance hardly moves', () => {
    const t = roundingRun('trunc', 3), u = roundingRun('half-up', 3), c = roundingRun('convergent', 3);
    expect(t.mean).toBeLessThan(-3); expect(Math.abs(u.mean)).toBeLessThan(1); expect(Math.abs(c.mean)).toBeLessThan(0.3);
    expect(Math.abs(t.variance - c.variance) / c.variance).toBeLessThan(0.1);
    expect(Math.abs(t.drift.at(-1)!)).toBeGreaterThan(5 * Math.abs(c.drift.at(-1)!));
  });
});

describe('a running sum', () => {
  it('the first two sets fit at the end, and wrapping gets them right where saturating does not', () => {
    for (const s of SUM_SETS.slice(0, 2)) {
      const r = runningSum(s.xs, 8), t = r.truth.at(-1)!;
      expect(Math.abs(t)).toBeLessThan(128);
      expect(r.wrapped.at(-1), s.name).toBe(t);
      expect(r.clamped.at(-1), s.name).not.toBe(t);
      expect(Math.max(...r.truth.map(Math.abs)), 'it does stray past the word').toBeGreaterThan(127);
    }
  });
  it('the third does not fit in 8 bits, and does within the slider', () => {
    const s = SUM_SETS[2].xs, t = runningSum(s, 8).truth.at(-1)!;
    expect(t).toBeGreaterThan(127);
    expect(runningSum(s, 8).wrapped.at(-1)).not.toBe(t);
    expect(bitsToHold(t)).toBe(10);
    expect(runningSum(s, 10).wrapped.at(-1)).toBe(t);
    const r = runningSum(s, 11);
    expect(r.wrapped.at(-1)).toBe(t); expect(r.clamped.at(-1)).toBe(t);
  });
});

describe('where the gain goes', () => {
  it('at a tenth of full scale up first is the word alone; down first loses about 6 dB a bit', () => {
    const alone = chainSnr(0.1, 0, 16, 'up first'), up = chainSnr(0.1, 3, 16, 'up first'), down = chainSnr(0.1, 3, 16, 'down first');
    expect(up).toBeCloseTo(alone, 6);
    expect(alone - down).toBeGreaterThan(15); expect(alone - down).toBeLessThan(21);
  });
  it('the try box: up first falls below down first where the peak passes full scale, at −18 dBFS with a 3-bit shift', () => {
    const at = (db: number, o: 'up first' | 'down first') => chainSnr(10 ** (db / 20), 3, 16, o);
    expect(at(-19, 'up first')).toBeGreaterThan(at(-19, 'down first'));
    expect(at(-18, 'up first')).toBeLessThan(at(-18, 'down first'));
  });
});

describe('the text', () => {
  it('every step has words and something to do', () => {
    for (const s of chFixed.steps) { expect(s.body.length, s.title).toBeGreaterThan(300); expect(!!s.widget || !!s.scene, s.title).toBe(true); expect(s.challenge, s.title).toBeTruthy(); }
  });
});

describe('dynamic range and the two truncations (steps "A word and its point" and "Rounding")', () => {
  it('6.02 dB a bit; 16 bits: 96.3 dB over the span, 90.3 dB from one step to full scale; a full-scale sine 98.1 dB', () => {
    expect((20 * Math.log10(2)).toFixed(2)).toBe('6.02');
    expect((20 * Math.log10(2 ** 16)).toFixed(1)).toBe('96.3');
    expect((20 * Math.log10(2 ** 15)).toFixed(1)).toBe('90.3');
    expect((6.02 * 16 + 1.76).toFixed(1)).toBe('98.1');
    // the 1.76: a full-scale sine's power over step^2 / 12 is (3/2) 2^(2b); measured on 16 bits
    expect(10 * Math.log10(1.5)).toBeCloseTo(1.76, 2);
  });
  it('an arithmetic shift floors, C division truncates toward zero', () => {
    expect([-3 >> 1, Math.trunc(-3 / 2), 3 >> 1, Math.trunc(3 / 2)]).toEqual([-2, -1, 1, 1]);
    // the shift-and-add C compilers use for x / 2^s: add 2^s - 1 to negative x first
    for (let x = -64; x <= 64; x++) expect((x + (x < 0 ? 3 : 0)) >> 2).toBe(Math.trunc(x / 4) + 0);
  });
  it('Qa.b x Qc.d = Q(a+c).(b+d): Q1.7 x Q1.7 is 16 bits with 14 after the point', () => {
    const p = 96 * 64; // 0.75 x 0.5 in Q1.7
    expect(p / 2 ** 14).toBe(0.375);
  });
});
