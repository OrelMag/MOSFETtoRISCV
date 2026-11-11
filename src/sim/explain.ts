// Why is a net at its value? A trace back from the net through the flat netlist, following at
// every NAND the inputs that decide it: one 0 is enough for a 1 (the others at 0 would do as
// well), a 0 needs every input at 1, an X comes from the inputs that are X. The trace ends at
// root input pins, constants, storage (a loop of gates, or a stateful behaviour) and switch-level
// leaves. whyAt then says the same at one level of the hierarchy: the gates inside a child box
// fold into one step whose causes are the box's inputs, so a CPU's trace reads in its blocks.
// Derived from the simulation alone: nothing to author. No DOM.

import type { FlatDesign, HierNode } from './flatten';
import type { Sim } from './sim';
import { B0, B1, BX, type Bit, inPorts, outPorts } from './types';

export type WhyKind = 'pin' | 'nand' | 'const' | 'behavior' | 'storage' | 'loop' | 'undriven' | 'switch' | 'more';

export interface Why {
  net: number;
  value: Bit;
  kind: WhyKind;
  /** The leaf driving the net (design.leaves index). */
  leaf?: number;
  /** The causes: all of them hold together (a NAND at 0: every input; at 1: one input at 0). */
  because: Why[];
  /** Other input nets that would decide it as well (a NAND at 1 with several inputs at 0). */
  also?: number[];
  /** A loop: how many nets back along the traced path it closes. */
  span?: number;
}

/** Most nets one trace expands: a deeper cause is cut off as `more`. */
const LIMIT = 2000;
/** A loop of at most this many gates is a latch holding its value (clusters.ts seeds storage the same way). */
const LATCH = 6;

interface Index {
  driver: Int32Array;
  pin: Uint8Array;
  /** Gates from the nearest source (a pin, a constant, a stateful behaviour), ignoring values: of several inputs that
   *  would each decide a NAND, the trace follows the nearest (a latch's enable from the clock, not its data's long way). */
  dist: Int32Array;
}
const indexes = new WeakMap<FlatDesign, Index>();

function indexOf(d: FlatDesign): Index {
  let ix = indexes.get(d);
  if (ix) return ix;
  const driver = new Int32Array(d.netCount).fill(-1);
  d.leaves.forEach((l, i) => {
    for (const p of l.outputs) for (const n of p) driver[n] = i;
    if (l.terminals && !l.outputs.length) for (const n of l.terminals) if (driver[n] < 0) driver[n] = i;
  });
  const pin = new Uint8Array(d.netCount);
  for (const p of inPorts(d.root.def)) for (const n of d.root.ports[p.name]) pin[n] = 1;
  const dist = new Int32Array(d.netCount).fill(0x3fffffff);
  const readers: number[][] = Array.from({ length: d.netCount }, () => []);
  const queue: number[] = [];
  d.leaves.forEach((l, i) => {
    for (const p of l.inputs) for (const n of p) readers[n].push(i);
    const b = l.kind === 'behavior' ? l.def.behavior! : null;
    if (b && (b.init || b.seq || !l.inputs.flat().length)) for (const p of l.outputs) for (const n of p) { dist[n] = 0; queue.push(n); }
  });
  pin.forEach((v, n) => { if (v) { dist[n] = 0; queue.push(n); } });
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q];
    for (const li of readers[n]) for (const p of d.leaves[li].outputs) for (const o of p) {
      if (dist[o] > dist[n] + 1) { dist[o] = dist[n] + 1; queue.push(o); }
    }
  }
  indexes.set(d, (ix = { driver, pin, dist }));
  return ix;
}

/** The cause tree of a net's present value on `sim` (shared subtrees: a DAG). */
export function whyNet(sim: Sim, net: number, limit = LIMIT): Why {
  const d = sim.design;
  const { driver, pin, dist } = indexOf(d);
  const done = new Map<number, Why>();
  /** Nets on the path being traced, with their depth on it. */
  const onPath = new Map<number, number>();
  let budget = limit;

  const visit = (n: number): Why => {
    const hit = done.get(n);
    if (hit) return hit;
    const value = sim.get(n);
    const at = onPath.get(n);
    if (at !== undefined) return { net: n, value, kind: 'loop', leaf: driver[n] >= 0 ? driver[n] : undefined, because: [], span: onPath.size - at };
    if (pin[n]) return remember(n, { net: n, value, kind: 'pin', because: [] });
    const li = driver[n];
    if (li < 0) return remember(n, { net: n, value, kind: 'undriven', because: [] });
    const leaf = d.leaves[li];
    if (budget-- <= 0) return { net: n, value, kind: 'more', leaf: li, because: [] };
    if (leaf.kind !== 'nand' && leaf.kind !== 'behavior') return remember(n, { net: n, value, kind: 'switch', leaf: li, because: [] });
    const ins = leaf.inputs.flat();
    if (leaf.kind === 'behavior') {
      const b = leaf.def.behavior!;
      if (b.init || b.seq) return remember(n, { net: n, value, kind: 'storage', leaf: li, because: [] });
      if (!ins.length) return remember(n, { net: n, value, kind: 'const', leaf: li, because: [] });
    }
    let pick: number[];
    let also: number[] | undefined;
    const zeros = leaf.kind === 'nand' && value === B1 ? ins.filter((x) => sim.get(x) === B0) : [];
    if (leaf.kind === 'behavior') pick = ins;
    else if (value === B1) {
      // any one 0 decides a NAND: follow the nearest to a source, name the others
      const best = zeros.reduce((a, z) => (dist[z] < dist[a] ? z : a), zeros[0]);
      pick = [best];
      if (zeros.length > 1) also = zeros.filter((z) => z !== best);
    }
    else if (value === B0) pick = ins;
    else pick = ins.filter((x) => sim.get(x) !== B1);
    onPath.set(n, onPath.size);
    let because = pick.map(visit);
    onPath.delete(n);
    // A short loop among the causes is a latch: the gates hold the value between them. A long one ran through a
    // transparent latch back to where it started, which explains nothing: it is dropped.
    if (because.some((c) => c.kind === 'loop' && c.span! <= LATCH)) return remember(n, { net: n, value, kind: 'storage', leaf: li, because: [] });
    because = because.filter((c) => c.kind !== 'loop');
    return remember(n, { net: n, value, kind: leaf.kind === 'behavior' ? 'behavior' : 'nand', leaf: li, because, also });
  };
  const remember = (n: number, w: Why) => (done.set(n, w), w);
  return visit(net);
}


// ---- One level of the hierarchy ----

export type StepKind = 'pin' | 'port' | 'nand' | 'box' | 'const' | 'storage' | 'undriven' | 'switch' | 'more';

/** A cause as one instance of a drill level shows it: an output port of a child, or an input of the level. */
export interface WhyStep {
  /** The child instance (null: an input of the level itself, a root pin at the top). */
  inst: string | null;
  port: string;
  width: number;
  /** Flat nets of the whole port, LSB first. */
  allNets: number[];
  /** Bits of the port this step explains (indices into allNets). */
  bits: number[];
  kind: StepKind;
  /** The steps it rests on, and per step the bits of it used. */
  because: WhyStep[];
  uses: Map<WhyStep, number[]>;
  /** Flat leaves folded into this step: the gates to light. */
  leaves: number[];
  /** The child has one 1-bit output: its name alone says which (g9, not g9.y). */
  sole?: boolean;
  /** Some of the box's own storage is among the causes (a register file read: the index from outside, the word held). */
  stored?: boolean;
}

/** The child of `level` a hierarchy node sits in (itself when it is one), or null outside. */
function childOf(node: HierNode, level: HierNode): HierNode | null {
  for (let n: HierNode | null = node; n; n = n.parent) if (n.parent === level) return n;
  return null;
}

function portOf(node: HierNode, net: number, dir: 'in' | 'out'): { port: string; bit: number; width: number } | null {
  for (const p of dir === 'in' ? inPorts(node.def) : outPorts(node.def)) {
    const bit = node.ports[p.name].indexOf(net);
    if (bit >= 0) return { port: p.name, bit, width: p.width };
  }
  return null;
}

const addBit = (bits: number[], b: number) => { if (!bits.includes(b)) bits.push(b); };

/**
 * Fold cause trees (the bits of one wire) into steps at `level` (default: the root): one step per child output
 * port and per input of the level, the gates inside a child folded into it. Returns the step of each tree.
 */
export function foldAt(sim: Sim, whys: readonly Why[], level: HierNode = sim.design.root): WhyStep[] {
  const d = sim.design;
  const steps = new Map<string, WhyStep>();
  const kindOf = (w: Why): StepKind => (w.kind === 'loop' ? 'storage' : w.kind === 'behavior' ? 'box' : w.kind);

  /** The step a cause belongs to and its bit there. */
  const stepOf = (w: Why): [WhyStep, number] => {
    const leafNode = w.leaf !== undefined ? d.leaves[w.leaf].node : null;
    const child = leafNode && w.kind !== 'pin' ? childOf(leafNode, level) : null;
    if (!child) {
      // Outside this level: it enters through one of the level's inputs (a root pin at the top).
      const p = portOf(level, w.net, 'in');
      const key = `^${p?.port ?? w.net}`;
      let s = steps.get(key);
      if (!s) {
        s = {
          inst: null, port: p?.port ?? `net ${w.net}`, width: p?.width ?? 1, allNets: p ? level.ports[p.port] : [w.net], bits: [],
          kind: w.kind === 'undriven' ? 'undriven' : level === d.root ? 'pin' : 'port', because: [], uses: new Map(), leaves: [],
        };
        steps.set(key, s);
      }
      const bit = p?.bit ?? 0;
      addBit(s.bits, bit);
      return [s, bit];
    }
    const p = portOf(child, w.net, 'out') ?? { port: `net ${w.net}`, bit: 0, width: 1 };
    const key = `${child.name}.${p.port}`;
    let s = steps.get(key);
    if (!s) {
      const outs = outPorts(child.def);
      s = {
        inst: child.name, port: p.port, width: p.width, allNets: child.ports[p.port] ?? [w.net], bits: [],
        kind: child.leafIndex !== undefined ? kindOf(w) : 'box', because: [], uses: new Map(), leaves: [],
        sole: outs.length === 1 && outs[0].width === 1,
      };
      steps.set(key, s);
    }
    if (s.bits.includes(p.bit)) return [s, p.bit];
    const fresh = !s.bits.length;
    s.bits.push(p.bit);
    // Fold the gates inside the child; what reaches it from outside becomes its causes.
    const seen = new Set<Why>();
    const frontier: Why[] = [];
    let inner: WhyKind | null = null;
    const walk = (c: Why) => {
      if (seen.has(c)) return;
      seen.add(c);
      const n = c.leaf !== undefined ? d.leaves[c.leaf].node : null;
      if (n && c.kind !== 'pin' && childOf(n, level) === child) {
        if (c.leaf !== undefined && !s!.leaves.includes(c.leaf)) s!.leaves.push(c.leaf);
        const k = c.kind === 'loop' ? 'storage' : c.kind;
        if (k === 'storage' || k === 'switch' || k === 'more' || k === 'const') inner ??= k;
        if (k === 'storage') s!.stored = true;
        c.because.forEach(walk);
      } else frontier.push(c);
    };
    walk(w);
    // A box whose bits rest on nothing from outside is what it holds (storage) or a constant.
    if (s.kind === 'box' && fresh && !frontier.length && inner) s.kind = inner;
    for (const f of frontier) {
      const [b, bit] = stepOf(f);
      if (b === s) continue;
      if (!s.because.includes(b)) { s.because.push(b); s.uses.set(b, []); }
      addBit(s.uses.get(b)!, bit);
    }
    return [s, p.bit];
  };
  const tops: WhyStep[] = [];
  for (const w of whys) {
    const [s] = stepOf(w);
    if (!tops.includes(s)) tops.push(s);
  }
  return tops;
}

/** One cause tree folded at `level`: its step. */
export function whyAt(sim: Sim, why: Why, level: HierNode = sim.design.root): WhyStep {
  return foldAt(sim, [why], level)[0];
}

/** The steps of a folded trace, the explained ones first, then each cause after the steps resting on it (breadth first). */
export function stepList(tops: WhyStep | readonly WhyStep[]): WhyStep[] {
  const out: WhyStep[] = Array.isArray(tops) ? [...tops] : [tops as WhyStep];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) for (const b of out[i].because) if (!seen.has(b)) { seen.add(b); out.push(b); }
  return out;
}

// ---- Words ----

const bitText = (b: Bit) => (b === B0 ? '0' : b === B1 ? '1' : b === BX ? 'X' : 'Z');

/** A port's value as text: one bit as 0 / 1 / X, a bus as an unsigned number (X when any bit is). */
export function portValue(sim: Sim, nets: readonly number[]): string {
  const bits = sim.getBits(nets);
  if (bits.length === 1) return bitText(bits[0]);
  if (bits.some((b) => b !== B0 && b !== B1)) return 'X';
  let v = 0n;
  for (let i = bits.length - 1; i >= 0; i--) v = (v << 1n) | BigInt(bits[i]);
  return v.toString();
}

/** "[3]", "[7:4]", "[0,2,5]": some bits of a bus ('' for all of them, or a 1-bit port). */
function bitRange(bits: readonly number[], width: number): string {
  if (width === 1 || !bits.length || bits.length === width) return '';
  const b = [...bits].sort((x, y) => x - y);
  if (b.length === 1) return `[${b[0]}]`;
  if (b[b.length - 1] - b[0] === b.length - 1) return `[${b[b.length - 1]}:${b[0]}]`;
  if (b.length <= 3) return `[${b.join(',')}]`;
  return ` (${b.length} of its ${width} bits)`;
}

/** Some bits of a step: their name ("g9", "fa2.cout", "a[3]", "alu.y[7:4]") and value. */
function partOf(sim: Sim, s: WhyStep, bits: readonly number[]): { name: string; value: string } {
  const base = s.inst ? (s.sole ? s.inst : `${s.inst}.${s.port}`) : s.port;
  const sorted = [...bits].sort((x, y) => x - y);
  const scattered = sorted.length > 3 && sorted[sorted.length - 1] - sorted[0] !== sorted.length - 1;
  const value = bits.length === s.width ? portValue(sim, s.allNets) : scattered ? sameValue(sim, sorted.map((b) => s.allNets[b])) : portValue(sim, sorted.map((b) => s.allNets[b]));
  return { name: base + bitRange(bits, s.width), value };
}

/** Scattered bits have no number of their own: "all 0", "all 1", or how many are 1. */
function sameValue(sim: Sim, nets: readonly number[]): string {
  const bits = sim.getBits(nets);
  if (bits.some((b) => b !== B0 && b !== B1)) return 'X';
  const ones = bits.filter((b) => b === B1).length;
  return ones === 0 ? 'all 0' : ones === bits.length ? 'all 1' : `${ones} at 1`;
}

/** The name a step's subject goes by; an input of the level is named whole (its value is the number on the pin). */
export function stepName(s: WhyStep): string {
  const base = s.inst ? (s.sole ? s.inst : `${s.inst}.${s.port}`) : s.port;
  return s.inst ? base + bitRange(s.bits, s.width) : base;
}

/** One sentence per step: what it is and why, in the level's own names. */
export function sayStep(sim: Sim, s: WhyStep): string {
  const self = s.inst ? partOf(sim, s, s.bits) : { name: s.port, value: portValue(sim, s.allNets) };
  const { name, value: v } = self;
  const causes = s.because.map((b) => {
    const c = partOf(sim, b, s.uses.get(b) ?? b.bits);
    return `${c.name} = ${c.value}`;
  });
  switch (s.kind) {
    case 'pin': return `${name} = ${v} is an input pin.`;
    case 'port': return `${name} = ${v} comes in from the level above.`;
    case 'const': return `${name} is the constant ${v}.`;
    case 'storage': return `${name} = ${v} is stored: it holds the value it took at the last clock edge or write.`;
    case 'undriven': return `${name} is driven by nothing, so it reads ${v}.`;
    case 'switch': return `${name} = ${v} is decided by the transistor network inside.`;
    case 'more': return `${name} = ${v}: the trace stops here (open the part to follow it).`;
    case 'nand': {
      if (v === '1') return `${name} = 1 because ${causes[0] ?? 'an input'}: one 0 into a NAND is enough.`;
      if (v === '0') return `${name} = 0 because ${causes.join(' and ')}: a NAND gives 0 only when every input is 1.`;
      return `${name} = X because ${causes.join(' and ') || 'an input'} is unknown.`;
    }
    default: {
      if (!causes.length) return `${name} = ${v}${s.stored ? ' from what it stores' : ''}.`;
      return `${name} = ${v} from ${causes.join(', ')}${s.stored ? ' and what it stores' : ''}.`;
    }
  }
}

/** The explanation of a wire (all its bits) at a level: the steps and a sentence for each. */
export function explainNets(sim: Sim, nets: readonly number[], level: HierNode = sim.design.root): { steps: WhyStep[]; lines: string[] } {
  const steps = stepList(foldAt(sim, nets.map((n) => whyNet(sim, n)), level));
  return { steps, lines: steps.map((s) => sayStep(sim, s)) };
}

export const explainNet = (sim: Sim, net: number, level?: HierNode) => explainNets(sim, [net], level);

// ---- Across the rim of an opened box (the zoom lens, docs/transparent/DESIGN.md item 5) ----

/** A level a trace is folded at: its simulation and its hierarchy node. */
export interface TraceLevel { sim: Sim; node: HierNode }

/** Where a trace reaches the rim of an opened box, and what it is on the other side. */
export interface Crossing {
  /** The step on the explained side that reaches the rim (an input of the inner level, or the box's output). */
  from: WhyStep;
  /** The box's port it crosses, and its bits used. */
  port: string;
  bits: number[];
  /** The trace on the other side, folded at that level, as a click on that wire there would explain it. */
  steps: WhyStep[];
  lines: string[];
}

/**
 * A trace that reaches the rim continues on the other level. `inner`: the box's own level (the same simulation as
 * `outer`, or a sub-simulation of the box); `box`: its instance at `outer`. From the inside, each input of the level the
 * steps rest on is explained on the outer level, on the nets that feed that port; from the outside, each step that is
 * one of the box's outputs is explained inside, on the port's nets there. One crossing: what is found across the rim
 * is not followed back again.
 */
export function acrossRim(steps: readonly WhyStep[], explained: 'inner' | 'outer', inner: TraceLevel, outer: TraceLevel, box: string): Crossing[] {
  const node = outer.node.children?.get(box);
  if (!node) return [];
  const out: Crossing[] = [];
  for (const s of steps) {
    const ins = explained === 'inner' && s.inst === null;
    const outs = explained === 'outer' && s.inst === box;
    const p = node.def.ports.find((q) => q.name === s.port);
    if (!(ins || outs) || !p || p.dir !== (ins ? 'in' : 'out') || !s.bits.length) continue;
    const there = ins ? { lv: outer, nets: node.ports[p.name] } : { lv: inner, nets: inner.node.ports[p.name] };
    if (!there.nets) continue;
    const bits = [...s.bits].sort((a, b) => a - b);
    const { steps: st, lines } = explainNets(there.lv.sim, bits.map((b) => there.nets[b]), there.lv.node);
    out.push({ from: s, port: p.name, bits, steps: st, lines });
  }
  return out;
}
