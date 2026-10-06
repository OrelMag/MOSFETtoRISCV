import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { disasm } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

function cosim(source: string, cycles = 400) {
  const asm = assemble(source);
  expect(asm.errors).toEqual([]);
  const design = flatten(singleCycleCpu(asm.words, { fpu: true, adder: 'ks' }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words);
  for (let c = 0; c < cycles && !iss.halted; c++) {
    const info = iss.step();
    clockCycle(sim);
    const st = cpuState(sim);
    expect(st.pc, `cycle ${c}: pc after ${info.text}`).toBe(iss.pc);
    expect(st.x, `cycle ${c}: x after ${info.text}`).toEqual([...iss.x]);
    expect(st.f, `cycle ${c}: f after ${info.text}`).toEqual([...iss.f]);
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { iss, leaves: design.leaves.length };
}

describe('assembler and ISS: F subset', () => {
  it('encodes and disassembles', () => {
    const r = assemble('fadd.s ft2, ft0, ft1\nflw fa0, 8(sp)\nfsw fs0, -4(a0)\nfmv.x.w a1, ft3\nfcvt.s.w ft0, t1\nfeq.s a0, ft1, ft2\nfneg.s ft5, ft4');
    expect(r.errors).toEqual([]);
    expect(r.words.map((w) => disasm(w))).toEqual(['fadd.s ft2, ft0, ft1', 'flw fa0, 8(sp)', 'fsw fs0, -4(a0)', 'fmv.x.w a1, ft3', 'fcvt.s.w ft0, t1', 'feq.s a0, ft1, ft2', 'fsgnjn.s ft5, ft4, ft4']);
    expect(r.words[0]).toBe(0x00107153);
  });
  it('computes the expected surprises', () => {
    const run = (id: string) => { const i = new ISS(assemble(F_PROGRAMS.find((p) => p.id === id)!.source).words); for (let k = 0; k < 500 && !i.halted; k++) i.step(); return i; };
    const t = run('tenth');
    expect([t.x[10], t.x[11]]).toEqual([0, 0x3f800001]);
    expect(run('dot').dmem[8]).toBe(0x41200000);
    const a = run('absorb');
    expect([a.x[10], a.x[11], a.x[12], a.x[13], a.x[14]]).toEqual([1, 0x4b800000, 1, 0x80000000, 0]);
    expect(a.f[7]).toBe(0x7fc00000); // ft7: inf - inf
    expect(a.f[30]).toBe(0x7f800000); // ft10: overflow to +inf
  });
});

describe('single-cycle RV32IF CPU (gate level) vs golden model', () => {
  for (const p of F_PROGRAMS) it(p.id, () => { const r = cosim(p.source); console.log(`${p.id}: ${r.leaves} leaves`); }, 300000);
  it('still runs integer programs', () => { for (const id of ['sort', 'gcd']) cosim(PROGRAMS.find((p) => p.id === id)!.source, 2000); }, 300000);
});
