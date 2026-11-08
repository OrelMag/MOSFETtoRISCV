// The twisted pair's model (phys/cable.ts) and its drawing held to it.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { COAX_PRESETS, DIELECTRICS, coaxLC, coaxZ0, fieldRate, halfTwistsPerMetre, LAY_A_MM, LAY_B_MM, loopCount, loopEdges, loopEmf, loopFractions, neighbourCoupling, neighbourHalfTwists, pairLoops, pairPickup, runningSum, unevenLoops } from '../src/phys/cable';
import { z0Of } from '../src/phys/line';
import { cableAnchors, cableParts, type CablePalette } from '../src/widgets/cable3dparts';

const G: RGB = [0.5, 0.5, 0.5], C: RGBA = [0.5, 0.5, 0.5, 0.5];
const F: RGB = [0.1, 0.2, 0.3], E_COLOUR: RGB = [0.9, 0.6, 0.1];
const P: CablePalette = { a: G, b: G, pos: [1, 0, 0, 0.5], neg: [0, 0, 1, 0.5], shield: C, core: G, field: F, efield: E_COLOUR, diel: [0.9, 0.9, 0.8, 0.5], jacket: [0.2, 0.2, 0.2, 0.4] };
const PAIR = { twists: 5, coax: false, preset: 'rg58', diel: 'pe' as const, uneven: 0, neighbour: 'off' as const };
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
    const s = PAIR, parts = cableParts(s, P);
    expect(parts.filter((p) => p.color === P.pos).length).toBe(parts.filter((p) => p.color === P.neg).length);
    expect(parts.filter((p) => p.color === P.pos).length).toBeGreaterThan(0);
    expect(cableAnchors(s).filter((a) => a.text === '+' || a.text === '−')).toHaveLength(6);
  });
  it('twelve half twists stay within a usable instance count', () => {
    expect(cableParts({ ...PAIR, twists: 12 }, P).length).toBeLessThan(900);
  });
});

describe('uneven twist', () => {
  it('the loop shares sum to 1, equal at 0 %, and stay within ±uneven of equal before normalising', () => {
    expect(loopFractions(5, 0).every((f) => Math.abs(f - 1 / 6) < 1e-15)).toBe(true);
    const f = loopFractions(7, 0.2);
    expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    for (const x of f) { expect(x).toBeGreaterThan(0.8 / 8 / 1.2); expect(x).toBeLessThan(1.2 / 8 / 0.8); }
  });
  it('0 % reproduces the equal pair; odd n then leaves a residue below one loop of the untwisted pair', () => {
    for (const n of [0, 3, 6]) unevenLoops(n, S, LEN, R, 0).forEach((x, i) => expect(x).toBeCloseTo(pairLoops(n, S, LEN, R)[i], 15));
    for (const n of [1, 3, 5, 7, 11]) {
      const t = unevenLoops(n, S, LEN, R, 0.1).reduce((a, b) => a + b, 0);
      expect(Math.abs(t)).toBeGreaterThan(1e-9);
      expect(Math.abs(t)).toBeLessThan(0.1 * loopEmf(S, LEN, R));
    }
  });
  it('the leg imbalance is the same sum: the edges of the loops cut 0..1', () => {
    const e = loopEdges(4, 0.15);
    expect(e[0]).toBe(0); expect(e.at(-1)).toBeCloseTo(1, 12); expect(e).toHaveLength(6);
  });
});

describe('real lays and the neighbour pair', () => {
  it('EP1058275 lays 0.440 in and 0.596 in: 11.18 and 15.14 mm, 179 and 132 half twists per metre', () => {
    expect(LAY_A_MM).toBeCloseTo(11.176, 3); expect(LAY_B_MM).toBeCloseTo(15.1384, 3);
    expect(halfTwistsPerMetre(LAY_A_MM)).toBeCloseTo(178.95, 1); expect(halfTwistsPerMetre(LAY_B_MM)).toBeCloseTo(132.1, 1);
  });
  it('the neighbour of 5 half twists (6 loops) has 3 (4 loops): same run, 11.18 : 15.14 lays', () => expect(neighbourHalfTwists(5)).toBe(3));
  it('equal lays couple fully; 6 loops against 4 sum to zero by hand (+1/6 −1/12 +1/12 −1/6 −1/6 +1/12 −1/12 +1/6)', () => {
    expect(neighbourCoupling(loopEdges(5), loopEdges(5))).toBeCloseTo(1, 12);
    expect(neighbourCoupling(loopEdges(5), loopEdges(3))).toBeCloseTo(0, 12);
  });
  it('a 100 µT, 50 Hz field is 0.031 T/s, far below the 10 T/s of the teaching scale', () => expect(fieldRate(100e-6, 50)).toBeCloseTo(0.0314, 4));
});

describe('the stock coax cables', () => {
  it('D > d, and Z0 from the closed form is within 5 % of the datasheet nominal at the stock dielectric', () => {
    for (const p of COAX_PRESETS) {
      expect(p.D).toBeGreaterThan(p.d);
      const er = DIELECTRICS[p.dielectric].er, z = coaxZ0(p.D, p.d, er), { l, c } = coaxLC(p.D, p.d, er);
      expect(Math.abs(z / p.z0 - 1)).toBeLessThan(0.05);
      expect(Math.abs(z0Of(l, c).z0 / z - 1)).toBeLessThan(2e-3);
    }
  });
  it('hand check: RG-58 60 / 1.5166 · ln(2.9464 / 0.8382) = 49.7 Ω against 52; RG-59 73.1 against 75; RG-6 73.5 against 75', () => {
    const [a, b, c] = COAX_PRESETS.map((p) => coaxZ0(p.D, p.d, DIELECTRICS[p.dielectric].er));
    expect(a).toBeCloseTo(49.73, 1); expect(b).toBeCloseTo(73.1, 0); expect(c).toBeCloseTo(73.5, 0);
  });
  it('the datasheets’ velocity of propagation gives the dielectrics: 1 / 0.66² = 2.30, 1 / 0.82² = 1.49', () => {
    expect(1 / 0.66 ** 2).toBeCloseTo(DIELECTRICS.pe.er, 1); expect(1 / 0.82 ** 2).toBeCloseTo(DIELECTRICS.foam.er, 1);
  });
  it('is drawn with jacket, braid, dielectric and core to scale, and a lower εr (PTFE) raises Z0 of the same geometry', () => {
    const parts = cableParts({ ...PAIR, coax: true, preset: 'rg6', diel: 'foam' }, P);
    const jacket = parts.find((p) => p.color === P.jacket), diel = parts.find((p) => p.color === P.diel), core = parts.find((p) => p.color === P.core && p.scale![0] < 3);
    expect(jacket!.scale![0] / diel!.scale![0]).toBeCloseTo(6.96 / 4.57, 2);
    expect(diel!.scale![0] / core!.scale![0]).toBeCloseTo(4.57 / 1.02, 1);
    expect(parts.filter((p) => p.color === P.shield).length).toBeGreaterThan(100);
    expect(coaxZ0(4.57, 1.02, DIELECTRICS.ptfe.er)).toBeGreaterThan(coaxZ0(4.57, 1.02, DIELECTRICS.pe.er));
  });
});

describe('the new drawing', () => {
  it('the B arrows pierce the loops at z = 0, one set per loop, and the E arrows reach in from the side', () => {
    const parts = cableParts(PAIR, P), B = parts.filter((p) => p.color === F), E = parts.filter((p) => p.color === E_COLOUR);
    expect(B).toHaveLength(6 * 3); expect(B.every((p) => Math.abs(p.pos[2]) < 1e-9)).toBe(true);
    expect(E).toHaveLength(5 * 3); expect(E.every((p) => p.pos[2] > 3)).toBe(true);
  });
  it('the neighbour pair adds only wires, and the instance counts stay low (n = 5, n = 12)', () => {
    const n5 = cableParts(PAIR, P).length, n5n = cableParts({ ...PAIR, neighbour: 'other' }, P).length, n12n = cableParts({ ...PAIR, twists: 12, neighbour: 'same' }, P).length;
    expect(n5n).toBeGreaterThan(n5); expect(n12n).toBeLessThan(900);
  });
  it('uneven loops are drawn with the same edges the model sums', () => {
    const s = { ...PAIR, uneven: 0.2 }, anchors = cableAnchors(s).filter((a) => a.text === '+' || a.text === '−');
    const e = loopEdges(5, 0.2);
    anchors.forEach((a, k) => expect(a.p[0]).toBeCloseTo(((e[k] + e[k + 1]) / 2 - 0.5) * 60, 9));
  });
});
