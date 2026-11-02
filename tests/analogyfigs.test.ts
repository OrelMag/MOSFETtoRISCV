import { describe, expect, it } from 'vitest';
import { airlockEdge, airlockSetD, airlockStart, bucketRun, decay, deltaMv, laundry, refreshLevel, senseRead, DRAM_OFFSET_MV, DRAM_SHARE } from '../src/widgets/analogy/model';

describe('bucket figure', () => {
  it('matches the step text: 2 inputs = 5 fF, about 21 ps, 16 fJ', () => {
    const r = bucketRun(2);
    expect(r.cLoad).toBe(5);
    expect(Math.round(r.t50)).toBe(21);
    expect(Math.round(r.energy)).toBe(16);
  });
  it('twice the load is about twice the delay', () => {
    expect(bucketRun(6).t50).toBeGreaterThan(bucketRun(3).t50 * 1.7);
    expect(bucketRun(2).fill[0]).toBe(0);
    expect(bucketRun(2).fill.at(-1)!).toBeGreaterThan(0.95);
  });
});

describe('airlock figure', () => {
  const last = (s: ReturnType<typeof airlockStart>, rising: boolean) => airlockEdge(s, rising).at(-1)!;
  it('Q copies D at the rising edge only, and the doors are never both open', () => {
    let s = airlockSetD(airlockStart(), true);
    expect(s.master).toBe(true);
    expect(s.q).toBe(false);
    const ph = airlockEdge(s, true);
    for (const p of ph) expect(p.outer && p.inner).toBe(false);
    s = ph.at(-1)!;
    expect(s.q).toBe(true);
    s = airlockSetD(s, false); // D moves while the clock is high: nothing happens
    expect(s.master).toBe(true);
    expect(s.q).toBe(true);
    s = last(s, false);
    expect(s.q).toBe(true);
    expect(s.master).toBe(false);
    expect(last(s, true).q).toBe(false);
  });
});

describe('laundry figure', () => {
  it('one at a time 12 slots, pipelined 6, with the stall 7 and a bubble', () => {
    expect(laundry(false, false).slots).toBe(12);
    expect(laundry(true, false).slots).toBe(6);
    const st = laundry(true, true);
    expect(st.slots).toBe(7);
    expect(st.bubbles.length).toBeGreaterThan(0);
    expect(laundry(true, false).bubbles).toEqual([]);
  });
  it('no machine holds two loads in one slot', () => {
    for (const [p, s] of [[true, false], [true, true], [false, false]] as const) {
      const keys = laundry(p, s).cells.map((c) => `${c.stage}/${c.slot}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('leaky DRAM figure', () => {
  it('uses the real constants', () => {
    expect(DRAM_SHARE).toBeCloseTo(0.2, 6);
    expect(DRAM_OFFSET_MV).toBeCloseTo(15, 6);
    expect(deltaMv(1)).toBeCloseTo(0.5 * 1100 * 0.2, 6); // 110 mV
  });
  it('a 1 leaks to X before refresh, a 0 never does', () => {
    expect(senseRead(1)).toBe(1);
    expect(senseRead(decay(1, 250))).toBe('X'); // at half
    expect(senseRead(decay(1, 1000))).toBe(0);
    expect(senseRead(0)).toBe(0);
  });
  it('refresh restores a clear read and tosses a coin for an X', () => {
    expect(refreshLevel(0.8)).toBe(1);
    expect(refreshLevel(0.1)).toBe(0);
    expect(refreshLevel(0.5, () => true)).toBe(1);
    expect(refreshLevel(0.5, () => false)).toBe(0);
  });
});
