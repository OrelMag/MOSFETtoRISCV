import { describe, expect, it } from 'vitest';
import { cachedMemory, dualCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { registry } from '../src/lib/define';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps } from '../src/view/route';

// Build the parametric designs the chapters show, so their schematics are in the registry too.
const words = assemble(PROGRAMS[0].source).words;
singleCycleCpu(words);
singleCycleCpu(words, { adder: 'ks' });
pipelinedCpu(words, { adder: 'ks', balanced: true, predictor: true });
pipelinedCpu(words);
systemCpu(words, { m: true });
multicycleCpu(words, { control: 'fsm' });
multicycleCpu(words, { control: 'micro' });
dualCore(words);
cachedMemory(6, 2);

describe('schematic labels', () => {
  const defs = [...registry.values()].filter((d) => d.netlist);
  it.each(defs.map((d) => [d.id, d] as const))('%s: no label hides another', (_, d) => {
    expect(labelOverlaps(d, netlistOf(d)!)).toEqual([]);
  });
});
