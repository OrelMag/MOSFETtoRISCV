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
