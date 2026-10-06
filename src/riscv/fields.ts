// The fields of one instruction as that instruction uses them (not just its format's template):
// shifts split funct7 from shamt, CSR ops carry a CSR number and maybe a zimm, FP operands name
// f registers. The instruction breakdown draws this; the hardware view colours wires from it.

import { ABI, CSR_NAMES, decode, FABI, IMM_SRC, IMM_TOP, OPCODES, type Fmt } from './isa';

export type FieldKey = 'opcode' | 'rd' | 'funct3' | 'rs1' | 'rs2' | 'funct7' | 'imm' | 'shamt' | 'csr' | 'zimm' | 'funct12';
export type FieldRole = 'op' | 'rd' | 'rs' | 'fn' | 'imm';

export interface Field {
  key: FieldKey;
  hi: number;
  lo: number;
  value: number;
  label: string;
  /** What the value means in this instruction. */
  meaning: string;
  /** False when the bits are don't-care for this instruction (e.g. rd of ecall). */
  used: boolean;
}

/** Colour role (CSS f-<role> in the strip, fld-<role> on wires). */
export function fieldRole(key: FieldKey): FieldRole {
  if (key === 'opcode') return 'op';
  if (key === 'rd') return 'rd';
  if (key === 'rs1' || key === 'rs2') return 'rs';
  if (key.startsWith('funct')) return 'fn';
  return 'imm';
}

/** The fixed slices every CPU's instruction splitter cuts (port o0..o5, LSB first). */
export const SLICES: { key: FieldKey; hi: number; lo: number }[] = [
  { key: 'opcode', hi: 6, lo: 0 }, { key: 'rd', hi: 11, lo: 7 }, { key: 'funct3', hi: 14, lo: 12 },
  { key: 'rs1', hi: 19, lo: 15 }, { key: 'rs2', hi: 24, lo: 20 }, { key: 'funct7', hi: 31, lo: 25 },
];

const OPNAME: Record<number, string> = {
  [OPCODES.LUI]: 'LUI', [OPCODES.AUIPC]: 'AUIPC', [OPCODES.JAL]: 'JAL', [OPCODES.JALR]: 'JALR',
  [OPCODES.BRANCH]: 'BRANCH', [OPCODES.LOAD]: 'LOAD', [OPCODES.STORE]: 'STORE', [OPCODES.OPIMM]: 'OP-IMM',
  [OPCODES.OP]: 'OP', [OPCODES.SYSTEM]: 'SYSTEM', [OPCODES.FENCE]: 'MISC-MEM', [OPCODES.LOADFP]: 'LOAD-FP',
  [OPCODES.STOREFP]: 'STORE-FP', [OPCODES.OPFP]: 'OP-FP', [OPCODES.AMO]: 'AMO',
};

const ALU3 = ['add/sub', 'sll', 'slt', 'sltu', 'xor', 'srl/sra', 'or', 'and'];
const F3: Record<number, string[]> = {
  [OPCODES.OP]: ALU3, [OPCODES.OPIMM]: ALU3,
  [OPCODES.BRANCH]: ['=', '≠', '', '', '< signed', '≥ signed', '< unsigned', '≥ unsigned'],
  [OPCODES.LOAD]: ['byte', 'half', 'word', '', 'byte, zero-ext.', 'half, zero-ext.'],
  [OPCODES.STORE]: ['byte', 'half', 'word'],
  [OPCODES.SYSTEM]: ['', 'CSR write', 'CSR set', 'CSR clear', '', 'CSR write imm.', 'CSR set imm.', 'CSR clear imm.'],
  [OPCODES.LOADFP]: ['', '', 'word'], [OPCODES.STOREFP]: ['', '', 'word'],
};

const bitsOf = (w: number, hi: number, lo: number) => Math.floor((w >>> 0) / 2 ** lo) % 2 ** (hi - lo + 1);
const sgn = (v: number) => (v < 0 ? `${v}` : `+${v}`);

/** The fields of one instruction word, high bits first, tiling bits 31..0 exactly. */
export function fieldsOf(word: number): Field[] {
  const w = word >>> 0;
  const d = decode(w);
  const s = d.spec;
  const fp = s?.fp;
  const reg = (bank: 'f' | 'x' | undefined, r: number) => (bank === 'f' ? `f${r} (${FABI[r]})` : `x${r} (${ABI[r]})`);
  const F = (key: FieldKey, hi: number, lo: number, meaning: string, label: string = key, used = true): Field =>
    ({ key, hi, lo, value: bitsOf(w, hi, lo), label, meaning, used });

  const opcode = F('opcode', 6, 0, s ? `${OPNAME[d.opcode]} (${d.fmt}-type)` : OPNAME[d.opcode] ?? 'not an RV32 opcode');
  const f3name = (F3[d.opcode] ?? [])[d.funct3];
  let f3m = s ? (f3name || s.name) : '?';
  if (d.opcode === OPCODES.OP && d.funct7 === 1) f3m = s?.name ?? '?';
  else if (d.opcode === OPCODES.OPFP && fp?.rm) f3m = 'rm: rounding mode (only RNE is built)';
  else if (d.opcode === OPCODES.OPFP || d.opcode === OPCODES.AMO) f3m = `→ ${s?.name ?? '?'}`;
  const funct3 = F('funct3', 14, 12, f3m, fp?.rm ? 'rm' : 'funct3');
  const rd = F('rd', 11, 7, reg(fp?.rd, d.rd));
  const rs1 = F('rs1', 19, 15, reg(fp?.rs1, d.rs1));
  const rs2 = fp?.rs2fixed !== undefined
    ? F('rs2', 24, 20, `${d.rs2}: selects ${s!.name}`)
    : F('rs2', 24, 20, reg(fp?.rs2, d.rs2));
  const immVal = d.fmt === 'U' ? `0x${(d.imm >>> 12).toString(16)} << 12` : d.fmt === 'B' || d.fmt === 'J' ? `pc ${sgn(d.imm)}` : `${d.imm}`;
  const imm = (hi: number, lo: number, label: string) => F('imm', hi, lo, `imm = ${immVal}`, label);

  if (!s) return [F('funct7', 31, 25, '?'), F('rs2', 24, 20, '?'), F('rs1', 19, 15, '?'), F('funct3', 14, 12, '?'), F('rd', 11, 7, '?'), opcode];

  switch (d.fmt) {
    case 'R': {
      let f7m = `→ ${s.name}`;
      if (d.opcode === OPCODES.OP) f7m = d.funct7 === 1 ? 'M extension' : d.funct7 === 0x20 ? 'bit 5 set: sub / sra' : 'base op';
      else if (d.opcode === OPCODES.AMO) f7m = `funct5 ${d.funct7 >> 2} (aq, rl): ${s.name}`;
      return [F('funct7', 31, 25, f7m), rs2, rs1, funct3, rd, opcode];
    }
    case 'I':
      if (d.opcode === OPCODES.OPIMM && (d.funct3 === 1 || d.funct3 === 5)) {
        return [F('funct7', 31, 25, d.funct7 & 0x20 ? 'bit 5 set: arithmetic' : 'logical'),
          F('shamt', 24, 20, `shift by ${d.rs2}`), rs1, funct3, rd, opcode];
      }
      if (d.opcode === OPCODES.SYSTEM && d.funct3 === 0) {
        return [F('funct12', 31, 20, s.name), F('rs1', 19, 15, 'must be 0', 'rs1', false), funct3, F('rd', 11, 7, 'must be 0', 'rd', false), opcode];
      }
      if (d.opcode === OPCODES.SYSTEM) {
        const csr = bitsOf(w, 31, 20);
        const src = d.funct3 & 4 ? F('zimm', 19, 15, `uimm ${d.rs1}`) : rs1;
        return [F('csr', 31, 20, CSR_NAMES[csr] ?? `CSR 0x${csr.toString(16)}`), src, funct3, rd, opcode];
      }
      if (d.opcode === OPCODES.FENCE) {
        return [F('imm', 31, 20, 'ordering (ignored: one hart, in order)', 'fm|pred|succ', false), F('rs1', 19, 15, 'ignored', 'rs1', false), funct3, F('rd', 11, 7, 'ignored', 'rd', false), opcode];
      }
      return [imm(31, 20, 'imm[11:0]'), rs1, funct3, rd, opcode];
    case 'S': return [imm(31, 25, 'imm[11:5]'), rs2, rs1, funct3, imm(11, 7, 'imm[4:0]'), opcode];
    case 'B': return [imm(31, 25, 'imm[12|10:5]'), rs2, rs1, funct3, imm(11, 7, 'imm[4:1|11]'), opcode];
    case 'U': return [imm(31, 12, 'imm[31:12]'), rd, opcode];
    case 'J': return [imm(31, 12, 'imm[20|10:1|11|19:12]'), rd, opcode];
  }
}

/** The field of `fields` that holds instruction bit b. */
export function fieldAt(fields: Field[], b: number): Field {
  return fields.find((f) => f.lo <= b && b <= f.hi)!;
}

export interface ImmBit {
  /** Bit of the immediate. */
  bit: number;
  /** Instruction bit it is wired to, or a constant 0. */
  src: number | 'zero';
  /** A sign copy of instr[31] (above the format's top bit). */
  sign: boolean;
  value: number;
}

/** How the immediate generator assembles this instruction's 32-bit immediate (empty for R-type). */
export function immBits(word: number): ImmBit[] {
  const fmt: Fmt = decode(word).fmt;
  if (fmt === 'R') return [];
  const map = IMM_SRC[fmt];
  return Array.from({ length: 32 }, (_, i) => {
    const src = map(i);
    return { bit: i, src, sign: src === 31 && i > IMM_TOP[fmt], value: src === 'zero' ? 0 : (word >>> src) & 1 };
  });
}
