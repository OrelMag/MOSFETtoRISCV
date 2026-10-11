// Custom ISA tables: the engine (assembler, disassembler, fields, checks) and the 4-bit preset,
// which must agree with the 4-bit CPU's own assembler and disassembler on every word.

import { describe, expect, it } from 'vitest';
import { assemble4 } from '../src/isa4/asm4';
import { decode4, disasm4, fields4 } from '../src/isa4/isa4';
import { PROGRAMS4 } from '../src/isa4/programs4';
import { BUILTIN_ISAS, isaOf, tableIsa } from '../src/isa/isa';
import { ISA4_PRESET } from '../src/isa/presets';
import { type IsaDoc, IsaTable } from '../src/isa/table';

const T4 = new IsaTable(ISA4_PRESET);

describe('the 4-bit preset table', () => {
  it('has no problems', () => {
    expect(T4.problems).toEqual([]);
  });

  it('disassembles every 16-bit word exactly as disasm4', () => {
    for (let w = 0; w < 0x10000; w++) if (T4.disasm(w) !== disasm4(w)) expect(T4.disasm(w), w.toString(16)).toBe(disasm4(w));
  });

  it('assembles every sample to the same words, lines and labels as assemble4', () => {
    for (const p of PROGRAMS4) {
      const a = T4.assemble(p.src), b = assemble4(p.src);
      expect(a.errors, p.id).toEqual([]);
      expect(a.words, p.id).toEqual(b.words);
      expect(a.lines, p.id).toEqual(b.lines);
      expect([...a.labels], p.id).toEqual([...b.labels]);
    }
  });

  it('assembles its own disassembly back to the word (every word an instruction names)', () => {
    let n = 0;
    for (let w = 0; w < 0x10000; w++) {
      const t = T4.disasm(w);
      if (t.startsWith('.word')) continue;
      const r = T4.assemble(t);
      expect(r.errors, t).toEqual([]);
      // '-' bits assemble as 0: the word comes back with its don't-care bits cleared
      const m = T4.match(w)!;
      expect(r.words[0], t).toBe(m.value | (w & ~m.mask & [...m.bits.values()].flat().reduce((x, b) => x | (1 << b), 0)));
      n++;
    }
    expect(n).toBeGreaterThan(20000);
  });

  it('reports the same lines as errors', () => {
    const src = '  LDM 16\n  ADD R16\n  JUN nowhere\n  FOO\n  JCN XX, 0';
    expect(T4.assemble(src).errors.map((e) => e.line)).toEqual(assemble4(src).errors.map((e) => e.line));
  });

  it('fields: the opcode runs and the operands, as wide as the word', () => {
    expect(T4.fields(0x7314)).toEqual([
      { name: 'opcode', bits: 4, value: 7, kind: 'op' }, { name: 'r', bits: 4, value: 3, kind: 'reg' }, { name: 'a', bits: 8, value: 0x14, kind: 'imm' },
    ]);
    expect(T4.fields(0x1914).map((f) => f.kind)).toEqual(['op', 'cond', 'imm']);
    for (const w of [0x0000, 0x2e00, 0xfb00, 0x4025]) expect(T4.fields(w).reduce((s, f) => s + f.bits, 0)).toBe(16);
    expect(fields4(0x7314).map((f) => f.bits)).toEqual([4, 4, 8]);
    expect(decode4(0x7314).name).toBe('ISZ');
  });
});

/** A small 8-bit stack machine: signed immediates, a PC-relative branch, a split field. */
const STACK: IsaDoc = {
  id: 'stack', name: 'Stack machine', wordBits: 8,
  operands: {
    i: { kind: 'imm', signed: true },
    o: { kind: 'addr', rel: true },
    n: { kind: 'imm' },
  },
  instrs: [
    { mnemonic: 'PUSH', operands: ['i'], pattern: '0iiiiiii' },
    { mnemonic: 'BZ', operands: ['o'], pattern: '10oooooo' },
    { mnemonic: 'ADD', operands: [], pattern: '11000000' },
    { mnemonic: 'DUP', operands: [], pattern: '11000001' },
    { mnemonic: 'PICK', operands: ['n'], pattern: '111n0nn-' },
    { mnemonic: 'HALT', operands: [], pattern: '11111111' },
  ],
};

describe('a table of your own', () => {
  const t = new IsaTable(STACK);

  it('checks clean, assembles signed immediates, relative branches and split fields', () => {
    expect(t.problems).toEqual([]);
    const r = t.assemble('top: PUSH -3\n  DUP\n  BZ top\n  PICK 5\n  BZ end\nend: HALT\n  .word 0xAB, 7');
    expect(r.errors).toEqual([]);
    expect(r.words).toEqual([0b01111101, 0b11000001, 0b10111110, 0b11110010, 0b10000001, 0xff, 0xab, 7]);
    expect(t.disasm(0b10111110, 2)).toBe('BZ   0x00');
    expect(t.disasm(0b01111101)).toBe('PUSH -3');
    expect(t.disasm(0b11110010)).toBe('PICK 5');
    expect(t.disasm(0b11110110)).toBe('PICK 7');
    expect(t.disasm(0b11110000)).toBe('PICK 4');
    expect(t.disasm(0b11010000)).toBe('.word 0xD0');
    expect(t.disasm(0b11000010)).toBe('.word 0xC2');
    expect(t.fields(0b11110110).map((f) => `${f.name}:${f.bits}`)).toEqual(['opcode:3', 'n:1', 'opcode:1', 'n:2', '—:1']);
  });

  it('range errors name the line', () => {
    const r = t.assemble('PUSH 64\nPUSH -65\nPICK 8\nBZ far\n.org 100\nfar: HALT');
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
  });

  it('finds the problems of a table', () => {
    const bad = new IsaTable({
      ...STACK,
      instrs: [
        ...STACK.instrs,
        { mnemonic: 'SWAP', operands: [], pattern: '11000001' }, // same as DUP
        { mnemonic: 'NEG', operands: ['x'], pattern: '1101xxx' }, // 7 bits, x has no kind
        { mnemonic: 'POP', operands: [], pattern: '1110q000' }, // q not an operand
      ],
    });
    const msgs = bad.problems.map((p) => p.message).join('\n');
    expect(msgs).toMatch(/SWAP and DUP can encode the same word/);
    expect(msgs).toMatch(/NEG: the pattern has 7 bits, the word 8/);
    expect(msgs).toMatch(/operand 'x' has no kind/);
    expect(msgs).toMatch(/'q' is in the pattern but not an operand/);
  });
});

describe('Isa: one shape for every ROM language', () => {
  it('wraps the built-in assemblers with word-index line addresses', () => {
    const rv = BUILTIN_ISAS.asm.assemble('addi a0, zero, 1\nj .');
    expect(rv.lines.map((l) => l.addr)).toEqual([0, 1]);
    expect(isaOf('rv16')!.wordBits).toBe(16);
    expect(isaOf('cpu4')!.disasm(0x4025)).toBe('JUN  0x25');
    expect(isaOf('hex')).toBeNull();
    expect(isaOf('isa', STACK)!.disasm(0xff)).toBe('HALT');
    expect(tableIsa(STACK)).toBe(tableIsa(STACK));
    expect(tableIsa(ISA4_PRESET).words.mnemonics).toContain('DAA');
    for (const isa of Object.values(BUILTIN_ISAS)) expect(isa.fields(0).reduce((s, f) => s + f.bits, 0), isa.id).toBe(isa.wordBits);
  });
});
