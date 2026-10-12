// Switch-level solver for transistor schematics. A MOSFET is modelled as a switch:
// NMOS conducts when its gate is 1, PMOS when its gate is 0. Each node takes the value of
// the rail(s) it is connected to through conducting transistors:
//   VDD only → 1, GND only → 0, both → X (a short: current flows from VDD to GND),
//   neither → Z (floating). A gate driven by X/Z "maybe" conducts, which yields X.
// Nodes feed the gates of other transistors, so we iterate to a fixed point.
//
// Strengths (ratioed logic): a path is as strong as its weakest element (rails and inputs are
// strongest). A node takes the value of its strongest definite path, unless an equally strong or
// stronger path to the opposite value exists or might exist (then X). This is what lets a bit-line
// driver overpower an SRAM cell's weak pull-up. Levels, strongest first:
//   6        rails and driven inputs
//   5, 4, 3  transistors of strength 4 (wide), 3 (default), 2 (narrow)
//   2        resistors (strength 1): always conducting, weaker than any transistor
//   1        stored charge: nets marked `cap` (or with a capacitor) keep their value when undriven
// So a node reached only through a pull-up resistor is 1, any conducting transistor path to GND
// overrides it (pseudo-NMOS, open-drain buses), and two resistors pulling opposite ways give X.
// A short (`shorted`) is a fight between transistor paths; a resistor that loses draws current
// by design (that static current is the cost of ratioed logic) and is not flagged.
// Iteration starts from the previous solution, so storage loops (cross-coupled inverters)
// remember their state; for loop-free circuits the result is unique anyway.
//
// Sources are ideal: rails and driven inputs are terminals, never internal conducting nodes. A
// path ends at a source; it never runs through one from a transistor to another. So one VDD (or
// GND, or input) net shared by many transistors behaves exactly like one rail symbol per
// transistor (a 6T cell with a single VDD writes from X just like the library cell). An input
// driven Z is not a source: it floats, and the circuit may drive it. Root `inout` ports are
// inputs that start undriven (Z) until setInput / setInputBit drives them.

import { matchNets, sharedInputs } from './carry';
import { findNode, type FlatDesign } from './flatten';
import { cloneState } from './gatesim';
import type { PowerOnMode, Sim, SimState } from './sim';
import { B0, B1, BX, BZ, type Bit } from './types';
import { pack, unpack } from './values';

export class SwitchSim implements Sim {
  readonly kind = 'switch' as const;
  readonly design: FlatDesign;
  readonly time = 0;
  unstable = false;
  evaluations = 0;
  onTrace?: (net: number, value: Bit, time: number) => void;

  private val: Uint8Array;
  /**
   * Root input values: a number from setInput (negative: every bit −v, i.e. X or Z), bits from
   * setInputBits (wide values stay exact).
   */
  private inputs = new Map<string, number | Bit[]>();
  private inputNets = new Map<string, number[]>();
  private dirty = true;
  /**
   * Private state of the behavioural leaves (external sources: a key part in a transistor
   * circuit). Their outputs are sources, as strong as rails and driven inputs.
   */
  private state: unknown[];
  private readonly behaviors: number[];
  /** Per leaf: 1 if the transistor conducts (a resistor always does), 2 if it might (gate X/Z), 0 if off. */
  readonly conducting: Uint8Array;
  /** Nets that are part of a VDD–GND short in the last solution. */
  readonly shorted: Uint8Array;

  constructor(design: FlatDesign) {
    this.design = design;
    this.val = new Uint8Array(design.netCount).fill(BZ);
    this.conducting = new Uint8Array(design.leaves.length);
    this.shorted = new Uint8Array(design.netCount);
    this.behaviors = design.leaves.flatMap((l, li) => (l.kind === 'behavior' ? [li] : []));
    this.state = design.leaves.map((l) => l.def.behavior?.init?.());
    for (const p of design.root.def.ports) {
      if (p.dir === 'in') {
        this.inputNets.set(p.name, design.root.ports[p.name]);
        this.inputs.set(p.name, 0);
      } else if (p.dir === 'inout') {
        this.inputNets.set(p.name, design.root.ports[p.name]);
        this.inputs.set(p.name, -BZ);
      }
    }
    this.settle();
  }

  get(net: number): Bit {
    return this.val[net] as Bit;
  }
  getBits(nets: readonly number[]): Bit[] {
    return nets.map((n) => this.val[n] as Bit);
  }
  getInput(port: string): number {
    const v = this.inputs.get(port) ?? 0;
    if (typeof v === 'number') return v;
    return v.every((b) => b === v[0]) && v[0] !== B0 && v[0] !== B1 ? -v[0] : pack(v);
  }
  getInputBits(port: string): Bit[] {
    return this.inputBits(port, this.inputs.get(port) ?? 0);
  }
  private inputBits(port: string, v: number | Bit[]): Bit[] {
    const w = this.inputNets.get(port)?.length ?? 0;
    return typeof v !== 'number' ? v.slice() : v >= 0 ? unpack(v, w) : new Array<Bit>(w).fill((-v) as Bit);
  }
  setInputBits(port: string, bits: ArrayLike<number>): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    this.inputs.set(port, nets.map((_, i) => (bits[i] ?? BZ) as Bit));
    this.dirty = true;
  }
  setInput(port: string, value: number): void {
    if (!this.inputNets.has(port)) throw new Error(`no input port '${port}'`);
    this.inputs.set(port, value);
    this.dirty = true;
  }
  /** Drive an input with an explicit bit, including X or Z (used for "what if" demos). */
  setInputBit(port: string, b: Bit): void {
    this.inputs.set(port, b === B0 ? 0 : b === B1 ? 1 : -(b as number));
    this.dirty = true;
  }
  watch(): void {}
  poke(leaf: number, state: unknown): void {
    this.state[leaf] = state;
    this.dirty = true;
  }
  leafState(leaf: number): unknown {
    return this.state[leaf];
  }
  busy(): boolean {
    return this.dirty;
  }
  reset(mode?: PowerOnMode): void {
    this.state = this.design.leaves.map((l) => l.def.behavior?.init?.(mode));
    this.dirty = true;
    this.settle();
  }
  /**
   * Take over the node values of a simulation of a previous version of the design: nets matched
   * through the hierarchy (see matchNets), root inputs by port name and width. The solve starts
   * from them, so cross-coupled inverters keep their bit and `cap` nets keep their charge. With
   * `known`, X nodes of `prev` are not copied.
   */
  carry(prev: Sim, opts: { known?: boolean } = {}): void {
    for (const name of sharedInputs(this.design, prev.design)) this.inputs.set(name, prev.getInputBits(name));
    // root inouts too (only a switch-level simulation drives them)
    for (const p of this.design.root.def.ports) {
      const q = p.dir === 'inout' && prev.kind === 'switch' && prev.design.root.def.ports.find((x) => x.name === p.name);
      if (q && q.dir === 'inout' && q.width === p.width) this.inputs.set(p.name, prev.getInputBits(p.name));
    }
    const map = matchNets(this.design, prev.design);
    for (let net = 0; net < map.length; net++) {
      if (map[net] < 0) continue;
      const b = prev.get(map[net]);
      if (!opts.known || b !== BX) this.val[net] = b;
    }
    // behavioural leaves at the same path with the same definition keep their state (a held key)
    for (const li of this.behaviors) {
      const l = this.design.leaves[li];
      const o = findNode(prev.design.root, l.node.path);
      if (o?.leafIndex === undefined || o.def.id !== l.def.id) continue;
      const s = prev.leafState(o.leafIndex), c = l.def.behavior!.carry;
      this.state[li] = c && s !== undefined ? c(s, !!opts.known) : cloneState(s);
    }
    this.dirty = true;
    this.settle();
  }

  saveState(): SimState {
    const st: SwitchState = {
      val: this.val.slice(), conducting: this.conducting.slice(), shorted: this.shorted.slice(),
      inputs: new Map([...this.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v])),
      state: this.state.map(cloneState),
      unstable: this.unstable, evaluations: this.evaluations, dirty: this.dirty,
    };
    return st as unknown as SimState;
  }

  restoreState(saved: SimState): void {
    const s = saved as unknown as SwitchState;
    this.val.set(s.val);
    this.conducting.set(s.conducting);
    this.shorted.set(s.shorted);
    this.inputs = new Map([...s.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
    this.state = s.state.map(cloneState);
    this.unstable = s.unstable;
    this.evaluations = s.evaluations;
    this.dirty = s.dirty;
  }

  /** A copy of every node value (index = flat net). */
  snapshot(): Uint8Array {
    return this.val.slice();
  }

  /**
   * Overwrite node values (as if the circuit had been left in that state: storage loops and
   * charge start from them). Inputs and rails still win at the next settle().
   */
  restore(vals: ArrayLike<number>): void {
    for (let i = 0; i < this.val.length; i++) this.val[i] = vals[i];
    this.dirty = true;
  }

  step(): boolean {
    if (!this.dirty) return false;
    this.settle();
    return false;
  }

  settle(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.design.netCount;
    const leaves = this.design.leaves;

    // Strong sources: rails and driven inputs.
    const source = new Int8Array(n).fill(-1);
    for (const l of leaves) {
      if (l.kind === 'vdd') source[l.terminals![0]] = B1;
      else if (l.kind === 'gnd') source[l.terminals![0]] = B0;
    }
    for (const [port, v] of this.inputs) {
      const nets = this.inputNets.get(port)!;
      const bits = this.inputBits(port, v);
      nets.forEach((net, i) => { if (bits[i] !== BZ) source[net] = bits[i]; });
    }
    if (!this.behaviors.length) return this.solve(source);

    // Behavioural leaves drive their outputs as sources too. One whose outputs depend on its
    // inputs is re-evaluated on the solution until nothing changes (a few rounds at most).
    let outs = this.behaviorOutputs();
    this.unstable = false;
    for (let round = 0; ; round++) {
      const src = source.slice();
      for (const [net, b] of outs) src[net] = b;
      const was: boolean = this.unstable;
      this.solve(src);
      this.unstable ||= was;
      const next = this.behaviorOutputs();
      if (round >= 8 || [...next].every(([net, b]) => outs.get(net) === b)) {
        if (round >= 8) this.unstable = true;
        return;
      }
      outs = next;
    }
  }

  /** Output bits of every behavioural leaf for the node values now (X when a packed input has X / Z). */
  private behaviorOutputs(): Map<number, Bit> {
    const out = new Map<number, Bit>();
    for (const li of this.behaviors) {
      const l = this.design.leaves[li];
      const ins = l.inputs.map((p) => pack(p.map((net) => this.val[net])));
      const res = l.def.behavior!.eval(ins, this.state[li]);
      this.evaluations++;
      l.outputs.forEach((p, pi) => unpack(res[pi] ?? -1, p.length).forEach((b, i) => out.set(p[i], b)));
    }
    return out;
  }

  /** One solve of the node values from the given sources (−1: not a source). */
  private solve(source: Int8Array): void {
    const n = this.design.netCount;
    const leaves = this.design.leaves;
    const val = this.val;
    for (let i = 0; i < n; i++) if (source[i] >= 0) val[i] = source[i];
    // stored charge: the value a capacitive net had before this solve
    const charge = new Int8Array(n).fill(-1);
    for (const c of this.design.caps) if (source[c] < 0 && (val[c] === B0 || val[c] === B1)) charge[c] = val[c];

    // Sources are terminals, never conducting nodes: every transistor terminal on a rail or a driven
    // input gets its own copy of that source (a virtual node n, n + 1, …), so paths cannot pass
    // through a source from one transistor to another. One VDD symbol feeding many pull-ups then
    // behaves exactly like one symbol per transistor.
    const srcLv: number[] = [], srcV: number[] = [];
    for (let i = 0; i < n; i++) {
      srcLv.push(charge[i] >= 0 ? LV_CHARGE : 0);
      srcV.push(charge[i]);
    }
    const term = (net: number) => {
      if (source[net] < 0) return net;
      srcLv.push(LV_SOURCE);
      srcV.push(source[net]);
      return srcLv.length - 1;
    };
    // Conducting elements: transistors (switched by their gate) and resistors (always on).
    const fets: { li: number; g: number; a: number; b: number; nmos: boolean; s: number }[] = [];
    const ress: { a: number; b: number; s: number }[] = [];
    leaves.forEach((l, li) => {
      if (l.kind === 'res') {
        const [a, b] = l.terminals!;
        ress.push({ a: term(a), b: term(b), s: level(l.def.strength ?? 1) });
        this.conducting[li] = 1;
        return;
      }
      if (l.kind !== 'nmos' && l.kind !== 'pmos') return;
      const [g, a, b] = l.terminals!;
      fets.push({ li, g, a: term(a), b: term(b), nmos: l.kind === 'nmos', s: level(l.def.strength ?? 3) });
    });
    const N = srcLv.length;

    let iter = 0;
    let changed = true;
    while (changed && iter < 64) {
      iter++;
      changed = false;
      this.evaluations++;
      // conduction state from the current gate values
      const on = new Uint8Array(fets.length), maybeOn = new Uint8Array(fets.length);
      fets.forEach((f, k) => {
        const gv = val[f.g];
        const o = f.nmos ? gv === B1 : gv === B0, off = f.nmos ? gv === B0 : gv === B1;
        this.conducting[f.li] = o ? 1 : off ? 0 : 2;
        on[k] = o ? 1 : 0;
        maybeOn[k] = off ? 0 : 1;
      });
      // Strongest definite / possible path from a 1, a 0 or an X source, per node (levels: see
      // the header).
      const d1 = new Uint8Array(n), d0 = new Uint8Array(n), dX = new Uint8Array(n);
      const m1 = new Uint8Array(n), m0 = new Uint8Array(n), mX = new Uint8Array(n);
      for (let L = LV_SOURCE; L >= LV_CHARGE; L--) {
        const sure = new UF(N), maybe = new UF(N);
        fets.forEach((f, k) => {
          if (f.s < L) return;
          if (on[k]) sure.union(f.a, f.b);
          if (maybeOn[k]) maybe.union(f.a, f.b);
        });
        for (const r of ress) {
          if (r.s < L) continue;
          sure.union(r.a, r.b);
          maybe.union(r.a, r.b);
        }
        const sHi = new Uint8Array(N), sLo = new Uint8Array(N), sX = new Uint8Array(N);
        const mHi = new Uint8Array(N), mLo = new Uint8Array(N), mXx = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
          if (srcLv[i] < L) continue;
          const v = srcV[i], rs = sure.find(i), rm = maybe.find(i);
          if (v === B1) { sHi[rs] = 1; mHi[rm] = 1; } else if (v === B0) { sLo[rs] = 1; mLo[rm] = 1; } else { sX[rs] = 1; mXx[rm] = 1; }
        }
        for (let i = 0; i < n; i++) {
          const rs = sure.find(i), rm = maybe.find(i);
          if (sHi[rs] && !d1[i]) d1[i] = L;
          if (sLo[rs] && !d0[i]) d0[i] = L;
          if (sX[rs] && !dX[i]) dX[i] = L;
          if (mHi[rm] && !m1[i]) m1[i] = L;
          if (mLo[rm] && !m0[i]) m0[i] = L;
          if (mXx[rm] && !mX[i]) mX[i] = L;
        }
      }
      for (let i = 0; i < n; i++) {
        if (source[i] >= 0) { this.shorted[i] = 0; continue; }
        let v: number;
        const best = Math.max(d1[i], d0[i]);
        if (dX[i] && dX[i] >= best) v = BX;
        else if (d1[i] > d0[i] && d1[i] > m0[i] && d1[i] > mX[i]) v = B1;
        else if (d0[i] > d1[i] && d0[i] > m1[i] && d0[i] > mX[i]) v = B0;
        else v = m1[i] || m0[i] || mX[i] ? BX : BZ;
        // current flows from a rail to the other through conducting transistors
        this.shorted[i] = d1[i] >= LV_FET && d0[i] >= LV_FET ? 1 : 0;
        if (val[i] !== v) {
          val[i] = v;
          changed = true;
        }
      }
    }
    this.unstable = changed;
  }
}

/** Solver levels (see the header): sources, the weakest transistor, stored charge. */
const LV_SOURCE = 6, LV_FET = 3, LV_CHARGE = 1;
/** Level of a conducting element of strength s (1 = resistor … 4 = wide transistor). */
const level = (s: number) => Math.min(LV_SOURCE - 1, Math.max(LV_CHARGE + 1, Math.round(s) + 1));

class UF {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(x: number): number {
    const p = this.p;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

interface SwitchState {
  val: Uint8Array; conducting: Uint8Array; shorted: Uint8Array; inputs: Map<string, number | Bit[]>; state: unknown[];
  unstable: boolean; evaluations: number; dirty: boolean;
}
