import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { measureClasses } from '../src/riscv/cycletime';
import { flatten } from '../src/sim/flatten';
import { analyzeTiming } from '../src/sim/timing';
import { controlRows, PERIOD } from '../src/widgets/cpucost';
import { tick } from './yieldtick';

describe('chapter 14: the control table', () => {
  it('is CONTROL evaluated on one instruction per class', () => {
    const r = Object.fromEntries(controlRows().map((x) => [x.asm.split(' ')[0], x]));
    expect([r.add.regWrite, r.add.srcB, r.add.result, r.add.alu]).toEqual([1, 'rs2', 'ALU', 'ADD']);
    expect([r.sub.alu, r.srai.alu, r.addi.srcB, r.addi.imm]).toEqual(['SUB', 'SRA', 'imm', 'I']);
    expect([r.lw.result, r.lw.regWrite, r.lw.memWrite, r.lw.alu]).toEqual(['mem', 1, 0, 'ADD']);
    expect([r.sw.regWrite, r.sw.memWrite, r.sw.imm]).toEqual([0, 1, 'S']);
    expect([r.beq.branch, r.beq.regWrite, r.beq.alu, r.beq.imm]).toEqual([1, 0, 'SUB', 'B']);
    expect([r.jal.jump, r.jal.result, r.jal.imm, r.jalr.jalr, r.jalr.result]).toEqual([1, 'PC + 4', 'J', 1, 'PC + 4']);
    expect([r.lui.result, r.lui.imm, r.auipc.srcA, r.auipc.alu]).toEqual(['imm', 'U', 'PC', 'ADD']);
  });
});

describe('chapter 14: what sets the period', () => {
  for (const adder of ['rca', 'ks'] as const) {
    it(`${adder}: static path and the stage ribbon`, () => {
      const rep = analyzeTiming(flatten(singleCycleCpu(assemble('li a0, 1\nhalt: j halt').words, { adder }), { mode: 'gate' }))!;
      const p = PERIOD[adder];
      expect(rep.period).toBe(p.pc);
      expect(Object.fromEntries(rep.byCapture.map((c) => [c.inst, c.period]))).toEqual({ pc: p.pc, rf: p.rf, dm: p.dm });
      expect(p.stages.reduce((a, [, d]) => a + d, 0)).toBe(p.pc);
      expect(rep.stages.map((s) => s.inst)).toEqual(['pc', 'imem', 'ctl', 'imm', 'srcB', 'alu', 'npc', 'pcmux', 'pc']);
    });
  }
  it('measured settle times stay under the static path, and a Kogge–Stone ALU is faster', async () => {
    const a = await measureClasses('rca', [1], 40, tick), b = await measureClasses('ks', [1], 40, tick);
    expect(a.worst).toBeLessThanOrEqual(a.period);
    expect(b.worst).toBeLessThanOrEqual(b.period);
    expect(b.worst).toBeLessThan(a.worst);
    for (const c of a.classes.filter((x) => ['R', 'I', 'LOAD', 'STORE', 'BRANCH', 'LUI'].includes(x.cls))) expect(c.n, c.cls).toBeGreaterThan(0);
    const all = a.classes.filter((c) => c.n), mean = all.reduce((s, c) => s + c.mean * c.n, 0) / all.reduce((s, c) => s + c.n, 0);
    expect(mean).toBeGreaterThan(0.3 * a.period); // "around half of the static bound" in the chapter
    expect(mean).toBeLessThan(0.65 * a.period);
  }, 120000);
});
