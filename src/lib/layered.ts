// Layout for Builder-made blocks of many small parts: columns by logic depth (a feedback edge cut at the first part that closes a
// loop), rows ordered to shorten wires, every part then moved so its ports sit level with the ports it talks to, pins at the
// height of what they feed. Layout only: instances, nets and their order are the Builder's, so simulation, statistics and Verilog
// are untouched.

import { symbolGeom } from '../sim/geometry';
import type { InstanceDef, NetDef, Netlist, PortDef } from '../sim/types';
import type { Builder } from './builder';

export interface LayeredOptions {
  /** Left margin before the first column (the pins stand at x = 0). */
  x0?: number;
  /** Space between columns: base + one per `perEdge` wires between them, clamped. */
  gap?: number;
  vgap?: number;
  /** Instances to leave in the column the Builder gave them (by name): none by default. */
  pinned?: string[];
  /** Nets (by driver end) forced to wires, or to pointers (false). */
  wires?: Record<string, boolean>;
  /** Column per instance name, overriding the depth (relative, 0 = first). */
  column?: Record<string, number>;
  /** Minimum row-to-row spacing of pins. */
  pinPitch?: number;
}

const inst = (end: string): string | null => (end.includes('.') ? end.slice(0, end.indexOf('.')) : null);
const portOf = (end: string): string => end.slice(end.indexOf('.') + 1);

export function layered(ports: PortDef[], b: Builder, opts: LayeredOptions = {}): Netlist {
  const nets: NetDef[] = b.nets();
  const insts = b.instances;
  const byName = new Map(insts.map((i) => [i.name, i]));
  const geom = new Map(insts.map((i) => [i.name, symbolGeom(i.def)]));
  const names = insts.map((i) => i.name);
  // edges between instances
  type Edge = { from: string; fp: string; to: string; tp: string };
  const edges: Edge[] = [];
  for (const n of nets) {
    const d = inst(n.ends[0]);
    if (!d) continue;
    for (const s of n.ends.slice(1)) { const t = inst(s); if (t) edges.push({ from: d, fp: portOf(n.ends[0]), to: t, tp: portOf(s) }); }
  }
  // cut feedback: depth-first from parts nothing feeds, then the rest, in the Builder's order
  const out = new Map<string, Edge[]>(names.map((n) => [n, []]));
  const inn = new Map<string, number>(names.map((n) => [n, 0]));
  for (const e of edges) { out.get(e.from)!.push(e); inn.set(e.to, inn.get(e.to)! + 1); }
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<Edge>();
  const visit = (n: string): void => {
    state.set(n, 1);
    for (const e of out.get(n)!) {
      const s = state.get(e.to) ?? 0;
      if (s === 1) back.add(e);
      else if (s === 0) visit(e.to);
    }
    state.set(n, 2);
  };
  for (const n of names) if (!inn.get(n) && !state.get(n)) visit(n);
  for (const n of names) if (!state.get(n)) visit(n);
  const fwd = edges.filter((e) => !back.has(e) && e.from !== e.to);
  // depth: longest path; sources with no part feeding them move to just before their first reader
  const layer = new Map<string, number>(names.map((n) => [n, 0]));
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const e of fwd) if (layer.get(e.to)! < layer.get(e.from)! + 1) { layer.set(e.to, layer.get(e.from)! + 1); moved = true; }
    if (!moved) break;
  }
  const fedBy = new Set(fwd.map((e) => e.to));
  for (let pass = 0; pass < 4; pass++) {
    for (const n of names) {
      if (fedBy.has(n)) continue;
      const rs = fwd.filter((e) => e.from === n).map((e) => layer.get(e.to)!);
      if (rs.length) layer.set(n, Math.min(...rs) - 1);
    }
  }
  const minL = Math.min(...names.map((n) => layer.get(n)!));
  for (const n of names) layer.set(n, layer.get(n)! - minL + (opts.column?.[n] ?? 0));
  const L = Math.max(...names.map((n) => layer.get(n)!)) + 1;
  const cols: string[][] = Array.from({ length: L }, () => []);
  for (const n of names) cols[layer.get(n)!].push(n);

  const h = (n: string) => geom.get(n)!.h, w = (n: string) => geom.get(n)!.w;
  const portY = (n: string, p: string) => geom.get(n)!.ports[p]?.pos[1] ?? h(n) / 2;
  const vgap = opts.vgap ?? 3;
  const top = new Map<string, number>();
  const stack = (col: string[]) => { let y = 2; for (const n of col) { top.set(n, y); y += h(n) + vgap; } };
  cols.forEach(stack);
  // pins: input pins' sinks, output pins' drivers (for the pull of a row)
  const pinEnds = new Map<string, { inst: string; port: string; out: boolean }[]>();
  for (const n of nets) {
    const d = inst(n.ends[0]);
    if (!d) { const l = pinEnds.get(n.ends[0]) ?? []; for (const s of n.ends.slice(1)) { const t = inst(s); if (t) l.push({ inst: t, port: portOf(s), out: false }); } pinEnds.set(n.ends[0], l); }
    for (const s of n.ends.slice(1)) if (!inst(s)) { const l = pinEnds.get(s) ?? []; if (d) l.push({ inst: d, port: portOf(n.ends[0]), out: true }); pinEnds.set(s, l); }
  }
  // neighbours of a part: [its port y offset, the other end's inst, port] over forward edges (back edges pull weakly)
  const nb = new Map<string, { own: number; other: string; op: string; wt: number; left: boolean }[]>(names.map((n) => [n, []]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    const wt = back.has(e) ? 0.25 : 1;
    nb.get(e.from)!.push({ own: portY(e.from, e.fp), other: e.to, op: e.tp, wt, left: false });
    nb.get(e.to)!.push({ own: portY(e.to, e.tp), other: e.from, op: e.fp, wt, left: true });
  }
  const pinY = new Map<string, number>();
  const aim = (n: string): number | null => {
    let s = 0, k = 0;
    for (const x of nb.get(n)!) { s += x.wt * (top.get(x.other)! + portY(x.other, x.op) - x.own); k += x.wt; }
    for (const [p, list] of pinEnds) for (const q of list) if (q.inst === n) { const y = pinY.get(p); if (y !== undefined) { s += 0.5 * (y - portY(n, q.port)); k += 0.5; } }
    return k ? s / k : null;
  };
  const initPins = () => {
    for (const [p, list] of pinEnds) {
      if (!list.length) { pinY.set(p, 2); continue; }
      pinY.set(p, list.reduce((a, q) => a + top.get(q.inst)! + portY(q.inst, q.port), 0) / list.length);
    }
  };
  initPins();
  // row order by the barycentre of the neighbours' ports, then the stacked rows pulled level with them
  for (let sweep = 0; sweep < 12; sweep++) {
    const order = sweep % 2 ? [...cols.keys()].reverse() : [...cols.keys()];
    for (const c of order) {
      const col = cols[c];
      const want = new Map(col.map((n) => [n, aim(n) ?? top.get(n)!]));
      col.sort((p, q) => want.get(p)! - want.get(q)! || names.indexOf(p) - names.indexOf(q));
      let y = 2;
      for (const n of col) { const t = Math.max(y, Math.round(want.get(n)!)); top.set(n, t); y = t + h(n) + vgap; }
    }
    initPins();
  }
  // a last pass downwards and upwards to close the gaps the stacking left (rows keep their order and spacing)
  for (let sweep = 0; sweep < 6; sweep++) {
    for (const col of cols) {
      for (let i = 0; i < col.length; i++) {
        const n = col[i]; const a = aim(n); if (a === null) continue;
        const lo = i ? top.get(col[i - 1])! + h(col[i - 1]) + vgap : 2;
        const hi = i + 1 < col.length ? top.get(col[i + 1])! - vgap - h(n) : Infinity;
        top.set(n, Math.max(lo, Math.min(hi, Math.round(a))));
      }
    }
    initPins();
  }
  // x: columns, a channel between them as wide as the wires that run there
  const x = new Map<string, number>();
  let cx = opts.x0 ?? 10;
  const colX: number[] = [];
  for (let c = 0; c < L; c++) {
    colX.push(cx);
    const cw = Math.max(0, ...cols[c].map(w));
    const span = edges.filter((e) => layer.get(e.from)! <= c && layer.get(e.to)! > c).length;
    cx += cw + Math.min(14, (opts.gap ?? 6) + Math.floor(span / 6));
    for (const n of cols[c]) x.set(n, colX[c]);
  }
  const instances: InstanceDef[] = insts.map((i) => ({ ...i, at: [x.get(i.name)!, top.get(i.name)!] }));
  void byName;
  // pins: inputs left, outputs right; ordered by the height they want, kept `pitch` apart
  const pitch = opts.pinPitch ?? 2;
  const pins: Record<string, [number, number]> = {};
  const place = (side: PortDef[], px: number) => {
    const want = side.map((p) => ({ p: p.name, y: pinY.get(p.name) ?? 2 })).sort((a, b) => a.y - b.y);
    let y = 2;
    for (const q of want) { const t = Math.max(y, Math.round(q.y)); pins[q.p] = [px, t]; y = t + pitch; }
  };
  place(ports.filter((p) => p.dir === 'in'), 0);
  place(ports.filter((p) => p.dir === 'out'), cx);
  const outNets = nets.map((n) => {
    const o = opts.wires?.[n.ends[0]];
    if (o === undefined) return n;
    const c = { ...n };
    if (o) delete c.tags; else c.tags = true;
    return c;
  });
  return { pins, instances, nets: outNets };
}
