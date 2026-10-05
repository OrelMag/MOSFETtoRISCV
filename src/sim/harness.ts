// Convenience wrappers to simulate a component in isolation. Used by tests, truth tables
// and the workbench.

import { flatten } from './flatten';
import { GateSim } from './gatesim';
import type { Sim } from './sim';
import { SwitchSim } from './switchsim';
import { type ComponentDef, inPorts, netlistOf, outPorts } from './types';
import { pack } from './values';

/** Does this component only make sense at switch level (contains transistors)? */
export function needsSwitchLevel(def: ComponentDef): boolean {
  if (def.prim === 'nmos' || def.prim === 'pmos' || def.prim === 'vdd' || def.prim === 'gnd') return true;
  // Anything whose own inside is transistors (including the NAND primitive) is shown at switch level.
  const nl = netlistOf(def);
  return !!nl && nl.level === 'switch';
}

export function simulate(def: ComponentDef, level: 'gate' | 'switch' = needsSwitchLevel(def) ? 'switch' : 'gate'): Sim {
  const design = flatten(def, { mode: level });
  return level === 'switch' ? new SwitchSim(design) : new GateSim(design);
}

/** Apply inputs (packed per input port, in port order), settle, return packed outputs (-1 = X/Z). */
export function evalOnce(sim: Sim, inputs: number[]): number[] {
  const def = sim.design.root.def;
  inPorts(def).forEach((p, i) => sim.setInput(p.name, inputs[i]));
  sim.settle();
  return outPorts(def).map((p) => pack(sim.getBits(sim.design.root.ports[p.name])));
}

export function inputBits(def: ComponentDef): number {
  return inPorts(def).reduce((a, p) => a + p.width, 0);
}

/** Enumerate every input combination (callback gets packed inputs per port). */
export function forEachInput(def: ComponentDef, fn: (inputs: number[]) => void): void {
  const ps = inPorts(def);
  const total = inputBits(def);
  for (let v = 0; v < 2 ** total; v++) {
    let rest = v;
    const ins: number[] = [];
    // First port is the most significant group (reads naturally in a truth table).
    for (let i = ps.length - 1; i >= 0; i--) {
      const w = ps[i].width;
      ins[i] = rest % 2 ** w;
      rest = Math.floor(rest / 2 ** w);
    }
    fn(ins);
  }
}
