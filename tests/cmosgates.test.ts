import { describe, expect, it } from 'vitest';
import { cmosNand, cmosNor, ringOsc } from '../src/lib';
import { deadInstances } from '../src/sim/dead';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { GateSim } from '../src/sim/gatesim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const gates = [['nand3', cmosNand(3)], ['nand4', cmosNand(4)], ['nor3', cmosNor(3)], ['nor4', cmosNor(4)]] as const;
const rings = [3, 5, 7].map((n) => ringOsc(n));

describe('wide CMOS gates', () => {
  it.each(gates)('%s: truth table from the switch solver, 2n transistors', (_, def) => {
    const sim = simulate(def, 'switch');
    forEachInput(def, (ins) => expect(evalOnce(sim, ins)).toEqual(def.spec!(ins.map((v) => v) as never) ?? []));
    expect(stats(def).transistors).toBe(2 * (def.ports.length - 1));
  });
  it.each([...gates.map(([, d]) => [d.id, d] as const), ...rings.map((d) => [d.id, d] as const)])('%s: clean drawing', (_, def) => {
    const nl = netlistOf(def)!;
    expect(wireOverlaps(routeNetlist(def, nl).nets)).toEqual([]);
    expect(labelOverlaps(def, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(backwardEnds(def, nl)).toEqual([]);
    expect(deadInstances(nl, def.ports)).toEqual([]);
  });
});

describe('ring oscillator', () => {
  it.each([3, 5, 7])('%i stages: still with en = 0, period 2n gate delays with en = 1', (n) => {
    const def = ringOsc(n), d = flatten(def, { mode: 'gate' }), sim = new GateSim(d);
    sim.setInput('en', 0);
    sim.settle();
    const edges: number[] = [];
    let last = sim.getBits(sim.design.root.ports.y)[0];
    sim.setInput('en', 1);
    for (let i = 0; i < 20 * n && edges.length < 5; i++) {
      sim.step();
      const v = sim.getBits(sim.design.root.ports.y)[0];
      if (v === 1 && last === 0) edges.push(sim.time);
      last = v;
    }
    expect(edges.length).toBeGreaterThanOrEqual(3);
    expect(edges[2] - edges[1]).toBe(2 * n);
  });
});
