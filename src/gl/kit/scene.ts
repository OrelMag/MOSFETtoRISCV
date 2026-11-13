// A studio model (DOM-free): items (a geometry, a material, a place, what it is), cut planes, the tour's beats, labels.
// The stage (widgets/studiostage.ts) draws it on gl/studio.ts, or flat in SVG; picking is a ray against the items'
// triangles here, so what a hover names can be tested in Node.

import { cross3, dot3, mat4Mul, quatRotate, sub3, type Mat4, type Quat, type Vec3 } from '../math';
import type { Anchor } from '../parts';
import type { OrbitView } from '../camera';
import type { Geo } from './geo';
import type { Colour, Material } from './materials';

export interface ItemInfo { dim?: string; source?: string; note?: string }

export interface Item {
  geo: Geo;
  mat: Material;
  at?: Vec3; rot?: Quat; scale?: Vec3;
  /** Hover and Tab name it; items sharing a name are one part (both halves of a plate). */
  name?: string;
  info?: ItemInfo;
  /** For explode, highlight and the tour. */
  group?: string;
  /** Where it goes at explode = 1 (added to `at`). */
  explode?: Vec3;
  /** What the model's cuts do to it: cut and capped (default), cut open (a thin shell: no cap), or untouched. */
  cut?: 'section' | 'open' | 'none';
  /** Casts a shadow (default: unless it is glass). */
  shadow?: boolean;
  /** See-through items are drawn far to near; a lower order draws first whatever the distance (nested layers). */
  order?: number;
}

/** A light a hot or lit part gives off onto its neighbours: no shadow, falling off over `range`. */
export interface GlowLight {
  p: Vec3;
  colour: Colour;
  /** Linear intensity at the source (heatGlow of the part's temperature, say). */
  power: number;
  range: number;
  /** Rides with this item or group when the model explodes. */
  on?: string;
}

/** A cut: the side where n·p > d is removed; with two, only where both say so (a quarter section). */
export interface Cut { n: Vec3; d: number }

export interface Beat {
  title: string; text: string;
  /** The view's direction (yaw, pitch); its target and distance too unless `frame` is given. */
  view: OrbitView;
  /** Fit these groups or names to the canvas (a small margin), from the view's direction. */
  frame?: string[];
  /** Groups or names lit; the rest dimmed. Absent: everything. */
  show?: string[];
  /** Groups or names hidden in this beat (a level of detail, a second variant). */
  hide?: string[];
  explode?: number;
  /** The cut's position 0 (none) … 1 (fully open). */
  cut?: number;
  /** false: no names in this beat (a view where they would only clutter, a field of copies). */
  labels?: boolean;
}

export interface StudioAnchor extends Anchor {
  /** Follows this item (by name or group) when the model explodes. */
  on?: string;
  /** Shown only in views from below (pins). */
  under?: boolean;
  /** The studio stage puts a name in the gutter nearer its point (`side` is only modelStage's); this forces one. */
  gutter?: 'l' | 'r';
}

export interface Model3 {
  items: Item[];
  /** The cut at full opening; the stage scales `d` from `open` (nothing cut) to the given value. */
  cuts?: { planes: Cut[]; open: number[] };
  anchors?: StudioAnchor[];
  beats?: Beat[];
  /** A floor that catches the shadow at this height (absent: below the lowest point). */
  floor?: number;
  lights?: GlowLight[];
  /** The model's look on the studio (phase 0's per-model data, and any model's): exposure, key-light direction. */
  look?: { exposure?: number; keyDir?: Vec3; haze?: { colour: Colour; dist: number } };
  /** The flat (SVG) drawing's painter's order: per triangle (default), or whole items back to front by their farthest point,
   *  then the triangles within each: for a model of separate layers (stacked platters, thin overlays on a face). */
  flatOrder?: 'faces' | 'items';
}

export interface Knobs { explode: number; cut: number }

/** Parts moved by the physics this frame (an armature's swing, a rotor's step), by name or group: applied after the
 *  item's own placement, so a part pivots about where it is drawn. */
export type Moves = ReadonlyMap<string, Mat4>;
const moveOf = (it: Item, moves?: Moves): Mat4 | undefined => moves && ((it.name && moves.get(it.name)) || (it.group && moves.get(it.group)) || undefined);

/** An item's offset at explode k (eased, so parts start and stop gently). */
export function explodeOffset(it: Item, k: number): Vec3 {
  const e = it.explode;
  if (!e || k <= 0) return [0, 0, 0];
  const s = k * k * (3 - 2 * k);
  return [e[0] * s, e[1] * s, e[2] * s];
}

/** The item's model matrix (column-major) at explode k. */
export function itemMatrix(it: Item, k: number, out: Mat4 = new Float32Array(16), moves?: Moves): Mat4 {
  const mv = moveOf(it, moves);
  if (mv) { const m = itemMatrix(it, k); out.set(mat4Mul(mv, m)); return out; }
  const [qx, qy, qz, qw] = it.rot ?? [0, 0, 0, 1], [sx, sy, sz] = it.scale ?? [1, 1, 1], o = explodeOffset(it, k), a = it.at ?? [0, 0, 0];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  out[0] = (1 - 2 * (yy + zz)) * sx; out[1] = 2 * (xy + wz) * sx; out[2] = 2 * (xz - wy) * sx; out[3] = 0;
  out[4] = 2 * (xy - wz) * sy; out[5] = (1 - 2 * (xx + zz)) * sy; out[6] = 2 * (yz + wx) * sy; out[7] = 0;
  out[8] = 2 * (xz + wy) * sz; out[9] = 2 * (yz - wx) * sz; out[10] = (1 - 2 * (xx + yy)) * sz; out[11] = 0;
  out[12] = a[0] + o[0]; out[13] = a[1] + o[1]; out[14] = a[2] + o[2]; out[15] = 1;
  return out;
}

export const applyMat = (m: Mat4, p: Vec3): Vec3 =>
  [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

/** The cut planes at opening c (0 nothing cut … 1 the model's full cut). */
export function cutsAt(m: Model3, c: number): Cut[] {
  if (!m.cuts || c <= 0) return [];
  return m.cuts.planes.map((p, i) => ({ n: p.n, d: m.cuts!.open[i] + (p.d - m.cuts!.open[i]) * c }));
}

/** Is a point removed by the cuts? */
export const isCut = (cuts: readonly Cut[], p: Vec3) => cuts.length > 0 && cuts.every((c) => dot3(c.n, p) > c.d);

/** The world bounds of the model at explode k. */
export function boundsOf(m: Model3, k = 0): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity], M = new Float32Array(16);
  for (const it of m.items) {
    itemMatrix(it, k, M);
    for (const x of [it.geo.min[0], it.geo.max[0]]) for (const y of [it.geo.min[1], it.geo.max[1]]) for (const z of [it.geo.min[2], it.geo.max[2]]) {
      const p = applyMat(M, [x, y, z]);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
    }
  }
  return { min, max };
}

export interface Hit { item: Item; index: number; t: number; p: Vec3 }

/** The nearest item a ray meets (origin o, direction d), cut parts skipped where cut, glass skipped unless `glass`. */
export function pick(m: Model3, o: Vec3, d: Vec3, k: Knobs, opts: { glass?: boolean; moves?: Moves; hidden?: ReadonlySet<string> } = {}): Hit | null {
  const cuts = cutsAt(m, k.cut), M = new Float32Array(16);
  let best: Hit | null = null;
  m.items.forEach((it, index) => {
    if (!it.name) return;
    if (!opts.glass && (it.mat.transmit ?? 0) > 0.5) return;
    if (opts.hidden && ((it.name && opts.hidden.has(it.name)) || (it.group && opts.hidden.has(it.group)))) return;
    itemMatrix(it, k.explode, M, opts.moves);
    // the ray in the item's world box first
    const { min, max } = worldBox(it, M);
    if (!rayBox(o, d, min, max, best?.t ?? Infinity)) return;
    const P = it.geo.positions, I = it.geo.indices, cutThis = (it.cut ?? 'section') !== 'none' && cuts.length > 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = applyMat(M, [P[3 * I[t]], P[3 * I[t] + 1], P[3 * I[t] + 2]]);
      const b = applyMat(M, [P[3 * I[t + 1]], P[3 * I[t + 1] + 1], P[3 * I[t + 1] + 2]]);
      const c = applyMat(M, [P[3 * I[t + 2]], P[3 * I[t + 2] + 1], P[3 * I[t + 2] + 2]]);
      const hit = rayTri(o, d, a, b, c);
      if (hit === null || (best && hit >= best.t)) continue;
      const p: Vec3 = [o[0] + d[0] * hit, o[1] + d[1] * hit, o[2] + d[2] * hit];
      if (cutThis && isCut(cuts, p)) continue;
      best = { item: it, index, t: hit, p };
    }
  });
  return best;
}

function worldBox(it: Item, M: Mat4): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [it.geo.min[0], it.geo.max[0]]) for (const y of [it.geo.min[1], it.geo.max[1]]) for (const z of [it.geo.min[2], it.geo.max[2]]) {
    const p = applyMat(M, [x, y, z]);
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  }
  return { min, max };
}

function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, tMax: number): boolean {
  let t0 = 0, t1 = tMax;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < min[a] || o[a] > max[a]) return false; continue; }
    let ta = (min[a] - o[a]) / d[a], tb = (max[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** Möller–Trumbore, both faces. */
function rayTri(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub3(b, a), e2 = sub3(c, a), p = cross3(d, e2), det = dot3(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det, s = sub3(o, a), u = dot3(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross3(s, e1), v = dot3(d, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot3(e2, q) * inv;
  return t > 1e-6 ? t : null;
}

/** An anchor's point at explode k (it rides with its item). */
export function anchorAt(m: Model3, a: StudioAnchor, k: number, moves?: Moves): Vec3 {
  if (!a.on) return a.p;
  const it = m.items.find((i) => i.name === a.on || i.group === a.on);
  if (!it) return a.p;
  // a moved part carries its label (the move is about where the part is drawn, before the explode's offset)
  const mv = moveOf(it, moves), p = mv ? applyMat(mv, a.p) : a.p;
  if (k <= 0) return p;
  const o = explodeOffset(it, k);
  return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
}

export { quatRotate };

/** The bounds of the items named (by name or group) at explode k, or of all of them. */
export function boundsOfNamed(m: Model3, names: readonly string[] | undefined, k = 0): { min: Vec3; max: Vec3 } {
  if (!names?.length) return boundsOf(m, k);
  const set = new Set(names);
  return boundsOf({ items: m.items.filter((i) => (i.name && set.has(i.name)) || (i.group && set.has(i.group))) }, k);
}

/** The target and distance that fit a box to a view from (yaw, pitch) with vertical field of view fov and aspect w / h,
 *  leaving `margin` (a fraction of the half-size) on every side. */
export function fitView(box: { min: Vec3; max: Vec3 }, yaw: number, pitch: number, fov: number, aspect: number, margin = 0.08): { target: Vec3; dist: number } {
  const c: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const r: Vec3 = [cy, 0, -sy], u: Vec3 = [-sp * sy, cp, -sp * cy], f: Vec3 = [cp * sy, sp, cp * cy]; // f: towards the eye
  const ty = Math.tan(fov / 2) * (1 - margin), tx = ty * aspect;
  let dist = 0;
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const q = sub3([x, y, z], c), a = dot3(q, r), b = dot3(q, u), z0 = dot3(q, f);
    dist = Math.max(dist, z0 + Math.abs(a) / tx, z0 + Math.abs(b) / ty);
  }
  return { target: c, dist };
}

/** How wide the model looks from (yaw, pitch): its projected width over height (the stage picks its aspect from it). */
export function aspectOf(box: { min: Vec3; max: Vec3 }, yaw: number, pitch: number): number {
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const r: Vec3 = [cy, 0, -sy], u: Vec3 = [-sp * sy, cp, -sp * cy];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    const a = dot3([x, y, z], r), b = dot3([x, y, z], u);
    x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b);
  }
  return (x1 - x0) / Math.max(1e-9, y1 - y0);
}
