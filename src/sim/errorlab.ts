// Chapter float's error lab (DOM-free): an expression evaluated twice, in float32 (src/sim/fpref.ts, round to nearest even,
// operation by operation) and exactly (BigInt rationals; sqrt to 2^-160), so that every error figure on screen is computed.
// A decimal literal is the real number it spells; the float evaluation rounds it to float32 first, like a compiler does.

import { F32, fpAddX, fpDivX, fpMulX, fpSqrtX, parts, roundTo } from './fpref';

/** An exact rational n / d, d > 0, in lowest terms. */
export interface Q { n: bigint; d: bigint }

const babs = (x: bigint) => (x < 0n ? -x : x);
const gcd = (a: bigint, b: bigint): bigint => { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a; };
const bl = (x: bigint) => (x === 0n ? 0 : x.toString(2).length);
export const q = (n: bigint, d: bigint = 1n): Q => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return { n: n / g, d: d / g }; };
export const qAdd = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const qSub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const qMul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
export const qDiv = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
export const qAbs = (a: Q): Q => ({ n: babs(a.n), d: a.d });
export const qCmp = (a: Q, b: Q) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
export const qIsZero = (a: Q) => a.n === 0n;
const pow2 = (k: number): Q => (k >= 0 ? q(1n << BigInt(k)) : q(1n, 1n << BigInt(-k)));

const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = 1n << BigInt((bl(n) + 1) >> 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
};
/** √a to within 2^-160 (absolute, and relative for any a above 2^-100). */
export function qSqrt(a: Q): Q {
  const k = 160n;
  return q(isqrt((a.n << (2n * k)) / a.d), 1n << k);
}

/** The ratio as the nearest double (to 53 bits; any magnitude). */
export function qNum(a: Q): number {
  if (a.n === 0n) return 0;
  const neg = a.n < 0n, n = babs(a.n);
  const shift = 64 - (bl(n) - bl(a.d));
  const num = shift >= 0 ? n << BigInt(shift) : n, den = shift >= 0 ? a.d : a.d << BigInt(-shift);
  const r = (num << 64n) / den;
  const e = -shift - 64;
  const v = Number(r) * 2 ** Math.trunc(e / 2) * 2 ** (e - Math.trunc(e / 2));
  return neg ? -v : v;
}

/** Digits of a rational: `sig` significant decimal digits (rounded), plain from 10^-4 to 10^7, else scientific. */
export function qText(a: Q, sig = 9): string {
  if (a.n === 0n) return '0';
  const neg = a.n < 0n, n = babs(a.n), p10 = (k: number) => 10n ** BigInt(k);
  let e10 = Math.floor(Math.log10(Math.abs(qNum(a))));
  const digitsAt = (ex: number) => {
    const s = sig - 1 - ex; // round(n / d × 10^s)
    return s >= 0 ? (2n * n * p10(s) + a.d) / (2n * a.d) : (2n * n + a.d * p10(-s)) / (2n * a.d * p10(-s));
  };
  let m = digitsAt(e10);
  while (m >= p10(sig)) m = digitsAt(++e10);
  while (m < p10(sig - 1)) m = digitsAt(--e10);
  const all = m.toString(), trimmed = all.replace(/0+$/, '') || '0', sign = neg ? '−' : '';
  if (e10 >= -4 && e10 < 7) {
    const at = e10 + 1;
    if (at <= 0) return `${sign}0.${'0'.repeat(-at)}${trimmed}`;
    const frac = all.slice(at).replace(/0+$/, '');
    return `${sign}${all.slice(0, at).padEnd(at, '0')}${frac ? `.${frac}` : ''}`;
  }
  return `${sign}${trimmed[0]}${trimmed.length > 1 ? `.${trimmed.slice(1)}` : ''}e${e10 < 0 ? '−' : '+'}${Math.abs(e10)}`;
}

/** The exact value of a finite float32 encoding. */
export function qOfBits(bits: number): Q {
  const p = parts(bits, F32);
  if (p.kind === 'inf' || p.kind === 'nan') throw new Error('not finite');
  const mant = BigInt(p.field === 0 ? p.frac : p.frac + 2 ** 23), exp2 = (p.field === 0 ? 1 : p.field) - p.bias - 23;
  const v = qMul(q(mant), pow2(exp2));
  return p.sign ? q(-v.n, v.d) : v;
}
export const valueOfBits = (bits: number) => qNum(qOfBits(bits));

/** Round a rational to float32 (round to nearest even), exactly. */
export function roundQ32(a: Q): number {
  if (a.n === 0n) return 0;
  const sign = a.n < 0n ? 1 : 0, n = babs(a.n);
  const s = Math.max(0, 64 - (bl(n) - bl(a.d))) + 2;
  const num = n << BigInt(s), mant = num / a.d, rem = num % a.d;
  return roundTo(sign, (mant << 1n) | (rem ? 1n : 0n), -s - 1, F32);
}

/** Weight of the last place of a float32 at |a|: 2^(max(⌊log2|a|⌋, −126) − 23). */
export function ulpExp(a: Q): number {
  const n = babs(a.n);
  let e = bl(n) - bl(a.d);
  if (!(e >= 0 ? n >= a.d << BigInt(e) : n << BigInt(-e) >= a.d)) e--;
  return Math.max(e, -126) - 23;
}
/** |f − real| in ulps of the real value (null when real is 0). */
export function ulpsOff(f: Q, real: Q): number | null {
  if (qIsZero(real)) return null;
  return qNum(qDiv(qAbs(qSub(f, real)), pow2(ulpExp(real))));
}
/** |f − real| / |real| (null when real is 0). */
export function relErr(f: Q, real: Q): number | null {
  if (qIsZero(real)) return null;
  return qNum(qDiv(qAbs(qSub(f, real)), qAbs(real)));
}

/** Machine epsilon (the gap from 1 to the next float) and the unit roundoff of round to nearest (half of it). */
export const EPSILON = 2 ** -23;
export const UNIT_ROUNDOFF = 2 ** -24;

// ---------- the expression ----------

export type Expr =
  | { op: 'num'; text: string; q: Q }
  | { op: '+' | '-' | '*' | '/'; a: Expr; b: Expr; text: string }
  | { op: 'neg' | 'sqrt'; a: Expr; text: string };

/** One evaluated node, in evaluation order. */
export interface Step {
  text: string;
  op: Expr['op'];
  /** The float32 result's encoding, and the real value of the same subexpression (from the decimal inputs). */
  bits: number;
  real: Q;
  /** The operation applied exactly to the float operands: what one rounding step would give (an approximation for sqrt). */
  own: Q;
  /** |float − own| / |own| ÷ u: this step's own rounding error in units of the unit roundoff (≤ 1 under RNE); null when own is 0. */
  delta: number | null;
  /** Operands' encodings (for the notes). */
  args: number[];
  /** Subtraction (or an addition of opposite signs) whose operands satisfy y/2 ≤ x ≤ 2y: exact by Sterbenz's lemma. */
  sterbenz: boolean;
  /** log2 of how much larger the biggest operand's magnitude is than the result's (an effective subtraction), else 0. */
  cancelled: number;
  /** Relative error of the result ÷ the largest relative error among the operands, when the operands carried error. */
  amplify: number | null;
}

export function parseExpr(src: string): Expr {
  const s = src.replace(/−/g, '-').replace(/×/g, '*').replace(/÷/g, '/').replace(/√/g, 'sqrt');
  let i = 0;
  const ws = () => { while (s[i] === ' ') i++; };
  const peek = () => (ws(), s[i]);
  const fail = (m: string): never => { throw new Error(m); };
  const text = (from: number) => s.slice(from, i).trim();
  function expr(): Expr {
    const from = (ws(), i);
    let a = term();
    while (peek() === '+' || peek() === '-') { const op = s[i++] as '+' | '-'; const b = term(); a = { op, a, b, text: text(from) }; }
    return a;
  }
  function term(): Expr {
    const from = (ws(), i);
    let a = unary();
    while (peek() === '*' || peek() === '/') { const op = s[i++] as '*' | '/'; const b = unary(); a = { op, a, b, text: text(from) }; }
    return a;
  }
  function unary(): Expr {
    const from = (ws(), i);
    if (peek() === '-') { i++; const a = unary(); return { op: 'neg', a, text: text(from) }; }
    return primary();
  }
  function primary(): Expr {
    const from = (ws(), i);
    if (peek() === '(') { i++; const e = expr(); if (peek() !== ')') fail('missing )'); i++; return { ...e, text: text(from) } as Expr; }
    if (s.startsWith('sqrt', i)) {
      i += 4;
      if (peek() !== '(') fail('sqrt needs ( )');
      i++; const a = expr(); if (peek() !== ')') fail('missing )'); i++;
      return { op: 'sqrt', a, text: text(from) };
    }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) return fail(i >= s.length ? 'the expression ends too soon' : `unexpected "${s[i]}"`);
    i += m[0].length;
    let val = decimalQ(m[0]);
    if (peek() === '^') {
      i++; const neg = s[i] === '-'; if (neg) i++;
      const d = /^\d+/.exec(s.slice(i)); if (!d || d[0].length > 4) return fail('^ needs a small integer');
      i += d[0].length;
      let r = q(1n); for (let k = 0; k < Number(d[0]); k++) r = qMul(r, val);
      val = neg ? qDiv(q(1n), r) : r;
    }
    return { op: 'num', text: text(from), q: val };
  }
  const e = expr();
  if (peek() !== undefined) fail(`unexpected "${s[i]}"`);
  return e;
}

function decimalQ(t: string): Q {
  const m = /^(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(t)!;
  const digits = BigInt((m[1] + m[2]) || '0'), exp = (m[3] ? Number(m[3]) : 0) - m[2].length;
  if (Math.abs(exp) > 400) throw new Error('exponent out of range');
  return exp >= 0 ? q(digits * 10n ** BigInt(exp)) : q(digits, 10n ** BigInt(-exp));
}

const isFiniteBits = (b: number) => { const k = parts(b, F32).kind; return k !== 'inf' && k !== 'nan'; };

/** Evaluate in float32 and exactly; the steps in evaluation order (operands before the operation). */
export function evaluate(e: Expr): { steps: Step[]; bits: number; real: Q } {
  const steps: Step[] = [];
  const err = (m: string): never => { throw new Error(m); };
  function go(x: Expr): { bits: number; real: Q } {
    if (x.op === 'num') {
      const bits = roundQ32(x.q);
      if (!isFiniteBits(bits)) err(`${x.text} is out of float32's range`);
      if (qCmp(qOfBits(bits), x.q) !== 0) steps.push(step(x, bits, x.q, x.q, [], []));
      return { bits, real: x.q };
    }
    const A = go(x.a);
    if (x.op === 'neg') return { bits: A.bits ^ 0x80000000, real: q(-A.real.n, A.real.d) };
    if (x.op === 'sqrt') {
      if (A.real.n < 0n) err('sqrt of a negative number');
      const r = fpSqrtX(A.bits, F32).y, real = qSqrt(A.real);
      return push(x, r, real, qSqrt(qOfBits(A.bits)), [A.bits], [A.real]);
    }
    if (!('b' in x)) return err('malformed expression');
    const B = go(x.b);
    const fa = qOfBits(A.bits), fb = qOfBits(B.bits);
    let r: number, real: Q, own: Q;
    switch (x.op) {
      case '+': r = fpAddX(A.bits, B.bits, false, F32).y; real = qAdd(A.real, B.real); own = qAdd(fa, fb); break;
      case '-': r = fpAddX(A.bits, B.bits, true, F32).y; real = qSub(A.real, B.real); own = qSub(fa, fb); break;
      case '*': r = fpMulX(A.bits, B.bits, F32).y; real = qMul(A.real, B.real); own = qMul(fa, fb); break;
      default:
        if (qIsZero(B.real) || qIsZero(fb)) err('division by zero');
        r = fpDivX(A.bits, B.bits, F32).y; real = qDiv(A.real, B.real); own = qDiv(fa, fb);
    }
    return push(x, r, real, own, [A.bits, B.bits], [A.real, B.real]);
  }
  function push(x: Expr, bits: number, real: Q, own: Q, args: number[], argReal: Q[]) {
    if (!isFiniteBits(bits)) err(`${x.text} overflows float32`);
    steps.push(step(x, bits, real, own, args, argReal));
    return { bits, real };
  }
  function step(x: Expr, bits: number, real: Q, own: Q, args: number[], argReal: Q[]): Step {
    const f = qOfBits(bits);
    const delta = qIsZero(own) ? null : qNum(qDiv(qAbs(qSub(f, own)), qAbs(own))) / UNIT_ROUNDOFF;
    let sterbenz = false, cancelled = 0, amplify: number | null = null;
    if ((x.op === '+' || x.op === '-') && args.length === 2) {
      const a = qOfBits(args[0]), b0 = qOfBits(args[1]), b = x.op === '-' ? q(-b0.n, b0.d) : b0;
      if (a.n !== 0n && b.n !== 0n && (a.n < 0n) !== (b.n < 0n) && !qIsZero(own)) {
        const ma = qAbs(a), mb = qAbs(b), big = qCmp(ma, mb) >= 0 ? ma : mb, small = big === ma ? mb : ma;
        sterbenz = qCmp(qMul(big, q(1n, 2n)), small) <= 0; // |big| / 2 ≤ |small|, i.e. y/2 ≤ x ≤ 2y
        cancelled = Math.max(0, Math.log2(qNum(qDiv(big, qAbs(own)))));
      } else if (a.n !== 0n && b.n !== 0n && (a.n < 0n) !== (b.n < 0n)) sterbenz = true; // result exactly 0
    }
    const re = relErr(f, real), ae = Math.max(0, ...args.map((b, k) => relErr(qOfBits(b), argReal[k]) ?? 0));
    if (re !== null && ae > 0 && args.length) amplify = re / ae;
    return { text: x.text, op: x.op, bits, real, own, delta, args, sterbenz, cancelled, amplify };
  }
  const r = go(e);
  return { steps, bits: r.bits, real: r.real };
}

/** Evaluate a string, or the reason it cannot be. */
export function evalText(src: string): { steps: Step[]; bits: number; real: Q } | { error: string } {
  try { return evaluate(parseExpr(src)); } catch (e) { return { error: (e as Error).message }; }
}
