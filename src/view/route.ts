// Orthogonal wire routing for a component's internal view. Deliberately simple and
// predictable: each wire leaves its driver in the port's exit direction, runs along a
// shared trunk, and enters each sink from the sink's side. A trunk that would lie on another
// net's wire is nudged along in half-grid steps (`place`). Authors untangle the rare hard
// case with `trunk` (a preferred position) and `via` (fixed corners) on the NetDef.

import { type ExitDir, instPort, type PortGeom, symbolGeom, type Vec } from '../sim/geometry';
import { type ComponentDef, type Netlist, parseEnd } from '../sim/types';

export interface NetTag {
  end: string;
  /** Port position and the direction the stub leaves it (with `at`: the label's direction). */
  pos: Vec;
  dir: ExitDir;
  /** Stub length: longer on a splitter / merger tap, so the label clears the tap's bit range. */
  stub: number;
  /**
   * Authored label position (NetDef.tagAt). The stub from `pos` to here is then a wire of the
   * net (in RoutedNet.paths, so hops and overlap checks see it), and `dir` is its last leg.
   */
  at?: Vec;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Approximate rendered width of monospace-ish label text at a font size (grid units). */
export const textWidth = (t: string, size: number) => t.length * size * 0.62 + 0.8;

export interface RoutedNet {
  index: number;
  width: number;
  tags: NetTag[];
  /** One polyline per sink (driver → sink). */
  paths: Vec[][];
  dots: Vec[];
  /** Where to draw the bus value label, and how wide it may be before it runs off its segment. */
  label: Vec | null;
  labelRoom: number;
}

export interface PinGeom extends PortGeom {
  name: string;
  dir: 'in' | 'out' | 'inout';
  width: number;
}

const DIR: Record<ExitDir, Vec> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const STUB = 1;
const half = (v: number) => Math.round(v * 2) / 2;

/** Positions of the component's own pins in its internal view. */
export function pinGeoms(def: ComponentDef, nl: Netlist): Map<string, PinGeom> {
  const m = new Map<string, PinGeom>();
  // Defaults for unplaced pins: inputs stacked on the left, outputs on the right.
  let xMax = 10;
  for (const inst of nl.instances) if (inst.at) xMax = Math.max(xMax, inst.at[0] + symbolGeom(inst.def).w);
  let li = 0, ri = 0;
  for (const p of def.ports) {
    const placed = nl.pins?.[p.name];
    const pos: Vec = placed ?? (p.dir === 'out' ? [xMax + 4, 2 + 3 * ri++] : [0, 2 + 3 * li++]);
    const exit = nl.pinDirs?.[p.name] ?? (p.dir === 'out' ? 'left' : 'right');
    m.set(p.name, { name: p.name, dir: p.dir, width: p.width, pos, exit });
  }
  return m;
}

function endGeom(def: ComponentDef, nl: Netlist, pins: Map<string, PinGeom>, end: string): PortGeom {
  const { inst, port } = parseEnd(end);
  if (inst === null) {
    const g = pins.get(port);
    if (!g) throw new Error(`${def.id}: no pin '${port}'`);
    return g;
  }
  const i = nl.instances.find((x) => x.name === inst)!;
  return instPort(i.def, i.at ?? [0, 0], i.flip, port);
}

function simplify(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  // Drop collinear middle points.
  for (let i = out.length - 2; i >= 1; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
  }
  return out;
}

const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k];
const horiz = (d: ExitDir) => d === 'left' || d === 'right';

/** A net's routing problem: everything but the trunk coordinate, which `place` chooses. */
interface NetPlan {
  index: number;
  width: number;
  tags: NetTag[];
  /** Per sink, in netlist order: an authored (`via`) path, or the stub points [P, P1, S1, S]
   *  of a route through the trunk. */
  sinks: ({ path: Vec[] } | { free: Quad })[];
  /** The trunk runs vertically (x = trunk) for a horizontal driver, else horizontally. */
  h: boolean;
  /** Preferred trunk coordinate. */
  t0: number;
}

type Quad = [Vec, Vec, Vec, Vec];
const freeOf = (n: NetPlan, i: number): Quad | null => { const s = n.sinks[i]; return 'free' in s ? s.free : null; };

/** Unsimplified points of a trunk route (`simplify` would hide a wire folding back on itself). */

function rawPath([P, P1, S1, S]: Quad, h: boolean, t: number): Vec[] {
  return h ? [P, P1, [t, P1[1]], [t, S1[1]], S1, S] : [P, P1, [P1[0], t], [S1[0], t], S1, S];
}

const pathsOf = (n: NetPlan, t: number): Vec[][] => n.sinks.map((s) => ('free' in s ? simplify(rawPath(s.free, n.h, t)) : s.path));

/**
 * The stub from a pin to an authored tag position: it leaves the pin in its exit direction
 * (stepping out first if the tag lies behind the pin), then turns once onto the tag. The label
 * continues the last leg, so it never sits on its own stub.
 */
export function tagStub(pos: Vec, exit: ExitDir, at: Vec): { path: Vec[]; dir: ExitDir } {
  const d = DIR[exit], h = horiz(exit);
  const ahead = h ? (at[0] - pos[0]) * d[0] : (at[1] - pos[1]) * d[1];
  const out = add(pos, d, STUB);
  const path = simplify(ahead > 0
    ? [pos, h ? [at[0], pos[1]] : [pos[0], at[1]], at]
    : [pos, out, h ? [out[0], at[1]] : [at[0], out[1]], at]);
  if (path.length < 2) return { path, dir: exit };
  const [a, b] = path.slice(-2);
  const dir: ExitDir = b[0] > a[0] ? 'right' : b[0] < a[0] ? 'left' : b[1] > a[1] ? 'down' : 'up';
  return { path, dir };
}

export function routeNetlist(def: ComponentDef, nl: Netlist): { nets: RoutedNet[]; pins: Map<string, PinGeom> } {
  const pins = pinGeoms(def, nl);
  const allTaps = tapLabels(nl);
  const taps = new Map(allTaps.map((t) => [t.end, t]));
  const plans = nl.nets.map((net, index): NetPlan => {
    const ends = net.ends.map((e) => endGeom(def, nl, pins, e));
    const { inst, port } = parseEnd(net.ends[0]);
    const width = inst === null
      ? def.ports.find((p) => p.name === port)!.width
      : nl.instances.find((i) => i.name === inst)!.def.ports.find((p) => p.name === port)!.width;
    const drv = ends[0];
    const P = drv.pos;
    const P1 = add(P, DIR[drv.exit], STUB);
    const tagged = (i: number) => net.tags === true || (net.tags?.includes(net.ends[i]) ?? false);
    const authored = (i: number) => net.tagAt?.[net.ends[i]];
    const tag = (i: number): NetTag => {
      const at = authored(i);
      if (at) return { end: net.ends[i], pos: ends[i].pos, dir: tagStub(ends[i].pos, ends[i].exit, at).dir, stub: 0, at };
      const tap = taps.get(net.ends[i]);
      return { end: net.ends[i], pos: ends[i].pos, dir: ends[i].exit, stub: tap ? TAP_GAP + tap.rect.w + 0.5 : TAG_STUB };
    };
    // A net whose every tagged sink is so close to the driver that the labels would collide is
    // just wired. (If some tags remain, the driver keeps its tag, which would sit on that wire.)
    // Tags placed by hand stay where they were put.
    const name = net.name ?? `n${index}`;
    const near = (i: number) => !authored(0) && !authored(i) && overlaps(tagGeom(tag(0), name).rect, tagGeom(tag(i), name).rect);
    const sinkIdx = ends.map((_, i) => i).slice(1);
    const wireAll = sinkIdx.some(tagged) && sinkIdx.filter(tagged).every(near);
    const tags: NetTag[] = [];
    const drawn: number[] = [];
    for (const i of sinkIdx) {
      if (tagged(i) && !wireAll) tags.push(tag(i));
      else drawn.push(i);
    }
    if (tags.length && (drawn.length === 0 || tagged(0))) tags.unshift(tag(0));
    const sinks = drawn.map((i) => ends[i]);
    const sinkNames = drawn.map((i) => net.ends[i]);
    const multi = sinks.length > 1;
    const h = horiz(drv.exit);
    const plan: NetPlan = { index, width, tags, sinks: [], h, t0: 0 };
    sinks.forEach((s, si) => {
      const via = net.via?.[sinkNames[si]];
      if (via && via.length) {
        const pts: Vec[] = [P];
        // Leave the driver in its exit direction.
        pts.push(h ? [via[0][0], P[1]] : [P[0], via[0][1]]);
        pts.push(via[0]);
        for (let i = 1; i < via.length; i++) {
          const a = via[i - 1], b = via[i];
          if (a[0] !== b[0] && a[1] !== b[1]) pts.push([b[0], a[1]]);
          pts.push(b);
        }
        const last = via[via.length - 1];
        const S = s.pos;
        if (last[0] !== S[0] && last[1] !== S[1]) pts.push(horiz(s.exit) ? [last[0], S[1]] : [S[0], last[1]]);
        pts.push(S);
        plan.sinks.push({ path: simplify(pts) });
      } else {
        plan.sinks.push({ free: [P, P1, add(s.pos, DIR[s.exit], STUB), s.pos] });
      }
    });
    // Stubs to hand-placed tags are fixed paths of the net, after the drawn sinks. Like every
    // path they run in the direction of signal flow: out of the driver, into a sink.
    for (const t of tags) {
      if (!t.at) continue;
      const { path } = tagStub(t.pos, ends[net.ends.indexOf(t.end)].exit, t.at);
      if (path.length > 1) plan.sinks.push({ path: t.end === net.ends[0] ? path : path.reverse() });
    }
    const a = h ? 0 : 1, f = plan.sinks.map((_, i) => freeOf(plan, i)).find((q) => q);
    plan.t0 = net.trunk ?? (multi || !f ? P1[a] : half((P1[a] + f[2][a]) / 2));
    return plan;
  });
  const trunks = place(plans);
  const all = plans.map((n) => pathsOf(n, trunks[n.index]));
  const boxes = nl.instances.map((i): Rect => {
    const g = symbolGeom(i.def), at = i.at ?? [0, 0];
    return { x: at[0], y: at[1], w: g.w, h: g.h };
  });
  untangle(plans, all, boxes);
  const nets = plans.map((n): RoutedNet => {
    const paths = all[n.index];
    return { index: n.index, width: n.width, tags: n.tags, paths, dots: junctions(paths), label: null, labelRoom: 0 };
  });
  // Bus value labels go last, clear of every tap label and net tag.
  const obstacles = [...allTaps.map((t) => t.rect), ...nets.flatMap((n) => n.tags.map((t) => tagGeom(t, nl.nets[n.index].name ?? `n${n.index}`).rect))];
  for (const n of nets) {
    const anchor = n.width > 1 ? labelAnchor(n.paths, obstacles) : null;
    n.label = anchor?.pos ?? null;
    n.labelRoom = anchor?.room ?? 0;
  }
  return { nets, pins };
}

/**
 * Trunk placement. Every net starts on its preferred trunk; then, in a few greedy passes,
 * each net is ripped up and put back on the nearby half-grid trunk that overlaps other nets
 * least. Overlap is the defect that matters: two nets on one line read as one wire. A wire
 * folding back over itself (or its pin) is as bad, and touching another net at a point that
 * is not a crossing reads as a false junction. Distance from the preferred trunk breaks
 * ties, so a clean layout, and an author's `trunk`, is left exactly as drawn.
 */
function place(plans: NetPlan[]): number[] {
  const W_OVERLAP = 100, W_FOLD = 200, W_TOUCH = 10, W_MOVE = 1, STEPS = 8, eps = 1e-6;
  const trunks = plans.map((n) => n.t0);
  // Horizontal segments by y, vertical ones by x; path points by y and by x.
  type Run = { lo: number; hi: number; net: number };
  type Pt = { c: number; net: number };
  type Bucket = Map<number, { net: number }[]>;
  const hSeg = new Map<number, Run[]>(), vSeg = new Map<number, Run[]>();
  const ptByY = new Map<number, Pt[]>(), ptByX = new Map<number, Pt[]>();
  const push = <T>(m: Map<number, T[]>, k: number, v: T) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  const each = (paths: Vec[][], seg: (h: boolean, at: number, lo: number, hi: number) => void, pt: (p: Vec) => void) => {
    for (const p of paths) {
      for (const q of p) pt(q);
      for (let i = 1; i < p.length; i++) {
        const [a, b] = [p[i - 1], p[i]];
        if (a[1] === b[1] && a[0] !== b[0]) seg(true, a[1], Math.min(a[0], b[0]), Math.max(a[0], b[0]));
        else if (a[0] === b[0] && a[1] !== b[1]) seg(false, a[0], Math.min(a[1], b[1]), Math.max(a[1], b[1]));
      }
    }
  };
  // The buckets each net is in, so ripping it up touches only those.
  const keys = new Map<number, [Bucket, number][]>();
  const insert = (net: number, paths: Vec[][]) => {
    const ks: [Bucket, number][] = [];
    each(
      paths,
      (h, at, lo, hi) => {
        push(h ? hSeg : vSeg, at, { lo, hi, net });
        ks.push([h ? hSeg : vSeg, at]);
      },
      (p) => {
        push(ptByY, p[1], { c: p[0], net });
        push(ptByX, p[0], { c: p[1], net });
        ks.push([ptByY, p[1]], [ptByX, p[0]]);
      },
    );
    keys.set(net, ks);
  };
  const remove = (net: number) => {
    for (const [m, k] of keys.get(net) ?? []) {
      const l = m.get(k);
      if (l) m.set(k, l.filter((v) => v.net !== net));
    }
  };
  const cost = (n: NetPlan, t: number): number => {
    let c = W_MOVE * Math.abs(t - n.t0);
    for (const s of n.sinks) {
      if (!('free' in s)) continue;
      // A fold: consecutive collinear segments running in opposite directions.
      const r = rawPath(s.free, n.h, t);
      for (let i = 2; i < r.length; i++) {
        const [a, b, d] = [r[i - 2], r[i - 1], r[i]];
        const u = [b[0] - a[0], b[1] - a[1]], v = [d[0] - b[0], d[1] - b[1]];
        if (u[0] * v[1] - u[1] * v[0] === 0 && u[0] * v[0] + u[1] * v[1] < 0) {
          c += W_FOLD * Math.min(Math.abs(u[0] + u[1]), Math.abs(v[0] + v[1]));
        }
      }
    }
    each(
      pathsOf(n, t),
      (h, at, lo, hi) => {
        for (const s of (h ? hSeg : vSeg).get(at) ?? []) {
          // Per overlap, not per unit of length: shortening an overlap the trunk can't remove
          // (it sits on a fixed row) would only drag the trunk off its place. untangle() fixes those.
          const len = Math.min(hi, s.hi) - Math.max(lo, s.lo);
          if (s.net !== n.index && len > eps) c += W_OVERLAP + 0.5 * len;
        }
        for (const p of (h ? ptByY : ptByX).get(at) ?? []) {
          if (p.net !== n.index && p.c > lo + eps && p.c < hi - eps) c += W_TOUCH;
        }
      },
      (p) => {
        for (const s of hSeg.get(p[1]) ?? []) if (s.net !== n.index && p[0] > s.lo + eps && p[0] < s.hi - eps) c += W_TOUCH;
        for (const s of vSeg.get(p[0]) ?? []) if (s.net !== n.index && p[1] > s.lo + eps && p[1] < s.hi - eps) c += W_TOUCH;
      },
    );
    return c;
  };
  for (const n of plans) insert(n.index, pathsOf(n, n.t0));
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const n of plans) {
      if (!n.sinks.some((s) => 'free' in s)) continue;
      remove(n.index);
      let best = trunks[n.index], bestCost = cost(n, best);
      // Look further out only while a candidate could still win (moving costs W_MOVE per unit).
      for (let k = 0; k <= STEPS && bestCost > W_MOVE * k * 0.5 + eps; k++) {
        for (const t of k ? [n.t0 + k * 0.5, n.t0 - k * 0.5] : [n.t0]) {
          if (t === best) continue;
          const tc = cost(n, t);
          if (tc < bestCost - eps) {
            best = t;
            bestCost = tc;
          }
        }
      }
      if (best !== trunks[n.index]) {
        trunks[n.index] = best;
        changed = true;
      }
      insert(n.index, pathsOf(n, best));
    }
    if (!changed) break;
  }
  return trunks;
}

/** Free paths (not authored with `via`) that lie along a path of another net, or reach a pin from behind. */
function overlapping(plans: NetPlan[], all: Vec[][][]): [number, number][] {
  const lines = new Map<string, { lo: number; hi: number; net: number; path: number }[]>();
  all.forEach((paths, net) => paths.forEach((p, path) => {
    for (let i = 1; i < p.length; i++) {
      const [a, b] = [p[i - 1], p[i]];
      const h = a[1] === b[1];
      if (h && a[0] === b[0]) continue;
      const k = h ? `h${a[1]}` : `v${a[0]}`;
      const run = h
        ? { lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), net, path }
        : { lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), net, path };
      const l = lines.get(k);
      if (l) l.push(run);
      else lines.set(k, [run]);
    }
  }));
  const out = new Map<string, [number, number]>();
  const free = (r: { net: number; path: number }) => freeOf(plans[r.net], r.path) !== null;
  for (const l of lines.values()) {
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        const [r, s] = [l[i], l[j]];
        if (r.net === s.net || Math.min(r.hi, s.hi) - Math.max(r.lo, s.lo) <= 1e-6) continue;
        for (const q of [r, s]) if (free(q)) out.set(`${q.net}:${q.path}`, [q.net, q.path]);
      }
    }
  }
  for (const [net, paths] of all.entries()) {
    paths.forEach((p, path) => {
      const q = freeOf(plans[net], path);
      if (q && backwards(p, q)) out.set(`${net}:${path}`, [net, path]);
    });
  }
  return [...out.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * A path that leaves its driver or reaches its sink from behind the pin: the trunk lies on the
 * far side of the stub, so the route runs out and back (simplify folds that into one segment)
 * straight across the symbol, and the wire looks attached to the wrong side.
 */
export function backwards(p: Vec[], [P, P1, S1, S]: Quad): boolean {
  if (p.length < 2) return false;
  const behind = (end: Vec, stub: Vec, next: Vec) => (next[0] - end[0]) * (stub[0] - end[0]) + (next[1] - end[1]) * (stub[1] - end[1]) < -1e-6;
  return behind(P, P1, p[1]) || behind(S, S1, p[p.length - 2]);
}

/**
 * Fallback for paths still lying on another net after trunk placement, where the overlap is
 * on a fixed row (a long run into a sink, a driver's own row), and for paths reaching a pin from
 * behind it (backwards). Such a path is rerouted by a
 * maze search (A* on the half grid) from the driver's stub to the sink's stub that
 * never runs along another net, never turns or stops on one, and never enters a symbol.
 * Bends and crossings cost extra, so the detour stays as plain as the layout allows.
 */
function untangle(plans: NetPlan[], all: Vec[][][], boxes: Rect[]) {
  const G = 0.5, MARGIN = 4, BEND = 1.5, CROSS = 1, CHEAP = 0.3, eps = 1e-6;
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const heading = (a: Vec, b: Vec) => (b[0] > a[0] ? 0 : b[1] > a[1] ? 1 : b[0] < a[0] ? 2 : 3);
  const onGrid = (v: number) => Math.abs(v / G - Math.round(v / G)) < eps;
  for (let round = 0; round < 2; round++) {
    const todo = overlapping(plans, all);
    if (!todo.length) return;
    // A grid over everything drawn.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };
    for (const paths of all) for (const p of paths) for (const q of p) grow(q[0], q[1]);
    for (const b of boxes) { grow(b.x, b.y); grow(b.x + b.w, b.y + b.h); }
    x0 = Math.floor(x0 / G) * G - MARGIN;
    y0 = Math.floor(y0 / G) * G - MARGIN;
    const W = Math.round((x1 + MARGIN - x0) / G) + 1, H = Math.round((y1 + MARGIN - y0) / G) + 1, N = W * H;
    const cell = (v: Vec) => Math.round((v[1] - y0) / G) * W + Math.round((v[0] - x0) / G);
    const blocked = new Uint8Array(N);
    for (const b of boxes) {
      for (let j = Math.ceil((b.y - y0) / G + eps); j <= Math.floor((b.y + b.h - y0) / G - eps); j++) {
        for (let i = Math.ceil((b.x - x0) / G + eps); i <= Math.floor((b.x + b.w - x0) / G - eps); i++) blocked[j * W + i] = 1;
      }
    }
    // Occupancy, as net index + 1 (0 = nobody): the edge east / south of a cell, a cell on a
    // horizontal / vertical wire, a wire's end or corner. A cell shared by several nets keeps
    // one of them, which is all `other` needs.
    const hEdge = new Int32Array(N), vEdge = new Int32Array(N), hOn = new Int32Array(N), vOn = new Int32Array(N), pt = new Int32Array(N);
    // Edges of the path's own route and of its net's other wires (bit 0 east, bit 1 south):
    // cheap to follow, so a detour leaves the drawn route only around the conflict.
    const mine = new Uint8Array(N);
    const dist = new Float64Array(N * 4), prev = new Int32Array(N * 4);
    for (const [net, pi] of todo) {
      const n = plans[net];
      const [P, P1, S1, S] = freeOf(n, pi)!;
      if (![P1, S1].every((v) => onGrid(v[0]) && onGrid(v[1]))) continue;
      const other = (v: number) => v !== 0 && v !== net + 1;
      for (const a of [hEdge, vEdge, hOn, vOn, pt, mine]) a.fill(0);
      all.forEach((paths, m) => paths.forEach((p, k) => {
        if (m === net) {
          for (let s = 1; s < p.length; s++) {
            const [a, b] = [p[s - 1], p[s]];
            const h = a[1] === b[1];
            if (!onGrid(h ? a[1] : a[0])) continue;
            const c0 = cell([Math.min(a[0], b[0]), Math.min(a[1], b[1])]);
            const len = Math.round(Math.abs(h ? b[0] - a[0] : b[1] - a[1]) / G);
            for (let t = 0; t < len; t++) mine[c0 + (h ? t : t * W)] |= h ? 1 : 2;
          }
          if (k === pi) return;
        }
        const id = m + 1;
        for (const q of p) if (onGrid(q[0]) && onGrid(q[1]) && !other(pt[cell(q)])) pt[cell(q)] = id;
        for (let s = 1; s < p.length; s++) {
          const [a, b] = [p[s - 1], p[s]];
          const h = a[1] === b[1];
          const at = h ? a[1] : a[0], o = h ? x0 : y0;
          if (!onGrid(at)) continue;
          const lo = Math.min(h ? a[0] : a[1], h ? b[0] : b[1]), hi = Math.max(h ? a[0] : a[1], h ? b[0] : b[1]);
          const on = h ? hOn : vOn, edge = h ? hEdge : vEdge;
          for (let t = Math.floor((lo - o) / G + eps); t <= Math.ceil((hi - o) / G - eps); t++) {
            const c = h ? Math.round((at - y0) / G) * W + t : t * W + Math.round((at - x0) / G);
            const v = o + t * G;
            if (v >= lo - eps && v <= hi + eps && !other(on[c])) on[c] = id;
            if (v + G > lo + eps && v < hi - eps && !other(edge[c])) edge[c] = id;
          }
        }
      }));
      // Search over (cell, heading). Leaving P1 back over the driver's stub, or reaching S1
      // heading away from the sink, would fold the wire onto itself.
      const start = cell(P1), goal = cell(S1), d0 = heading(P, P1), dIn = heading(S1, S);
      dist.fill(Infinity);
      prev.fill(-1);
      const heap: [number, number][] = [];
      const up = (d: number, s: number) => {
        heap.push([d, s]);
        for (let i = heap.length - 1; i > 0;) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      };
      const down = () => {
        const top = heap[0], last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          for (let i = 0; ;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
            if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
            if (m === i) break;
            [heap[m], heap[i]] = [heap[i], heap[m]];
            i = m;
          }
        }
        return top;
      };
      // A*: the heap is keyed on cost so far plus the Manhattan distance left at the cheapest
      // step cost (a lower bound).
      const gx = goal % W, gy = Math.floor(goal / W);
      const rest = (c: number) => (Math.abs((c % W) - gx) + Math.abs(Math.floor(c / W) - gy)) * G * CHEAP;
      dist[start * 4 + d0] = 0;
      up(rest(start), start * 4 + d0);
      // A detour much longer than the direct route is worse than the overlap it avoids.
      const budget = 2 * (Math.abs(S1[0] - P1[0]) + Math.abs(S1[1] - P1[1])) + 20;
      let end = -1;
      while (heap.length) {
        const [f, s] = down();
        if (f > budget) break;
        const c = s >> 2, h = s & 3, d = dist[s];
        if (f > d + rest(c) + eps) continue;
        if (c === goal) {
          if (h !== (dIn + 2) % 4) { end = s; break; }
          continue;
        }
        const cx = c % W, cy = Math.floor(c / W);
        for (let e = 0; e < 4; e++) {
          if (e === (h + 2) % 4) continue;
          // A turn on another net's wire would read as a junction with it.
          if (e !== h && c !== start && (other(hOn[c]) || other(vOn[c]))) continue;
          const nx = cx + DX[e], ny = cy + DY[e];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nc = ny * W + nx;
          if (nc !== goal && (blocked[nc] || other(pt[nc]))) continue;
          if (other(e === 0 ? hEdge[c] : e === 2 ? hEdge[nc] : e === 1 ? vEdge[c] : vEdge[nc])) continue;
          const own = e === 0 ? mine[c] & 1 : e === 2 ? mine[nc] & 1 : e === 1 ? mine[c] & 2 : mine[nc] & 2;
          const nd = d + G * (own ? CHEAP : 1) + (e !== h ? BEND : 0) + (other(e % 2 ? hOn[nc] : vOn[nc]) ? CROSS : 0);
          const ns = nc * 4 + e;
          if (nd < dist[ns]) {
            dist[ns] = nd;
            prev[ns] = s;
            up(nd + rest(nc), ns);
          }
        }
      }
      if (end < 0) continue;
      const pts: Vec[] = [S];
      for (let s = end; s >= 0; s = prev[s]) pts.push([x0 + ((s >> 2) % W) * G, y0 + Math.floor((s >> 2) / W) * G]);
      pts.push(P);
      all[net][pi] = simplify(pts.reverse());
    }
  }
}

export interface WireOverlap { nets: [number, number]; axis: 'h' | 'v'; at: number; from: number; to: number }

/** Collinear overlaps between wires of different nets: the defect `place` avoids. */
export function wireOverlaps(nets: RoutedNet[]): WireOverlap[] {
  const lines = new Map<string, { lo: number; hi: number; net: number }[]>();
  for (const n of nets) {
    for (const p of n.paths) {
      for (let i = 1; i < p.length; i++) {
        const [a, b] = [p[i - 1], p[i]];
        const h = a[1] === b[1];
        if (h && a[0] === b[0]) continue;
        const k = h ? `h${a[1]}` : `v${a[0]}`;
        const run = h
          ? { lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), net: n.index }
          : { lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), net: n.index };
        const l = lines.get(k);
        if (l) l.push(run);
        else lines.set(k, [run]);
      }
    }
  }
  const out: WireOverlap[] = [];
  for (const [k, l] of lines) {
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        if (l[i].net === l[j].net) continue;
        const from = Math.max(l[i].lo, l[j].lo), to = Math.min(l[i].hi, l[j].hi);
        if (to - from > 1e-6) out.push({ nets: [l[i].net, l[j].net], axis: k[0] as 'h' | 'v', at: Number(k.slice(1)), from, to });
      }
    }
  }
  return out;
}

const TAG_STUB = 1.4, TAG_H = 1.35, TAP_GAP = 0.12;

/**
 * Where a net tag's stub ends, the rectangle of its name label, and the stub the tag draws
 * itself (empty for a hand-placed tag, whose stub is one of the net's paths).
 */
export function tagGeom(t: NetTag, name: string): { tip: Vec; rect: Rect; stub: Vec[] } {
  const d = DIR[t.dir];
  const tip: Vec = t.at ?? [t.pos[0] + d[0] * t.stub, t.pos[1] + d[1] * t.stub];
  const w = textWidth(name, 0.8) + 0.6, h = TAG_H;
  const x = t.dir === 'right' ? tip[0] : t.dir === 'left' ? tip[0] - w : tip[0] - w / 2;
  const y = t.dir === 'down' ? tip[1] : t.dir === 'up' ? tip[1] - h : tip[1] - h / 2;
  return { tip, rect: { x, y, w, h }, stub: t.at ? [] : [t.pos, tip] };
}

export interface TapLabel {
  net: number;
  /** The splitter / merger port, as a netlist end (`inst.port`). */
  end: string;
  pos: Vec;
  text: string;
  size: number;
  rect: Rect;
}

const EPS = 0.05;
/** Rectangles overlap by more than a hair (shared edges don't count). */
export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

/** Every instance body, plus the name drawn above each box (schematic.ts, .inst-name). */
function symbolRects(nl: Netlist): { what: string; r: Rect; inst: string }[] {
  const out: { what: string; r: Rect; inst: string }[] = [];
  for (const i of nl.instances) {
    const at = i.at ?? [0, 0], g = symbolGeom(i.def);
    out.push({ what: `instance ${i.name}`, r: { x: at[0], y: at[1], w: g.w, h: g.h }, inst: i.name });
    if (i.def.symbol.kind === 'box' && i.def.prim !== 'alias') {
      const label = i.label ?? i.name;
      out.push({ what: `name of ${i.name}`, r: { x: at[0] + 0.1, y: at[1] - 1.2, w: label.length * 0.78 * 0.62, h: 0.9 }, inst: i.name });
    }
  }
  return out;
}

/**
 * Bit ranges carried by each connected splitter output / merger input, drawn just above the
 * wire. A label that would sit on another symbol (dense fans of splitters) is left out: the
 * neighbouring splitter's own labels already number the same wires.
 */
export function tapLabels(nl: Netlist): TapLabel[] {
  const syms = symbolRects(nl);
  const netOf = new Map<string, number>();
  nl.nets.forEach((n, i) => n.ends.forEach((e) => netOf.set(e, i)));
  const out: TapLabel[] = [];
  for (const inst of nl.instances) {
    const k = inst.def.symbol.kind;
    if (k !== 'split' && k !== 'merge') continue;
    const size = Math.min(0.72, (inst.def.symbol.pitch ?? 2) * 0.4);
    let bit = 0;
    for (const p of inst.def.ports) {
      if ((k === 'split') !== (p.dir === 'out')) continue;
      const text = p.width === 1 ? `${bit}` : `${bit + p.width - 1}:${bit}`;
      bit += p.width;
      const end = `${inst.name}.${p.name}`;
      const net = netOf.get(end);
      if (net === undefined) continue;
      const g = instPort(inst.def, inst.at ?? [0, 0], inst.flip, p.name);
      const w = textWidth(text, size) + 0.1, h = size * 1.3;
      const x = g.exit === 'right' ? g.pos[0] + TAP_GAP : g.pos[0] - TAP_GAP - w;
      const rect = { x, y: g.pos[1] - h - 0.1, w, h };
      if (syms.some((o) => o.inst !== inst.name && overlaps(o.r, rect))) continue;
      out.push({ net, end, pos: g.pos, text, size, rect });
    }
  }
  return out;
}

/** A junction dot wherever three or more wire directions meet. */
export function junctions(paths: Vec[][]): Vec[] {
  const segs: [Vec, Vec][] = [];
  for (const p of paths) for (let i = 1; i < p.length; i++) segs.push([p[i - 1], p[i]]);
  const key = (v: Vec) => `${v[0]},${v[1]}`;
  const pts = new Map<string, Vec>();
  for (const [a, b] of segs) {
    pts.set(key(a), a);
    pts.set(key(b), b);
  }
  const dots: Vec[] = [];
  for (const c of pts.values()) {
    const dirs = new Set<string>();
    for (const [a, b] of segs) {
      const onH = a[1] === b[1] && c[1] === a[1] && c[0] >= Math.min(a[0], b[0]) && c[0] <= Math.max(a[0], b[0]);
      const onV = a[0] === b[0] && c[0] === a[0] && c[1] >= Math.min(a[1], b[1]) && c[1] <= Math.max(a[1], b[1]);
      if (!onH && !onV) {
        // A slanted segment (a sandbox's straight wire): the directions to its ends, by angle.
        if (a[0] === b[0] || a[1] === b[1]) continue;
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(dx, dy);
        const t = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (l * l);
        if (t < -1e-3 || t > 1 + 1e-3 || Math.abs(dx * (c[1] - a[1]) - dy * (c[0] - a[0])) / l > 1e-3) continue;
        const ang = (x: number, y: number) => `a${Math.round(Math.atan2(y, x) * 1000)}`;
        if (t * l > 1e-3) dirs.add(ang(-dx, -dy));
        if ((1 - t) * l > 1e-3) dirs.add(ang(dx, dy));
        continue;
      }
      if (onH) {
        if (c[0] > Math.min(a[0], b[0])) dirs.add('l');
        if (c[0] < Math.max(a[0], b[0])) dirs.add('r');
      }
      if (onV) {
        if (c[1] > Math.min(a[1], b[1])) dirs.add('u');
        if (c[1] < Math.max(a[1], b[1])) dirs.add('d');
      }
    }
    if (dirs.size >= 3) dots.push(c);
  }
  return dots;
}

function labelAnchor(paths: Vec[][], obstacles: Rect[]): { pos: Vec; room: number } | null {
  // The longest free stretch of a horizontal segment of the first path: labels that sit where
  // the value label would (just above the wire) are cut out of it. A label beside a
  // vertical segment only crosses it.
  const p = paths[0];
  if (!p) return null;
  let best: { pos: Vec; room: number } | null = null, len = -1;
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]];
    if (a[1] !== b[1]) {
      const l = Math.abs(a[1] - b[1]) * 0.5;
      if (l > len) { len = l; best = { pos: [a[0], (a[1] + b[1]) / 2], room: Infinity }; }
      continue;
    }
    const y = a[1];
    let free: [number, number][] = [[Math.min(a[0], b[0]), Math.max(a[0], b[0])]];
    for (const r of obstacles) {
      if (r.y >= y - 0.25 || r.y + r.h <= y - 1.55) continue;
      const [x0, x1] = [r.x - 0.2, r.x + r.w + 0.2];
      free = free.flatMap(([lo, hi]): [number, number][] =>
        x1 <= lo || x0 >= hi ? [[lo, hi]] : [[lo, x0], [x1, hi]].filter(([u, v]) => v > u) as [number, number][]);
    }
    for (const [lo, hi] of free) {
      if (hi - lo > len) { len = hi - lo; best = { pos: [(lo + hi) / 2, y], room: hi - lo }; }
    }
  }
  return len >= 3 ? best : null;
}

/**
 * SVG path data for every routed path, with a hop (a small arc) wherever a horizontal
 * segment crosses a vertical segment of another net. Crossings closer than a hop's width
 * share one wider arc. Same-net crossings are left alone (they meet at junction dots).
 * With `only`, just those nets' paths are computed (every net still counts as an obstacle);
 * the others get an empty list: a cheap repaint of the wires an edit touched.
 */
export function hopPathData(nets: RoutedNet[], bars: { x: number; y0: number; y1: number }[] = [], r = 0.45, only?: Set<number>): string[][] {
  const eps = 0.01;
  // Vertical segments of every net, bucketed by x for quick lookup. Splitter / merger bars
  // are obstacles too (net -1): a wire passing over another bus's bar hops it.
  const vert = new Map<number, { y0: number; y1: number; net: number }[]>();
  for (const b of bars) {
    const list = vert.get(b.x) ?? [];
    list.push({ y0: b.y0, y1: b.y1, net: -1 });
    vert.set(b.x, list);
  }
  for (const n of nets) {
    for (const p of n.paths) {
      for (let i = 1; i < p.length; i++) {
        const [a, b] = [p[i - 1], p[i]];
        if (a[0] !== b[0] || a[1] === b[1]) continue;
        const list = vert.get(a[0]) ?? [];
        list.push({ y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), net: n.index });
        vert.set(a[0], list);
      }
    }
  }
  const xs = [...vert.keys()].sort((a, b) => a - b);
  const crossings = (y: number, xa: number, xb: number, net: number): number[] => {
    const lo = Math.min(xa, xb) + r + eps, hi = Math.max(xa, xb) - r - eps;
    const out: number[] = [];
    // binary search the first x ≥ lo
    let l = 0, h = xs.length;
    while (l < h) { const m = (l + h) >> 1; if (xs[m] < lo) l = m + 1; else h = m; }
    for (let i = l; i < xs.length && xs[i] <= hi; i++) {
      if (vert.get(xs[i])!.some((v) => v.net !== net && v.y0 < y - eps && v.y1 > y + eps)) out.push(xs[i]);
    }
    return out;
  };
  return nets.map((n) => only && !only.has(n.index) ? [] : n.paths.map((p) => {
    let d = `M${p[0][0]},${p[0][1]}`;
    for (let i = 1; i < p.length; i++) {
      const [a, b] = [p[i - 1], p[i]];
      if (a[1] === b[1] && a[0] !== b[0]) {
        const dir = Math.sign(b[0] - a[0]);
        const hits = crossings(a[1], a[0], b[0], n.index).sort((u, v) => (u - v) * dir);
        // Group crossings whose hops would overlap.
        const groups: [number, number][] = [];
        for (const x of hits) {
          const g = groups[groups.length - 1];
          if (g && Math.abs(x - g[1]) < 2 * r + 0.15) g[1] = x;
          else groups.push([x, x]);
        }
        for (const [x0, x1] of groups) {
          const s = x0 - dir * r, e = x1 + dir * r;
          const rx = Math.abs(e - s) / 2;
          // The arc always bulges upward: sweep 1 going right, 0 going left.
          d += ` L${s},${a[1]} A${rx},${r * 1.1} 0 0 ${dir > 0 ? 1 : 0} ${e},${a[1]}`;
        }
      }
      d += ` L${b[0]},${b[1]}`;
    }
    return d;
  }));
}

/** Vertical bars of the splitters and mergers in a netlist (obstacles for hops). */
export function splitterBars(nl: Netlist): { x: number; y0: number; y1: number }[] {
  const out: { x: number; y0: number; y1: number }[] = [];
  for (const i of nl.instances) {
    const k = i.def.symbol.kind;
    if (k !== 'split' && k !== 'merge') continue;
    const g = symbolGeom(i.def);
    const at = i.at ?? [0, 0];
    const ys = i.def.ports.filter((p) => (k === 'split' ? p.dir === 'out' : p.dir === 'in')).map((p) => g.ports[p.name].pos[1]);
    out.push({ x: at[0] + 0.5, y0: at[1] + Math.min(...ys) - 0.4, y1: at[1] + Math.max(...ys) + 0.4 });
  }
  return out;
}

/**
 * Ends ('inst.port' or a pin) whose wire arrives from behind: across the symbol, so it looks
 * attached to the wrong side (a splitter's input reached from its outputs' side).
 */
export function backwardEnds(def: ComponentDef, nl: Netlist): string[] {
  const { nets, pins } = routeNetlist(def, nl);
  const out = new Set<string>();
  for (const n of nets) {
    const ends = nl.nets[n.index].ends.map((e) => ({ e, g: endGeom(def, nl, pins, e) }));
    for (const p of n.paths) {
      if (p.length < 2) continue;
      for (const [at, next] of [[p[0], p[1]], [p[p.length - 1], p[p.length - 2]]]) {
        const end = ends.find(({ g }) => g.pos[0] === at[0] && g.pos[1] === at[1]);
        if (!end) continue;
        const d = DIR[end.g.exit];
        if ((next[0] - at[0]) * d[0] + (next[1] - at[1]) * d[1] < -1e-6) out.add(end.e);
      }
    }
  }
  return [...out];
}

/** Instance bodies drawn on top of one another (wiring aliases included: a splitter under a gate hides it). */
export function symbolOverlaps(nl: Netlist): string[] {
  const bodies = symbolRects(nl).filter((r) => r.what.startsWith('instance '));
  const out: string[] = [];
  bodies.forEach((a, i) => bodies.slice(i + 1).forEach((b) => {
    if (overlaps(a.r, b.r)) out.push(`${a.inst} × ${b.inst}`);
  }));
  return out;
}

/**
 * Labels drawn on top of each other or over a symbol: net tags, tap bit ranges, instance
 * bodies and box names. Used by tests so that a layout change can't silently hide a label.
 */
export function labelOverlaps(def: ComponentDef, nl: Netlist): string[] {
  const labels: { what: string; r: Rect; inst?: string }[] = [];
  for (const n of routeNetlist(def, nl).nets) {
    const name = nl.nets[n.index].name ?? `n${n.index}`;
    for (const t of n.tags) labels.push({ what: `tag '${name}' at ${t.end}`, r: tagGeom(t, name).rect, inst: parseEnd(t.end).inst ?? undefined });
  }
  for (const t of tapLabels(nl)) labels.push({ what: `tap '${t.text}' at ${t.end}`, r: t.rect, inst: parseEnd(t.end).inst ?? undefined });
  const all = [...labels, ...symbolRects(nl)];
  const out: string[] = [];
  // Each label against every later label and every symbol other than its own.
  labels.forEach((a, i) => all.slice(i + 1).forEach((b) => {
    if (a.inst !== undefined && a.inst === b.inst) return;
    if (overlaps(a.r, b.r)) out.push(`${a.what} × ${b.what}`);
  }));
  return out;
}
