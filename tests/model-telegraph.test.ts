// The telegraph key and sounder: the drawing held to phys/telegraph.ts and phys/relay.ts.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { RELAY, T_OFF } from '../src/phys/relay';
import { loopCurrent, margin, PULL_I, reachKm, type Metal } from '../src/phys/telegraph';
import { armTheta, coilVolts, lineCurrent, pressX, pulls, releaseX, tgAnchors, tgParts, type Line, type TgPalette } from '../src/widgets/telegraph3dparts';

const G: RGB = [0.5, 0.5, 0.5], P: TgPalette = { board: G, metal: G, brass: G, wood: G, live: [0, 1, 0], coil: G, glow: G, wire: G };
const METALS: Metal[] = ['iron', 'copper'];
const at = (V: number, m: Metal, f: number): Line => ({ V, metal: m, km: reachKm(V, m) * f });
const settled = (l: Line) => pressX(l, 0.2);

describe('the sounder against the line model', () => {
  it('current and reach are phys/telegraph.ts at several lengths, for both metals', () => {
    for (const m of METALS) for (const V of [24, 48, 120]) for (const km of [0, 5, 29, 100, 300]) {
      const l: Line = { V, km, metal: m };
      expect(lineCurrent(l)).toBe(loopCurrent(V, km, m));
      expect(pulls(l)).toBe(margin(V, km, m) >= 1);
      expect(pulls(l)).toBe(km <= reachKm(V, m));
    }
  });

  it('just inside the reach the armature travels to the anvil and the contact closes', () => {
    for (const m of METALS) for (const V of [24, 48, 120]) {
      const l = at(V, m, 1 - 1e-9);
      expect(pulls(l)).toBe(true);
      expect(settled(l)).toBeCloseTo(RELAY.travel, 12);
      expect(pressX(l, 0.2)).toBeGreaterThan(pressX(l, 0.001));
    }
    expect(settled({ V: 24, km: 0, metal: 'iron' })).toBeCloseTo(RELAY.travel, 12);
  });

  it('a hair past the reach it does not move at all, at any time, held or released', () => {
    for (const m of METALS) for (const V of [24, 48, 120]) {
      const l = at(V, m, 1 + 1e-9);
      expect(pulls(l)).toBe(false);
      for (const t of [0, 0.001, 0.007, 0.02, 0.2]) expect(pressX(l, t)).toBe(0);
      expect(releaseX(l, 0, 0.005)).toBe(0);
      expect(coilVolts(l)).toBeLessThan(PULL_I * RELAY.Rc + 1e-9);
    }
  });

  it('the armature starts open, only falls back after a release and ends at rest', () => {
    const l = at(24, 'iron', 0.5);
    expect(pressX(l, 0)).toBe(0);
    expect(releaseX(l, RELAY.travel, 0)).toBeGreaterThan(0);
    expect(releaseX(l, RELAY.travel, 0.02)).toBeCloseTo(0, 9);
    for (const t of [0, 0.002, 0.004, 0.02]) expect(releaseX(l, 0.3e-3, t)).toBeLessThanOrEqual(0.3e-3 + 1e-12);
    expect(T_OFF).toBeGreaterThan(0);
  });

  it('a marginal coil still ends on the anvil once it has begun to move', () => {
    const l = at(24, 'copper', 1 - 1e-6);
    expect(pressX(l, 0.5)).toBeCloseTo(RELAY.travel, 12);
  });

  it('the drawn armature angle follows the gap: open at rest, nearly flat on the anvil', () => {
    expect(armTheta(0)).toBeGreaterThan(armTheta(RELAY.travel));
    expect(armTheta(RELAY.travel)).toBeGreaterThan(0);
  });

  it('draws parts and labels, and the coils glow only while current flows', () => {
    const glow = (flowing: boolean, i: number) => tgParts({ kd: flowing ? 1 : 0, x: 0, flowing, i }, P).filter((p) => p.emissive).length;
    expect(glow(false, 0)).toBe(0);
    expect(glow(true, PULL_I)).toBeGreaterThan(0);
    expect(tgAnchors({ kd: 0, x: 0, flowing: false, i: 0 }).map((a) => a.text)).toContain('anvil');
  });
});
