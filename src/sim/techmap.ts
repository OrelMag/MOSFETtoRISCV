// Technology mapping, the first step of logic synthesis, in its simplest form: our designs use
// one cell (NAND2, 4 transistors). A real library has an inverter (2 transistors). Map every NAND
// whose inputs are tied together to an inverter, then delete pairs of inverters in series.

import type { ComponentDef } from './types';
import { flatten } from './flatten';

export interface MapResult {
  nands: number;
  inverters: number;
  /** Inverter pairs removed (x → INV → INV → y becomes a wire). */
  pairsRemoved: number;
  nandTransistors: number;
  mappedTransistors: number;
  /** Behavioural leaves (ROMs) are not counted. */
  behavioural: number;
}

export function techMap(def: ComponentDef): MapResult {
  const d = flatten(def);
  const nand = d.leaves.filter((l) => l.kind === 'nand');
  const fanout = new Map<number, number>();
  for (const l of d.leaves) for (const ins of l.inputs) for (const n of ins) fanout.set(n, (fanout.get(n) ?? 0) + 1);
  for (const p of def.ports) if (p.dir === 'out') for (const n of d.root.ports[p.name]) fanout.set(n, (fanout.get(n) ?? 0) + 1);
  const isInv = nand.map((l) => l.inputs[0][0] === l.inputs[1][0]);
  const invByOut = new Map<number, number>();
  nand.forEach((l, i) => { if (isInv[i]) invByOut.set(l.outputs[0][0], i); });
  const used = new Set<number>();
  let pairs = 0;
  nand.forEach((l, i) => {
    if (!isInv[i] || used.has(i)) return;
    const j = invByOut.get(l.inputs[0][0]);
    // the first inverter's output may feed only this inverter (counting both of its tied inputs)
    if (j === undefined || used.has(j) || j === i) return;
    if ((fanout.get(l.inputs[0][0]) ?? 0) !== 2) return;
    used.add(i); used.add(j);
    pairs++;
  });
  const inverters = isInv.filter(Boolean).length;
  return {
    nands: nand.length,
    inverters,
    pairsRemoved: pairs,
    nandTransistors: nand.length * 4,
    mappedTransistors: (nand.length - inverters) * 4 + (inverters - 2 * pairs) * 2,
    behavioural: d.leaves.filter((l) => l.kind === 'behavior').length,
  };
}
