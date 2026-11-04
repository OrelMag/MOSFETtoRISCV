// The opened package (widgets/package3dparts.ts) held to phys/line.ts's groundBounce and the noise panel's limits.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { groundBounce, VIH, VIL, VIO } from '../src/phys/line';
import { padSwing } from '../src/widgets/line';
import { bonds, bounceOf, pkParts, verdictOf, SEG, type PkPalette, type PkState } from '../src/widgets/package3dparts';

const G: RGB = [0.5, 0.5, 0.5];
const P: PkPalette = { board: G, lead: G, paddle: G, die: G, pad: G, gold: G, ground: G, lit: [1, 0.6, 0.2], bad: [1, 0.3, 0.3] };
const st = (n: number, g = 1, lnh = 3, rise = 1): PkState => ({ n, g, lnh, rise });

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
});
