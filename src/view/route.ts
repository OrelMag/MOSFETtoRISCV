// Orthogonal wire routing for a component's internal view. Deliberately simple and
// predictable: each wire leaves its driver in the port's exit direction, runs along a
// shared trunk, and enters each sink from the sink's side. Authors untangle the rare hard
// case with `trunk` and `via` on the NetDef.

import { type ExitDir, instPort, type PortGeom, symbolGeom, type Vec } from '../sim/geometry';
import { type ComponentDef, type Netlist, parseEnd } from '../sim/types';

export interface RoutedNet {
  index: number;
  width: number;
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
  const nets = nl.nets.map((net, index): RoutedNet => {
    const ends = net.ends.map((e) => endGeom(def, nl, pins, e));
    const { inst, port } = parseEnd(net.ends[0]);
    const width = inst === null
      ? def.ports.find((p) => p.name === port)!.width
      : nl.instances.find((i) => i.name === inst)!.def.ports.find((p) => p.name === port)!.width;
    const drv = ends[0];
    const P = drv.pos;
    const P1 = add(P, DIR[drv.exit], STUB);
    const sinks = ends.slice(1);
    const multi = sinks.length > 1;
    const paths = sinks.map((s, si) => {
      const via = net.via?.[net.ends[si + 1]];
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
    return { index, width, paths, dots: junctions(paths), label: width > 1 ? labelAnchor(paths) : null };
  });
  return { nets, pins };
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
  return best;
}
