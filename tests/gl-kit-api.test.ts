// The studio kit's newer API, DOM-free: framing (fitView, aspectOf), live deform (refresh), paths (along), parametric
// surfaces, ribbons and lettering (strokeGeo, round and flat).
import { describe, expect, it } from 'vitest';
import { along, paint, plane, refresh, ribbon, roundedBox, surface, type Geo } from '../src/gl/kit/geo';
import { heatRamp } from '../src/gl/kit/materials';
import { aspectOf, fitView } from '../src/gl/kit/scene';
import { onCylinder, onPlane, strokeGeo } from '../src/gl/kit/text';
import { dot3, mat4Apply, mat4LookAt, mat4Mul, mat4Perspective, type Vec3 } from '../src/gl/math';

const corners = (b: { min: Vec3; max: Vec3 }): Vec3[] =>
  [b.min[0], b.max[0]].flatMap((x) => [b.min[1], b.max[1]].flatMap((y) => [b.min[2], b.max[2]].map((z): Vec3 => [x, y, z])));

describe('framing', () => {
  const box = { min: [-30, 0, -8] as Vec3, max: [40, 25, 8] as Vec3 };
  for (const [yaw, pitch, aspect] of [[-0.4, 0.3, 4 / 3], [0, 0, 0.6], [1.2, -0.2, 1.9]]) {
    it(`fits the box inside the view, tightly (yaw ${yaw}, aspect ${aspect.toFixed(2)})`, () => {
      const fov = 0.6, f = fitView(box, yaw, pitch, fov, aspect, 0.08);
      const dir: Vec3 = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
      const eye: Vec3 = [f.target[0] + dir[0] * f.dist, f.target[1] + dir[1] * f.dist, f.target[2] + dir[2] * f.dist];
      const vp = mat4Mul(mat4Perspective(fov, aspect, 0.1, 5000), mat4LookAt(eye, f.target));
      let most = 0;
      for (const c of corners(box)) {
        const [x, y, , w] = mat4Apply(vp, c);
        expect(w).toBeGreaterThan(0);
        most = Math.max(most, Math.abs(x / w), Math.abs(y / w));
        expect(Math.abs(x / w)).toBeLessThanOrEqual(1);
        expect(Math.abs(y / w)).toBeLessThanOrEqual(1);
      }
      expect(most).toBeGreaterThan(0.8); // not lost in the middle of the canvas
    });
  }
  it('reads a long, low model as wide and a tall one as tall', () => {
    expect(aspectOf(box, 0, 0)).toBeCloseTo(70 / 25, 6);
    expect(aspectOf({ min: [-10, 0, -10], max: [10, 70, 10] }, 0, 0)).toBeLessThan(0.5);
  });
});

describe('live deform', () => {
  it('replaces the vertices in place and bumps the revision', () => {
    const g = roundedBox(2, 2, 2, 0.2), n = g.positions.length, before = g.positions;
    refresh(g, roundedBox(3, 2, 2, 0.2));
    expect(g.positions).toBe(before);
    expect(g.positions.length).toBe(n);
    expect(g.rev).toBe(1);
    expect(g.max[0]).toBeCloseTo(1.5, 6);
  });
  it('paints a colour per vertex from its position (a scalar through a ramp) and bumps the revision', () => {
    const g = paint(plane(2, 2), (p) => heatRamp((p[0] + 1) / 2));
    expect(g.colors!.length).toBe(g.positions.length);
    expect([...g.colors!.slice(0, 3)]).toEqual([...heatRamp(0)].map((v) => Math.fround(v)));
    expect([...g.colors!.slice(3, 6)]).toEqual([...heatRamp(1)].map((v) => Math.fround(v)));
    expect(g.rev).toBe(1);
  });
  it('refuses a geometry of another shape', () => {
    expect(() => refresh(roundedBox(1, 1, 1, 0.1), roundedBox(1, 1, 1, 0))).toThrow();
  });
});

describe('paths and surfaces', () => {
  it('walks a polyline by length', () => {
    const p: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0]];
    expect(along(p, 0)).toEqual([0, 0, 0]);
    expect(along(p, 0.25)).toEqual([5, 0, 0]);
    expect(along(p, 0.75)).toEqual([10, 5, 0]);
    expect(along(p, 1)).toEqual([10, 10, 0]);
  });
  it('builds a surface with UVs and outward normals (a sphere patch)', () => {
    const s = surface((u, v) => { const a = u * Math.PI * 2, b = (v - 0.5) * 2; return [Math.cos(a) * Math.cos(b), Math.sin(b), -Math.sin(a) * Math.cos(b)]; }, 16, 8);
    expect(s.uvs!.length / 2).toBe(s.positions.length / 3);
    for (let k = 0; k < s.positions.length; k += 3) {
      const p: Vec3 = [s.positions[k], s.positions[k + 1], s.positions[k + 2]], n: Vec3 = [s.normals[k], s.normals[k + 1], s.normals[k + 2]];
      expect(Math.abs(dot3(p, n))).toBeGreaterThan(0.9);
    }
    expect(plane(2, 4).uvs).toEqual(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  });
  it('builds a ribbon facing its normals', () => {
    const r = ribbon([[0, 0, 1], [1, 0, 1]], [[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [0, 1, 0]]);
    expect(r.indices.length).toBe(6);
    expect([...r.normals].filter((_, k) => k % 3 === 1).every((v) => v === 1)).toBe(true);
  });
});

describe('lettering', () => {
  const radius = (g: Geo, k: number) => Math.hypot(g.positions[k], g.positions[k + 2]);
  it('lays flat ink in the bulb\'s surface, a hair proud of it, with the surface\'s normals', () => {
    const g = strokeGeo('6SN7GT', onCylinder(20, 0), 0, 10, 2.2, 0.14, 0.03, { flat: true });
    for (let k = 0; k < g.positions.length; k += 3) {
      expect(radius(g, k)).toBeGreaterThan(20.02);
      expect(radius(g, k)).toBeLessThan(20.04);
      const n: Vec3 = [g.normals[k], g.normals[k + 1], g.normals[k + 2]];
      expect(n[1]).toBeCloseTo(0, 6); // round the cylinder, never up or down
    }
    expect(g.max[1] - g.min[1]).toBeLessThan(2.2 * 1.25); // the glyphs' full height, a little over the capitals'
  });
  it('stands round strokes proud of a plane', () => {
    const g = strokeGeo('A1', onPlane([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]), 0, 0, 6, 0.6, 0.3);
    expect(g.min[2]).toBeGreaterThanOrEqual(-1e-6);
    expect(g.max[2]).toBeCloseTo(0.6, 2);
    expect(g.indices.length).toBeGreaterThan(0);
  });
});
