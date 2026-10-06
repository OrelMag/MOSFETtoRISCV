// A small netlist builder for blocks best read by drilling into their sub-units: instances are
// added in columns (left to right as data flows) and nets are collected per driver, so a
// component can be written as a sequence of operations. Nets with several sinks, or driven by a
// component pin, are drawn as labels. (fpu.ts has its own copy of this class.)

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef } from '../sim/types';

export class Builder {
  instances: InstanceDef[] = [];
  private sinks = new Map<string, string[]>();
  private names = new Map<string, string>();
  private y = 0;
  private colW = 0;
  private x: number;
  private n = 0;
  constructor(x0 = 10, private gap = 12) {
    this.x = x0;
  }
  /** Start a new column. */
  next(): void {
    if (this.y === 0) return;
    this.x += this.colW + this.gap;
    this.y = 0;
    this.colW = 0;
  }
  add(def: ComponentDef, label?: string, name?: string): string {
    const nm = name ?? `u${this.n++}`;
    const g = symbolGeom(def);
    this.instances.push({ name: nm, def, at: [this.x, this.y + 2], label });
    this.y += g.h + 4;
    this.colW = Math.max(this.colW, g.w);
    return nm;
  }
  /** Connect a driver ("inst.port" or a component pin) to a sink. */
  wire(drv: string, sink: string): void {
    if (!this.sinks.has(drv)) this.sinks.set(drv, []);
    this.sinks.get(drv)!.push(sink);
  }
  private tagged = new Set<string>();
  /** Name a driver's net; tag = draw it as labels (for long or feedback nets). */
  name(drv: string, n: string, tag = false): string {
    this.names.set(drv, n);
    if (tag) this.tagged.add(drv);
    return drv;
  }
  /** Instantiate def and wire its inputs (in port order) from drivers; returns the instance name. */
  op(def: ComponentDef, inputs: string[], label?: string, name?: string): string {
    const nm = this.add(def, label, name);
    const ins = def.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    inputs.forEach((d, i) => d && this.wire(d, `${nm}.${ins[i]}`)); // '' = wired later
    return nm;
  }
  /** Single-output helper: returns "inst.out". */
  op1(def: ComponentDef, inputs: string[], label?: string, name?: string): string {
    const nm = this.op(def, inputs, label, name);
    return `${nm}.${def.ports.find((p) => p.dir === 'out')!.name}`;
  }
  get right(): number { return this.x + this.colW + this.gap; }
  get height(): number { return Math.max(...this.instances.map((i) => (i.at![1] + symbolGeom(i.def).h))); }
  nets(): NetDef[] {
    const out: NetDef[] = [];
    for (const [d, ss] of this.sinks) out.push({ name: this.names.get(d), ends: [d, ...ss], tags: ss.length > 1 || !d.includes('.') || this.tagged.has(d) ? true : undefined });
    return out;
  }
}
