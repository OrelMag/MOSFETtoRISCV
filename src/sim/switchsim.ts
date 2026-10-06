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
      nets.forEach((net, i) => (source[net] = bits[i]));
    }

    const val = this.val;
    for (let i = 0; i < n; i++) if (source[i] >= 0) val[i] = source[i];
    // stored charge: the value a capacitive net had before this solve
    const charge = new Int8Array(n).fill(-1);
    for (const c of this.design.caps) if (source[c] < 0 && (val[c] === B0 || val[c] === B1)) charge[c] = val[c];

    const fets: { li: number; g: number; a: number; b: number; nmos: boolean; s: number }[] = [];
    leaves.forEach((l, li) => {
      if (l.kind !== 'nmos' && l.kind !== 'pmos') return;
      const [g, a, b] = l.terminals!;
      fets.push({ li, g, a, b, nmos: l.kind === 'nmos', s: l.def.strength ?? 3 });
    });

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
      const srcLevel = (i: number) => (source[i] >= 0 ? 5 : charge[i] >= 0 ? 1 : 0);
      const srcVal = (i: number) => (source[i] >= 0 ? source[i] : charge[i]);
      for (let L = 5; L >= 1; L--) {
        const sure = new UF(n), maybe = new UF(n);
        fets.forEach((f, k) => {
          if (f.s < L) return;
          if (on[k]) sure.union(f.a, f.b);
          if (maybeOn[k]) maybe.union(f.a, f.b);
        });
        const sHi = new Uint8Array(n), sLo = new Uint8Array(n), sX = new Uint8Array(n);
        const mHi = new Uint8Array(n), mLo = new Uint8Array(n), mXx = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          if (srcLevel(i) < L) continue;
          const v = srcVal(i), rs = sure.find(i), rm = maybe.find(i);
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
