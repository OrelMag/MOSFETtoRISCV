// Sensitized delay of selected outputs (DOM-free): like settle.ts outputSettle, but only the named ports count, so the ALU's
// result can be timed apart from its flags. The control input stays fixed across the vectors: this is the delay of one operation.

import { onTick } from './edge';
import { flatten } from './flatten';
import { GateSim } from './gatesim';
import type { ComponentDef } from './types';
import { inPorts } from './types';

/**
 * Worst time from applying a vector to the last change on `ports`, over consecutive vectors (packed inputs in port order).
 * `model` as settle.ts outputSettle: 'load' in tenths of a unit.
 */
export function portSettle(def: ComponentDef, vectors: number[][], ports: string[], model: 'unit' | 'load' = 'unit'): number {
  const sim = new GateSim(flatten(def), { delay: model });
  sim.watch(ports.flatMap((p) => sim.design.root.ports[p]));
  let last = 0;
  sim.onTrace = (_n, _b, t) => { last = t; };
  const ins = inPorts(def);
  const apply = (v: number[]) => ins.forEach((p, i) => sim.setInput(p.name, v[i]));
  apply(vectors[0]);
  sim.settle();
  let worst = 0;
  for (let i = 1; i < vectors.length; i++) {
    const t0 = sim.time;
    last = t0;
    apply(vectors[i]);
    sim.settle();
    worst = Math.max(worst, onTick(sim, last - t0));
  }
  return worst;
}
