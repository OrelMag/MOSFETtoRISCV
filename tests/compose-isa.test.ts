// The instruction builder's adapters against each ISA's own assembler: every instruction, random
// operands, encode → text → assemble gives the word back, and decode → encode too.

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { assemble4 } from '../src/isa4/asm4';
import { composeIsaOf, CPU4_COMPOSE, tableCompose } from '../src/isa/compose';
import { clampSlot, type ComposeIsa, type Parts } from '../src/isa/composekit';
import { RV32_COMPOSE } from '../src/riscv/compose';
import { RV16_COMPOSE } from '../src/riscv/rv16/compose16';
import { tableOf, type IsaDoc } from '../src/isa/table';

let seed = 99;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return Math.floor((seed / 2 ** 32) * n);
};

/** A table with the awkward cases: a split signed immediate, a scaled relative address, an enum with numbers, an absolute address. */
const SAMPLE: IsaDoc = {
  id: 'sample', name: 'Sample16', wordBits: 16,
  operands: {
    d: { kind: 'reg', names: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] },
    s: { kind: 'reg', names: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] },
    i: { kind: 'imm', signed: true },
    h: { kind: 'imm', hex: true },
    c: { kind: 'enum', names: { eq: 0, ne: 1, lt: 2, ge: 3 }, number: true },
    a: { kind: 'addr', rel: true, scale: 2 },
    j: { kind: 'addr' },
  },
  instrs: [
    { mnemonic: 'add', operands: ['d', 's'], pattern: '0000 ddd sss 000000' },
    { mnemonic: 'addi', operands: ['d', 'i'], pattern: '0001 ddd iii 000 iii' },
    { mnemonic: 'ldh', operands: ['d', 'h'], pattern: '0010 ddd 0 hhhhhhhh' },
    { mnemonic: 'br', operands: ['c', 'a'], pattern: '0011 ccc aaaaaaaaa' },
    { mnemonic: 'jmp', operands: ['j'], pattern: '01 jjjjjjjjjjjjjj' },
    { mnemonic: 'halt', operands: [], pattern: '1111 ------------' },
  ],
};

function randomParts(isa: ComposeIsa, id: string): Parts {
  const p: Parts = {};
  for (const s of isa.instr(id)!.slots) p[s.key] = clampSlot(s, s.min + rnd(s.max - s.min + 1));
  return p;
}

const CASES: [string, ComposeIsa, (src: string) => { words: number[]; errors: unknown[] }, number][] = [
  ['RV32', RV32_COMPOSE, assemble, 0x40],
  ['RV16', RV16_COMPOSE, assemble16, 0x10],
  ['4-bit CPU', CPU4_COMPOSE, assemble4, 0x10],
  // pc 0x200: the table's relative targets are absolute addresses in the text, so one below 0 is unwritable
  ['a table', tableCompose(SAMPLE), (src) => tableOf(SAMPLE).assemble(src), 0x200],
];

describe('instruction builder adapters', () => {
  for (const [name, isa, asm, pc] of CASES) {
    it(`${name}: every instruction round-trips through the assembler`, () => {
      const ids = isa.groups.flatMap((g) => g.ids);
      expect(new Set(ids).size, 'each instruction once').toBe(ids.length);
      for (const id of ids) {
        expect(isa.instr(id), id).toBeDefined();
        for (let t = 0; t < 25; t++) {
          const w = isa.encode(id, randomParts(isa, id));
          const d = isa.decode(w);
          expect(d, `${name} ${id} 0x${w.toString(16)}`).not.toBeNull();
          expect(isa.encode(d!.id, d!.parts)).toBe(w);
          // the text at pc, assembled at pc (a target is relative), is the same word
          const text = isa.text(w, pc, new Map());
          const src = isa.step === 4 ? `${'nop\n'.repeat(pc / 4)}${text}` : `${isa === RV16_COMPOSE ? 'nop\n'.repeat(pc) : `.org ${pc}\n`}${text}`;
          const r = asm(src);
          expect(r.errors, `${name}: ${text}`).toEqual([]);
          expect(r.words[r.words.length - 1] >>> 0, `${name}: ${text}`).toBe(w);
          // fields tile the word
          const f = isa.fields(w);
          expect(f.reduce((n, x) => n + x.hi - x.lo + 1, 0)).toBe(isa.wordBits);
          expect(f[0].hi).toBe(isa.wordBits - 1);
        }
      }
    });
  }

  it('targets read and write labels in every ISA', () => {
    for (const [name, isa] of CASES) {
      const id = isa.groups.flatMap((g) => g.ids).find((x) => isa.instr(x)!.slots.some((s) => s.role === 'target'));
      if (!id) continue;
      const slot = isa.instr(id)!.slots.find((s) => s.role === 'target')!;
      const parts = { ...randomParts(isa, id), [slot.key]: -2 * slot.step };
      const w = isa.encode(id, parts);
      const pc = 20 * isa.step, labels = new Map([['loop', pc - 2 * slot.step]]);
      const text = isa.text(w, pc, labels);
      expect(text, name).toMatch(/loop$/);
      const back = isa.parse(text, pc, labels);
      expect(back, `${name}: ${text}`).toEqual({ word: w });
    }
  });

  it('a split immediate is gathered from its pieces', () => {
    const isa = tableCompose(SAMPLE);
    const w = isa.encode('1', { d: 2, i: -3 });
    expect(w).toBe(0b0001_010_111_000_101);
    const imm = isa.imm(w)!;
    expect(imm.value).toBe(-3);
    expect(imm.wires.map((x) => x.src)).toEqual([0, 1, 2, 6, 7, 8]);
    expect(isa.fields(w).map((f) => f.label)).toEqual(['opcode', 'd', 'i[5:3]', 'opcode', 'i[2:0]']);
  });

  it('RV16 lui: imm10 shifted up 6, its low bit in op[3]', () => {
    const w = RV16_COMPOSE.encode('lui', { rd: 3, imm: 0x3ff });
    expect(RV16_COMPOSE.text(w)).toBe('lui a0, 0x3ff');
    const imm = RV16_COMPOSE.imm(w)!;
    expect(imm.value).toBe(0xffc0);
    expect(imm.wires.slice(0, 6).every((x) => x.src === 'zero')).toBe(true);
    expect(imm.wires[6].src).toBe(3);
  });

  it('each ROM language has its builder', () => {
    expect(composeIsaOf('asm')).toBe(RV32_COMPOSE);
    expect(composeIsaOf('rv16')).toBe(RV16_COMPOSE);
    expect(composeIsaOf('cpu4')).toBe(CPU4_COMPOSE);
    expect(composeIsaOf('isa', SAMPLE)).toBe(composeIsaOf('isa', SAMPLE));
    expect(composeIsaOf('hex')).toBeNull();
  });
});
