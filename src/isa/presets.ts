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

/** The PDP-8's memory-reference instructions: opcode (3 bits), then I (indirect) and the paged address (Z + 7 bits). */
const PDP8_MRI: [string, number, string][] = [
  ['AND', 0, 'AC = AC AND M'], ['TAD', 1, 'AC = AC + M (two\'s complement); a carry out flips L'],
  ['ISZ', 2, 'M = M + 1; skip the next instruction if it became 0'], ['DCA', 3, 'M = AC, then AC = 0'],
  ['JMS', 4, 'M = the return address, then jump to M + 1'], ['JMP', 5, 'jump to M'],
];
/** Operate microinstructions (opcode 7), PAL's names: [name, word, group, what it does]. */
const PDP8_OPR: [string, number, string, string][] = [
  ['NOP', 0o7000, 'g1', 'no operation'], ['IAC', 0o7001, 'g1', 'AC + 1'], ['BSW', 0o7002, 'g1', 'swap the two 6-bit halves of AC'],
  ['RAL', 0o7004, 'g1', 'rotate L:AC left one'], ['RTL', 0o7006, 'g1', 'rotate L:AC left two'],
  ['RAR', 0o7010, 'g1', 'rotate L:AC right one'], ['RTR', 0o7012, 'g1', 'rotate L:AC right two'],
  ['CML', 0o7020, 'g1', 'complement L'], ['CMA', 0o7040, 'g1', 'complement AC'], ['CIA', 0o7041, 'g1', 'AC = −AC (CMA IAC)'],
  ['CLL', 0o7100, 'g1', 'clear L'], ['STL', 0o7120, 'g1', 'set L (CLL CML)'], ['CLA', 0o7200, 'g1', 'clear AC'],
  ['STA', 0o7240, 'g1', 'AC = 7777 (CLA CMA)'],
  ['SMA', 0o7500, 'g2', 'skip if AC < 0'], ['SZA', 0o7440, 'g2', 'skip if AC = 0'], ['SNL', 0o7420, 'g2', 'skip if L = 1'],
  ['SKP', 0o7410, 'g2', 'skip always'], ['SPA', 0o7510, 'g2', 'skip if AC ≥ 0'], ['SNA', 0o7450, 'g2', 'skip if AC ≠ 0'],
  ['SZL', 0o7430, 'g2', 'skip if L = 0'], ['OSR', 0o7404, 'g2', 'AC = AC OR the switch register'], ['HLT', 0o7402, 'g2', 'halt'],
  ['CLA', 0o7600, 'g2', 'clear AC (after the skip test)'], ['LAS', 0o7604, 'g2', 'AC = the switch register (CLA OSR)'],
  ['CLA', 0o7601, 'g3', 'clear AC (group 3)'], ['MQA', 0o7501, 'g3', 'AC = AC OR MQ'], ['MQL', 0o7421, 'g3', 'MQ = AC, then AC = 0'],
  ['SWP', 0o7521, 'g3', 'swap AC and MQ'], ['CAM', 0o7621, 'g3', 'clear AC and MQ'],
];
/** Input / output transfers for the console teletype and the interrupt system. */
const PDP8_IOT: [string, number, string][] = [
  ['ION', 0o6001, 'interrupts on (after the next instruction)'], ['IOF', 0o6002, 'interrupts off'],
  ['KSF', 0o6031, 'skip if the keyboard has a character'], ['KCC', 0o6032, 'clear AC and the keyboard flag'],
  ['KRS', 0o6034, 'AC = AC OR the keyboard buffer'], ['KRB', 0o6036, 'AC = the keyboard buffer, clear the flag'],
  ['TSF', 0o6041, 'skip if the teleprinter is ready'], ['TCF', 0o6042, 'clear the teleprinter flag'],
  ['TPC', 0o6044, 'print AC[7:0]'], ['TLS', 0o6046, 'print AC[7:0] and clear the flag'],
];
const bin12 = (v: number) => v.toString(2).padStart(12, '0');

export const PDP8_PRESET: IsaDoc = {
  id: 'pdp8',
  name: 'PDP-8',
  wordBits: 12,
  spaced: true,
  octal: true,
  operands: {
    i: { kind: 'enum', names: { I: 1 } },
    a: { kind: 'addr', page: true },
    d: { kind: 'imm' },
  },
  instrs: [
    ...PDP8_MRI.flatMap(([m, op, what]): InstrDef[] => [
      { mnemonic: m, operands: ['a'], pattern: `${bin12(op << 9).slice(0, 3)} 0 aaaaaaaa`, summary: what },
      { mnemonic: m, operands: ['i', 'a'], pattern: `${bin12(op << 9).slice(0, 3)} i aaaaaaaa`, summary: `${what}, through a pointer at M` },
    ]),
    ...PDP8_IOT.map(([m, w, what]): InstrDef => ({ mnemonic: m, operands: [], pattern: bin12(w), summary: what })),
    { mnemonic: 'IOT', operands: ['d'], pattern: '110 dddddddd d', summary: 'an I/O transfer: device (6 bits), then the pulses (3)' },
    ...PDP8_OPR.map(([m, w, g, what]): InstrDef => ({ mnemonic: m, operands: [], pattern: bin12(w), summary: what, group: g })),
    { mnemonic: 'OPR', operands: ['d'], pattern: '111 dddddddd d', summary: 'an operate word no name above spells' },
  ],
  notes: 'The DEC PDP-8 in its own assembler\'s style: 12-bit words, octal, operands separated by spaces (TAD I PTR), '
    + 'labels with a colon (PAL wrote PTR,). An address reaches page zero (0000–0177) or the 128-word page the instruction is on: '
    + 'the assembler sets the page bit from the target and refuses one elsewhere (go through a pointer: I). '
    + 'Operate microinstructions of one group share a line and are OR\'ed (CLA CLL, SMA CLA). What a table cannot say, '
    + 'because it describes syntax, not behaviour: that an indirect reference through 0010–0017 first adds 1 to the pointer '
    + '(auto-index), the order the microinstructions act in, which IOTs a device answers. The PDP-8 front panel '
    + 'runs a program on its own model of the machine (src/pdp8), which does all of that.',
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
export const ISA_PRESETS: Record<string, IsaDoc> = { [ISA4_PRESET.id]: ISA4_PRESET, [PDP8_PRESET.id]: PDP8_PRESET, [BABY_PRESET.id]: BABY_PRESET };
