import { describe, expect, it } from 'vitest';
import { ABI } from '../src/riscv/isa';
import { ABI_GROUPS, expand, PSEUDOS, SUM_RUN } from '../src/widgets/abi';

describe('chapter 13: pseudo-instructions and the calling convention', () => {
  it('the expansions the chapter quotes', () => {
    expect(expand('li t0, 5').words).toEqual(['addi t0, zero, 5']);
    expect(expand('li t0, 0x12345').words).toHaveLength(2);
    expect(expand('li t0, 0x12345000').words).toEqual(['lui t0, 0x12345']);
    expect(expand('ret').words).toEqual(['jalr zero, 0(ra)']);
    expect(expand('call L').words).toHaveLength(2);
    expect(expand('la a0, L').words).toHaveLength(2);
    expect(expand('mv a0, a1').words).toEqual(['addi a0, a1, 0']);
    for (const p of PSEUDOS) expect(expand(p).error, p).toBeUndefined();
  });
  it('the register groups name each of the 32 registers once', () => {
    const all = ABI_GROUPS.flatMap((g) => g.regs).sort();
    expect(all).toEqual([...ABI].sort());
  });
  it('the recursive example: sumto(3) = 6, four frames of 16 bytes, 58 instructions', () => {
    expect(SUM_RUN.result).toBe(6);
    expect(SUM_RUN.depth).toBe(64);
    expect(SUM_RUN.instrs).toBe(58);
    expect(SUM_RUN.mem.map(([a]) => a)).toContain(124);
  });
});

describe('register runs', () => {
  it('compress consecutive numbers into ranges', async () => {
    const { regRuns } = await import('../src/widgets/abi');
    expect(regRuns(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'])).toEqual(['a0–a7 (x10–x17)']);
    expect(regRuns(['t0', 't1', 't2', 't3', 't4', 't5', 't6'])).toEqual(['t0–t2 (x5–x7)', 't3–t6 (x28–x31)']);
  });
});
