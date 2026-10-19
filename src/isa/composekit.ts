// What the instruction builder needs from an instruction set, whatever it is: its instructions with
// their operands (slots, in assembly order), encode / decode between a word and spec + operands, the
// word's fields for the strip, the immediate's wiring when it has one, and the text of a word for a
// program (targets by label). Adapters: RV32 (riscv/compose.ts), RV16 (riscv/rv16/compose16.ts),
// tables, the 4-bit CPU's included (isa/compose.ts). DOM-free.

import { commentStart } from '../riscv/asm';

export type Role ='op' | 'rd' | 'rs' | 'fn' | 'imm';

/** One operand as written. */
export interface CSlot {
  key: string;
  /** Shown on its tab or card. */
  label: string;
  kind: 'reg' | 'num' | 'enum';
  /** reg: the register names by number. */
  names?: string[];
  /** enum: the named values. */
  options?: { name: string; value: number }[];
  min: number;
  max: number;
  step: number;
  /** num: what the number is (offset from this instruction, an absolute address, upper bits, ...). */
  role?: 'imm' | 'shamt' | 'offset' | 'target' | 'address' | 'upper';
  /** reg: the destination (drawn in rd's colour). */
  dest?: boolean;
  hex?: boolean;
}

export interface CInstr { id: string; name: string; slots: CSlot[]; summary?: string }
export interface CGroup { name: string; ids: string[]; more?: boolean }

/** A field of a word: tiles the word's bits exactly, most significant first. */
export interface CField { key: string; label: string; hi: number; lo: number; role: Role; used: boolean; meaning: string; value: number }

/** Bit i of the immediate: an instruction bit, ground, or a copy of the sign. */
export interface ImmWire { bit: number; src: number | 'zero'; sign: boolean; value: number }
export interface CImm { wires: ImmWire[]; value: number; text: string; note: string }

export type Parts = Record<string, number>;
export type ParseResult = { word: number } | { words: number[] } | { error: string };

export interface ProgramInfo {
  lines: { addr: number; word: number; srcLine: number }[];
  labels: Map<string, number>;
  errors: { line: number; message: string }[];
  /** Address of the word after the last. */
  end: number;
}

export interface ComposeIsa {
  /** The ROM language ('asm', 'rv16', 'cpu4', 'isa:<id>'). */
  id: string;
  name: string;
  wordBits: number;
  /** Address units per instruction (RV32: 4 bytes; word-addressed ISAs: 1). */
  step: number;
  groups: CGroup[];
  instr(id: string): CInstr | undefined;
  /** The word of an instruction (operands outside their range clamped). */
  encode(id: string, parts: Parts): number;
  /** A word as instruction + operands; null when none matches, or bits are set the builder would not set. */
  decode(word: number): { id: string; parts: Parts } | null;
  /** The instruction a word names even with bits set the builder would not set ("one bit away"). */
  loose(word: number): { id: string; parts: Parts } | null;
  fields(word: number): CField[];
  imm(word: number): CImm | null;
  /** The word as a line of the program: pc in the ISA's address unit, a target by label when one fits. */
  text(word: number, pc?: number, labels?: Map<string, number>): string;
  parse(line: string, pc?: number, labels?: Map<string, number>): ParseResult;
  /** A program's lines and labels (pc units) for the program editor. */
  program(src: string): ProgramInfo;
  /** RV32: the data-path sketch, decode chain and opcode map panels. */
  rv32?: boolean;
  /** Start here when there is no word yet. */
  start: number;
}

/** Fit a value into a slot. */
export function clampSlot(slot: CSlot, v: number): number {
  if (!Number.isFinite(v)) return slot.min;
  // A name list holds only its names: the nearest one.
  if (slot.kind === 'enum' && slot.options?.length) return slot.options.reduce((b, o) => (Math.abs(o.value - v) < Math.abs(b.value - v) ? o : b)).value;
  let r = Math.min(slot.max, Math.max(slot.min, Math.round(v)));
  if (slot.step > 1) r -= ((r - slot.min) % slot.step + slot.step) % slot.step;
  return r;
}

/** Operands for another instruction: those with the same key and kind carry over, clamped; others from `keep`. */
export function carryParts(from: Parts, keep: Parts, to: CInstr): Parts {
  const p: Parts = { ...keep };
  for (const s of to.slots) p[s.key] = clampSlot(s, s.key in from ? from[s.key] : keep[s.key] ?? s.min);
  return p;
}

/** Remember each operand an instruction has (so another one picked later starts from them). */
export function rememberParts(mem: Parts, ins: CInstr | undefined, parts: Parts): Parts {
  if (!ins) return mem;
  const m = { ...mem };
  for (const s of ins.slots) if (s.key in parts) m[s.key] = parts[s.key];
  return m;
}

const LABEL_PREFIX = /^(?:[A-Za-z_.$][\w.$]*\s*:\s*)+/;

/** A line without its labels and comment (#, ;, //). */
export function codeOf(line: string): string {
  return line.slice(0, commentStart(line)).trim().replace(LABEL_PREFIX, '').trim();
}

/** Parse one line with an assembler that resolves a branch's numeric offset: a trailing label becomes
 *  its offset from pc (branchy(mnemonic) says whether the last operand is a target). */
export function parseWithOffsets(
  line: string, assemble: (src: string) => { words: number[]; errors: { message: string }[] },
  wordBits: number, pc = 0, labels?: Map<string, number>, branchy: (op: string) => boolean = () => true,
): ParseResult {
  const t = codeOf(line);
  if (!t) return { error: 'Type an instruction or a hex word.' };
  const hexRe = new RegExp(`^0x[0-9a-f]{1,${wordBits / 4}}$|^[0-9a-f]{${wordBits / 4}}$`, 'i');
  if (hexRe.test(t)) return { word: parseInt(t.replace(/^0x/i, ''), 16) >>> 0 };
  let src = t;
  const m = t.match(/^(\S+)\s+(.*?)([A-Za-z_.$][\w.$]*)$/);
  if (m && labels?.has(m[3]) && branchy(m[1].toLowerCase())) src = `${m[1]} ${m[2]}${labels.get(m[3])! - pc}`;
  const r = assemble(src);
  if (r.errors.length) return { error: r.errors[0].message };
  if (r.words.length === 1) return { word: r.words[0] >>> 0 };
  if (!r.words.length) return { error: 'No instruction on this line.' };
  return { words: r.words };
}

/** The immediate's wiring from the word bits of an operand (most significant first), sign-extended to width. */
export function wiresOf(word: number, srcBits: number[], width: number, signed: boolean, shift = 0): ImmWire[] {
  const n = srcBits.length;
  const top = shift + n - 1;
  return Array.from({ length: width }, (_, i): ImmWire => {
    const src = i < shift ? 'zero' : i <= top ? srcBits[n - 1 - (i - shift)] : signed ? srcBits[0] : 'zero';
    return { bit: i, src, sign: signed && i > top, value: src === 'zero' ? 0 : (word >>> src) & 1 };
  });
}
