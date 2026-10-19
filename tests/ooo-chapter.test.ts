// Chapter 25's quoted numbers, recomputed from the models (riscv/ilp.ts, ooomodel.ts, scoreboard.ts), so the prose
// cannot drift from them.

import { describe, expect, it } from 'vitest';
import { chOoo } from '../src/chapters/ch-ooo';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { dataflow, traceOf } from '../src/riscv/ilp';
import { oooRun, type OooConfig } from '../src/riscv/ooomodel';
import { OOO_PROGRAMS, SCOREBOARD_SOURCE } from '../src/riscv/oooprograms';
import { Scoreboard } from '../src/riscv/scoreboard';
import RESULTS from '../src/bench/results.json';

const OPTS = { dmemWords: 64, imemWords: 128 };
const words = (id: string) => assemble(OOO_PROGRAMS.find((p) => p.id === id)?.source ?? BENCHMARKS.find((b) => b.id === id)!.source).words;
const cpi = (id: string, cfg: Partial<OooConfig> = {}) => { const s = oooRun(words(id), cfg, OPTS); return s.cycles / s.instructions; };
const text = [...chOoo.steps.map((s) => s.body), ...chOoo.recap!.keep].join(' ').replace(/\s+/g, ' ');
const quoted = (v: string) => expect(text, v).toContain(v);
const LONG = { lat: { alu: 1, load: 4, mul: 4, div: 19 } };

describe('chapter 25: the numbers it quotes', () => {
  it('dataflow ceilings', () => {
    const ipc = (id: string) => dataflow(traceOf(words(id), OPTS)).ipc;
    expect(ipc('fib').toFixed(1)).toBe('10.3');
    expect(ipc('sort').toFixed(1)).toBe('10.6');
    expect(Math.round(ipc('matmul'))).toBe(87);
    expect(ipc('crc').toFixed(1)).toBe('3.8');
    for (const v of ['fib 10.3', 'sort 10.6', 'matmul 87', 'crc 3.8']) quoted(v);
  });

  it('the best pipeline\'s mean CPI on the benchmark set', () => {
    const cpu = RESULTS.cpus.find((c) => c.id === 'pipe-bal-bp')!;
    const runs = cpu.runs.filter((r) => ['fib', 'sort', 'matmul', 'crc'].includes(r.bench));
    expect((runs.reduce((a, r) => a + r.cycles / r.instructions, 0) / runs.length).toFixed(2)).toBe('1.26');
    quoted('CPI 1.26');
  });

  it('in order against out of order', () => {
    expect(cpi('dot', { inorder: true }).toFixed(2)).toBe('1.14');
    expect(cpi('dot').toFixed(2)).toBe('0.91');
    expect(cpi('dot', { inorder: true, ...LONG }).toFixed(2)).toBe('1.60');
    expect(cpi('dot', LONG).toFixed(2)).toBe('1.10');
    expect(cpi('chains', { inorder: true }).toFixed(2)).toBe('4.13');
    expect(cpi('chains').toFixed(2)).toBe('3.72');
    for (const v of ['1.14 against 0.91', '1.60 against 1.10', '4.13 against 3.72']) quoted(v);
  });

  it('the scoreboard: Hennessy and Patterson\'s table', () => {
    const sb = new Scoreboard(assemble(SCOREBOARD_SOURCE).words, { alu: 2, load: 1, mul: 10, div: 40 });
    sb.run();
    const add = sb.ins[5];
    expect([add.issue, add.read, add.exec, add.write]).toEqual([13, 14, 16, 22]);
    expect(sb.ins[4].read).toBe(21);
    expect(sb.ins[1].issue).toBe(5);
    quoted('cycle 16');
    quoted('cycle 22');
  });

  it('speculation on fib', () => {
    const btb = oooRun(words('fib'), { predict: 'btb' }, OPTS), core = oooRun(words('fib'), {}, OPTS);
    expect(btb.mispredicts).toBe(613);
    expect(core.mispredicts).toBe(287);
    expect((btb.cycles / btb.instructions).toFixed(2)).toBe('1.29');
    expect((core.cycles / core.instructions).toFixed(2)).toBe('0.99');
    expect(cpi('fib', { recover: 'resolve' }).toFixed(2)).toBe('0.92');
    expect(cpi('fib', { predict: 'perfect' }).toFixed(2)).toBe('0.63');
    for (const v of ['613', '287', 'from 1.29 to 0.99', '0.92', '0.63']) quoted(v);
  });
});
