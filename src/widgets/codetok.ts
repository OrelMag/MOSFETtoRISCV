// Per-line tokenizers for the code editor (DOM-free, so tests can import them). The tokens of a
// line always concatenate back to the line: the highlight layer must match the textarea glyph
// for glyph. Comment splitting, mnemonics and register names come from the assembler and ISA
// tables themselves, so the colours cannot disagree with what assembles.

import { commentStart, DIRECTIVES, PSEUDO_OPS } from '../riscv/asm';
import { BY_NAME, CSRS, fregNumber, regNumber, RM_OPERANDS } from '../riscv/isa';
import { scanHexLine } from '../editor/program';
import { DIRECTIVES16, PSEUDO16 } from '../riscv/rv16/asm16';
import { BY_NAME16, CSRS16, reg16 } from '../riscv/rv16/isa16';
import { DIRECTIVES4 } from '../isa4/asm4';
import { BY_NAME4, JCN_NAMES, pair4, reg4 } from '../isa4/isa4';
import { type IsaDoc, tableOf } from '../isa/table';
import { MNEMONICS as M65 } from '../m6502/isa';

/** rvasm: RV32 assembly; rv16asm: the campaign's RV16; cpu4asm: the 4-bit CPU's; m6502asm: the 6502's (Appendix A); hex: words. */
export type CodeLang = 'rvasm' | 'rv16asm' | 'cpu4asm' | 'm6502asm' | 'hex' | { table: IsaDoc };

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

/** How an ISA's assembly classifies words. */
interface AsmWords { mnemonic(w: string): TokClass; operand(w: string): TokClass }

const RV32: AsmWords = {
  mnemonic(w) {
    const t = w.toLowerCase();
    if (t.startsWith('.')) return DIRS.has(t) ? 'dir' : 'bad';
    return BY_NAME.has(t) ? 'op' : PSEUDO.has(t) ? 'ps' : 'bad';
  },
  operand(w) {
    const t = w.toLowerCase();
    if (regNumber(t) !== null || fregNumber(t) !== null) return 'reg';
    if (t in CSRS) return 'csr';
    if (RMS.has(t)) return 'kw';
    return 'sym';
  },
};

const PSEUDO_16 = new Set(PSEUDO16), DIRS_16 = new Set(DIRECTIVES16), CSRS_16 = new Set(CSRS16);
const RV16: AsmWords = {
  mnemonic(w) {
    const t = w.toLowerCase();
    if (t.startsWith('.')) return DIRS_16.has(t) ? 'dir' : 'bad';
    return BY_NAME16.has(t) ? 'op' : PSEUDO_16.has(t) ? 'ps' : 'bad';
  },
  operand(w) {
    const t = w.toLowerCase();
    if (reg16(t) !== null) return 'reg';
    if (CSRS_16.has(t)) return 'csr';
    return 'sym';
  },
};

// The 4-bit CPU: Intel's upper-case mnemonics in any case, R0–R15 / P0–P7, JCN conditions as keywords.
const DIRS_4 = new Set(DIRECTIVES4), CONDS_4 = new Set(Object.keys(JCN_NAMES));
const CPU4: AsmWords = {
  mnemonic(w) {
    if (w.startsWith('.')) return DIRS_4.has(w.toLowerCase()) ? 'dir' : 'bad';
    return BY_NAME4.has(w.toUpperCase()) ? 'op' : 'bad';
  },
  operand(w) {
    if (reg4(w) !== null || pair4(w) !== null) return 'reg';
    if (CONDS_4.has(w.toLowerCase())) return 'kw';
    return 'sym';
  },
};

// A Custom ISA table: its mnemonics, register names and list names, in any case.
const TABLE_DIRS = new Set(['.word', '.org']);
const tableCache = new WeakMap<IsaDoc, AsmWords>();
function tableWords(doc: IsaDoc): AsmWords {
  let w = tableCache.get(doc);
  if (w) return w;
  const t = tableOf(doc).words();
  const ops = new Set(t.mnemonics.map((m) => m.toLowerCase())), regs = new Set(t.registers.map((r) => r.toLowerCase())), kws = new Set(t.keywords.map((k) => k.toLowerCase()));
  w = {
    mnemonic: (s) => (s.startsWith('.') ? (TABLE_DIRS.has(s.toLowerCase()) ? 'dir' : 'bad') : ops.has(s.toLowerCase()) ? 'op' : 'bad'),
    operand: (s) => (regs.has(s.toLowerCase()) ? 'reg' : kws.has(s.toLowerCase()) ? 'kw' : 'sym'),
  };
  tableCache.set(doc, w);
  return w;
}

function rvasm(line: string, isa: AsmWords): Tok[] {
  const { mnemonic, operand } = isa;
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

// The 6502's assembly (m6502/asm.ts): ';' comments, $hex %binary decimal 'c' numbers, #, A X Y.
const OPS_65 = new Set(M65.map((m) => m.toLowerCase()));
const DIRS_65 = new Set(['.org', '.byte', '.word', '.text', '.fill']);
function m6502asm(line: string): Tok[] {
  const out: Tok[] = [];
  const push = (text: string, cls: TokClass) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };
  let i = 0, expectOp = true;
  while (i < line.length) {
    const rest = line.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) { push(m[0], ''); i += m[0].length; continue; }
    // strings and characters first: a ';' inside them is not a comment
    if ((m = rest.match(/^"(?:[^"\\]|\\.)*"?/)) || (m = rest.match(/^'(?:[^'\\]|\\.)'/))) { push(m[0], 'num'); i += m[0].length; expectOp = false; continue; }
    if (rest[0] === ';') { push(rest, 'com'); break; }
    if (expectOp && (m = rest.match(/^([A-Za-z_]\w*)(\s*)(:)/))) { push(m[1], 'lbl'); push(m[2], ''); push(m[3], 'lbl'); i += m[0].length; continue; }
    if (expectOp && rest.startsWith('*=')) { push('*=', 'dir'); i += 2; expectOp = false; continue; }
    if ((m = rest.match(/^(?:\$[0-9a-f]+|%[01]+|\d+)(?!\w)/i))) { push(m[0], 'num'); i += m[0].length; expectOp = false; continue; }
    if ((m = rest.match(/^\.?[A-Za-z_]\w*/))) {
      const w = m[0], t = w.toLowerCase();
      // the first word is a mnemonic or directive (or a constant's name, before its '=')
      push(w, expectOp ? (t.startsWith('.') ? (DIRS_65.has(t) ? 'dir' : 'bad') : OPS_65.has(t) ? 'op' : 'sym') : /^[axy]$/.test(t) ? 'reg' : 'sym');
      i += w.length;
      expectOp = false;
      continue;
    }
    push(rest[0], /[,()#+\-*/<>=]/.test(rest[0]) ? 'pun' : 'bad');
    i++;
  }
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
  if (typeof lang === 'object') return rvasm(line, tableWords(lang.table));
  if (lang === 'm6502asm') return m6502asm(line);
  return lang === 'hex' ? hex(line) : rvasm(line, lang === 'rv16asm' ? RV16 : lang === 'cpu4asm' ? CPU4 : RV32);
}
