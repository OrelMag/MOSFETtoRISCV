import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

describe('single-cycle CPU (gate level) vs golden model', () => {
  for (const p of PROGRAMS) {
    it(p.id, () => {
      const words = assemble(p.source).words;
      const t0 = performance.now();
      const design = flatten(singleCycleCpu(words));
      const sim = new GateSim(design);
      sim.setInput('clk', 0);
      sim.settle();
      const tBuild = performance.now() - t0;
      const iss = new ISS(words);
      let cycles = 0;
      const t1 = performance.now();
      while (!iss.halted && cycles < 1500) {
        const before = cpuState(sim);
        expect(before.pc, `cycle ${cycles}: pc`).toBe(iss.pc);
        iss.step();
        clockCycle(sim);
        cycles++;
        const st = cpuState(sim);
        expect(st.x, `cycle ${cycles} after ${iss.steps}`).toEqual([...iss.x]);
      }
      const st = cpuState(sim);
      expect(st.dmem).toEqual([...iss.dmem]);
      expect(iss.halted).toBe(true);
      const dt = performance.now() - t1;
      console.log(`${p.id}: ${design.leaves.length} leaves, built in ${tBuild.toFixed(0)} ms, ${cycles} cycles in ${dt.toFixed(0)} ms (${(cycles / dt * 1000).toFixed(0)} cycles/s)`);
    }, 120000);
  }
});

describe('fast-adder CPU and static timing', () => {
  it('Kogge–Stone variant still matches the golden model', () => {
    for (const id of ['primer', 'sort', 'alu']) {
      const words = assemble(PROGRAMS.find((p) => p.id === id)!.source).words;
      const sim = new GateSim(flatten(singleCycleCpu(words, { adder: 'ks' })));
      sim.setInput('clk', 0);
      sim.settle();
      const iss = new ISS(words);
      let n = 0;
      while (!iss.halted && n++ < 1500) {
        iss.step();
        clockCycle(sim);
        expect(cpuState(sim).x, `${id} cycle ${n}`).toEqual([...iss.x]);
      }
    }
  }, 120000);

  it('reports the critical path, and fast adders shorten it', async () => {
    const { analyzeTiming } = await import('../src/sim/timing');
    const words = assemble(PROGRAMS[0].source).words;
    const slow = analyzeTiming(flatten(singleCycleCpu(words)))!;
    const fast = analyzeTiming(flatten(singleCycleCpu(words, { adder: 'ks' })))!;
    console.log('rca:', slow.period, slow.stages.map((s) => `${s.inst}@${s.arrival}`).join(' → '));
    console.log('ks :', fast.period, fast.stages.map((s) => `${s.inst}@${s.arrival}`).join(' → '));
    expect(slow.stages[0].inst).toBe('pc');
    expect(fast.period).toBeLessThan(slow.period * 0.75);
  }, 60000);
});
