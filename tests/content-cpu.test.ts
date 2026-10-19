// Chapters 11–17 quote measured numbers: each is measured here and found in the chapter's text, so an edit to
// either the hardware or the prose that breaks the match fails (content review 2026-10-18, slice j-cpu).
import { describe, expect, it } from 'vitest';
import { chAlu, chIsa, chRegfile, chSingleCycle } from '../src/chapters/ch-cpu';
import { chFastAdders } from '../src/chapters/ch-perf';
import { chPipeline } from '../src/chapters/ch-pipe';
import { chPipePay } from '../src/chapters/ch-pipe2';
import type { Chapter } from '../src/chapters/types';
import { CONTROL, addSubFast, alu, isZero, koggeStone, muxTree, pipelinedCpu, singleCycleCpu } from '../src/lib';
import { withoutParts } from '../src/lib/tech';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { disasm } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';

/** Everything a chapter says (bodies, recap, quizzes), whitespace collapsed. */
const text = (c: Chapter) => JSON.stringify(c).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
const words = (id: string) => assemble(PROGRAMS.find((p) => p.id === id)!.source).words;
const W0 = words(PROGRAMS[0].id);
const core = (d: Parameters<typeof withoutParts>[0]) => stats(withoutParts(d, ['imem'])).nands;
const period = (d: Parameters<typeof flatten>[0]) => analyzeTiming(flatten(d))!;

describe('ALU control (finding 1)', () => {
  const OP = { R: 0x33, I: 0x13, LOAD: 0x03, STORE: 0x23, BRANCH: 0x63, JALR: 0x67, AUIPC: 0x17 };
  const sim = simulate(CONTROL);
  const ctl = (op: number, f3: number, f7: number) => evalOnce(sim, [op, f3, f7])[9];
  it('is {funct7[5], funct3} only for R-type; the control unit decides the rest', () => {
    expect(ctl(OP.R, 0, 0x20)).toBe(0b1000); // sub
    expect(ctl(OP.R, 5, 0x20)).toBe(0b1101); // sra
    expect(ctl(OP.I, 0, 0x7f)).toBe(0b0000); // addi a0, a0, -1: bit 30 is imm[10], still ADD
    expect(ctl(OP.I, 5, 0x20)).toBe(0b1101); // srai
    expect(ctl(OP.LOAD, 2, 0x7f)).toBe(0b0000); // lw with a negative offset: ADD, not SLT
    expect(ctl(OP.STORE, 2, 0x7f)).toBe(0b0000);
    expect(ctl(OP.JALR, 0, 0x7f)).toBe(0b0000);
    expect(ctl(OP.AUIPC, 7, 0x7f)).toBe(0b0000);
    expect(ctl(OP.BRANCH, 1, 0x7f)).toBe(0b1000); // bne: SUB
  });
  it('every place quoting the formula also says where it does not apply', () => {
    for (const c of [chAlu, chSingleCycle]) {
      const t = text(c);
      expect(t).toContain('srai');
      expect(t).not.toContain('almost empty');
    }
    expect(chAlu.goals!.join(' ')).toMatch(/R-type/);
    expect(chAlu.recap!.keep.join(' ')).toMatch(/srai/);
    expect(chSingleCycle.recap!.keep.join(' ')).toMatch(/srai.*ADD.*SUB/);
  });
});

describe('register file and single-cycle CPU (findings 9, 10, 11)', () => {
  it('the register file is nearly half of the 48 000-NAND CPU', () => {
    const rf = stats(singleCycleCpu(W0).netlist!().instances.find((i) => i.name === 'rf')!.def).nands;
    const c = core(singleCycleCpu(W0));
    expect(Math.round(c / 1000)).toBe(48);
    expect(rf / c).toBeGreaterThan(0.45);
    expect(rf / c).toBeLessThan(0.5);
    expect(text(chRegfile)).toContain('about 48 000');
  });
  it('the pseudo-instructions credited to x0 use x0; mv does not', () => {
    const fields = (src: string) => assemble(src).words.map((w) => ({ rd: (w >>> 7) & 31, rs1: (w >>> 15) & 31, rs2: (w >>> 20) & 31 }));
    for (const s of ['li a0, 5', 'nop', 'j 0', 'beqz a0, 0', 'neg a0, a1', 'ret']) {
      const f = fields(s)[0];
      expect([f.rd, f.rs1, f.rs2], s).toContain(0);
    }
    const mv = fields('mv a0, a1')[0];
    expect(mv.rd === 0 || mv.rs1 === 0).toBe(false);
    expect(chRegfile.goals!.join(' ')).not.toMatch(/\bmv\b/);
  });
  it('static timing: a branch sets 155 (ripple) and 103 (Kogge–Stone); lw is shorter here', () => {
    const r = period(singleCycleCpu(W0)), k = period(singleCycleCpu(W0, { adder: 'ks' }));
    expect([r.period, k.period]).toEqual([155, 103]);
    expect(r.byCapture.find((c) => c.inst === 'rf')!.period).toBeLessThan(r.period); // the lw path ends at rf
    expect(text(chFastAdders)).toContain('155 NAND delays. Kogge–Stone adders cut it to 103');
    expect(text(chSingleCycle)).toContain('With realistic memories');
  });
});

describe('ISA details (finding 15, addressing aside)', () => {
  it('li rounds the upper part when bit 11 is set, as the text shows', () => {
    const dis = assemble('li a0, 0x12845').words.map((w, i) => disasm(w, 4 * i));
    expect(dis).toEqual(['lui a0, 0x13', 'addi a0, a0, -1979']);
    const t = text(chIsa);
    for (const d of dis) expect(t).toContain(`<code>${d}</code>`);
    expect(0x13000 - 0x7bb).toBe(0x12845);
  });
});

describe('faster adders (findings 8, 12)', () => {
  it('a KS ALU: the result mux and zero detector add as much again as the adder', () => {
    const ks = logicDepth(koggeStone(32))!, rest = logicDepth(muxTree(3, 32, 16))! + logicDepth(isZero(32))!;
    expect(Math.abs(rest - ks)).toBeLessThanOrEqual(1);
    expect(logicDepth(addSubFast(32))!).toBeLessThan(logicDepth(alu(32, 'ks'))! / 2);
  });

  /** The sum program on the ripple single-cycle CPU, clocked as Stage does with a fixed period (view/stage.ts rise/fall). */
  function overclock(P: number, cycles: number) {
    const w = words('sum');
    const sim = new GateSim(flatten(singleCycleCpu(w)));
    sim.reset('zero');
    sim.setInput('clk', 0);
    sim.settle();
    const iss = new ISS(w);
    let next = sim.time, late = 0, mismatch: { reg: number; hw: number; model: number } | null = null, a0AtHalt = -1;
    for (let c = 0; c < cycles; c++) {
      const E = Math.max(sim.time, next);
      sim.runUntil(E);
      if (sim.busy()) late++;
      sim.setInput('clk', 1);
      sim.runUntil(E + Math.ceil(P / 2));
      if (!iss.halted) {
        iss.step();
        const x = cpuState(sim).x;
        const d = x.findIndex((v, i) => v !== iss.x[i]);
        if (d >= 0 && !mismatch) mismatch = { reg: d, hw: x[d], model: iss.x[d] };
        if (iss.halted) a0AtHalt = x[10];
      }
      sim.setInput('clk', 0);
      sim.runUntil(E + P);
      next = E + P;
    }
    return { late, mismatch, a0AtHalt, state: cpuState(sim) };
  }
  it('overclocking the sum program: clean at 150, one early edge but right at 140, a0 = 66 at 130', () => {
    const a = overclock(150, 40), b = overclock(140, 40), c = overclock(130, 120);
    expect([a.late, a.mismatch, a.a0AtHalt]).toEqual([0, null, 55]);
    expect([b.late, b.mismatch, b.a0AtHalt]).toEqual([1, null, 55]);
    expect(c.mismatch).toEqual({ reg: 10, hw: 66, model: 55 });
    expect(c.state.dmem[0]).toBe(0); // never reaches the store: the loop runs on
    expect(c.state.pc).toBeLessThan(0x18);
    const t = text(chFastAdders);
    expect(t).toContain('at 150 every edge is clean');
    expect(t).toContain('a0 = 66 instead of 55');
  }, 60000);
});

describe('pipelines (findings 2–7)', () => {
  const cpiOf = (id: string, o: Parameters<typeof pipelinedCpu>[1]) => {
    const w = words(id);
    const sim = new GateSim(flatten(pipelinedCpu(w, o)));
    sim.setInput('clk', 0);
    sim.settle();
    const iss = new ISS(w);
    let cycles = 0;
    while (!iss.halted && cycles < 3000) {
      const r = retiring(sim);
      clockCycle(sim);
      cycles++;
      if (r) iss.step();
    }
    return cycles / iss.steps;
  };

  it('chapter 16: E is ~7× (ripple) / 4.4× (KS) the other stages, and the pipeline loses', () => {
    const r = period(pipelinedCpu(W0)), k = period(pipelinedCpu(W0, { adder: 'ks' }));
    expect([r.period, k.period]).toEqual([145, 93]);
    const others = Math.max(...r.byCapture.filter((c) => ['MW', 'rf', 'dm'].includes(c.inst)).map((c) => c.period));
    expect(others).toBe(21);
    expect(Math.round(r.period / others)).toBe(7);
    expect((k.period / others).toFixed(1)).toBe('4.4');
    const cpi = cpiOf('fib', {});
    expect(cpi.toFixed(2)).toBe('1.34');
    expect(Math.round(145 * cpi)).toBe(194);
    const t = text(chPipeline);
    expect(t).toContain('145 × CPI 1.34 on fib is about 194');
    expect(t).toContain('about 7× slower');
    expect(t).not.toContain('barely pays');
  }, 120000);

  it('chapter 17: periods, the path through the comparator, and the price of the BTB', () => {
    const bal = pipelinedCpu(W0, { adder: 'ks', balanced: true }), pred = pipelinedCpu(W0, { adder: 'ks', balanced: true, predictor: true });
    const tb = period(bal), tp = period(pred);
    expect([period(pipelinedCpu(W0, { balanced: true })).period, tb.period, tp.period]).toEqual([103, 59, 70]);
    // the 59-delay path: forwarding → branch comparator → flush of ID/EX, not the ALU
    expect(tb.stages.map((s) => s.inst)).toContain('bcmp');
    expect(tb.stages.at(-1)!.inst).toBe('DE');
    expect(tb.byCapture.find((c) => c.inst === 'EM')!.period).toBe(51);
    const t = text(chPipePay);
    expect(t).toContain('The ALU path into EX/MEM is now 51');
    // balancing: comparator + jalr adder ≈ what the core grows by
    const basic = core(pipelinedCpu(W0, { adder: 'ks' })), cb = core(bal), cp = core(pred);
    const added = cb - basic;
    expect(Math.abs(added - 2100)).toBeLessThan(100);
    expect(t).toContain('about 2 100 more NANDs');
    // the BTB: core +38 %
    expect(Math.round(((cp - cb) / cb) * 100)).toBe(38);
    expect(t).toContain('the core grows by 38 %');
    const sp = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');
    expect(t).toContain(`from ${sp(cb)} to ${sp(cp)} NANDs`);
  }, 120000);

  it('chapter 17: prediction is about a draw (period +19 %, CPI −14 %), wins fib and gcd, loses mul', () => {
    const ids = ['fib', 'gcd', 'mul'];
    const plain = ids.map((id) => cpiOf(id, { adder: 'ks', balanced: true }));
    const pred = ids.map((id) => cpiOf(id, { adder: 'ks', balanced: true, predictor: true }));
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(plain).toFixed(2)).toBe('1.51');
    expect(avg(pred).toFixed(2)).toBe('1.30');
    expect(Math.round((70 / 59 - 1) * 100)).toBe(19);
    expect(Math.round((1 - avg(pred) / avg(plain)) * 100)).toBe(14);
    expect([Math.round(59 * avg(plain)), Math.round(70 * avg(pred))]).toEqual([89, 91]);
    const wins = ids.map((_, i) => 70 * pred[i] < 59 * plain[i]);
    expect(wins).toEqual([true, true, false]);
    const t = text(chPipePay);
    expect(t).toContain('period +19 % (59 → 70), CPI −14 % (1.51 → 1.30)');
    expect(t).toContain('(89 against 91');
    expect(t).not.toContain('much lower CPI');
  }, 120000);
});
