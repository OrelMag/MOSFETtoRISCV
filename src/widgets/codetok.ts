// Per-line tokenizers for the code editor (DOM-free, so tests can import them). The tokens of a
// line always concatenate back to the line: the highlight layer must match the textarea glyph
// for glyph. Comment splitting, mnemonics and register names come from the assembler and ISA
// tables themselves, so the colours cannot disagree with what assembles.

import { commentStart, DIRECTIVES, PSEUDO_OPS } from '../riscv/asm';
import { BY_NAME, CSRS, fregNumber, regNumber, RM_OPERANDS } from '../riscv/isa';
import { scanHexLine } from '../editor/program';

export type CodeLang = 'rvasm' | 'hex';

/** Token classes (CSS: .tk-<cls>); '' is plain text / whitespace.
 *  com comment · lbl label · op instruction · ps pseudo-instruction · dir directive · reg register
 *  num number · csr CSR name · kw rounding mode · sym symbol (label use) · pun punctuation
 *  addr hex @marker · bad unknown or malformed */
export type TokClass = '' | 'com' | 'lbl' | 'op' | 'ps' | 'dir' | 'reg' | 'num' | 'csr' | 'kw' | 'sym' | 'pun' | 'addr' | 'bad';

export interface Tok { text: string; cls: TokClass }

const PSEUDO = new Set(PSEUDO_OPS);
const DIRS = new Set(DIRECTIVES);
const RMS = new Set(RM_OPERANDS.filter(Boolean));

// Same number syntax as the assembler's parseImm (sign, 0x, 0b, decimal, underscores).
const NUM = /^-?(?:0x[0-9a-f_]+|0b[01_]+|\d[\d_]*)(?![\w.$])/i;
const WORD = /^[A-Za-z_.$][\w.$]*/;
const LABEL = /^([A-Za-z_.$][\w.$]*)(\s*)(:)/;

function mnemonic(w: string): TokClass {
  const t = w.toLowerCase();
  if (t.startsWith('.')) return DIRS.has(t) ? 'dir' : 'bad';
  return BY_NAME.has(t) ? 'op' : PSEUDO.has(t) ? 'ps' : 'bad';
}

function operand(w: string): TokClass {
  const t = w.toLowerCase();
  if (regNumber(t) !== null || fregNumber(t) !== null) return 'reg';
  if (t in CSRS) return 'csr';
  if (RMS.has(t)) return 'kw';
  return 'sym';
}

function rvasm(line: string): Tok[] {
  const out: Tok[] = [];
  const push = (text: string, cls: TokClass) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };
  const cut = commentStart(line);
  const code = line.slice(0, cut);
  let i = 0;
  let expectOp = true; // before the mnemonic, words may be labels
  while (i < code.length) {
    const rest = code.slice(i);
    const ws = rest.match(/^\s+/);
    if (ws) { push(ws[0], ''); i += ws[0].length; continue; }
    let m: RegExpMatchArray | null;
    if (expectOp && (m = rest.match(LABEL))) {
      push(m[1], 'lbl'); push(m[2], ''); push(m[3], 'lbl');
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(NUM) ?? rest.match(/^-?\d[\w.$]*/))) {
      push(m[0], NUM.test(m[0]) ? 'num' : 'bad'); // 0x1g, 12ab: one malformed number
      i += m[0].length;
      expectOp = false;
      continue;
    }
    if ((m = rest.match(WORD))) {
      push(m[0], expectOp ? mnemonic(m[0]) : operand(m[0]));
      i += m[0].length;
      expectOp = false;
      continue;
    }
    if (rest[0] === "'") {
      // A character literal is exactly 'c' for the assembler; anything else is an error.
      const lit = /^'.'/.test(rest) ? rest.slice(0, 3) : rest.slice(0, rest.indexOf("'", 1) + 1 || rest.length);
      push(lit, lit.length === 3 && lit.endsWith("'") ? 'num' : 'bad');
      i += lit.length;
      expectOp = false;
      continue;
    }
    push(rest[0], /[,()+\-:]/.test(rest[0]) ? 'pun' : 'bad');
    i++;
  }
  push(line.slice(cut), 'com');
  return out;
}

const HEX_CLS = { word: 'num', addr: 'addr', sep: 'pun', comment: 'com', bad: 'bad' } as const;

function hex(line: string): Tok[] {
  const out: Tok[] = [];
  let at = 0;
  for (const t of scanHexLine(line)) {
    if (t.start > at) out.push({ text: line.slice(at, t.start), cls: '' });
    out.push({ text: line.slice(t.start, t.end), cls: HEX_CLS[t.kind] });
    at = t.end;
  }
  if (at < line.length) out.push({ text: line.slice(at), cls: '' });
  return out;
}

/** Split one line into classified tokens; their texts concatenate to `line`. */
export function tokenize(line: string, lang: CodeLang): Tok[] {
  return lang === 'hex' ? hex(line) : rvasm(line);
}
