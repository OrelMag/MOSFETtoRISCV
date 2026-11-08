// The shared model camera's pan and zoom to the cursor (gl/camera.ts), checked by projection, so no sign can be wrong:
// a pan moves what was under the pointer with it, a zoom keeps the point under the cursor where it was, and a pan is
// held within maxPan of home.
import { describe, expect, it } from 'vitest';
import { OrbitCamera } from '../src/gl/camera';
import type { Vec3 } from '../src/gl/math';

const W = 800, H = 600;
const views = [
  { target: [0, 0, 0] as Vec3, yaw: 0, pitch: 0.3, dist: 40 },
  { target: [5, 2, -3] as Vec3, yaw: 1.1, pitch: 0.7, dist: 120 },
  { target: [-2, 6, 4] as Vec3, yaw: -2.4, pitch: -0.1, dist: 15 },
];
const near = (a: [number, number] | null, b: [number, number]) => {
  expect(a).not.toBeNull();
  expect(a![0]).toBeCloseTo(b[0], 3);
  expect(a![1]).toBeCloseTo(b[1], 3);
};

describe('pan', () => {
  it('moves the old target by exactly the drag, in pixels', () => {
    for (const v of views) for (const [dx, dy] of [[30, 0], [0, -25], [-17, 41]]) {
      const c = new OrbitCamera(v), p = [...c.target] as Vec3;
      expect(c.project(p, W, H)![0]).toBeCloseTo(W / 2, 3);
      c.pan(dx, dy, H);
      near(c.project(p, W, H), [W / 2 + dx, H / 2 + dy]);
      expect(c.dist).toBe(v.dist);
      expect(c.yaw).toBeCloseTo(v.yaw, 12);
    }
  });
  it('moves the target by the drag times the world units per pixel, in the view plane', () => {
    const c = new OrbitCamera(views[1]), t0 = [...c.target], [r, up] = c.axes(), u = c.unitsPerPx(H);
    c.pan(10, -6, H);
    const d = c.target.map((v, i) => v - t0[i]);
    expect(Math.hypot(...d)).toBeCloseTo(u * Math.hypot(10, 6), 9);
    const fwd = c.target.map((v, i) => v - c.eye()[i]);
    expect(d.reduce((s, x, i) => s + x * fwd[i], 0)).toBeCloseTo(0, 9); // nothing along the view direction
    expect(r.reduce((s, x, i) => s + x * up[i], 0)).toBeCloseTo(0, 12);
  });
  it('is held within maxPan of home, and Reset brings it back', () => {
    const c = new OrbitCamera(views[0]);
    expect(c.limits.maxPan).toBe(20);
    for (let i = 0; i < 50; i++) c.pan(400, 300, H);
    expect(Math.hypot(...c.target)).toBeCloseTo(20, 9);
    expect(c.atHome()).toBe(false);
    c.reset();
    expect(c.atHome()).toBe(true);
    const d = new OrbitCamera(views[0], { maxPan: 3 });
    d.pan(-5000, 0, H);
    expect(Math.hypot(...d.target)).toBeCloseTo(3, 9);
  });
});

describe('zoom to the cursor', () => {
  it('keeps the point under the cursor where it was', () => {
    for (const v of views) for (const [px, py] of [[100, 80], [700, 500], [W / 2, H / 2], [420, 590]]) for (const f of [0.8, 1.25]) {
      const c = new OrbitCamera(v), u = c.unitsPerPx(H), [r, up] = c.axes();
      const p = c.target.map((t, i) => t + r[i] * (px - W / 2) * u + up[i] * (H / 2 - py) * u) as Vec3;
      near(c.project(p, W, H), [px, py]);
      c.zoomAt(f, px, py, W, H);
      expect(c.dist).toBeCloseTo(v.dist * f, 9);
      near(c.project(p, W, H), [px, py]);
    }
  });
  it('at the centre is a plain zoom, and at the distance limit moves nothing', () => {
    const c = new OrbitCamera(views[1]);
    c.zoomAt(0.5, W / 2, H / 2, W, H);
    expect(c.target).toEqual([5, 2, -3]);
    const d = new OrbitCamera(views[0]);
    d.zoom(0.25); // at minDist
    const t = [...d.target];
    d.zoomAt(0.5, 50, 50, W, H);
    expect(d.dist).toBe(10);
    d.target.forEach((x, i) => expect(x).toBeCloseTo(t[i], 12));
  });
});
