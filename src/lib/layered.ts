// Layout for Builder-made blocks of many small parts: columns by logic depth (a feedback edge cut at the first part that closes a
// loop), rows ordered to shorten wires, every part then moved so its ports sit level with the ports it talks to, pins at the
// height of what they feed. Layout only: instances, nets and their order are the Builder's, so simulation, statistics and Verilog
// are untouched.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, Netlist, PortDef } from '../sim/types';
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
  /** Rows to move a part by after the layout settled (negative: up): out of the way of a wire that must pass it. */
  nudge?: Record<string, number>;
  /** Pins in this order, top to bottom, whatever their sinks ask for (the others sorted by height). */
  pinOrder?: string[];
  /**
   * Size the space around parts from what is drawn there: between two stacked parts room for a label hanging from a bottom port
   * and the next box's name, each channel a trunk per net through it and the labels on both its sides. Off: vgap and a channel
   * of gap + one unit per six wires (at most 14), which suits most blocks better; on, for blocks whose labels collide.
   */
  room?: boolean;
  /**
   * Keep each column's parts in the order the Builder added them (register 0 above register 1, bit 0 above bit 1): the rows only
   * move up or down to sit level with what they connect to. Off: rows reordered by their neighbours (fewer crossings, but a
   * bit-sliced block may come out of order).
   */
  keepOrder?: boolean;
  /** Minimum row-to-row spacing of pins. */
  pinPitch?: number | [number, number];
  /**
   * The shape to aim at (width / height, a stage's canvas is about 1.6): a drawing much wider is folded into 2–4 bands stacked
   * top to bottom at its natural seams (the channels the fewest edges cross), so a long chain of logic fits large, not as a strip.
   */
  aspect?: number;
}

/** How far a net label reaches from its port (view/route.ts: TAG_STUB + TAG_H), and the height of a box's name above it. */
const TAG_DROP = 2.75, NAME_H = 1.2;
/** A net label's width (view/route.ts textWidth at 0.8 + 0.6; lib/ does not import the view). */
const tagWidth = (name: string) => name.length * 0.8 * 0.62 + 1.4;

const CLOCK = /^(clk|clock|rst|reset|wclk|rclk)$/i;
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
  // room between two parts stacked in a column: a label hanging from the upper one's bottom port (stub + box, view/route.ts
  // TAG_STUB + TAG_H), the lower box's name above it, a label standing on the lower one's top port
  const sides = new Map(names.map((n) => [n, new Set(Object.values(geom.get(n)!.ports).map((p) => p.exit))]));
  const isBox = (n: string) => byName.get(n)!.def.symbol.kind === 'box' && byName.get(n)!.def.prim !== 'alias';
  const room = (a: string, b: string): number => !opts.room ? vgap : Math.max(vgap, Math.ceil((sides.get(a)!.has('down') ? TAG_DROP : 0) + (isBox(b) ? NAME_H : 0) + (sides.get(b)!.has('up') ? TAG_DROP : 0) + 0.3));
  const below = (a: string, b: string) => top.get(a)! + h(a) + room(a, b);
  const top = new Map<string, number>();
  const stack = (col: string[]) => { let y = 2; col.forEach((n, i) => { if (i) y = below(col[i - 1], n); top.set(n, y); }); };
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
      if (!opts.keepOrder) col.sort((p, q) => want.get(p)! - want.get(q)! || names.indexOf(p) - names.indexOf(q));
      col.forEach((n, i) => top.set(n, Math.max(i ? below(col[i - 1], n) : 2, Math.round(want.get(n)!))));
    }
    initPins();
  }
  // a last pass downwards and upwards to close the gaps the stacking left (rows keep their order and spacing)
  for (let sweep = 0; sweep < 6; sweep++) {
    for (const col of cols) {
      for (let i = 0; i < col.length; i++) {
        const n = col[i]; const a = aim(n); if (a === null) continue;
        const lo = i ? below(col[i - 1], n) : 2;
        const hi = i + 1 < col.length ? top.get(col[i + 1])! - room(n, col[i + 1]) - h(n) : Infinity;
        top.set(n, Math.max(lo, Math.min(hi, Math.round(a))));
      }
    }
    initPins();
  }
  for (const [n, d] of Object.entries(opts.nudge ?? {})) top.set(n, top.get(n)! + d);
  initPins();
  // nothing anchors the rows, so the whole drawing may have drifted: back to the top
  const lift = 2 - Math.min(...names.map((n) => top.get(n)!), ...[...pinY.values()].map((y) => y));
  for (const n of names) top.set(n, top.get(n)! + lift);
  for (const [p, y] of pinY) pinY.set(p, y + lift);
  // x: columns, a channel between them as wide as the wires that run there (a trunk each, half a unit apart) and, once it is
  // known which nets are labels, the labels on both its sides
  const spans = cols.map((_, c) => edges.filter((e) => layer.get(e.from)! <= c && layer.get(e.to)! > c));
  const channel = (c: number) => (opts.room ? Math.min(24, (opts.gap ?? 6) + Math.ceil(new Set(spans[c].map((e) => `${e.from}.${e.fp}`)).size / 3))
    : Math.min(14, (opts.gap ?? 6) + Math.floor(spans[c].length / 6)));
  const lay = (extra: number[]) => {
    const x = new Map<string, number>();
    let cx = opts.x0 ?? 10;
    for (let c = 0; c < L; c++) {
      const cw = Math.max(0, ...cols[c].map(w));
      for (const n of cols[c]) x.set(n, cx);
      cx += cw + Math.max(channel(c), extra[c] ?? 0);
    }
    const instances: InstanceDef[] = insts.map((i) => ({ ...i, at: [x.get(i.name)!, top.get(i.name)!] }));
    // pins: inputs left, outputs right; ordered by the height they want, kept `pitch` apart
    const pitches: [number, number] = Array.isArray(opts.pinPitch) ? opts.pinPitch : [opts.pinPitch ?? 2, opts.pinPitch ?? 2];
    const pins: Record<string, [number, number]> = {};
    const place = (side: PortDef[], px: number, pitch: number) => {
      const rank = (n: string) => opts.pinOrder?.indexOf(n) ?? -1;
      const want = side.map((p) => ({ p: p.name, y: pinY.get(p.name) ?? 2 })).sort((a, b) => (rank(a.p) >= 0 && rank(b.p) >= 0 ? rank(a.p) - rank(b.p) : a.y - b.y));
      let y = 2;
      for (const q of want) { const t = Math.max(y, Math.round(q.y)); pins[q.p] = [px, t]; y = t + pitch; }
    };
    place(ports.filter((p) => p.dir === 'in'), 0, pitches[0]);
    place(ports.filter((p) => p.dir === 'out'), cx, pitches[1]);
    // what a wire reads as well as a label draws as a wire (the view's wires-first rule would do the same): a net that runs forward a
    // short way to a few sinks, and anything the caller names
    const at = new Map(instances.map((i) => [i.name, i.at!]));
    const endPos = (end: string): [number, number] => {
      const n = inst(end);
      if (!n) return pins[end] ?? [0, 0];
      const p = geom.get(n)!.ports[portOf(end)]?.pos ?? [0, 0];
      return [at.get(n)![0] + p[0], at.get(n)![1] + p[1]];
    };
    const outNets = nets.map((n) => {
      const o = opts.wires?.[n.ends[0]];
      const local = n.tags === true && n.ends.length - 1 < 5 && !CLOCK.test(n.name ?? '') && (() => {
        const d = endPos(n.ends[0]);
        return n.ends.slice(1).every((e) => { const q = endPos(e); return q[0] >= d[0] - 2 && Math.abs(q[0] - d[0]) + Math.abs(q[1] - d[1]) <= 45; });
      })();
      if (o === undefined && !local) return n;
      if (o === false) return { ...n, tags: true as const };
      const c = { ...n };
      if (o ?? local) delete c.tags;
      return c;
    });
    return { pins, instances, nets: outNets };
  };
  // the labels' room: per channel, the widest label leaving the column on its left plus the widest entering the one on its right
  const labelRoom = (nl: Netlist): number[] => {
    const right = new Array<number>(L).fill(0), left = new Array<number>(L).fill(0);
    nl.nets.forEach((n, k) => {
      if (n.tags !== true) return;
      const tw = tagWidth(n.name ?? `n${k}`);
      for (const e of n.ends) {
        const i = inst(e); if (!i) continue;
        const ex = geom.get(i)!.ports[portOf(e)]?.exit, c = layer.get(i)!;
        if (ex === 'right') right[c] = Math.max(right[c], tw);
        else if (ex === 'left' && c > 0) left[c - 1] = Math.max(left[c - 1], tw);
      }
    });
    return right.map((r, c) => (r || left[c] ? Math.ceil(r + left[c] + 1) : 0));
  };
  let nl = lay([]);
  for (let pass = 0; opts.room && pass < 2; pass++) {
    const need = labelRoom(nl);
    const next = lay(need);
    if (JSON.stringify(next.nets.map((n) => !!n.tags)) === JSON.stringify(nl.nets.map((n) => !!n.tags)) && pass) { nl = next; break; }
    nl = next;
  }
  if (opts.aspect) nl = fold(nl, opts.aspect);
  const { pins, instances, nets: outNets } = nl;
  void byName;
  return { pins, instances, nets: outNets };

  /**
   * A drawing far wider than `target` (w / h): its columns in 2–4 bands stacked top to bottom, as many as bring the whole
   * closest to the target. Each seam is the channel near an even split that the fewest edges cross (a functional group's
   * edge, a register boundary). A net reaching across a seam becomes labels; a pin stands at the band it serves.
   */
  function fold(nl: ReturnType<typeof lay>, target: number): ReturnType<typeof lay> {
    const at = new Map(nl.instances.map((i) => [i.name, i.at!]));
    const colX = cols.map((col) => Math.min(...col.map((n) => at.get(n)![0])));
    const colR = cols.map((col) => Math.max(...col.map((n) => at.get(n)![0] + w(n))));
    const x0 = opts.x0 ?? 10, right = Math.max(...colR);
    const extent = (cs: number[]) => {
      const ns = cs.flatMap((c) => cols[c]);
      return { y0: Math.min(...ns.map((n) => at.get(n)![1])), y1: Math.max(...ns.map((n) => at.get(n)![1] + h(n))) };
    };
    const all = extent([...cols.keys()]), H1 = all.y1 - all.y0;
    if (L < 4 || right / Math.max(H1, 1) <= target * 1.35) return nl;
    // seams for R bands: per cut, the channel within a quarter band of the even split that the fewest edges cross
    const seamsFor = (R: number): number[] | null => {
      const cuts: number[] = [];
      for (let k = 1; k < R; k++) {
        const ideal = x0 + ((right - x0) * k) / R, slack = (right - x0) / R / 4;
        let best = -1, bestCost = Infinity;
        for (let c = (cuts.at(-1) ?? -1) + 1; c < L - 1; c++) {
          const gapX = (colR[c] + colX[c + 1]) / 2;
          if (Math.abs(gapX - ideal) > slack) continue;
          const cost = spans[c].length + Math.abs(gapX - ideal) / slack;
          if (cost < bestCost) { bestCost = cost; best = c; }
        }
        if (best < 0) return null;
        cuts.push(best);
      }
      return cuts;
    };
    const BAND_GAP = 8;
    const plan = (cuts: number[]) => {
      const bands: number[][] = [];
      let s = 0;
      for (const c of [...cuts, L - 1]) { bands.push(Array.from({ length: c - s + 1 }, (_, i) => s + i)); s = c + 1; }
      const ext = bands.map(extent);
      const width = Math.max(...bands.map((b) => colR[b.at(-1)!] - colX[b[0]])) + x0;
      const height = ext.reduce((a, e) => a + (e.y1 - e.y0), 0) + BAND_GAP * (bands.length - 1);
      return { bands, ext, width, height };
    };
    let best: ReturnType<typeof plan> | null = null, bestErr = Math.abs(Math.log(right / Math.max(H1, 1) / target));
    for (let R = 2; R <= 4; R++) {
      const cuts = seamsFor(R);
      if (!cuts) continue;
      const p = plan(cuts), err = Math.abs(Math.log(p.width / Math.max(p.height, 1) / target));
      if (err < bestErr - 1e-9) { best = p; bestErr = err; }
    }
    if (!best) return nl;
    const band = new Map<string, number>();
    const moved = new Map<string, [number, number]>();
    let y = 2;
    best.bands.forEach((cs, k) => {
      const e = best!.ext[k], dx = x0 - colX[cs[0]], dy = y - e.y0;
      for (const c of cs) for (const n of cols[c]) { band.set(n, k); const p = at.get(n)!; moved.set(n, [p[0] + dx, p[1] + dy]); }
      y += e.y1 - e.y0 + BAND_GAP;
    });
    const instances = nl.instances.map((i) => ({ ...i, at: moved.get(i.name)! }));
    const portAt = (end: string): [number, number] | null => {
      const n = inst(end); if (!n) return null;
      const p = geom.get(n)!.ports[portOf(end)]?.pos ?? [0, 0], q = moved.get(n)!;
      return [q[0] + p[0], q[1] + p[1]];
    };
    // pins: each at the height of the ends it serves, inputs at the left edge, outputs at the right, kept a pitch apart
    const pitches: [number, number] = Array.isArray(opts.pinPitch) ? opts.pinPitch : [opts.pinPitch ?? 2, opts.pinPitch ?? 2];
    const pins: Record<string, [number, number]> = {};
    const outX = best.width + Math.max(6, Math.ceil(Math.max(0, ...ports.filter((p) => p.dir === 'out').map((p) => tagWidth(p.name))) + 12));
    const rank = (n: string) => opts.pinOrder?.indexOf(n) ?? -1; // pinOrder holds when folded too (a chip face keeps it)
    const place = (side: PortDef[], px: number, pitch: number) => {
      const want = side.map((p) => {
        const ys = nl.nets.filter((n) => n.ends.includes(p.name)).flatMap((n) => n.ends.map(portAt)).filter((q): q is [number, number] => !!q).map((q) => q[1]);
        return { p: p.name, y: ys.length ? ys.reduce((a, v) => a + v, 0) / ys.length : 2 };
      }).sort((a, b) => (rank(a.p) >= 0 && rank(b.p) >= 0 ? rank(a.p) - rank(b.p) : a.y - b.y));
      let yy = 2;
      for (const q of want) { const t = Math.max(yy, Math.round(q.y)); pins[q.p] = [px, t]; yy = t + pitch; }
    };
    place(ports.filter((p) => p.dir === 'in'), 0, pitches[0]);
    place(ports.filter((p) => p.dir === 'out'), outX, pitches[1]);
    // a net across a seam is labels; within one band it keeps layered's choice
    const bandOf = (end: string): number | 'pin' => { const n = inst(end); return n ? band.get(n)! : 'pin'; };
    const nets = nl.nets.map((n) => {
      const bs = new Set(n.ends.map(bandOf).filter((b) => b !== 'pin'));
      if (bs.size <= 1 || opts.wires?.[n.ends[0]] === true) return n;
      return { ...n, tags: true as const };
    });
    return { pins, instances, nets };
  }
}

/**
 * A Builder-made level's netlist laid out by layered(), for a definition's `netlist: laid(b, opts)`: the ports are the
 * definition's own, read when the netlist is first asked for (netlistOf calls it as the definition's method).
 */
export function laid(b: Builder, opts: LayeredOptions = {}): (this: ComponentDef) => Netlist {
  return function (this: ComponentDef) { return layered(this.ports, b, opts); };
}
