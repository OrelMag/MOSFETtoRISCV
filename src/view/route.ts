// Orthogonal wire routing for a component's internal view. Deliberately simple and
// predictable: each wire leaves its driver in the port's exit direction, runs along a
// shared trunk, and enters each sink from the sink's side. Authors untangle the rare hard
// case with `trunk` and `via` on the NetDef.

import { type ExitDir, instPort, type PortGeom, symbolGeom, type Vec } from '../sim/geometry';
import { type ComponentDef, type Netlist, parseEnd } from '../sim/types';

export interface NetTag {
  end: string;
  /** Port position and the direction the stub leaves it. */
  pos: Vec;
  dir: ExitDir;
  /** Stub length: longer on a splitter / merger tap, so the label clears the tap's bit range. */
  stub: number;
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
  /** Where to draw the bus value label. */
  label: Vec | null;
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

export function routeNetlist(def: ComponentDef, nl: Netlist): { nets: RoutedNet[]; pins: Map<string, PinGeom> } {
  const pins = pinGeoms(def, nl);
  const taps = new Map(tapLabels(nl).map((t) => [t.end, t]));
  const nets = nl.nets.map((net, index): RoutedNet => {
    const ends = net.ends.map((e) => endGeom(def, nl, pins, e));
    const { inst, port } = parseEnd(net.ends[0]);
    const width = inst === null
      ? def.ports.find((p) => p.name === port)!.width
      : nl.instances.find((i) => i.name === inst)!.def.ports.find((p) => p.name === port)!.width;
    const drv = ends[0];
    const P = drv.pos;
    const P1 = add(P, DIR[drv.exit], STUB);
    const tagged = (i: number) => net.tags === true || (net.tags?.includes(net.ends[i]) ?? false);
    const tag = (i: number): NetTag => {
      const tap = taps.get(net.ends[i]);
      return { end: net.ends[i], pos: ends[i].pos, dir: ends[i].exit, stub: tap ? TAP_GAP + tap.rect.w + 0.5 : TAG_STUB };
    };
    // A tagged sink so close to its driver that the two labels would collide is just wired.
    const name = net.name ?? `n${index}`;
    const near = (i: number) => overlaps(tagGeom(tag(0), name).rect, tagGeom(tag(i), name).rect);
    const tags: NetTag[] = [];
    const drawn: number[] = [];
    for (let i = 1; i < ends.length; i++) {
      if (tagged(i) && !near(i)) tags.push(tag(i));
      else drawn.push(i);
    }
    if (tags.length && (drawn.length === 0 || tagged(0))) tags.unshift(tag(0));
    const sinks = drawn.map((i) => ends[i]);
    const sinkNames = drawn.map((i) => net.ends[i]);
    const multi = sinks.length > 1;
    const paths = sinks.map((s, si) => {
      const via = net.via?.[sinkNames[si]];
      if (via && via.length) {
        const pts: Vec[] = [P];
        // Leave the driver in its exit direction.
        pts.push(horiz(drv.exit) ? [via[0][0], P[1]] : [P[0], via[0][1]]);
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
        return simplify(pts);
      }
      const S = s.pos;
      const S1 = add(S, DIR[s.exit], STUB);
      if (horiz(drv.exit)) {
        const xm = net.trunk ?? (multi ? P1[0] : half((P1[0] + S1[0]) / 2));
        return simplify([P, P1, [xm, P1[1]], [xm, S1[1]], S1, S]);
      }
      const ym = net.trunk ?? (multi ? P1[1] : half((P1[1] + S1[1]) / 2));
      return simplify([P, P1, [P1[0], ym], [S1[0], ym], S1, S]);
    });
    return { index, width, tags, paths, dots: junctions(paths), label: width > 1 ? labelAnchor(paths) : null };
  });
  return { nets, pins };
}

const TAG_STUB = 1.4, TAG_H = 1.35, TAP_GAP = 0.12;

/** Where a net tag's stub ends and the rectangle of its name label. */
export function tagGeom(t: NetTag, name: string): { tip: Vec; rect: Rect } {
  const d = DIR[t.dir];
  const tip: Vec = [t.pos[0] + d[0] * t.stub, t.pos[1] + d[1] * t.stub];
  const w = textWidth(name, 0.8) + 0.6, h = TAG_H;
  const x = t.dir === 'right' ? tip[0] : t.dir === 'left' ? tip[0] - w : tip[0] - w / 2;
  const y = t.dir === 'down' ? tip[1] : t.dir === 'up' ? tip[1] - h : tip[1] - h / 2;
  return { tip, rect: { x, y, w, h } };
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
function junctions(paths: Vec[][]): Vec[] {
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
      if (!onH && !onV) continue;
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

function labelAnchor(paths: Vec[][]): Vec | null {
  // Midpoint of the longest horizontal segment of the first path.
  const p = paths[0];
  if (!p) return null;
  let best: Vec | null = null, len = -1;
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]];
    const l = a[1] === b[1] ? Math.abs(a[0] - b[0]) : Math.abs(a[1] - b[1]) * 0.5;
    if (l > len) {
      len = l;
      best = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
  }
  return len >= 3 ? best : null;
}

/**
 * SVG path data for every routed path, with a hop (a small arc) wherever a horizontal
 * segment crosses a vertical segment of another net. Crossings closer than a hop's width
 * share one wider arc. Same-net crossings are left alone (they meet at junction dots).
 */
export function hopPathData(nets: RoutedNet[], bars: { x: number; y0: number; y1: number }[] = [], r = 0.45): string[][] {
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
  return nets.map((n) => n.paths.map((p) => {
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
