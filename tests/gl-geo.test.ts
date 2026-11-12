import { describe, expect, it } from 'vitest';
import { bentSheet, extrude, filletPath, helix, lathe, merge, roundedBox, sphere, torus, tube, type Geo } from '../src/gl/kit/geo';

/** Every triangle faces the way its vertices' normals say (counter-clockwise from outside), no NaN, normals unit. */
function wellFormed(g: Geo) {
  const P = g.positions, N = g.normals;
  expect(P.length).toBe(N.length);
  for (let k = 0; k < N.length; k += 3) {
    expect(Number.isFinite(P[k] + P[k + 1] + P[k + 2])).toBe(true);
    expect(Math.hypot(N[k], N[k + 1], N[k + 2])).toBeCloseTo(1, 3);
  }
  let bad = 0, tris = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
    const e1 = [0, 1, 2].map((i) => P[3 * b + i] - P[3 * a + i]), e2 = [0, 1, 2].map((i) => P[3 * c + i] - P[3 * a + i]);
    const gn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(...gn) < 1e-9) continue; // degenerate (a pole)
    tris++;
    const vn = [0, 1, 2].map((i) => N[3 * a + i] + N[3 * b + i] + N[3 * c + i]);
    if (gn[0] * vn[0] + gn[1] * vn[1] + gn[2] * vn[2] <= 0) bad++;
  }
  expect(tris).toBeGreaterThan(0);
  expect(bad).toBe(0);
}

/** Enclosed volume by the divergence theorem: positive when every face points out. */
function volume(g: Geo) {
  const P = g.positions;
  let v = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]].map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

describe('studio geometry', () => {
  it('a lathe cylinder r 2, 3 tall: outward, volume π r² h', () => {
    const g = lathe([[0, 0], [2, 0], [2, 3], [0, 3]], { seg: 128 });
    wellFormed(g);
    expect(volume(g)).toBeCloseTo(Math.PI * 4 * 3, 0);
    expect(g.min[1]).toBe(0); expect(g.max[1]).toBe(3);
  });
  it('a lathe shell (bulb wall) walks up the outside and down the inside', () => {
    const g = lathe([[0, 0], [5, 0], [5, 10], [4.5, 10], [4.5, 0.5], [0, 0.5]], { seg: 96 });
    wellFormed(g);
    expect(volume(g)).toBeCloseTo(Math.PI * (25 * 10 - 4.5 * 4.5 * 9.5), -1);
  });
  it('a sphere r 1: volume 4/3 π', () => {
    const g = sphere(1, 64, 32);
    wellFormed(g);
    expect(volume(g)).toBeCloseTo((4 / 3) * Math.PI, 1);
  });
  it('a tube along a bent path is closed and faces out', () => {
    const g = tube([[0, 0, 0], [0, 10, 0], [5, 10, 0]], 0.5, { bend: 2, sides: 12 });
    wellFormed(g);
    expect(volume(g)).toBeGreaterThan(0);
  });
  it('a torus: volume 2π² R r²', () => {
    const g = torus(3, 0.5, 96, 24);
    wellFormed(g);
    expect(volume(g)).toBeCloseTo(2 * Math.PI ** 2 * 3 * 0.25, 0);
  });
  it('a helix rises by its pitch per turn, and an oval one keeps its radii', () => {
    const p = helix({ rx: 2, rz: 1, pitch: 0.5, from: 0, to: 5, perTurn: 20 });
    expect(p[0][1]).toBe(0); expect(p.at(-1)![1]).toBeCloseTo(5, 9);
    expect(Math.max(...p.map((q) => q[0]))).toBeCloseTo(2, 6);
    expect(Math.max(...p.map((q) => q[2]))).toBeCloseTo(1, 2);
    wellFormed(tube(p, 0.05, { sides: 6 }));
  });
  it('a fillet keeps the ends and stays within the corner', () => {
    const f = filletPath([[0, 0, 0], [10, 0, 0], [10, 10, 0]], 3);
    expect(f[0]).toEqual([0, 0, 0]); expect(f.at(-1)).toEqual([10, 10, 0]);
    expect(f.length).toBeGreaterThan(5);
    for (const q of f) expect(q[0]).toBeLessThanOrEqual(10 + 1e-9);
  });
  it('extrude: a concave L in either winding, volume = area × height', () => {
    const L: [number, number][] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];
    for (const o of [L, L.slice().reverse()]) {
      const g = extrude(o, 2);
      wellFormed(g);
      expect(volume(g)).toBeCloseTo(6 * 2, 6);
    }
  });
  it('a bent sheet (a plate half) is a closed solid of about length × t × h', () => {
    const g = bentSheet([[-6, 0], [-5, 0], [-5, -3], [5, -3], [5, 0], [6, 0]], 0.25, 22);
    wellFormed(g);
    expect(volume(g)).toBeCloseTo((1 + 3 + 10 + 3 + 1) * 0.25 * 22, 0);
  });
  it('a rounded box: volume between the inner and outer box', () => {
    const g = roundedBox(4, 2, 3, 0.5, 4);
    wellFormed(g);
    const v = volume(g), r = 0.5, [a, b, c] = [3, 1, 2];
    const exact = a * b * c + 2 * r * (a * b + b * c + a * c) + Math.PI * r * r * (a + b + c) + (4 / 3) * Math.PI * r ** 3;
    expect(v).toBeLessThan(exact);
    expect(v).toBeGreaterThan(exact - 0.1);
    wellFormed(roundedBox(1, 1, 1, 0));
  });
  it('merge keeps every triangle', () => {
    const a = sphere(1, 8, 4), b = torus(2, 0.2, 8, 4), m = merge([a, b]);
    expect(m.indices.length).toBe(a.indices.length + b.indices.length);
    wellFormed(m);
  });
});
