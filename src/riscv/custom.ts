// Custom RV32 instructions (DOM-free): one of the three free major opcodes (custom-1, custom-2, custom-3;
// custom-0 holds the lane cores' SIMT instructions), a format, a funct3, and what the instruction does as
// one row of the single-cycle CPU's control signals (lib/cpu.ts CONTROL). The same row drives three
// things that therefore cannot disagree: the control unit's new opcode class (lib/cpu.ts control()),
// the golden model (iss.ts runs execCustom), and the assembler / disassembler (asm.ts, isa.ts take the
// rows). One instruction per slot: CONTROL's classes match opcode[6:2] only, so funct3 is the
// instruction's own (it can pick the ALU operation, as in an I-type instruction).

import type { Fmt, InstrSpec } from './isa';

export type CustomFmt = 'R' | 'I' | 'S' | 'B' | 'U';

export interface CustomRow {
  /** Mnemonic: lower case, not an existing instruction or pseudo-instruction. */
  name: string;
  /** custom-1, custom-2 or custom-3. */
  slot: 1 | 2 | 3;
  fmt: CustomFmt;
  funct3: number;
  regWrite: boolean;
  srcA: 'rs1' | 'pc';
  srcB: 'rs2' | 'imm';
  /** add, subtract, or the instruction's funct3 picks (add sll slt sltu xor srl/sra or and, as OP-IMM). */
  alu: 'add' | 'sub' | 'funct3';
  memWrite: boolean;
  result: 'alu' | 'mem' | 'pc4' | 'imm';
  /** PC + 4, a branch on funct3 (the flags of rs1 − rs2), PC + imm, or the ALU result (bit 0 cleared). */
  next: 'pc4' | 'branch' | 'jump' | 'jalr';
}

/** opcode[6:2] of each custom slot. */
export const SLOT_CODE: Record<1 | 2 | 3, number> = { 1: 0b01010, 2: 0b10110, 3: 0b11110 };
export const slotOpcode = (slot: 1 | 2 | 3) => (SLOT_CODE[slot] << 2) | 3;

/** The fields each format carries. */
export const FMT_FIELDS: Record<CustomFmt, { rd: boolean; rs1: boolean; rs2: boolean; imm: boolean }> = {
  R: { rd: true, rs1: true, rs2: true, imm: false },
  I: { rd: true, rs1: true, rs2: false, imm: true },
  S: { rd: false, rs1: true, rs2: true, imm: true },
  B: { rd: false, rs1: true, rs2: true, imm: true },
  U: { rd: true, rs1: false, rs2: false, imm: true },
};

/** ImmSrc of a format (lib/cpu.ts IMM_GEN: 0 I, 1 S, 2 B, 3 U). */
export const IMM_SRC_OF: Record<CustomFmt, number> = { R: 0, I: 0, S: 1, B: 2, U: 3 };

export interface Problem { level: 'bad' | 'warn' | 'note'; text: string }

/** What a row reads and uses (the data path, the problems, the cost). */
export function uses(r: CustomRow) {
  const alu = r.result === 'alu' || r.result === 'mem' || r.memWrite || r.next === 'branch' || r.next === 'jalr';
  return {
    alu,
    rs1: alu && r.srcA === 'rs1',
    rs2: (alu && r.srcB === 'rs2') || r.memWrite,
    imm: (alu && r.srcB === 'imm') || (r.regWrite && r.result === 'imm') || r.next === 'jump' || r.next === 'branch',
    mem: r.memWrite || (r.regWrite && r.result === 'mem'),
  };
}

/** Why a row cannot be built (bad), or what to know about it. names: mnemonics already taken. */
export function problemsOf(r: CustomRow, taken: Set<string> = new Set()): Problem[] {
  const p: Problem[] = [];
  const f = FMT_FIELDS[r.fmt], u = uses(r);
  if (!/^[a-z][a-z0-9_.]*$/.test(r.name)) p.push({ level: 'bad', text: 'A mnemonic is lower-case letters, digits, _ or .' });
  else if (taken.has(r.name)) p.push({ level: 'bad', text: `${r.name} is already an instruction or pseudo-instruction.` });
  if (r.regWrite && !f.rd) p.push({ level: 'bad', text: `${r.fmt}-type has no rd: nothing to write. Pick R, I or U.` });
  if (u.imm && !f.imm) p.push({ level: 'bad', text: `${r.fmt}-type carries no immediate. Pick I, S, B or U.` });
  if (u.rs2 && !f.rs2) p.push({ level: 'bad', text: `${r.fmt}-type has no rs2.` });
  if (u.rs1 && !f.rs1) p.push({ level: 'bad', text: `${r.fmt}-type has no rs1: use PC as A, or another format.` });
  if (r.next === 'branch' && (r.alu !== 'sub' || r.srcB !== 'rs2' || r.srcA !== 'rs1')) p.push({ level: 'bad', text: 'Branch conditions come from the flags of rs1 − rs2: A = rs1, B = rs2, ALU subtract.' });
  if (r.next === 'branch' && r.fmt !== 'B') p.push({ level: 'bad', text: 'A branch needs rs1, rs2 and an offset: B-type.' });
  if (r.next === 'jump' && r.fmt === 'S') p.push({ level: 'warn', text: 'The jump offset is the S immediate (its bits split around rs2).' });
  if (r.memWrite && r.regWrite && r.result === 'mem') p.push({ level: 'warn', text: 'Reads and writes memory in one cycle: the read sees the old word (the write lands at the clock edge).' });
  if (r.memWrite && r.srcB === 'rs2') p.push({ level: 'note', text: 'The address is rs1 + rs2 and the data is rs2 too: one register, two jobs. RISC-V stores at rs1 + imm for this reason.' });
  if (r.alu === 'funct3' && r.next === 'branch') p.push({ level: 'bad', text: 'A branch needs the subtract: funct3 picks the condition, not the ALU operation.' });
  if (!r.regWrite && !r.memWrite && r.next === 'pc4') p.push({ level: 'warn', text: 'Writes nothing and goes on: a nop.' });
  return p;
}

export const buildable = (r: CustomRow, taken?: Set<string>) => !problemsOf(r, taken).some((x) => x.level === 'bad');

/** The row as an instruction spec for decode / disasm / the assembler (funct7 0 for R). */
export function specOf(r: CustomRow): InstrSpec & { custom: CustomRow } {
  return { name: r.name, fmt: r.fmt as Fmt, opcode: slotOpcode(r.slot), funct3: r.fmt === 'U' ? undefined : r.funct3, ...(r.fmt === 'R' ? { funct7: 0 } : {}), hw: true, custom: r };
}

/** The row in words: "rd ← mem[rs1 + rs2]". */
export function meaning(r: CustomRow): string[] {
  const A = r.srcA === 'pc' ? 'pc' : 'rs1', B = r.srcB === 'imm' ? 'imm' : 'rs2';
  const op = r.alu === 'add' ? `${A} + ${B}` : r.alu === 'sub' ? `${A} − ${B}` : `${A} op[funct3] ${B}`;
  const res = { alu: op, mem: `mem[${op}]`, pc4: 'pc + 4', imm: 'imm' }[r.result];
  const out: string[] = [];
  if (r.regWrite) out.push(`rd ← ${res}`);
  if (r.memWrite) out.push(`mem[${op}] ← rs2`);
  if (r.next === 'branch') out.push(`if (rs1 ${['=', '≠', '?', '?', '<', '≥', '<u', '≥u'][r.funct3]} rs2) pc ← pc + imm`);
  if (r.next === 'jump') out.push('pc ← pc + imm');
  if (r.next === 'jalr') out.push(`pc ← (${op}) & ~1`);
  return out.length ? out : ['(nothing: a nop)'];
}

/** The control signals the row asserts (CONTROL's OR inputs it adds; lib/cpu.ts control()). */
export function signalsOf(r: CustomRow): string[] {
  const s: string[] = [];
  if (r.regWrite) s.push('regWrite');
  if (r.srcB === 'imm') s.push('aluSrcB');
  if (r.srcA === 'pc') s.push('aluSrcA');
  if (r.memWrite) s.push('memWrite');
  const res = r.regWrite ? r.result : 'alu';
  if (res === 'mem' || res === 'imm') s.push('resSrc0');
  if (res === 'pc4' || res === 'imm') s.push('resSrc1');
  const imm = IMM_SRC_OF[r.fmt];
  if (uses(r).imm) { if (imm & 1) s.push('immSrc0'); if (imm & 2) s.push('immSrc1'); }
  if (r.alu === 'funct3') s.push('aluOp');
  if (r.alu === 'sub') s.push('alt');
  if (r.next === 'branch') s.push('branch');
  if (r.next === 'jump') s.push('jump');
  if (r.next === 'jalr') s.push('jalr');
  return s;
}

/** The ALU as the control unit drives it for this row: ctl[2:0] = funct3 when funct3 picks, ctl[3] = sub, or
 *  sra (funct3 101 with instruction bit 30), exactly as lib/cpu.ts's ALU decoder does. */
export function aluCtlOf(r: CustomRow, word: number): number {
  const f3 = (word >>> 12) & 7, b30 = (word >>> 30) & 1;
  if (r.alu === 'sub') return 0b1000;
  if (r.alu === 'add') return 0;
  return f3 | (b30 && f3 === 5 ? 0b1000 : 0);
}

/** lib/alu.ts's operation for a 4-bit control. */
export function aluOp(ctl: number, a: number, b: number): number {
  const sh = b & 31;
  switch (ctl & 7) {
    case 0: return ctl & 8 ? (a - b) | 0 : (a + b) | 0;
    case 1: return (a << sh) | 0;
    case 2: return (a | 0) < (b | 0) ? 1 : 0;
    case 3: return a >>> 0 < b >>> 0 ? 1 : 0;
    case 4: return (a ^ b) | 0;
    case 5: return ctl & 8 ? (a | 0) >> sh : (a >>> sh) | 0;
    case 6: return (a | b) | 0;
    default: return (a & b) | 0;
  }
}

/** The branch condition of funct3 on rs1 − rs2 (lib/cpu.ts NEXT_PC). */
export function branchTaken(f3: number, a: number, b: number): boolean {
  switch (f3) {
    case 0: return a === b;
    case 1: return a !== b;
    case 4: return (a | 0) < (b | 0);
    case 5: return (a | 0) >= (b | 0);
    case 6: return a >>> 0 < b >>> 0;
    case 7: return a >>> 0 >= b >>> 0;
    default: return false;
  }
}

export interface CustomMachine {
  pc: number;
  x: Int32Array | number[];
  load(addr: number): number;
  store(addr: number, value: number): void;
}

/** One custom instruction on the golden model, from its row: returns the next PC. */
export function execCustom(r: CustomRow, word: number, imm: number, m: CustomMachine): number {
  const rd = (word >>> 7) & 31, rs1 = (word >>> 15) & 31, rs2 = (word >>> 20) & 31, f3 = (word >>> 12) & 7;
  const f = FMT_FIELDS[r.fmt];
  // The register file reads whatever bits sit in rs1 / rs2, whatever the format (as the hardware does).
  const x1 = m.x[rs1] | 0, x2 = m.x[rs2] | 0;
  const A = r.srcA === 'pc' ? m.pc | 0 : x1, B = r.srcB === 'imm' ? imm | 0 : x2;
  const y = aluOp(aluCtlOf(r, word), A, B);
  const old = r.regWrite && r.result === 'mem' ? m.load(y >>> 0) : 0;
  if (r.memWrite) m.store(y >>> 0, x2);
  if (r.regWrite && f.rd && rd) m.x[rd] = { alu: y, mem: old, pc4: (m.pc + 4) | 0, imm: imm | 0 }[r.result] | 0;
  switch (r.next) {
    case 'branch': return branchTaken(f3, x1, x2) ? (m.pc + imm) >>> 0 : (m.pc + 4) >>> 0;
    case 'jump': return (m.pc + imm) >>> 0;
    case 'jalr': return (y & ~1) >>> 0;
    default: return (m.pc + 4) >>> 0;
  }
}

/** A stored row, checked field by field (null: not one). */
export function sanitizeRow(x: unknown): CustomRow | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, opts: readonly T[]): T | null => (opts.includes(v as T) ? (v as T) : null);
  const slot = o.slot === 1 || o.slot === 2 || o.slot === 3 ? o.slot : null;
  const fmt = pick(o.fmt, ['R', 'I', 'S', 'B', 'U'] as const), srcA = pick(o.srcA, ['rs1', 'pc'] as const), srcB = pick(o.srcB, ['rs2', 'imm'] as const);
  const alu = pick(o.alu, ['add', 'sub', 'funct3'] as const), result = pick(o.result, ['alu', 'mem', 'pc4', 'imm'] as const), next = pick(o.next, ['pc4', 'branch', 'jump', 'jalr'] as const);
  if (typeof o.name !== 'string' || o.name.length > 24 || !slot || !fmt || !srcA || !srcB || !alu || !result || !next) return null;
  const f3 = Number(o.funct3);
  if (!Number.isInteger(f3) || f3 < 0 || f3 > 7) return null;
  return { name: o.name, slot, fmt, funct3: f3, regWrite: o.regWrite === true, srcA, srcB, alu, memWrite: o.memWrite === true, result, next };
}

/** Rows as stored: sanitized, one per slot and per name (later ones dropped). */
export function sanitizeRows(x: unknown): CustomRow[] {
  if (!Array.isArray(x)) return [];
  const out: CustomRow[] = [];
  for (const v of x.slice(0, 32)) {
    const r = sanitizeRow(v);
    if (r && !out.some((o) => o.slot === r.slot || o.name === r.name)) out.push(r);
    if (out.length === 3) break;
  }
  return out;
}

/** A short stable key for a set of rows (memo keys, chip ids). */
export function rowsKey(rows: readonly CustomRow[]): string {
  const s = JSON.stringify([...rows].sort((a, b) => a.slot - b.slot));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Starting points (the mockup's presets). */
export const CUSTOM_PRESETS: CustomRow[] = [
  { name: 'lwx', slot: 1, fmt: 'R', funct3: 0, regWrite: true, srcA: 'rs1', srcB: 'rs2', alu: 'add', memWrite: false, result: 'mem', next: 'pc4' },
  { name: 'ldi', slot: 1, fmt: 'I', funct3: 0, regWrite: true, srcA: 'rs1', srcB: 'imm', alu: 'add', memWrite: false, result: 'imm', next: 'pc4' },
  { name: 'subi', slot: 2, fmt: 'I', funct3: 0, regWrite: true, srcA: 'rs1', srcB: 'imm', alu: 'sub', memWrite: false, result: 'alu', next: 'pc4' },
  { name: 'swx', slot: 3, fmt: 'R', funct3: 0, regWrite: false, srcA: 'rs1', srcB: 'rs2', alu: 'add', memWrite: true, result: 'alu', next: 'pc4' },
];
