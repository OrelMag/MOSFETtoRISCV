// What a model's parts are made of (DOM-free, so a model's geometry can be tested): boxes and cylinders as renderer
// instances, and the same parts as flat shaded faces, painter-sorted, for the SVG fallback without WebGL2.

import type { Instance, RGB, RGBA } from './instances';
import { cross3, dot3, len3, norm3, QUAT_ID, quatAxisAngle, quatRotate, sub3, type Vec3 } from './math';

export interface Part extends Instance { kind: 'box' | 'cyl' }

/** A label: where it points, which side its text sits on, and the way the labelled face looks (dimmed when that
 *  face turns away from the camera: the label would otherwise float over whatever hides it). */
export interface Anchor { text: string; p: Vec3; side: 'l' | 'r' | 't' | 'b'; n: Vec3; minor?: boolean }

export const box = (c: RGB | RGBA, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, spec = 0): Part =>
  ({ kind: 'box', pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], scale: [x1 - x0, y1 - y0, z1 - z0], color: c, spec });

/** An upright cylinder from y0 to y1. */
export const cyl = (c: RGB | RGBA, x: number, z: number, y0: number, y1: number, r: number, spec = 0): Part =>
  ({ kind: 'cyl', pos: [x, (y0 + y1) / 2, z], scale: [2 * r, y1 - y0, 2 * r], color: c, spec });

/** A round bar from a to b: a wire, a shaft, a dimension line. */
export function rod(c: RGB | RGBA, a: Vec3, b: Vec3, r: number, spec = 0): Part {
  const d = sub3(b, a), l = len3(d) || 1e-6, u = norm3(d), axis = cross3([0, 1, 0], u), s = len3(axis);
  const rot = s > 1e-6 ? quatAxisAngle(axis, Math.atan2(s, u[1])) : u[1] > 0 ? QUAT_ID : quatAxisAngle([1, 0, 0], Math.PI);
  return { kind: 'cyl', pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], scale: [2 * r, l, 2 * r], rot, color: c, spec };
}

/** The polyline through `pts` as rods. */
export const wire = (c: RGB | RGBA, pts: Vec3[], r: number, spec = 0): Part[] =>
  pts.slice(1).map((p, i) => rod(c, pts[i], p, r, spec));

// ---------------------------------------------------------------- the flat view

export interface FlatFace { pts: [number, number][]; depth: number; color: RGBA }

const LIGHT: Vec3 = norm3([-0.35, 0.8, 0.5]);
const SIDES = 12;

/** A fixed view: world point → x right, y up, depth (larger is nearer). */
export function flatView(yaw: number, pitch: number): (p: Vec3) => [number, number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return ([x, y, z]) => { const X = x * c + z * s, Z = -x * s + z * c; return [X, y * cp - Z * sp, y * sp + Z * cp]; };
}

/** The faces of a part in its own unit coordinates: corners and outward normal. */
function unitFaces(kind: Part['kind']): { v: Vec3[]; n: Vec3 }[] {
  if (kind === 'box') {
    const h = 0.5, q = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3) => ({ v: [a, b, c, d], n });
    return [
      q([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]), q([h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]),
      q([h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h], [1, 0, 0]), q([-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], [-1, 0, 0]),
      q([-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h], [0, 1, 0]), q([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [0, -1, 0]),
    ];
  }
  const out: { v: Vec3[]; n: Vec3 }[] = [], at = (i: number, y: number): Vec3 => { const a = (i * 2 * Math.PI) / SIDES; return [0.5 * Math.cos(a), y, 0.5 * Math.sin(a)]; };
  for (let i = 0; i < SIDES; i++) { const a = ((i + 0.5) * 2 * Math.PI) / SIDES; out.push({ v: [at(i, -0.5), at(i, 0.5), at(i + 1, 0.5), at(i + 1, -0.5)], n: [Math.cos(a), 0, Math.sin(a)] }); }
  const ring = (y: number) => Array.from({ length: SIDES }, (_, i) => at(i, y));
  out.push({ v: ring(0.5), n: [0, 1, 0] }, { v: ring(-0.5), n: [0, -1, 0] });
  return out;
}
const FACES = { box: unitFaces('box'), cyl: unitFaces('cyl') };

/** Every face of `parts` turned towards the view, far ones first, shaded as the 3D view roughly is. */
export function flatFaces(parts: readonly Part[], yaw: number, pitch: number): FlatFace[] {
  const pr = flatView(yaw, pitch), origin = pr([0, 0, 0]), eye = sub3(pr([0, 1, 0]), origin), out: FlatFace[] = [];
  // The direction the viewer looks along, in world space, from where the world axes land.
  const toEye: Vec3 = [pr([1, 0, 0])[2] - origin[2], eye[2], pr([0, 0, 1])[2] - origin[2]];
  for (const p of parts) {
    const s = p.scale ?? [1, 1, 1], r = p.rot ?? QUAT_ID, [cr, cg, cb, ca] = [...p.color, 1] as RGBA, e = p.emissive ?? [0, 0, 0];
    for (const f of FACES[p.kind]) {
      const n = norm3(quatRotate(r, [f.n[0] / s[0], f.n[1] / s[1], f.n[2] / s[2]]));
      if (dot3(n, toEye) <= 0) continue;
      const pts = f.v.map((v): Vec3 => {
        const w = quatRotate(r, [v[0] * s[0], v[1] * s[1], v[2] * s[2]]);
        return pr([w[0] + p.pos[0], w[1] + p.pos[1], w[2] + p.pos[2]]);
      });
      const k = 0.55 + 0.45 * Math.max(0, dot3(n, LIGHT)), lit = (c: number, g: number) => Math.min(1, c * k + g);
      out.push({ pts: pts.map((q): [number, number] => [q[0], q[1]]), depth: pts.reduce((t, q) => t + q[2], 0) / pts.length, color: [lit(cr, e[0]), lit(cg, e[1]), lit(cb, e[2]), ca] });
    }
  }
  return out.sort((a, b) => a.depth - b.depth);
}
