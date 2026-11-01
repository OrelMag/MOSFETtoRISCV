// Why is a net at its value? A trace back from the net through the flat netlist, following at
// every NAND the inputs that decide it: one 0 is enough for a 1 (the others at 0 would do as
// well), a 0 needs every input at 1, an X comes from the inputs that are X. The trace ends at
// root input pins, constants, storage (a loop of gates, or a stateful behaviour) and switch-level
// leaves. whyAt then says the same at one level of the hierarchy: the gates inside a child box
// fold into one step whose causes are the box's inputs, so a CPU's trace reads in its blocks.
// Derived from the simulation alone: nothing to author. No DOM.

import type { FlatDesign, HierNode } from './flatten';
import type { Sim } from './sim';
import { B0, B1, BX, type Bit, inPorts, netlistOf, outPorts } from './types';

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
}

/** Most nets one trace expands: a deeper cause is cut off as `more`. */
const LIMIT = 600;

interface Index { driver: Int32Array; pin: Uint8Array }
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
  indexes.set(d, (ix = { driver, pin }));
  return ix;
}

/** The cause tree of a net's present value on `sim` (shared subtrees: a DAG). */
export function whyNet(sim: Sim, net: number, limit = LIMIT): Why {
  const d = sim.design;
  const { driver, pin } = indexOf(d);
  const done = new Map<number, Why>();
  const onPath = new Set<number>();
  let budget = limit;

  const visit = (n: number): Why => {
    const hit = done.get(n);
    if (hit) return hit;
    const value = sim.get(n);
    if (onPath.has(n)) return { net: n, value, kind: 'loop', because: [] };
    if (pin[n]) return remember(n, { net: n, value, kind: 'pin', because: [] });
    const li = driver[n];
    if (li < 0) return remember(n, { net: n, value, kind: 'undriven', because: [] });
    const leaf = d.leaves[li];
    if (budget-- <= 0) return { net: n, value, kind: 'more', leaf: li, because: [] };
    if (leaf.kind !== 'nand' && leaf.kind !== 'behavior') return remember(n, { net: n, value, kind: 'switch', leaf: li, because: [] });
    if (leaf.kind === 'behavior') {
      const b = leaf.def.behavior!;
      const ins = leaf.inputs.flat();
      if (b.init || b.seq) return remember(n, { net: n, value, kind: 'storage', leaf: li, because: [] });
      if (!ins.length) return remember(n, { net: n, value, kind: 'const', leaf: li, because: [] });
      onPath.add(n);
      const w: Why = { net: n, value, kind: 'behavior', leaf: li, because: ins.map(visit) };
      onPath.delete(n);
      return remember(n, w);
    }
    const ins = leaf.inputs.flat();
    let pick: number[];
    let also: number[] | undefined;
    if (value === B1) {
      const zeros = ins.filter((x) => sim.get(x) === B0);
      pick = zeros.slice(0, 1);
      if (zeros.length > 1) also = zeros.slice(1);
    } else if (value === B0) pick = ins;
    else pick = ins.filter((x) => sim.get(x) !== B1);
    onPath.add(n);
    const because = pick.map(visit);
    onPath.delete(n);
    // A loop among the causes is storage: the gates hold the value between them.
    const kind: WhyKind = because.some((c) => c.kind === 'loop') ? 'storage' : 'nand';
    return remember(n, { net: n, value, kind, leaf: li, because: kind === 'storage' ? [] : because, also });
  };
  const remember = (n: number, w: Why) => (done.set(n, w), w);
  return visit(net);
}

// ---- One level of the hierarchy ----

export type StepKind = 'pin' | 'port' | 'nand' | 'box' | 'const' | 'storage' | 'undriven' | 'switch' | 'more';

/** A cause as one instance of a drill level shows it: a port of a child (some of its bits) or of the level. */
export interface WhyStep {
  /** The child instance (null: a port of the level itself, or a root pin). */
  inst: string | null;
  port: string;
  /** Bits of the port this step explains (LSB index into the port). */
  bits: number[];
  width: number;
  kind: StepKind;
  because: WhyStep[];
  /** Flat leaves folded into this step: the gates to light. */
  leaves: number[];
  /** Flat nets of the bits explained. */
  nets: number[];
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

/** Fold a cause tree into steps at `level` (default: the root): one per child port, the gates inside folded. */
export function whyAt(sim: Sim, why: Why, level: HierNode = sim.design.root): WhyStep {
  const d = sim.design;
  const steps = new Map<string, WhyStep>();

  const stepOf = (w: Why): WhyStep => {
    const leafNode = w.leaf !== undefined ? d.leaves[w.leaf].node : null;
    const child = leafNode ? childOf(leafNode, level) : null;
    if (!child) {
      // Outside this level: it enters through one of the level's inputs (a root pin at the top).
      const p = portOf(level, w.net, 'in');
      const key = `^${p?.port ?? w.net}`;
      let s = steps.get(key);
      if (!s) {
        s = {
          inst: null, port: p?.port ?? `net ${w.net}`, bits: [], width: p?.width ?? 1, nets: [], leaves: [], because: [],
          kind: w.kind === 'undriven' ? 'undriven' : level === d.root ? 'pin' : 'port',
        };
        steps.set(key, s);
      }
      if (p && !s.bits.includes(p.bit)) { s.bits.push(p.bit); s.nets.push(w.net); }
      return s;
    }
    const p = portOf(child, w.net, 'out') ?? { port: `net ${w.net}`, bit: 0, width: 1 };
    const key = `${child.name}.${p.port}`;
    let s = steps.get(key);
    const fresh = !s;
    if (!s) {
      const leafChild = child.leafIndex !== undefined;
      s = { inst: child.name, port: p.port, bits: [], width: p.width, nets: [], leaves: [], because: [], kind: leafChild ? kindOf(w) : 'box' };
      steps.set(key, s);
    }
    if (s.bits.includes(p.bit)) return s;
    s.bits.push(p.bit);
    s.nets.push(w.net);
    // Fold the gates inside the child; what reaches it from outside becomes its causes.
    const seen = new Set<Why>();
    const frontier: Why[] = [];
    let inner: WhyKind | null = null;
    const walk = (c: Why) => {
      if (seen.has(c)) return;
      seen.add(c);
      const n = c.leaf !== undefined ? d.leaves[c.leaf].node : null;
      if (n && childOf(n, level) === child && c.kind !== 'pin') {
        if (c.leaf !== undefined && !s!.leaves.includes(c.leaf)) s!.leaves.push(c.leaf);
        if (c.kind === 'storage' || c.kind === 'switch' || c.kind === 'more' || c.kind === 'const') inner ??= c.kind;
        if (c.kind === 'storage') s!.stored = true;
        c.because.forEach(walk);
      } else frontier.push(c);
    };
    walk(w);
    // A box whose bits rest on nothing from outside is what it holds (storage) or a constant.
    if (s.kind === 'box' && fresh && !frontier.length && inner) s.kind = inner === 'const' ? 'const' : inner;
    for (const f of frontier) {
      const b = stepOf(f);
      if (!s.because.includes(b)) s.because.push(b);
    }
    return s;
  };
  const kindOf = (w: Why): StepKind => (w.kind === 'loop' ? 'storage' : w.kind === 'behavior' ? 'box' : w.kind === 'pin' ? 'pin' : w.kind);
  return stepOf(why);
}

/** The steps of a folded trace, the explained one first, each after the ones that rest on it (breadth first). */
export function stepList(top: WhyStep): WhyStep[] {
  const out: WhyStep[] = [top];
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

/** The name a step's subject goes by: "g9.y", "fa2.cout", "a", "sum[3]". */
export function stepName(s: WhyStep): string {
  const base = s.inst ? `${s.inst}.${s.port}` : s.port;
  if (s.width === 1) return base;
  if (s.bits.length === 1) return `${base}[${s.bits[0]}]`;
  return base;
}

function stepValue(sim: Sim, s: WhyStep): string {
  const sorted = s.nets.map((n, i) => [s.bits[i], n] as const).sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  return portValue(sim, sorted);
}

/**
 * One sentence per step: what it is and why, in the level's own names. `level` must be the level whyAt
 * folded at (the NAND sentence reads the child's inputs).
 */
export function sayStep(sim: Sim, s: WhyStep, level: HierNode = sim.design.root): string {
  const v = stepValue(sim, s);
  const name = stepName(s);
  const causes = s.because.map((b) => `${stepName(b)} = ${stepValue(sim, b)}`);
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
      void level;
      const held = s.stored ? ' and what it stores' : '';
      if (!causes.length) return `${name} = ${v}${held ? ' from what it stores' : ''}.`;
      return `${name} = ${v} from ${causes.join(', ')}${held}.`;
    }
  }
}

/** The whole explanation at a level: the steps and a sentence for each. */
export function explainNet(sim: Sim, net: number, level: HierNode = sim.design.root): { steps: WhyStep[]; lines: string[] } {
  const steps = stepList(whyAt(sim, whyNet(sim, net), level));
  return { steps, lines: steps.map((s) => sayStep(sim, s, level)) };
}

/** The net names of a level's netlist, by flat net (for a caller that wants the drawn wire's name). */
export function levelNetNames(level: HierNode): Map<number, string> {
  const out = new Map<number, string>();
  if (!level.nets) return out;
  const nl = netlistOf(level.def);
  nl?.nets.forEach((nd, i) => { if (nd.name) for (const n of level.nets![i] ?? []) out.set(n, nd.name); });
  return out;
}
