// The Baby's assembler: one store line per statement, from line 0 unless a statement starts with a line number
// (`20:`), labels (`loop:`), operands as numbers or labels. Mnemonics are the replica's (JMP JRP LDN STO SUB CMP STP;
// STOP for STP), `NUM v` a number (decimal, 0x, 0b, negative). Comments: ; # //. Errors are collected per source line.

import { commentStart, parseImm } from '../riscv/asm';
import { encode, LINES, MNEMONIC, usesLine } from './isa';

export interface SsemAsmLine { line: number; word: number; text: string; srcLine: number }
export interface SsemAsmResult { words: number[]; lines: SsemAsmLine[]; labels: Map<string, number>; errors: { line: number; message: string }[] }

interface Stmt { srcLine: number; op: string; arg?: string; text: string; line: number }

const FNS = new Map<string, number>(MNEMONIC.map((m, f) => [m, f] as [string, number]).filter(([, f]) => f !== 5));
FNS.set('STOP', 7);
FNS.set('HLT', 7);

export function assembleSsem(src: string): SsemAsmResult {
  const stmts: Stmt[] = [];
  const labels = new Map<string, number>();
  const errors: { line: number; message: string }[] = [];
  let at = 0;
  src.split(/\r?\n/).forEach((raw, i) => {
    let ln = raw.slice(0, commentStart(raw)).trim();
    for (;;) {
      const m = ln.match(/^([A-Za-z_]\w*|\d+)\s*:/);
      if (!m) break;
      if (/^\d+$/.test(m[1])) {
        const n = parseInt(m[1], 10);
        if (n >= LINES) errors.push({ line: i + 1, message: `line ${n} is past the store (0–${LINES - 1})` });
        at = n;
      } else {
        if (labels.has(m[1])) errors.push({ line: i + 1, message: `label "${m[1]}" defined twice` });
        labels.set(m[1], at);
      }
      ln = ln.slice(m[0].length).trim();
    }
    if (!ln) return;
    const parts = ln.split(/\s+/);
    if (parts.length > 2) { errors.push({ line: i + 1, message: `too many operands: "${ln}"` }); return; }
    stmts.push({ srcLine: i + 1, op: parts[0].toUpperCase(), arg: parts[1], text: ln, line: at++ });
  });

  const value = (s: Stmt, lo: number, hi: number): number => {
    const a = s.arg!;
    let v: number;
    if (labels.has(a)) v = labels.get(a)!;
    else { try { v = parseImm(a); } catch { throw new Error(`not a number or label: "${a}"`); } }
    if (v < lo || v > hi) throw new Error(`${v} does not fit (${lo} to ${hi})`);
    return v;
  };

  const words = new Array<number>(LINES).fill(0);
  const used = new Set<number>();
  const lines: SsemAsmLine[] = [];
  for (const s of stmts) {
    if (s.line >= LINES) { errors.push({ line: s.srcLine, message: `the store has ${LINES} lines` }); continue; }
    if (used.has(s.line)) errors.push({ line: s.srcLine, message: `line ${s.line} is written twice` });
    used.add(s.line);
    let word = 0;
    try {
      if (s.op === 'NUM' || s.op === '.NUM') {
        if (s.arg === undefined) throw new Error('NUM needs a value');
        word = value(s, -(2 ** 31), 2 ** 32 - 1) | 0;
      } else {
        const f = FNS.get(s.op);
        if (f === undefined) throw new Error(`unknown instruction "${s.op}"`);
        if (usesLine(f) && s.arg === undefined) throw new Error(`${s.op} needs a line number`);
        if (!usesLine(f) && s.arg !== undefined) throw new Error(`${s.op} takes no line number`);
        word = encode(f, usesLine(f) ? value(s, 0, LINES - 1) : 0);
      }
    } catch (e) {
      errors.push({ line: s.srcLine, message: (e as Error).message });
    }
    words[s.line] = word;
    lines.push({ line: s.line, word, text: s.text, srcLine: s.srcLine });
  }
  return { words, lines, labels, errors };
}

/** Assemble or throw the first error (samples, tests). */
export function ssemWords(src: string): number[] {
  const r = assembleSsem(src);
  if (r.errors.length) throw new Error(`line ${r.errors[0].line}: ${r.errors[0].message}`);
  return r.words;
}
