// Technology mapping onto k-input look-up tables (the FPGA chapter, docs/PLAN-FPGA.md): cover a design's NAND gates with
// LUTs, each LUT one cut (a set of at most k nets that every path from a source to the gate's output crosses), whatever
// the gates inside compute. Priority cuts (Mishchenko et al.): every net keeps its best few cuts, merged from its
// gate's two inputs; a first pass picks the cut of least depth (LUT levels), then area recovery walks back from the
// outputs choosing, among the cuts that still meet the depth, the one of least area flow. Each LUT's truth table is its
// cone evaluated over every assignment of its leaves (tests/lutmap.test.ts: the LUT network equals the gates on every
// input).
//
// What is not mapped: storage drawn as gates (NANDs in a loop: a strongly connected component of the gate graph) and
// behaviour leaves (memories, external sources) stay as they are. Their outputs are sources of the mapping and their
// inputs are outputs it must produce, as an FPGA keeps a flip-flop or a block RAM beside its LUTs. A constant (a tie
// cell: a behaviour with no inputs) is folded into the truth tables.

import { flatten, type FlatDesign } from './flatten';
import type { ComponentDef } from './types';

export interface Lut {
  /** The net it drives. */
  out: number;
  /** Its inputs (the cut's leaves), in the order of the truth table's address bits (input i = bit i). */
  ins: number[];
  /** Output for each address 0 … 2^ins.length − 1: bit a (a bigint: a 6-input table has 64 bits). */
  table: bigint;
  /** The NAND leaves (indices into design.leaves) it replaces. A gate may sit in several LUTs' cones (duplication). */
  gates: number[];
  /** LUT levels from a source to its output. */
  level: number;
}

export interface LutMap {
  k: number;
  design: FlatDesign;
  /** In topological order. */
  luts: Lut[];
  /** LUT levels on the longest path. */
  depth: number;
  /** Nets the mapping starts from: the design's inputs, storage loops' and behaviours' outputs. */
  sources: number[];
  /** Nets it must produce: the design's outputs, storage loops' and behaviours' inputs. */
  sinks: number[];
  /** Constant nets folded into the tables. */
  consts: Map<number, 0 | 1>;
  /** NAND leaves left as they are: storage drawn as gates (loops). */
  loops: number[];
  /** NAND leaves the mapping covers (each once, however many LUTs repeat it). */
  nands: number;
}

export interface LutMapOptions {
  /** Inputs per LUT (default 4). */
  k?: number;
  /** Cuts kept per net (default 12). */
  keep?: number;
}

const MAX_K = 6;

/** Map a component (flattened at gate level) or an already flat design. */
export function lutMap(src: ComponentDef | FlatDesign, opts: LutMapOptions = {}): LutMap {
  const k = opts.k ?? 4, keep = opts.keep ?? 12;
  if (k < 2 || k > MAX_K) throw new Error(`lutMap: k = ${k}, not 2 … ${MAX_K}`);
  const design = 'leaves' in src ? src : flatten(src, { mode: 'gate' });
  const { leaves, root } = design;
  const N = design.netCount;

  // drivers, constants, boundaries
  const gateOf = new Int32Array(N).fill(-1);
  const consts = new Map<number, 0 | 1>();
  const sinkSet = new Set<number>(), sourceSet = new Set<number>();
  const nands: number[] = [];
  leaves.forEach((l, i) => {
    if (l.kind === 'nand') { gateOf[l.outputs[0][0]] = i; nands.push(i); return; }
    if (l.kind !== 'behavior') throw new Error(`lutMap: a ${l.kind} leaf (${l.node.path.join('.')}): map gate-level designs only`);
    const ins = l.inputs.flat();
    if (!ins.length && l.def.behavior?.eval && !l.def.behavior.seq) {
      const v = l.def.behavior.eval([], undefined as never) as number[];
      l.outputs.forEach((o, p) => o.forEach((n, b) => consts.set(n, ((v[p] >> b) & 1) as 0 | 1)));
      return;
    }
    for (const n of ins) sinkSet.add(n);
    for (const n of l.outputs.flat()) sourceSet.add(n);
  });
  for (const p of root.def.ports) {
    const nets = root.ports[p.name] ?? [];
    if (p.dir === 'in') for (const n of nets) sourceSet.add(n);
    else for (const n of nets) sinkSet.add(n);
  }

  // storage loops: strongly connected components of the gate graph (Tarjan, iterative)
  const readers = new Map<number, number[]>();
  for (const g of nands) for (const n of leaves[g].inputs.flat()) { const r = readers.get(n); if (r) r.push(g); else readers.set(n, [g]); }
  const inLoop = new Set<number>();
  {
    const index = new Map<number, number>(), low = new Map<number, number>(), on = new Set<number>(), stack: number[] = [];
    let next = 0;
    for (const start of nands) {
      if (index.has(start)) continue;
      const work: [number, number][] = [[start, 0]];
      index.set(start, next); low.set(start, next); next++; stack.push(start); on.add(start);
      while (work.length) {
        const top = work[work.length - 1], [g, i] = top;
        const succ = readers.get(leaves[g].outputs[0][0]) ?? [];
        if (i < succ.length) {
          top[1]++;
          const h = succ[i];
          if (!index.has(h)) { index.set(h, next); low.set(h, next); next++; stack.push(h); on.add(h); work.push([h, 0]); }
          else if (on.has(h)) low.set(g, Math.min(low.get(g)!, index.get(h)!));
          continue;
        }
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p)!, low.get(g)!)); }
        if (low.get(g) === index.get(g)) {
          const comp: number[] = [];
          for (;;) { const h = stack.pop()!; on.delete(h); comp.push(h); if (h === g) break; }
          const self = comp.length === 1 && leaves[g].inputs.flat().includes(leaves[g].outputs[0][0]);
          if (comp.length > 1 || self) for (const h of comp) inLoop.add(h);
        }
      }
    }
  }
  for (const g of inLoop) {
    sourceSet.add(leaves[g].outputs[0][0]);
    for (const n of leaves[g].inputs.flat()) if (!(gateOf[n] >= 0 && inLoop.has(gateOf[n]))) sinkSet.add(n);
  }
  const mapped = (n: number) => gateOf[n] >= 0 && !inLoop.has(gateOf[n]) && !sourceSet.has(n);

  // topological order of the mapped gates (depth-first from the sinks, so only what an output needs)
  const order: number[] = [];
  {
    const seen = new Uint8Array(N);
    for (const s of sinkSet) {
      if (!mapped(s) || seen[s]) continue;
      const work: [number, number][] = [[s, 0]];
      seen[s] = 1;
      while (work.length) {
        const top = work[work.length - 1], ins = leaves[gateOf[top[0]]].inputs;
        if (top[1] < 2) {
          const n = ins[top[1]++][0];
          if (mapped(n) && !seen[n]) { seen[n] = 1; work.push([n, 0]); }
          continue;
        }
        work.pop();
        order.push(top[0]);
      }
    }
  }

  // fanout (references by mapped gates and sinks): area flow divides a cone among its readers
  const fanout = new Float64Array(N);
  for (const n of order) for (const [i] of leaves[gateOf[n]].inputs) fanout[i]++;
  for (const s of sinkSet) fanout[s]++;

  // cuts per net, best first
  type Cut = { leaves: number[]; depth: number; flow: number };
  const cuts = new Map<number, Cut[]>();
  const arrival = new Float64Array(N), flow = new Float64Array(N);
  const leafCut = (n: number): Cut[] => (consts.has(n) ? [{ leaves: [], depth: 0, flow: 0 }] : [{ leaves: [n], depth: arrival[n], flow: flow[n] }]);
  const cutsOf = (n: number): Cut[] => {
    if (!mapped(n)) return leafCut(n);
    // a mapped net offers its own cuts and itself as a leaf
    return [...cuts.get(n)!, { leaves: [n], depth: arrival[n], flow: flow[n] }];
  };
  const measure = (lv: number[]): Cut => {
    let d = 0, f = 1;
    for (const l of lv) { d = Math.max(d, arrival[l]); f += flow[l]; }
    return { leaves: lv, depth: d + 1, flow: f };
  };
  const better = (a: Cut, b: Cut) => a.depth - b.depth || a.flow - b.flow || a.leaves.length - b.leaves.length;
  for (const n of order) {
    const [[a], [b]] = leaves[gateOf[n]].inputs;
    const seen = new Set<string>(), out: Cut[] = [];
    for (const ca of cutsOf(a)) for (const cb of cutsOf(b)) {
      const u = [...new Set([...ca.leaves, ...cb.leaves])].sort((x, y) => x - y);
      if (u.length > k) continue;
      const key = u.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(measure(u));
    }
    out.sort(better);
    // a cut that contains another is never better
    const kept: Cut[] = [];
    for (const c of out) {
      if (kept.length >= keep) break;
      if (kept.some((q) => q.leaves.every((l) => c.leaves.includes(l)) && q.depth <= c.depth && q.flow <= c.flow)) continue;
      kept.push(c);
    }
    cuts.set(n, kept);
    arrival[n] = kept[0].depth;
    flow[n] = kept[0].flow / Math.max(1, fanout[n]);
  }

  // area recovery: from the sinks back, the cut of least area flow that meets the required level
  let depth = 0;
  for (const s of sinkSet) if (mapped(s)) depth = Math.max(depth, arrival[s]);
  const required = new Float64Array(N).fill(Infinity);
  for (const s of sinkSet) if (mapped(s)) required[s] = depth;
  const chosen = new Map<number, Cut>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (required[n] === Infinity) continue;
    const ok = cuts.get(n)!.filter((c) => c.depth <= required[n]);
    const c = ok.reduce((x, y) => (y.flow < x.flow || (y.flow === x.flow && y.depth < x.depth) ? y : x));
    chosen.set(n, c);
    for (const l of c.leaves) if (mapped(l)) required[l] = Math.min(required[l], required[n] - 1);
  }

  // the LUTs, in topological order, with their tables and cones
  const level = new Map<number, number>();
  const luts: Lut[] = [];
  const covered = new Set<number>();
  for (const n of order) {
    const c = chosen.get(n);
    if (!c) continue;
    const gates: number[] = [];
    const inCone = new Set<number>();
    const collect = (m: number) => {
      if (c.leaves.includes(m) || consts.has(m) || inCone.has(m)) return;
      inCone.add(m);
      const g = gateOf[m];
      gates.push(g);
      for (const [x] of leaves[g].inputs) collect(x);
    };
    collect(n);
    let table = 0n;
    for (let a = 0; a < 1 << c.leaves.length; a++) {
      const val = new Map<number, number>(c.leaves.map((l, i) => [l, (a >> i) & 1]));
      const ev = (m: number): number => {
        const v = val.get(m) ?? consts.get(m);
        if (v !== undefined) return v;
        const [[x], [y]] = leaves[gateOf[m]].inputs;
        const r = ev(x) & ev(y) ? 0 : 1;
        val.set(m, r);
        return r;
      };
      if (ev(n)) table |= 1n << BigInt(a);
    }
    for (const g of gates) covered.add(g);
    const lv = 1 + Math.max(0, ...c.leaves.map((l) => level.get(l) ?? 0));
    level.set(n, lv);
    luts.push({ out: n, ins: c.leaves, table, gates, level: lv });
  }
  return {
    k, design, luts, depth: luts.reduce((d, l) => Math.max(d, l.level), 0), sources: [...sourceSet], sinks: [...sinkSet], consts,
    loops: [...inLoop], nands: covered.size,
  };
}

/**
 * The mapped network's value on every net it computes, given its sources' values (by net). For tests and the chapter's
 * widgets: equal to the gates' settled values wherever the mapping is right.
 */
export function evalLuts(m: LutMap, sources: Map<number, number>): Map<number, number> {
  const v = new Map<number, number>(sources);
  for (const [n, c] of m.consts) v.set(n, c);
  for (const l of m.luts) {
    let a = 0;
    l.ins.forEach((n, i) => { a |= (v.get(n) ?? 0) << i; });
    v.set(l.out, Number((l.table >> BigInt(a)) & 1n));
  }
  return v;
}
