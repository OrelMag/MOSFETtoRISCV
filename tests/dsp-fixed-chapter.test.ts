// What "Numbers that fit" claims, on its models and gates.
import { describe, expect, it } from 'vitest';
import { chFixed } from '../src/chapters/ch-dsp-fixed';
import { chainSnr, overflowRun, roundingRun, runningSum } from '../src/dsp/fixeddemos';
import { wrapTo } from '../src/dsp/fixed';
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
  it('the try box: up first does fall below down first by the top of the slider', () => {
    expect(chainSnr(1, 3, 16, 'up first')).toBeLessThan(chainSnr(1, 3, 16, 'down first'));
  });
});

describe('the text', () => {
  it('every step has words and something to do', () => {
    for (const s of chFixed.steps) { expect(s.body.length, s.title).toBeGreaterThan(300); expect(!!s.widget || !!s.scene, s.title).toBe(true); expect(s.challenge, s.title).toBeTruthy(); }
  });
});
