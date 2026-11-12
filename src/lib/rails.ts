// Literal rails for two-level logic drawn the textbook way (PLA, sum of minterms): every input as a true and a complement line
// running down beside the gates that use them. The rails are vertical trunks of ordinary nets (NetDef.trunk), so each tap is a
// plain wire from its rail to a gate input; the crossings with the other rails are regular, as in a PLA drawing. Wires, no pointers.

import { NOT } from './gates';
import type { InstanceDef, NetDef } from '../sim/types';

export interface RailInput {
  /** Driver of the true rail: a pin name or "inst.port". */
  src: string;
  /** y (grid units) of that driver's pin: a pin drives straight right from its own height. */
  y: number;
  /** Net names of the true and the complement rail. */
  name: string;
  /** The inverter's instance name; none: the complement is not used and nothing is drawn for it. */
  not?: string;
}

/**
 * One group per input, left to right: the true rail, an inverter, the complement rail. The groups are ordered by the height of
 * their drivers, the lowest driver leftmost, so a driver's wire to its rail never crosses the rail of another group (the rails
 * hang down from their drivers like a staircase).
 */
export class LiteralRails {
  readonly instances: InstanceDef[] = [];
  /** Rail x per input index: [true, complement]. */
  readonly xs: [number, number][];
  /** x just right of the last rail. */
  readonly right: number;
  private readonly sinks: string[][][];

  constructor(private readonly ins: RailInput[], x0: number, yNot: number) {
    const order = ins.map((_, i) => i).sort((a, b) => ins[b].y - ins[a].y);
    this.xs = ins.map(() => [0, 0]);
    order.forEach((i, g) => {
      const xt = x0 + 7 * g;
      this.xs[i] = [xt, xt + 5];
      const nm = ins[i].not;
      if (nm) this.instances.push({ name: nm, def: NOT, at: [xt + 1, yNot] });
    });
    this.right = x0 + 7 * ins.length - 1;
    this.sinks = ins.map(() => [[], []]);
  }

  /** Rail i (value 1: the true line, 0: the complement) feeds this gate input ("inst.port"). */
  use(i: number, value: 0 | 1, end: string): void {
    this.sinks[i][value ? 0 : 1].push(end);
  }

  /** The x of rail i. */
  x(i: number, value: 0 | 1): number {
    return this.xs[i][value ? 0 : 1];
  }

  nets(): NetDef[] {
    const out: NetDef[] = [];
    this.ins.forEach((r, i) => {
      const [t, c] = this.sinks[i];
      out.push({ name: r.name, ends: [r.src, ...(r.not ? [`${r.not}.a`] : []), ...t], trunk: this.xs[i][0] });
      if (c.length && r.not) out.push({ name: `${r.name}′`, ends: [`${r.not}.y`, ...c], trunk: this.xs[i][1] });
    });
    return out;
  }
}
