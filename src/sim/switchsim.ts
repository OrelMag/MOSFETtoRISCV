// Switch-level solver for transistor schematics. A MOSFET is modelled as a switch:
// NMOS conducts when its gate is 1, PMOS when its gate is 0. Each node takes the value of
// the rail(s) it is connected to through conducting transistors:
//   VDD only → 1, GND only → 0, both → X (a short: current flows from VDD to GND),
//   neither → Z (floating). A gate driven by X/Z "maybe" conducts, which yields X.
// Nodes feed the gates of other transistors, so we iterate to a fixed point.

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
    for (let i = 0; i < n; i++) val[i] = source[i] >= 0 ? source[i] : BZ;

    let iter = 0;
    let changed = true;
    while (changed && iter < 64) {
      iter++;
      changed = false;
      this.evaluations++;
      const sure = new UF(n);
      const maybe = new UF(n);
      leaves.forEach((l, li) => {
        if (l.kind !== 'nmos' && l.kind !== 'pmos') return;
        const [g, a, b] = l.terminals!;
        const gv = val[g];
        const on = l.kind === 'nmos' ? gv === B1 : gv === B0;
        const off = l.kind === 'nmos' ? gv === B0 : gv === B1;
        this.conducting[li] = on ? 1 : off ? 0 : 2;
        if (on) sure.union(a, b);
        if (!off) maybe.union(a, b);
      });
      // Which rails reach each component.
      const sureHi = new Uint8Array(n), sureLo = new Uint8Array(n), sureX = new Uint8Array(n);
      const mayHi = new Uint8Array(n), mayLo = new Uint8Array(n), mayX = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = source[i];
        if (s < 0) continue;
        const rs = sure.find(i), rm = maybe.find(i);
        if (s === B1) { sureHi[rs] = 1; mayHi[rm] = 1; }
        else if (s === B0) { sureLo[rs] = 1; mayLo[rm] = 1; }
        else { sureX[rs] = 1; mayX[rm] = 1; }
      }
      for (let i = 0; i < n; i++) {
        if (source[i] >= 0) { this.shorted[i] = 0; continue; }
        const rs = sure.find(i), rm = maybe.find(i);
        const hi = sureHi[rs], lo = sureLo[rs];
        let v: number;
        if (sureX[rs] || (hi && lo)) v = BX;
        else if (hi) v = mayLo[rm] || mayX[rm] ? BX : B1;
        else if (lo) v = mayHi[rm] || mayX[rm] ? BX : B0;
        else v = mayHi[rm] || mayLo[rm] || mayX[rm] ? BX : BZ;
        this.shorted[i] = hi && lo ? 1 : 0;
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
