// "Open in Sandbox" places a part by library id only when a fresh page load can find it. A part
// that only a CPU generator registers (e.g. the pipeline's fan-out wiring) must come along some
// other way or resolve from its id, or the remixed CPU goes X after a reload.
import { describe, expect, it } from 'vitest';
import { emptyWorkspace } from '../src/editor/model';
import { remixDef } from '../src/editor/remix';
import { singleCycleCpu } from '../src/lib/cpu';
import { registry } from '../src/lib/define';
import { pipelinedFpCpu } from '../src/lib/fppipe';
import { dualCore } from '../src/lib/multicore';
import { multicycleCpu } from '../src/lib/multicycle';
import { pipelinedCpu } from '../src/lib/pipeline';
import { regenerable } from '../src/lib/resolve';
import { systemCpu } from '../src/lib/system';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';

// What a fresh page has registered before any CPU is built.
const atLoad = new Set(registry.keys());
const words = assemble(PROGRAMS[0].source).words;

const CPUS: [string, () => ReturnType<typeof singleCycleCpu>][] = [
  ['single-cycle', () => singleCycleCpu(words)],
  ['single-cycle, fast adders, write-back cache', () => singleCycleCpu(words, { adder: 'ks', dcache: 'wb' })],
  ['pipelined', () => pipelinedCpu(words)],
  ['pipelined, balanced, predictor, cache', () => pipelinedCpu(words, { adder: 'ks', balanced: true, predictor: true, dcache: 'wb2' })],
  ['pipelined, M', () => pipelinedCpu(words, { adder: 'ks', m: true })],
  ['multicycle (microcode)', () => multicycleCpu(words, { control: 'micro' })],
  ['system, M', () => systemCpu(words, { m: true })],
  ['pipelined FPU', () => pipelinedFpCpu(words)],
  ['dual-core', () => dualCore(words)],
];

describe('a remixed CPU still resolves after a reload', () => {
  for (const [name, make] of CPUS) {
    it(name, () => {
      const r = remixDef(emptyWorkspace(), make());
      if ('error' in r) throw new Error(r.error);
      const lost = new Set<string>();
      for (const chip of Object.values(r.ws.chips))
        for (const p of chip.parts) if ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib)) lost.add(p.ref.lib);
      expect([...lost]).toEqual([]);
    });
  }
});
