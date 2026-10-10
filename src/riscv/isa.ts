// RV32I: encodings, decoding and disassembly. The single source of truth for the assembler,
// the instruction-set simulator and the instruction explorer.

export type Fmt = 'R' | 'R4' | 'I' | 'S' | 'B' | 'U' | 'J';

export const OPCODES = {
  LUI: 0b0110111, AUIPC: 0b0010111, JAL: 0b1101111, JALR: 0b1100111, BRANCH: 0b1100011,
  LOAD: 0b0000011, STORE: 0b0100011, OPIMM: 0b0010011, OP: 0b0110011, SYSTEM: 0b1110011, FENCE: 0b0001111,
  LOADFP: 0b0000111, STOREFP: 0b0100111, OPFP: 0b1010011, AMO: 0b0101111,
  FMADD: 0b1000011, FMSUB: 0b1000111, FNMSUB: 0b1001011, FNMADD: 0b1001111,
} as const;

/** Register roles of a floating-point instruction: which operands live in the f registers. */
export interface FpRoles { rd?: 'f' | 'x'; rs1?: 'f' | 'x'; rs2?: 'f' | 'x'; rs3?: 'f'; rm?: boolean; rs2fixed?: number }

export interface InstrSpec {
  name: string;
  fmt: Fmt;
  opcode: number;
  funct3?: number;
  funct7?: number;
  /** Supported by the gate-level single-cycle CPU (byte/half memory ops and system come later). */
  hw: boolean;
  /** F extension: register files of the operands (absent: integer instruction). */
  fp?: FpRoles;
}

const FR = (name: string, f7: number, fp: FpRoles, f3?: number): InstrSpec => ({ name, fmt: 'R', opcode: OPCODES.OPFP, funct7: f7, funct3: fp.rm ? undefined : f3, hw: false, fp });

const R = (name: string, f3: number, f7: number): InstrSpec => ({ name, fmt: 'R', opcode: OPCODES.OP, funct3: f3, funct7: f7, hw: true });
const I = (name: string, f3: number, opcode: number = OPCODES.OPIMM, hw = true): InstrSpec => ({ name, fmt: 'I', opcode, funct3: f3, hw });
const B = (name: string, f3: number): InstrSpec => ({ name, fmt: 'B', opcode: OPCODES.BRANCH, funct3: f3, hw: true });

export const INSTRS: InstrSpec[] = [
  { name: 'lui', fmt: 'U', opcode: OPCODES.LUI, hw: true },
  { name: 'auipc', fmt: 'U', opcode: OPCODES.AUIPC, hw: true },
  { name: 'jal', fmt: 'J', opcode: OPCODES.JAL, hw: true },
  { name: 'jalr', fmt: 'I', opcode: OPCODES.JALR, funct3: 0, hw: true },
  B('beq', 0), B('bne', 1), B('blt', 4), B('bge', 5), B('bltu', 6), B('bgeu', 7),
  I('lb', 0, OPCODES.LOAD, false), I('lh', 1, OPCODES.LOAD, false), I('lw', 2, OPCODES.LOAD), I('lbu', 4, OPCODES.LOAD, false), I('lhu', 5, OPCODES.LOAD, false),
  { name: 'sb', fmt: 'S', opcode: OPCODES.STORE, funct3: 0, hw: false },
  { name: 'sh', fmt: 'S', opcode: OPCODES.STORE, funct3: 1, hw: false },
  { name: 'sw', fmt: 'S', opcode: OPCODES.STORE, funct3: 2, hw: true },
  I('addi', 0), I('slti', 2), I('sltiu', 3), I('xori', 4), I('ori', 6), I('andi', 7),
  { name: 'slli', fmt: 'I', opcode: OPCODES.OPIMM, funct3: 1, funct7: 0, hw: true },
  { name: 'srli', fmt: 'I', opcode: OPCODES.OPIMM, funct3: 5, funct7: 0, hw: true },
  { name: 'srai', fmt: 'I', opcode: OPCODES.OPIMM, funct3: 5, funct7: 0x20, hw: true },
  R('add', 0, 0), R('sub', 0, 0x20), R('sll', 1, 0), R('slt', 2, 0), R('sltu', 3, 0),
  R('xor', 4, 0), R('srl', 5, 0), R('sra', 5, 0x20), R('or', 6, 0), R('and', 7, 0),
  // M extension (funct7 = 1)
  { ...R('mul', 0, 1), hw: false }, { ...R('mulh', 1, 1), hw: false }, { ...R('mulhsu', 2, 1), hw: false }, { ...R('mulhu', 3, 1), hw: false },
  { ...R('div', 4, 1), hw: false }, { ...R('divu', 5, 1), hw: false }, { ...R('rem', 6, 1), hw: false }, { ...R('remu', 7, 1), hw: false },
  { name: 'ecall', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 0, hw: false },
  { name: 'ebreak', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 0, hw: false },
  { name: 'mret', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 0, hw: false },
  { name: 'wfi', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 0, hw: false },
  { name: 'csrrw', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 1, hw: false },
  { name: 'csrrs', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 2, hw: false },
  { name: 'csrrc', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 3, hw: false },
  { name: 'csrrwi', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 5, hw: false },
  { name: 'csrrsi', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 6, hw: false },
  { name: 'csrrci', fmt: 'I', opcode: OPCODES.SYSTEM, funct3: 7, hw: false },
  { name: 'fence', fmt: 'I', opcode: OPCODES.FENCE, funct3: 0, hw: false },
  // F extension (single precision; rm = rounding mode, 7 = dynamic: use frm)
  { name: 'flw', fmt: 'I', opcode: OPCODES.LOADFP, funct3: 2, hw: false, fp: { rd: 'f', rs1: 'x' } },
  { name: 'fsw', fmt: 'S', opcode: OPCODES.STOREFP, funct3: 2, hw: false, fp: { rs1: 'x', rs2: 'f' } },
  FR('fadd.s', 0x00, { rd: 'f', rs1: 'f', rs2: 'f', rm: true }),
  FR('fsub.s', 0x04, { rd: 'f', rs1: 'f', rs2: 'f', rm: true }),
  FR('fmul.s', 0x08, { rd: 'f', rs1: 'f', rs2: 'f', rm: true }),
  FR('fdiv.s', 0x0c, { rd: 'f', rs1: 'f', rs2: 'f', rm: true }),
  FR('fsqrt.s', 0x2c, { rd: 'f', rs1: 'f', rs2fixed: 0, rm: true }),
  FR('fsgnj.s', 0x10, { rd: 'f', rs1: 'f', rs2: 'f' }, 0),
  FR('fsgnjn.s', 0x10, { rd: 'f', rs1: 'f', rs2: 'f' }, 1),
  FR('fsgnjx.s', 0x10, { rd: 'f', rs1: 'f', rs2: 'f' }, 2),
  FR('fmin.s', 0x14, { rd: 'f', rs1: 'f', rs2: 'f' }, 0),
  FR('fmax.s', 0x14, { rd: 'f', rs1: 'f', rs2: 'f' }, 1),
  FR('fle.s', 0x50, { rd: 'x', rs1: 'f', rs2: 'f' }, 0),
  FR('flt.s', 0x50, { rd: 'x', rs1: 'f', rs2: 'f' }, 1),
  FR('feq.s', 0x50, { rd: 'x', rs1: 'f', rs2: 'f' }, 2),
  FR('fcvt.w.s', 0x60, { rd: 'x', rs1: 'f', rs2fixed: 0, rm: true }),
  FR('fcvt.wu.s', 0x60, { rd: 'x', rs1: 'f', rs2fixed: 1, rm: true }),
  FR('fmv.x.w', 0x70, { rd: 'x', rs1: 'f', rs2fixed: 0 }, 0),
  FR('fclass.s', 0x70, { rd: 'x', rs1: 'f', rs2fixed: 0 }, 1),
  FR('fcvt.s.w', 0x68, { rd: 'f', rs1: 'x', rs2fixed: 0, rm: true }),
  FR('fcvt.s.wu', 0x68, { rd: 'f', rs1: 'x', rs2fixed: 1, rm: true }),
  FR('fmv.w.x', 0x78, { rd: 'f', rs1: 'x', rs2fixed: 0 }, 0),
  // fused multiply-add (R4 format: rs3 in bits 31:27, fmt = 00 for single precision in 26:25)
  ...(['fmadd.s', 'fmsub.s', 'fnmsub.s', 'fnmadd.s'] as const).map((name, i): InstrSpec => ({
    name, fmt: 'R4', opcode: OPCODES.FMADD + 4 * i, hw: false, fp: { rd: 'f', rs1: 'f', rs2: 'f', rs3: 'f', rm: true },
  })),
  // A extension: the two atomic memory operations the multi-core chapter uses (aq / rl bits ignored)
  { name: 'amoswap.w', fmt: 'R', opcode: OPCODES.AMO, funct3: 2, funct7: 0x04, hw: false },
  { name: 'amoadd.w', fmt: 'R', opcode: OPCODES.AMO, funct3: 2, funct7: 0x00, hw: false },
];

export const FABI = [
  'ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7', 'fs0', 'fs1', 'fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5',
  'fa6', 'fa7', 'fs2', 'fs3', 'fs4', 'fs5', 'fs6', 'fs7', 'fs8', 'fs9', 'fs10', 'fs11', 'ft8', 'ft9', 'ft10', 'ft11',
];

export function fregNumber(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^f([0-9]|[12][0-9]|3[01])$/.test(t)) return Number(t.slice(1));
  const i = FABI.indexOf(t);
  return i >= 0 ? i : null;
}

export const BY_NAME = new Map(INSTRS.map((i) => [i.name, i]));

/** Machine-mode CSRs implemented by the full system CPU. */
export const CSRS: Record<string, number> = {
  mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305, mscratch: 0x340, mepc: 0x341, mcause: 0x342,
  mtval: 0x343, mip: 0x344, mcycle: 0xb00, cycle: 0xc00, mvendorid: 0xf11, marchid: 0xf12, mimpid: 0xf13, mhartid: 0xf14,
  // F extension: accrued exception flags, dynamic rounding mode, and both together
  fflags: 0x001, frm: 0x002, fcsr: 0x003,
};

/** Rounding-mode operand names (rm field); 7 = dyn (use frm). */
export const RM_OPERANDS = ['rne', 'rtz', 'rdn', 'rup', 'rmm', '', '', 'dyn'];
export const CSR_NAMES: Record<number, string> = Object.fromEntries(Object.entries(CSRS).map(([k, v]) => [v, k]));

export const ABI = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
];

export function regNumber(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^x([0-9]|[12][0-9]|3[01])$/.test(t)) return Number(t.slice(1));
  if (t === 'fp') return 8;
  const i = ABI.indexOf(t);
  return i >= 0 ? i : null;
}

const u32 = (v: number) => v >>> 0;
export const sext = (v: number, bits: number) => (v & (1 << (bits - 1)) ? v - 2 ** bits : v) | 0;

// ---- encoding ------------------------------------------------------------------------------

export function encR(op: number, rd: number, f3: number, rs1: number, rs2: number, f7: number): number {
  return u32((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
}
/** R4 (fused multiply-add): rs3 in the top five bits, fmt (00 = single) below it. */
export function encR4(op: number, rd: number, f3: number, rs1: number, rs2: number, rs3: number, fmt = 0): number {
  return u32((rs3 << 27) | (fmt << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
}
export function encI(op: number, rd: number, f3: number, rs1: number, imm: number): number {
  return u32(((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
}
export function encS(op: number, f3: number, rs1: number, rs2: number, imm: number): number {
  imm &= 0xfff;
  return u32(((imm >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | op);
}
export function encB(op: number, f3: number, rs1: number, rs2: number, imm: number): number {
  imm &= 0x1fff;
  return u32((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12)
    | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | op);
}
export function encU(op: number, rd: number, imm20: number): number {
  return u32(((imm20 & 0xfffff) << 12) | (rd << 7) | op);
}
export function encJ(op: number, rd: number, imm: number): number {
  imm &= 0x1fffff;
  return u32((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20)
    | (((imm >> 12) & 0xff) << 12) | (rd << 7) | op);
}

// ---- decoding ------------------------------------------------------------------------------

export interface Decoded {
  word: number;
  spec: InstrSpec | null;
  name: string;
  fmt: Fmt;
  opcode: number;
  rd: number;
  rs1: number;
  rs2: number;
  /** Third source (R4 format only; otherwise bits 31:27). */
  rs3: number;
  funct3: number;
  funct7: number;
  /** Sign-extended immediate (for U-type: the value placed in the upper 20 bits, i.e. imm << 12). */
  imm: number;
}

export function immI(w: number) { return sext(w >>> 20, 12); }
export function immS(w: number) { return sext(((w >>> 25) << 5) | ((w >>> 7) & 0x1f), 12); }
export function immB(w: number) {
  return sext((((w >>> 31) & 1) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1), 13);
}
export function immU(w: number) { return (w & 0xfffff000) | 0; }
export function immJ(w: number) {
  return sext((((w >>> 31) & 1) << 20) | (((w >>> 12) & 0xff) << 12) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1), 21);
}

/** Formats that carry an immediate. */
export type ImmFmt = Exclude<Fmt, 'R' | 'R4'>;
/**
 * Where bit i of each format's immediate comes from: an instruction bit, or a constant 0. The
 * hardware immediate generator (lib/cpu.ts) is wired from this table and the instruction
 * breakdown draws it, so they cannot disagree. Bits above IMM_TOP are sign copies of instr[31].
 */
export const IMM_SRC: Record<ImmFmt, (i: number) => number | 'zero'> = {
  I: (i) => (i < 12 ? 20 + i : 31),
  S: (i) => (i < 5 ? 7 + i : i < 11 ? 25 + (i - 5) : 31),
  B: (i) => (i === 0 ? 'zero' : i < 5 ? 7 + i : i < 11 ? 25 + (i - 5) : i === 11 ? 7 : 31),
  U: (i) => (i < 12 ? 'zero' : i),
  J: (i) => (i === 0 ? 'zero' : i < 11 ? 20 + i : i === 11 ? 20 : i < 20 ? i : 31),
};
export const IMM_TOP: Record<ImmFmt, number> = { I: 11, S: 11, B: 12, U: 31, J: 20 };

export function decode(word: number): Decoded {
  const w = word >>> 0;
  const opcode = w & 0x7f, rd = (w >>> 7) & 31, funct3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, funct7 = w >>> 25;
  let spec: InstrSpec | null = null;
  for (const s of INSTRS) {
    if (s.opcode !== opcode) continue;
    if (s.funct3 !== undefined && s.funct3 !== funct3 && s.fmt !== 'U' && s.fmt !== 'J') continue;
    if (s.fmt === 'R' && s.funct7 !== (s.opcode === OPCODES.AMO ? funct7 & 0x7c : funct7)) continue;
    if (s.fmt === 'R4' && (funct7 & 3) !== 0) continue; // only fmt = S (single precision)
    if (s.fp?.rs2fixed !== undefined && s.fp.rs2fixed !== rs2) continue;
    if (s.opcode === OPCODES.OPIMM && (funct3 === 1 || funct3 === 5) && s.funct7 !== undefined && s.funct7 !== funct7) continue; // RV32: shamt[5] = instr[25] must be 0
    if (s.opcode === OPCODES.OPIMM && (funct3 === 1 || funct3 === 5) && s.funct7 === undefined) continue;
    if (s.opcode === OPCODES.SYSTEM && funct3 === 0) {
      const imm = w >>> 20;
      const want = imm === 0 ? 'ecall' : imm === 1 ? 'ebreak' : imm === 0x302 ? 'mret' : imm === 0x105 ? 'wfi' : '';
      if (s.name !== want) continue;
    }
    spec = s;
    break;
  }
  const fmt: Fmt = spec?.fmt ?? 'I';
  let imm = 0;
  switch (fmt) {
    case 'I': imm = spec && (spec.name === 'slli' || spec.name === 'srli' || spec.name === 'srai') ? rs2 : immI(w); break;
    case 'S': imm = immS(w); break;
    case 'B': imm = immB(w); break;
    case 'U': imm = immU(w); break;
    case 'J': imm = immJ(w); break;
    default: imm = 0;
  }
  return { word: w, spec, name: spec?.name ?? 'unknown', fmt, opcode, rd, rs1, rs2, rs3: w >>> 27, funct3, funct7, imm };
}

const rn = (r: number) => ABI[r];
const frn = (r: number) => FABI[r];

/** Disassemble one word; pc (if given) resolves branch / jump targets to absolute addresses. */
export function disasm(word: number, pc?: number): string {
  const d = decode(word);
  const tgt = (off: number) => (pc === undefined ? `${off}` : `0x${u32(pc + off).toString(16)}`);
  if (!d.spec) return `.word 0x${d.word.toString(16).padStart(8, '0')}`;
  const n = d.name;
  if (word === 0x00000013) return 'nop';
  const fp = d.spec.fp;
  if (fp) {
    const R = (role: 'f' | 'x' | undefined, r: number) => (role === 'f' ? frn(r) : rn(r));
    if (d.fmt === 'I') return `${n} ${frn(d.rd)}, ${d.imm}(${rn(d.rs1)})`;
    if (d.fmt === 'S') return `${n} ${frn(d.rs2)}, ${d.imm}(${rn(d.rs1)})`;
    const rm = fp.rm && d.funct3 !== 7 ? `, ${RM_OPERANDS[d.funct3] || d.funct3}` : '';
    if (fp.rs2fixed !== undefined) return `${n} ${R(fp.rd, d.rd)}, ${R(fp.rs1, d.rs1)}${rm}`;
    if (d.fmt === 'R4') return `${n} ${frn(d.rd)}, ${frn(d.rs1)}, ${frn(d.rs2)}, ${frn(d.rs3)}${rm}`;
    return `${n} ${R(fp.rd, d.rd)}, ${R(fp.rs1, d.rs1)}, ${R(fp.rs2, d.rs2)}${rm}`;
  }
  if (d.opcode === OPCODES.AMO) return `${n} ${rn(d.rd)}, ${rn(d.rs2)}, (${rn(d.rs1)})`;
  switch (d.fmt) {
    case 'R': case 'R4': return `${n} ${rn(d.rd)}, ${rn(d.rs1)}, ${rn(d.rs2)}`;
    case 'I':
      if (d.opcode === OPCODES.LOAD || n === 'jalr') return `${n} ${rn(d.rd)}, ${d.imm}(${rn(d.rs1)})`;
      if (d.opcode === OPCODES.SYSTEM && d.funct3 !== 0) {
        const csr = CSR_NAMES[(word >>> 20) & 0xfff] ?? `0x${((word >>> 20) & 0xfff).toString(16)}`;
        return d.funct3 & 4 ? `${n} ${rn(d.rd)}, ${csr}, ${d.rs1}` : `${n} ${rn(d.rd)}, ${csr}, ${rn(d.rs1)}`;
      }
      if (d.opcode === OPCODES.SYSTEM || d.opcode === OPCODES.FENCE) return n;
      return `${n} ${rn(d.rd)}, ${rn(d.rs1)}, ${d.imm}`;
    case 'S': return `${n} ${rn(d.rs2)}, ${d.imm}(${rn(d.rs1)})`;
    case 'B': return `${n} ${rn(d.rs1)}, ${rn(d.rs2)}, ${tgt(d.imm)}`;
    case 'U': return `${n} ${rn(d.rd)}, 0x${(d.imm >>> 12).toString(16)}`;
    case 'J': return `${n} ${rn(d.rd)}, ${tgt(d.imm)}`;
  }
}

/** Bit fields of each format, high to low, for the instruction explorer. */
export const FIELDS: Record<Fmt, { name: string; hi: number; lo: number }[]> = {
  R4: [{ name: 'rs3', hi: 31, lo: 27 }, { name: 'fmt', hi: 26, lo: 25 }, { name: 'rs2', hi: 24, lo: 20 }, { name: 'rs1', hi: 19, lo: 15 }, { name: 'rm', hi: 14, lo: 12 }, { name: 'rd', hi: 11, lo: 7 }, { name: 'opcode', hi: 6, lo: 0 }],
  R: [{ name: 'funct7', hi: 31, lo: 25 }, { name: 'rs2', hi: 24, lo: 20 }, { name: 'rs1', hi: 19, lo: 15 }, { name: 'funct3', hi: 14, lo: 12 }, { name: 'rd', hi: 11, lo: 7 }, { name: 'opcode', hi: 6, lo: 0 }],
  I: [{ name: 'imm[11:0]', hi: 31, lo: 20 }, { name: 'rs1', hi: 19, lo: 15 }, { name: 'funct3', hi: 14, lo: 12 }, { name: 'rd', hi: 11, lo: 7 }, { name: 'opcode', hi: 6, lo: 0 }],
  S: [{ name: 'imm[11:5]', hi: 31, lo: 25 }, { name: 'rs2', hi: 24, lo: 20 }, { name: 'rs1', hi: 19, lo: 15 }, { name: 'funct3', hi: 14, lo: 12 }, { name: 'imm[4:0]', hi: 11, lo: 7 }, { name: 'opcode', hi: 6, lo: 0 }],
  B: [{ name: 'imm[12|10:5]', hi: 31, lo: 25 }, { name: 'rs2', hi: 24, lo: 20 }, { name: 'rs1', hi: 19, lo: 15 }, { name: 'funct3', hi: 14, lo: 12 }, { name: 'imm[4:1|11]', hi: 11, lo: 7 }, { name: 'opcode', hi: 6, lo: 0 }],
  U: [{ name: 'imm[31:12]', hi: 31, lo: 12 }, { name: 'rd', hi: 11, lo: 7 }, { name: 'opcode', hi: 6, lo: 0 }],
  J: [{ name: 'imm[20|10:1|11|19:12]', hi: 31, lo: 12 }, { name: 'rd', hi: 11, lo: 7 }, { name: 'opcode', hi: 6, lo: 0 }],
};
