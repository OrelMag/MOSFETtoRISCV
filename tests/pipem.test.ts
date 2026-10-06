import { describe, expect, it } from 'vitest';
import { DIV_E, MUL_E, MUL_M } from '../src/lib';
import { mExec } from '../src/riscv/iss';
import { define } from '../src/lib/define';
import { evalOnce, simulate } from '../src/sim/harness';
import { lcg, out, set, tick } from './util';

const edge = [0, 1, 2, 3, 7, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffff9, 0x12345678];
const pairs = (n: number) => {
  const r = lcg(9), p: [number, number][] = [];
  for (const a of edge) for (const b of edge) p.push([a, b]);
  for (let i = 0; i < n; i++) p.push([r(2 ** 32), r(2 ** 32)]);
  return p;
};

describe('pipelined M-extension units', () => {
  it('multiply: E half then M half = mul / mulh / mulhsu / mulhu', () => {
    // E and M back to back, so no 64-bit word has to pass through a JavaScript number
    const both = define({
      id: 'test_mul_em', name: 'MUL E + M', category: 'cpu',
      ports: [{ name: 'a', width: 32, dir: 'in' }, { name: 'b', width: 32, dir: 'in' }, { name: 'f', width: 2, dir: 'in' }, { name: 'y', width: 32, dir: 'out' }],
      symbol: { kind: 'box' },
      netlist: () => ({
        instances: [{ name: 'e', def: MUL_E, at: [10, 0] }, { name: 'm', def: MUL_M, at: [40, 0] }],
        nets: [
          { ends: ['a', 'e.a'] }, { ends: ['b', 'e.b'] }, { ends: ['f', 'e.f', 'm.f'] },
          { ends: ['e.s', 'm.s'] }, { ends: ['e.c', 'm.c'] }, { ends: ['m.y', 'y'] },
        ],
      }),
    });
    const sim = simulate(both);
    for (const [a, b] of pairs(60)) for (let f = 0; f < 4; f++) {
      expect(evalOnce(sim, [a, b, f])[0] >>> 0, `f3=${f} ${a} ${b}`).toBe(mExec(f, a, b) >>> 0);
    }
  }, 120000);
  it('divide: div / divu / rem / remu, stalling until done', () => {
    const s = simulate(DIV_E);
    set(s, { clk: 0, go: 0, a: 0, b: 0, f: 0 });
    for (const [a, b] of pairs(15)) for (let f = 0; f < 4; f++) {
      set(s, { go: 1, a, b, f });
      let cycles = 0;
      while (out(s, 'stall')) { tick(s); cycles++; expect(cycles).toBeLessThan(40); }
      expect(out(s, 'y') >>> 0, `f3=${4 + f} ${a} ${b}`).toBe(mExec(4 + f, a, b) >>> 0);
      expect(cycles).toBe(18); // one load edge and 17 radix-4 steps; done on the 19th cycle
      tick(s);
      set(s, { go: 0 });
      tick(s);
    }
  }, 300000);
});

import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PIPE_M_PROGRAMS } from '../src/riscv/pmprograms';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

function cosim(source: string, extra: { balanced?: boolean; predictor?: boolean } = {}) {
  const words = assemble(source).words;
  const design = flatten(pipelinedCpu(words, { adder: 'ks', m: true, ...extra }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words);
  let cycles = 0, retired = 0;
  while (!iss.halted && cycles < 3000) {
    const ret = retiring(sim);
    clockCycle(sim);
    cycles++;
    if (ret) {
      iss.step();
      retired++;
      expect(cpuState(sim).x, `after retiring #${retired} (cycle ${cycles})`).toEqual([...iss.x]);
    }
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles, retired };
}

describe('pipelined RV32IM CPU vs golden model', () => {
  for (const p of PIPE_M_PROGRAMS) it(p.id, () => { const r = cosim(p.source); console.log(`${p.id}: ${r.retired} instructions in ${r.cycles} cycles`); }, 300000);
  it('balanced, with branch prediction', () => { cosim(PIPE_M_PROGRAMS[1].source, { balanced: true, predictor: true }); }, 300000);
  it('plain RV32I programs still run', () => { cosim(PROGRAMS[0].source); }, 300000);
});
