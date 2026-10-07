// Drills: short generated exercises with an exact checker. A drill level is passed after enough
// correct answers; mistakes cost stars. Binary and hex, two's complement, Boolean simplification
// and Karnaugh maps (an exact minimum, don't-cares included). No DOM.

import { assemble16 } from '../riscv/rv16/asm16';
import { decode16, disasm16 } from '../riscv/rv16/isa16';

/** A seeded generator (mulberry32): the same seed gives the same questions. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export interface KmapSpec {
  vars: string[];
  /** Minterms (bit i of the index = vars[vars.length - 1 - i]: the first variable is the most significant). */
  ones: number[];
  dc: number[];
}

export interface Question {
  /** HTML. */
  prompt: string;
  placeholder?: string;
  /** Accepts the learner's text answer. */
  check(answer: string): { ok: boolean; why?: string };
  /** A correct answer, shown on request. */
  answer: string;
  /** HTML: why. */
  explain?: string;
  /** Draw a K-map for this question. */
  kmap?: KmapSpec;
}

export interface Drill {
  id: string;
  title: string;
  /** Correct answers needed to pass. */
  goal: number;
  /** HTML: how to answer. */
  how: string;
  make(r: () => number): Question;
}

// ---- numbers ----------------------------------------------------------------------------------

/** Parse an integer written in decimal, 0x hex or 0b binary (underscores and spaces allowed). */
export function parseNum(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/[_\s]/g, '');
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(-?)0x([0-9a-f]+)$/))) return (m[1] ? -1 : 1) * parseInt(m[2], 16);
  if ((m = t.match(/^(-?)0b([01]+)$/))) return (m[1] ? -1 : 1) * parseInt(m[2], 2);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  return null;
}

const bin = (v: number, w: number) => v.toString(2).padStart(w, '0');
const hex = (v: number, w: number) => v.toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');
const grp = (s: string) => s.replace(/(.{4})(?=.)/g, '$1 ');

/** A text answer must be this number written in this base (the prefix is optional). */
function numAnswer(want: number, base: 2 | 10 | 16, width = 0): Question['check'] {
  return (a) => {
    const t = a.trim().toLowerCase().replace(/[_\s]/g, '');
    const s = base === 16 && /^[0-9a-f]+$/.test(t) && !/^\d+$/.test(t) ? `0x${t}` : base === 16 && /^\d+$/.test(t) ? `0x${t}` : base === 2 && /^[01]+$/.test(t) ? `0b${t}` : t;
    const v = parseNum(s);
    if (v === null) return { ok: false, why: `write a ${base === 2 ? 'binary' : base === 16 ? 'hexadecimal' : 'decimal'} number` };
    if (base === 2 && width && t.replace(/^0b/, '').length !== width) return { ok: v === want, why: v === want ? undefined : 'not that value' };
    return { ok: v === want, why: v === want ? undefined : 'not that value' };
  };
}

const binary: Drill = {
  id: 'binary', title: 'Binary and hex', goal: 8,
  how: 'Type the number in the base asked for. Prefixes (0x, 0b) are optional; spaces are ignored.',
  make(r) {
    const k = int(r, 0, 3);
    const v = int(r, 0, 255);
    if (k === 0) return { prompt: `Write <b>${v}</b> in binary (8 bits).`, placeholder: '0000 0000', check: numAnswer(v, 2), answer: grp(bin(v, 8)), explain: `${v} = ${[...bin(v, 8)].map((b, i) => (b === '1' ? 2 ** (7 - i) : 0)).filter(Boolean).join(' + ') || 0}.` };
    if (k === 1) return { prompt: `What is <code>${grp(bin(v, 8))}</code> in decimal?`, check: numAnswer(v, 10), answer: String(v), explain: `Add the weights of the 1 bits (128, 64, 32, 16, 8, 4, 2, 1).` };
    if (k === 2) return { prompt: `Write <code>${grp(bin(v, 8))}</code> in hexadecimal.`, placeholder: '0x..', check: numAnswer(v, 16), answer: `0x${hex(v, 8)}`, explain: `One hex digit per group of four bits: ${grp(bin(v, 8)).split(' ').map((g) => `${g} = ${parseInt(g, 2).toString(16).toUpperCase()}`).join(', ')}.` };
    const w = int(r, 0, 0xffff);
    return { prompt: `Write <b>0x${hex(w, 16)}</b> in decimal.`, check: numAnswer(w, 10), answer: String(w), explain: `Each hex digit weighs a power of 16: ${[...hex(w, 16)].map((d, i) => `${parseInt(d, 16)}×${16 ** (3 - i)}`).join(' + ')}.` };
  },
};

const s8 = (v: number) => (v & 0x80 ? v - 256 : v);

const twos: Drill = {
  id: 'twos', title: "Two's complement", goal: 8,
  how: 'Answer in decimal (signed) or as asked. 8-bit two\'s complement: −128 … 127.',
  make(r) {
    const k = int(r, 0, 4);
    const v = int(r, 0, 255);
    if (k === 0) return { prompt: `The 8-bit pattern <code>${grp(bin(v, 8))}</code> as a signed (two's-complement) number?`, check: numAnswer(s8(v), 10), answer: String(s8(v)), explain: `The top bit weighs −128: ${v & 0x80 ? `−128 + ${v & 0x7f}` : String(v)} = ${s8(v)}.` };
    if (k === 1) {
      const x = int(r, -128, 127);
      return { prompt: `Write <b>${x}</b> as an 8-bit two's-complement pattern.`, placeholder: '0000 0000', check: numAnswer(x & 0xff, 2), answer: grp(bin(x & 0xff, 8)), explain: x < 0 ? `−x = ¬x + 1: ${grp(bin(-x, 8))} → ${grp(bin(~-x & 0xff, 8))} → ${grp(bin(x & 0xff, 8))}.` : 'Positive: the plain binary value.' };
    }
    if (k === 2) {
      const x = int(r, -127, 127);
      return { prompt: `Negate <code>${grp(bin(x & 0xff, 8))}</code>: the 8-bit pattern of its negation?`, placeholder: '0000 0000', check: numAnswer(-x & 0xff, 2), answer: grp(bin(-x & 0xff, 8)), explain: `Invert every bit, then add 1.` };
    }
    if (k === 3) {
      const a = int(r, -128, 127), b = int(r, -128, 127);
      const sum = a + b, ovf = sum < -128 || sum > 127;
      return {
        prompt: `In 8 bits, <b>${a} + ${b}</b>: does it overflow (signed)? Answer <code>yes</code> or <code>no</code>.`,
        check: (t) => { const y = /^\s*(y|yes|1|true)\s*$/i.test(t), n = /^\s*(n|no|0|false)\s*$/i.test(t); return { ok: (y && ovf) || (n && !ovf), why: y || n ? 'no' : 'yes or no' }; },
        answer: ovf ? 'yes' : 'no', explain: `The true sum is ${sum}; 8 bits hold −128 … 127. Overflow ⇔ both operands have the same sign and the result the other.`,
      };
    }
    const x = int(r, -32, 31);
    return { prompt: `Sign-extend the 6-bit immediate <code>${bin(x & 0x3f, 6)}</code> to 16 bits (hex).`, placeholder: '0x....', check: numAnswer(x & 0xffff, 16), answer: `0x${hex(x & 0xffff, 16)}`, explain: `Copy the sign bit (${(x >> 5) & 1}) into bits 15…6: the value stays ${x}.` };
  },
};

// ---- Boolean expressions ------------------------------------------------------------------------

type Ex = { k: 'v'; i: number } | { k: 'c'; v: 0 | 1 } | { k: 'not'; a: Ex } | { k: 'and' | 'or' | 'xor'; a: Ex; b: Ex };

/**
 * Parse a Boolean expression over the given variables. NOT: prefix ¬ ~ ! or postfix ' ; AND: · * &
 * or juxtaposition; OR: + |; XOR: ^ ⊕; constants 0 / 1; parentheses.
 */
export function parseBool(src: string, vars: string[]): { ex: Ex; literals: number } | { error: string } {
  const toks = src.replace(/\s+/g, ' ').trim().match(/[A-Za-z]|[01]|[()¬~!'+|^⊕·*&]|./g) ?? [];
  let pos = 0, literals = 0;
  const peek = () => (pos < toks.length ? toks[pos] : '');
  const fail = (m: string): never => { throw new Error(m); };
  const atomStart = (t: string) => /[A-Za-z01(¬~!]/.test(t);
  const orE = (): Ex => {
    let a = xorE();
    while (peek() === '+' || peek() === '|') { pos++; a = { k: 'or', a, b: xorE() }; }
    return a;
  };
  const xorE = (): Ex => {
    let a = andE();
    while (peek() === '^' || peek() === '⊕') { pos++; a = { k: 'xor', a, b: andE() }; }
    return a;
  };
  const andE = (): Ex => {
    let a = unary();
    for (;;) {
      if (['·', '*', '&'].includes(peek())) { pos++; a = { k: 'and', a, b: unary() }; } else if (peek() === ' ') { pos++; } else if (atomStart(peek())) a = { k: 'and', a, b: unary() };
      else return a;
    }
  };
  const unary = (): Ex => {
    while (peek() === ' ') pos++;
    let e: Ex;
    const t = peek();
    if (t === '¬' || t === '~' || t === '!') { pos++; e = { k: 'not', a: unary() }; } else if (t === '(') {
      pos++;
      e = orE();
      while (peek() === ' ') pos++;
      if (peek() !== ')') fail('missing )');
      pos++;
    } else if (t === '0' || t === '1') { pos++; e = { k: 'c', v: t === '1' ? 1 : 0 }; } else if (/[A-Za-z]/.test(t)) {
      const i = vars.indexOf(t.toLowerCase());
      if (i < 0) fail(`unknown variable ${t} (use ${vars.join(', ')})`);
      pos++;
      literals++;
      e = { k: 'v', i };
    } else return fail(t ? `unexpected ${t}` : 'incomplete expression');
    while (peek() === "'") { pos++; e = { k: 'not', a: e }; }
    while (peek() === ' ' && toks[pos + 1] === "'") pos++;
    return e;
  };
  try {
    const ex = orE();
    while (peek() === ' ') pos++;
    if (pos < toks.length) fail(`unexpected ${peek()}`);
    return { ex, literals };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Evaluate with variable values packed in `x` (vars[0] is the most significant bit). */
export function evalBool(e: Ex, x: number, n: number): number {
  switch (e.k) {
    case 'v': return (x >> (n - 1 - e.i)) & 1;
    case 'c': return e.v;
    case 'not': return evalBool(e.a, x, n) ^ 1;
    case 'and': return evalBool(e.a, x, n) & evalBool(e.b, x, n);
    case 'or': return evalBool(e.a, x, n) | evalBool(e.b, x, n);
    default: return evalBool(e.a, x, n) ^ evalBool(e.b, x, n);
  }
}

/** A product term: bits in mask are free; the others must equal val. */
export interface Term { val: number; mask: number }

const covers = (t: Term, m: number) => (m & ~t.mask) === t.val;
const lits = (t: Term, n: number) => n - popcount(t.mask);
function popcount(x: number): number {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
}

/** Prime implicants of ones ∪ dc (Quine–McCluskey). */
export function primes(ones: number[], dc: number[] = []): Term[] {
  let cur: Term[] = [...new Set([...ones, ...dc])].map((m) => ({ val: m, mask: 0 }));
  const out: Term[] = [];
  const key = (t: Term) => `${t.val}/${t.mask}`;
  while (cur.length) {
    const used = new Set<string>(), next = new Map<string, Term>();
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
      const a = cur[i], b = cur[j], d = a.val ^ b.val;
      if (a.mask === b.mask && d && !(d & (d - 1))) {
        const t = { val: a.val & ~d, mask: a.mask | d };
        next.set(key(t), t);
        used.add(key(a)).add(key(b));
      }
    }
    for (const t of cur) if (!used.has(key(t)) && !out.some((p) => key(p) === key(t))) out.push(t);
    cur = [...next.values()];
  }
  return out;
}

/** An exact minimum sum of products (fewest terms, then fewest literals) covering `ones`. */
export function minimumCover(n: number, ones: number[], dc: number[] = []): Term[] {
  if (!ones.length) return [];
  const ps = primes(ones, dc).filter((p) => ones.some((m) => covers(p, m)));
  let best: Term[] | null = null;
  const cost = (ts: Term[]) => ts.length * 1000 + ts.reduce((a, t) => a + lits(t, n), 0);
  const go = (left: number[], chosen: Term[]) => {
    if (best && cost(chosen) >= cost(best)) return;
    if (!left.length) { best = [...chosen]; return; }
    // Branch on the first uncovered minterm's covering primes.
    const m = left[0];
    for (const p of ps) {
      if (!covers(p, m)) continue;
      go(left.filter((x) => !covers(p, x)), [...chosen, p]);
    }
  };
  go(ones, []);
  return best ?? [];
}

export const termText = (t: Term, vars: string[]): string => {
  const n = vars.length;
  if (t.mask === (1 << n) - 1) return '1';
  return vars.map((v, i) => {
    const bit = 1 << (n - 1 - i);
    return t.mask & bit ? '' : t.val & bit ? v : `${v}'`;
  }).join('');
};

export const sopText = (ts: Term[], vars: string[]): string => (ts.length ? ts.map((t) => termText(t, vars)).join(' + ') : '0');

export const sopLiterals = (ts: Term[], n: number): number => ts.reduce((a, t) => a + lits(t, n), 0);

/** Check an expression against a function (on its care set) and a literal budget. */
export function checkExpr(src: string, k: KmapSpec, maxLiterals: number): { ok: boolean; why?: string } {
  const n = k.vars.length;
  const p = parseBool(src, k.vars);
  if ('error' in p) return { ok: false, why: p.error };
  for (let x = 0; x < 2 ** n; x++) {
    if (k.dc.includes(x)) continue;
    const want = k.ones.includes(x) ? 1 : 0;
    if (evalBool(p.ex, x, n) !== want) {
      const at = k.vars.map((v, i) => `${v}=${(x >> (n - 1 - i)) & 1}`).join(' ');
      return { ok: false, why: `wrong for ${at} (gives ${want ^ 1}, should be ${want})` };
    }
  }
  if (p.literals > maxLiterals) return { ok: false, why: `equivalent, but ${p.literals} literals: the minimum is ${maxLiterals}` };
  return { ok: true };
}

const VARS = ['a', 'b', 'c', 'd'];

const kmap: Drill = {
  id: 'kmap', title: 'Karnaugh maps', goal: 5,
  how: 'Write a minimal sum of products, e.g. <code>a\'b + cd</code> (\' or ¬ for NOT, juxtaposition or · for AND, + for OR). It must match every 1 and 0 (× are don\'t-cares) and use no more literals than the minimum.',
  make(r) {
    const n = r() < 0.35 ? 3 : 4;
    const vars = VARS.slice(0, n);
    const N = 2 ** n;
    for (;;) {
      const ones: number[] = [], dc: number[] = [];
      for (let x = 0; x < N; x++) {
        const u = r();
        if (u < 0.42) ones.push(x);
        else if (n === 4 && u < 0.5) dc.push(x);
      }
      if (ones.length < 2 || ones.length + dc.length >= N - 1) continue;
      const min = minimumCover(n, ones, dc);
      const L = sopLiterals(min, n);
      if (min.length < 2 || L < 3) continue;
      const k: KmapSpec = { vars, ones, dc };
      return {
        prompt: `Minimal sum of products for this ${n}-variable function (${min.length} terms, ${L} literals are enough).`,
        placeholder: n === 4 ? "a'b + cd" : "ab + c'", kmap: k, answer: sopText(min, vars),
        check: (t) => checkExpr(t, k, L),
        explain: `Groups: ${min.map((t) => termText(t, vars)).join(', ')}. Each group of 2^k cells drops the k variables that change inside it.`,
      };
    }
  },
};

/** Expressions to simplify, with a minimum literal count. */
const SIMPLIFY: { src: string; vars: string[] }[] = [
  { src: "a·b + a·b'", vars: ['a', 'b'] }, { src: "a + a·b", vars: ['a', 'b'] }, { src: "¬(¬a + ¬b)", vars: ['a', 'b'] },
  { src: "a·b + a'·c + b·c", vars: ['a', 'b', 'c'] }, { src: "(a + b)(a + c)", vars: ['a', 'b', 'c'] }, { src: "¬(a·b)·¬(a'·b)", vars: ['a', 'b'] },
  { src: "a'b'c + a'bc + ab'c + abc", vars: ['a', 'b', 'c'] }, { src: "¬(¬a·¬b) · ¬a", vars: ['a', 'b'] }, { src: "a·(a' + b)", vars: ['a', 'b'] },
  { src: "(a + b')·(a' + b')", vars: ['a', 'b'] }, { src: "a·b·c + a·b·c' + a·b'·c", vars: ['a', 'b', 'c'] }, { src: "¬(a + b·¬a)", vars: ['a', 'b'] },
];

const boolean: Drill = {
  id: 'boolean', title: 'Simplify', goal: 6,
  how: 'Write an equivalent expression with as few literals (variable occurrences) as the minimum. NOT: \' or ¬; AND: juxtaposition or ·; OR: +.',
  make(r) {
    const q = SIMPLIFY[int(r, 0, SIMPLIFY.length - 1)];
    const p = parseBool(q.src, q.vars);
    if ('error' in p) throw new Error(`bad drill ${q.src}: ${p.error}`);
    const n = q.vars.length;
    const ones = Array.from({ length: 2 ** n }, (_, x) => x).filter((x) => evalBool(p.ex, x, n));
    const min = minimumCover(n, ones);
    const constant = !ones.length ? '0' : ones.length === 2 ** n ? '1' : null;
    const L = constant ? 0 : sopLiterals(min, n);
    const k: KmapSpec = { vars: q.vars, ones, dc: [] };
    return {
      prompt: `Simplify <code>${q.src}</code> to ${constant ? 'a constant' : `${L} literal${L === 1 ? '' : 's'}`}.`,
      placeholder: 'ab + c', answer: constant ?? sopText(min, q.vars),
      check: (t) => checkExpr(t, k, L),
      explain: 'Use absorption (a + ab = a), complements (a + a\' = 1), consensus and De Morgan; or draw the K-map.',
    };
  },
};

// ---- RV16 encoding --------------------------------------------------------------------------

const ENC_SAMPLES = [
  'add a0, a1, a2', 'sub t0, a0, a1', 'addi a0, a0, -1', 'addi sp, sp, 5', 'lw a1, 3(sp)', 'sw ra, -1(sp)', 'beq a0, zero, -4', 'bne a0, a1, 7',
  'jal ra, 20', 'jalr zero, 0(ra)', 'lui a0, 3', 'slli a0, a0, 4', 'srai t1, a2, 15', 'and t0, t0, a2', 'xor a2, a2, a2', 'blt a1, a0, -32', 'sltu a0, zero, a1',
];

const isa16: Drill = {
  id: 'isa16', title: 'Encode and decode', goal: 6,
  how: 'Encode: give the 16-bit word in hex. Decode: write the instruction (register names or x0–x7; immediates in decimal). Fields: op [3:0], rd [6:4], rs1 [9:7], rs2 [12:10], f3 [15:13].',
  make(r) {
    const text = ENC_SAMPLES[int(r, 0, ENC_SAMPLES.length - 1)];
    const a = assemble16(text);
    const w = a.words[0];
    if (r() < 0.5) {
      return {
        prompt: `Encode <code>${text}</code> as a 16-bit word (hex).`, placeholder: '0x....', check: numAnswer(w, 16), answer: `0x${hex(w, 16)}`,
        explain: `Fields: f3 ${(w >> 13) & 7}, rs2 ${(w >> 10) & 7}, rs1 ${(w >> 7) & 7}, rd ${(w >> 4) & 7}, op ${w & 15}: ${grp(bin(w, 16))}.`,
      };
    }
    return {
      prompt: `Decode <code>0x${hex(w, 16)}</code> (${grp(bin(w, 16))}).`, placeholder: 'add a0, a1, a2',
      check: (t) => {
        const b = assemble16(t);
        if (b.errors.length) return { ok: false, why: b.errors[0].message };
        return { ok: b.words.length === 1 && decodeSame(b.words[0], w), why: 'that is a different instruction' };
      },
      answer: disasm16(w), explain: `op = ${w & 15}: ${decode16(w).spec?.fmt}-format.`,
    };
  },
};

/** Same instruction, ignoring fields the format does not use. */
function decodeSame(x: number, y: number): boolean {
  const a = decode16(x), b = decode16(y);
  if (!a.spec || a.spec !== b.spec) return false;
  const f = a.spec.fmt;
  return a.imm === b.imm && (f === 'S' || f === 'B' || a.rd === b.rd) && (f === 'U' || f === 'J' || a.rs1 === b.rs1)
    && (!['R', 'S', 'B'].includes(f) || a.rs2 === b.rs2);
}

export const DRILLS: Record<string, Drill> = { binary, twos, kmap, boolean, isa16 };
