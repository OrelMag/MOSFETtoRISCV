import { describe, expect, it } from 'vitest';
import { and4Tree, and4Wide, G_NAND, gNand, gNor, P_NAND, pGate } from '../src/phys/effort';
import { cmosNand, cmosNor } from '../src/lib';
import { stats } from '../src/sim/stats';

describe('logical effort of wide gates', () => {
  it('agrees with the load-delay model for a NAND2', () => {
    expect(gNand(2)).toBeCloseTo(G_NAND, 12);
    expect(pGate(2)).toBe(P_NAND);
  });
  it('NOR grows faster than NAND', () => {
    for (const n of [2, 3, 4]) expect(gNor(n)).toBeGreaterThan(gNand(n));
    expect([gNand(3), gNand(4), gNor(2), gNor(3), gNor(4)].map((g) => +g.toFixed(3))).toEqual([1.667, 2, 1.667, 2.333, 3]);
  });
  it('a NAND2 / NOR2 tree beats NAND4 + inverter at any fan-out', () => {
    for (const H of [1, 4, 16]) expect(and4Tree(H)).toBeLessThan(and4Wide(H));
    expect(and4Wide(4)).toBeCloseTo(10.657, 2);
    expect(and4Tree(4)).toBeCloseTo(9.96, 2);
  });
  it('transistor counts are 2n', () => {
    for (const n of [3, 4]) expect([stats(cmosNand(n)).transistors, stats(cmosNor(n)).transistors]).toEqual([2 * n, 2 * n]);
  });
});
