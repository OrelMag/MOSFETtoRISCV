import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { hardwareGaps } from '../src/riscv/hwgaps';
import { PROGRAMS } from '../src/riscv/programs';

describe('hardware gaps', () => {
  it('`.` is the current address', () => {
    const r = assemble('addi a0, zero, 1\nj .\nbeq a0, a0, .');
    expect(r.errors).toEqual([]);
    expect(r.words[1]).toBe(assemble('x: j x').words[0]);
  });
  it('notes M and sub-word instructions on a plain RV32I CPU', () => {
    const r = assemble('mul a0, a1, a2\nlb a0, 0(zero)\nsb a0, 0(zero)\nlw a0, 0(zero)\nadd a0, a0, a0');
    const g = hardwareGaps(r, {});
    expect(g.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(g[0].message).toContain('M extension');
    expect(hardwareGaps(r, { m: true, subword: true })).toEqual([]);
  });
  it('the chapter programs use nothing the single-cycle CPU lacks', () => {
    for (const p of PROGRAMS) expect(hardwareGaps(assemble(p.source), {}), p.name).toEqual([]);
  });
});
