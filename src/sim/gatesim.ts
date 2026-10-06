// Event-driven gate-level simulator over 1-bit nets with three values (0, 1, X).
// Every NAND has a delay of one time unit; behavioural leaves use their declared delay.
// Transport delay is used, so glitches are visible when propagation is animated.

import { matchNets, sharedInputs } from './carry';
import { findNode, type FlatDesign } from './flatten';
import type { PowerOnMode, Sim } from './sim';
import { B0, B1, BX, BZ, type Bit, outPorts } from './types';
import { pack, unpack } from './values';

const RING = 64; // event wheel size; must exceed the largest leaf delay

export interface GateSimOptions {
  /** Maximum simulated time per settle() before the circuit is declared unstable. */
  settleLimit?: number;
}

export class GateSim implements Sim {
  readonly kind = 'gate' as const;
  readonly design: FlatDesign;
  time = 0;
  unstable = false;
  evaluations = 0;
  onTrace?: (net: number, value: Bit, time: number) => void;

  private val: Uint8Array;
  private proj: Uint8Array;
  private watched: Uint8Array;
  private fanStart: Int32Array;
  private fanList: Int32Array;
  private delay: Int32Array;
  private state: unknown[];
  private inputs = new Map<string, number>();
  private inputNets = new Map<string, number[]>();

  private dirty: number[] = [];
  private dirtyMark: Uint8Array;
  private wheelNets: number[][] = Array.from({ length: RING }, () => []);
  private wheelVals: number[][] = Array.from({ length: RING }, () => []);
  private pendingEvents = 0;
  private settleLimit: number;

  constructor(design: FlatDesign, opts: GateSimOptions = {}) {
    this.design = design;
    this.settleLimit = opts.settleLimit ?? 4000;
    const n = design.netCount;
    const leaves = design.leaves;
    this.val = new Uint8Array(n).fill(BX);
    this.proj = new Uint8Array(n).fill(BX);
    this.watched = new Uint8Array(n);
    this.dirtyMark = new Uint8Array(leaves.length);
    this.delay = new Int32Array(leaves.length);
    this.state = new Array(leaves.length);

    // Fan-out lists in CSR form, and a single-driver check.
    const counts = new Int32Array(n + 1);
    const driver = new Int32Array(n).fill(-1);
    leaves.forEach((l, li) => {
      for (const port of l.inputs) for (const net of port) counts[net + 1]++;
      for (const port of l.outputs) {
        for (const net of port) {
          if (driver[net] >= 0) {
            throw new Error(`net driven by both ${pathOf(leaves[driver[net]])} and ${pathOf(l)}`);
          }
          driver[net] = li;
        }
      }
      this.delay[li] = l.kind === 'nand' ? 1 : Math.max(1, Math.min(RING - 1, l.def.behavior?.delay ?? 1));
    });
    for (let i = 0; i < n; i++) counts[i + 1] += counts[i];
    this.fanStart = counts;
    this.fanList = new Int32Array(counts[n]);
    const fill = counts.slice(0, n);
    leaves.forEach((l, li) => {
      for (const port of l.inputs) for (const net of port) this.fanList[fill[net]++] = li;
    });

    for (const p of design.root.def.ports) {
      if (p.dir === 'in') {
        this.inputNets.set(p.name, design.root.ports[p.name]);
        this.inputs.set(p.name, 0);
      }
    }
    this.reset('zero');
  }

  get(net: number): Bit {
    return this.val[net] as Bit;
  }

  getBits(nets: readonly number[]): Bit[] {
    return nets.map((n) => this.val[n] as Bit);
  }

  getInput(port: string): number {
    return this.inputs.get(port) ?? 0;
  }

  setInput(port: string, value: number): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    this.inputs.set(port, value);
    const bits = unpack(value, nets.length);
    nets.forEach((net, i) => this.force(net, bits[i]));
  }

  watch(nets: readonly number[]): void {
    for (const n of nets) this.watched[n] = 1;
  }

  busy(): boolean {
    return this.pendingEvents > 0 || this.dirty.length > 0;
  }

  reset(mode: PowerOnMode = 'zero'): void {
    this.val.fill(BX);
    this.proj.fill(BX);
    this.wheelNets.forEach((b) => (b.length = 0));
    this.wheelVals.forEach((b) => (b.length = 0));
    this.pendingEvents = 0;
    this.time = 0;
    this.unstable = false;
    this.design.leaves.forEach((l, i) => {
      this.state[i] = l.def.behavior?.init?.();
    });
    for (const [port, v] of this.inputs) {
      const nets = this.inputNets.get(port)!;
      unpack(v, nets.length).forEach((b, i) => {
        this.val[nets[i]] = b;
        this.proj[nets[i]] = b;
      });
    }
    if (mode !== 'x') {
      for (const [net, v] of this.design.powerOn) {
        const b = mode === 'random' ? (Math.random() < 0.5 ? 0 : 1) : v;
        this.val[net] = b;
        this.proj[net] = b;
      }
    }
    this.dirty.length = 0;
    this.dirtyMark.fill(0);
    for (let i = 0; i < this.design.leaves.length; i++) this.markDirty(i);
    this.relax();

    // Any storage loop without a hint is still X: break the tie by forcing outputs, the way
    // real silicon settles to an arbitrary state, then let the circuit resolve itself.
    if (mode !== 'x') {
      for (let round = 0; round < 4096; round++) {
        const l = this.design.leaves.findIndex((leaf) =>
          leaf.outputs.some((p) => p.some((net) => this.val[net] === BX)));
        if (l < 0) break;
        for (const p of this.design.leaves[l].outputs) {
          for (const net of p) {
            if (this.val[net] === BX) this.force(net, mode === 'random' && Math.random() < 0.5 ? B1 : B0);
          }
        }
        this.relax();
      }
    }
    this.time = 0;
    this.unstable = false;
  }

  /**
   * Take over the state of a simulation of a previous version of the design (an editor rebuilds
   * the circuit on every edit). Nets are matched through the hierarchy (see matchNets: instance
   * paths, port names, internal nets), so a counter keeps its count when an unrelated gate is
   * added. Root inputs carry over by port name when the widths match; behavioural leaves at the
   * same path with the same definition id get a copy of their private state; the time carries
   * over. Anything new keeps its power-on value. Pending events of `prev` are dropped: the
   * result is relaxed to a fixed point, so a storage loop that held a value keeps it, and logic
   * that changed is recomputed. A switch-level `prev` works too (Z becomes X). With `known`,
   * X / Z nets of `prev` are not copied (they keep their power-on value).
   */
  carry(prev: Sim, opts: { known?: boolean } = {}): void {
    const d = this.design;
    for (const name of sharedInputs(d, prev.design)) this.inputs.set(name, prev.getInput(name));
    const map = matchNets(d, prev.design);
    for (let net = 0; net < d.netCount; net++) {
      if (map[net] < 0) continue;
      const b = prev.get(map[net]);
      if (opts.known && b !== B0 && b !== B1) continue;
      this.val[net] = b === BZ ? BX : b;
      this.proj[net] = this.val[net];
    }
    for (const [port, v] of this.inputs) {
      const nets = this.inputNets.get(port)!;
      unpack(v, nets.length).forEach((b, i) => {
        this.val[nets[i]] = b;
        this.proj[nets[i]] = b;
      });
    }
    if (prev instanceof GateSim) {
      d.leaves.forEach((l, li) => {
        if (l.kind !== 'behavior' || !l.def.behavior?.init) return;
        const o = findNode(prev.design.root, l.node.path);
        if (o?.leafIndex === undefined || o.def.id !== l.def.id) return;
        this.state[li] = cloneState(prev.state[o.leafIndex]);
      });
    }
    this.wheelNets.forEach((b) => (b.length = 0));
    this.wheelVals.forEach((b) => (b.length = 0));
    this.pendingEvents = 0;
    this.dirty.length = 0;
    this.dirtyMark.fill(0);
    for (let i = 0; i < d.leaves.length; i++) this.markDirty(i);
    this.unstable = false;
    this.relax();
    this.time = prev.time;
  }

  /**
   * Zero-delay relaxation: evaluate dirty leaves one at a time, applying each output
   * immediately (Gauss–Seidel). Unlike the timed simulation, this cannot get stuck in the
   * symmetric oscillation of a perfectly balanced latch: updating one gate before the other
   * breaks the tie, as unequal real delays would. Used at power-on and to resolve
   * oscillations (a model of metastability resolving).
   */
  relax(): void {
    // Drop any timed events; relaxation replaces them.
    for (let s = 0; s < RING; s++) {
      for (let i = 0; i < this.wheelNets[s].length; i++) this.proj[this.wheelNets[s][i]] = this.val[this.wheelNets[s][i]];
      this.wheelNets[s] = [];
      this.wheelVals[s] = [];
    }
    this.pendingEvents = 0;
    const leaves = this.design.leaves;
    const budget = 64 * leaves.length + 1000;
    let work = 0;
    const out: Bit[] = [];
    const q = this.dirty; // work queue; markDirty() appends to it while we walk it
    let head = 0;
    while (head < q.length) {
      const li = q[head++];
      this.dirtyMark[li] = 0;
      if (++work > budget) {
        // Genuinely unstable (e.g. a ring oscillator): give up and mark its outputs X.
        for (const p of leaves[li].outputs) for (const net of p) this.force(net, BX);
        for (let i = head; i < q.length; i++) this.dirtyMark[q[i]] = 0;
        this.dirty = [];
        this.unstable = true;
        return;
      }
      this.evaluations++;
      this.evalLeaf(li, out);
      let k = 0;
      for (const p of leaves[li].outputs) for (const net of p) this.force(net, out[k++]);
      if (head > 4096 && head * 2 > q.length) {
        q.splice(0, head);
        head = 0;
      }
    }
    this.dirty = [];
  }

  step(): boolean {
    if (this.dirty.length) this.evalDirty();
    if (this.pendingEvents === 0) return false;
    // Advance to the next time instant that holds events.
    let t = this.time + 1;
    while (this.wheelNets[t % RING].length === 0) t++;
    this.time = t;
    const slot = t % RING;
    const nets = this.wheelNets[slot];
    const vals = this.wheelVals[slot];
    this.wheelNets[slot] = [];
    this.wheelVals[slot] = [];
    this.pendingEvents -= nets.length;
    for (let i = 0; i < nets.length; i++) this.apply(nets[i], vals[i] as Bit);
    this.evalDirty();
    return true;
  }

  /**
   * Process every event up to and including time t, then stand at t even if events are
   * still pending beyond it (a clock edge that does not wait for the logic to settle).
   */
  runUntil(t: number): void {
    for (;;) {
      if (this.dirty.length) this.evalDirty();
      if (this.pendingEvents === 0) break;
      let n = this.time + 1;
      while (this.wheelNets[n % RING].length === 0) n++;
      if (n > t) break;
      this.step();
    }
    if (t > this.time) this.time = t;
  }

  settle(): void {
    const start = this.time;
    this.unstable = false;
    while (this.step()) {
      if (this.time - start > this.settleLimit) {
        // Oscillation (e.g. both inputs of an SR latch released together): resolve it.
        this.unstable = true;
        for (let i = 0; i < this.design.leaves.length; i++) this.markDirty(i);
        this.relax();
        this.unstable = true;
        return;
      }
    }
  }

  // --- internals -----------------------------------------------------------------------

  private force(net: number, b: Bit): void {
    this.proj[net] = b;
    this.apply(net, b);
  }

  private apply(net: number, b: Bit): void {
    if (this.val[net] === b) return;
    this.val[net] = b;
    if (this.watched[net] && this.onTrace) this.onTrace(net, b, this.time);
    for (let i = this.fanStart[net]; i < this.fanStart[net + 1]; i++) this.markDirty(this.fanList[i]);
  }

  private markDirty(leaf: number): void {
    if (!this.dirtyMark[leaf]) {
      this.dirtyMark[leaf] = 1;
      this.dirty.push(leaf);
    }
  }

  private evalDirty(): void {
    const list = this.dirty;
    this.dirty = [];
    for (const li of list) this.dirtyMark[li] = 0;
    const leaves = this.design.leaves;
    const out: Bit[] = [];
    for (const li of list) {
      this.evaluations++;
      const t = this.time + this.delay[li];
      this.evalLeaf(li, out);
      let k = 0;
      for (const p of leaves[li].outputs) for (const net of p) this.schedule(net, out[k++], t);
    }
  }

  /** Compute a leaf's output bits (flattened across its output ports) into `out`. */
  private evalLeaf(li: number, out: Bit[]): void {
    const leaf = this.design.leaves[li];
    const v = this.val;
    if (leaf.kind === 'nand') {
      const a = v[leaf.inputs[0][0]];
      const b = v[leaf.inputs[1][0]];
      out[0] = a === B0 || b === B0 ? B1 : a === B1 && b === B1 ? B0 : BX;
      return;
    }
    const ins = leaf.inputs.map((p) => pack(p.map((net) => v[net])));
    const outs = leaf.def.behavior!.eval(ins, this.state[li]);
    const ops = outPorts(leaf.def);
    let k = 0;
    ops.forEach((p, pi) => {
      for (const b of unpack(outs[pi] ?? -1, p.width)) out[k++] = b;
    });
  }

  private schedule(net: number, b: Bit, t: number): void {
    if (this.proj[net] === b) return;
    this.proj[net] = b;
    const slot = t % RING;
    this.wheelNets[slot].push(net);
    this.wheelVals[slot].push(b);
    this.pendingEvents++;
  }
}

/**
 * Deep copy of plain data (objects, arrays, typed arrays, maps, sets), so the two simulations do
 * not share it. A class instance would lose its prototype in structuredClone: share it instead.
 */
function cloneState(s: unknown): unknown {
  if (s === null || typeof s !== 'object') return s;
  const proto = Object.getPrototypeOf(s);
  const plain = proto === Object.prototype || proto === null || Array.isArray(s) || ArrayBuffer.isView(s) || s instanceof Map || s instanceof Set;
  if (!plain) return s;
  try {
    return structuredClone(s);
  } catch {
    return s;
  }
}

function pathOf(l: { node: { path: string[] } }): string {
  return l.node.path.join('.') || '(root)';
}
