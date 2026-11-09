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

describe('caches: two arrays one cache apart', () => {
  it('is the cache model on the loop, and the step\'s cache costs 8 cycles a miss', async () => {
    const { pairRun, PAIR_TRACE, chCache } = await import('../src/chapters/ch-cache');
    const { CacheModel } = await import('../src/sim/cachemodel');
    const R = pairRun();
    expect([R.dmMiss, R.dmCompulsory, R.dmConflict, R.w2Miss]).toEqual([16, 4, 12, 4]);
    expect(R.w2.filter((x) => !x.hit).every((x) => x.kind === 'compulsory')).toBe(true);
    // b moved one line on (0x50): the direct-mapped cache takes only the compulsory misses, as the text says
    const c = new CacheModel({ size: 64, line: 16, ways: 1, replacement: 'lru', write: 'wt' });
    expect(PAIR_TRACE.map((a) => (a >= 0x40 ? a + 16 : a)).filter((a) => !c.access(a).hit).length).toBe(4);
    // the miss time quoted is the gate-level cache's (the direct-mapped step's tour: miss → hit in 4 + 4 edges)
    const dm = chCache.steps.find((s) => s.title === 'A direct-mapped cache')!;
    expect(dm.tour!.beats.slice(1, 3).reduce((n, b) => n + (b.cycles ?? 0), 0)).toBe(R.MISS);
    expect(chCache.steps.find((s) => s.title === 'The three Cs and associativity')!.body).toContain('Worked example: two arrays one cache apart');
    expect(chCache.steps.find((s) => s.title === 'Average memory access time')!.body).toContain('Common mistakes with caches');
  });
});

describe('floating point: 3.25 + 0.46875, every step', () => {
  it('ends where the reference and the gate-level adder end', async () => {
    const { ADD_EX, addSteps, chFloat } = await import('../src/chapters/ch-float');
    const { fpAddX, fpValue } = await import('../src/sim/fpref');
    const { fpAdd } = await import('../src/lib/fpu');
    const E4M3 = { E: 4, M: 3 };
    const S = addSteps();
    const ref = fpAddX(ADD_EX.a, ADD_EX.b, false, E4M3);
    expect(S.y).toBe(ref.y);
    expect(ref.fl & 1).toBe(1);
    expect([S.d, S.g, S.r, S.st, S.up, S.carry]).toEqual([3, 1, 1, 1, true, false]);
    expect([fpValue(ADD_EX.a, E4M3), fpValue(ADD_EX.b, E4M3), fpValue(S.y, E4M3), S.exact]).toEqual([3.25, 0.46875, 3.75, 3.71875]);
    // the circuit of the addition step
    const sim = new GateSim(flatten(fpAdd(E4M3)));
    sim.setInput('a', ADD_EX.a); sim.setInput('b', ADD_EX.b); sim.setInput('sub', 0); sim.settle();
    const y = sim.getBits(sim.design.root.ports.y).reduce<number>((v, b, i) => v + (b === 1 ? 2 ** i : 0), 0);
    expect(y).toBe(S.y);
    // every pair of positive normals a ≥ b whose sum stays finite (the steps have no overflow case) agrees with the reference
    for (let a = 0x08; a < 0x70; a++) for (let b = 0x08; b <= a; b++) expect(addSteps(a, b).y, `${a} + ${b}`).toBe(fpAddX(a, b, false, E4M3).y);
    expect(chFloat.steps.find((s) => s.title === 'Round to nearest, ties to even')!.body).toContain('every step');
    expect(chFloat.steps.find((s) => s.title === 'Rounding surprises')!.body).toContain('Common mistakes with floating point');
  }, 60000);
});
