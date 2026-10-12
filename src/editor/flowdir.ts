// Which way signals travel along the sandbox's wires, for the flowing-bits overlay (view/flow.ts).
// A wire is drawn in whatever direction the user dragged it, and a branch may start anywhere on
// another wire, so each wire is cut at its branch points and the pieces are walked outwards
// from the drivers (part outputs, chip inputs; pointers and bidirectional pins only for a group
// with neither). A wire walked from one end to the other in one go flows whole (forwards or
// backwards: its hop path is reused); a wire entered in the middle flows as separate pieces.
// DOM-free. The overlay: pellets (1-bit) and riding values (buses), view/flow.ts and flowtokens.ts.

import type { Vec } from '../sim/geometry';
import { polyLength, slicePoly } from '../view/flow';
import { type ChipDoc, type DefOf, type EndRef, onSegment } from './model';

export type WireFlow =
  /** The whole wire, from end a (or from b when `reverse`); d0 = distance of that end from the driver;
   *  `sink`: nothing continues past the far end (riding values fade out there, not at a junction). */
  | { whole: true; reverse: boolean; d0: number; len: number; sink: boolean }
  /** Pieces drawn from their own start, each `d0` from the driver. */
  | { whole: false; pieces: { pts: Vec[]; d0: number; sink: boolean }[] };

interface Edge { wire: string; pts: Vec[]; a: string; b: string; len: number; from?: string }

const key = ([x, y]: Vec) => `${x},${y}`;
const dist = (p: Vec, q: Vec) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Arc length of `p` along `poly`, or -1 when it is not on it. */
function along(poly: Vec[], p: Vec): number {
  let s = 0;
  for (let i = 1; i < poly.length; i++) {
    const [a, b] = [poly[i - 1], poly[i]];
    if (onSegment(a, b, p)) return s + dist(a, p);
    s += dist(a, b);
  }
  return -1;
}

/**
 * Flow of every drawn wire (`polys`: the view's polylines, a → b). Wires not reached from any
 * driver are left out (nothing flows on them).
 */
export function wireFlows(doc: ChipDoc, polys: Map<string, Vec[]>, defOf: DefOf): Map<string, WireFlow> {
  // Cut points of each wire: its ends and wherever another wire branches off it. A branch point
  // on a slanted segment is named by the branch's own end (slicePoly's float may differ slightly).
  const cuts = new Map<string, number[]>();
  const named = new Map<string, Map<number, Vec>>();
  for (const w of doc.wires) {
    const p = polys.get(w.id);
    if (p) cuts.set(w.id, [0, polyLength(p)]);
  }
  for (const w of doc.wires) {
    for (const e of [w.a, w.b]) {
      if (!('wire' in e)) continue;
      const host = polys.get(e.wire);
      const s = host ? along(host, e.at) : -1;
      if (s < 0) continue;
      cuts.get(e.wire)!.push(s);
      (named.get(e.wire) ?? named.set(e.wire, new Map()).get(e.wire)!).set(s, e.at);
    }
  }
  const edges: Edge[] = [];
  const adj = new Map<string, Edge[]>();
  const byWire = new Map<string, Edge[]>();
  for (const [id, cs] of cuts) {
    const poly = polys.get(id)!;
    const sorted = [...new Set(cs)].sort((u, v) => u - v);
    const list: Edge[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const pts = slicePoly(poly, sorted[i - 1], sorted[i]);
      if (pts.length < 2) continue;
      const [p0, p1] = [named.get(id)?.get(sorted[i - 1]), named.get(id)?.get(sorted[i])];
      if (p0) pts[0] = p0;
      if (p1) pts[pts.length - 1] = p1;
      const e: Edge = { wire: id, pts, a: key(pts[0]), b: key(pts[pts.length - 1]), len: sorted[i] - sorted[i - 1] };
      list.push(e);
      edges.push(e);
      for (const n of [e.a, e.b]) adj.set(n, [...adj.get(n) ?? [], e]);
    }
    byWire.set(id, list);
  }

  // Sources: rank 1 drives the net, rank 2 only stands in for a group with no driver.
  const rank = (e: EndRef): number => {
    if ('part' in e) {
      const part = doc.parts.find((p) => p.id === e.part);
      const port = part && defOf(part)?.ports.find((q) => q.name === e.port);
      return port?.dir === 'out' ? 1 : port?.dir === 'inout' ? 2 : 0;
    }
    if ('pin' in e) {
      const pin = doc.pins.find((p) => p.id === e.pin);
      return pin?.dir === 'in' ? 1 : pin?.dir === 'inout' ? 2 : 0;
    }
    return 'label' in e ? 2 : 0;
  };
  const ranked: string[][] = [[], [], []];
  for (const w of doc.wires) {
    const p = polys.get(w.id);
    if (!p) continue;
    ranked[rank(w.a)].push(key(p[0]));
    ranked[rank(w.b)].push(key(p[p.length - 1]));
  }

  // Breadth-first from the drivers; a tree net gets each piece's exact distance from its driver.
  const d = new Map<string, number>();
  const walk = (starts: string[]) => {
    const queue = starts.filter((n) => !d.has(n));
    for (const n of queue) d.set(n, 0);
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i];
      for (const e of adj.get(n) ?? []) {
        if (e.from !== undefined) continue;
        e.from = n;
        const m = n === e.a ? e.b : e.a;
        if (!d.has(m)) {
          d.set(m, d.get(n)! + e.len);
          queue.push(m);
        }
      }
    }
  };
  walk(ranked[1]);
  walk(ranked[2]);

  // A node where only this piece ends is a sink; anywhere else the signal carries on.
  const sink = (n: string) => (adj.get(n)?.length ?? 0) < 2;
  const out = new Map<string, WireFlow>();
  for (const [id, list] of byWire) {
    const lit = list.filter((e) => e.from !== undefined);
    if (!lit.length) continue;
    const len = list.reduce((t, e) => t + e.len, 0);
    // Whole: every piece walked the same way, each continuing the distance of the one before.
    const near = (u: number, v: number) => Math.abs(u - v) < 1e-6;
    const fwd = lit.length === list.length && list.every((e, i) => e.from === e.a && (i === 0 || near(d.get(e.a)!, d.get(list[i - 1].a)! + list[i - 1].len)));
    const back = lit.length === list.length && list.every((e, i) => e.from === e.b && (i === list.length - 1 || near(d.get(e.b)!, d.get(list[i + 1].b)! + list[i + 1].len)));
    if (fwd) out.set(id, { whole: true, reverse: false, d0: d.get(list[0].a)!, len, sink: sink(list[list.length - 1].b) });
    else if (back) out.set(id, { whole: true, reverse: true, d0: d.get(list[list.length - 1].b)!, len, sink: sink(list[0].a) });
    else {
      out.set(id, { whole: false, pieces: lit.map((e) => (e.from === e.a
        ? { pts: e.pts, d0: d.get(e.a)!, sink: sink(e.b) }
        : { pts: [...e.pts].reverse(), d0: d.get(e.b)!, sink: sink(e.a) })) });
    }
  }
  return out;
}
