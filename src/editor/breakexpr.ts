// A breakpoint's condition (DOM-free): `pc == 0x40`, `stall`, `count >= 12 && en`, `rose(miss)`, `ir[6:0] == 0b1100011`.
// A small expression language over the circuit's named signals, evaluated exactly at any width (BigInt) with unknown bits
// tracked bit by bit: a comparison that reads an unknown bit is unknown, and an unknown condition does not stop the run.
//
//   ||  &&            logic (a known false side decides: `0 && x` is false)
//   |  ^  &           bitwise
//   == != < <= > >=   unsigned comparisons
//   !  ~              not (logic, bitwise)
//   x[3]  x[7:4]      bit selects
//   rose(x) fell(x) changed(x)   against the value at the previous check (false at the first)
//   numbers: 12, 0x4_0, 0b1011, 0o17
//
// Names are what the sandbox resolves (a pin, a pointer, part.port, a path into placed chips); this file only reads them
// through a callback.

import type { Bit } from '../sim/types';

export type BreakNode =
  | { k: 'num'; v: bigint; w: number }
  | { k: 'name'; name: string }
  | { k: 'not' | 'inv'; a: BreakNode }
  | { k: 'bin'; op: BinOp; a: BreakNode; b: BreakNode }
  | { k: 'sel'; a: BreakNode; hi: number; lo: number }
  | { k: 'edge'; fn: EdgeFn; a: BreakNode; id: number };

type BinOp = '||' | '&&' | '|' | '^' | '&' | '==' | '!=' | '<' | '<=' | '>' | '>=';
export type EdgeFn = 'rose' | 'fell' | 'changed';

export interface BreakExpr {
  root: BreakNode;
  /** Every name it reads, in order of first use. */
  names: string[];
  /** How many rose / fell / changed calls (each keeps its previous value). */
  edges: number;
}

/** A value: `xm` marks the unknown bits (X or Z), `v` is the known bits (0 where unknown). */
export interface BreakVal { v: bigint; xm: bigint; w: number }

const LEVELS: BinOp[][] = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>=']];
const TOKEN = /\s*(?:(0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*)|([A-Za-z_][\w$]*(?:\.[A-Za-z_$\d][\w$]*)*)|(\|\||&&|==|!=|<=|>=|[<>|^&!~()[\]:]))/iy;

/** Parse a condition; the error names what was expected and where (a character offset). */
export function parseBreak(src: string): BreakExpr | { error: string; at: number } {
  type Tok = { t: 'num' | 'name' | 'op'; s: string; at: number };
  const toks: Tok[] = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < src.length) {
    if (!src.slice(i).trim()) break;
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) return { error: `unexpected “${src.slice(i).trim()[0]}”`, at: i + (src.slice(i).length - src.slice(i).trimStart().length) };
    const at = m.index + m[0].length - (m[1] ?? m[2] ?? m[3]).length;
    toks.push({ t: m[1] ? 'num' : m[2] ? 'name' : 'op', s: m[1] ?? m[2] ?? m[3], at });
    i = TOKEN.lastIndex;
  }
  if (!toks.length) return { error: 'a condition, e.g. pc == 0x40', at: 0 };
  let p = 0, edges = 0;
  const names: string[] = [];
  const peek = () => toks[p];
  const fail = (what: string): never => { throw { error: what, at: peek()?.at ?? src.length }; };
  const expect = (s: string) => { if (peek()?.s !== s) fail(`“${s}” expected`); p++; };
  const int = (): number => {
    const t = peek();
    if (t?.t !== 'num') fail('a bit number');
    p++;
    return Number(numOf(t.s));
  };
  const binary = (lv: number): BreakNode => {
    if (lv === LEVELS.length) return unary();
    let a = binary(lv + 1);
    while (peek()?.t === 'op' && (LEVELS[lv] as string[]).includes(peek().s)) {
      const op = toks[p++].s as BinOp;
      a = { k: 'bin', op, a, b: binary(lv + 1) };
      // comparisons do not chain (`a < b < c` reads wrong in every language that allows it)
      if (lv >= 5 && peek()?.t === 'op' && (LEVELS[lv] as string[]).includes(peek().s)) fail('parentheses around one comparison');
    }
    return a;
  };
  const unary = (): BreakNode => {
    const t = peek();
    if (t?.s === '!' || t?.s === '~') { p++; return { k: t.s === '!' ? 'not' : 'inv', a: unary() }; }
    let a = primary();
    while (peek()?.s === '[') {
      p++;
      const hi = int();
      let lo = hi;
      if (peek()?.s === ':') { p++; lo = int(); }
      expect(']');
      if (lo > hi) fail('the high bit first, x[7:4]');
      a = { k: 'sel', a, hi, lo };
    }
    return a;
  };
  const primary = (): BreakNode => {
    const t = peek();
    if (!t) fail('a signal or a number');
    if (t.t === 'num') {
      p++;
      const v = numOf(t.s);
      return { k: 'num', v, w: Math.max(1, v.toString(2).length) };
    }
    if (t.s === '(') { p++; const a = binary(0); expect(')'); return a; }
    if (t.t === 'name') {
      p++;
      if ((t.s === 'rose' || t.s === 'fell' || t.s === 'changed') && peek()?.s === '(') {
        p++;
        const a = binary(0);
        expect(')');
        return { k: 'edge', fn: t.s, a, id: edges++ };
      }
      if (!names.includes(t.s)) names.push(t.s);
      return { k: 'name', name: t.s };
    }
    return fail('a signal or a number');
  };
  try {
    const root = binary(0);
    if (p < toks.length) fail(`an operator before “${peek().s}”`);
    return { root, names, edges };
  } catch (e) {
    if (e && typeof e === 'object' && 'error' in e) return e as { error: string; at: number };
    throw e;
  }
}

const numOf = (s: string): bigint => {
  const t = s.replace(/_/g, '').toLowerCase();
  return t.startsWith('0o') ? BigInt(`0o${t.slice(2)}`) : BigInt(t);
};

const ones = (w: number) => (1n << BigInt(w)) - 1n;
const bool = (b: boolean | null): BreakVal => (b === null ? { v: 0n, xm: 1n, w: 1 } : { v: b ? 1n : 0n, xm: 0n, w: 1 });
/** Known true, known false, or null (unknown). */
const truth = (a: BreakVal): boolean | null => ((a.v & ~a.xm) !== 0n ? true : a.xm === 0n ? false : null);

/** Bits (LSB first) as a value. */
export function valOf(bits: ArrayLike<Bit>): BreakVal {
  let v = 0n, xm = 0n;
  for (let i = bits.length - 1; i >= 0; i--) {
    v <<= 1n; xm <<= 1n;
    if (bits[i] === 1) v |= 1n;
    else if (bits[i] !== 0) xm |= 1n;
  }
  return { v, xm, w: Math.max(1, bits.length) };
}

/** What each rose / fell / changed call saw last time (one per call, by its id). */
export type BreakMemory = (BreakVal | undefined)[];

/**
 * Evaluate: `read` gives a name's bits (null: not found, read as unknown). `mem` holds the edge calls' previous values and is
 * updated, so call this once per check.
 */
export function evalBreak(e: BreakExpr, read: (name: string) => ArrayLike<Bit> | null, mem: BreakMemory): { hit: boolean; unknown: boolean } {
  const ev = (n: BreakNode): BreakVal => {
    switch (n.k) {
      case 'num': return { v: n.v, xm: 0n, w: n.w };
      case 'name': { const b = read(n.name); return b ? valOf(b) : { v: 0n, xm: 1n, w: 1 }; }
      case 'not': { const t = truth(ev(n.a)); return bool(t === null ? null : !t); }
      case 'inv': { const a = ev(n.a), m = ones(a.w); return { v: ~a.v & m & ~a.xm, xm: a.xm, w: a.w }; }
      case 'sel': {
        const a = ev(n.a), m = ones(n.hi - n.lo + 1), s = BigInt(n.lo);
        // a bit past the signal's width reads as unknown
        const xm = ((a.xm >> s) | (~ones(a.w) >> s)) & m;
        return { v: (a.v >> s) & m & ~xm, xm, w: n.hi - n.lo + 1 };
      }
      case 'edge': {
        const a = ev(n.a), prev = mem[n.id];
        mem[n.id] = a;
        if (!prev) return bool(false);
        if (prev.xm || a.xm) return bool(null);
        return bool(n.fn === 'rose' ? prev.v === 0n && a.v !== 0n : n.fn === 'fell' ? prev.v !== 0n && a.v === 0n : prev.v !== a.v);
      }
      case 'bin': {
        if (n.op === '&&' || n.op === '||') {
          // both sides are evaluated: an edge call on the right keeps its memory up to date
          const a = truth(ev(n.a)), b = truth(ev(n.b));
          if (n.op === '&&') return bool(a === false || b === false ? false : a && b ? true : null);
          return bool(a === true || b === true ? true : a === false && b === false ? false : null);
        }
        const a = ev(n.a), b = ev(n.b), w = Math.max(a.w, b.w);
        if (n.op === '&') {
          const z = (~a.v & ~a.xm) | (~b.v & ~b.xm), xm = (a.xm | b.xm) & ~z & ones(w);
          return { v: a.v & b.v & ~xm, xm, w };
        }
        if (n.op === '|') {
          const o = (a.v & ~a.xm) | (b.v & ~b.xm), xm = (a.xm | b.xm) & ~o;
          return { v: o, xm, w };
        }
        if (n.op === '^') { const xm = a.xm | b.xm; return { v: (a.v ^ b.v) & ~xm, xm, w }; }
        if (a.xm || b.xm) return bool(null);
        const r = { '==': a.v === b.v, '!=': a.v !== b.v, '<': a.v < b.v, '<=': a.v <= b.v, '>': a.v > b.v, '>=': a.v >= b.v }[n.op];
        return bool(r);
      }
    }
  };
  const t = truth(ev(e.root));
  return { hit: t === true, unknown: t === null };
}
