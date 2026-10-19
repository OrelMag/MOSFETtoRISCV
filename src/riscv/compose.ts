// The instruction composer's model: an instruction as a spec plus its operands, both ways. Built on
// isa.ts's encoders and decoder (so a composed word is exactly what the assembler emits:
// tests/compose.test.ts runs every instruction through both), with what a UI needs on top: the
// operands in assembly order with their register bank or range, the palette's groups, and the
// text to put back in a program (a branch target named by its label when one sits there).

import { BY_NAME, CSR_NAMES, decode, disasm, encB, encI, encJ, encR, encR4, encS, encU, INSTRS, OPCODES, type InstrSpec } from './isa';

export type SlotKey = 'rd' | 'rs1' | 'rs2' | 'rs3' | 'imm' | 'csr' | 'zimm' | 'rm';

/** One operand as written, in assembly order. */
export interface Slot {
  key: SlotKey;
  /** Register operands: which file. */
  bank?: 'x' | 'f';
  /** imm / zimm / csr: the values it takes (step 2: an even offset). */
  min?: number;
  max?: number;
  step?: number;
  /** imm: what the number means (offset from this instruction, upper 20 bits, ...). */
  role?: 'imm' | 'shamt' | 'offset' | 'target' | 'upper';
}

/** The operands of one instruction (zimm lives in rs1, as in the word). */
export interface Parts { rd: number; rs1: number; rs2: number; rs3: number; imm: number; csr: number; rm: number }

export interface Composed { spec: InstrSpec; parts: Parts }

export const NO_PARTS: Parts = { rd: 0, rs1: 0, rs2: 0, rs3: 0, imm: 0, csr: 0, rm: 7 };

/** Instructions whose word is fixed (no operands; fence's ordering bits are not ours to set). */
export const FIXED: Record<string, number> = { ecall: 0x00000073, ebreak: 0x00100073, mret: 0x30200073, wfi: 0x10500073, fence: 0x0ff0000f };

const isShift = (s: InstrSpec) => s.opcode === OPCODES.OPIMM && (s.funct3 === 1 || s.funct3 === 5);
const isCsr = (s: InstrSpec) => s.opcode === OPCODES.SYSTEM && (s.funct3 ?? 0) !== 0;

const IMM12 = { min: -2048, max: 2047, step: 1 };

/** The operands of `spec` in the order they are written. */
export function slotsOf(spec: InstrSpec): Slot[] {
  if (spec.name in FIXED) return [];
  const fp = spec.fp;
  const x = (key: SlotKey): Slot => ({ key, bank: 'x' });
  const f = (key: SlotKey): Slot => ({ key, bank: 'f' });
  const reg = (key: 'rd' | 'rs1' | 'rs2' | 'rs3', role?: 'f' | 'x') => (role === 'f' ? f(key) : x(key));
  const rm: Slot[] = fp?.rm ? [{ key: 'rm', min: 0, max: 7, step: 1 }] : [];
  if (spec.simt) return spec.simt.map((k) => x(k));
  if (spec.opcode === OPCODES.AMO) return [x('rd'), x('rs2'), x('rs1')];
  if (isCsr(spec)) {
    const src: Slot = spec.funct3! & 4 ? { key: 'zimm', min: 0, max: 31, step: 1 } : x('rs1');
    return [x('rd'), { key: 'csr', min: 0, max: 0xfff, step: 1 }, src];
  }
  if (fp) {
    if (spec.fmt === 'I') return [f('rd'), { key: 'imm', ...IMM12, role: 'offset' }, x('rs1')];
    if (spec.fmt === 'S') return [f('rs2'), { key: 'imm', ...IMM12, role: 'offset' }, x('rs1')];
    if (spec.fmt === 'R4') return [f('rd'), f('rs1'), f('rs2'), f('rs3'), ...rm];
    if (fp.rs2fixed !== undefined) return [reg('rd', fp.rd), reg('rs1', fp.rs1), ...rm];
    return [reg('rd', fp.rd), reg('rs1', fp.rs1), reg('rs2', fp.rs2), ...rm];
  }
  switch (spec.fmt) {
    case 'R': case 'R4': return [x('rd'), x('rs1'), x('rs2')];
    case 'I':
      if (spec.opcode === OPCODES.LOAD || spec.name === 'jalr') return [x('rd'), { key: 'imm', ...IMM12, role: 'offset' }, x('rs1')];
      if (isShift(spec)) return [x('rd'), x('rs1'), { key: 'imm', min: 0, max: 31, step: 1, role: 'shamt' }];
      return [x('rd'), x('rs1'), { key: 'imm', ...IMM12, role: 'imm' }];
    case 'S': return [x('rs2'), { key: 'imm', ...IMM12, role: 'offset' }, x('rs1')];
    case 'B': return [x('rs1'), x('rs2'), { key: 'imm', min: -4096, max: 4094, step: 2, role: 'target' }];
    case 'U': return [x('rd'), { key: 'imm', min: 0, max: 0xfffff, step: 1, role: 'upper' }];
    case 'J': return [x('rd'), { key: 'imm', min: -1048576, max: 1048574, step: 2, role: 'target' }];
  }
}

/** Fit a value into a slot's range and step. */
export function clampTo(slot: Slot, v: number): number {
  if (slot.min === undefined || slot.max === undefined) return Math.max(0, Math.min(31, Math.round(v)));
  let r = Math.min(slot.max, Math.max(slot.min, Math.round(v)));
  if (slot.step === 2 && r % 2) r -= Math.sign(r);
  return r;
}

/** The word of a composed instruction (operands outside their range are clamped). */
export function encodeParts(spec: InstrSpec, p: Parts): number {
  if (spec.name in FIXED) return FIXED[spec.name];
  const slots = slotsOf(spec);
  const v = (k: SlotKey) => {
    const s = slots.find((x) => x.key === k);
    return s ? clampTo(s, k === 'zimm' ? p.rs1 : p[k]) : 0;
  };
  const op = spec.opcode, f3 = spec.funct3 ?? 0;
  if (spec.simt) return encR(op, 0, f3, v('rs1'), v('rs2'), 0);
  if (op === OPCODES.AMO) return encR(op, v('rd'), 2, v('rs1'), v('rs2'), spec.funct7!);
  if (isCsr(spec)) return encI(op, v('rd'), f3, spec.funct3! & 4 ? v('zimm') : v('rs1'), v('csr'));
  const fp = spec.fp;
  switch (spec.fmt) {
    case 'R4': return encR4(op, v('rd'), v('rm'), v('rs1'), v('rs2'), v('rs3'));
    case 'R': return encR(op, v('rd'), fp?.rm ? v('rm') : f3, v('rs1'), fp?.rs2fixed ?? v('rs2'), spec.funct7!);
    case 'I': return encI(op, v('rd'), f3, v('rs1'), isShift(spec) ? (spec.funct7! << 5) | v('imm') : v('imm'));
    case 'S': return encS(op, f3, v('rs1'), v('rs2'), v('imm'));
    case 'B': return encB(op, f3, v('rs1'), v('rs2'), v('imm'));
    case 'U': return encU(op, v('rd'), v('imm'));
    case 'J': return encJ(op, v('rd'), v('imm'));
  }
}

/** A word as spec + operands, or null when no instruction decodes it (or its fixed bits differ). */
export function partsOf(word: number): Composed | null {
  const w = word >>> 0;
  const d = decode(w);
  const spec = d.spec;
  if (!spec) return null;
  if (spec.name in FIXED) return FIXED[spec.name] === w ? { spec, parts: { ...NO_PARTS } } : null;
  const parts: Parts = {
    rd: d.rd, rs1: d.rs1, rs2: d.rs2, rs3: d.rs3, csr: w >>> 20, rm: d.funct3,
    imm: spec.fmt === 'U' ? d.imm >>> 12 : d.imm,
  };
  const c = { spec, parts };
  // Bits the composer cannot set (an AMO's aq / rl, an R4's fmt above S, a SIMT's rd) make the
  // word one it would not build: keep those out rather than lose them silently.
  return encodeParts(spec, parts) === w ? c : null;
}

/** Re-target a composed instruction at another spec, keeping what carries over. */
export function retarget(from: Parts, spec: InstrSpec): Parts {
  const p = { ...from };
  for (const s of slotsOf(spec)) if (s.key === 'imm' || s.key === 'csr') p[s.key] = clampTo(s, p[s.key]);
  if (spec.fp?.rm && p.rm > 4 && p.rm !== 7) p.rm = 7;
  return p;
}

/** The assembly text of a word for a program: disasm, with a branch / jump target by label. */
export function textOf(word: number, pc?: number, labels?: Map<string, number>): string {
  const d = decode(word);
  const base = disasm(word);
  if (pc === undefined || !labels || !d.spec || (d.fmt !== 'B' && d.fmt !== 'J')) return base;
  const at = pc + d.imm;
  for (const [name, addr] of labels) if (addr === at) return base.replace(/-?\d+$/, name);
  return base;
}

/** Parse one line of assembly or a hex word into a word; labels resolve against pc. */
export function parseLine(text: string, assemble: (src: string) => { words: number[]; errors: { message: string }[] }, pc = 0, labels?: Map<string, number>): { word: number } | { words: number[] } | { error: string } {
  const t = text.replace(/#.*/, '').trim().replace(/^(?:[A-Za-z_.$][\w.$]*\s*:\s*)+/, '');
  if (!t) return { error: 'Type an instruction (addi a0, a0, -1) or a hex word (0xfff50513).' };
  if (/^0x[0-9a-f]{1,8}$/i.test(t) || /^[0-9a-f]{8}$/i.test(t)) return { word: parseInt(t.replace(/^0x/i, ''), 16) >>> 0 };
  // A label as the last operand of a branch / jump becomes its offset from this instruction.
  let src = t;
  const m = t.match(/^(\S+)\s+(.*?)([A-Za-z_.$][\w.$]*)$/);
  if (m && labels?.has(m[3])) {
    const spec = BY_NAME.get(m[1].toLowerCase());
    const branchy = !spec || spec.fmt === 'B' || spec.fmt === 'J';
    if (branchy) src = `${m[1]} ${m[2]}${labels.get(m[3])! - pc}`;
  }
  const r = assemble(src);
  if (r.errors.length) return { error: r.errors[0].message };
  if (r.words.length === 1) return { word: r.words[0] >>> 0 };
  return { words: r.words };
}

export interface PaletteGroup { id: string; name: string; names: string[]; more?: boolean }

/** The picker's groups, by what an instruction does (more: hidden until "More"). */
export const PALETTE: PaletteGroup[] = [
  { id: 'r', name: 'Register', names: ['add', 'sub', 'and', 'or', 'xor', 'sll', 'srl', 'sra', 'slt', 'sltu'] },
  { id: 'i', name: 'Immediate', names: ['addi', 'andi', 'ori', 'xori', 'slti', 'sltiu', 'slli', 'srli', 'srai'] },
  { id: 'ld', name: 'Load', names: ['lw', 'lh', 'lb', 'lhu', 'lbu'] },
  { id: 'st', name: 'Store', names: ['sw', 'sh', 'sb'] },
  { id: 'br', name: 'Branch', names: ['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'] },
  { id: 'j', name: 'Jump · upper', names: ['jal', 'jalr', 'lui', 'auipc'] },
  { id: 'm', name: 'Multiply', names: ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'] },
  { id: 'sys', name: 'System', names: ['ecall', 'ebreak', 'mret', 'wfi', 'fence', 'csrrw', 'csrrs', 'csrrc', 'csrrwi', 'csrrsi', 'csrrci'] },
  { id: 'a', name: 'Atomic', names: ['amoswap.w', 'amoadd.w'], more: true },
  { id: 'f', name: 'Float', names: INSTRS.filter((s) => s.fp).map((s) => s.name), more: true },
  { id: 'simt', name: 'SIMT (lanes)', names: INSTRS.filter((s) => s.simt).map((s) => s.name), more: true },
];

/** A CSR operand's name (or its number in hex). */
export const csrName = (n: number) => CSR_NAMES[n] ?? `0x${n.toString(16)}`;
