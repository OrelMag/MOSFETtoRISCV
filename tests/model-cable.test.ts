// The twisted pair's model (phys/cable.ts) and its drawing held to it.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { coaxLC, coaxZ0, loopCount, loopEmf, pairLoops, pairPickup, runningSum } from '../src/phys/cable';
import { z0Of } from '../src/phys/line';
import { cableAnchors, cableParts, type CablePalette } from '../src/widgets/cable3dparts';

const G: RGB = [0.5, 0.5, 0.5], C: RGBA = [0.5, 0.5, 0.5, 0.5];
const P: CablePalette = { a: G, b: G, pos: [1, 0, 0, 0.5], neg: [0, 0, 1, 0.5], shield: C, core: G, field: G };
const S = 1e-3, LEN = 1, R = 10;

describe('the pair', () => {
  it('untwisted, the pickup is the single loop A * dB/dt', () => {
    expect(loopCount(0)).toBe(1);
    expect(pairPickup(0, S, LEN, R)).toBeCloseTo(loopEmf(S, LEN, R), 12);
  });
  it('an odd number of half twists sums to zero, an even one to one loop', () => {
    for (const n of [1, 3, 5, 7, 11]) expect(Math.abs(pairPickup(n, S, LEN, R))).toBeLessThan(1e-12);
    for (const n of [2, 4, 8, 12]) expect(pairPickup(n, S, LEN, R)).toBeCloseTo(loopEmf(S, LEN / (n + 1), R), 12);
  });
  it('signs alternate and the running sum ends on the pickup', () => {
    const l = pairLoops(4, S, LEN, R);
    expect(l).toHaveLength(5);
    l.forEach((e, k) => expect(Math.sign(e)).toBe(k % 2 ? -1 : 1));
    expect(runningSum(l).at(-1)).toBeCloseTo(pairPickup(4, S, LEN, R), 12);
  });
  it('more twist never makes the leftover larger', () => {
    // odd counts cancel, so only the same parity is ordered; every count is bounded by one loop
    for (let n = 1; n < 20; n++) expect(Math.abs(pairPickup(n, S, LEN, R))).toBeLessThanOrEqual(loopEmf(S, LEN / (n + 1), R) + 1e-15);
    for (let n = 0; n < 20; n += 2) expect(Math.abs(pairPickup(n + 2, S, LEN, R))).toBeLessThanOrEqual(Math.abs(pairPickup(n, S, LEN, R)) + 1e-15);
  });
});

describe('the coax', () => {
  it('z0Of on the L and C of D, d, er agrees with 60 / sqrt(er) * ln(D / d)', () => {
    for (const [D, d, er] of [[4.6, 0.9, 2.3], [7, 1, 1], [10, 0.2, 4]]) {
      const { l, c } = coaxLC(D, d, er);
      // the closed form rounds 60 = eta0 / 2 pi (59.96): within 0.1 %
      expect(Math.abs(z0Of(l, c).z0 / coaxZ0(D, d, er) - 1)).toBeLessThan(1e-3);
    }
  });
});

describe('the drawing', () => {
  it('shows the loops’ alternating signs from the first frame, and labels every loop', () => {
    const s = { twists: 5, coax: false, D: 4, d: 1 }, parts = cableParts(s, P);
    expect(parts.filter((p) => p.color === P.pos).length).toBe(parts.filter((p) => p.color === P.neg).length);
    expect(parts.filter((p) => p.color === P.pos).length).toBeGreaterThan(0);
    expect(cableAnchors(s).filter((a) => a.text === '+' || a.text === '−')).toHaveLength(6);
  });
  it('twelve half twists stay within a usable instance count', () => {
    expect(cableParts({ twists: 12, coax: false, D: 4, d: 1 }, P).length).toBeLessThan(900);
  });
});
