import { describe, expect, it } from 'vitest';
import { OrbitCamera } from '../src/gl/camera';
import { parseCssColor } from '../src/gl/color';
import { INSTANCE_ATTRS, INSTANCE_FLOATS, packInstances, writeInstance } from '../src/gl/instances';
import { cross3, dot3, len3, mat4Apply, mat4Identity, mat4LookAt, mat4Mul, mat4Perspective, quatAxisAngle, quatMul, quatRotate, sub3, type Vec3 } from '../src/gl/math';
import { boxMesh, cylinderMesh, type Mesh } from '../src/gl/mesh';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, d = 6) => { for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], d); };

describe('gl math', () => {
  it('multiplies matrices (identity, associativity with a point)', () => {
    const p = mat4Perspective(1, 1.5, 0.1, 100), v = mat4LookAt([3, 4, 5], [0, 1, 0]);
    close(mat4Mul(mat4Identity(), v), v);
    const pt: Vec3 = [0.3, -2, 1.7], a = mat4Apply(mat4Mul(p, v), pt), [x, y, z] = mat4Apply(v, pt), b = mat4Apply(p, [x, y, z]);
    close(a, b, 4);
  });

  it('looks at the target: the target lands on −z, the eye at the origin', () => {
    const v = mat4LookAt([3, 4, 5], [1, 1, 1]);
    close(mat4Apply(v, [3, 4, 5]), [0, 0, 0, 1]);
    const t = mat4Apply(v, [1, 1, 1]);
    close(t.slice(0, 2), [0, 0]);
    expect(t[2]).toBeCloseTo(-Math.hypot(2, 3, 4), 5);
  });

  it('maps near and far planes to clip z −1 and 1', () => {
    const p = mat4Perspective(1, 1, 2, 50);
    for (const [d, z] of [[2, -1], [50, 1]]) { const c = mat4Apply(p, [0, 0, -d]); expect(c[2] / c[3]).toBeCloseTo(z, 5); }
  });

  it('rotates by quaternions like the shader', () => {
    const q = quatAxisAngle([0, 0, 1], Math.PI / 2);
    close(quatRotate(q, [1, 0, 0]), [0, 1, 0]);
    const r = quatMul(quatAxisAngle([0, 1, 0], Math.PI / 2), q); // q first, then about y
    close(quatRotate(r, [1, 0, 0]), [0, 1, 0]);
    close(quatRotate(r, [0, 1, 0]), quatRotate(quatAxisAngle([0, 1, 0], Math.PI / 2), [-1, 0, 0]));
  });
});

describe('orbit camera', () => {
  it('projects its target to the centre and keeps limits', () => {
    const cam = new OrbitCamera({ target: [1, 2, 3], yaw: 0.4, pitch: 0.3, dist: 10 });
    close(cam.project([1, 2, 3], 400, 300)!, [200, 150], 3);
    expect(len3(sub3(cam.eye(), [1, 2, 3]))).toBeCloseTo(10, 9);
    cam.orbit(0, 10);
    expect(cam.pitch).toBeLessThan(Math.PI / 2);
    cam.zoom(1e-3);
    expect(cam.dist).toBeCloseTo(2.5, 9);
    cam.orbit(7, 0);
    expect(Math.abs(cam.yaw)).toBeLessThanOrEqual(Math.PI);
    expect(cam.atHome()).toBe(false);
    cam.reset();
    expect(cam.atHome()).toBe(true);
    expect(cam.project(sub3(cam.eye(), sub3([1, 2, 3], cam.eye())), 400, 300)).toBeNull(); // behind the eye
  });

  it('puts +y up and turns with yaw', () => {
    const cam = new OrbitCamera({ target: [0, 0, 0], yaw: 0, pitch: 0, dist: 10 });
    expect(cam.project([0, 1, 0], 400, 400)![1]).toBeLessThan(200);
    expect(cam.project([1, 0, 0], 400, 400)![0]).toBeGreaterThan(200); // looking down −z, +x is right
  });
});

function checkMesh(m: Mesh) {
  const n = m.positions.length / 3;
  expect(m.normals.length).toBe(m.positions.length);
  expect(m.indices.length % 3).toBe(0);
  for (let i = 0; i < m.indices.length; i++) expect(m.indices[i]).toBeLessThan(n);
  const v = (k: number): Vec3 => [m.positions[k * 3], m.positions[k * 3 + 1], m.positions[k * 3 + 2]];
  const nv = (k: number): Vec3 => [m.normals[k * 3], m.normals[k * 3 + 1], m.normals[k * 3 + 2]];
  for (let k = 0; k < n; k++) expect(len3(nv(k))).toBeCloseTo(1, 6);
  // Every triangle winds counter-clockwise seen from outside: its face normal agrees with its vertex normals.
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    const f = cross3(sub3(v(b), v(a)), sub3(v(c), v(a)));
    for (const k of [a, b, c]) expect(dot3(f, nv(k))).toBeGreaterThan(0);
  }
  for (let k = 0; k < n; k++) for (const x of v(k)) expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-6);
}

describe('meshes', () => {
  it('box: 24 vertices, 12 triangles, outward', () => {
    const m = boxMesh();
    expect(m.positions.length / 3).toBe(24);
    expect(m.indices.length / 3).toBe(12);
    checkMesh(m);
  });

  it('cylinder: smooth side, flat caps, outward', () => {
    const m = cylinderMesh(24);
    expect(m.positions.length / 3).toBe(2 * 25 + 2 * 26);
    expect(m.indices.length / 3).toBe(24 * 2 + 24 * 2);
    checkMesh(m);
  });
});

describe('instance records', () => {
  it('packs position, scale, rotation, colour, emissive and specular in that order', () => {
    const data = packInstances([
      { pos: [1, 2, 3], color: [0.1, 0.2, 0.3] },
      { pos: [4, 5, 6], scale: [2, 3, 4], rot: [0, 0, 1, 0], color: [1, 0, 0, 0.5], emissive: [0.7, 0.8, 0.9], spec: 0.4 },
    ]);
    expect(data.length).toBe(2 * INSTANCE_FLOATS);
    close(data.subarray(0, INSTANCE_FLOATS), [1, 2, 3, 1, 1, 1, 0, 0, 0, 1, 0.1, 0.2, 0.3, 1, 0, 0, 0, 0]);
    close(data.subarray(INSTANCE_FLOATS), [4, 5, 6, 2, 3, 4, 0, 0, 1, 0, 1, 0, 0, 0.5, 0.7, 0.8, 0.9, 0.4]);
    writeInstance(data, 0, { pos: [9, 9, 9], color: [1, 1, 1] });
    expect(data[0]).toBe(9);
    expect(data[INSTANCE_FLOATS]).toBe(4);
    const last = INSTANCE_ATTRS.at(-1)!;
    expect(last.offset + last.size).toBe(INSTANCE_FLOATS);
  });
});

describe('CSS colours', () => {
  it('parses what getComputedStyle returns', () => {
    close(parseCssColor('rgb(255, 128, 0)')!, [1, 128 / 255, 0, 1]);
    close(parseCssColor('rgba(0, 0, 255, 0.5)')!, [0, 0, 1, 0.5]);
    close(parseCssColor('rgb(10 20 30 / 40%)')!, [10 / 255, 20 / 255, 30 / 255, 0.4]);
    close(parseCssColor('color(srgb 0.5 0.25 1)')!, [0.5, 0.25, 1, 1]);
    close(parseCssColor('#b8692e')!, [0xb8 / 255, 0x69 / 255, 0x2e / 255, 1]);
    close(parseCssColor('#fff')!, [1, 1, 1, 1]);
    expect(parseCssColor('oklch(0.5 0.1 30)')).toBeNull();
    expect(parseCssColor('bogus')).toBeNull();
  });
});
