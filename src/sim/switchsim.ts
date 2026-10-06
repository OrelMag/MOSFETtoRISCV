// Switch-level solver for transistor schematics. A MOSFET is modelled as a switch:
// NMOS conducts when its gate is 1, PMOS when its gate is 0. Each node takes the value of
// the rail(s) it is connected to through conducting transistors:
//   VDD only → 1, GND only → 0, both → X (a short: current flows from VDD to GND),
//   neither → Z (floating). A gate driven by X/Z "maybe" conducts, which yields X.
// Nodes feed the gates of other transistors, so we iterate to a fixed point.
//
// Strengths (ratioed logic): a path is as strong as its weakest transistor (rails and inputs are
// strongest). A node takes the value of its strongest definite path, unless an equally strong or
// stronger path to the opposite value exists or might exist (then X). This is what lets a bit-line
// driver overpower an SRAM cell's weak pull-up. Nets marked `cap` keep their charge (weakest of all)
// when undriven. Iteration starts from the previous solution, so storage loops (cross-coupled
// inverters) remember their state; for loop-free circuits the result is unique anyway.
//
// Sources are ideal: rails and driven inputs are terminals, never internal conducting nodes. A
// path ends at a source; it never runs through one from a transistor to another. So one VDD (or
// GND, or input) net shared by many transistors behaves exactly like one rail symbol per
// transistor (a 6T cell with a single VDD writes from X just like the library cell). An input
// driven Z is not a source: it floats, and the circuit may drive it. Root `inout` ports are
// inputs that start undriven (Z) until setInput / setInputBit drives them.

import { matchNets, sharedInputs } from './carry';
import type { FlatDesign } from './flatten';
import type { PowerOnMode, Sim } from './sim';
import { B0, B1, BX, BZ, type Bit } from './types';
import { unpack } from './values';

export class SwitchSim implements Sim {
  readonly kind = 'switch' as const;
  readonly design: FlatDesign;
  readonly time = 0;
  unstable = false;
  evaluations = 0;
  onTrace?: (net: number, value: Bit, time: number) => void;

  private val: Uint8Array;
  private inputs = new Map<string, number>();
  private inputNets = new Map<string, number[]>();
  private dirty = true;
  /** Per leaf: 1 if the transistor conducts, 2 if it might (gate X/Z), 0 if off. */
  readonly conducting: Uint8Array;
  /** Nets that are part of a VDD–GND short in the last solution. */
  readonly shorted: Uint8Array;

  constructor(design: FlatDesign) {
    this.design = design;
    this.val = new Uint8Array(design.netCount).fill(BZ);
    this.conducting = new Uint8Array(design.leaves.length);
    this.shorted = new Uint8Array(design.netCount);
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
    return this.inputs.get(port) ?? 0;
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
  busy(): boolean {
    return this.dirty;
  }
  reset(_mode?: PowerOnMode): void {
    this.dirty = true;
    this.settle();
  }
  /**
   * Take over the node values of a simulation of a previous version of the design: nets matched
   * through the hierarchy (see matchNets), root inputs by port name and width. The solve starts
   * from them, so cross-coupled inverters keep their bit and `cap` nets keep their charge.
   */
  carry(prev: Sim): void {
    for (const name of sharedInputs(this.design, prev.design)) this.inputs.set(name, prev.getInput(name));
    // root inouts too (only a switch-level simulation drives them)
    for (const p of this.design.root.def.ports) {
      const q = p.dir === 'inout' && prev.kind === 'switch' && prev.design.root.def.ports.find((x) => x.name === p.name);
      if (q && q.dir === 'inout' && q.width === p.width) this.inputs.set(p.name, prev.getInput(p.name));
    }
    const map = matchNets(this.design, prev.design);
    for (let net = 0; net < map.length; net++) if (map[net] >= 0) this.val[net] = prev.get(map[net]);
    this.dirty = true;
    this.settle();
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
      const bits: Bit[] = v >= 0 ? unpack(v, nets.length) : nets.map(() => (-v) as Bit);
      nets.forEach((net, i) => { if (bits[i] !== BZ) source[net] = bits[i]; });
    }

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
      srcLv.push(charge[i] >= 0 ? 1 : 0);
      srcV.push(charge[i]);
    }
    const term = (net: number) => {
      if (source[net] < 0) return net;
      srcLv.push(5);
      srcV.push(source[net]);
      return srcLv.length - 1;
    };
    const fets: { li: number; g: number; a: number; b: number; nmos: boolean; s: number }[] = [];
    leaves.forEach((l, li) => {
      if (l.kind !== 'nmos' && l.kind !== 'pmos') return;
      const [g, a, b] = l.terminals!;
      fets.push({ li, g, a: term(a), b: term(b), nmos: l.kind === 'nmos', s: l.def.strength ?? 3 });
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
      // Strongest definite / possible path from a 1, a 0 or an X source, per node. Levels:
      // 5 = rails and inputs, 4..2 = transistors, 1 = stored charge.
      const d1 = new Uint8Array(n), d0 = new Uint8Array(n), dX = new Uint8Array(n);
      const m1 = new Uint8Array(n), m0 = new Uint8Array(n), mX = new Uint8Array(n);
      for (let L = 5; L >= 1; L--) {
        const sure = new UF(N), maybe = new UF(N);
        fets.forEach((f, k) => {
          if (f.s < L) return;
          if (on[k]) sure.union(f.a, f.b);
          if (maybeOn[k]) maybe.union(f.a, f.b);
        });
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
        this.shorted[i] = d1[i] >= 2 && d0[i] >= 2 ? 1 : 0;
        if (val[i] !== v) {
          val[i] = v;
          changed = true;
        }
      }
    }
    this.unstable = changed;
  }
}

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
