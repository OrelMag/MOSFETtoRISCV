// Static timing analysis: the longest register-to-register path in NAND delays.
// Flip-flops (components marked `ff`: the library DFF, a user chip ticked as a flip-flop) are the
// timing boundaries: their outputs launch at clk-to-q, their data inputs (d, and en if any) must
// arrive a setup time before the next rising edge. Everything in between is combinational and
// is traversed backwards from every capture point. A flip-flop that contains flip-flops (the
// DFFE: a mux in front of a DFF) is not a boundary itself: its inner ones are, so the logic
// around them counts.

import type { FlatDesign, HierNode } from './flatten';
import { type ComponentDef, netlistOf } from './types';

/** Delays of our NAND master–slave flip-flop, in NAND delays (measured from its structure). */
export const CLK_TO_Q = 3;
export const SETUP = 3;
/** A loaded NAND2 in a 28 nm-class process: turns NAND delays into a clock rate. */
export const PS_PER_NAND = 25;

export interface TimingReport {
  /** Clock period needed: clk-to-q + logic + setup, in NAND delays. */
  period: number;
  logic: number;
  /** Flip-flop paths (instance names) that launch and capture the critical path. */
  launch: string[];
  capture: string[];
  /** The critical path as a list of leaves (hierarchical paths) with arrival times. */
  path: { node: string[]; arrival: number }[];
  /** Flat nets along the critical path, from the capture point back to the launching flip-flop. */
  nets: number[];
  /** Top-level instances crossed, in order, with the arrival time when the path leaves each. */
  stages: { inst: string; arrival: number }[];
  /** Worst arrival (+ setup) at each top-level instance that captures (pipeline registers, PC, …). */
  byCapture: { inst: string; period: number }[];
}

const innerFf = new WeakMap<ComponentDef, boolean>();
/** Does a flip-flop's inside contain another flip-flop? (Then the inner ones are the boundaries.) */
function hasInnerFf(def: ComponentDef): boolean {
  let r = innerFf.get(def);
  if (r === undefined) {
    innerFf.set(def, false); // (a malformed cycle)
    r = !!netlistOf(def)?.instances.some((i) => !!i.def.ff || hasInnerFf(i.def));
    innerFf.set(def, r);
  }
  return r;
}

export function analyzeTiming(design: FlatDesign): TimingReport | null {
  const leaves = design.leaves;
  const excluded = new Uint8Array(leaves.length);
  const qSource = new Map<number, string[]>(); // net -> launching dff path
  const captures: { net: number; dff: string[] }[] = [];

  const walk = (n: HierNode, insideDff: boolean): void => {
    const ff = insideDff ? undefined : n.def.ff;
    const isDff = !!ff && !hasInnerFf(n.def);
    if (ff && isDff) {
      for (const p of n.def.ports) if (p.dir === 'out') for (const net of n.ports[p.name]) qSource.set(net, n.path);
      captures.push({ net: n.ports[ff.d][0], dff: n.path });
      if (ff.en) captures.push({ net: n.ports[ff.en][0], dff: n.path });
    }
    if (n.leafIndex !== undefined && (insideDff || isDff)) excluded[n.leafIndex] = 1;
    n.children?.forEach((c) => walk(c, insideDff || isDff));
  };
  walk(design.root, false);
  if (!captures.length) return null;

  const driver = new Int32Array(design.netCount).fill(-1);
  leaves.forEach((l, i) => {
    if (!excluded[i]) for (const p of l.outputs) for (const net of p) driver[net] = i;
  });
  const arrival = new Float64Array(design.netCount).fill(-1);
  const via = new Int32Array(design.netCount).fill(-1); // critical input net of the driving leaf
  const state = new Uint8Array(design.netCount);
  const delayOf = (i: number) => (leaves[i].kind === 'nand' ? 1 : leaves[i].def.behavior?.delay ?? 1);

  // Iterative DFS (paths can be hundreds of gates deep).
  const arr = (start: number): number => {
    if (arrival[start] >= 0) return arrival[start];
    const stack = [start];
    while (stack.length) {
      const net = stack[stack.length - 1];
      if (arrival[net] >= 0) { stack.pop(); continue; }
      if (qSource.has(net)) { arrival[net] = CLK_TO_Q; stack.pop(); continue; }
      const d = driver[net];
      if (d < 0) { arrival[net] = 0; stack.pop(); continue; }
      if (state[net] === 0) {
        state[net] = 1;
        for (const p of leaves[d].inputs) for (const i of p) if (arrival[i] < 0 && state[i] === 0) stack.push(i);
        continue;
      }
      // All inputs visited (or on the stack: a combinational loop, counted as 0).
      let best = 0, bestNet = -1;
      for (const p of leaves[d].inputs) for (const i of p) {
        const a = arrival[i] < 0 ? 0 : arrival[i];
        if (a >= best) { best = a; bestNet = i; }
      }
      arrival[net] = best + delayOf(d);
      via[net] = bestNet;
      stack.pop();
    }
    return arrival[start];
  };

  let worst = -1, cap = captures[0];
  const byInst = new Map<string, number>();
  for (const c of captures) {
    const a = arr(c.net);
    if (a > worst) { worst = a; cap = c; }
    const top = c.dff[0] ?? '';
    byInst.set(top, Math.max(byInst.get(top) ?? 0, a + SETUP));
  }
  // Trace back.
  const path: { node: string[]; arrival: number }[] = [];
  const nets: number[] = [];
  let net = cap.net;
  let launch: string[] = [];
  while (net >= 0) {
    nets.push(net);
    if (qSource.has(net)) { launch = qSource.get(net)!; break; }
    const d = driver[net];
    if (d < 0) break;
    path.unshift({ node: leaves[d].node.path, arrival: arrival[net] });
    net = via[net];
  }
  const stages: { inst: string; arrival: number }[] = [];
  if (launch.length) stages.push({ inst: launch[0], arrival: CLK_TO_Q });
  for (const p of path) {
    const top = p.node[0] ?? '';
    if (stages.length && stages[stages.length - 1].inst === top) stages[stages.length - 1].arrival = p.arrival;
    else stages.push({ inst: top, arrival: p.arrival });
  }
  const byCapture = [...byInst].map(([inst, period]) => ({ inst, period })).sort((a, b) => b.period - a.period);
  return { period: worst + SETUP, logic: worst - CLK_TO_Q, launch, capture: cap.dff, path, nets, stages, byCapture };
}
