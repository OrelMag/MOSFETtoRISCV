// Chapter 14's challenge "Your own instruction": the draft row leaves the sum wrong, the answer row gives 80 on the
// single-cycle CPU and on the pipelined one, and the cost the prose quotes is the control unit's growth.

import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { problemsOf } from '../src/riscv/custom';
import { BY_NAME } from '../src/riscv/isa';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { OWN_ANSWER, OWN_COST, OWN_DRAFT, OWN_SOURCE, OWN_SUM, ownInstrScene } from '../src/widgets/owninstr';

function sumOf(root: Parameters<typeof flatten>[0], cycles: number): number {
  const sim = new GateSim(flatten(root));
  sim.setInput('clk', 0);
  sim.settle();
  for (let i = 0; i < cycles; i++) clockCycle(sim);
  return cpuState(sim).dmem[0];
}

describe('chapter challenge: lwx', () => {
  it('both rows are buildable; the draft is wrong, the answer sums the array', () => {
    for (const r of [OWN_DRAFT, OWN_ANSWER]) expect(problemsOf(r, new Set(BY_NAME.keys())).filter((p) => p.level === 'bad')).toEqual([]);
    expect(sumOf(ownInstrScene([OWN_DRAFT]).root, 120)).not.toBe(OWN_SUM);
    expect(sumOf(ownInstrScene([OWN_ANSWER]).root, 120)).toBe(OWN_SUM);
  }, 60_000);

  it('the pipelined CPU gives the same sum', () => {
    const words = assemble(OWN_SOURCE, [OWN_ANSWER]).words;
    expect(sumOf(pipelinedCpu(words, { custom: [OWN_ANSWER] }), 200)).toBe(OWN_SUM);
  }, 60_000);

  it('the quoted cost: 152 NANDs plus 14', () => {
    expect(OWN_COST.control).toBe(152);
    expect(OWN_COST.lwx - OWN_COST.control).toBe(14);
    expect(OWN_COST.and5).toBe(8);
  });
});
