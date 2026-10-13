// The MOS 6502's documented instruction set: 56 mnemonics, 151 opcodes, 13 addressing modes. The
// table below is the single source for the assembler, the disassembler and the ISS's decode, so the
// three cannot drift apart. Undocumented opcodes are absent (OPCODES[op] undefined).

export type Mode = 'impl' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'abx' | 'aby' | 'izx' | 'izy' | 'ind' | 'rel';

export interface ModeInfo {
  name: Mode;
  /** Long name, e.g. "zero page,X". */
  title: string;
  /** Operand syntax with nn / nnnn for a byte / word operand, e.g. "($nn),Y". */
  syntax: string;
  /** Instruction length in bytes (opcode included). */
  bytes: number;
}

export const MODES: Record<Mode, ModeInfo> = {
  impl: { name: 'impl', title: 'implied', syntax: '', bytes: 1 },
  acc: { name: 'acc', title: 'accumulator', syntax: 'A', bytes: 1 },
  imm: { name: 'imm', title: 'immediate', syntax: '#$nn', bytes: 2 },
  zp: { name: 'zp', title: 'zero page', syntax: '$nn', bytes: 2 },
  zpx: { name: 'zpx', title: 'zero page,X', syntax: '$nn,X', bytes: 2 },
  zpy: { name: 'zpy', title: 'zero page,Y', syntax: '$nn,Y', bytes: 2 },
  abs: { name: 'abs', title: 'absolute', syntax: '$nnnn', bytes: 3 },
  abx: { name: 'abx', title: 'absolute,X', syntax: '$nnnn,X', bytes: 3 },
  aby: { name: 'aby', title: 'absolute,Y', syntax: '$nnnn,Y', bytes: 3 },
  izx: { name: 'izx', title: '(indirect,X)', syntax: '($nn,X)', bytes: 2 },
  izy: { name: 'izy', title: '(indirect),Y', syntax: '($nn),Y', bytes: 2 },
  ind: { name: 'ind', title: 'indirect', syntax: '($nnnn)', bytes: 3 },
  rel: { name: 'rel', title: 'relative', syntax: '$nnnn', bytes: 2 },
};

/** Instruction classes, for colouring listings. */
export type OpClass = 'ldst' | 'alu' | 'rmw' | 'branch' | 'jump' | 'stack' | 'transfer' | 'flag';

export const CLASS_TITLES: Record<OpClass, string> = {
  ldst: 'load / store', alu: 'arithmetic / logic / compare', rmw: 'shift / increment / decrement',
  branch: 'branch', jump: 'jump / call / interrupt', stack: 'stack', transfer: 'register transfer', flag: 'flags / no-op',
};

/**
 * How an instruction uses its effective address: r = read, w = write, m = read-modify-write (the NMOS
 * part writes the unmodified value back before the result), '' = no data access through a mode.
 */
export type Access = 'r' | 'w' | 'm' | '';

export interface OpInfo {
  op: number;
  mnemonic: string;
  mode: Mode;
  bytes: number;
  /** Cycles without penalties. */
  cycles: number;
  /** +1 cycle when the indexed address crosses a page (reads through abx / aby / izy). */
  pageCross: boolean;
  /** Branch: +1 cycle when taken, +1 more when the target is on another page. */
  branch: boolean;
  cls: OpClass;
  access: Access;
}

// mnemonic class access: mode opcode cycles[+] ...  ('+': one more on a page cross)
const TABLE = `
ADC alu r: imm 69 2, zp 65 3, zpx 75 4, abs 6d 4, abx 7d 4+, aby 79 4+, izx 61 6, izy 71 5+
AND alu r: imm 29 2, zp 25 3, zpx 35 4, abs 2d 4, abx 3d 4+, aby 39 4+, izx 21 6, izy 31 5+
ASL rmw m: acc 0a 2, zp 06 5, zpx 16 6, abs 0e 6, abx 1e 7
BCC branch -: rel 90 2
BCS branch -: rel b0 2
BEQ branch -: rel f0 2
BIT alu r: zp 24 3, abs 2c 4
BMI branch -: rel 30 2
BNE branch -: rel d0 2
BPL branch -: rel 10 2
BRK jump -: impl 00 7
BVC branch -: rel 50 2
BVS branch -: rel 70 2
CLC flag -: impl 18 2
CLD flag -: impl d8 2
CLI flag -: impl 58 2
CLV flag -: impl b8 2
CMP alu r: imm c9 2, zp c5 3, zpx d5 4, abs cd 4, abx dd 4+, aby d9 4+, izx c1 6, izy d1 5+
CPX alu r: imm e0 2, zp e4 3, abs ec 4
CPY alu r: imm c0 2, zp c4 3, abs cc 4
DEC rmw m: zp c6 5, zpx d6 6, abs ce 6, abx de 7
DEX rmw -: impl ca 2
DEY rmw -: impl 88 2
EOR alu r: imm 49 2, zp 45 3, zpx 55 4, abs 4d 4, abx 5d 4+, aby 59 4+, izx 41 6, izy 51 5+
INC rmw m: zp e6 5, zpx f6 6, abs ee 6, abx fe 7
INX rmw -: impl e8 2
INY rmw -: impl c8 2
JMP jump -: abs 4c 3, ind 6c 5
JSR jump -: abs 20 6
LDA ldst r: imm a9 2, zp a5 3, zpx b5 4, abs ad 4, abx bd 4+, aby b9 4+, izx a1 6, izy b1 5+
LDX ldst r: imm a2 2, zp a6 3, zpy b6 4, abs ae 4, aby be 4+
LDY ldst r: imm a0 2, zp a4 3, zpx b4 4, abs ac 4, abx bc 4+
LSR rmw m: acc 4a 2, zp 46 5, zpx 56 6, abs 4e 6, abx 5e 7
NOP flag -: impl ea 2
ORA alu r: imm 09 2, zp 05 3, zpx 15 4, abs 0d 4, abx 1d 4+, aby 19 4+, izx 01 6, izy 11 5+
PHA stack -: impl 48 3
PHP stack -: impl 08 3
PLA stack -: impl 68 4
PLP stack -: impl 28 4
ROL rmw m: acc 2a 2, zp 26 5, zpx 36 6, abs 2e 6, abx 3e 7
ROR rmw m: acc 6a 2, zp 66 5, zpx 76 6, abs 6e 6, abx 7e 7
RTI jump -: impl 40 6
RTS jump -: impl 60 6
SBC alu r: imm e9 2, zp e5 3, zpx f5 4, abs ed 4, abx fd 4+, aby f9 4+, izx e1 6, izy f1 5+
SEC flag -: impl 38 2
SED flag -: impl f8 2
SEI flag -: impl 78 2
STA ldst w: zp 85 3, zpx 95 4, abs 8d 4, abx 9d 5, aby 99 5, izx 81 6, izy 91 6
STX ldst w: zp 86 3, zpy 96 4, abs 8e 4
STY ldst w: zp 84 3, zpx 94 4, abs 8c 4
TAX transfer -: impl aa 2
TAY transfer -: impl a8 2
TSX transfer -: impl ba 2
TXA transfer -: impl 8a 2
TXS transfer -: impl 9a 2
TYA transfer -: impl 98 2
`;

/** Every opcode: its documented instruction, or undefined. */
export const OPCODES: (OpInfo | undefined)[] = new Array(256).fill(undefined);
/** Documented mnemonics in alphabetical order. */
export const MNEMONICS: string[] = [];
const BY_NAME = new Map<string, Partial<Record<Mode, number>>>();

for (const row of TABLE.trim().split('\n')) {
  const [head, rest] = row.split(':');
  const [mnemonic, cls, acc] = head.trim().split(/\s+/);
  const modes: Partial<Record<Mode, number>> = {};
  for (const item of rest.split(',')) {
    const [mode, hex, cyc] = item.trim().split(/\s+/) as [Mode, string, string];
    const op = parseInt(hex, 16);
    modes[mode] = op;
    OPCODES[op] = {
      op, mnemonic, mode, bytes: MODES[mode].bytes, cycles: parseInt(cyc), pageCross: cyc.endsWith('+'),
      branch: mode === 'rel', cls: cls as OpClass, access: (acc === '-' ? '' : acc) as Access,
    };
  }
  MNEMONICS.push(mnemonic);
  BY_NAME.set(mnemonic, modes);
}

/** The opcode of `mnemonic` (any case) in `mode`, or undefined when that combination does not exist. */
export function opcodeOf(mnemonic: string, mode: Mode): number | undefined {
  return BY_NAME.get(mnemonic.toUpperCase())?.[mode];
}

/** The modes a mnemonic exists in (empty for an unknown mnemonic). */
export function modesOf(mnemonic: string): Mode[] {
  return Object.keys(BY_NAME.get(mnemonic.toUpperCase()) ?? {}) as Mode[];
}

/**
 * The opcode's bit fields, aaabbbcc: most of the map is regular, cc picks a group (01: the ALU
 * instructions, 10: shifts / inc / dec / ldx / stx, 00: the rest), aaa the operation, bbb the mode.
 */
export function fields(op: number): { aaa: number; bbb: number; cc: number } {
  return { aaa: op >> 5, bbb: (op >> 2) & 7, cc: op & 3 };
}

const hex2 = (v: number) => '$' + (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v: number) => '$' + (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');

/** The operand as written in assembly, e.g. "($12),Y"; `pc` is the instruction's address (branches show the target). */
export function formatOperand(mode: Mode, lo: number, hi: number, pc: number): string {
  const w = lo | (hi << 8);
  switch (mode) {
    case 'impl': return '';
    case 'acc': return 'A';
    case 'imm': return '#' + hex2(lo);
    case 'zp': return hex2(lo);
    case 'zpx': return hex2(lo) + ',X';
    case 'zpy': return hex2(lo) + ',Y';
    case 'abs': return hex4(w);
    case 'abx': return hex4(w) + ',X';
    case 'aby': return hex4(w) + ',Y';
    case 'izx': return '(' + hex2(lo) + ',X)';
    case 'izy': return '(' + hex2(lo) + '),Y';
    case 'ind': return '(' + hex4(w) + ')';
    case 'rel': return hex4(pc + 2 + ((lo << 24) >> 24));
  }
}

/**
 * Disassembles the instruction whose bytes start at bytes[0] (missing operand bytes read 0), at
 * address `pc`: "LDA $1234,X", "BNE $0202". An undocumented opcode gives ".byte $xx".
 */
export function disasm(bytes: ArrayLike<number>, pc: number): string {
  const info = OPCODES[bytes[0] & 0xff];
  if (!info) return '.byte ' + hex2(bytes[0]);
  const operand = formatOperand(info.mode, bytes[1] ?? 0, bytes[2] ?? 0, pc);
  return operand ? info.mnemonic + ' ' + operand : info.mnemonic;
}

/** Disassembles at `pc` through a reader: the text and the instruction's length (1 for an undocumented opcode). */
export function disasmAt(read: (addr: number) => number, pc: number): { text: string; bytes: number } {
  const op = read(pc & 0xffff) & 0xff;
  const n = OPCODES[op]?.bytes ?? 1;
  const bytes = [op, n > 1 ? read((pc + 1) & 0xffff) : 0, n > 2 ? read((pc + 2) & 0xffff) : 0];
  return { text: disasm(bytes, pc), bytes: n };
}
