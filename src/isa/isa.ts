// One shape for every instruction set a ROM can hold: the built-in ones (RV32, RV16, the 4-bit CPU)
// and the tables of the sandbox's Custom ISA. What the program editor, the listing, the CPU drawer
// and program puzzles need from an ISA: assemble, disassemble, the fields of a word, the words a
// highlighter knows. Golden models stay per ISA (a table says how instructions are written only).

import { assemble, DIRECTIVES, PSEUDO_OPS } from '../riscv/asm';
import { fieldsOf } from '../riscv/fields';
import { ABI, BY_NAME, disasm, FABI } from '../riscv/isa';
import { assemble16, DIRECTIVES16, PSEUDO16 } from '../riscv/rv16/asm16';
import { BY_NAME16, disasm16, REG_NAMES16 } from '../riscv/rv16/isa16';
import { assemble4, DIRECTIVES4 } from '../isa4/asm4';
import { BY_NAME4, disasm4, fields4, JCN_NAMES } from '../isa4/isa4';
import { type IsaDoc, tableOf, type WordField } from './table';

export interface IsaAsm {
  words: number[];
  errors: { line: number; message: string }[];
  /** addr: the word index. */
  lines: { addr: number; word: number; text: string; srcLine: number }[];
  labels: Map<string, number>;
}

export interface Isa {
  /** The ROM language: 'asm' (RV32), 'rv16', 'cpu4', or 'isa:<id>' for a table. */
  id: string;
  name: string;
  wordBits: 8 | 16 | 32;
  /** 'byte': the PC counts bytes (RV32); 'word': it counts words. */
  addressing: 'byte' | 'word';
  assemble(src: string): IsaAsm;
  /** pc: the word's address in the ISA's own unit (bytes for RV32, words otherwise). */
  disasm(word: number, pc?: number): string;
  /** The word's fields, most significant first. */
  fields(word: number): WordField[];
  words: { mnemonics: string[]; registers: string[]; keywords: string[]; directives: string[] };
}

const RV32: Isa = {
  id: 'asm', name: 'RV32 assembly', wordBits: 32, addressing: 'byte',
  assemble: (src) => {
    const r = assemble(src);
    return { words: r.words, errors: r.errors, labels: r.labels, lines: r.lines.map((l) => ({ ...l, addr: l.addr / 4 })) };
  },
  disasm: (w, pc) => disasm(w, pc),
  fields: (w) => fieldsOf(w).map((f) => ({ name: f.label, bits: f.hi - f.lo + 1, value: f.value, kind: f.key === 'opcode' ? 'op' : f.key === 'rd' || f.key.startsWith('rs') ? 'reg' : f.key.startsWith('funct') ? 'cond' : f.used ? 'imm' : 'none' })),
  words: { mnemonics: [...BY_NAME.keys(), ...PSEUDO_OPS], registers: [...ABI, ...FABI, ...Array.from({ length: 32 }, (_, i) => `x${i}`)], keywords: [], directives: [...DIRECTIVES] },
};

const RV16: Isa = {
  id: 'rv16', name: 'RV16 assembly', wordBits: 16, addressing: 'word',
  assemble: (src) => assemble16(src),
  disasm: (w, pc) => disasm16(w, pc),
  fields: (w) => [
    { name: 'f3', bits: 3, value: (w >> 13) & 7, kind: 'cond' }, { name: 'rs2', bits: 3, value: (w >> 10) & 7, kind: 'reg' },
    { name: 'rs1', bits: 3, value: (w >> 7) & 7, kind: 'reg' }, { name: 'rd', bits: 3, value: (w >> 4) & 7, kind: 'reg' },
    { name: 'op', bits: 4, value: w & 15, kind: 'op' },
  ],
  words: { mnemonics: [...BY_NAME16.keys(), ...PSEUDO16], registers: [...REG_NAMES16, ...Array.from({ length: 8 }, (_, i) => `x${i}`)], keywords: [], directives: [...DIRECTIVES16] },
};

const CPU4: Isa = {
  id: 'cpu4', name: '4-bit CPU (4004)', wordBits: 16, addressing: 'word',
  assemble: (src) => assemble4(src),
  disasm: (w) => disasm4(w),
  fields: (w) => fields4(w),
  words: {
    mnemonics: [...BY_NAME4.keys()], registers: [...Array.from({ length: 16 }, (_, i) => `R${i}`), ...Array.from({ length: 8 }, (_, i) => `P${i}`)],
    keywords: Object.keys(JCN_NAMES).map((k) => k.toUpperCase()), directives: [...DIRECTIVES4],
  },
};

const TABLE_DIRECTIVES = ['.word', '.org'];

const tableIsas = new WeakMap<IsaDoc, Isa>();
/** An Isa over a Custom ISA table (cached per document object). */
export function tableIsa(doc: IsaDoc): Isa {
  let isa = tableIsas.get(doc);
  if (isa) return isa;
  const t = tableOf(doc);
  isa = {
    id: `isa:${doc.id}`, name: doc.name, wordBits: doc.wordBits, addressing: 'word',
    assemble: (src) => t.assemble(src),
    disasm: (w, pc) => t.disasm(w, pc),
    fields: (w) => t.fields(w),
    words: { ...t.words(), directives: TABLE_DIRECTIVES },
  };
  tableIsas.set(doc, isa);
  return isa;
}

/** The built-in ISAs by ROM language. */
export const BUILTIN_ISAS: Record<string, Isa> = { asm: RV32, rv16: RV16, cpu4: CPU4 };

/** The ISA of a ROM language ('asm', 'rv16', 'cpu4'; 'isa' with its table), or null ('hex', unknown). */
export function isaOf(lang: string, table?: IsaDoc): Isa | null {
  if (lang === 'isa') return table ? tableIsa(table) : null;
  return BUILTIN_ISAS[lang] ?? null;
}
