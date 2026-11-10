// Placement by logic depth, shared by the Verilog import (hdl/yosysjson.ts: a netlist with no drawing) and the re-layout of
// an imported chip (editor/relayout.ts: a .dig / .circ drawing replaced). Parts go left to right by logic depth (feedback
// through storage cut), each column ordered by where its drivers sit; short forward nets become wires with a trunk each in
// the gap after their column, the rest pointers named after the net. docFromDef then routes it.

import type { PartRef } from './model';
import { uniqueName } from './model';
import { symbolGeom, type Vec } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';

/** One part being placed: its def, how the document refers to it, its column. */
export interface Inst {
  name: string;
  def: ComponentDef;
  ref: PartRef;
  label?: string;
  /** Fixed column: 'in' (input splitters), 'out' (output mergers), else placed by depth. */
  fixed?: 'in' | 'out';
  col: number;
  y: number;
}

/** A net in the making: a driver end and its sinks ('inst.port' or a pin name). */
export interface NetB { drv?: string; sinks: string[]; name?: string; bus?: boolean }

// ---------------------------------------------------------------------------------------------------------
// Placement: columns by logic depth, rows by where the drivers sit.

const VGAP = 2;

/**
 * sweeps: rounds of crossing reduction (each a pass right to left then left to right ordering a column by the mean rank of
 * its neighbours in the column it is swept from, Sugiyama's barycentre step) before the rows are set; 0 (the Verilog
 * import's) keeps each column in the order of its drivers' rows.
 */
export function placeByDepth(insts: Inst[], byName: Map<string, Inst>, list: NetB[], ports: PortDef[], opts: { sweeps?: number } = {}): import('../sim/types').Netlist {
  const instOf = (end: string) => (end.includes('.') ? byName.get(end.slice(0, end.indexOf('.'))) : undefined);
  // Graph between parts.
  const succ = new Map<Inst, Set<Inst>>(), pred = new Map<Inst, Set<Inst>>();
  for (const i of insts) { succ.set(i, new Set()); pred.set(i, new Set()); }
  for (const n of list) {
    const a = instOf(n.drv!);
    if (!a) continue;
    for (const s of n.sinks) {
      const b = instOf(s);
      if (b && b !== a) { succ.get(a)!.add(b); pred.get(b)!.add(a); }
    }
  }
  // Cut feedback: depth-first from the parts nothing drives (and storage first, so loops break at a flip-flop's input).
  const back = new Set<string>();
  const st = new Map<Inst, 1 | 2>();
  const roots = [...insts].sort((x, y) => pred.get(x)!.size - pred.get(y)!.size || +isStore(y) - +isStore(x));
  for (const r of roots) {
    if (st.has(r)) continue;
    const stack: [Inst, Inst[]][] = [[r, [...succ.get(r)!]]];
    st.set(r, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nx = top[1].pop();
      if (!nx) { st.set(top[0], 2); stack.pop(); continue; }
      const s = st.get(nx);
      if (s === 1) back.add(`${top[0].name}>${nx.name}`);
      else if (!s) { st.set(nx, 1); stack.push([nx, [...succ.get(nx)!]]); }
    }
  }
  // Longest path, in topological order of the cut graph.
  const indeg = new Map<Inst, number>();
  for (const i of insts) indeg.set(i, [...pred.get(i)!].filter((p) => !back.has(`${p.name}>${i.name}`)).length);
  const queue = insts.filter((i) => indeg.get(i) === 0);
  const depth = new Map<Inst, number>();
  for (const i of insts) depth.set(i, 1);
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    for (const s of succ.get(i)!) {
      if (back.has(`${i.name}>${s.name}`)) continue;
      // Input splitters and constants (nothing drives them) add no depth: their readers can sit in the first column.
      if (i.fixed !== 'in' && pred.get(i)!.size) depth.set(s, Math.max(depth.get(s)!, depth.get(i)! + (s.fixed === 'out' ? 0 : 1)));
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  // Parts with no inputs (constants) sit just before their first reader.
  for (const i of insts) {
    if (pred.get(i)!.size || i.fixed) continue;
    const ss = [...succ.get(i)!].filter((s) => !s.fixed);
    if (ss.length) depth.set(i, Math.max(1, Math.min(...ss.map((s) => depth.get(s)!)) - 1));
  }
  const maxD = Math.max(1, ...insts.filter((i) => !i.fixed).map((i) => depth.get(i)!));
  // Columns: -1 input pins, 0 input splitters, 1..maxD parts, maxD+1 output mergers, maxD+2 output pins.
  for (const i of insts) i.col = i.fixed === 'in' ? 0 : i.fixed === 'out' ? maxD + 1 : depth.get(i)!;
  // Columns that hold something, in order: rank 0 the input pins, the last the output pins.
  const present = [...new Set([-1, ...insts.map((i) => i.col), maxD + 2])].sort((a, b) => a - b);
  for (const i of insts) i.col = present.indexOf(i.col);
  const ncol = present.length;
  const colOf = (end: string) => instOf(end)?.col ?? (ports.find((p) => p.name === end)!.dir === 'in' ? 0 : ncol - 1);

  const geomOf = (i: Inst) => symbolGeom(i.def);
  const portOf = (end: string) => geomOf(instOf(end)!).ports[end.slice(end.indexOf('.') + 1)];
  const exitOf = (end: string) => (instOf(end) ? portOf(end).exit : ports.find((p) => p.name === end)!.dir === 'in' ? 'right' : 'left');

  // Which nets may be wires: forward into the next column only, a few sinks, leaving to the right and entering
  // from the left (a select or clock pin on a part's edge is reached by a pointer). The rest are pointers.
  const wired = list.map((n) => {
    const c = colOf(n.drv!);
    return n.sinks.length <= 4 && exitOf(n.drv!) === 'right' && n.sinks.every((s) => colOf(s) === c + 1 && exitOf(s) === 'left');
  });

  // Rows. Input pins and their splitters stacked in port order.
  const pins: Record<string, Vec> = {};
  const placed = new Set<Inst>();
  const endY = (end: string): number | undefined => {
    const i = instOf(end);
    if (!i) return pins[end]?.[1];
    return placed.has(i) ? i.y + portOf(end).pos[1] : undefined;
  };
  let cur = 2;
  for (const p of ports.filter((q) => q.dir === 'in')) {
    const sp = insts.find((i) => i.fixed === 'in' && list.some((n) => n.drv === p.name && n.sinks.includes(`${i.name}.in`)));
    if (sp) {
      const g = geomOf(sp);
      sp.y = cur;
      placed.add(sp);
      pins[p.name] = [0, cur + g.ports.in.pos[1]];
      cur += g.h + VGAP + 1;
    } else {
      pins[p.name] = [0, cur + 1];
      cur += 3;
    }
  }
  const rank = opts.sweeps ? sweepOrder(insts, list, ports, instOf, ncol, opts.sweeps) : undefined;
  // Each column of parts: rows where their inputs come from, kept apart.
  const ins = new Map<Inst, NetB[]>();
  list.forEach((n) => n.sinks.forEach((s) => { const i = instOf(s); if (i) { if (!ins.has(i)) ins.set(i, []); ins.get(i)!.push(n); } }));
  for (let c = 1; c < ncol - 1; c++) {
    const col = insts.filter((i) => i.col === c && !placed.has(i));
    const want = new Map<Inst, number>();
    for (const i of col) {
      const ys: number[] = [];
      for (const n of ins.get(i) ?? []) {
        const y = endY(n.drv!);
        if (y === undefined) continue;
        for (const s of n.sinks) if (instOf(s) === i) ys.push(y - portOf(s).pos[1]);
      }
      want.set(i, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity);
    }
    col.sort(rank ? (a, b) => rank.get(a)! - rank.get(b)! : (a, b) => (want.get(a)! - want.get(b)!) || 0);
    let bottom = 0;
    for (const i of col) {
      const w = want.get(i)!;
      i.y = snapY(i.def, Math.max(Number.isFinite(w) ? w : bottom, bottom));
      placed.add(i);
      bottom = i.y + geomOf(i).h + VGAP;
    }
  }
  // Output pins: beside what drives them, in port order.
  let ob = 2;
  for (const p of ports.filter((q) => q.dir === 'out')) {
    const n = list.find((x) => x.sinks.includes(p.name));
    const y = n ? endY(n.drv!) : undefined;
    const py = Math.max(Math.round(y ?? ob), ob);
    pins[p.name] = [0, py];
    ob = py + 3;
  }

  // Wires, routed here (the router then has nothing to untangle): in a gap every wired net gets a vertical trunk of
  // its own. Rows of output ports are distinct, and so are rows of input ports, so two wires can only meet where one's
  // driver row is another's sink row: there the first one's trunk must lie left of the second's. Kahn's order over
  // those pairs (by driver row otherwise); a net caught in a cycle (two nets swapping rows) becomes pointers.
  const Y = (end: string) => endY(end)!;
  const order = new Map<number, number[]>();
  list.forEach((n, i) => { if (wired[i]) { const c = colOf(n.drv!); if (!order.has(c)) order.set(c, []); order.get(c)!.push(i); } });
  for (const [c, idx] of order) {
    const bySink = new Map<number, number>();
    for (const i of idx) for (const s of list[i].sinks) bySink.set(Y(s), i);
    const next = new Map<number, number>(), indeg = new Map(idx.map((i) => [i, 0]));
    for (const a of idx) {
      const b = bySink.get(Y(list[a].drv!));
      if (b !== undefined && b !== a) { next.set(a, b); indeg.set(b, indeg.get(b)! + 1); }
    }
    const byRow = (a: number, b: number) => Y(list[a].drv!) - Y(list[b].drv!);
    const ready = idx.filter((i) => indeg.get(i) === 0).sort(byRow);
    const out: number[] = [];
    while (ready.length) {
      const i = ready.shift()!;
      out.push(i);
      const b = next.get(i);
      if (b !== undefined && indeg.set(b, indeg.get(b)! - 1).get(b) === 0) { ready.push(b); ready.sort(byRow); }
    }
    for (const i of idx) if (!out.includes(i)) wired[i] = false;
    order.set(c, out);
  }

  // Gap after each column: the pointers leaving it, a trunk per wire, the pointers entering the next column.
  const tagOut = new Array(ncol).fill(0), tagIn = new Array(ncol).fill(0);
  list.forEach((n, i) => {
    if (wired[i]) return;
    const w = tagW(n.name ?? 'n00');
    const c = colOf(n.drv!);
    tagOut[c] = Math.max(tagOut[c], w);
    for (const s of n.sinks) { const sc = colOf(s); tagIn[sc] = Math.max(tagIn[sc], w); }
  });
  const colW = new Array(ncol).fill(0);
  for (const i of insts) colW[i.col] = Math.max(colW[i.col], geomOf(i).w);
  const colX = new Array(ncol).fill(0), trunk0 = new Array(ncol).fill(0);
  for (let c = 1; c < ncol; c++) {
    trunk0[c - 1] = colX[c - 1] + colW[c - 1] + Math.ceil(tagOut[c - 1]) + 2;
    colX[c] = trunk0[c - 1] + (order.get(c - 1)?.length ?? 0) + 1 + Math.ceil(tagIn[c]);
  }
  for (const p of ports) pins[p.name][0] = p.dir === 'in' ? colX[0] : colX[ncol - 1];
  const via = new Map<number, number>(); // net → its trunk's x
  for (const [c, out] of order) out.forEach((i, k) => via.set(i, trunk0[c] + k));

  const instances: InstanceDef[] = insts.map((i) => ({
    name: i.name, def: i.def, at: [colX[i.col], i.y] as [number, number], ...(i.label ? { label: i.label } : {}),
  }));
  const used = new Set<string>();
  const netDefs: NetDef[] = list.map((n, i) => {
    let name = n.name;
    if (name !== undefined) { name = uniqueName(name, used); used.add(name); }
    const t = via.get(i);
    const route = wired[i] && t !== undefined
      ? { via: Object.fromEntries(n.sinks.map((s) => [s, [[t, Y(s)] as [number, number]]])) }
      : { tags: true as const };
    return { ...(name !== undefined ? { name } : {}), ends: [n.drv!, ...n.sinks], ...route };
  });
  return { instances, nets: netDefs, pins };
}

/** Each part's rank in its column after barycentre sweeps (input pins ranked in port order, output pins likewise). */
function sweepOrder(insts: Inst[], list: NetB[], ports: PortDef[], instOf: (e: string) => Inst | undefined, ncol: number, rounds: number): Map<Inst, number> {
  type Node = Inst | string;
  const nodeOf = (e: string): Node => instOf(e) ?? e;
  const colOf = (n: Node) => (typeof n === 'string' ? (ports.find((p) => p.name === n)!.dir === 'in' ? 0 : ncol - 1) : n.col);
  const nb = new Map<Node, Node[]>();
  const link = (a: Node, b: Node) => { if (a === b) return; if (!nb.has(a)) nb.set(a, []); nb.get(a)!.push(b); };
  for (const n of list) { const d = nodeOf(n.drv!); for (const s of n.sinks) { const t = nodeOf(s); link(d, t); link(t, d); } }
  const cols: Node[][] = Array.from({ length: ncol }, () => []);
  for (const p of ports) cols[p.dir === 'in' ? 0 : ncol - 1].push(p.name);
  for (const i of insts) cols[i.col].push(i);
  const pos = new Map<Node, number>();
  const setPos = (c: number) => cols[c].forEach((n, k) => pos.set(n, cols[c].length > 1 ? k / (cols[c].length - 1) : 0.5));
  cols.forEach((_, c) => setPos(c));
  // first: the import's own order (by the inputs' ranks), then sweeps from the right and from the left
  const orderBy = (c: number, from: (o: number) => boolean) => {
    const key = new Map<Node, number>();
    cols[c].forEach((n, k) => {
      const ps = (nb.get(n) ?? []).filter((m) => from(colOf(m))).map((m) => pos.get(m)!);
      key.set(n, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(n)!);
      void k;
    });
    cols[c].sort((a, b) => key.get(a)! - key.get(b)!);
    setPos(c);
  };
  for (let c = 1; c < ncol - 1; c++) orderBy(c, (o) => o < c);
  for (let r = 0; r < rounds; r++) {
    for (let c = ncol - 2; c >= 1; c--) orderBy(c, (o) => o > c);
    for (let c = 1; c < ncol - 1; c++) orderBy(c, (o) => o < c);
  }
  const out = new Map<Inst, number>();
  for (const col of cols) col.forEach((n, k) => { if (typeof n !== 'string') out.set(n, k); });
  return out;
}

const isStore = (i: Inst) => 'lib' in i.ref && /^(dff|dffe|dff_r|d_latch|d_latch_r)$/.test(i.ref.lib);

/** Room a pointer takes beside its port: the stub and the label. */
const tagW = (name: string) => 2 + name.length * 0.62 + 1;

/** A top row so the part's ports land on whole grid units (a box's pins may sit on half units). */
function snapY(def: ComponentDef, y: number): number {
  const ps = Object.values(symbolGeom(def).ports);
  const off = ps.length ? ((ps[0].pos[1] % 1) + 1) % 1 : 0;
  return Math.round(y - off) + off;
}
