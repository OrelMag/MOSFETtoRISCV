// Instruction-set tables that ship with the site. The 4-bit CPU's ISA (src/isa4) as a table: the
// first preset, read-only in the editor and copied to start one's own. tests/isa-table.test.ts holds
// it to the 4-bit assembler and disassembler on every word.

import { INSTRS4, JCN_NAMES, type Shape4 } from '../isa4/isa4';
import { FN, MEANING } from '../ssem/isa';
import type { InstrDef, IsaDoc } from './table';

const bin = (v: number, n: number) => v.toString(2).padStart(n, '0');

/** The pattern of a 4-bit instruction from its high byte and operand shape. */
function pattern4(hi: number, shape: Shape4): string {
  const opr = bin(hi >> 4, 4), opa = bin(hi & 15, 4);
  switch (shape) {
    case '': return `${opr} ${opa} --------`;
    case 'r': return `${opr} rrrr --------`;
    case 'p': return `${opr} ppp${opa[3]} --------`;
    case 'd': return `${opr} dddd --------`;
    case 'ca': return `${opr} cccc aaaaaaaa`;
    case 'pb': return `${opr} ppp0 bbbbbbbb`;
    case 'a': return `${opr} ---- aaaaaaaa`;
    case 'ra': return `${opr} rrrr aaaaaaaa`;
  }
}

const OPERANDS4: Record<Shape4, string[]> = { '': [], r: ['r'], p: ['p'], d: ['d'], ca: ['c', 'a'], pb: ['p', 'b'], a: ['a'], ra: ['r', 'a'] };

export const ISA4_PRESET: IsaDoc = {
  id: 'cpu4',
  name: '4-bit CPU (4004)',
  wordBits: 16,
  operands: {
    r: { kind: 'reg', names: Array.from({ length: 16 }, (_, i) => `R${i}`) },
    p: { kind: 'reg', names: Array.from({ length: 8 }, (_, i) => `P${i}`) },
    c: { kind: 'enum', names: Object.fromEntries(Object.entries(JCN_NAMES).map(([k, v]) => [k.toUpperCase(), v])), number: true },
    a: { kind: 'addr' },
    d: { kind: 'imm' },
    b: { kind: 'imm', hex: true },
  },
  instrs: INSTRS4.map((i): InstrDef => ({ mnemonic: i.name, operands: OPERANDS4[i.shape], pattern: pattern4(i.hi, i.shape), summary: i.summary })),
  notes: 'The Intel 4004\'s opcode map in 16-bit words: the 4004 byte (OPR:OPA) high, its second byte (an address or data) low.',
};

/**
 * The Manchester Baby's (SSEM, 1948) order code as a table. A word is 32 digits and an instruction uses two fields: the
 * line number in bits 4:0 and the function in bits 15:13 (ssem/isa.ts); the others are ignored when decoding and
 * assembled as 0. Function 5 is a second SUB (digit 15 is not decoded for subtraction), so SUB's pattern leaves bit 13
 * free. One store line is one word, the address counts lines: `.org 20` where the notebook writes 20:, `.word` for NUM.
 * tests/isa-baby.test.ts holds it to ssem/asm.ts and ssem/isa.ts on every function and line.
 */
const fnBits = (f: number) => f.toString(2).padStart(3, '0');
const baby = (name: keyof typeof FN, line: boolean, fn = fnBits(FN[name])): InstrDef => ({
  mnemonic: name,
  operands: line ? ['s'] : [],
  pattern: `---------------- ${fn} -------- ${line ? 'sssss' : '-----'}`,
  summary: MEANING[FN[name]],
});

export const BABY_PRESET: IsaDoc = {
  id: 'ssem',
  name: 'Manchester Baby (SSEM, 1948)',
  wordBits: 32,
  operands: { s: { kind: 'imm' } },
  instrs: [baby('JMP', true), baby('JRP', true), baby('LDN', true), baby('STO', true), baby('SUB', true, '10-'), baby('CMP', false), baby('STP', false)],
  notes: 'The 1948 machine: 32 lines of 32 digits, the line number in bits 4:0 and the function in bits 15:13 of a word (the other digits are ignored). Function 5 also subtracts. CMP skips the next line when the accumulator is negative; STP halts. Data lines are .word values; .org n starts at line n.',
};

/** The presets, by id. */
export const ISA_PRESETS: Record<string, IsaDoc> = { [ISA4_PRESET.id]: ISA4_PRESET, [BABY_PRESET.id]: BABY_PRESET };
