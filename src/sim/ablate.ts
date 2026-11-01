// What is each part for? Every child instance of a level is removed in turn (its outputs left
// open: X), then held at 0 and at 1, and the whole truth table is run against the intact circuit:
// the rows each output gets wrong say which outputs the part serves, and a part no output needs
// shows itself. Exhaustive over combinational gate-level blocks of up to MAX_BITS input bits,
// three-valued and bit-parallel (32 rows per word: one plane for "is 1", one for "is 0").
// No DOM.

import { findNode, flatten, type FlatDesign, type HierNode } from './flatten';
import { inPorts, outPorts, type ComponentDef } from './types';

export const MAX_BITS = 12;

export type FaultMode = 'open' | 'stuck0' | 'stuck1';
export const FAULT_MODES: FaultMode[] = ['open', 'stuck0', 'stuck1'];

export interface PartRole {
  inst: string;
  /** Rows each output gets wrong (any bit differs or is X), per fault. */
  wrong: Record<FaultMode, Record<string, number>>;
  /** Outputs the part serves: wrong on some row once it is removed. */
  serves: string[];
}

export interface Ablation {
  /** Truth-table rows (2^input bits). */
  rows: number;
  outputs: string[];
  parts: PartRole[];
}

interface Plan {
  design: FlatDesign;
  /** Leaves in evaluation order. */
  order: number[];
  inNets: number[];
  outs: { name: string; nets: number[] }[];
}

/** Why a component cannot be ablated, or null. */
export function ablationRefusal(def: ComponentDef): string | null {
  const bits = inPorts(def).reduce((a, p) => a + p.width, 0);
  if (bits > MAX_BITS) return `${bits} input bits: the table would have ${2 ** bits} rows (at most ${MAX_BITS} bits)`;
  return null;
}

function planOf(def: ComponentDef): Plan | string {
  const refusal = ablationRefusal(def);
  if (refusal) return refusal;
  const design = flatten(def, { mode: 'gate' });
  const driver = new Int32Array(design.netCount).fill(-1);
  for (const [i, l] of design.leaves.entries()) {
    if (l.kind !== 'nand' && l.kind !== 'behavior') return 'it reaches transistors (switch level)';
    if (l.kind === 'behavior' && (l.def.behavior!.init || l.def.behavior!.seq)) return `${l.node.path.join('.') || l.def.name} holds state`;
    for (const p of l.outputs) for (const n of p) driver[n] = i;
  }
  // Kahn's order over the leaves; a cycle is storage, which a truth table does not describe.
  const deps = design.leaves.map((l) => new Set(l.inputs.flat().map((n) => driver[n]).filter((d) => d >= 0)));
  const users: number[][] = design.leaves.map(() => []);
  deps.forEach((ds, i) => ds.forEach((d) => users[d].push(i)));
  const left = deps.map((s) => s.size);
  const order: number[] = [];
  left.forEach((k, i) => { if (!k) order.push(i); });
  for (let q = 0; q < order.length; q++) for (const u of users[order[q]]) if (--left[u] === 0) order.push(u);
  if (order.length < design.leaves.length) return 'it has feedback (storage)';
  return {
    design, order,
    inNets: inPorts(def).flatMap((p) => design.root.ports[p.name]),
    outs: outPorts(def).map((p) => ({ name: p.name, nets: design.root.ports[p.name] })),
  };
}

/** One pass over every row: per output, a lane mask word per 32 rows of "this row's value", as planes. */
function run(plan: Plan, forced: Set<number> | null, mode: FaultMode): { one: Int32Array[]; zero: Int32Array[] } {
  const { design, order, inNets } = plan;
  const rows = 2 ** inNets.length;
  const words = Math.ceil(rows / 32);
  const one = new Int32Array(design.netCount), zero = new Int32Array(design.netCount);
  const outOne: Int32Array[] = plan.outs.map((o) => new Int32Array(words * o.nets.length));
  const outZero: Int32Array[] = plan.outs.map((o) => new Int32Array(words * o.nets.length));
  const fOne = mode === 'stuck1' ? -1 : 0, fZero = mode === 'stuck0' ? -1 : 0;
  for (let w = 0; w < words; w++) {
    one.fill(0); zero.fill(0);
    inNets.forEach((n, b) => {
      let m = 0;
      for (let l = 0; l < 32; l++) if (((w * 32 + l) >>> b) & 1) m |= 1 << l;
      one[n] = m; zero[n] = ~m;
    });
    for (const li of order) {
      const leaf = design.leaves[li];
      const outNets = leaf.outputs.flat();
      if (forced && outNets.some((n) => forced.has(n))) {
        for (const n of outNets) if (forced.has(n)) { one[n] = fOne; zero[n] = fZero; }
        continue;
      }
      if (leaf.kind === 'nand') {
        let o1 = 0, o0 = -1;
        for (const n of leaf.inputs.flat()) { o1 |= zero[n]; o0 &= one[n]; }
        one[outNets[0]] = o1; zero[outNets[0]] = o0 & ~o1;
      } else evalBehavior(leaf, one, zero);
    }
    plan.outs.forEach((o, k) => o.nets.forEach((n, b) => {
      outOne[k][b * words + w] = one[n];
      outZero[k][b * words + w] = zero[n];
    }));
  }
  return { one: outOne, zero: outZero };
}

/** A stateless behaviour (a constant, a table) row by row: X on any input bit makes every output X. */
function evalBehavior(leaf: FlatDesign['leaves'][number], one: Int32Array, zero: Int32Array): void {
  const outs = leaf.outputs;
  const o1 = outs.map((p) => p.map(() => 0)), o0 = outs.map((p) => p.map(() => 0));
  for (let l = 0; l < 32; l++) {
    let known = true;
    const ins = leaf.inputs.map((p) => p.reduce((v, n, b) => {
      const is1 = (one[n] >>> l) & 1, is0 = (zero[n] >>> l) & 1;
      if (!is1 && !is0) known = false;
      return v + (is1 ? 2 ** b : 0);
    }, 0));
    if (!known) continue;
    const res = leaf.def.behavior!.eval(ins, undefined);
    outs.forEach((p, k) => p.forEach((_, b) => {
      if (Math.floor(res[k] / 2 ** b) % 2) o1[k][b] |= 1 << l; else o0[k][b] |= 1 << l;
    }));
  }
  outs.forEach((p, k) => p.forEach((n, b) => { one[n] = o1[k][b]; zero[n] = o0[k][b]; }));
}

const cache = new WeakMap<ComponentDef, Map<string, Ablation | string>>();

/**
 * Every child of the level at `path` (default: the top) removed and stuck in turn, against the intact
 * table. Memoized per component and path. A string says why it cannot be done.
 */
export function ablate(def: ComponentDef, path: readonly string[] = []): Ablation | string {
  let byPath = cache.get(def);
  if (!byPath) cache.set(def, (byPath = new Map()));
  const key = path.join('.');
  const hit = byPath.get(key);
  if (hit) return hit;
  const res = compute(def, path);
  byPath.set(key, res);
  return res;
}

function compute(def: ComponentDef, path: readonly string[]): Ablation | string {
  const plan = planOf(def);
  if (typeof plan === 'string') return plan;
  const level: HierNode | null = findNode(plan.design.root, path);
  if (!level?.children?.size) return 'nothing inside to remove';
  const rows = 2 ** plan.inNets.length;
  const words = Math.ceil(rows / 32);
  const live = rows >= 32 ? -1 : (1 << rows) - 1;
  const good = run(plan, null, 'open');
  const parts: PartRole[] = [];
  for (const child of level.children.values()) {
    const forced = new Set(outPorts(child.def).flatMap((p) => child.ports[p.name]));
    // A splitter or merger's ports are the nets around it (aliases merge): removing one cuts nothing.
    if (child.def.prim === 'alias') continue;
    const wrong = {} as PartRole['wrong'];
    for (const mode of FAULT_MODES) {
      const bad = run(plan, forced, mode);
      wrong[mode] = {};
      plan.outs.forEach((o, k) => {
        let count = 0;
        for (let w = 0; w < words; w++) {
          let diff = 0;
          for (let b = 0; b < o.nets.length; b++) {
            const i = b * words + w;
            diff |= (good.one[k][i] & ~bad.one[k][i]) | (good.zero[k][i] & ~bad.zero[k][i]);
          }
          count += popcount(diff & (w === words - 1 ? live : -1));
        }
        wrong[mode][o.name] = count;
      });
    }
    parts.push({ inst: child.name, wrong, serves: plan.outs.map((o) => o.name).filter((n) => wrong.open[n] > 0) });
  }
  return { rows, outputs: plan.outs.map((o) => o.name), parts };
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** What a part is for, in words: "s only", "shared: s and cout", "nothing: no output needs it". */
export function roleText(p: PartRole, outputs: readonly string[]): string {
  if (!p.serves.length) return 'nothing: no output needs it';
  if (p.serves.length === 1 && outputs.length > 1) return `${p.serves[0]} only`;
  if (p.serves.length === outputs.length && outputs.length > 1) return `shared by every output`;
  if (p.serves.length === 1) return `${p.serves[0]}`;
  return `shared: ${p.serves.join(' and ')}`;
}
