// The opened package (widgets/package3dparts.ts) held to phys/line.ts's groundBounce and the noise panel's limits.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { groundBounce, VIH, VIL, VIO } from '../src/phys/line';
import { padSwing } from '../src/widgets/line';
import { bondL, bonds, bounceOf, chordFor, drawnLenMm, pkParts, verdictOf, LEN_DEFAULT, SEG, UNITS_PER_MM, type PkPalette, type PkState } from '../src/widgets/package3dparts';

const G: RGB = [0.5, 0.5, 0.5];
const P: PkPalette = { board: G, lead: G, paddle: G, die: G, pad: G, gold: G, ground: G, vdd: G, attach: G, mould: G, lit: [1, 0.6, 0.2], bad: [1, 0.3, 0.3] };
const st = (n: number, g = 1, lnh = 3, rise = 1, extra: Partial<PkState> = {}): PkState => ({ n, g, lnh, rise, ...extra });

describe('the package', () => {
  it('the chapter\'s quoted case: 8 pads, 3 nH, 1 ns is 0.58 V', () => {
    expect(bounceOf(st(8)).toFixed(2)).toBe('0.58');
  });
  it('is groundBounce on a pad\'s current, at several settings', () => {
    for (const [n, g, l, r] of [[1, 1, 3, 1], [8, 1, 3, 1], [16, 1, 10, 0.1], [12, 2, 5, 2], [16, 4, 0.5, 4]]) {
      expect(bounceOf(st(n, g, l, r))).toBe(groundBounce(n, padSwing(), r, l / g));
    }
  });
  it('k ground wires divide the inductance, so the bounce', () => {
    expect(bounceOf(st(8, 4))).toBeCloseTo(bounceOf(st(8, 1)) / 4, 12);
  });
  it('lit signal wires equal the outputs switching, and so do the glowing parts', () => {
    for (const n of [1, 5, 8, 16]) {
      const b = bonds(st(n, 2));
      expect(b.filter((x) => !x.ground && x.lit)).toHaveLength(n);
      expect(b.filter((x) => x.ground)).toHaveLength(2);
      expect(pkParts(st(n, 2), P).filter((p) => p.kind === 'cyl' && p.emissive).length).toBe((n + 2) * SEG);
    }
  });
  it('the over-limit flag is the panel\'s: VIL, VIH, then the supply', () => {
    expect(verdictOf(VIL - 1e-6)).toBe('ok');
    expect(verdictOf(VIL)).toBe('undefined');
    expect(verdictOf(VIH)).toBe('high');
    expect(verdictOf(VIO)).toBe('invalid');
    expect(verdictOf(bounceOf(st(8)))).toBe('ok');
    expect(verdictOf(bounceOf(st(16, 1, 3, 0.2)))).toBe('invalid');
  });
  it('Grover: 25 µm gold is about 0.85 nH/mm at 1 mm and 3 nH at 2.8 mm, the chapter figure', () => {
    expect(bondL(1)).toBeCloseTo(0.2 * (Math.log(160) - 0.75), 9);
    expect(bondL(1)).toBeGreaterThan(0.8); expect(bondL(1)).toBeLessThan(1.1);
    expect(bondL(LEN_DEFAULT)).toBeCloseTo(3, 1);
    expect(bondL(4)).toBeGreaterThan(bondL(2) * 2);
  });
  it('the drawn wire has the length the inductance was computed from, and a longer wire is drawn longer', () => {
    for (const len of [1.5, 2.8, 5]) {
      const s1 = st(8, 1, bondL(len), 1, { len });
      expect(drawnLenMm(s1)).toBeCloseTo(len, 4);
      const p = bonds(s1)[0].pts;
      const polyMm = p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0) / UNITS_PER_MM;
      expect(polyMm).toBeCloseTo(len, 4);
    }
    expect(chordFor(5)).toBeGreaterThan(chordFor(1.5));
    expect(bounceOf(st(8, 1, bondL(5), 1, { len: 5 }))).toBeGreaterThan(bounceOf(st(8, 1, bondL(1.5), 1, { len: 1.5 })));
  });
  it('a falling edge lights the ground wires, a rising one the VDD wires, and the droop equals the bounce formula', () => {
    const rail = (edge: 'fall' | 'rise') => bonds(st(8, 3, 3, 1, { edge })).filter((b) => b.rail !== 'sig' && b.lit).map((b) => b.rail);
    expect(rail('fall')).toEqual(['gnd', 'gnd', 'gnd']);
    expect(rail('rise')).toEqual(['vdd', 'vdd', 'vdd']);
    expect(bonds(st(8, 3)).filter((b) => b.rail === 'vdd')).toHaveLength(3);
    expect(bounceOf(st(8, 3, 3, 1, { edge: 'rise' }))).toBeCloseTo(bounceOf(st(8, 3)), 12);
  });
  it('the wires stay clear of the leads and the board at every length, and the mould is a part only when asked', () => {
    for (const len of [1.5, 5]) for (const b of bonds(st(8, 4, 3, 1, { len }))) for (const q of b.pts) expect(Math.abs(q[0])).toBeLessThan(37);
    const count = (mould: boolean) => pkParts(st(8, 1, 3, 1, { mould }), P).length;
    expect(count(true)).toBe(count(false) + 1);
  });
});
