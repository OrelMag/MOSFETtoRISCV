import { describe, expect, it } from 'vitest';
import { cachedMemory, dualCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { registry } from '../src/lib/define';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, symbolOverlaps } from '../src/view/route';
import { families, initialParams } from '../src/lib/resolve';
import { bigMemTops, cpuTops } from './tops';

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
// Every workbench family as it first opens.
for (const f of families) f.make(initialParams(f));

describe('schematic labels', () => {
  // the top-level CPUs are not registered (only their parts are): add them explicitly
  const tops = [...cpuTops(), ...bigMemTops()];
  const defs = [...new Set([...registry.values(), ...tops])].filter((d) => d.netlist);
  it.each(defs.map((d) => [d.id, d] as const))('%s: no label hides another', (_, d) => {
    expect(labelOverlaps(d, netlistOf(d)!)).toEqual([]);
  });
  it.each(defs.map((d) => [d.id, d] as const))('%s: no symbol sits on another', (_, d) => {
    expect(symbolOverlaps(netlistOf(d)!)).toEqual([]);
  });
});
