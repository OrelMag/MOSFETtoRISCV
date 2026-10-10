// Unravel and collapse pointers: the same net drawn with wires instead of named pointers, or the
// other way round. Both are pure edits that never change connectivity (the same ports and pins end
// up on the same nets; tests/editor-unravel.test.ts compiles every example before and after).
//
// Unravel: the pointers of one name go and the islands they joined are wired together. The island
// holding the driver is the hub: the wire to the hub's pointer and the wire to the nearest twin's
// pointer become one wire, and every other twin's wire is extended to the nearest point of the net
// wired so far (a branch). Wires that ended on a pointer branch off where it stood.
// Collapse: a drawn wire (with the wires branched from it or it from, one drawn tree) goes, and
// each of its ends gets a short stub to a new pointer, all of one name.
//
// Routing is a cheap search, not a router: square shapes (an L, or a Z through the channels beside
// the parts) scored by the parts, pins and pointers they cross, the ports they would touch and the
// other nets' wires they would run along. The learner tidies the rest by hand.

import type { Rect } from '../view/route';
import { DIR, attachPoints, drives, partBox, pinBody, pointerGeom } from './geom';
import {
  endGeom, endKey, nextId, onPolyline, orthogonal, polyline, straightLine, uniqueName,
  type ChipDoc, type DefOf, type EndRef, type ExitDir, type LabelDoc, type Vec, type WireDoc,
} from './model';
import { nearestOn, type Edited, type Sel } from './ops';

const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + k * b[0], a[1] + k * b[1]];
const eqv = (a: Vec, b: Vec) => a[0] === b[0] && a[1] === b[1];
const manhattan = (a: Vec, b: Vec) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const onLabel = (e: EndRef, id: string) => 'label' in e && e.label === id;

class UF {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = x;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!;
    this.p.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

/** Ids of the wires joined to wire `id` by branches (its hosts and its branches, transitively), `id` first. */
export function wireTree(doc: ChipDoc, id: string): string[] {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  };
  for (const w of doc.wires) for (const e of [w.a, w.b]) if ('wire' in e) link(w.id, e.wire);
  const seen = new Set([id]);
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const n of adj.get(out[i]) ?? []) if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.filter((w) => doc.wires.some((q) => q.id === w));
}

/** Wires drawn joined (at a shared end or by a branch), pointers kept apart: `find('w:<id>')`, `find('lbl:<id>')`. */
function islands(wires: WireDoc[]): UF {
  const uf = new UF();
  for (const w of wires) for (const e of [w.a, w.b]) uf.union(`w:${w.id}`, 'wire' in e ? `w:${e.wire}` : endKey(e));
  return uf;
}

const wiresOn = (doc: ChipDoc, lid: string) => doc.wires.filter((w) => onLabel(w.a, lid) || onLabel(w.b, lid));

/** True when the pointers named `name` can be unravelled: at least two of them have a wire. */
export function canUnravel(doc: ChipDoc, name: string): boolean {
  return doc.labels.filter((l) => l.name === name && wiresOn(doc, l.id).length).length >= 2;
}

/**
 * The names of the pointers a selection touches and that can be unravelled: selected pointers, and
 * the pointers at the ends of the drawn trees of the selected wires and of the wires on selected parts and pins.
 */
export function pointersOf(doc: ChipDoc, sel: Sel): string[] {
  const names = new Set<string>();
  for (const id of sel.labels ?? []) { const l = doc.labels.find((q) => q.id === id); if (l) names.add(l.name); }
  const parts = new Set(sel.parts), pins = new Set(sel.pins);
  const roots = new Set(sel.wires);
  for (const w of doc.wires) {
    if ([w.a, w.b].some((e) => ('part' in e && parts.has(e.part)) || ('pin' in e && pins.has(e.pin)))) roots.add(w.id);
  }
  const done = new Set<string>();
  for (const r of roots) {
    if (done.has(r)) continue;
    for (const id of wireTree(doc, r)) {
      done.add(id);
      const w = doc.wires.find((q) => q.id === id)!;
      for (const e of [w.a, w.b]) if ('label' in e) { const l = doc.labels.find((q) => q.id === e.label); if (l) names.add(l.name); }
    }
  }
  return [...names].filter((n) => canUnravel(doc, n)).sort();
}

// ---------------------------------------------------------------------------------------------
// Routing

type Seg = { a: Vec; b: Vec; wire: string };

/** What a new wire must avoid, built once per unravel: wires only grow, so new routes are just added. */
class Scene {
  boxes: Rect[];
  /** Attach points (ports, pins, pointers) a route must not run through: "x,y". */
  ports: Set<string>;
  /** Horizontal segments of the drawn wires by y, vertical ones by x (slanted ones are never run along). */
  rows = new Map<number, Seg[]>();
  cols = new Map<number, Seg[]>();
  /** Is this wire on the net being wired? (Running along it is only untidy.) */
  same: (wire: string) => boolean = () => false;

  /** `gone`: pointers about to go. */
  constructor(doc: ChipDoc, defOf: DefOf, gone: Set<string>, poly: (w: WireDoc) => Vec[] | null) {
    this.boxes = [
      ...doc.parts.map((p) => partBox(defOf(p), p.at)),
      ...doc.pins.map(pinBody),
      ...doc.labels.filter((l) => !gone.has(l.id)).map((l) => pointerGeom(l).rect),
    ];
    this.ports = new Set(attachPoints(doc, defOf).filter((a) => !('label' in a.end && gone.has(a.end.label))).map((a) => `${a.pos[0]},${a.pos[1]}`));
    for (const w of doc.wires) { const p = poly(w); if (p) this.add(p, w.id); }
  }

  add(path: Vec[], wire: string): void {
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [path[i - 1], path[i]];
      const [m, k] = a[1] === b[1] ? [this.rows, a[1]] : a[0] === b[0] ? [this.cols, a[0]] : [null, 0];
      if (!m) continue;
      const l = m.get(k);
      if (l) l.push({ a, b, wire });
      else m.set(k, [{ a, b, wire }]);
    }
  }
}

const E = 0.1;
/** An axis-aligned segment enters the inside of a rectangle (running along its edge does not). */
function hitsRect(a: Vec, b: Vec, r: Rect): boolean {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return x1 > r.x + E && x0 < r.x + r.w - E && y1 > r.y + E && y0 < r.y + r.h - E;
}

/** Length of the stretch two axis-aligned segments share on one line. */
function overlap(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (a[1] === b[1] && c[1] === d[1] && a[1] === c[1] && a[0] !== b[0] && c[0] !== d[0]) {
    return Math.max(0, Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) - Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])));
  }
  if (a[0] === b[0] && c[0] === d[0] && a[0] === c[0] && a[1] !== b[1] && c[1] !== d[1]) {
    return Math.max(0, Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) - Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])));
  }
  return 0;
}

/** Length plus bends: what cost() adds to a path with nothing in its way. */
function base(path: Vec[]): number {
  let c = 3 * (path.length - 2);
  for (let i = 1; i < path.length; i++) c += manhattan(path[i - 1], path[i]);
  return c;
}

/** Badness of a full polyline: length and bends, plus heavy costs for what a reader would misread. Stops past `limit`. */
function cost(path: Vec[], sc: Scene, limit = Infinity): number {
  let c = base(path);
  const lo: Vec = [Infinity, Infinity], hi: Vec = [-Infinity, -Infinity];
  for (const p of path) { lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]); }
  const boxes = sc.boxes.filter((r) => !(r.x > hi[0] || r.x + r.w < lo[0] || r.y > hi[1] || r.y + r.h < lo[1]));
  const [p0, pn] = [path[0], path[path.length - 1]];
  for (let i = 1; i < path.length && c < limit; i++) {
    const [a, b] = [path[i - 1], path[i]];
    for (const r of boxes) if (hitsRect(a, b, r)) c += 400;
    for (const s of (a[1] === b[1] ? sc.rows.get(a[1]) : sc.cols.get(a[0])) ?? []) {
      const o = overlap(a, b, s.a, s.b);
      if (o) c += (sc.same(s.wire) ? 4 : 60) * o + 20;
    }
    // A port on the way would look connected.
    if (a[1] === b[1]) {
      for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) {
        const q: Vec = [x, a[1]];
        if (!eqv(q, p0) && !eqv(q, pn) && sc.ports.has(`${x},${a[1]}`)) c += 300;
      }
    } else {
      for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) {
        const q: Vec = [a[0], y];
        if (!eqv(q, p0) && !eqv(q, pn) && sc.ports.has(`${a[0]},${y}`)) c += 300;
      }
    }
  }
  return c;
}

/**
 * Interior corners of a square path from p to q. `pd` / `qd`: the direction the wire should leave p
 * and arrive at q from (a pointer's flag side, now free), or null. Returns the path and its cost.
 */
function routeSquare(p: Vec, pd: ExitDir | null, q: Vec, qd: ExitDir | null, sc: Scene, limit = Infinity): { pts: Vec[]; cost: number } {
  const heads: Vec[][] = pd ? [[p], [p, add(p, DIR[pd], 2)]] : [[p]];
  const tails: Vec[][] = qd ? [[q], [add(q, DIR[qd], 2), q]] : [[q]];
  const paths: Vec[][] = [];
  for (const H of heads) {
    for (const T of tails) {
      const [h, t] = [H[H.length - 1], T[0]];
      const [x0, x1, y0, y1] = [Math.min(h[0], t[0]), Math.max(h[0], t[0]), Math.min(h[1], t[1]), Math.max(h[1], t[1])];
      // Channels: beside the parts near the way, and around everything.
      const ys = new Set([h[1], t[1]]), xs = new Set([h[0], t[0]]);
      const m = 12 + Math.max(x1 - x0, y1 - y0) / 2;
      let [gx0, gx1, gy0, gy1] = [x0, x1, y0, y1];
      for (const r of sc.boxes) {
        [gx0, gx1, gy0, gy1] = [Math.min(gx0, r.x), Math.max(gx1, r.x + r.w), Math.min(gy0, r.y), Math.max(gy1, r.y + r.h)];
        if (r.x <= x1 && r.x + r.w >= x0 && r.y + r.h >= y0 - m && r.y <= y1 + m) { ys.add(Math.floor(r.y) - 1); ys.add(Math.ceil(r.y + r.h) + 1); }
        if (r.y <= y1 && r.y + r.h >= y0 && r.x + r.w >= x0 - m && r.x <= x1 + m) { xs.add(Math.floor(r.x) - 1); xs.add(Math.ceil(r.x + r.w) + 1); }
      }
      ys.add(Math.floor(gy0) - 2); ys.add(Math.ceil(gy1) + 2);
      xs.add(Math.floor(gx0) - 2); xs.add(Math.ceil(gx1) + 2);
      paths.push([...H, [t[0], h[1]], ...T], [...H, [h[0], t[1]], ...T]);
      for (const y of ys) paths.push([...H, [h[0], y], [t[0], y], ...T]);
      for (const x of xs) paths.push([...H, [x, h[1]], [x, t[1]], ...T]);
    }
  }
  // Cheapest-looking first: a path's length and bends bound its cost from below.
  const cands = paths.map((r) => orthogonal(r)).map((f) => ({ f, b: base(f) })).sort((a, b) => a.b - b.b);
  let best: { pts: Vec[]; cost: number } = { pts: [], cost: Infinity };
  for (const { f, b } of cands) {
    if (b >= Math.min(best.cost, limit)) break;
    const c = f.length < 2 ? 0 : cost(f, sc, best.cost);
    if (c < best.cost) best = { pts: f.slice(1, -1), cost: c };
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Unravel

/** Does wire `id` branch (directly or through its hosts) off one of `of`? */
function dependsOn(wires: Map<string, WireDoc>, id: string, of: Set<string>, seen = new Set<string>()): boolean {
  if (of.has(id)) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  const w = wires.get(id);
  return !!w && [w.a, w.b].some((e) => 'wire' in e && dependsOn(wires, e.wire, of, seen));
}

/**
 * What is wrong with the wires: a branch off a missing wire, off itself (even through others) or
 * off its wire's line, an end on a missing pointer, both ends on one point. Compared before and
 * after, so a document that already had a fault can still be unravelled elsewhere.
 */
function faults(doc: ChipDoc, defOf: DefOf, polys: (w: WireDoc) => Vec[] | null): Set<string> {
  const out = new Set<string>();
  const wires = new Map(doc.wires.map((w) => [w.id, w]));
  const labels = new Set(doc.labels.map((l) => l.id));
  for (const w of doc.wires) {
    for (const e of [w.a, w.b]) {
      if ('label' in e && !labels.has(e.label)) out.add(`${w.id} to a missing pointer`);
      if (!('wire' in e)) continue;
      const host = wires.get(e.wire);
      if (!host || dependsOn(wires, e.wire, new Set([w.id]))) out.add(`${w.id} in a loop of branches`);
      const poly = host && polys(host);
      if (poly && !onPolyline(poly, e.at)) out.add(`${w.id} off ${e.wire} at ${e.at}`);
    }
    if (endKey(w.a) === endKey(w.b)) out.add(`${w.id} ends where it starts`);
  }
  return out;
}

/**
 * Replaces the pointers named `name` by wires (see the top of the file). Refused (document
 * unchanged, with a reason) when fewer than two of them have a wire.
 */
export function unravelPointer(doc: ChipDoc, name: string, defOf: DefOf): Edited & { wires?: string[] } {
  const labels = doc.labels.filter((l) => l.name === name);
  const ids = new Set(labels.map((l) => l.id));
  const onName = (e: EndRef) => 'label' in e && ids.has(e.label);
  // A wire between two of these pointers joins nothing new: it goes.
  const loops = new Set(doc.wires.filter((w) => onName(w.a) && onName(w.b)).map((w) => w.id));
  if (doc.wires.some((w) => !loops.has(w.id) && [w.a, w.b].some((e) => 'wire' in e && loops.has(e.wire)))) {
    return { doc, reason: `a wire branches off a wire between two “${name}” pointers` };
  }
  const kept = doc.wires.filter((w) => !loops.has(w.id));
  const att = new Map(labels.map((l) => [l.id, kept.filter((w) => onLabel(w.a, l.id) || onLabel(w.b, l.id))]));
  const wired = labels.filter((l) => att.get(l.id)!.length);
  if (wired.length < 2) return { doc, reason: `“${name}” has no twin with a wire to join` };

  const uf = islands(kept);
  const far = (w: WireDoc, lid: string): EndRef => (onLabel(w.a, lid) ? w.b : w.a);
  const driven = new Set(kept.filter((w) => [w.a, w.b].some((e) => drives(doc, e, defOf))).map((w) => uf.find(`w:${w.id}`)));
  const hub = wired.find((l) => driven.has(uf.find(`lbl:${l.id}`))) ?? wired[0];
  // The wire that carries a pointer's island to the rest: towards a driver, else a real end, not a branch.
  const carrier = (l: LabelDoc): WireDoc => {
    const ws = att.get(l.id)!;
    return ws.find((w) => drives(doc, far(w, l.id), defOf)) ?? ws.find((w) => !('wire' in far(w, l.id))) ?? ws[0];
  };
  const rest = wired.filter((l) => l !== hub).sort((a, b) => manhattan(a.at, hub.at) - manhattan(b.at, hub.at));
  const wh = carrier(hub);
  const second = rest.find((l) => {
    const w2 = carrier(l);
    const [fh, f2] = [far(wh, hub.id), far(w2, l.id)];
    return w2 !== wh && endKey(fh) !== endKey(f2) && !('wire' in fh && fh.wire === w2.id) && !('wire' in f2 && f2.wire === wh.id);
  });
  if (!second) return { doc, reason: `the “${name}” pointers sit on one wire` };
  const order = [second, ...rest.filter((l) => l !== second)];

  // The document being rewritten (the pointers stay until the end: their positions still resolve,
  // and nothing else moves, so a wire's polyline is cached by its object).
  let cur: ChipDoc = { ...doc, wires: kept };
  const byId = () => new Map(cur.wires.map((w) => [w.id, w]));
  const mapEnds = (f: (e: EndRef, w: WireDoc) => EndRef) => {
    cur = { ...cur, wires: cur.wires.map((w) => { const [a, b] = [f(w.a, w), f(w.b, w)]; return a === w.a && b === w.b ? w : { ...w, a, b }; }) };
  };
  const polys = new WeakMap<WireDoc, Vec[] | null>();
  const poly = (w: WireDoc) => {
    let p = polys.get(w);
    if (p === undefined) polys.set(w, (p = polyline(cur, w, defOf)));
    return p;
  };
  const connected = new Set([uf.find(`lbl:${hub.id}`), uf.find(`lbl:${second.id}`)]);
  const sameNet = (wid: string) => connected.has(uf.find(`w:${wid}`));
  const touched: string[] = [];
  const named = kept.some((w) => w.name && connected.has(uf.find(`w:${w.id}`)));
  const sc = new Scene(cur, defOf, ids, poly);
  sc.same = sameNet;

  // Hub and nearest twin: their two wires become one, through a square path between the pointers.
  {
    const w2 = carrier(second);
    let ph = poly(wh), p2 = poly(w2);
    if (!ph || !p2) return { doc, reason: `a wire to a “${name}” pointer does not resolve` };
    if (onLabel(wh.a, hub.id)) ph = [...ph].reverse(); // ends at the hub
    if (onLabel(w2.b, second.id)) p2 = [...p2].reverse(); // starts at the twin
    const r = routeSquare(hub.at, hub.face ?? 'right', second.at, second.face ?? 'right', sc);
    sc.add([hub.at, ...r.pts, second.at], wh.id);
    const straight = !!(wh.straight || w2.straight);
    const fa = far(wh, hub.id), fb = far(w2, second.id);
    const full = (straight ? straightLine : orthogonal)([...ph, ...r.pts, ...p2]);
    const merged: WireDoc = { id: wh.id, a: fa, b: fb, pts: full.slice(1, -1) };
    if (straight) merged.straight = true;
    const nm = wh.name ?? w2.name ?? (named ? undefined : name);
    if (nm) merged.name = nm;
    if (wh.cap || w2.cap) merged.cap = true;
    const init = wh.init ?? w2.init;
    if (init !== undefined) merged.init = init;
    cur = { ...cur, wires: cur.wires.filter((w) => w.id !== w2.id).map((w) => (w.id === wh.id ? merged : w)) };
    mapEnds((e) => ('wire' in e && e.wire === w2.id ? { wire: wh.id, at: e.at }
      : onLabel(e, hub.id) ? { wire: wh.id, at: hub.at }
      : onLabel(e, second.id) ? { wire: wh.id, at: second.at } : e));
    touched.push(wh.id);
  }

  // Every other twin: its wire runs on to the nearest point of the net wired so far.
  for (const l of order.slice(1)) {
    const wi = byId().get(carrier(l).id)!;
    const own = new Set(att.get(l.id)!.map((w) => w.id));
    const wires = byId();
    const cands: { wire: string; at: Vec }[] = [];
    for (const t of cur.wires) {
      if (!sameNet(t.id) || dependsOn(wires, t.id, own)) continue;
      const p = poly(t);
      if (!p) continue;
      cands.push({ wire: t.id, at: nearestOn(p, l.at) });
      for (const v of p) cands.push({ wire: t.id, at: v });
    }
    cands.sort((a, b) => manhattan(a.at, l.at) - manhattan(b.at, l.at));
    sc.same = (wid) => sameNet(wid) || own.has(wid);
    let best: { wire: string; at: Vec; pts: Vec[]; cost: number } | null = null;
    for (const c of cands.slice(0, 8)) {
      if (best && manhattan(c.at, l.at) >= best.cost) break;
      const r = routeSquare(l.at, l.face ?? 'right', c.at, null, sc, best?.cost);
      if (!best || r.cost < best.cost) best = { ...c, ...r };
    }
    sc.same = sameNet;
    if (!best) return { doc, reason: `no wire of the net to join “${name}” to` };
    sc.add([l.at, ...best.pts, best.at], wi.id);
    let pi = poly(wi);
    if (!pi) return { doc, reason: `a wire to a “${name}” pointer does not resolve` };
    const atA = onLabel(wi.a, l.id);
    if (atA) pi = [...pi].reverse(); // ends at the pointer
    const full = (wi.straight ? straightLine : orthogonal)([...pi, ...best.pts, best.at]);
    const branch: EndRef = { wire: best.wire, at: best.at };
    const pts = full.slice(1, -1);
    const next: WireDoc = atA ? { ...wi, a: branch, pts: [...pts].reverse() } : { ...wi, b: branch, pts };
    cur = { ...cur, wires: cur.wires.map((w) => (w.id === wi.id ? next : w)) };
    mapEnds((e) => (onLabel(e, l.id) ? { wire: wi.id, at: l.at } : e));
    connected.add(uf.find(`lbl:${l.id}`));
    touched.push(wi.id);
  }

  const out: ChipDoc = { ...cur, labels: doc.labels.filter((l) => !ids.has(l.id)) };
  const had = faults(doc, defOf, (w) => polyline(doc, w, defOf));
  if ([...faults(out, defOf, poly)].some((f) => !had.has(f))) return { doc, reason: `“${name}” could not be unravelled without a loop of branches` };
  return { doc: out, wires: touched };
}

/** unravelPointer for several names, one after the other; the reasons of those refused, joined. */
export function unravelPointers(doc: ChipDoc, names: string[], defOf: DefOf): Edited & { wires: string[] } {
  let out = doc;
  const why: string[] = [];
  const wires: string[] = [];
  for (const n of names) {
    const r = unravelPointer(out, n, defOf);
    if (r.reason) why.push(r.reason);
    else { out = r.doc; wires.push(...r.wires!); }
  }
  return why.length ? { doc: out, reason: why.join('; '), wires } : { doc: out, wires };
}

// ---------------------------------------------------------------------------------------------
// Collapse

/** Ends of a drawn tree other than branch points, once each. */
function treeEnds(doc: ChipDoc, tree: string[]): EndRef[] {
  const out = new Map<string, EndRef>();
  for (const id of tree) {
    const w = doc.wires.find((q) => q.id === id)!;
    for (const e of [w.a, w.b]) if (!('wire' in e)) out.set(endKey(e), e);
  }
  return [...out.values()];
}

/**
 * The name to offer for collapsing wire `id`: the pointer its tree already reaches, else a net
 * name on it, else the driver's (a pin's name, `<part>_<port>`), made unique among the pointers.
 */
export function suggestName(doc: ChipDoc, id: string, defOf: DefOf): string {
  const tree = wireTree(doc, id);
  const ends = treeEnds(doc, tree);
  for (const e of ends) if ('label' in e) { const l = doc.labels.find((q) => q.id === e.label); if (l) return l.name; }
  const taken = doc.labels.map((l) => l.name);
  const wn = tree.map((t) => doc.wires.find((w) => w.id === t)?.name).find((n) => n);
  if (wn) return uniqueName(wn, taken);
  const d = ends.find((e) => drives(doc, e, defOf)) ?? ends.find((e) => 'pin' in e);
  const base = !d ? 'net' : 'pin' in d ? doc.pins.find((p) => p.id === d.pin)!.name : 'part' in d ? `${d.part}_${d.port}` : 'net';
  return uniqueName(base, taken);
}

/**
 * Collapses wire `id` with its drawn tree to pointers named `name`: one per end (a port, a pin),
 * on a short stub pointing away from it. The tree's own pointers stay. Refused when the name
 * belongs to another net, or the tree reaches a pointer of another name.
 */
export function collapseWire(doc: ChipDoc, id: string, name: string, defOf: DefOf): Edited & { labels?: string[]; wires?: string[] } {
  const nm = name.trim();
  if (!nm) return { doc, reason: 'a pointer needs a name' };
  if (!doc.wires.some((w) => w.id === id)) return { doc, reason: `no wire '${id}'` };
  const tree = wireTree(doc, id);
  const ends = treeEnds(doc, tree);
  const own = new Set(ends.flatMap((e) => ('label' in e ? [doc.labels.find((l) => l.id === e.label)?.name ?? ''] : [])));
  const other = [...own].find((n) => n !== nm);
  if (other !== undefined) return { doc, reason: `this wire already reaches pointer “${other}”: collapse it under that name` };
  if (!own.size && doc.labels.some((l) => l.name === nm)) return { doc, reason: `“${nm}” is already a pointer of another net` };
  const real = ends.filter((e) => !('label' in e));
  if (!real.length) return { doc, reason: 'nothing on this wire to point from' };

  const gone = new Set(tree);
  const wires = doc.wires.filter((w) => !gone.has(w.id));
  const old = doc.wires.filter((w) => gone.has(w.id));
  const boxes: Rect[] = [...doc.parts.map((p) => partBox(defOf(p), p.at)), ...doc.pins.map(pinBody), ...doc.labels.map((l) => pointerGeom(l).rect)];
  const labels = [...doc.labels];
  const newLabels: string[] = [], newWires: string[] = [];
  const lids = new Set(labels.map((l) => l.id)), wids = new Set(doc.wires.map((w) => w.id));
  for (const e of real) {
    const g = endGeom(doc, e, defOf);
    if (!g) return { doc, reason: `${endKey(e)} does not resolve` };
    const face: ExitDir = g.exit ?? 'right';
    // The nearest spot out along the port's axis where the flag and its stub hit nothing.
    let at = add(g.pos, DIR[face], 2);
    for (const k of [2, 3, 4, 5, 6]) {
      const p = add(g.pos, DIR[face], k);
      const rect = pointerGeom({ at: p, face, name: nm }).rect;
      const clash = (r: Rect) => hitsRect(g.pos, p, r) || (rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y);
      if (!boxes.some(clash)) { at = p; break; }
    }
    const lid = nextId('l', lids);
    lids.add(lid);
    const l: LabelDoc = { id: lid, name: nm, at, face };
    labels.push(l);
    boxes.push(pointerGeom(l).rect);
    const wid = nextId('w', wids);
    wids.add(wid);
    const w: WireDoc = { id: wid, a: e, b: { label: lid }, pts: [] };
    // A stored charge or power-on value belongs to the net: the first stub carries it.
    if (!newWires.length) {
      if (old.some((q) => q.cap)) w.cap = true;
      const init = old.find((q) => q.init !== undefined)?.init;
      if (init !== undefined) w.init = init;
    }
    wires.push(w);
    newLabels.push(lid);
    newWires.push(wid);
  }
  return { doc: { ...doc, wires, labels }, labels: newLabels, wires: newWires };
}

/** Collapses each drawn tree among `ids` under its suggested name. */
export function collapseWires(doc: ChipDoc, ids: string[], defOf: DefOf): Edited & { labels: string[] } {
  let out = doc;
  const why: string[] = [];
  const labels: string[] = [];
  const done = new Set<string>();
  for (const id of ids) {
    if (done.has(id) || !out.wires.some((w) => w.id === id)) continue;
    for (const t of wireTree(out, id)) done.add(t);
    const r = collapseWire(out, id, suggestName(out, id, defOf), defOf);
    if (r.reason) why.push(r.reason);
    else { out = r.doc; labels.push(...r.labels!); }
  }
  return why.length ? { doc: out, reason: why.join('; '), labels } : { doc: out, labels };
}
