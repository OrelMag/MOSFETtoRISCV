// Numbers quoted in chapters 19–23 (ch-system, ch-muldiv, ch-cache, ch-multicycle) that the text cannot compute in
// place: each is measured here and compared with the number the text quotes, so an edit to either fails.

import { describe, expect, it } from 'vitest';
import { kNands, sysNands, chIO, chTraps } from '../src/chapters/ch-system';
import { chMulDiv } from '../src/chapters/ch-muldiv';
import { chCache } from '../src/chapters/ch-cache';
import { chMulticycle } from '../src/chapters/ch-multicycle';
import { CSR_UNIT, TRAP_UNIT, popcount, systemCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { decode } from '../src/riscv/isa';
import { ISS, mExec } from '../src/riscv/iss';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { logicDepth, stats } from '../src/sim/stats';
import type { Chapter } from '../src/chapters/types';

const step = (c: Chapter, title: string) => {
  const s = c.steps.find((x) => x.title === title);
  if (!s) throw new Error(`${c.id}: no step "${title}"`);
  return s;
};
const text = (c: Chapter, title: string) => {
  const s = step(c, title);
  const q = s.challenge?.kind === 'quiz' ? s.challenge : undefined;
  return [s.body, q?.question, ...(q?.options ?? []), q?.explain].join(' ');
};
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('chapters 19–20: the system CPU', () => {
  it('measures the program ROM the same for any program, so sysNands may use an empty one', () => {
    const src = (id: string) => SYSTEM_PROGRAMS.find((p) => p.id === id)!.source;
    const hello = systemCpu(assemble(src('hello')).words);
    expect(stats(hello).nands).toBe(sysNands(false).all);
    const fact = systemCpu(assemble(M_PROGRAMS.find((p) => p.id === 'factorial')!.source).words, { m: true });
    expect(stats(fact).nands).toBe(sysNands(true).all);
  });

  it('quotes the CSR unit, trap unit and system decoder as about 10 000 NANDs', () => {
    const sysDec = systemCpu([]).netlist!().instances.find((i) => i.name === 'sys')!.def;
    const n = stats(CSR_UNIT).nands + stats(TRAP_UNIT).nands + stats(sysDec).nands;
    expect(chTraps.recap!.keep.join(' ')).toContain(`about ${kNands(n)} NANDs`);
    expect(text(chTraps, 'Inside the trap unit')).toContain(`about ${kNands(n)} NANDs`);
  });

  it('quotes the machine without its ROM in the recap', () => {
    expect(chIO.recap!.keep.join(' ')).toContain(`about ${kNands(sysNands(false).core)} NANDs without its program ROM`);
  });

  it('timer handler leaves the main loop\'s registers alone, as the text says', () => {
    const src = SYSTEM_PROGRAMS.find((p) => p.id === 'timer')!.source;
    const handler = src.slice(src.indexOf('handler:'));
    const loop = src.slice(src.indexOf('loop:'), src.indexOf('handler:'));
    expect(flat(text(chTraps, 'The timer interrupt'))).toContain('touches t1, t2 and s1');
    for (const r of ['t1', 't2', 's1']) { expect(handler).toContain(r); expect(loop).not.toContain(r); }
  });
});

describe('chapter 21: multiply and divide', () => {
  it('counts the 3:2 levels of a 32-bit popcount tree', () => {
    const rows = [32];
    while (rows[rows.length - 1] > 2) { const r = rows[rows.length - 1]; rows.push(2 * Math.floor(r / 3) + (r % 3)); }
    const t = text(chMulDiv, 'Counting ones');
    expect(t).toContain(rows.join(' → '));
    expect(t).toContain(`${rows.length - 1} full-adder levels`);
    expect(t).toContain(`${logicDepth(popcount(32))} gate delays deep`);
    expect(t).toContain(`${stats(popcount(32)).nands} NANDs and ${logicDepth(popcount(32))} delays for 32`);
  });

  it('gives the specified overflow result for −2³¹ / −1', () => {
    expect(mExec(4, 0x80000000, 0xffffffff)).toBe(0x80000000);
    expect(mExec(6, 0x80000000, 0xffffffff)).toBe(0);
    const q = chMulDiv.recap!.check!.find((c) => c.question.includes('−2³¹'))!;
    expect(q.options[q.answer]).toContain('0x80000000');
    expect(q.options[q.answer]).toContain('remainder 0');
  });

  it('compares the dividers with the cycle × delay products it quotes', () => {
    const t = text(chMulDiv, 'Dividers compared');
    expect(t).toContain(`7 cycles of 44 delays against 10 of 29: ${7 * 44} against ${10 * 29}`);
    expect(t).toContain(`19 of 44 against 34 of 31: ${19 * 44} against ${(34 * 31).toLocaleString('en-US').replace(/,/g, ' ')}`);
  });
});

describe('chapter 22: caches', () => {
  it('quotes the write-through miss count that its frozen cycles imply', () => {
    const t = flat(text(chCache, 'A cache in the pipeline'));
    const frozen = Number(/391 cycles, (\d+) frozen/.exec(t)![1]);
    expect(flat(text(chCache, 'Two ways and an LRU bit'))).toContain(`${frozen / 8} with the write-through cache`);
  });
});

describe('chapter 23: multicycle CPI', () => {
  // cycles per instruction class, from the state table (tests/multicycle.test.ts runs the gates against the ISS)
  const cyclesOf = (word: number) => {
    const n = decode(word).name;
    if (['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'lui', 'auipc'].includes(n)) return 3;
    if (['lb', 'lh', 'lw', 'lbu', 'lhu', 'jalr'].includes(n)) return 5;
    return 4;
  };
  const run = (source: string) => {
    const iss = new ISS(assemble(source).words);
    let cycles = 0;
    while (!iss.halted && iss.steps < 100000) cycles += cyclesOf(iss.step().word);
    return { steps: iss.steps, cycles };
  };

  it('quotes the gcd scene\'s CPI and the range over the sample programs', () => {
    const g = run(PROGRAMS.find((p) => p.id === 'gcd')!.source);
    const t = flat(text(chMulticycle, 'Was it worth it?'));
    expect(t).toContain(`${g.steps} instructions in ${g.cycles} cycles, ${(g.cycles / g.steps).toFixed(2)}`);
    const cpis = PROGRAMS.map((p) => run(p.source)).map((r) => r.cycles / r.steps);
    const lo = Math.min(...cpis).toFixed(1), hi = Math.max(...cpis).toFixed(1);
    expect(t).toContain(`${lo} to ${hi}`);
    expect(chMulticycle.recap!.keep.join(' ')).toContain(`CPI ${lo} to ${hi}`);
  });
});
