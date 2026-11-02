import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { hardwareGaps, hwFeaturesOf } from '../src/riscv/hwgaps';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { PIPE_M_PROGRAMS } from '../src/riscv/pmprograms';
import { CACHE_CPU_PROGRAMS } from '../src/riscv/cprograms';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
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
  it('data lines are not instructions', () => {
    expect(hardwareGaps(assemble('.word 0x02b50533\nlw a0, 0(zero)'), {})).toEqual([]);
  });
  it('every sample program uses only what the scene it is shown on implements (the note is for the learner own edits)', () => {
    const sets: [string, typeof PROGRAMS, Parameters<typeof hwFeaturesOf>[0]][] = [
      ['PROGRAMS', PROGRAMS, {}], ['M_PROGRAMS', M_PROGRAMS, { system: true, m: true }], ['PIPE_M_PROGRAMS', PIPE_M_PROGRAMS, { m: true }],
      ['CACHE_CPU_PROGRAMS', CACHE_CPU_PROGRAMS, {}], ['F_PROGRAMS', F_PROGRAMS, { fpu: true }], ['SYSTEM_PROGRAMS', SYSTEM_PROGRAMS, { system: true }],
    ];
    for (const [name, list, o] of sets) for (const p of list) expect(hardwareGaps(assemble(p.source), hwFeaturesOf(o)), `${name}/${p.id}`).toEqual([]);
  });
});
