import { describe, expect, it } from 'vitest';
import {
  AMP, beamPath, cellOf, deflectionOf, DIGITS, funnelRadius, LINES, meshParts, poseParts, spotCentre, spotYZ, staticParts, WGEOM, williamsAnchors, type WilliamsPose,
} from '../src/widgets/williams3dparts';
import type { CrtPalette } from '../src/widgets/crt3dparts';
import type { RGB } from '../src/gl/instances';

const c = (v: number): RGB => [v, v, v];
const P: CrtPalette = { glass: c(0.8), aquadag: c(0.2), copper: c(0.7), ferrite: c(0.3), metal: c(0.6), pin: c(0.5), cellOff: c(0.1), mask: c(0.4), heater: c(0.9), ghost: c(0.5), bezel: c(0.2) };
const pose = (o: Partial<WilliamsPose> = {}): WilliamsPose => ({ beam: null, bit: (i) => i & 1, glow: () => 0, plate: 0, ...o });

describe('the Williams tube geometry', () => {
  it('quotes its figures: the CV1131 face drawn 12-inch (300 mm) after Lavington (Computer50 says 6), 32 x 32 spots, a raster inside the glass', () => {
    expect(WGEOM.FACE_D).toBe(300);
    expect(DIGITS * LINES).toBe(1024);
    expect(Math.hypot(...spotYZ(0, 0))).toBeLessThan(WGEOM.FACE_R);
    expect(WGEOM.RASTER).toBe(DIGITS * WGEOM.PITCH);
  });

  it('digit 0 is on the left seen from the front (z positive), digits run left to right, line 0 at the top', () => {
    const [y0, z0] = spotYZ(0, 0), z31 = spotYZ(0, 31)[1], y1 = spotYZ(31, 0)[0];
    expect(z0).toBeGreaterThan(z31);
    expect(spotYZ(0, 1)[1]).toBeLessThan(z0);
    expect(y0).toBeGreaterThan(y1);
    expect(z0 + z31).toBeCloseTo(0, 9); // centred
  });

  it('the beam ends on its spot, leaves the gun on the axis and bends only in and after the plates', () => {
    for (const [l, d] of [[0, 0], [31, 31], [10, 20]]) {
      const p = beamPath(spotCentre(l, d));
      expect(p[0]).toEqual([WGEOM.GUN_X0 + 30, 0, 0]);
      expect(p[p.length - 1]).toEqual(spotCentre(l, d));
      for (const q of p.filter((q) => q[0] <= WGEOM.Y_PLATES[0])) expect(Math.hypot(q[1], q[2])).toBe(0);
      for (let i = 1; i < p.length; i++) expect(p[i][0]).toBeGreaterThan(p[i - 1][0]);
    }
  });

  it('plate voltages are about +-1 at the edges of the raster', () => {
    const tl = deflectionOf(0, 0), br = deflectionOf(31, 31);
    expect(tl.vy).toBeGreaterThan(0.95);
    expect(br.vy).toBeLessThan(-0.95);
    expect(tl.vx).toBeLessThan(-0.95);
    expect(br.vx).toBeGreaterThan(0.95);
    expect(Math.abs(tl.vy + br.vy)).toBeLessThan(1e-9);
  });

  it('the funnel opens from the neck to wider than the face, and the beams stay inside the glass along their whole length', () => {
    expect(funnelRadius(WGEOM.JOIN_X - 10)).toBe(WGEOM.NECK_R + 1);
    expect(funnelRadius(WGEOM.FACE_X - 12)).toBeGreaterThan(WGEOM.FACE_R);
    for (const [l, d] of [[0, 0], [0, 31], [31, 0], [31, 31]]) {
      for (const q of beamPath(spotCentre(l, d)).slice(0, -1)) expect(Math.hypot(q[1], q[2])).toBeLessThan(q[0] <= WGEOM.JOIN_X ? WGEOM.NECK_R : funnelRadius(q[0]));
    }
  });
});

describe('the parts', () => {
  it('builds 1 024 spots: a dash is longer than a dot, along the line; a lit one glows', () => {
    const ps = poseParts(P, pose({ glow: (i) => (i === 1 ? 1 : 0) }));
    const spots = ps.filter((p) => p.kind === 'box' && p.pos[0] > WGEOM.FACE_X - 1 && p.pos[0] < WGEOM.FACE_X + 0.5);
    expect(spots.length).toBe(1024);
    expect(spots.filter((p) => p.emissive).length).toBe(1);
    expect(spots[cellOf(0, 1)].scale![2]).toBeCloseTo(WGEOM.DASH, 9); // pose.bit(1) = 1
    expect(spots[cellOf(0, 0)].scale![2]).toBeCloseTo(WGEOM.DOT, 9);
    expect(WGEOM.DASH).toBeGreaterThan(WGEOM.DOT);
  });

  it('the beam is drawn only when it is on, and it ends on its spot', () => {
    const none = poseParts(P, pose()).length, on = poseParts(P, pose({ beam: { line: 3, digit: 5 } })).length;
    expect(on - none).toBe(beamPath(spotCentre(3, 5)).length - 1);
  });

  it('the pick-up mesh is a grid of wires in front of the glass, covering the raster, with a lead to the amplifier box', () => {
    const m = meshParts(P, 0);
    expect(new Set(m.map((p) => p.pos[0])).size).toBe(1);
    expect(m[0].pos[0]).toBeGreaterThan(WGEOM.FACE_X + WGEOM.GLASS);
    expect(Math.max(...m.map((p) => Math.abs(p.pos[1])))).toBeGreaterThanOrEqual(WGEOM.RASTER / 2);
    const lit = poseParts(P, pose({ plate: 1 })).filter((p) => p.emissive);
    expect(lit.length).toBeGreaterThan(m.length); // mesh and amplifier glow with the signal
    expect(AMP.at[2]).toBeGreaterThan(WGEOM.RASTER / 2);
  });

  it('the plates take their voltage tints', () => {
    const glow = (ps: ReturnType<typeof staticParts>) => ps.reduce((a, p) => a + (p.emissive ? p.emissive[0] + p.emissive[1] + p.emissive[2] : 0), 0);
    expect(glow(staticParts(P, 1, 1))).toBeGreaterThan(glow(staticParts(P, 0, 0)));
  });

  it('names its parts, and a phone gets three labels', () => {
    for (const d of ['overview', 'face', 'plates'] as const) {
      const a = williamsAnchors(d);
      expect(a.length).toBeGreaterThan(3);
      for (const x of a) expect(x.text.length).toBeGreaterThan(2);
    }
    expect(williamsAnchors('overview', true).length).toBe(3);
    expect(williamsAnchors('overview').map((a) => a.text).join()).toMatch(/gun.*plates.*pick-up.*amplifier/s);
  });
});
