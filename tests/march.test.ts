import { describe, expect, it } from 'vitest';
import { FaultyMemory, MARCH_C_MINUS, ZEROS_ONES, allMemFaults, marchCoverage, marchOps, marchText, runMarch } from '../src/sim/march';

describe('March tests', () => {
  it('a good memory passes both; March C− is 10n operations', () => {
    expect(runMarch(MARCH_C_MINUS, new FaultyMemory(16)).pass).toBe(true);
    expect(runMarch(ZEROS_ONES, new FaultyMemory(16)).pass).toBe(true);
    expect(marchOps(MARCH_C_MINUS, 16)).toBe(160);
    expect(marchText(MARCH_C_MINUS)).toBe('⇕(w0) ⇑(r0, w1) ⇑(r1, w0) ⇓(r0, w1) ⇓(r1, w0) ⇕(r0)');
  });

  it('the fault models act as described', () => {
    const m = new FaultyMemory(4, { kind: 'coupling', aggressor: 1, victim: 2, rise: true, v: 1 });
    m.write(1, 1);
    expect(m.read(2)).toBe(1);
    const d = new FaultyMemory(4, { kind: 'decoder', addr: 0, also: 3 });
    d.write(0, 1);
    expect([d.read(3), d.read(0)]).toEqual([1, 1]);
    d.write(3, 0);
    expect(d.read(0)).toBe(0);
    const t = new FaultyMemory(4, { kind: 'transition', cell: 2, rise: false });
    t.write(2, 1); t.write(2, 0);
    expect(t.read(2)).toBe(1);
  });

  it('March C− finds every single fault of the four kinds; the naive test misses most couplings and every decoder fault', () => {
    const n = 8;
    expect(allMemFaults(n)).toHaveLength(16 + 16 + 224 + 56);
    expect(marchCoverage(MARCH_C_MINUS, n)).toEqual({
      stuck: { found: 16, total: 16 }, transition: { found: 16, total: 16 }, coupling: { found: 224, total: 224 }, decoder: { found: 56, total: 56 },
    });
    expect(marchCoverage(ZEROS_ONES, n)).toEqual({
      stuck: { found: 16, total: 16 }, transition: { found: 8, total: 16 }, coupling: { found: 28, total: 224 }, decoder: { found: 0, total: 56 },
    });
  });
});
