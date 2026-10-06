import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { CACHE_CPU_PROGRAMS } from '../src/riscv/cprograms';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

/** Pipelined CPU with a data cache vs the ISS, checked at every retirement; counts frozen cycles. */
function run(source: string, dcache: 'wt' | 'wb' | 'wb2', predictor = false) {
  const words = assemble(source).words;
  const design = flatten(pipelinedCpu(words, { adder: 'ks', dcache, predictor }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words, { dmemWords: 64 });
  let cycles = 0, retired = 0, frozen = 0;
  while (!iss.halted && cycles < 6000) {
    const ret = retiring(sim);
    if (sim.getBits(design.root.ports.dstall)[0] === 1) frozen++;
    clockCycle(sim);
    cycles++;
    if (ret) {
      iss.step();
      retired++;
      expect(cpuState(sim).x, `after retiring #${retired} (cycle ${cycles})`).toEqual([...iss.x]);
    }
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem, 'memory, dirty lines included').toEqual([...iss.dmem]);
  return { cycles, retired, frozen };
}

const src = (id: string) => (CACHE_CPU_PROGRAMS.find((p) => p.id === id) ?? PROGRAMS.find((p) => p.id === id))!.source;

describe('pipelined CPU with a data cache vs golden model', () => {
  for (const dc of ['wt', 'wb', 'wb2'] as const) {
    for (const id of ['reuse', 'pingpong', 'inplace']) {
      it(`${dc}: ${id}`, () => {
        const r = run(src(id), dc);
        console.log(`${dc} ${id}: ${r.retired} instructions in ${r.cycles} cycles, ${r.frozen} frozen`);
      }, 300000);
    }
  }
  it('with branch prediction too (the predictor must not update while frozen)', () => {
    run(src('pingpong'), 'wb2', true);
    run(src('sort'), 'wb', true);
  }, 300000);
  it('the misses are the only extra cycles: a 2-way cache halves the frozen time of pingpong', () => {
    const dm = run(src('pingpong'), 'wb'), two = run(src('pingpong'), 'wb2');
    expect(two.frozen).toBeLessThan(dm.frozen / 2);
  }, 300000);
});
