import { describe, expect, it } from 'vitest';
import { multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { netlistOf } from '../src/sim/types';
import { instrUse, STAGE_UNITS } from '../src/widgets/insthw';

// The program-listing highlight names top-level instances: keep the tables in step with the CPUs.
const names = (d: ReturnType<typeof singleCycleCpu>) => new Set(netlistOf(d)!.instances.map((i) => i.name));
const prog = assemble('addi t0, zero, 1\nadd t1, t0, t0\nlw t2, 0(zero)\nsw t2, 4(zero)\nbeq t0, t1, 0\njal ra, 4\njalr zero, 0(ra)\nlui a0, 1\nauipc a1, 0').words;

describe('instruction → hardware map', () => {
  it('every pipeline stage unit exists in the pipelined CPU', () => {
    const have = names(pipelinedCpu(prog, {}));
    for (const [stage, units] of Object.entries(STAGE_UNITS)) {
      const missing = units.filter((u) => !have.has(u) && !['btb', 'fsel', 'corr', 'mis', 'mspc', 'vF', 'bcmp', 'jtgt', 'clr0E'].includes(u));
      expect(missing, stage).toEqual([]);
    }
  });

  it('each instruction class lights up real units on every CPU', () => {
    for (const cpu of [singleCycleCpu(prog), systemCpu(prog), multicycleCpu(prog, {}), pipelinedCpu(prog, {})]) {
      const have = names(cpu);
      for (const w of prog) {
        const hit = instrUse(w).units.filter((u) => have.has(u));
        expect(hit.length, `${cpu.id} ${w.toString(16)}`).toBeGreaterThan(3);
        expect(hit).toContain('pc');
      }
    }
    expect(instrUse(prog[2]).units).toContain('dm');
    expect(instrUse(prog[1]).units).not.toContain('dm');
  });
});
