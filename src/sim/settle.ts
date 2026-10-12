// Dynamic delay: how long after an input change do the outputs stop changing? Unlike static depth
// (the longest path in the netlist), this follows only paths that a transition actually sensitizes,
// so a false path (one that can never carry the last change) does not count.

import { flatten } from './flatten';
import { GateSim } from './gatesim';
import type { ComponentDef } from './types';
import { inPorts, outPorts } from './types';

/** Worst time (gate delays) from applying each vector to the last output change, over consecutive vectors. */
export function outputSettle(def: ComponentDef, vectors: number[][]): { worst: number; from: number[]; to: number[] } {
  const sim = new GateSim(flatten(def));
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
    if (last - t0 > worst) { worst = last - t0; from = vectors[i - 1]; to = vectors[i]; }
  }
  return { worst, from, to };
}
