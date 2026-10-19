// Chapter 15's numbers, recomputed: every count the prose quotes comes from the compiler, the golden model or the
// gate-level CPU the scenes build.
import { describe, expect, it } from 'vitest';
import { chPython } from '../src/chapters/ch-python';
import { compilePy } from '../src/lang/compile';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { singleCycleCpu } from '../src/lib';
import { clockCycle } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { stats } from '../src/sim/stats';
import { PY_DMEM_K, PY_IMEM_K, pyCompile, pyProfile } from '../src/widgets/python';

const prose = chPython.steps.map((s) => s.body).join('\n') + chPython.recap!.keep.join('\n');
const src = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!.source;
const quoted = (n: number | string) => expect(prose.replace(/\s+/g, ' ')).toContain(String(n));

describe('chapter 15: the numbers in the text', () => {
  it('sum: 4 lines, 12 instructions, total in s0 and i in s1', () => {
    const c = pyCompile(src('sum'));
    expect(c.words.length).toBe(12);
    quoted('become 12 instructions');
    expect(c.layout!.homes.filter((h) => !h.hidden).map((h) => `${h.name}:${h.reg}`)).toEqual(['total:s0', 'i:s1']);
  });

  it('collatz 938 cycles; gcd: a % b about 240 cycles a call, 1 472 of 1 545', () => {
    expect(pyProfile(pyCompile(src('collatz'))).steps).toBe(938);
    quoted('938 cycles');
    const c = pyCompile(src('gcd')), p = pyProfile(c);
    expect(p.steps).toBe(1545);
    const line = src('gcd').split('\n').findIndex((l) => l.includes('t = a % b')) + 1;
    const total = (p.own.get(line) ?? 0) + (p.rt.get(line) ?? 0);
    expect(total).toBe(1472);
    quoted('1 472 of the program\'s 1 545');
    const calls = p.own.get(line)! / c.pcsOfPy(line).length; // every instruction of the line runs once a call
    expect(Math.abs(total / calls - 240)).toBeLessThan(10);
  });

  it('fib(7): 13, 41 calls, 721 cycles, at most seven frames of two words', () => {
    const c = pyCompile(src('fib'));
    const iss = new ISS(c.words, { dmemWords: 2 ** PY_DMEM_K, imemWords: 2 ** PY_IMEM_K });
    const fib = c.assembled!.labels.get('fib')!;
    let calls = 0, minSp = 1e9;
    while (!iss.halted) { if (iss.pc === fib) calls++; iss.step(); minSp = Math.min(minSp, iss.x[2]); }
    expect(iss.steps).toBe(721);
    expect(calls).toBe(41);
    quoted('721 cycles for its 13');
    expect(c.asm).toMatch(/fib:\n\s+addi sp, sp, -8\n/);
    // seven frames of ra and n, plus the t0 words waiting across the second calls
    expect(c.layout!.stackTop - minSp).toBeGreaterThanOrEqual(7 * 8);
    expect(c.layout!.stackTop - minSp).toBeLessThan(8 * 12);
  });

  it('the CPU: 100 979 NANDs, 403 916 transistors; one total += i is about 25 000 toggles', () => {
    const c = pyCompile(src('sum'));
    const def = singleCycleCpu(c.words, { imemK: PY_IMEM_K, dmemK: PY_DMEM_K });
    const st = stats(def);
    expect([st.nands, st.transistors]).toEqual([100979, 403916]);
    quoted('100 979 NANDs');
    quoted('403 916 transistors');
    const sim = new GateSim(flatten(def));
    sim.setInput('clk', 0);
    sim.settle();
    sim.countToggles();
    const iss = new ISS(c.words, { dmemWords: 2 ** PY_DMEM_K, imemWords: 2 ** PY_IMEM_K });
    const line = 3;
    let runs = 0, toggles = 0;
    while (!iss.halted) {
      const py = c.pyOfPc(iss.pc);
      const before = sim.toggles!.reduce((a, b) => a + b, 0);
      iss.step();
      clockCycle(sim);
      if (py === line) { runs++; toggles += sim.toggles!.reduce((a, b) => a + b, 0) - before; }
    }
    expect(runs).toBe(10);
    expect(Math.abs(toggles / runs - 25000)).toBeLessThan(1000);
    quoted('about 25 000 nets');
  }, 60000);

  it('every sample fits the chapter\'s ROM and data memory', () => {
    for (const p of PY_PROGRAMS) {
      const c = compilePy(p.source, { dmemWords: 2 ** PY_DMEM_K });
      expect(c.error, p.id).toBeNull();
      expect(c.words.length, p.id).toBeLessThanOrEqual(2 ** PY_IMEM_K);
    }
  });
});
