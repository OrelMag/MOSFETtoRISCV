// Event-driven gate-level simulator over 1-bit nets with three values (0, 1, X).
// Every NAND has a delay of one time unit; behavioural leaves use their declared delay.
// Transport delay is used, so glitches are visible when propagation is animated.
//
// The hot loops work on flat typed arrays (a NAND's two input nets and its output net, fan-out
// lists, an event wheel of growable typed buffers, a FIFO ring of dirty leaves). The semantics are
// those of the first, object-based version, kept as tests/ref/gatesim-ref.ts: tests/gatesim-fast
// .test.ts checks that both report the same changes at the same times, the same power-on and the
// same relaxation, on CPUs and on sequential parts.

import { matchNets, sharedInputs } from './carry';
import { findNode, type FlatDesign } from './flatten';
import type { PowerOnMode, Sim, SimState } from './sim';
import { B0, B1, BX, BZ, type Bit, outPorts } from './types';
import { pack, unpack } from './values';

const RING = 64; // event wheel size; must exceed the largest leaf delay

/** NAND of two 3-valued inputs, indexed by (a << 2) | b (Z reads as X). */
const NAND_T = new Uint8Array(16);
for (let a = 0; a < 4; a++) {
  for (let b = 0; b < 4; b++) NAND_T[(a << 2) | b] = a === B0 || b === B0 ? B1 : a === B1 && b === B1 ? B0 : BX;
}

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
  private anyWatched = false;
  private fanStart: Int32Array;
  private fanList: Int32Array;
  private delay: Int32Array;
  /** A NAND leaf's input nets and output net; opA = −1 for a behavioural leaf. */
  private opA: Int32Array;
  private opB: Int32Array;
  private opY: Int32Array;
  /** Every leaf's output nets, all ports in order (CSR). */
  private outStart: Int32Array;
  private outList: Int32Array;
  private state: unknown[];
  /** Root input values: a number from setInput, bits from setInputBits (wide values stay exact). */
  private inputs = new Map<string, number | Bit[]>();
  private inputNets = new Map<string, number[]>();

  /** Dirty leaves: a FIFO ring (each leaf at most once, dirtyMark), so its capacity is the leaf count. */
  private dq: Int32Array;
  private dHead = 0;
  private dLen = 0;
  private dirtyMark: Uint8Array;
  /** Event wheel: per slot, nets and values in the order scheduled, and how many. */
  private wNets: Int32Array[] = Array.from({ length: RING }, () => new Int32Array(16));
  private wVals: Uint8Array[] = Array.from({ length: RING }, () => new Uint8Array(16));
  private wLen = new Int32Array(RING);
  private pendingEvents = 0;
  private settleLimit: number;
  private out: Bit[] = [];

  constructor(design: FlatDesign, opts: GateSimOptions = {}) {
    this.design = design;
    this.settleLimit = opts.settleLimit ?? 4000;
    const n = design.netCount;
    const leaves = design.leaves;
    const L = leaves.length;
    this.val = new Uint8Array(n).fill(BX);
    this.proj = new Uint8Array(n).fill(BX);
    this.watched = new Uint8Array(n);
    this.dirtyMark = new Uint8Array(L);
    this.dq = new Int32Array(Math.max(1, L));
    this.delay = new Int32Array(L);
    this.opA = new Int32Array(L).fill(-1);
    this.opB = new Int32Array(L);
    this.opY = new Int32Array(L);
    this.outStart = new Int32Array(L + 1);
    this.state = new Array(L);

    // Fan-out lists in CSR form, and a single-driver check.
    const counts = new Int32Array(n + 1);
    const driver = new Int32Array(n).fill(-1);
    let outs = 0;
    leaves.forEach((l, li) => {
      for (const port of l.inputs) for (const net of port) counts[net + 1]++;
      for (const port of l.outputs) {
        for (const net of port) {
          if (driver[net] >= 0) {
            throw new Error(`net driven by both ${pathOf(leaves[driver[net]])} and ${pathOf(l)}`);
          }
          driver[net] = li;
          outs++;
        }
      }
      const d = l.kind === 'nand' ? 1 : Math.max(1, l.def.behavior?.delay ?? 1);
      // A longer delay would wrap the event wheel and fire early: refuse it rather than clamp it.
      if (d >= RING) throw new Error(`${pathOf(l)}: delay ${d} exceeds the event wheel (max ${RING - 1})`);
      this.delay[li] = d;
      if (l.kind === 'nand') {
        this.opA[li] = l.inputs[0][0];
        this.opB[li] = l.inputs[1][0];
        this.opY[li] = l.outputs[0][0];
      }
    });
    this.outList = new Int32Array(outs);
    let k = 0;
    leaves.forEach((l, li) => {
      this.outStart[li] = k;
      for (const port of l.outputs) for (const net of port) this.outList[k++] = net;
    });
    this.outStart[L] = k;
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
    const v = this.val;
    const out: Bit[] = new Array(nets.length);
    for (let i = 0; i < nets.length; i++) out[i] = v[nets[i]] as Bit;
    return out;
  }

  getInput(port: string): number {
    const v = this.inputs.get(port) ?? 0;
    return typeof v === 'number' ? v : pack(v);
  }

  getInputBits(port: string): Bit[] {
    return this.inputBits(port, this.inputs.get(port) ?? 0);
  }

  private inputBits(port: string, v: number | Bit[]): Bit[] {
    return typeof v === 'number' ? unpack(v, this.inputNets.get(port)?.length ?? 0) : v.slice();
  }

  setInput(port: string, value: number): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    this.inputs.set(port, value);
    const bits = unpack(value, nets.length);
    nets.forEach((net, i) => this.force(net, bits[i]));
  }

  setInputBits(port: string, bits: ArrayLike<number>): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    // no Z at gate level: an undriven input reads as unknown
    const b = nets.map((_, i) => (bits[i] === B0 || bits[i] === B1 ? bits[i] : BX) as Bit);
    this.inputs.set(port, b);
    nets.forEach((net, i) => this.force(net, b[i]));
  }

  watch(nets: readonly number[]): void {
    for (const n of nets) this.watched[n] = 1;
    if (nets.length) this.anyWatched = true;
  }

  poke(leaf: number, state: unknown): void {
    this.state[leaf] = state;
    this.markDirty(leaf);
  }

  leafState(leaf: number): unknown {
    return this.state[leaf];
  }

  /**
   * Force nets to these bits now, as storage seeded from outside (a behavioural RAM's words put
   * into the latches of its structure: Behavior.inside). The logic reading them reacts on the
   * next step / settle; a net already at its bit is left alone.
   */
  forceNets(nets: readonly number[], bits: ArrayLike<number>): void {
    nets.forEach((net, i) => {
      const b = (bits[i] === B0 || bits[i] === B1 ? bits[i] : BX) as Bit;
      if (this.val[net] !== b) this.force(net, b);
    });
  }

  busy(): boolean {
    return this.pendingEvents > 0 || this.dLen > 0;
  }

  reset(mode: PowerOnMode = 'zero'): void {
    this.val.fill(BX);
    this.proj.fill(BX);
    this.wLen.fill(0);
    this.pendingEvents = 0;
    this.time = 0;
    this.unstable = false;
    this.design.leaves.forEach((l, i) => {
      this.state[i] = l.def.behavior?.init?.(mode);
    });
    for (const [port, v] of this.inputs) {
      const nets = this.inputNets.get(port)!;
      this.inputBits(port, v).forEach((b, i) => {
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
    this.clearDirty();
    const L = this.design.leaves.length;
    for (let i = 0; i < L; i++) this.markDirty(i);
    this.relax();

    // Any storage loop without a hint is still X: break the tie by forcing outputs, the way
    // real silicon settles to an arbitrary state, then let the circuit resolve itself.
    if (mode !== 'x') {
      const { outStart, outList, val } = this;
      for (let round = 0; round < 4096; round++) {
        // the first leaf with an X output: the owner of the first X in outList (sorted by leaf)
        let k = 0;
        while (k < outList.length && val[outList[k]] !== BX) k++;
        if (k === outList.length) break;
        let lo = 0, hi = L - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (outStart[mid] <= k) lo = mid;
          else hi = mid - 1;
        }
        for (let q = outStart[lo]; q < outStart[lo + 1]; q++) {
          const net = outList[q];
          if (val[net] === BX) this.force(net, mode === 'random' && Math.random() < 0.5 ? B1 : B0);
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
    for (const name of sharedInputs(d, prev.design)) this.inputs.set(name, prev.getInputBits(name).map((b) => (b === BZ ? BX : b)));
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
      this.inputBits(port, v).forEach((b, i) => {
        this.val[nets[i]] = b;
        this.proj[nets[i]] = b;
      });
    }
    d.leaves.forEach((l, li) => {
      if (l.kind !== 'behavior' || !l.def.behavior?.init) return;
      const o = findNode(prev.design.root, l.node.path);
      if (o?.leafIndex === undefined || o.def.id !== l.def.id) return;
      const s = prev.leafState(o.leafIndex);
      const c = l.def.behavior.carry;
      if (s !== undefined) this.state[li] = c ? c(s, !!opts.known) : cloneState(s);
    });
    this.wLen.fill(0);
    this.pendingEvents = 0;
    this.clearDirty();
    for (let i = 0; i < d.leaves.length; i++) this.markDirty(i);
    this.unstable = false;
    this.relax();
    this.time = prev.time;
  }

  /**
   * Take over a settled state of this same design from another engine (the cycle engine, see
   * DualSim): every net's value, the behavioural states (shared, not copied: one engine runs at a
   * time), the inputs and the time. Nothing is pending afterwards except the readers of the
   * `changed` nets and the `dirty` leaves: input changes and pokes the other engine had not settled,
   * which then propagate exactly as if they had been made here.
   */
  adopt(src: Sim, changed: readonly number[] = [], dirty: readonly number[] = []): void {
    const d = this.design;
    for (let net = 0; net < d.netCount; net++) {
      const b = src.get(net);
      this.val[net] = this.proj[net] = b === BZ ? BX : b;
    }
    d.leaves.forEach((l, li) => { if (l.kind === 'behavior') this.state[li] = src.leafState(li); });
    for (const port of this.inputNets.keys()) this.inputs.set(port, src.getInputBits(port));
    this.time = src.time;
    this.unstable = false;
    this.wLen.fill(0);
    this.pendingEvents = 0;
    this.clearDirty();
    for (const net of changed) for (let i = this.fanStart[net]; i < this.fanStart[net + 1]; i++) this.markDirty(this.fanList[i]);
    for (const li of dirty) this.markDirty(li);
  }

  saveState(): SimState {
    const st: GateState = {
      val: this.val.slice(), proj: this.proj.slice(), state: this.state.map(cloneState),
      inputs: new Map([...this.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v])),
      time: this.time, unstable: this.unstable, evaluations: this.evaluations,
      wheelNets: this.wNets.map((b, s) => b.slice(0, this.wLen[s])),
      wheelVals: this.wVals.map((b, s) => b.slice(0, this.wLen[s])),
      pending: this.pendingEvents, dirty: this.dirtyList(),
    };
    return st as unknown as SimState;
  }

  restoreState(saved: SimState): void {
    const s = saved as unknown as GateState;
    this.val.set(s.val);
    this.proj.set(s.proj);
    // copies again: the same saved state may be restored more than once
    this.state = s.state.map(cloneState);
    this.inputs = new Map([...s.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
    this.time = s.time;
    this.unstable = s.unstable;
    this.evaluations = s.evaluations;
    for (let slot = 0; slot < RING; slot++) {
      const nets = s.wheelNets[slot], n = nets.length;
      if (this.wNets[slot].length < n) {
        this.wNets[slot] = new Int32Array(n);
        this.wVals[slot] = new Uint8Array(n);
      }
      this.wNets[slot].set(nets);
      this.wVals[slot].set(s.wheelVals[slot]);
      this.wLen[slot] = n;
    }
    this.pendingEvents = s.pending;
    this.clearDirty();
    for (const li of s.dirty) this.markDirty(li);
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
    const { val, proj, opA, opB, opY, dq, dirtyMark, outStart, outList } = this;
    for (let s = 0; s < RING; s++) {
      const nets = this.wNets[s];
      for (let i = 0; i < this.wLen[s]; i++) proj[nets[i]] = val[nets[i]];
      this.wLen[s] = 0;
    }
    this.pendingEvents = 0;
    const cap = dq.length;
    const budget = 64 * this.design.leaves.length + 1000;
    let work = 0;
    const out = this.out;
    // the FIFO is the work queue: markDirty() appends to it while we walk it
    while (this.dLen > 0) {
      const li = dq[this.dHead];
      if (++this.dHead === cap) this.dHead = 0;
      this.dLen--;
      dirtyMark[li] = 0;
      if (++work > budget) {
        // Genuinely unstable (e.g. a ring oscillator): give up and mark its outputs X.
        for (let q = outStart[li]; q < outStart[li + 1]; q++) this.force(outList[q], BX);
        this.clearDirty();
        this.unstable = true;
        return;
      }
      this.evaluations++;
      const a = opA[li];
      if (a >= 0) {
        const y = NAND_T[(val[a] << 2) | val[opB[li]]] as Bit;
        const net = opY[li];
        proj[net] = y;
        if (val[net] !== y) this.apply(net, y);
        continue;
      }
      this.evalBehavior(li, out);
      for (let q = outStart[li], j = 0; q < outStart[li + 1]; q++) this.force(outList[q], out[j++]);
    }
  }

  step(): boolean {
    if (this.dLen) this.evalDirty();
    if (this.pendingEvents === 0) return false;
    // Advance to the next time instant that holds events.
    let t = this.time + 1;
    while (this.wLen[t % RING] === 0) t++;
    this.time = t;
    const slot = t % RING;
    const nets = this.wNets[slot];
    const vals = this.wVals[slot];
    const n = this.wLen[slot];
    this.wLen[slot] = 0;
    this.pendingEvents -= n;
    // nothing is scheduled into this slot before evalDirty (delays are 1 … RING − 1)
    const { val, fanStart, fanList, dirtyMark, dq, watched } = this;
    const cap = dq.length;
    const trace = this.anyWatched ? this.onTrace : undefined;
    let len = this.dLen, tail = this.dHead + len;
    if (tail >= cap) tail -= cap;
    for (let i = 0; i < n; i++) {
      const net = nets[i], b = vals[i];
      if (val[net] === b) continue;
      val[net] = b;
      if (trace && watched[net]) trace(net, b as Bit, t);
      for (let f = fanStart[net], e = fanStart[net + 1]; f < e; f++) {
        const li = fanList[f];
        if (dirtyMark[li]) continue;
        dirtyMark[li] = 1;
        dq[tail] = li;
        if (++tail === cap) tail = 0;
        len++;
      }
    }
    this.dLen = len;
    this.evalDirty();
    return true;
  }

  /**
   * Process every event up to and including time t, then stand at t even if events are
   * still pending beyond it (a clock edge that does not wait for the logic to settle).
   */
  runUntil(t: number): void {
    for (;;) {
      if (this.dLen) this.evalDirty();
      if (this.pendingEvents === 0) break;
      let n = this.time + 1;
      while (this.wLen[n % RING] === 0) n++;
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
    if (this.dirtyMark[leaf]) return;
    this.dirtyMark[leaf] = 1;
    let at = this.dHead + this.dLen;
    if (at >= this.dq.length) at -= this.dq.length;
    this.dq[at] = leaf;
    this.dLen++;
  }

  private clearDirty(): void {
    this.dirtyMark.fill(0);
    this.dHead = 0;
    this.dLen = 0;
  }

  /** The dirty leaves in queue order. */
  private dirtyList(): number[] {
    const out: number[] = [];
    for (let i = 0, h = this.dHead; i < this.dLen; i++) {
      out.push(this.dq[h]);
      if (++h === this.dq.length) h = 0;
    }
    return out;
  }

  private evalDirty(): void {
    const n = this.dLen;
    const { val, proj, opA, opB, opY, dq, dirtyMark } = this;
    const cap = dq.length;
    let h = this.dHead;
    this.dHead = h + n >= cap ? h + n - cap : h + n;
    this.dLen = 0;
    // NANDs fire one delay later; nothing marks a leaf dirty while we evaluate
    const slot1 = (this.time + 1) % RING;
    let nets1 = this.wNets[slot1], vals1 = this.wVals[slot1], len1 = this.wLen[slot1];
    let scheduled = 0;
    for (let k = 0; k < n; k++) {
      const li = dq[h];
      if (++h === cap) h = 0;
      dirtyMark[li] = 0;
      const a = opA[li];
      if (a >= 0) {
        const y = NAND_T[(val[a] << 2) | val[opB[li]]];
        const net = opY[li];
        if (proj[net] === y) continue;
        proj[net] = y;
        if (len1 === nets1.length) {
          this.wLen[slot1] = len1;
          this.grow(slot1);
          nets1 = this.wNets[slot1];
          vals1 = this.wVals[slot1];
        }
        nets1[len1] = net;
        vals1[len1++] = y;
        scheduled++;
        continue;
      }
      this.wLen[slot1] = len1;
      scheduled += this.evalBehaviorLeaf(li);
      nets1 = this.wNets[slot1];
      vals1 = this.wVals[slot1];
      len1 = this.wLen[slot1];
    }
    this.wLen[slot1] = len1;
    this.evaluations += n;
    this.pendingEvents += scheduled;
  }

  /** Evaluate a behavioural leaf and schedule its changed outputs; returns how many. */
  private evalBehaviorLeaf(li: number): number {
    const out = this.out;
    this.evalBehavior(li, out);
    const slot = (this.time + this.delay[li]) % RING;
    let scheduled = 0;
    for (let q = this.outStart[li], j = 0; q < this.outStart[li + 1]; q++) {
      const net = this.outList[q], b = out[j++];
      if (this.proj[net] === b) continue;
      this.proj[net] = b;
      if (this.wLen[slot] === this.wNets[slot].length) this.grow(slot);
      const i = this.wLen[slot]++;
      this.wNets[slot][i] = net;
      this.wVals[slot][i] = b;
      scheduled++;
    }
    return scheduled;
  }

  private grow(slot: number): void {
    const n = this.wNets[slot].length * 2;
    const nets = new Int32Array(n), vals = new Uint8Array(n);
    nets.set(this.wNets[slot]);
    vals.set(this.wVals[slot]);
    this.wNets[slot] = nets;
    this.wVals[slot] = vals;
  }

  /** A behavioural leaf's output bits (flattened across its output ports) into `out`. */
  private evalBehavior(li: number, out: Bit[]): void {
    const leaf = this.design.leaves[li];
    const v = this.val;
    const ins = leaf.inputs.map((p) => pack(p.map((net) => v[net])));
    const outs = leaf.def.behavior!.eval(ins, this.state[li]);
    const ops = outPorts(leaf.def);
    let k = 0;
    ops.forEach((p, pi) => {
      for (const b of unpack(outs[pi] ?? -1, p.width)) out[k++] = b;
    });
  }
}

/**
 * Deep copy of plain data (objects, arrays, typed arrays, maps, sets), so the two simulations do
 * not share it. A class instance would lose its prototype in structuredClone: share it instead.
 */
export function cloneState(s: unknown): unknown {
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

interface GateState {
  val: Uint8Array; proj: Uint8Array; state: unknown[]; inputs: Map<string, number | Bit[]>;
  time: number; unstable: boolean; evaluations: number;
  wheelNets: Int32Array[]; wheelVals: Uint8Array[]; pending: number; dirty: number[];
}

function pathOf(l: { node: { path: string[] } }): string {
  return l.node.path.join('.') || '(root)';
}
