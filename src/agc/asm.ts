// An assembler for the AGC golden model (src/agc/iss.ts): a subset of yaYUL's language, enough for the appendix's programs
// and the oracle's tests. One statement a line: an optional label in the first column, then an operation and its operand;
// '#' starts a comment. Numbers are octal unless written with a decimal point or a D suffix (yaYUL's DEC takes decimal).
//
//   SETLOC 4000          where the next word goes (an address 0–7777; fixed-fixed 4000–7777 is banks 2 and 3)
//   BANK n               the next words go to common-fixed bank n (address 2000 in that bank)
//   label ERASE [n]      reserve n + 1 erasable words at the location (default one)
//   label EQUALS expr    (or label = expr) a symbol for an address or number
//   OCT 37777 / DEC -5   a constant word (DEC: a decimal integer, |n| ≤ 16383, in one's complement)
//   EXTEND               then an extracode: DV BZF MSU QXCH AUG DIM DCA DCS INDEX SU BZMF MP
//
// Operands: a number, a symbol, symbol ± number, or a register name (A L Q EB FB Z BB ZERO CYR SR CYL EDOP). The
// assembler checks a quartercode instruction's operand is erasable (< 2000) and a BZF / BZMF / TCF target fixed.

import { REG, BANK_WORDS, FIXED_BANKS } from './iss';
import { W15, word15 } from './word';

export interface AgcProgram {
  /** Fixed memory, 044 banks of 02000 words (15 bits). */
  fixed: Uint16Array;
  /** Erasable initial values the program sets with constants placed in erasable (rare; the oracle starts erasable at 0). */
  symbols: Map<string, number>;
  /** Per source line (1-based) the fixed-memory address it assembled to, when it holds a word. */
  lineOf: Map<number, number>;
  /** Words assembled, as (bank, address) for listings. */
  listing: { line: number; bank: number; addr: number; word: number; text: string }[];
}

export class AgcAsmError extends Error {
  constructor(public line: number, msg: string) { super(`line ${line}: ${msg}`); }
}

const BASIC: Record<string, { base: number; kind: 'k12' | 'k10' | 'dp10' | 'fixed' | 'none' }> = {
  TC: { base: 0o00000, kind: 'k12' }, TCR: { base: 0o00000, kind: 'k12' },
  CCS: { base: 0o10000, kind: 'k10' }, TCF: { base: 0o10000, kind: 'fixed' },
  DAS: { base: 0o20000, kind: 'dp10' }, LXCH: { base: 0o22000, kind: 'k10' }, INCR: { base: 0o24000, kind: 'k10' }, ADS: { base: 0o26000, kind: 'k10' },
  CA: { base: 0o30000, kind: 'k12' }, CAE: { base: 0o30000, kind: 'k12' }, CAF: { base: 0o30000, kind: 'k12' },
  CS: { base: 0o40000, kind: 'k12' },
  INDEX: { base: 0o50000, kind: 'k10' }, NDX: { base: 0o50000, kind: 'k10' }, DXCH: { base: 0o52000, kind: 'dp10' }, TS: { base: 0o54000, kind: 'k10' }, XCH: { base: 0o56000, kind: 'k10' },
  AD: { base: 0o60000, kind: 'k12' }, MASK: { base: 0o70000, kind: 'k12' }, MSK: { base: 0o70000, kind: 'k12' },
};
const NO_OPERAND: Record<string, number> = {
  RELINT: 0o00003, INHINT: 0o00004, EXTEND: 0o00006, RETURN: 0o00002, NOOP: 0o30000, COM: 0o40000, DOUBLE: 0o60000,
  DDOUBL: 0o20001, ZL: 0o22007, XLQ: 0o00001, XXALQ: 0o00000,
};
const EXTRA: Record<string, { base: number; kind: 'k12' | 'k10' | 'dp12' | 'fixed' }> = {
  DV: { base: 0o10000, kind: 'k10' }, BZF: { base: 0o10000, kind: 'fixed' },
  MSU: { base: 0o20000, kind: 'k10' }, QXCH: { base: 0o22000, kind: 'k10' }, AUG: { base: 0o24000, kind: 'k10' }, DIM: { base: 0o26000, kind: 'k10' },
  DCA: { base: 0o30000, kind: 'dp12' }, DCS: { base: 0o40000, kind: 'dp12' }, INDEX: { base: 0o50000, kind: 'k12' }, NDX: { base: 0o50000, kind: 'k12' },
  SU: { base: 0o60000, kind: 'k10' }, BZMF: { base: 0o60000, kind: 'fixed' }, MP: { base: 0o70000, kind: 'k12' },
};
const EXTRA_NO_OPERAND: Record<string, number> = { ZQ: 0o22007, DCOM: 0o40001, SQUARE: 0o70000 };

interface Stmt { line: number; label?: string; op: string; arg: string; text: string }

function parse(src: string): Stmt[] {
  const out: Stmt[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.replace(/#.*/, '').replace(/\s+$/, '');
    if (!text.trim()) return;
    const label = /^\S/.test(text) ? text.split(/\s+/)[0] : undefined;
    const rest = (label ? text.slice(label.length) : text).trim().split(/\s+/);
    let op = (rest[0] ?? '').toUpperCase(), arg = rest.slice(1).join(' ');
    if (label && op === '=') { op = 'EQUALS'; }
    if (!op) throw new AgcAsmError(i + 1, `a label alone: ${label}`);
    out.push({ line: i + 1, label, op, arg, text: raw.trim() });
  });
  return out;
}

/** Assemble a program; throws AgcAsmError with the line. */
export function assembleAgc(src: string): AgcProgram {
  const stmts = parse(src);
  const syms = new Map<string, number>(Object.entries(REG).map(([k, v]) => [k, v]));
  const num = (s: string, line: number): number => {
    const t = s.trim();
    if (/^[+-]?\d+(\.\d*)?D?$/i.test(t) && (/[.D]$/i.test(t) || /\.\d/.test(t))) return parseInt(t, 10);
    if (/^[+-]?[0-7]+$/.test(t)) return parseInt(t, 8);
    throw new AgcAsmError(line, `not a number: ${s}`);
  };
  const expr = (s: string, line: number, pass2: boolean): number => {
    const m = /^\s*([A-Za-z_][\w]*|[+-]?[0-9.]+D?)\s*(?:([+-])\s*([0-7]+|\d+D))?\s*$/i.exec(s);
    if (!m) throw new AgcAsmError(line, `bad operand: ${s}`);
    let v: number;
    if (/^[A-Za-z_]/.test(m[1])) {
      const name = m[1].toUpperCase();
      if (!syms.has(name)) { if (pass2) throw new AgcAsmError(line, `undefined symbol: ${m[1]}`); v = 0; } else v = syms.get(name)!;
    } else v = num(m[1], line);
    if (m[2]) v += (m[2] === '-' ? -1 : 1) * num(m[3], line);
    return v;
  };

  // pass 1: locations and symbols; pass 2: words
  const fixed = new Uint16Array(FIXED_BANKS * BANK_WORDS);
  const listing: AgcProgram['listing'] = [];
  const lineOf = new Map<number, number>();
  for (const pass2 of [false, true]) {
    let loc = 0o4000, bank = 2, ext = false;
    const place = (s: Stmt, w: number) => {
      if (pass2) {
        if (loc < 0o2000) throw new AgcAsmError(s.line, `code in erasable memory (location ${loc.toString(8)})`);
        if (loc > 0o7777) throw new AgcAsmError(s.line, 'past the end of fixed-fixed memory (7777): put more in a bank of its own');
        const b = loc >= 0o4000 ? (loc < 0o6000 ? 2 : 3) : bank;
        fixed[b * BANK_WORDS + (loc & 0o1777)] = w & W15;
        listing.push({ line: s.line, bank: b, addr: loc, word: w & W15, text: s.text });
        lineOf.set(s.line, loc);
      }
      loc++;
    };
    for (const s of stmts) {
      if (s.label && s.op !== 'EQUALS' && !pass2) {
        const name = s.label.toUpperCase();
        if (syms.has(name) && !(name in REG)) throw new AgcAsmError(s.line, `symbol defined twice: ${s.label}`);
        syms.set(name, loc);
      }
      const op = s.op;
      if (op === 'SETLOC') { loc = expr(s.arg, s.line, pass2) & 0o7777; if (loc >= 0o2000 && loc < 0o4000) bank = 2; ext = false; continue; }
      if (op === 'BANK') { bank = expr(s.arg, s.line, pass2); if (bank < 0 || bank >= FIXED_BANKS) throw new AgcAsmError(s.line, `no bank ${s.arg}`); loc = 0o2000; continue; }
      if (op === 'EQUALS') { if (!pass2) syms.set(s.label!.toUpperCase(), expr(s.arg, s.line, false)); continue; }
      if (op === 'ERASE') { loc += 1 + (s.arg ? expr(s.arg, s.line, pass2) : 0); continue; }
      if (op === 'OCT') { place(s, num(s.arg, s.line)); continue; }
      if (op === 'DEC') {
        const v = parseInt(s.arg, 10);
        if (!Number.isFinite(v) || Math.abs(v) > 16383) throw new AgcAsmError(s.line, `DEC takes an integer up to ±16383: ${s.arg}`);
        place(s, word15(v)); continue;
      }
      const arg = (kind: string): number => {
        const k = expr(s.arg, s.line, pass2) & 0o7777;
        if (pass2 && (kind === 'k10' || kind === 'dp10') && k >= 0o2000) throw new AgcAsmError(s.line, `${op} takes an erasable address (below 2000): ${s.arg}`);
        if (pass2 && kind === 'fixed' && k < 0o2000) throw new AgcAsmError(s.line, `${op} takes a fixed-memory address (2000 or above): ${s.arg}`);
        return kind === 'dp10' || kind === 'dp12' ? k + 1 : k;
      };
      if (ext) {
        ext = false;
        if (op in EXTRA_NO_OPERAND) { place(s, EXTRA_NO_OPERAND[op]); continue; }
        const e = EXTRA[op];
        if (!e) throw new AgcAsmError(s.line, `${op} after EXTEND: not an extracode`);
        place(s, e.base + arg(e.kind));
        if (op === 'INDEX' || op === 'NDX') ext = true; // an indexed extracode is still one
        continue;
      }
      if (op in NO_OPERAND) { place(s, NO_OPERAND[op]); if (op === 'EXTEND') ext = true; continue; }
      const b = BASIC[op];
      if (!b) throw new AgcAsmError(s.line, op in EXTRA || op in EXTRA_NO_OPERAND ? `${op} is an extracode: put EXTEND before it` : `unknown operation: ${op}`);
      place(s, b.base + arg(b.kind));
    }
  }
  const symbols = new Map([...syms].filter(([k]) => !(k in REG)));
  return { fixed, symbols, lineOf, listing };
}

/** The rope as yaAGC reads it (agc_load_binfile): banks 2, 3, 0, 1, 4 … 043, each word big-endian, value << 1, parity bit 0. */
export function ropeBin(fixed: Uint16Array, banks = FIXED_BANKS): Uint8Array {
  const order = [2, 3, 0, 1, ...Array.from({ length: banks - 4 }, (_, i) => i + 4)];
  const out = new Uint8Array(banks * BANK_WORDS * 2);
  let o = 0;
  for (const b of order) for (let j = 0; j < BANK_WORDS; j++) {
    const v = (fixed[b * BANK_WORDS + j] & W15) << 1;
    out[o++] = v >> 8; out[o++] = v & 0xff;
  }
  return out;
}
