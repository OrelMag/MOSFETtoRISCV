// Static timing analysis: the longest register-to-register path in NAND delays.
// Flip-flops (components marked `ff`: the library DFF, a user chip ticked as a flip-flop) are the
// timing boundaries: their outputs launch at clk-to-q, their data inputs (d, and en if any) must
// arrive a setup time before the next rising edge. Everything in between is combinational and
// is traversed backwards from every capture point. A flip-flop that contains flip-flops (the
// DFFE: a mux in front of a DFF) is not a boundary itself: its inner ones are, so the logic
// around them counts. Delays are NAND delays, or under the load model (delay.ts) each NAND by its load.

import { type DelayModel, fanoutOf, inputArrivals, leafDelays, nandDelay, netLoads } from './delay';
import type { FlatDesign, HierNode } from './flatten';
import { driverOf } from './netcap';
import { type ComponentDef, netlistOf } from './types';

/** Delays of our NAND master–slave flip-flop, in NAND delays (measured from its structure). */
export const CLK_TO_Q = 3;
export const SETUP = 3;
/** An illustrative loaded NAND2 in a 28 nm-class process, not characterized from a cell library:
 *  turns NAND delays into a clock rate. */
export const PS_PER_NAND = 25;
/** Tooltip for every clock rate derived from PS_PER_NAND. */
export const PS_NOTE = `Clock rates assume an illustrative ${PS_PER_NAND} ps per NAND delay (a loaded NAND2 in a 28 nm-class process), not timing characterized from a cell library.`;

export interface TimingReport {
  /** The delay model the numbers are in: NAND delays ('unit') or load-dependent units (delay.ts). */
  model: DelayModel;
  /** Clock period needed: clk-to-q + logic + setup, in NAND delays. */
  period: number;
  logic: number;
  /** Flip-flop paths (instance names) that launch and capture the critical path. */
  launch: string[];
  capture: string[];
  /** The critical path as a list of leaves (hierarchical paths) with arrival times; under the load model
   *  also the fan-out of the net each drives along the path (NAND inputs and other loads). */
  path: { node: string[]; arrival: number; fanout?: number }[];
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

/** `outputs`: the root's outputs are capture points too (due at the next edge, no setup), as a synthesis
 *  constraint with zero output delay counts them: a core whose memories sit outside its ports.
 *  `delay`: the delay model (default 'unit': every NAND 1). */
export function analyzeTiming(design: FlatDesign, opts: { outputs?: boolean; delay?: DelayModel } = {}): TimingReport | null {
  const model = opts.delay ?? 'unit';
  const leaves = design.leaves;
  const excluded = new Uint8Array(leaves.length);
  const qSource = new Map<number, string[]>(); // net -> launching dff path
  const loads = model !== 'unit' ? netLoads(design) : null;
  const allDrivers = loads ? driverOf(design) : null;
  const inArr = inputArrivals(design, model);
  // A flip-flop's last NAND drives the q net: under the load model it sees that net's load.
  const clkToQ = (net: number) => {
    const d = allDrivers ? allDrivers[net] : -1;
    return d < 0 || leaves[d].kind !== 'nand' ? CLK_TO_Q : CLK_TO_Q - 1 + nandDelay(loads![net], model === 'load');
  };
  const captures: { net: number; dff: string[]; pin?: boolean }[] = [];
  // Edge-triggered behaviours (a large RAM): their inputs but clk are captured like a flip-flop's
  // d, and only their comb inputs reach the outputs, which launch at clk-to-q at the earliest.
  const tin = leaves.map((l) => l.inputs);
  const seq0 = new Uint8Array(leaves.length);

  const walk = (n: HierNode, insideDff: boolean): void => {
    const ff = insideDff ? undefined : n.def.ff;
    const isDff = !!ff && !hasInnerFf(n.def);
    if (ff && isDff) {
      for (const p of n.def.ports) if (p.dir === 'out') for (const net of n.ports[p.name]) qSource.set(net, n.path);
      captures.push({ net: n.ports[ff.d][0], dff: n.path });
      if (ff.en) captures.push({ net: n.ports[ff.en][0], dff: n.path });
    }
    if (n.leafIndex !== undefined && (insideDff || isDff)) excluded[n.leafIndex] = 1;
    const seq = n.def.behavior?.seq;
    if (seq && n.leafIndex !== undefined && !insideDff && !isDff) {
      for (const p of n.def.ports) if (p.dir === 'in' && p.name !== seq.clk) for (const net of n.ports[p.name]) captures.push({ net, dff: n.path });
      tin[n.leafIndex] = [seq.comb.flatMap((c) => n.ports[c] ?? [])];
      seq0[n.leafIndex] = 1;
    }
    n.children?.forEach((c) => walk(c, insideDff || isDff));
  };
  walk(design.root, false);
  if (opts.outputs) for (const p of design.root.def.ports) if (p.dir === 'out') for (const net of design.root.ports[p.name]) captures.push({ net, dff: [p.name], pin: true });
  if (!captures.length) return null;

  const driver = new Int32Array(design.netCount).fill(-1);
  leaves.forEach((l, i) => {
    if (!excluded[i]) for (const p of l.outputs) for (const net of p) driver[net] = i;
  });
  const arrival = new Float64Array(design.netCount).fill(-1);
  const via = new Int32Array(design.netCount).fill(-1); // critical input net of the driving leaf
  const state = new Uint8Array(design.netCount);
  const delays = leafDelays(design, model);

  // Iterative DFS (paths can be hundreds of gates deep).
  const arr = (start: number): number => {
    if (arrival[start] >= 0) return arrival[start];
    const stack = [start];
    while (stack.length) {
      const net = stack[stack.length - 1];
      if (arrival[net] >= 0) { stack.pop(); continue; }
      if (qSource.has(net)) { arrival[net] = clkToQ(net); stack.pop(); continue; }
      const d = driver[net];
      if (d < 0) { arrival[net] = inArr ? inArr[net] : 0; stack.pop(); continue; }
      const ins = tin[d];
      if (state[net] === 0) {
        state[net] = 1;
        for (const p of ins) for (const i of p) if (arrival[i] < 0 && state[i] === 0) stack.push(i);
        continue;
      }
      // All inputs visited (or on the stack: a combinational loop, counted as 0).
      let best = seq0[d] ? CLK_TO_Q : 0, bestNet = -1;
      for (const p of ins) for (const i of p) {
        const a = arrival[i] < 0 ? 0 : arrival[i];
        if (a >= best) { best = a; bestNet = i; }
      }
      arrival[net] = best + delays[d];
      via[net] = bestNet;
      stack.pop();
    }
    return arrival[start];
  };

  let worst = -1, cap = captures[0];
  const byInst = new Map<string, number>();
  for (const c of captures) {
    const a = arr(c.net) + (c.pin ? 0 : SETUP);
    if (a > worst) { worst = a; cap = c; }
    if (c.pin) continue;
    const top = c.dff[0] ?? '';
    byInst.set(top, Math.max(byInst.get(top) ?? 0, a));
  }
  // Trace back.
  const path: TimingReport['path'] = [];
  const nets: number[] = [];
  let net = cap.net;
  let launch: string[] = [];
  while (net >= 0) {
    nets.push(net);
    if (qSource.has(net)) { launch = qSource.get(net)!; break; }
    const d = driver[net];
    if (d < 0) break;
    path.unshift(loads
      ? { node: leaves[d].node.path, arrival: arrival[net], fanout: fanoutOf(loads[net]) }
      : { node: leaves[d].node.path, arrival: arrival[net] });
    if (via[net] < 0 && seq0[d]) { launch = leaves[d].node.path; break; }
    net = via[net];
  }
  const stages: { inst: string; arrival: number }[] = [];
  const launchQ = qSource.has(nets[nets.length - 1]) ? clkToQ(nets[nets.length - 1]) : CLK_TO_Q;
  if (launch.length) stages.push({ inst: launch[0], arrival: launchQ });
  for (const p of path) {
    const top = p.node[0] ?? '';
    if (stages.length && stages[stages.length - 1].inst === top) stages[stages.length - 1].arrival = p.arrival;
    else stages.push({ inst: top, arrival: p.arrival });
  }
  const byCapture = [...byInst].map(([inst, period]) => ({ inst, period })).sort((a, b) => b.period - a.period);
  return { model, period: worst, logic: worst - (cap.pin ? 0 : SETUP) - launchQ, launch, capture: cap.dff, path, nets, stages, byCapture };
}
