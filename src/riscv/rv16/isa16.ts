// RV16: the campaign's 16-bit RISC-V-like instruction set (docs/CAMPAIGN.md §3). 16-bit data and
// instructions, 8 registers (x0 = 0), word addressed. Every field has a fixed position:
//   op [3:0] · rd [6:4] · rs1 [9:7] · rs2 [12:10] · f3 [15:13]
// This table is the single source of truth for the assembler, the golden model, the disassembler
// and the instruction drills.

export const OP16 = {
  SYSTEM: 0, OP: 1, OPX: 2, MD: 3, ADDI: 4, SHI: 5, LW: 6, LUI: 7,
  BEQ: 8, BNE: 9, BLT: 10, BGE: 11, JAL: 12, JALR: 13, SW: 14, /* 15: LUI (op[3] is an immediate bit) */
} as const;

export type Fmt16 = 'R' | 'I' | 'SH' | 'U' | 'B' | 'J' | 'S' | 'SYS' | 'CSR';

export interface Instr16 {
  name: string;
  fmt: Fmt16;
  op: number;
  f3?: number;
  /** SHI: the shift type in imm[5:4]; SYS: the rs2 field. */
  sub?: number;
  /** In the optional M extension (MD opcode) or the system (CSR / trap) part. */
  ext?: 'm' | 'system';
}

const R = (name: string, op: number, f3: number, ext?: 'm'): Instr16 => ({ name, fmt: 'R', op, f3, ...(ext ? { ext } : {}) });

export const INSTRS16: Instr16[] = [
  R('add', 1, 0), R('sll', 1, 1), R('slt', 1, 2), R('sltu', 1, 3), R('xor', 1, 4), R('srl', 1, 5), R('or', 1, 6), R('and', 1, 7),
  R('sub', 2, 0), R('sra', 2, 5),
  R('mul', 3, 0, 'm'), R('mulh', 3, 1, 'm'), R('mulhsu', 3, 2, 'm'), R('mulhu', 3, 3, 'm'),
  R('div', 3, 4, 'm'), R('divu', 3, 5, 'm'), R('rem', 3, 6, 'm'), R('remu', 3, 7, 'm'),
  { name: 'addi', fmt: 'I', op: 4 },
  { name: 'slli', fmt: 'SH', op: 5, sub: 0 }, { name: 'srli', fmt: 'SH', op: 5, sub: 1 }, { name: 'srai', fmt: 'SH', op: 5, sub: 2 },
  { name: 'lw', fmt: 'I', op: 6 },
  { name: 'lui', fmt: 'U', op: 7 },
  { name: 'beq', fmt: 'B', op: 8 }, { name: 'bne', fmt: 'B', op: 9 }, { name: 'blt', fmt: 'B', op: 10 }, { name: 'bge', fmt: 'B', op: 11 },
  { name: 'jal', fmt: 'J', op: 12 }, { name: 'jalr', fmt: 'I', op: 13 }, { name: 'sw', fmt: 'S', op: 14 },
  { name: 'ecall', fmt: 'SYS', op: 0, f3: 0, sub: 1, ext: 'system' }, { name: 'ebreak', fmt: 'SYS', op: 0, f3: 0, sub: 2, ext: 'system' },
  { name: 'mret', fmt: 'SYS', op: 0, f3: 0, sub: 3, ext: 'system' }, { name: 'wfi', fmt: 'SYS', op: 0, f3: 0, sub: 4, ext: 'system' },
  { name: 'csrrw', fmt: 'CSR', op: 0, f3: 1, ext: 'system' }, { name: 'csrrs', fmt: 'CSR', op: 0, f3: 2, ext: 'system' },
  { name: 'csrrc', fmt: 'CSR', op: 0, f3: 3, ext: 'system' },
];

export const BY_NAME16 = new Map(INSTRS16.map((i) => [i.name, i]));

export const REG_NAMES16 = ['zero', 'ra', 'sp', 'a0', 'a1', 'a2', 't0', 't1'];

/** x0–x7 or an ABI name → number, else null. */
export function reg16(s: string): number | null {
  const t = s.trim().toLowerCase();
  const m = t.match(/^x([0-7])$/);
  if (m) return Number(m[1]);
  const i = REG_NAMES16.indexOf(t);
  return i >= 0 ? i : null;
}

export const CSRS16 = ['mstatus', 'mie', 'mip', 'mtvec', 'mepc', 'mcause', 'mscratch', 'mcycle'];
export const CSR16 = { mstatus: 0, mie: 1, mip: 2, mtvec: 3, mepc: 4, mcause: 5, mscratch: 6, mcycle: 7 } as const;
/** mstatus bits, mie / mip bits, mcause values. */
export const MSTATUS_MIE = 1 << 3, MSTATUS_MPIE = 1 << 7;
export const MIP_MTIP = 1 << 7, MIP_MEIP = 1 << 11;
export const CAUSE = { illegal: 2, breakpoint: 3, ecall: 11, timer: 0x8007, external: 0x800b } as const;

/** Memory-mapped I/O: the top of the data address space, reachable as imm(x0). */
export const MMIO16 = { EXIT: 0xffff, CONSOLE: 0xfffe, OUT: 0xfffd, IN: 0xfffc, LEDS: 0xfffb, SWITCHES: 0xfffa, IRQ: 0xfff9, MTIME: 0xfff8, MTIMECMP: 0xfff7 } as const;
export const MMIO_BASE = 0xfff7;

export const sext = (v: number, bits: number) => {
  const m = 1 << (bits - 1);
  return ((v & ((1 << bits) - 1)) ^ m) - m;
};

/** The fields of a word (all of them, whatever the format). */
export function fields16(w: number) {
  return { op: w & 15, rd: (w >> 4) & 7, rs1: (w >> 7) & 7, rs2: (w >> 10) & 7, f3: (w >> 13) & 7 };
}

/** The immediate of each format, sign-extended (U: the 16-bit value loaded). */
export const immI = (w: number) => sext(w >> 10, 6);
export const immSB = (w: number) => sext((((w >> 13) & 7) << 3) | ((w >> 4) & 7), 6);
export const immJ = (w: number) => sext(w >> 7, 9);
export const immU = (w: number) => (((((w >> 7) & 0x1ff) << 1) | ((w >> 3) & 1)) << 6) & 0xffff;

export interface Decoded16 {
  spec: Instr16 | null;
  rd: number;
  rs1: number;
  rs2: number;
  imm: number;
  /** CSR index (CSR format). */
  csr: number;
}

/** Decode a word. spec is null for an illegal instruction. */
export function decode16(w: number): Decoded16 {
  w &= 0xffff;
  const f = fields16(w);
  const d: Decoded16 = { spec: null, rd: f.rd, rs1: f.rs1, rs2: f.rs2, imm: 0, csr: f.rs2 };
  const op = f.op;
  if ((op & 7) === 7) return { ...d, spec: BY_NAME16.get('lui')!, imm: immU(w) };
  let spec: Instr16 | undefined;
  switch (op) {
    case 0:
      spec = f.f3 === 0 ? INSTRS16.find((i) => i.fmt === 'SYS' && i.sub === f.rs2) : INSTRS16.find((i) => i.fmt === 'CSR' && i.f3 === f.f3);
      break;
    case 1: case 2: case 3:
      spec = INSTRS16.find((i) => i.fmt === 'R' && i.op === op && i.f3 === f.f3);
      break;
    case 5:
      spec = INSTRS16.find((i) => i.fmt === 'SH' && i.sub === ((w >> 14) & 3));
      return spec ? { ...d, spec, imm: (w >> 10) & 15 } : d;
    default:
      spec = INSTRS16.find((i) => i.op === op);
  }
  if (!spec) return d;
  const imm = spec.fmt === 'I' ? immI(w) : spec.fmt === 'B' || spec.fmt === 'S' ? immSB(w) : spec.fmt === 'J' ? immJ(w) : 0;
  return { ...d, spec, imm };
}

const rn = (r: number) => REG_NAMES16[r];

/** Assembly text of a word; pc (a word address) resolves branch and jump targets. */
export function disasm16(w: number, pc?: number): string {
  const d = decode16(w);
  const s = d.spec;
  if (!s) return `.word 0x${(w & 0xffff).toString(16).padStart(4, '0')}`;
  const tgt = (off: number) => (pc === undefined ? String(off) : `0x${((pc + off) & 0xffff).toString(16)}`);
  switch (s.fmt) {
    case 'R': return `${s.name} ${rn(d.rd)}, ${rn(d.rs1)}, ${rn(d.rs2)}`;
    case 'SH': return `${s.name} ${rn(d.rd)}, ${rn(d.rs1)}, ${d.imm}`;
    case 'U': return `lui ${rn(d.rd)}, 0x${(d.imm >> 6).toString(16)}`;
    case 'B': return `${s.name} ${rn(d.rs1)}, ${rn(d.rs2)}, ${tgt(d.imm)}`;
    case 'J': return d.rd === 0 && d.imm === 0 ? 'halt' : `jal ${rn(d.rd)}, ${tgt(d.imm)}`;
    case 'S': return `sw ${rn(d.rs2)}, ${d.imm}(${rn(d.rs1)})`;
    case 'SYS': return s.name;
    case 'CSR': return `${s.name} ${rn(d.rd)}, ${CSRS16[d.csr]}, ${rn(d.rs1)}`;
    default:
      if (s.name === 'lw' || s.name === 'jalr') return `${s.name} ${rn(d.rd)}, ${d.imm}(${rn(d.rs1)})`;
      if (s.name === 'addi' && d.rd === 0 && d.rs1 === 0 && d.imm === 0) return 'nop';
      return `${s.name} ${rn(d.rd)}, ${rn(d.rs1)}, ${d.imm}`;
  }
}

// ---- encoding ---------------------------------------------------------------------------------

const chk = (v: number, lo: number, hi: number, what: string) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} ${v} out of range ${lo}…${hi}`);
  return v;
};

export const encR = (op: number, f3: number, rd: number, rs1: number, rs2: number) => (f3 << 13) | (rs2 << 10) | (rs1 << 7) | (rd << 4) | op;
export const encI = (op: number, rd: number, rs1: number, imm: number) => ((chk(imm, -32, 31, 'immediate') & 63) << 10) | (rs1 << 7) | (rd << 4) | op;
export const encSB = (op: number, rs1: number, rs2: number, imm: number) => {
  const v = chk(imm, -32, 31, 'offset') & 63;
  return ((v >> 3) << 13) | (rs2 << 10) | (rs1 << 7) | ((v & 7) << 4) | op;
};
export const encJ = (rd: number, imm: number) => ((chk(imm, -256, 255, 'jump offset') & 0x1ff) << 7) | (rd << 4) | OP16.JAL;
/** lui rd, imm10: rd = imm10 << 6. */
export const encU = (rd: number, imm10: number) => {
  const v = chk(imm10, 0, 1023, 'upper immediate');
  return ((v >> 1) << 7) | ((v & 1) << 3) | (rd << 4) | 7;
};
export const encSH = (type: number, rd: number, rs1: number, sh: number) => (type << 14) | (chk(sh, 0, 15, 'shift amount') << 10) | (rs1 << 7) | (rd << 4) | OP16.SHI;
export const encSYS = (sub: number) => (sub << 10) | OP16.SYSTEM;
export const encCSR = (f3: number, rd: number, csr: number, rs1: number) => (f3 << 13) | (csr << 10) | (rs1 << 7) | (rd << 4) | OP16.SYSTEM;

/** %hi / %lo for li: value = (hi << 6) + sext6(lo). */
export function hiLo(v: number): { hi: number; lo: number } {
  const x = v & 0xffff;
  const lo = sext(x, 6);
  const hi = ((x - lo) >> 6) & 0x3ff;
  return { hi, lo };
}
