// Program images for a ROM: RISC-V assembly or a hex word list, turned into 32-bit words with a
// per-word listing. DOM-free, so the circuit editor, the tests and the highlighter share it.

import { assemble } from '../riscv/asm';
import type { CustomRow } from '../riscv/custom';
import { disasm } from '../riscv/isa';
import { assemble16 } from '../riscv/rv16/asm16';
import { disasm16 } from '../riscv/rv16/isa16';
import { assemble4 } from '../isa4/asm4';
import { disasm4 } from '../isa4/isa4';
import { type IsaDoc, tableOf } from '../isa/table';
import { assemble as assemble6502 } from '../m6502/asm';
import { disasm as disasm6502 } from '../m6502/isa';

/** asm: RV32 assembly; rv16: the campaign's RV16 assembly (16-bit, word addressed); cpu4: the 4-bit
 *  CPU's assembly (16-bit words, word addressed); 6502: the 6502's assembly (bytes, Appendix A); hex: words. */
export type ProgramLang = 'asm' | 'hex' | 'rv16' | 'cpu4' | 'isa' | '6502';

export interface ProgramLine {
  /** Byte address of the word. */
  addr: number;
  word: number;
  /** Disassembly of the word (branch targets resolved against addr). */
  text: string;
  /** 1-based source line the word came from (for a hex gap: the `@` line that skipped it). */
  srcLine: number;
  /** 6502: the CPU address the byte answers at (the ROM repeats every 2^k bytes; absent: unknown). */
  at?: number;
  /** 6502: the first byte of an instruction (its text is the instruction, its operand bytes have none). */
  op?: boolean;
}

export interface ProgramError { line: number; message: string }

export interface BuiltProgram {
  words: number[];
  errors: ProgramError[];
  lines: ProgramLine[];
}

/** One token of a hex line. Whitespace is not a token; `,` is a separator. */
export interface HexTok {
  start: number;
  end: number;
  kind: 'word' | 'addr' | 'sep' | 'comment' | 'bad';
  /** word: its value; addr: the word index it moves to. */
  value?: number;
  error?: string;
}

/** Highest word index a `@` marker may name: 4 MiB of program is far beyond any ROM here, and the
 *  cap keeps a typo like @ffffffff from allocating gigabytes. */
export const HEX_MAX_WORDS = 1 << 20;

const parseHexDigits = (t: string): number | string => {
  const d = t.replace(/_/g, '');
  if (!/^[0-9a-f]+$/i.test(d)) return `not a hex number: "${t}"`;
  const sig = d.replace(/^0+/, '');
  if (sig.length > 8) return `"${t}" does not fit in 32 bits`;
  return parseInt(sig || '0', 16) >>> 0;
};

/** Scan one line of a hex image: words (optional 0x), `@index` markers, `,` separators and
 *  `#` / `//` comments. */
export function scanHexLine(line: string): HexTok[] {
  const out: HexTok[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#' || (ch === '/' && line[i + 1] === '/')) { out.push({ start: i, end: line.length, kind: 'comment' }); break; }
    if (ch === ',') { out.push({ start: i, end: i + 1, kind: 'sep' }); i++; continue; }
    let j = i + 1;
    while (j < line.length && !/[\s,#]/.test(line[j]) && !(line[j] === '/' && line[j + 1] === '/')) j++;
    const t = line.slice(i, j);
    if (ch === '@') {
      const v = parseHexDigits(t.slice(1));
      if (typeof v === 'string') out.push({ start: i, end: j, kind: 'bad', error: `bad address marker "${t}"` });
      else if (v >= HEX_MAX_WORDS) out.push({ start: i, end: j, kind: 'bad', error: `address ${t} is beyond ${HEX_MAX_WORDS} words` });
      else out.push({ start: i, end: j, kind: 'addr', value: v });
    } else {
      const v = /^0x/i.test(t) ? (t.length > 2 ? parseHexDigits(t.slice(2)) : `not a hex number: "${t}"`) : parseHexDigits(t);
      out.push(typeof v === 'string' ? { start: i, end: j, kind: 'bad', error: v } : { start: i, end: j, kind: 'word', value: v });
    }
    i = j;
  }
  return out;
}

function buildHex(src: string): BuiltProgram {
  const words: number[] = [];
  const from: number[] = []; // srcLine per word index
  const errors: ProgramError[] = [];
  let at = 0, marker = 0;
  src.split(/\r?\n/).forEach((raw, k) => {
    const line = k + 1;
    for (const t of scanHexLine(raw)) {
      if (t.kind === 'bad') errors.push({ line, message: t.error! });
      else if (t.kind === 'addr') { at = t.value!; marker = line; }
      else if (t.kind === 'word') {
        if (at >= HEX_MAX_WORDS) { errors.push({ line, message: `word index beyond ${HEX_MAX_WORDS}` }); continue; }
        if (from[at] !== undefined && from[at] > 0) errors.push({ line, message: `word ${at} (0x${(at * 4).toString(16)}) already set on line ${from[at]}` });
        // Gap words are zero; they point at the marker that skipped them (negated until written).
        while (words.length < at) { words.push(0); from.push(-marker); }
        words[at] = t.value!;
        from[at] = line;
        at++;
      }
    }
  });
  const lines = words.map((w, i) => ({ addr: 4 * i, word: w, text: disasm(w, 4 * i), srcLine: Math.abs(from[i]) }));
  return { words, errors, lines };
}

/** A directive line of 6502 source (labels first): its bytes are data, not instructions. */
const DATA_6502 = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)*\./;
const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

/**
 * 6502 assembly into a ROM of 2^k bytes. The CPU sees 64K addresses and a ROM decodes only its low k
 * address bits, so it answers wherever the decoder puts it, repeating every 2^k bytes: byte A of the
 * program goes to word A mod 2^k (code at $F000 and the vectors at $FFFA fit a 4K ROM). Two bytes
 * landing on one word is an error. Every word up to the last one written is listed (fill: 0, BRK).
 */
function build6502(src: string, k: number): BuiltProgram {
  const r = assemble6502(src);
  const N = 2 ** k;
  const errors: ProgramError[] = [...r.errors];
  const words: number[] = [];
  const meta: { at: number; srcLine: number; text: string; op: boolean }[] = [];
  for (const l of r.lines) {
    if (!l.bytes.length) continue;
    const data = DATA_6502.test(l.source);
    l.bytes.forEach((b, j) => {
      const at = (l.addr + j) & 0xffff, i = at % N;
      const was = meta[i];
      if (was && was.at !== at) {
        // one report per line (a long .text would give one per byte)
        if (errors[errors.length - 1]?.line !== l.line) errors.push({ line: l.line, message: `$${hex4(at)} and $${hex4(was.at)} (line ${was.srcLine}) are the same byte of a ${N}-byte ROM, which repeats every ${N} bytes` });
        return;
      }
      while (words.length < i) words.push(0);
      words[i] = b;
      const op = !data && j === 0;
      meta[i] = { at, srcLine: l.line, op, text: data ? `.byte $${b.toString(16).toUpperCase().padStart(2, '0')}` : op ? disasm6502(l.bytes, l.addr) : '' };
    });
  }
  // Where the ROM sits: every byte placed at the same offset from its word (else only placed bytes say).
  const offs = new Set(meta.flatMap((m, i) => (m ? [m.at - i] : [])));
  const base = offs.size === 1 ? [...offs][0] : null;
  const lines = words.map((w, i): ProgramLine => {
    const m = meta[i];
    const at = m?.at ?? (base !== null ? base + i : undefined);
    return { addr: 4 * i, word: w, text: m?.text ?? '', srcLine: m?.srcLine ?? 0, ...(at !== undefined ? { at } : {}), ...(m?.op ? { op: true } : {}) };
  });
  return { words, errors, lines };
}

/** Build a program image. asm / rv16 / cpu4: that ISA's assembler; hex: one 32-bit word per token; 6502: bytes for a ROM of 2^k. */
/** custom: an RV32 program's custom instructions (riscv/custom.ts). */
export function buildProgram(lang: ProgramLang, src: string, isa?: IsaDoc, k = 16, custom: readonly CustomRow[] = []): BuiltProgram {
  if (lang === 'hex') return buildHex(src);
  if (lang === '6502') return build6502(src, k);
  if (lang === 'isa') {
    // A custom instruction set (the ROM's own copy of the table): word addressed like RV16.
    if (!isa) return { words: [], errors: [{ line: 0, message: 'no instruction set: pick one in the ROM\'s Language' }], lines: [] };
    const t = tableOf(isa), r = t.assemble(src);
    return { words: r.words, errors: r.errors, lines: r.lines.map((l) => ({ addr: 4 * l.addr, word: l.word, text: t.disasm(l.word, l.addr), srcLine: l.srcLine })) };
  }
  if (lang === 'rv16') {
    // Word addressed: line addr stays 4 × the word index, like the other languages' listings.
    const r = assemble16(src);
    return { words: r.words, errors: r.errors, lines: r.lines.map((l) => ({ addr: 4 * l.addr, word: l.word, text: disasm16(l.word, l.addr), srcLine: l.srcLine })) };
  }
  if (lang === 'cpu4') {
    const r = assemble4(src);
    return { words: r.words, errors: r.errors, lines: r.lines.map((l) => ({ addr: 4 * l.addr, word: l.word, text: disasm4(l.word), srcLine: l.srcLine })) };
  }
  const r = assemble(src, custom);
  return {
    words: r.words,
    errors: r.errors,
    lines: r.lines.map((l) => ({ addr: l.addr, word: l.word, text: disasm(l.word, l.addr, custom), srcLine: l.srcLine })),
  };
}
