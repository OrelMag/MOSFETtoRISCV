// Where a library part is used: its parents come from the netlists (with instance counts) and its
// copies in a CPU agree with a flatten of that CPU.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { copiesIn, referenceCpus, usedIn } from '../src/lib/usage';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';

describe('where a part is used', () => {
  it('lists every component placing it, with the number of instances', () => {
    const fa = registry.get('full_adder')!;
    const parents = usedIn(fa);
    expect(parents.length).toBeGreaterThan(0);
    for (const p of parents) expect(netlistOf(p.def)!.instances.filter((i) => i.def === fa).length).toBe(p.count);
    for (let i = 1; i < parents.length; i++) expect(parents[i - 1].count).toBeGreaterThanOrEqual(parents[i].count);
    // The CPUs the chapters build are parents too, though not registered (and not openable by id).
    const alu = registry.get('alu32')!;
    const tops = new Set(referenceCpus().map((c) => c.def));
    const cpuParents = usedIn(alu).filter((p) => tops.has(p.def));
    expect(cpuParents.length).toBeGreaterThan(0);
    for (const p of cpuParents) expect(p.openable).toBe(false);
  });

  it('counts copies in a flattened CPU as the statistics do', () => {
    const nand = registry.get('nand')!;
    for (const { def } of referenceCpus()) expect(copiesIn(def, nand)).toBe(stats(def).nands);
    expect(copiesIn(nand, nand)).toBe(1);
  });
});
