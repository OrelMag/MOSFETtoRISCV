// Bit-parallel two-valued simulator for test benches: 32 independent input vectors at once, one
// per bit of an Int32 word, so every NAND is ~(a & b) on whole words. It runs the same flattened
// NAND netlist as GateSim, only without timing or X: gates are evaluated in topological order
// (feedback loops broken arbitrarily) and swept until nothing changes. That is exact for
// combinational logic, and for edge-triggered logic built from master–slave latches it reaches
// the same state as GateSim, because each latch enable is a NOT of the clock evaluated before
// any latch in the sweep. Exhaustive tests of floating-point units use it; tests/bitsim.test.ts
// checks it against GateSim.

import type { FlatDesign, FlatLeaf } from './flatten';
import { type Bit, inPorts, outPorts } from './types';

export const LANES = 32;

/** Bit i of a non-negative integer that may exceed 32 bits. */
const bitOf = (x: number, i: number) => (i < 31 && x < 2 ** 31 ? (x >>> i) & 1 : Math.floor(x / 2 ** i) % 2);

export class BitSim {
  readonly design: FlatDesign;
  /** One word per net: bit l is the net's value in lane l. */
  readonly v: Int32Array;
  /** Leaves in evaluation order: NANDs as (a, b, y) net triples, behaviours as (−1 − index, 0, 0). */
  private readonly ops: Int32Array;
  /** True when the netlist has no feedback: one sweep settles it. */
  readonly acyclic: boolean;
  sweeps = 0;

  /** Behavioural leaves (e.g. an instruction ROM) in the evaluation order, with their state. */
  private readonly behaviors: { leaf: FlatLeaf; state: unknown }[] = [];

  constructor(design: FlatDesign) {
    this.design = design;
    const n = design.netCount;
    this.v = new Int32Array(n);
    const leaves = design.leaves;
    const driven = new Uint8Array(n);
    for (const p of inPorts(design.root.def)) for (const net of design.root.ports[p.name]) driven[net] = 1;
    const nodes: number[] = [];
    const driverOf = new Int32Array(n).fill(-1);
    leaves.forEach((l, li) => {
      if (l.kind === 'nand' || (l.kind === 'behavior' && l.inputs.length > 0)) {
        nodes.push(li);
        for (const port of l.outputs) for (const net of port) { driverOf[net] = li; driven[net] = 1; }
        return;
      }
      if (l.kind === 'behavior') {
        // constants (tie cells): evaluate once
        const outs = l.def.behavior!.eval([], l.def.behavior!.init?.());
        outPorts(l.def).forEach((_, pi) => l.outputs[pi].forEach((net, i) => {
          this.v[net] = bitOf(outs[pi], i) ? -1 : 0;
          driven[net] = 1;
        }));
        return;
      }
      throw new Error(`BitSim: ${l.node.path.join('.')} (${l.def.id}) is a ${l.kind} leaf; only NANDs and behaviours are supported`);
    });
    for (const li of nodes) for (const port of leaves[li].inputs) for (const net of port) {
      if (!driven[net]) throw new Error(`BitSim: undriven net into ${leaves[li].node.path.join('.')}`);
    }
    // Kahn's algorithm over the leaf graph; when only cycles remain, force the lowest-numbered leaf.
    const indeg = new Int32Array(nodes.length);
    const fan: number[][] = Array.from({ length: n }, () => []);
    nodes.forEach((li, k) => {
      for (const port of leaves[li].inputs) for (const net of port) {
        fan[net].push(k);
        if (driverOf[net] >= 0) indeg[k]++;
      }
    });
    const done = new Uint8Array(nodes.length);
    const order: number[] = [];
    const queue: number[] = [];
    nodes.forEach((_, k) => { if (indeg[k] === 0) queue.push(k); });
    let scan = 0, forced = false, head = 0;
    while (order.length < nodes.length) {
      if (head === queue.length) {
        while (done[scan]) scan++;
        queue.push(scan);
        forced = true;
      }
      const k = queue[head++];
      if (done[k]) continue;
      done[k] = 1;
      order.push(k);
      for (const port of leaves[nodes[k]].outputs) for (const net of port) for (const c of fan[net]) if (!done[c] && --indeg[c] === 0) queue.push(c);
    }
    this.acyclic = !forced;
    this.ops = new Int32Array(order.length * 3);
    order.forEach((k, i) => {
      const l = leaves[nodes[k]];
      if (l.kind === 'nand') {
        this.ops[3 * i] = l.inputs[0][0];
        this.ops[3 * i + 1] = l.inputs[1][0];
        this.ops[3 * i + 2] = l.outputs[0][0];
      } else {
        this.ops[3 * i] = -1 - this.behaviors.length;
        this.behaviors.push({ leaf: l, state: l.def.behavior!.init?.() });
      }
    });
    for (const [net, b] of design.powerOn) this.v[net] = b ? -1 : 0;
    this.settle();
  }

  /**
   * A behavioural leaf is evaluated on lane 0 and its outputs broadcast to every lane, so designs
   * with behaviours must be simulated with the same inputs in every lane. Returns: did an output change?
   */
  private evalBehavior(k: number): boolean {
    const { leaf, state } = this.behaviors[k], v = this.v;
    const ins = leaf.inputs.map((port) => port.reduce((acc, net, i) => acc + (v[net] & 1) * 2 ** i, 0));
    const outs = leaf.def.behavior!.eval(ins, state);
    let changed = false;
    leaf.outputs.forEach((port, pi) => port.forEach((net, i) => {
      const w = bitOf(outs[pi] ?? 0, i) ? -1 : 0;
      if (v[net] !== w) { v[net] = w; changed = true; }
    }));
    return changed;
  }

  /** Lane 0 of some nets, as bits (the Sim interface used by the co-simulation helpers). */
  getBits(nets: readonly number[]): Bit[] {
    return nets.map((n) => (this.v[n] & 1) as Bit);
  }

  /** Drive an input port: one value for every lane, or one value per lane. */
  setInput(port: string, values: number | ArrayLike<number>): void {
    const nets = this.design.root.ports[port];
    if (!nets) throw new Error(`no port '${port}'`);
    if (typeof values === 'number') {
      nets.forEach((net, i) => { this.v[net] = bitOf(values, i) ? -1 : 0; });
      return;
    }
    nets.forEach((net, i) => {
      let w = 0;
      for (let l = 0; l < values.length; l++) if (bitOf(values[l], i)) w |= 1 << l;
      this.v[net] = w;
    });
  }

  /** Read a port in every lane. */
  get(port: string, lanes = LANES): number[] {
    const nets = this.design.root.ports[port];
    if (!nets) throw new Error(`no port '${port}'`);
    const out: number[] = new Array(lanes).fill(0);
    nets.forEach((net, i) => {
      const w = this.v[net];
      if (!w) return;
      for (let l = 0; l < lanes; l++) if ((w >>> l) & 1) out[l] += 2 ** i;
    });
    return out;
  }

  settle(): void {
    const v = this.v, ops = this.ops, n = ops.length;
    if (this.acyclic && !this.behaviors.length) {
      for (let i = 0; i < n; i += 3) v[ops[i + 2]] = ~(v[ops[i]] & v[ops[i + 1]]);
      this.sweeps++;
      return;
    }
    for (let sweep = 0; sweep < 1000; sweep++) {
      let changed = false;
      for (let i = 0; i < n; i += 3) {
        const a = ops[i];
        if (a < 0) { if (this.evalBehavior(-1 - a)) changed = true; continue; }
        const y = ~(v[a] & v[ops[i + 1]]);
        if (v[ops[i + 2]] !== y) { v[ops[i + 2]] = y; changed = true; }
      }
      this.sweeps++;
      if (!changed) return;
    }
    throw new Error('BitSim: no fixed point (the circuit oscillates)');
  }

  /** One clock cycle on port clk: settle the inputs, rising edge, settle, falling edge, settle. */
  cycle(): void {
    this.settle();
    this.setInput('clk', 1);
    this.settle();
    this.setInput('clk', 0);
    this.settle();
  }
}

/**
 * Evaluate a combinational component on many input vectors, 32 at a time. `vectors[k]` is the
 * packed value of every input port (port order); the result holds the packed outputs.
 */
export function evalMany(sim: BitSim, vectors: number[][]): number[][] {
  const ins = inPorts(sim.design.root.def), outs = outPorts(sim.design.root.def);
  const res: number[][] = [];
  for (let at = 0; at < vectors.length; at += LANES) {
    const batch = vectors.slice(at, at + LANES);
    ins.forEach((p, pi) => sim.setInput(p.name, batch.map((v) => v[pi])));
    sim.settle();
    const got = outs.map((p) => sim.get(p.name, batch.length));
    batch.forEach((_, l) => res.push(got.map((g) => g[l])));
  }
  return res;
}
