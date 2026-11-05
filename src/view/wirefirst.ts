// Wires first: what a level draws as wires although its author's generator labelled it. A view rule over the netlist,
// never part of it (the simulation, statistics and Verilog know nothing of it); the learner's layout applies on top.
//
// A wire shows the mechanism and carries the flowing bits; a pointer does neither, and on a fitted view its name is
// often too small to read. So a level is wired whole when that stays readable, else its local nets are: those that run
// forward a short way to a few sinks. What stays a pointer is what a wire would tangle: feedback across a level, long
// spans, wide fan-out. A clock or reset reaching many parts stays a pointer anywhere, as on a real schematic.
import { instPort, type Vec } from '../sim/geometry';
import { parseEnd, type ComponentDef, type NetDef, type Netlist } from '../sim/types';
import { routeNetlist, symbolRects, wireOverlaps, type RoutedNet } from './route';

/** A level of up to this many nets is tried wired whole. */
export const WHOLE_NETS = 30;
/** Wired whole only under this many wire crossings per net: past it the wires read worse than the pointers. */
export const MAX_CROSSINGS_PER_NET = 3;
/** Past this many nets a level keeps its author's drawing: routing it a second time would be felt, and little is local. */
export const LOCAL_NETS = 120;
/** A local net reaches at most this far (grid units), to fewer than FAN sinks. */
const FAR = 45, FAN = 5;
/** A clock or reset with this many sinks stays a pointer. */
const CLOCK_FAN = 3;
/** Rerouting moves wires, so a net kept as a pointer can send another through a part: a few passes settle it. */
const CLEAR_PASSES = 4;
const EDGE = 0.01;
const CLOCK = /^(clk|clock|rst|reset|rst_n|phi\d)$/i;

const tagged = (n: NetDef) => n.tags === true || (n.tags?.length ?? 0) > 0;

/** Wire crossings between different nets of a routed level. */
export function wireCrossings(nets: readonly { paths: Vec[][] }[]): number {
  const hs: { n: number; a: number; b: number; c: number }[] = [], vs: typeof hs = [];
  nets.forEach((net, n) => {
    for (const p of net.paths) for (let i = 0; i + 1 < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      if (y0 === y1) hs.push({ n, a: Math.min(x0, x1), b: Math.max(x0, x1), c: y0 });
      else if (x0 === x1) vs.push({ n, a: Math.min(y0, y1), b: Math.max(y0, y1), c: x0 });
    }
  });
  let k = 0;
  for (const h of hs) for (const v of vs) if (h.n !== v.n && v.c > h.a && v.c < h.b && h.c > v.a && h.c < v.b) k++;
  return k;
}

function withWires(nl: Netlist, wire: (n: NetDef) => boolean): Netlist {
  return { ...nl, nets: nl.nets.map((n) => {
    if (!tagged(n) || !wire(n)) return n;
    const out = { ...n };
    delete out.tags;
    delete out.tagAt;
    return out;
  }) };
}

function endPos(nl: Netlist, end: string): Vec | undefined {
  const { inst, port } = parseEnd(end);
  if (inst === null) return nl.pins?.[port];
  const i = nl.instances.find((x) => x.name === inst);
  return i?.at && instPort(i.def, i.at, i.flip, port, i.rot).pos;
}

const manyClock = (n: NetDef) => CLOCK.test(n.name ?? '') && n.ends.length - 1 >= CLOCK_FAN;

function isLocal(nl: Netlist, n: NetDef): boolean {
  if (manyClock(n) || n.ends.length - 1 >= FAN) return false;
  const d = endPos(nl, n.ends[0]);
  if (!d) return false;
  return n.ends.slice(1).every((e) => {
    const s = endPos(nl, e);
    return !!s && s[0] >= d[0] - 2 && Math.abs(s[0] - d[0]) + Math.abs(s[1] - d[1]) <= FAR;
  });
}

/** The nets (their index in `nl`) with a wire running through a part's body. */
export function wiresThroughParts(nl: Netlist, nets: readonly RoutedNet[]): Set<number> {
  const bodies = symbolRects(nl).filter((b) => b.what.startsWith('instance ')).map((b) => b.r);
  const hit = new Set<number>();
  for (const net of nets) for (const p of net.paths) for (let i = 0; i + 1 < p.length; i++) {
    const x0 = Math.min(p[i][0], p[i + 1][0]), x1 = Math.max(p[i][0], p[i + 1][0]);
    const y0 = Math.min(p[i][1], p[i + 1][1]), y1 = Math.max(p[i][1], p[i + 1][1]);
    // strictly inside: a wire may end on a part's edge, where its pins are
    if (bodies.some((r) => x0 < r.x + r.w - EDGE && x1 > r.x + EDGE && y0 < r.y + r.h - EDGE && y1 > r.y + EDGE)) hit.add(net.index);
  }
  return hit;
}

/** The nets `wire` picks, as wires; those that would run through a part stay pointers. */
function wiredClear(def: ComponentDef, nl: Netlist, wire: (n: NetDef) => boolean): Netlist {
  const keep = new Set<NetDef>();
  for (let pass = 0; pass < CLEAR_PASSES; pass++) {
    const c = withWires(nl, (x) => wire(x) && !keep.has(x));
    const hit = [...wiresThroughParts(c, routeNetlist(def, c).nets)].map((i) => nl.nets[i]).filter((x) => tagged(x) && !keep.has(x));
    if (!hit.length) return c;
    for (const x of hit) keep.add(x);
  }
  return nl;
}

const cache = new WeakMap<Netlist, Netlist>();

/** The level as first drawn: `nl` with the nets wires can carry readably drawn as wires. */
export function drawnNetlist(def: ComponentDef, nl: Netlist): Netlist {
  const known = cache.get(nl);
  if (known) return known;
  let out = nl;
  const n = nl.nets.length;
  if (n <= LOCAL_NETS && nl.nets.some(tagged)) {
    const fits = (c: Netlist, limit: number) => {
      const r = routeNetlist(def, c).nets;
      return wireOverlaps(r).length === 0 && wireCrossings(r) <= limit;
    };
    const whole = n <= WHOLE_NETS ? wiredClear(def, nl, (x) => !manyClock(x)) : null;
    const local = wiredClear(def, nl, (x) => isLocal(nl, x));
    if (whole && fits(whole, MAX_CROSSINGS_PER_NET * n)) out = whole;
    else if (fits(local, Infinity)) out = local;
  }
  cache.set(nl, out);
  return out;
}
