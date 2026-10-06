import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { breathe } from './fptest';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { disasm } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

async function cosim(source: string, cycles = 400) {
  const asm = assemble(source);
  expect(asm.errors).toEqual([]);
  const design = flatten(singleCycleCpu(asm.words, { fpu: true, adder: 'ks' }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words);
  for (let c = 0; c < cycles && !iss.halted; c++) {
    if (c % 50 === 49) await breathe();
    const info = iss.step();
    clockCycle(sim);
    const st = cpuState(sim);
    expect(st.pc, `cycle ${c}: pc after ${info.text}`).toBe(iss.pc);
    expect(st.x, `cycle ${c}: x after ${info.text}`).toEqual([...iss.x]);
    expect(st.f, `cycle ${c}: f after ${info.text}`).toEqual([...iss.f]);
    expect(st.fcsr, `cycle ${c}: fcsr after ${info.text}`).toBe((iss.frm << 5) | iss.fflags);
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { iss, leaves: design.leaves.length };
}

const run = (id: string) => { const i = new ISS(assemble(F_PROGRAMS.find((p) => p.id === id)!.source).words); for (let k = 0; k < 500 && !i.halted; k++) i.step(); return i; };

describe('assembler and ISS: F extension', () => {
  it('encodes and disassembles', () => {
    const r = assemble('fadd.s ft2, ft0, ft1\nflw fa0, 8(sp)\nfsw fs0, -4(a0)\nfmv.x.w a1, ft3\nfcvt.s.w ft0, t1\nfeq.s a0, ft1, ft2\nfneg.s ft5, ft4\nfcvt.w.s a0, ft0, rtz\nfmul.s ft1, ft2, ft3, rmm\nfmin.s ft0, ft1, ft2\nfclass.s a2, ft7\nfcvt.wu.s t0, ft1');
    expect(r.errors).toEqual([]);
    expect(r.words.map((w) => disasm(w))).toEqual(['fadd.s ft2, ft0, ft1', 'flw fa0, 8(sp)', 'fsw fs0, -4(a0)', 'fmv.x.w a1, ft3', 'fcvt.s.w ft0, t1', 'feq.s a0, ft1, ft2', 'fsgnjn.s ft5, ft4, ft4',
      'fcvt.w.s a0, ft0, rtz', 'fmul.s ft1, ft2, ft3, rmm', 'fmin.s ft0, ft1, ft2', 'fclass.s a2, ft7', 'fcvt.wu.s t0, ft1']);
    expect(r.words[0]).toBe(0x00107153);
    expect(r.words[7]).toBe(0xc0001553); // fcvt.w.s a0, ft0, rtz
    const c = assemble('frcsr a0\nfscsr t0\nfsrmi a1, 3\nfsflags zero\nfrflags a2');
    expect(c.errors).toEqual([]);
    expect(c.words.map((w) => disasm(w))).toEqual(['csrrs a0, fcsr, zero', 'csrrw zero, fcsr, t0', 'csrrwi a1, frm, 3', 'csrrw zero, fflags, zero', 'csrrs a2, fflags, zero']);
    expect(assemble('fadd.s ft0, ft1, ft2, up').errors.length).toBe(1);
  });
  it('computes the expected surprises', () => {
    const t = run('tenth');
    expect([t.x[10], t.x[11]]).toEqual([0, 0x3f800001]);
    expect(run('dot').dmem[8]).toBe(0x41200000);
    const a = run('absorb');
    expect([a.x[10], a.x[11], a.x[12], a.x[13], a.x[14]]).toEqual([1, 0x4b800000, 1, 0x80000000, 0]);
    expect(a.f[7]).toBe(0x7fc00000); // ft7: inf - inf
    expect(a.f[30]).toBe(0x7f800000); // ft10: overflow to +inf
    expect(a.fflags).toBe(0x15); // NV (inf - inf), OF and NX (1e64)
  });
  it('rounding modes, flags, min / max and classification', () => {
    const m = run('rmodes');
    expect([10, 11, 12, 13, 14].map((i) => m.x[i] | 0)).toEqual([2, 2, 2, 3, 3]);
    expect([18, 19, 20, 21, 22].map((i) => m.x[i] | 0)).toEqual([-2, -2, -3, -2, -3]);
    expect([m.f[2], m.f[3], m.f[4]]).toEqual([0x4b800000, 0x4b800001, 0xcb800001]);
    expect([m.x[15], m.x[16]]).toEqual([2, 1]);
    const f = run('flags');
    expect([10, 11, 12, 13, 14, 15, 16, 17].map((i) => f.x[i])).toEqual([0x10, 0x05, 0x05, 0, 0x03, 0x7fffffff, 3000000000, 0x10]);
    expect([f.f[3], f.f[4]]).toEqual([0x7f800000, 0x7f7fffff]);
    const x = run('minmax');
    expect([x.f[2], x.f[3], x.f[6], x.f[7], x.f[30]]).toEqual([0x3f800000, 0x7fc00000, 0x80000000, 0, 0x3f800000]);
    expect([10, 11, 12, 13, 14, 15, 16, 17].map((i) => x.x[i])).toEqual([0x200, 0x008, 0x020, 0, 0, 0, 0x100, 0x10]);
  });
});

describe('single-cycle RV32IF CPU (gate level) vs golden model', () => {
  for (const p of F_PROGRAMS) it(p.id, async () => { const r = await cosim(p.source); console.log(`${p.id}: ${r.leaves} leaves`); }, 300000);
  it('still runs integer programs', async () => { for (const id of ['sort', 'gcd']) await cosim(PROGRAMS.find((p) => p.id === id)!.source, 2000); }, 300000);
});
