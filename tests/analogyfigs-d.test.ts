import { describe, expect, it } from 'vitest';
import { SR_LATCH, counter } from '../src/lib/sequential';
import { evalOnce, simulate } from '../src/sim/harness';
import { flatten } from '../src/sim/flatten';
import { analyzeTiming, SETUP } from '../src/sim/timing';
import {
  beat, counterPlayers, expectedHistogram, FORBIDDEN, histogram, mulberry32, rollBoth, rollOne, slowestNeed,
  SR_POWER_ON, srSettle, TIE_BREAK_P, type Say,
} from '../src/widgets/analogy/storage';

describe('disagree: two NANDs holding hands', () => {
  it('the bubbles follow the library SR latch through set, release, reset, release', () => {
    const sim = simulate(SR_LATCH);
    let st: Say = SR_POWER_ON;
    for (const [sn, rn] of [[0, 1], [1, 1], [1, 0], [1, 1], [0, 1], [1, 1]]) {
      st = srSettle(st, sn, rn).final;
      const [q, qn] = evalOnce(sim, [sn, rn]);
      expect([st.a, st.b]).toEqual([q, qn]);
    }
  });
  it('a shout makes the other answer the opposite, and it holds after release', () => {
    const set = srSettle(SR_POWER_ON, 0, 1);
    expect(set.final).toEqual({ a: 1, b: 0 });
    expect(set.frames.length).toBe(3); // start, both yes, settled
    expect(set.frames[1]).toEqual({ a: 1, b: 1 });
    expect(srSettle(set.final, 1, 1)).toMatchObject({ final: { a: 1, b: 0 }, ringing: false });
    expect(srSettle(set.final, 1, 0).final).toEqual({ a: 0, b: 1 });
  });
});

describe('hilltop: releasing both', () => {
  it('both held low says yes / yes, as the library part does', () => {
    const sim = simulate(SR_LATCH);
    expect(evalOnce(sim, [0, 0])).toEqual([FORBIDDEN.a, FORBIDDEN.b]);
    expect(srSettle(SR_POWER_ON, 0, 0).final).toEqual(FORBIDDEN);
  });
  it('releasing both rings in the model and is flagged a race by GateSim; releasing one is not', () => {
    const r = srSettle(FORBIDDEN, 1, 1);
    expect(r.ringing).toBe(true);
    expect(r.frames.slice(0, 3)).toEqual([{ a: 1, b: 1 }, { a: 0, b: 0 }, { a: 1, b: 1 }]);
    const sim = simulate(SR_LATCH);
    evalOnce(sim, [0, 0]);
    evalOnce(sim, [1, 1]);
    expect(sim.unstable).toBe(true);
    // releasing only reset: set still shouting, decided: q = 1
    expect(srSettle(FORBIDDEN, 0, 1)).toMatchObject({ final: { a: 1, b: 0 }, ringing: false });
    expect(rollOne('s').valley).toBe(1);
    const sim2 = simulate(SR_LATCH);
    evalOnce(sim2, [0, 0]);
    expect(evalOnce(sim2, [0, 1])).toEqual([1, 0]);
    expect(sim2.unstable).toBe(false);
    expect(srSettle(FORBIDDEN, 1, 0).final).toEqual({ a: 0, b: 1 });
    expect(rollOne('r').valley).toBe(0);
  });
  it('the wait is geometric with the stated chance and the seeded runs are repeatable', () => {
    expect(TIE_BREAK_P).toBe(0.5);
    const rolls = (seed: number, n: number) => { const g = mulberry32(seed); return Array.from({ length: n }, () => rollBoth(g)); };
    expect(rolls(5, 50)).toEqual(rolls(5, 50));
    const big = rolls(11, 20000);
    const hist = histogram(big, 8);
    const exp = expectedHistogram(20000, 8);
    expect(hist.reduce((a, b) => a + b, 0)).toBe(20000);
    exp.forEach((e, i) => expect(Math.abs(hist[i] - e)).toBeLessThan(0.06 * 20000 * 0.5 + 1));
    expect(exp.reduce((a, b) => a + b, 0)).toBeCloseTo(20000, 6);
    expect(exp[1] / exp[0]).toBeCloseTo(0.5, 9); // each delay halves the chance it is still up
    const ones = big.filter((r) => r.valley).length;
    expect(ones / 20000).toBeGreaterThan(0.48);
    expect(ones / 20000).toBeLessThan(0.52);
    expect(Math.min(...big.map((r) => r.delays))).toBe(1);
  });
});

describe('orchestra: a register is a row of flip-flops', () => {
  it('each bit of the 4-bit counter is ready 2 delays after the one below, and the slowest sets the period', () => {
    const ps = counterPlayers();
    expect(ps.map((p) => p.bit)).toEqual([0, 1, 2, 3]);
    expect(ps.map((p) => p.ready)).toEqual([8, 10, 12, 14]);
    expect(ps.map((p) => p.need)).toEqual([8 + SETUP, 10 + SETUP, 12 + SETUP, 14 + SETUP]);
    expect(slowestNeed(ps)).toBe(17);
    expect(analyzeTiming(flatten(counter(4)))!.period).toBe(slowestNeed(ps));
  });
  it('at the slowest need the count steps; below it the late bits keep their old value', () => {
    let q = 0;
    for (let i = 1; i <= 20; i++) { const r = beat(q, 17); expect(r.late).toEqual([]); q = r.q; expect(q).toBe(i & 15); }
    // 0111 -> 1000 at period 14: needs are 11, 13, 15, 17, so bits 2 and 3 miss the beat and keep 1 and 0
    expect(beat(7, 14)).toEqual({ q: 0b0100, late: [2, 3] });
    expect(beat(0, 14)).toEqual({ q: 1, late: [] }); // nothing the late bits had to change
    expect(beat(7, 10)).toEqual({ q: 0b0111, late: [0, 1, 2, 3] });
  });
});
