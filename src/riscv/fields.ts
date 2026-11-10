// The fields of one instruction as that instruction uses them (not just its format's template):
// shifts split funct7 from shamt, CSR ops carry a CSR number and maybe a zimm, FP operands name
// f registers. The instruction breakdown draws this; the hardware view colours wires from it.

import { ABI, CSR_NAMES, decode, FABI, IMM_SRC, IMM_TOP, OPCODES, RM_OPERANDS } from './isa';
import type { CustomRow } from './custom';
import { decodeV, F3 as VF3, type VKind, V_OPCODE } from './rvv';

export type FieldKey = 'opcode' | 'rd' | 'funct3' | 'rs1' | 'rs2' | 'rs3' | 'funct7' | 'fmt' | 'imm' | 'shamt' | 'csr' | 'zimm' | 'funct12';
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
  if (key === 'rs1' || key === 'rs2' || key === 'rs3') return 'rs';
  if (key.startsWith('funct') || key === 'fmt') return 'fn';
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
  [OPCODES.STOREFP]: 'STORE-FP', [OPCODES.OPFP]: 'OP-FP', [OPCODES.AMO]: 'AMO', [OPCODES.OPIMM32]: 'OP-IMM-32 (W)', [OPCODES.OP32]: 'OP-32 (W)',
  [V_OPCODE]: 'OP-V (vector)', [OPCODES.FMADD]: 'MADD', [OPCODES.FMSUB]: 'MSUB', [OPCODES.FNMSUB]: 'NMSUB', [OPCODES.FNMADD]: 'NMADD',
};

const ALU3 = ['add/sub', 'sll', 'slt', 'sltu', 'xor', 'srl/sra', 'or', 'and'];
const F3: Record<number, string[]> = {
  [OPCODES.OP]: ALU3, [OPCODES.OPIMM]: ALU3, [OPCODES.OP32]: ALU3, [OPCODES.OPIMM32]: ALU3,
  [OPCODES.BRANCH]: ['taken if rs1 = rs2', 'taken if rs1 ≠ rs2', '', '', 'taken if rs1 < rs2 (signed)', 'taken if rs1 ≥ rs2 (signed)', 'taken if rs1 < rs2 (unsigned)', 'taken if rs1 ≥ rs2 (unsigned)'],
  [OPCODES.LOAD]: ['byte', 'half', 'word', 'doubleword (RV64)', 'byte, zero-ext.', 'half, zero-ext.', 'word, zero-ext. (RV64)'],
  [OPCODES.STORE]: ['byte', 'half', 'word', 'doubleword (RV64)'],
  [OPCODES.SYSTEM]: ['', 'CSR write', 'CSR set', 'CSR clear', '', 'CSR write imm.', 'CSR set imm.', 'CSR clear imm.'],
  [OPCODES.LOADFP]: ['', '', 'word'], [OPCODES.STOREFP]: ['', '', 'word'],
};

const bitsOf = (w: number, hi: number, lo: number) => Math.floor((w >>> 0) / 2 ** lo) % 2 ** (hi - lo + 1);
const sgn = (v: number) => (v < 0 ? `${v}` : `+${v}`);

/** The fields of one instruction word, high bits first, tiling bits 31..0 exactly. */
export function fieldsOf(word: number, custom?: readonly CustomRow[], xlen: 32 | 64 = 32): Field[] {
  const w = word >>> 0;
  const d = decode(w, custom, xlen);
  const s = d.spec;
  const fp = s?.fp;
  const reg = (bank: 'f' | 'x' | undefined, r: number) => (bank === 'f' ? `f${r} (${FABI[r]})` : `x${r} (${ABI[r]})`);
  const F = (key: FieldKey, hi: number, lo: number, meaning: string, label: string = key, used = true): Field =>
    ({ key, hi, lo, value: bitsOf(w, hi, lo), label, meaning, used });

  const opcode = F('opcode', 6, 0, s ? `${s.custom ? `custom-${s.custom.slot}: ${s.name}` : OPNAME[d.opcode]} (${d.fmt}-type)` : OPNAME[d.opcode] ?? 'not an RV32 opcode');
  const f3name = (F3[d.opcode] ?? [])[d.funct3];
  let f3m = s ? (f3name || s.name) : '?';
  if (d.opcode === OPCODES.OP && d.funct7 === 1) f3m = s?.name ?? '?';
  else if (fp?.rm) f3m = `rounding: ${RM_OPERANDS[d.funct3] || 'reserved'}${d.funct3 === 7 ? ' (the mode in frm)' : ''}`;
  else if (d.opcode === OPCODES.OPFP || d.opcode === OPCODES.AMO) f3m = `→ ${s?.name ?? '?'}`;
  const funct3 = F('funct3', 14, 12, f3m, fp?.rm ? 'rm' : 'funct3');
  const rd = F('rd', 11, 7, reg(fp?.rd, d.rd));
  const rs1 = F('rs1', 19, 15, reg(fp?.rs1, d.rs1));
  const rs2 = fp?.rs2fixed !== undefined
    ? F('rs2', 24, 20, `${d.rs2}: selects ${s!.name}`)
    : F('rs2', 24, 20, reg(fp?.rs2, d.rs2));
  const immVal = d.fmt === 'U' ? `0x${(d.imm >>> 12).toString(16)} << 12` : d.fmt === 'B' || d.fmt === 'J' ? `pc ${sgn(d.imm)}` : `${d.imm}`;
  const imm = (hi: number, lo: number, label: string) => F('imm', hi, lo, `imm = ${immVal}`, label);

  const v = s ? null : decodeV(w);
  if (v) return vectorFields(w, v, F);
  if (!s) return [F('funct7', 31, 25, '?'), F('rs2', 24, 20, '?'), F('rs1', 19, 15, '?'), F('funct3', 14, 12, '?'), F('rd', 11, 7, '?'), opcode];

  switch (d.fmt) {
    case 'R4':
      return [F('rs3', 31, 27, reg('f', d.rs3)), F('fmt', 26, 25, 'single precision'), rs2, rs1, funct3, rd, opcode];
    case 'R': {
      let f7m = `→ ${s.name}`;
      if (d.opcode === OPCODES.OP) f7m = d.funct7 === 1 ? 'M extension' : d.funct7 === 0x20 ? 'bit 5 set: sub / sra' : 'base op';
      else if (d.opcode === OPCODES.AMO) f7m = `funct5 ${d.funct7 >> 2} (aq, rl): ${s.name}`;
      return [F('funct7', 31, 25, f7m), rs2, rs1, funct3, rd, opcode];
    }
    case 'I':
      if ((d.opcode === OPCODES.OPIMM || d.opcode === OPCODES.OPIMM32) && (d.funct3 === 1 || d.funct3 === 5)) {
        // RV64's OP-IMM shifts have a 6-bit amount (instr[25] is shamt[5]) under a 6-bit funct6
        if (xlen === 64 && d.opcode === OPCODES.OPIMM) return [F('funct7', 31, 26, d.funct7 & 0x20 ? 'bit 5 set: arithmetic' : 'logical', 'funct6'), F('shamt', 25, 20, `shift by ${d.imm}`), rs1, funct3, rd, opcode];
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
export function immBits(word: number, custom?: readonly CustomRow[], xlen: 32 | 64 = 32): ImmBit[] {
  const fmt = decode(word, custom, xlen).fmt;
  if (fmt === 'R' || fmt === 'R4') return [];
  const map = IMM_SRC[fmt];
  return Array.from({ length: 32 }, (_, i) => {
    const src = map(i);
    return { bit: i, src, sign: src === 31 && i > IMM_TOP[fmt], value: src === 'zero' ? 0 : (word >>> src) & 1 };
  });
}

/** OP-V's funct3: the operands' kinds. */
const VCAT: Record<number, string> = {
  [VF3.IVV]: 'OPIVV: vector, vector', [VF3.IVX]: 'OPIVX: vector, scalar x', [VF3.IVI]: 'OPIVI: vector, 5-bit immediate',
  [VF3.MVV]: 'OPMVV: vector, vector (reductions, moves)', [VF3.MVX]: 'OPMVX: vector, scalar x', [VF3.CFG]: 'OPCFG: set vl and vtype',
};
type MakeField = (key: FieldKey, hi: number, lo: number, meaning: string, label?: string, used?: boolean) => Field;

/** A vector word's fields (RVV 1.0): funct6 · vm · vs2 · vs1 / rs1 / imm · funct3 · vd · opcode; the vset forms; a load / store. */
function vectorFields(w: number, v: VKind, F: MakeField): Field[] {
  const x = (r: number) => `x${r} (${ABI[r]})`;
  const vreg = (hi: number, lo: number) => `v${bitsOf(w, hi, lo)}`;
  const f3 = bitsOf(w, 14, 12);
  const funct3 = F('funct3', 14, 12, VCAT[f3] ?? '?');
  const vm = (masked: boolean) => F('fmt', 25, 25, masked ? '0: only where the bit of v0 is 1 (v0.t)' : '1: every element', 'vm');
  const op = F('opcode', 6, 0, v.k === 'mem' ? `${v.store ? 'STORE-FP' : 'LOAD-FP'} with a vector width: a vector ${v.store ? 'store' : 'load'}` : 'OP-V (vector)');
  switch (v.k) {
    case 'vsetvli':
      return [F('funct7', 31, 31, '0: vsetvli', 'bit 31'), F('imm', 30, 20, 'vtype: SEW, LMUL, ta / ma', 'zimm[10:0]'), F('rs1', 19, 15, `AVL from ${x(v.rs1)}`), funct3, F('rd', 11, 7, `vl to ${x(v.rd)}`), op];
    case 'vsetivli':
      return [F('funct7', 31, 30, '11: vsetivli', 'bits 31:30'), F('imm', 29, 20, 'vtype: SEW, LMUL, ta / ma', 'zimm[9:0]'), F('zimm', 19, 15, `AVL = ${v.uimm}`, 'uimm'), funct3, F('rd', 11, 7, `vl to ${x(v.rd)}`), op];
    case 'vsetvl':
      return [F('funct7', 31, 25, '1000000: vsetvl'), F('rs2', 24, 20, `vtype from ${x(v.rs2)}`), F('rs1', 19, 15, `AVL from ${x(v.rs1)}`), funct3, F('rd', 11, 7, `vl to ${x(v.rd)}`), op];
    case 'mem':
      return [F('funct7', 31, 26, `nf, mew, mop: ${v.strided ? 'strided' : 'unit stride'}`, 'nf|mew|mop'), vm(v.vm),
        v.strided ? F('rs2', 24, 20, `stride from ${x(v.rs2)}`) : F('rs2', 24, 20, '0: unit stride', 'lumop'),
        F('rs1', 19, 15, `base address from ${x(v.rs1)}`), F('funct3', 14, 12, `${v.eew}-bit elements`, 'width'),
        F('rd', 11, 7, `v${v.v}`, v.store ? 'vs3' : 'vd'), op];
  }
  const name = v.k === 'opi' ? v.name : v.k === 'merge' ? (v.vm ? 'vmerge' : 'vmv.v') : v.k === 'redsum' ? 'vredsum' : v.k === 'mul' ? 'vmul'
    : v.k === 'mvxs' ? 'vmv.x.s' : v.k === 'mvsx' ? 'vmv.s.x' : 'vid';
  const masked = 'vm' in v && v.vm;
  const shift = name === 'vsll' || name === 'vsrl' || name === 'vsra';
  const imm5 = bitsOf(w, 19, 15), simm = !shift && imm5 & 16 ? imm5 - 32 : imm5;
  const src = f3 === VF3.IVI ? F('imm', 19, 15, `imm = ${simm}`, 'imm[4:0]')
    : f3 === VF3.IVX || f3 === VF3.MVX ? F('rs1', 19, 15, `scalar ${x(imm5)}`)
      : v.k === 'vid' ? F('rs1', 19, 15, '10001: selects vid', 'vs1') : v.k === 'mvxs' ? F('rs1', 19, 15, '00000: selects vmv.x.s', 'vs1')
        : F('rs1', 19, 15, vreg(19, 15), 'vs1');
  const noVs2 = v.k === 'vid' || v.k === 'mvsx' || (v.k === 'merge' && !v.vm);
  const vs2 = F('rs2', 24, 20, noVs2 ? 'must be 0' : vreg(24, 20), 'vs2', !noVs2);
  const vd = v.k === 'mvxs' ? F('rd', 11, 7, x(v.rd)) : F('rd', 11, 7, vreg(11, 7), 'vd');
  return [F('funct7', 31, 26, `→ ${name}`, 'funct6'), vm(masked), vs2, src, funct3, vd, op];
}
