// The out-of-order core at gate level (lib/ooocore.ts) against riscv/ooomodel.ts's OOO_CORE, cycle by cycle (commits
// and the instruction each port issues), and against the golden model (every register after every commit, memory at
// the halt).

import { describe, expect, it } from 'vitest';
import { oooCpu } from '../src/lib/ooocore';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { clockCycle, cpuState, retireCount } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { OooModel } from '../src/riscv/ooomodel';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

export function cosimOoo(source: string, { imemK = 6, dmemK = 5, max = 6000 } = {}): { cycles: number; retired: number } {
  const words = assemble(source).words;
  const opts = { imemWords: 2 ** imemK, dmemWords: 2 ** dmemK };
  const design = flatten(oooCpu(words, { imemK, dmemK }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const model = new OooModel(words, {}, opts), iss = new ISS(words, { m: true, ...opts });
  const iq = design.root.children!.get('iq')!;
  const pcOf = (p: number) => pack(sim.getBits(iq.ports[`pay${p}`].slice(4, 36))) >>> 0;
  let cycles = 0, retired = 0;
  while (!model.halted && cycles < max) {
    const n = retireCount(sim), info = model.step();
    const issued = [0, 1].map((p) => (sim.getBits(iq.ports[`go${p}`])[0] === 1 ? pcOf(p) : -1));
    // (the model stops issuing in the cycle it halts)
    const want = model.halted ? issued : [0, 1].map((p) => info.issued.find((u) => u.port === p)?.pc ?? -1);
    expect({ cycle: cycles, commits: n, issued }, `cycle ${cycles}`).toEqual({ cycle: cycles, commits: info.committed.length, issued: want });
    clockCycle(sim);
    cycles++;
    for (let k = 0; k < n && !iss.halted; k++) { iss.step(); retired++; }
    if (n) expect(cpuState(sim).x, `after #${retired} (cycle ${cycles})`).toEqual([...iss.x]);
  }
  expect(model.halted, 'the model halted').toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles, retired };
}

describe('out-of-order core vs the model and the golden model', () => {
  it('a straight line of independent and dependent ALU instructions', () => {
    const r = cosimOoo(`li x1, 1\n li x2, 2\n add x3, x1, x2\n add x4, x3, x3\n addi x5, x0, 7\n sub x6, x4, x5\n xor x7, x6, x1\n or x8, x7, x2\n halt: j halt`);
    console.log(`straight line: ${r.retired} instructions in ${r.cycles} cycles`);
  }, 600_000);
});

describe('out-of-order core: memory, control, multiply and divide', () => {
  it('stores and loads: forwarding from the store queue, loads behind stores', () => {
    cosimOoo(`li x1, 12\n li x2, 34\n sw x1, 0(x0)\n sw x2, 4(x0)\n lw x3, 0(x0)\n add x4, x3, x3\n lw x5, 4(x0)\n sw x4, 8(x0)\n lw x6, 8(x0)
      addi x6, x6, 1\n sw x6, 0(x0)\n lw x7, 0(x0)\n add x8, x7, x5\n halt: j halt`);
  }, 600_000);
  it('loops and branches: mispredictions flush at commit', () => {
    cosimOoo(`li x1, 0\n li x2, 10\n li x3, 0\nloop: addi x1, x1, 1\n add x3, x3, x1\n bne x1, x2, loop\n li x4, 3\nl2: addi x4, x4, -1\n beq x4, x0, out\n j l2\nout: addi x5, x3, 1\n halt: j halt`);
  }, 600_000);
  it('calls and returns through the return stack', () => {
    cosimOoo(`li sp, 64\n li a0, 0\n jal ra, f1\n jal ra, f1\n jal ra, f2\n j halt\nf1: addi sp, sp, -4\n sw ra, 0(sp)\n addi a0, a0, 1\n jal ra, f2\n lw ra, 0(sp)\n addi sp, sp, 4\n ret
      f2: addi a0, a0, 10\n ret\nhalt: j halt`, { dmemK: 5 });
  }, 600_000);
  it('multiply and divide on port 1, the divider in the background', () => {
    cosimOoo(`li x1, 7\n li x2, -3\n mul x3, x1, x2\n div x4, x1, x2\n addi x5, x0, 1\n addi x6, x5, 1\n rem x7, x1, x2\n mulh x8, x2, x2\n add x9, x4, x7\n divu x10, x1, x1\n add x11, x10, x9\n halt: j halt`);
  }, 600_000);
});

describe('out-of-order core: the benchmark set, cycle for cycle', () => {
  for (const bm of BENCHMARKS.filter((x) => !x.needs?.f)) it(bm.id, () => {
    const r = cosimOoo(bm.source, { imemK: 7, dmemK: 6, max: 20000 });
    console.log(`${bm.id}: CPI ${(r.cycles / r.retired).toFixed(2)} (${r.retired} instructions, ${r.cycles} cycles)`);
  }, 1_800_000);
});
