// The worked examples in the dense chapters (pipelining, traps, caches, floating point) quote measured runs: each is measured
// again here, so the numbers on the page cannot drift from the circuits and the golden models.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { pipelinedCpu } from '../src/lib/pipeline';
import { assemble } from '../src/riscv/asm';
import { clockCycle, pipeSnap } from '../src/riscv/cosim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { HAZARDS, HAZARD_TRACE, chPipeline, hazardSums } from '../src/chapters/ch-pipe';

describe('pipelining: every hazard, cycle by cycle', () => {
  it('is the gate-level pipeline\'s own run', () => {
    const sim = new GateSim(flatten(pipelinedCpu(assemble(HAZARDS).words)));
    sim.setInput('clk', 0);
    sim.settle();
    const got: number[][] = [];
    for (let c = 0; c < HAZARD_TRACE.length; c++) {
      const s = pipeSnap(sim, sim.design.root, c)!;
      got.push([...s.slots.map((x) => (x.valid ? x.pc / 4 : -1)), s.fwdA, s.fwdB, s.stall ? 1 : 0, s.flush ? 1 : 0]);
      clockCycle(sim);
    }
    expect(got).toEqual(HAZARD_TRACE);
  }, 60000);

  it('adds up: fill + instructions + bubble + flushed', () => {
    const S = hazardSums();
    expect(S).toMatchObject({ cycles: 16, retired: 9, stalls: 1, flushed: 2 });
    expect(S.fill + S.retired + S.stalls + S.flushed).toBe(S.cycles);
    const step = chPipeline.steps.find((s) => s.title === 'Control hazards')!;
    expect(step.body).toContain('Worked example: every hazard, cycle by cycle');
    expect(step.body).toContain(`in ${S.cycles} cycles`);
    expect(chPipeline.steps.find((s) => s.title === 'Does it pay? Measured')!.body).toContain('Common mistakes with pipelines');
  });
});
