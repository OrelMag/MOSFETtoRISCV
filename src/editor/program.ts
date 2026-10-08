// Program images for a ROM: RISC-V assembly or a hex word list, turned into 32-bit words with a
// per-word listing. DOM-free, so the circuit editor, the tests and the highlighter share it.

import { assemble } from '../riscv/asm';
import { disasm } from '../riscv/isa';
import { assemble16 } from '../riscv/rv16/asm16';
import { disasm16 } from '../riscv/rv16/isa16';

/** asm: RV32 assembly; rv16: the campaign's RV16 assembly (16-bit, word addressed); hex: words. */
export type ProgramLang = 'asm' | 'hex' | 'rv16';

export interface ProgramLine {
  /** Byte address of the word. */
  addr: number;
  word: number;
  /** Disassembly of the word (branch targets resolved against addr). */
  text: string;
  /** 1-based source line the word came from (for a hex gap: the `@` line that skipped it). */
  srcLine: number;
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

/** Build a program image. asm: the two-pass assembler; hex: one 32-bit word per token. */
export function buildProgram(lang: ProgramLang, src: string): BuiltProgram {
  if (lang === 'hex') return buildHex(src);
  if (lang === 'rv16') {
    // Word addressed: line addr stays 4 × the word index, like the other languages' listings.
    const r = assemble16(src);
    return { words: r.words, errors: r.errors, lines: r.lines.map((l) => ({ addr: 4 * l.addr, word: l.word, text: disasm16(l.word, l.addr), srcLine: l.srcLine })) };
  }
  const r = assemble(src);
  return {
    words: r.words,
    errors: r.errors,
    lines: r.lines.map((l) => ({ addr: l.addr, word: l.word, text: disasm(l.word, l.addr), srcLine: l.srcLine })),
  };
}
