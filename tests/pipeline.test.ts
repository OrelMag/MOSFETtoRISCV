import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

function run(id: string, adder: 'rca' | 'ks' = 'rca') {
  const words = assemble(PROGRAMS.find((p) => p.id === id)!.source).words;
  const design = flatten(pipelinedCpu(words, { adder }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words);
  let cycles = 0, retired = 0;
  while (!iss.halted && cycles < 4000) {
    const ret = retiring(sim);
    clockCycle(sim);
    cycles++;
    if (ret) {
      iss.step();
      retired++;
      expect(cpuState(sim).x, `${id}: after retiring #${retired} (cycle ${cycles})`).toEqual([...iss.x]);
    }
  }
  expect(iss.halted, `${id} halted`).toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles, retired, leaves: design.leaves.length };
}

describe('pipelined CPU (gate level) vs golden model', () => {
  for (const p of PROGRAMS) {
    it(p.id, () => {
      const r = run(p.id);
      console.log(`${p.id}: ${r.retired} instructions in ${r.cycles} cycles (CPI ${(r.cycles / r.retired).toFixed(2)}), ${r.leaves} leaves`);
    }, 120000);
  }
});

describe('pipeline timing', () => {
  it('has a much shorter clock period than the single-cycle CPU', async () => {
    const { analyzeTiming } = await import('../src/sim/timing');
    const { singleCycleCpu } = await import('../src/lib');
    const words = assemble(PROGRAMS[0].source).words;
    const rows: string[] = [];
    const per: Record<string, number> = {};
    for (const [name, def] of [
      ['single rca', singleCycleCpu(words)], ['single ks', singleCycleCpu(words, { adder: 'ks' })],
      ['pipe rca', pipelinedCpu(words)], ['pipe ks', pipelinedCpu(words, { adder: 'ks' })],
    ] as const) {
      const t = analyzeTiming(flatten(def))!;
      per[name] = t.period;
      rows.push(`${name}: ${t.period}  ${t.stages.map((s) => `${s.inst}@${s.arrival}`).join(' → ')}
   per capture: ${t.byCapture.map((c) => `${c.inst}:${c.period}`).join(' ')}`);
    }
    console.log(rows.join('\n'));
    expect(per['pipe rca']).toBeLessThan(per['single rca']);
    expect(per['pipe ks']).toBeLessThan(per['single ks']);
  }, 120000);
});
