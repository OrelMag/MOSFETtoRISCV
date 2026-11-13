// The telegraph key and sounder: the drawing held to phys/telegraph.ts and phys/relay.ts.
import { describe, expect, it } from 'vitest';
import { RELAY, T_OFF } from '../src/phys/relay';
import { loopCurrent, margin, ohmsPerKm, PULL_I, PULL_V, reachKm, SOUNDER, SOUNDER_R, SOUNDER_RELEASE, type Metal } from '../src/phys/telegraph';
import { armTheta, CLOSER_TIP, coilVolts, KEY_TIP, lineCurrent, pressX, pulls, releaseX, type Line } from '../src/widgets/telegraph3dparts';
import { SOS_UNITS } from '../src/widgets/telegraph3dview';
import { tgModel, tgPose, U } from '../src/widgets/telegraph3dkit';
import { LEVER_L } from '../src/widgets/telegraph3dparts';
const LEVER_MM = LEVER_L * U;

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
      expect(coilVolts(l)).toBeLessThan(PULL_I * SOUNDER_R + 1e-9);
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

  it('the model: labels on named groups, and the coils and wires light only while current flows', () => {
    const off = tgModel({ kd: 0, x: 0, flowing: false, i: 0 }), on = tgModel({ kd: 1, x: 0, flowing: true, i: PULL_I });
    const lit = (m: ReturnType<typeof tgModel>) => m.items.filter((i) => (i.mat.glow ?? 0) > 0).length;
    expect(lit(off)).toBe(0);
    expect(lit(on)).toBeGreaterThan(0);
    const groups = new Set(on.items.map((i) => i.group));
    for (const a of on.anchors!) expect(groups.has(a.on!)).toBe(true);
    expect(on.anchors!.map((a) => a.text)).toContain('anvil');
    for (const it of on.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it('Ohm and the numbers by hand: a 120 Ω main-line coil, 38.0 mA, reach 64 km on iron at 24 V', () => {
    expect(SOUNDER_R).toBe(120);
    expect(SOUNDER_RELEASE).toBe(1000);
    expect(SOUNDER.Rc).toBe(SOUNDER_R);
    expect(SOUNDER.Rq).toBe(SOUNDER_RELEASE);
    expect(PULL_I * 1e3).toBeCloseTo(38.0, 1);
    expect(PULL_V).toBeCloseTo(4.56, 2);
    // 12 km of iron: 7.96 Ω/km → 95.5 Ω + 120 Ω = 215.5 Ω → 24 V / 215.5 Ω = 111.4 mA, 13.4 V across the coil
    expect(ohmsPerKm('iron')).toBeCloseTo(7.958, 2);
    const l: Line = { V: 24, km: 12, metal: 'iron' };
    expect(lineCurrent(l) * 1e3).toBeCloseTo(111.4, 1);
    expect(coilVolts(l)).toBeCloseTo(13.4, 1);
    // reach = (V / I_pull − R_coil) / r
    expect(reachKm(24, 'iron')).toBeCloseTo((24 / PULL_I - 120) / ohmsPerKm('iron'), 9);
    expect(reachKm(24, 'iron')).toBeCloseTo(64.2, 1);
    expect(reachKm(24, 'copper')).toBeCloseTo(382.3, 0);
  });

  it('the sounder lets go at every drive, within the run that is kept (no telephone quench)', () => {
    for (const f of [1.05, 2, 5, 26]) {
      const V = 24, km = Math.max(0, (V / (f * PULL_I) - SOUNDER_R) / ohmsPerKm('iron'));
      const l: Line = { V, km, metal: 'iron' };
      expect(pulls(l)).toBe(true);
      expect(releaseX(l, RELAY.travel, 0.03)).toBeLessThan(1e-9);
    }
  });

  it('closed circuit: the armature is down at idle with the closer shut; opening the closer lets it go, the key brings it back', () => {
    const l: Line = { V: 24, km: 12, metal: 'iron' };
    expect(pressX(l, 1)).toBeCloseTo(RELAY.travel, 12);
    expect(releaseX(l, RELAY.travel, 0)).toBeGreaterThan(0.9 * RELAY.travel);
    expect(releaseX(l, RELAY.travel, 0.03)).toBeLessThan(1e-9);
    expect(pressX(l, 0)).toBe(0);
    // out of reach, a shut closer holds nothing down
    expect(pressX({ V: 24, km: 100, metal: 'iron' }, 1)).toBe(0);
  });

  it('the closer lever lies on its stud shut and stands up open; the key lever is longer than the sounder pole spacing', () => {
    expect(CLOSER_TIP(1)[1]).toBeLessThan(CLOSER_TIP(0)[1] - 5);
    expect(CLOSER_TIP(1)[0]).toBeCloseTo(-21, 0);
    expect(KEY_TIP(0)[0] - KEY_TIP(0, 0)[0]).toBeGreaterThan(34);
  });

  it('the pose turns the key, closer and armature about their own pivots; the closer wires carry current only while it is shut', () => {
    const base = { kd: 0, x: 0, flowing: false, i: 0 };
    const mv = tgPose({ ...base, kd: 1, cd: 1, x: RELAY.travel }), at = (m: Float32Array, p: number[]) => [m[0] * p[0] + m[4] * p[1] + m[12], m[1] * p[0] + m[5] * p[1] + m[13]];
    for (const [g, p] of [['key', [-40, 6]], ['closer', [-34, 7]], ['armature', [72, 13]]] as const) {
      const q = at(mv.get(g)!, [p[0] * U, p[1] * U]);
      expect(q[0]).toBeCloseTo(p[0] * U, 3); expect(q[1]).toBeCloseTo(p[1] * U, 3);
    }
    expect(at(mv.get('key')!, [-4 * U, 6 * U])[1]).toBeLessThan(at(tgPose(base).get('key')!, [-4 * U, 6 * U])[1]); // pressed: the tip goes down
    const wires = (cd: number) => tgModel({ ...base, cd, flowing: true, i: 0.05 }).items.filter((i) => i.name === 'circuit closer' && i.group === 'wires')[0].mat.glow ?? 0;
    expect(wires(1)).toBeGreaterThan(0);
    expect(wires(0)).toBe(0);
    expect(LEVER_MM).toBeGreaterThanOrEqual(100); expect(LEVER_MM).toBeLessThanOrEqual(127); // Pope: four to five inches
  });

  it('SOS is three dots, three dashes, three dots with the standard gaps: 27 units', () => {
    expect(SOS_UNITS.length).toBe(9);
    expect(SOS_UNITS.map(([a, b]) => b - a)).toEqual([1, 1, 1, 3, 3, 3, 1, 1, 1]);
    expect(SOS_UNITS[SOS_UNITS.length - 1][1]).toBe(27);
    // a dot at 20 wpm is 1.2 / 20 = 60 ms
    expect((1.2 / 20) * 1000).toBeCloseTo(60, 9);
  });
});
