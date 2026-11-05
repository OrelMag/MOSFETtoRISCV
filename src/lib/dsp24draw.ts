// Hand placement for the DSP core's drawings: instances at grid positions, found from the symbols' port positions.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef } from '../sim/types';

export class Sheet {
  private at = new Map<string, [number, number]>();
  private defs = new Map<string, ComponentDef>();
  private labels = new Map<string, string | undefined>();
  /** Instance `name` of `def` with its top-left corner at (x, y). */
  place(name: string, def: ComponentDef, x: number, y: number, label?: string): string {
    this.at.set(name, [x, y]);
    this.defs.set(name, def);
    this.labels.set(name, label);
    return name;
  }
  /** Place so that `port` lands on row y (x is the left edge). */
  alignY(name: string, def: ComponentDef, x: number, port: string, y: number, label?: string): string {
    return this.place(name, def, x, y - symbolGeom(def).ports[port].pos[1], label);
  }
  /** Place so that `port` lands on column x (y is the top edge). */
  alignX(name: string, def: ComponentDef, port: string, x: number, y: number, label?: string): string {
    return this.place(name, def, x - symbolGeom(def).ports[port].pos[0], y, label);
  }
  /** Absolute position of an instance's port. */
  P(inst: string, port: string): [number, number] {
    const a = this.at.get(inst)!;
    const p = symbolGeom(this.defs.get(inst)!).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  }
  /** Right edge of an instance. */
  R(inst: string): number { return this.at.get(inst)![0] + symbolGeom(this.defs.get(inst)!).w; }
  /** Bottom edge of an instance. */
  B(inst: string): number { return this.at.get(inst)![1] + symbolGeom(this.defs.get(inst)!).h; }
  instances(): InstanceDef[] {
    return [...this.at.keys()].map((name) => ({ name, def: this.defs.get(name)!, at: this.at.get(name), label: this.labels.get(name) }));
  }
}
