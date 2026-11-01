// Chapter 13's first step, recomputed: the program the stepper runs does what the prose says it does.
import { describe, expect, it } from 'vitest';
import { chIsa, FETCH_LOOP } from '../src/chapters/ch-cpu';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';

describe('chapter 13: the fetch–decode–execute loop', () => {
  it('sums 3 + 2 + 1 into a1, stores it at 0, branches back from 0x10 to 0x08 twice, then halts', () => {
    const r = assemble(FETCH_LOOP);
    expect(r.errors).toEqual([]);
    expect(r.words.length).toBe(7);
    const iss = new ISS(r.words);
    const back: number[] = [];
    for (let i = 0; i < 100 && !iss.halted; i++) {
      const s = iss.step();
      if (iss.pc !== s.pc + 4 && !s.halted) back.push(s.pc, iss.pc);
    }
    expect(iss.halted).toBe(true);
    expect(back).toEqual([0x10, 0x08, 0x10, 0x08]);
    expect(iss.x[11]).toBe(6);
    expect(iss.dmem[0]).toBe(6);
    expect(chIsa.steps[0].body).toContain('0x10 to 0x08 twice');
  });
});
