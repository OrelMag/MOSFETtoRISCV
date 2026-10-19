// The encoding designer's analysis: clashes, shadows, the opcode map, coverage and the decoder's cost.

import { describe, expect, it } from 'vitest';
import { andCost, andDepth, analyze, groupPattern } from '../src/isa/design';
import { ISA4_PRESET } from '../src/isa/presets';
import type { IsaDoc } from '../src/isa/table';
import { andN } from '../src/lib/combinational';
import { logicDepth, stats } from '../src/sim/stats';

const TOY: IsaDoc = {
  id: 'toy', name: 'TOY16', wordBits: 16,
  operands: { d: { kind: 'reg', names: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] }, s: { kind: 'reg', names: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] }, i: { kind: 'imm', signed: true } },
  instrs: [
    { mnemonic: 'add', operands: ['d', 's'], pattern: '0000 ddd sss 000000' },
    { mnemonic: 'addi', operands: ['d', 's', 'i'], pattern: '0001 ddd sss iiiiii' },
    { mnemonic: 'ld', operands: ['d', 's', 'i'], pattern: '0010 ddd sss iiiiii' },
    { mnemonic: 'halt', operands: [], pattern: '1111 ------------' },
    { mnemonic: 'nop', operands: [], pattern: '1111 000000000000' },
  ],
};

describe('encoding designer analysis', () => {
  it('the decoder cost model is the library AND tree', () => {
    for (const k of [2, 3, 4, 5, 8, 9]) {
      expect(andCost(k), `nands ${k}`).toBe(stats(andN(k)).nands);
      expect(andDepth(k), `depth ${k}`).toBe(logicDepth(andN(k)));
    }
  });

  it('a special case shadows its general pattern; equal ones clash', () => {
    const a = analyze(TOY);
    expect(a.clashes).toEqual([]);
    expect(a.shadows).toEqual([{ general: 3, special: 4 }]);
    const clash = analyze({ ...TOY, instrs: [...TOY.instrs.slice(0, 2), { ...TOY.instrs[2], pattern: '0001 ddd sss iiiiii' }] });
    expect(clash.clashes.map((c) => [c.a, c.b])).toEqual([[1, 2]]);
    expect(clash.cells.find((c) => c.value === 1)!.clash).toBe(true);
  });

  it('the opcode map sits on the bits the patterns fix, and counts what decodes', () => {
    const a = analyze(TOY);
    expect(a.window).toEqual({ hi: 15, lo: 12 });
    expect(a.cells.filter((c) => c.rows.length).map((c) => c.value)).toEqual([0, 1, 2, 15]);
    // add: 2^6 words; addi, ld: 2^12 each; halt: 2^12 (nop inside it)
    expect(a.decoded).toBe(64 + 3 * 4096);
    expect(a.exact).toBe(true);
  });

  it('decoder: one AND per instruction, NOT of the shadowing ones, shared inverters', () => {
    const d = analyze(TOY).decoder;
    // inputs: add 10 fixed bits, addi 4, ld 4, halt 4 + NOT nop, nop 16
    expect(d.inputs).toEqual([10, 4, 4, 5, 16]);
    expect(d.ands).toBe([10, 4, 4, 5, 16].reduce((n, k) => n + andCost(k), 0));
    expect(d.nots).toBe(16 + 1); // every bit is a fixed 0 somewhere; nop's match inverted once
    expect(d.nands).toBe(d.ands + d.nots);
  });

  it('the 4-bit preset has no clash and a decoder', () => {
    const a = analyze(ISA4_PRESET);
    expect(a.clashes).toEqual([]);
    expect(a.decoder.nands).toBeGreaterThan(0);
    expect(a.decoded).toBeLessThanOrEqual(a.total);
  });

  it('patterns are written in groups of 4', () => {
    expect(groupPattern('0001dddsssiiiiii')).toBe('0001 ddds ssii iiii');
  });
});
