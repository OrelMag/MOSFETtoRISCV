// Shared test helpers: spec checking for combinational parts, and set / tick / out for clocked ones.

import { expect } from 'vitest';
import { evalOnce, forEachInput, inputBits, simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import type { ComponentDef } from '../src/sim/types';
import { inPorts } from '../src/sim/types';
import { pack } from '../src/sim/values';

/** Gate-level simulation vs def.spec: exhaustive up to 12 input bits, random vectors above. */
export function checkSpec(def: ComponentDef, trials = 400, extra: number[][] = []): void {
  const sim = simulate(def);
  for (const ins of extra) expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins));
  if (inputBits(def) <= 12) {
    forEachInput(def, (ins) => expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins)));
  } else {
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let t = 0; t < trials; t++) {
      const ins = inPorts(def).map((p) => Math.floor(rnd() * 2 ** p.width));
      expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins));
    }
  }
}

/** Corner vectors: all inputs zero, all inputs ones. */
export const corners = (def: ComponentDef): number[][] => [inPorts(def).map(() => 0), inPorts(def).map((p) => 2 ** p.width - 1)];

export const out = (sim: Sim, port: string): number => pack(sim.getBits(sim.design.root.ports[port]));
export const set = (sim: Sim, vals: Record<string, number>): void => {
  for (const [k, v] of Object.entries(vals)) sim.setInput(k, v);
  sim.settle();
};
export const tick = (sim: Sim): void => { set(sim, { clk: 1 }); set(sim, { clk: 0 }); };

/** Deterministic pseudo-random integers in [0, n). */
export function lcg(seed = 12345): (n: number) => number {
  let s = seed >>> 0;
  return (n) => Math.floor(((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * n);
}
