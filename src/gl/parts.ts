// What a model's parts are made of (DOM-free, so a model's geometry can be tested): boxes and cylinders as renderer
// instances (the old renderer's figures, and kits that read parts by role), and the flat view the studio stage's SVG
// fallback projects with.

import type { Instance, RGB, RGBA } from './instances';
import { cross3, len3, norm3, QUAT_ID, quatAxisAngle, sub3, type Vec3 } from './math';

export interface Part extends Instance { kind: 'box' | 'cyl' }

/** A label: where it points, which side its text sits on, and the way the labelled face looks (dimmed when that
 *  face turns away from the camera: the label would otherwise float over whatever hides it). */
export interface Anchor {
  text: string; p: Vec3; side: 'l' | 'r' | 't' | 'b'; n: Vec3; minor?: boolean;
  /** Which label gives way when two cannot both be shown (lower is kept); absent: the order the model lists them. */
  prio?: number;
}

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

/** A fixed view: world point → x right, y up, depth (larger is nearer), seen from where OrbitCamera.eye() puts the eye at
 *  this yaw and pitch: (sin yaw, cos yaw) in xz, so depth runs along that and right along (cos yaw, −sin yaw). */
export function flatView(yaw: number, pitch: number): (p: Vec3) => [number, number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return ([x, y, z]) => { const X = x * c - z * s, Z = x * s + z * c; return [X, y * cp - Z * sp, y * sp + Z * cp]; };
}
