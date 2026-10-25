// The dual-issue in-order pipeline (Phase 17b, lib/pipe2w.ts) and its parts: the 4-read 2-write register file,
// and the CPU in lock-step with the golden model (two instructions may retire a cycle, oldest first).

import { describe, expect, it } from 'vitest';
import RESULTS from '../src/bench/results.json';
import { chOoo, DUAL_SOURCE } from '../src/chapters/ch-ooo';
import { dualPipeCpu } from '../src/lib/pipe2w';
import { regfile2w, writeSelect } from '../src/lib/regfile';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { clockCycle, cpuState, retireCount, retirePc } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PIPE_M_PROGRAMS } from '../src/riscv/pmprograms';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import { checkSpec, lcg, out, set, tick } from './util';

/**
 * The dual-issue CPU on GateSim beside the golden model: before each edge the oldest retiring instruction must be
 * the model's next; after it the model steps once per instruction retired and every register is compared; memory
 * at the halt. Returns cycles and instructions.
 */
function cosim(source: string, { imemK = 6, dmemK = 5, max = 4000 } = {}): { cycles: number; retired: number; pairs: number } {
  const words = assemble(source).words;
  const design = flatten(dualPipeCpu(words, { imemK, dmemK }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words, { m: true, dmemWords: 2 ** dmemK, imemWords: 2 ** imemK });
  let cycles = 0, retired = 0, pairs = 0;
  while (!iss.halted && cycles < max) {
    const n = retireCount(sim);
    if (n) expect(retirePc(sim, design.root), `cycle ${cycles}: the oldest retiring`).toBe(iss.pc >>> 0);
    clockCycle(sim);
    cycles++;
    if (n === 2) pairs++;
    for (let k = 0; k < n && !iss.halted; k++) { iss.step(); retired++; }
    if (n) expect(cpuState(sim).x, `after retiring #${retired} (cycle ${cycles})`).toEqual([...iss.x]);
  }
  expect(iss.halted, 'halted in the budget').toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles, retired, pairs };
}

describe('register file, 4 read and 2 write ports', () => {
  it('write select: either port enables, port 1 wins', () => checkSpec(writeSelect(4)));

  it('two writes a cycle (port 1 wins one register both write), four reads, x0 = 0', () => {
    const s = simulate(regfile2w(3, 8)), r = lcg(7), regs = Array(8).fill(0);
    set(s, { clk: 0, we0: 1, we1: 0, wa0: 0, wa1: 0, wd0: 0, wd1: 0 });
    for (let a = 1; a < 8; a++) { set(s, { wa0: a }); tick(s); }
    for (let t = 0; t < 120; t++) {
      const v = { we0: r(2), we1: r(2), wa0: r(8), wa1: t % 5 === 0 ? -1 : r(8), wd0: r(256), wd1: r(256), ra1: r(8), ra2: r(8), ra3: r(8), ra4: r(8) };
      if (v.wa1 < 0) v.wa1 = v.wa0; // both ports on one register now and then
      set(s, v);
      for (let p = 1; p <= 4; p++) expect(out(s, `rd${p}`), `t ${t} rd${p}`).toBe(regs[v[`ra${p}` as 'ra1']]);
      tick(s);
      if (v.we0 && v.wa0) regs[v.wa0] = v.wd0;
      if (v.we1 && v.wa1) regs[v.wa1] = v.wd1;
    }
  });
});

describe('dual-issue pipeline vs golden model', () => {
  it('independent pairs issue together, dependent ones split', () => {
    const r = cosim(`li x1, 1\n li x2, 2\n add x3, x1, x2\n add x4, x1, x1\n addi x5, x3, 1\n addi x6, x5, 1\n add x7, x6, x5\n sub x8, x7, x1\n
      xor x9, x8, x2\n or x10, x9, x3\n halt: j halt`);
    expect(r.pairs).toBeGreaterThan(0);
  }, 300000);
  it('loads, stores, load-use in either slot, a write both lanes make', () => {
    cosim(`li x1, 12\n li x2, 34\n sw x1, 0(x0)\n sw x2, 4(x0)\n lw x3, 0(x0)\n add x4, x3, x3\n lw x5, 4(x0)\n addi x6, x0, 1\n add x7, x5, x6
      addi x8, x0, 5\n addi x8, x0, 7\n add x9, x8, x8\n lw x10, 0(x0)\n addi x10, x10, 1\n sw x10, 8(x0)\n lw x11, 8(x0)\n halt: j halt`);
  }, 300000);
  it('branches and jumps in either lane, mispredicted and predicted', () => {
    cosim(`li x1, 0\n li x2, 10\nloop: addi x1, x1, 1\n bne x1, x2, loop\n li x3, 0\n li x4, 3\nl2: addi x3, x3, 1\n beq x3, x4, out\n j l2\nout: addi x5, x0, 9
      jal x6, f\n addi x7, x0, 1\n j halt\nf: addi x8, x0, 2\n jalr x0, 0(x6)\nhalt: j halt`);
  }, 300000);
  it('calls and returns through the return stack (nested)', () => {
    cosim(`li sp, 64\n li a0, 0\n jal ra, f1\n jal ra, f1\n j halt\nf1: addi sp, sp, -4\n sw ra, 0(sp)\n addi a0, a0, 1\n jal ra, f2\n lw ra, 0(sp)\n addi sp, sp, 4\n ret
      f2: addi a0, a0, 10\n ret\nhalt: j halt`, { dmemK: 5 });
  }, 300000);
  it('multiply and divide (lane 0 only, divide never paired)', () => {
    cosim(`li x1, 7\n li x2, -3\n mul x3, x1, x2\n addi x4, x0, 1\n add x5, x3, x4\n div x6, x1, x2\n addi x7, x6, 1\n rem x8, x1, x2\n mulh x9, x2, x2\n add x10, x9, x8\n halt: j halt`);
  }, 300000);
  for (const p of PIPE_M_PROGRAMS) it(p.id, () => { const r = cosim(p.source); console.log(`${p.id}: ${r.retired} instructions in ${r.cycles} cycles, ${r.pairs} pairs`); }, 600000);
  it('plain RV32I programs', () => { for (const p of PROGRAMS.slice(0, 3)) cosim(p.source); }, 600000);
  const paired: number[] = [];
  for (const bm of BENCHMARKS.filter((b) => !b.needs?.f)) it(`benchmark ${bm.id}`, () => {
    const r = cosim(bm.source, { imemK: 7, dmemK: 6, max: 20000 });
    paired.push((2 * r.pairs) / r.retired);
    console.log(`${bm.id}: CPI ${(r.cycles / r.retired).toFixed(2)} (${r.retired} instructions, ${r.cycles} cycles, ${r.pairs} pairs)`);
  }, 900000);
  it('step 2 quotes the share of instructions that go in pairs', () => {
    const pct = (x: number) => Math.round(100 * x);
    const text = chOoo.steps.find((s) => s.title === 'Two at a time, in order')!.body.replace(/\s+/g, ' ');
    expect(paired.length).toBe(5);
    expect(text).toContain(`Only ${pct(Math.min(...paired))} to ${pct(Math.max(...paired))} %`);
  });
});

describe('chapter 26, step 2', () => {
  it('its program runs on the scene\'s CPU and leaves a · b = 72 at 0x80', () => {
    const words = assemble(DUAL_SOURCE).words;
    const iss = new ISS(words, { dmemWords: 64 });
    iss.run(10000);
    expect(iss.dmem[32]).toBe(72);
    expect(cosim(DUAL_SOURCE, { dmemK: 6 }).pairs).toBeGreaterThan(0);
  }, 300000);

  it('quotes the measured cost and CPI', () => {
    const cpu = (id: string) => RESULTS.cpus.find((c) => c.id === id)!;
    const two = cpu('pipe-2w'), one = cpu('pipe-m-bal-bp');
    const text = chOoo.steps.find((s) => s.title === 'Two at a time, in order')!.body.replace(/\s+/g, ' ');
    const n = (x: number) => x.toLocaleString('en-US').replace(/,/g, ' ');
    const cpis = (c: typeof two) => c.runs.map((r) => `${r.bench} ${(r.cycles / r.instructions).toFixed(2)}`);
    expect(text).toContain(`${n(two.nands)} NANDs against ${n(one.nands)}`);
    expect(text).toContain(`+${Math.round(100 * (two.nands / one.nands - 1))} %`);
    expect(text).toContain(`period of ${two.period} NAND delays against ${one.period}`);
    expect(text).toContain(`CPI ${cpis(two).join(', ')} against`);
    expect(text).toContain(one.runs.map((r) => (r.cycles / r.instructions).toFixed(2)).join(', '));
  });
});
