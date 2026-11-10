// Dynamic delay: how long after an input change do the outputs stop changing? Unlike static depth
// (the longest path in the netlist), this follows only paths that a transition actually sensitizes,
// so a false path (one that can never carry the last change) does not count.

import { onTick } from './edge';
import { flatten } from './flatten';
import { GateSim } from './gatesim';
import type { ComponentDef } from './types';
import { inPorts, outPorts } from './types';

/**
 * Worst time (gate delays) from applying each vector to the last output change, over consecutive vectors. `model` 'load'
 * times each NAND by what it drives (sim/delay.ts), in tenths of a unit; 'unit' (the default) is one delay per gate.
 */
export function outputSettle(def: ComponentDef, vectors: number[][], model: 'unit' | 'load' = 'unit'): { worst: number; from: number[]; to: number[] } {
  const sim = new GateSim(flatten(def), { delay: model });
  const outs = outPorts(def).flatMap((p) => sim.design.root.ports[p.name]);
  sim.watch(outs);
  let last = 0;
  sim.onTrace = (_net, _b, t) => { last = t; };
  const ins = inPorts(def);
  const apply = (v: number[]) => ins.forEach((p, i) => sim.setInput(p.name, v[i]));
  apply(vectors[0]);
  sim.settle();
  let worst = 0, from = vectors[0], to = vectors[0];
  for (let i = 1; i < vectors.length; i++) {
    const t0 = sim.time;
    last = t0;
    apply(vectors[i]);
    sim.settle();
    const d = onTick(sim, last - t0);
    if (d > worst) { worst = d; from = vectors[i - 1]; to = vectors[i]; }
  }
  return { worst, from, to };
}
