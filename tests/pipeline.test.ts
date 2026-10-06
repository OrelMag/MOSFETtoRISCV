import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

function run(id: string, adder: 'rca' | 'ks' = 'rca', extra: { balanced?: boolean; predictor?: boolean } = {}) {
  const words = assemble(PROGRAMS.find((p) => p.id === id)!.source).words;
  const design = flatten(pipelinedCpu(words, { adder, ...extra }));
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

describe('balanced and branch-predicting pipelines vs golden model', () => {
  for (const variant of [{ balanced: true }, { predictor: true }, { balanced: true, predictor: true }]) {
    for (const id of ['primer', 'sort', 'gcd', 'alu', 'mul']) {
      it(`${JSON.stringify(variant)} ${id}`, () => {
        const r = run(id, 'ks', variant);
        console.log(`${JSON.stringify(variant)} ${id}: CPI ${(r.cycles / r.retired).toFixed(2)}`);
      }, 120000);
    }
  }
  it('timing of the variants', async () => {
    const { analyzeTiming } = await import('../src/sim/timing');
    const words = assemble(PROGRAMS[0].source).words;
    for (const v of [{}, { balanced: true }, { balanced: true, predictor: true }]) {
      for (const adder of ['rca', 'ks'] as const) {
        const t = analyzeTiming(flatten(pipelinedCpu(words, { adder, ...v })))!;
        console.log(`${JSON.stringify(v)} ${adder}: ${t.period} ${t.byCapture.slice(0, 4).map((c) => `${c.inst}:${c.period}`).join(' ')} | ${t.stages.map((s) => s.inst).join('→')}`);
      }
    }
  }, 120000);
});
