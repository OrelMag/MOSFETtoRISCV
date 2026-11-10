// The Vectors chapter's numbers: bench/vectorcosts.json recomputed from the circuits and golden models, the timing
// model (riscv/vecmodel.ts vecRun) equal to the gates' cycle count on every program the chapter runs, each program's
// result, the strip-mining loop at three VLENs, and the chaining model's totals.
import { describe, expect, it } from 'vitest';
import costs from '../src/bench/vectorcosts.json';
import { vectorCosts } from '../src/bench/vectorcosts';
import { singleCycleCpu } from '../src/lib/cpu';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { ABI } from '../src/riscv/isa';
import { CHAIN_KERNEL, chainTimes, vecRun } from '../src/riscv/vecmodel';
import { SAXPY_RESULT, VEC_PROGRAMS, vectorSaxpy } from '../src/riscv/vecprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { stripRun } from '../src/widgets/vectors';
import { tick } from './yieldtick';

/** Cycles the gate-level vector CPU takes to retire as many instructions as the golden model ran to its halt. */
function gateCycles(words: number[], instrs: number, dmemK: number): number {
  const sim = new GateSim(flatten(singleCycleCpu(words, { dmemK, vector: { lanes: 4, vlen: 128 } })));
  sim.setInput('clk', 0);
  sim.settle();
  let cycles = 0, retired = 0;
  while (retired < instrs && cycles < 5000) {
    if (retiring(sim)) retired++;
    clockCycle(sim);
    cycles++;
  }
  return cycles;
}

describe('the Vectors chapter', () => {
  it('vectorcosts.json is what the circuits measure today (scripts/vector-costs.ts --write)', () => {
    expect(vectorCosts()).toEqual(costs);
  }, 120_000);

  it('every program gives its result, and the timing model counts the cycles the gates take', async () => {
    const progs = [...VEC_PROGRAMS.map((p) => ({ id: p.id, src: p.source, k: 6, result: p.result })), ...([1, 2, 4, 8] as const).map((l) => ({ id: `saxpy m${l}`, src: vectorSaxpy(l), k: 5, result: undefined }))];
    for (const p of progs) {
      const words = assemble(p.src).words;
      const r = vecRun(words, { dmemWords: 2 ** p.k, imemWords: 64 });
      expect(r.iss.halted, p.id).toBe(true);
      if (p.result) expect(r.iss.x[ABI.indexOf(p.result.reg)], p.id).toBe(p.result.value);
      else expect([...r.iss.dmem.slice(16, 32)], p.id).toEqual(SAXPY_RESULT);
      expect(gateCycles(words, r.instrs, p.k), p.id).toBe(r.cycles);
      await tick();
    }
  }, 120_000);

  it('the gates end in the golden model\'s state on the kernel', () => {
    const words = assemble(vectorSaxpy(4)).words;
    const r = vecRun(words, { dmemWords: 32, imemWords: 64 });
    const sim = new GateSim(flatten(singleCycleCpu(words, { dmemK: 5, vector: { lanes: 4, vlen: 128 } })));
    sim.setInput('clk', 0);
    sim.settle();
    for (let i = 0; i < r.cycles; i++) clockCycle(sim);
    expect(cpuState(sim).dmem.slice(16, 32)).toEqual(SAXPY_RESULT);
  });

  it('strip-mining: passes and one binary at three VLENs', () => {
    expect(stripRun(37, 128, 1).passes).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4, 1]);
    expect(stripRun(100, 128, 8).passes).toEqual([32, 32, 32, 4]);
    expect([128, 256, 512].map((v) => stripRun(37, v, 1).passes.length)).toEqual([10, 5, 3]);
  });

  it('chaining: one at a time, separate units, chained', () => {
    expect((['serial', 'units', 'chained'] as const).map((m) => chainTimes(CHAIN_KERNEL, 8, m).total)).toEqual([48, 41, 27]);
    // chained, a dependent group never starts before its producer's same group is written
    const t = chainTimes(CHAIN_KERNEL, 8, 'chained');
    for (let g = 0; g < 8; g++) expect(t.start[2][g]).toBeGreaterThan(t.start[0][g]);
  });
});
