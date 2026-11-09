// The Cut tool's edit (ONI's Disconnect, docs/PLAN-ONI.md A): a line dragged across the canvas cuts every wire it
// crosses, at the crossing. Pure, like ops.ts: a new document sharing what it did not change, or the input itself.
//
// The model has no free wire ends, so a cut wire cannot simply be split in two. Each side of the cut:
//  - holds no branch (no other wire ends on it): it goes;
//  - holds branches: it is merged into the branch nearest the cut. The trunk from its far end up to that branch point
//    plus the branch become one wire (it keeps the branch's id, so the branch's own branches stay put), and every other
//    branch on that side is re-pointed at it. Its points are the drawn polylines, so nothing moves on screen.
// So everything on one side stays connected to everything else on that side, nothing crosses the cut, and no wire on
// the far side of a branch is ever removed (deleteSel cascades to branches: the cut never does). Pointers are not cut.

import { type ChipDoc, type DefOf, type EndRef, onSegment, polyline, type Vec, type WireDoc } from './model';
import { segmentCrossings } from './geom';
import { nearestOn, type Edited } from './ops';

const EPS = 1e-6;
const same = (p: Vec, q: Vec) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;

/** Arc length along the polyline to p (the first segment holding it), or null when p is not on it. */
function along(poly: Vec[], p: Vec): number | null {
  let s = 0;
  for (let i = 1; i < poly.length; i++) {
    const [a, b] = [poly[i - 1], poly[i]];
    if (onSegment(a, b, p)) return s + Math.hypot(p[0] - a[0], p[1] - a[1]);
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return null;
}

/** The polyline's points before arc length t, then the point at t. */
function prefix(poly: Vec[], t: number, at: Vec): Vec[] {
  const out: Vec[] = [poly[0]];
  let s = 0;
  for (let i = 1; i < poly.length; i++) {
    s += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    if (s < t - EPS) out.push(poly[i]);
    else break;
  }
  if (!same(out[out.length - 1], at)) out.push(at);
  return out;
}

const onWire = (e: EndRef, id: string): e is { wire: string; at: Vec } => 'wire' in e && e.wire === id;

/** True when p is on the wire's polyline and not at either end (where a cut would only touch a pin or a port). */
function inside(poly: Vec[] | null, p: Vec): boolean {
  if (!poly || poly.length < 2 || same(p, poly[0]) || same(p, poly[poly.length - 1])) return false;
  for (let i = 1; i < poly.length; i++) if (onSegment(poly[i - 1], poly[i], p)) return true;
  return false;
}

/**
 * Cuts wire `id` at point c of its polyline. Refused (reason) when c is not inside the wire or sits exactly on a
 * branch point (which side the branch is on would be a guess).
 */
export function cutWireAt(doc: ChipDoc, id: string, c: Vec, defOf: DefOf): Edited {
  const w = doc.wires.find((x) => x.id === id);
  const poly = w && polyline(doc, w, defOf);
  if (!w || !poly) return { doc, reason: 'no such wire' };
  if (!inside(poly, c)) return { doc, reason: 'a cut must cross the wire, not touch its end' };
  const tc = along(poly, c)!;
  type Branch = { w: WireDoc; end: 'a' | 'b'; at: Vec; t: number };
  const branches: Branch[] = [];
  for (const x of doc.wires) {
    if (x.id === id) continue;
    for (const end of ['a', 'b'] as const) {
      const e = x[end];
      if (!onWire(e, id)) continue;
      const t = along(poly, e.at);
      if (t === null) continue;
      if (Math.abs(t - tc) < EPS) return { doc, reason: 'the cut is on a junction: cut either side of it' };
      branches.push({ w: x, end, at: e.at, t });
    }
  }
  // One side's merge: the branch nearest the cut absorbs the trunk from the side's far end.
  const merge = (side: Branch[], fromA: boolean): { wire: WireDoc; absorbed: string } | null => {
    if (!side.length) return null;
    const near = side.reduce((m, x) => (fromA ? (x.t > m.t ? x : m) : x.t < m.t ? x : m));
    const bw = near.w;
    const bpoly = polyline(doc, bw, defOf);
    if (!bpoly) return null;
    const branchFromJoint = near.end === 'a' ? bpoly : [...bpoly].reverse(); // starts at the branch point
    const other = near.end === 'a' ? bw.b : bw.a;
    let pts: Vec[];
    let a: EndRef, b: EndRef;
    if (fromA) { // W.a … joint, then out along the branch
      pts = [...prefix(poly, near.t, near.at), ...branchFromJoint.slice(1)];
      [a, b] = [w.a, other];
    } else { // out along the branch back to the joint, then the trunk on to W.b
      const rev = [...poly].reverse();
      const total = along(rev, rev[rev.length - 1])!;
      const tail = prefix(rev, total - near.t, near.at).reverse();
      pts = [...[...branchFromJoint].reverse(), ...tail.slice(1)];
      [a, b] = [other, w.b];
    }
    const straight = w.straight || bw.straight;
    const merged: WireDoc = { id: bw.id, a, b, pts: pts.slice(1, -1).map((p): Vec => [p[0], p[1]]) };
    if (straight) merged.straight = true;
    const hue = bw.hue ?? w.hue, name = bw.name ?? (fromA ? w.name : undefined);
    const cap = bw.cap ?? w.cap, init = bw.init ?? w.init;
    if (hue !== undefined) merged.hue = hue;
    if (name !== undefined) merged.name = name;
    if (cap !== undefined) merged.cap = cap;
    if (init !== undefined) merged.init = init;
    return { wire: merged, absorbed: bw.id };
  };
  const sideA = branches.filter((x) => x.t < tc), sideB = branches.filter((x) => x.t > tc);
  const ma = merge(sideA, true), mb = merge(sideB, false);
  if ((sideA.length && !ma) || (sideB.length && !mb)) return { doc, reason: 'a branch of this wire does not resolve' };
  // a wire whose both ends sit on W (a loop back onto itself) cannot be both branches: refuse rather than guess
  if (ma && mb && ma.absorbed === mb.absorbed) return { doc, reason: 'a wire loops back onto this one: cut it on either side' };
  const repoint = (e: EndRef): EndRef => {
    if (!onWire(e, id)) return e;
    const t = along(poly, e.at)!;
    return { wire: t < tc ? ma!.absorbed : mb!.absorbed, at: e.at };
  };
  const wires: WireDoc[] = [];
  for (const x of doc.wires) {
    if (x.id === id) continue;
    if (ma && x.id === ma.absorbed) { wires.push(ma.wire); continue; }
    if (mb && x.id === mb.absorbed) { wires.push(mb.wire); continue; }
    const a = repoint(x.a), b = repoint(x.b);
    wires.push(a === x.a && b === x.b ? x : { ...x, a, b });
  }
  return { doc: { ...doc, wires } };
}

/** The wires the segment a–b crosses, each with its crossing points (the drag's preview). */
export function cutCrossings(doc: ChipDoc, a: Vec, b: Vec, defOf: DefOf): Map<string, Vec[]> {
  const out = new Map<string, Vec[]>();
  for (const w of doc.wires) {
    const poly = polyline(doc, w, defOf);
    if (!poly) continue;
    const xs = segmentCrossings(poly, a, b);
    if (xs.length) out.set(w.id, xs);
  }
  return out;
}

/**
 * Cuts every wire the segment a–b crosses, at each crossing (one edit, one undo step). A wire crossed twice is cut
 * twice; a crossing that lands on a junction is skipped. `cut`: how many cuts were made.
 */
export function cutWires(doc: ChipDoc, a: Vec, b: Vec, defOf: DefOf): Edited & { cut: number } {
  const pending = [...cutCrossings(doc, a, b, defOf).values()].flat();
  let cur = doc, cut = 0;
  // Each cut rewrites a few wires (a merged side keeps its points), so every crossing is looked up again on the
  // current document: it may now lie on a merged wire, or on nothing if its side went.
  for (let progress = true; progress && pending.length;) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const w = cur.wires.find((x) => inside(polyline(cur, x, defOf), p));
      if (!w) { pending.splice(i--, 1); continue; }
      const r = cutWireAt(cur, w.id, p, defOf);
      pending.splice(i--, 1);
      if (r.reason) continue;
      cur = r.doc; cut++; progress = true;
    }
  }
  return cut ? { doc: cur, cut } : { doc, cut: 0, reason: 'the line crosses no wire' };
}

/** A click with the tool: cut the wire at the point of it nearest p. */
export function cutWireNear(doc: ChipDoc, id: string, p: Vec, defOf: DefOf): Edited {
  const w = doc.wires.find((x) => x.id === id);
  const poly = w && polyline(doc, w, defOf);
  return poly ? cutWireAt(doc, id, nearestOn(poly, p), defOf) : { doc, reason: 'no such wire' };
}
