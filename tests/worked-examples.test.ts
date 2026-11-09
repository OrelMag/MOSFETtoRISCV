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

describe('traps: one tick, register by register', () => {
  it('is the golden model\'s run of the timer program', async () => {
    const { timerTick, chTraps } = await import('../src/chapters/ch-system');
    const T = timerTick();
    expect(T.pending).toMatchObject({ pc: 40, mtime: 44, mtimecmp: 44, mtip: 1, mie: 1 });
    expect(T.taken).toMatchObject({ pc: T.handler, mepc: 40, mcause: 0x80000007, mie: 0, mpie: 1, retired: T.pending.retired });
    expect(T.cleared).toMatchObject({ mtimecmp: 84, mtip: 0 });
    expect(T.back).toMatchObject({ pc: 40, mie: 1 });
    expect([T.cost, T.period]).toEqual([8, 40]);
    // the timer step's tour holds the gates to the same moment: the handler at pc 48 after 45 cycles
    const step = chTraps.steps.find((s) => s.title === 'The timer interrupt')!;
    expect(T.handler).toBe(48);
    expect(step.tour!.beats[0].cycles! + step.tour!.beats[1].cycles!).toBe(T.taken.mtime);
    expect(step.body).toContain('Worked example: one tick, register by register');
    expect(chTraps.steps.find((s) => s.title === 'Inside the trap unit')!.body).toContain('Common mistakes with traps and interrupts');
  }, 60000);
});
