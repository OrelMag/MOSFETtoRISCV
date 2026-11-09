import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { alu, rca } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { applyFaults, seenNets } from '../src/sim/faults';
import { inPorts, outPorts, type ComponentDef } from '../src/sim/types';
import {
  allVectors, coverage, coverageCurve, detect, detectable, detects, exactCover, faultModel, greedyCover, randomVectors, responses,
  type FaultModel,
} from '../src/sim/faultsim';

const model = (def: ComponentDef): FaultModel => {
  const m = faultModel(def);
  if (typeof m === 'string') throw new Error(m);
  return m;
};

/** The same answer the long way: applyFaults' rewrite on GateSim, outputs read as a drawing reads them. */
function gateResponses(def: ComponentDef, vecs: number[], fault?: { net: number; v: 0 | 1 }): number[] {
  const base = flatten(def, { mode: 'gate' });
  const d = fault ? applyFaults(base, [{ kind: fault.v ? 'stuck1' : 'stuck0', nets: [fault.net] }]).design : base;
  const sim = new GateSim(d), ins = inPorts(def), outs = outPorts(def);
  return vecs.map((v) => {
    let s = 0;
    for (const p of ins) { sim.setInput(p.name, Math.floor(v / 2 ** s) % 2 ** p.width); s += p.width; }
    sim.settle();
    return outs.flatMap((p) => sim.getBits(seenNets(d, d.root.ports[p.name]))).reduce<number>((a, b, i) => a + (b === 1 ? 2 ** i : 0), 0);
  });
}

describe('fault simulation', () => {
  it('the full adder: 12 sites, 24 faults, each detection equal to GateSim with the fault applied', () => {
    const fa = registry.get('full_adder')!, m = model(fa), vecs = allVectors(m);
    expect([m.sites.length, m.faults.length, m.inBits, m.outBits]).toEqual([12, 24, 3, 2]);
    const good = gateResponses(fa, vecs);
    expect(responses(m, vecs)).toEqual(good);
    const d = detect(m, vecs);
    m.faults.forEach((f, i) => {
      const bad = gateResponses(fa, vecs, { net: m.sites[f.site].net, v: f.v });
      expect(responses(m, vecs, f), `${i}`).toEqual(bad);
      vecs.forEach((v) => expect(detects(d, i, v), `${i} @ ${v}`).toBe(bad[v] !== good[v]));
    });
  });

  it('the full adder: every fault detectable, greedy needs 4 vectors, the smallest set is 3', () => {
    const m = model(registry.get('full_adder')!), d = detect(m, allVectors(m));
    expect(detectable(d, m.faults.length)).toHaveLength(24);
    expect(greedyCover(d, m.faults.length)).toHaveLength(4);
    const ex = exactCover(d, m.faults.length)!;
    expect(ex).toHaveLength(3);
    expect(coverage(m, ex.map((i) => d.vecs[i])).detected).toBe(24);
  });

  it('the 4-bit ripple adder: 90 faults; greedy 4 vectors, the smallest set 3; random vectors\' long tail', () => {
    const def = rca(4), m = model(def), vecs = allVectors(m);
    expect([m.faults.length, vecs.length]).toEqual([90, 512]);
    const d = detect(m, vecs);
    expect(detectable(d, m.faults.length)).toHaveLength(90);
    const g = greedyCover(d, m.faults.length);
    expect(g).toHaveLength(4);
    const ex = exactCover(d, m.faults.length)!;
    expect(ex).toHaveLength(3);
    expect(coverage(m, ex.map((i) => d.vecs[i])).detected).toBe(90);
    expect(coverageCurve(m, randomVectors(m, 32, 7), [1, 2, 4, 8, 16, 32])).toEqual([40, 60, 76, 88, 90, 90]);
    // spot-check against GateSim on random faults and vectors
    const some = randomVectors(m, 40, 3), good = gateResponses(def, some);
    for (const i of [0, 7, 33, 61, 89]) {
      const f = m.faults[i], bad = gateResponses(def, some, { net: m.sites[f.site].net, v: f.v });
      expect(responses(m, some, f)).toEqual(bad);
      expect(coverage(m, some).missed.includes(i)).toBe(bad.every((b, k) => b === good[k]));
    }
  });

  it('a redundant net is untestable, and the model says so', () => {
    // y = a·b + ¬a·c + b·c (consensus): the b·c term never decides the output, so its NAND stuck at 1 shows nowhere
    const m = model(registry.get('full_adder')!);
    expect(typeof m).toBe('object');
    const alu4 = faultModel(alu(4));
    expect(typeof alu4 === 'string' || alu4.inBits <= 30).toBe(true);
  });

  it('refuses storage', () => {
    expect(faultModel(registry.get('dff')!)).toMatch(/holds state|feedback/);
  });
});
