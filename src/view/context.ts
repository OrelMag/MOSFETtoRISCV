// A ViewCtx is "this component, as seen inside that simulation". Opening a child either
// reuses the same simulation (the child was expanded when flattening) or starts a lock-step
// sub-simulation of the child's structure driven by the parent's current port values
// (e.g. a NAND that is a primitive at gate level opens onto its four transistors).

import { flatten, type HierNode } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import type { Sim } from '../sim/sim';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, type Bit, type ComponentDef, netlistOf } from '../sim/types';
import { pack } from '../sim/values';

export class ViewCtx {
  readonly sim: Sim;
  readonly node: HierNode;
  readonly parent: ViewCtx | null;
  /** For sub-simulations: the node in the parent simulation that drives this one. */
  private readonly driver: HierNode | null;
  /** Instance names from the scene root. */
  readonly path: string[];
  private children = new Map<string, ViewCtx>();

  constructor(sim: Sim, node: HierNode, parent: ViewCtx | null = null, driver: HierNode | null = null, name = '') {
    this.sim = sim;
    this.node = node;
    this.parent = parent;
    this.driver = driver;
    this.path = parent ? [...parent.path, name] : [];
  }

  get def(): ComponentDef {
    return this.node.def;
  }

  get isSubSim(): boolean {
    return this.driver !== null;
  }

  /** Can this child be opened? (Has an inside, or is a transistor with its own explainer.) */
  canOpen(childName: string): boolean {
    const c = this.node.children?.get(childName);
    if (!c) return false;
    return c.expanded || !!netlistOf(c.def) || c.def.prim === 'nmos' || c.def.prim === 'pmos';
  }

  child(name: string): ViewCtx | null {
    const hit = this.children.get(name);
    if (hit) return hit;
    const c = this.node.children?.get(name);
    if (!c) return null;
    let ctx: ViewCtx;
    if (c.expanded) {
      ctx = new ViewCtx(this.sim, c, this, null, name);
    } else {
      const nl = netlistOf(c.def);
      if (!nl) return null;
      const mode = nl.level === 'switch' ? 'switch' : 'gate';
      const design = flatten(c.def, { mode });
      const sub = mode === 'switch' ? new SwitchSim(design) : new GateSim(design);
      ctx = new ViewCtx(sub, design.root, this, c, name);
    }
    this.children.set(name, ctx);
    ctx.sync();
    return ctx;
  }

  /** Pull input values from the parent simulation (sub-simulations only), then settle. */
  sync(): void {
    if (!this.parent) return;
    this.parent.sync();
    if (!this.driver) return;
    for (const p of this.def.ports) {
      if (p.dir !== 'in') continue;
      const bits = this.parent.sim.getBits(this.driver.ports[p.name]);
      if (this.sim instanceof SwitchSim && p.width === 1) this.sim.setInputBit(p.name, bits[0]);
      else this.sim.setInput(p.name, Math.max(0, pack(bits)));
    }
    this.sim.settle();
  }

  netBits(netIndex: number): Bit[] {
    const nets = this.node.nets?.[netIndex];
    return nets ? this.sim.getBits(nets) : [];
  }

  portBits(port: string): Bit[] {
    return this.sim.getBits(this.node.ports[port]);
  }

  /** Leaf index of a child in this simulation, if it is a leaf here. */
  childLeaf(name: string): number | undefined {
    return this.node.children?.get(name)?.leafIndex;
  }

  /** For transistor drill-down: the gate value of a transistor child. */
  transistorGate(name: string): Bit {
    const c = this.node.children?.get(name);
    if (!c) return B0;
    return this.sim.getBits(c.ports.g)[0] ?? B0;
  }
}

export function bitIsHigh(b: Bit): boolean {
  return b === B1;
}
