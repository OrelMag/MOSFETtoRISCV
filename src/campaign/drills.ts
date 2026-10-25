// Drills: short generated exercises with an exact checker. A drill level is passed after enough
// correct answers; mistakes cost stars. Binary and hex, two's complement, Boolean simplification
// and Karnaugh maps (an exact minimum, don't-cares included); Act P's relay (numbers read off the physical
// model's curves, drawn as inline SVG) and punched cards. No DOM.

import { objectCard, seqText, textCard, wordOf } from '../cards/card';
import { CHARSET, charOf, punchOf, ROW9, ROWS, rowsOf, rowsOfChar } from '../cards/hollerith';
import { RELAY, RELAY_STEP_MS, RELAY_SUPPLY, type RelayParams, relayPull, type RelayRun, relaySim, relayStatic, relaySummary, T_OFF, T_ON, Z3 } from '../phys/relay';
import { evalBool, parseBool } from '../lib/boolexpr';
import { literals as lits, minimumCover, primes, type Term } from '../lib/sop';
import { assemble16 } from '../riscv/rv16/asm16';
import { decode16, disasm16, REG_NAMES16 } from '../riscv/rv16/isa16';

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
  how: 'Type the number in the base asked for (a bit as 0 or 1). Prefixes (0x, 0b) are optional; spaces are ignored. 8-bit and 16-bit words, unsigned.',
  make(r) {
    const k = int(r, 0, 6);
    const v = int(r, 0, 255);
    if (k >= 4) {
      const w = int(r, 0, 0xffff);
      if (k === 4) {
        const i = int(r, 0, 15), bit = (w >> i) & 1, d = i >> 2;
        return {
          prompt: `What is bit <b>${i}</b> of <code>0x${hex(w, 16)}</code>? (Bit 0 is the least significant.)`, placeholder: '0 or 1', check: numAnswer(bit, 10), answer: String(bit),
          explain: `Bit ${i} is bit ${i & 3} of hex digit ${d}, both counted from 0 at the right: <code>${hex(w, 16)[3 - d]}</code> = ${bin((w >> (4 * d)) & 15, 4)}, so ${bit}.`,
        };
      }
      if (k === 5) {
        return {
          prompt: `Write <code>0x${hex(w, 16)}</code> in binary (16 bits).`, placeholder: '0000 0000 0000 0000', check: numAnswer(w, 2), answer: grp(bin(w, 16)),
          explain: `Four bits per hex digit, in order: ${[...hex(w, 16)].map((c) => `${c} = ${bin(parseInt(c, 16), 4)}`).join(', ')}.`,
        };
      }
      const n = [4, 6, 8, 10, 12, 16][int(r, 0, 5)];
      return {
        prompt: `The largest unsigned value ${n === 8 ? 'an' : 'a'} <b>${n}-bit</b> word holds, in decimal?`, check: numAnswer(2 ** n - 1, 10), answer: String(2 ** n - 1),
        explain: `All ${n} bits 1: 2^${n} − 1 = ${2 ** n - 1}. ${n === 8 ? 'An' : 'A'} ${n}-bit word holds 2^${n} = ${2 ** n} values, 0 to ${2 ** n - 1}.`,
      };
    }
    if (k === 0) return { prompt: `Write <b>${v}</b> in binary (8 bits).`, placeholder: '0000 0000', check: numAnswer(v, 2), answer: grp(bin(v, 8)), explain: `${v} = ${[...bin(v, 8)].map((b, i) => (b === '1' ? 2 ** (7 - i) : 0)).filter(Boolean).join(' + ') || 0}.` };
    if (k === 1) return { prompt: `What is <code>${grp(bin(v, 8))}</code> in decimal?`, check: numAnswer(v, 10), answer: String(v), explain: `Add the weights of the 1 bits (128, 64, 32, 16, 8, 4, 2, 1).` };
    if (k === 2) return { prompt: `Write <code>${grp(bin(v, 8))}</code> in hexadecimal.`, placeholder: '0x..', check: numAnswer(v, 16), answer: `0x${hex(v, 8)}`, explain: `One hex digit per group of four bits: ${grp(bin(v, 8)).split(' ').map((g) => `${g} = ${parseInt(g, 2).toString(16).toUpperCase()}`).join(', ')}.` };
    const w = int(r, 0, 0xffff);
    return { prompt: `Write <b>0x${hex(w, 16)}</b> in decimal.`, check: numAnswer(w, 10), answer: String(w), explain: `Each hex digit weighs a power of 16: ${[...hex(w, 16)].map((d, i) => `${parseInt(d, 16)}×${16 ** (3 - i)}`).join(' + ')}.` };
  },
};

const s8 = (v: number) => (v & 0x80 ? v - 256 : v);
const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);

const twos: Drill = {
  id: 'twos', title: "Two's complement", goal: 8,
  how: 'Answer in decimal (signed), as a pattern, or yes / no, as asked. 8-bit two\'s complement: −128 … 127; 16-bit: −32 768 … 32 767.',
  make(r) {
    const k = int(r, 0, 7);
    const v = int(r, 0, 255);
    if (k >= 5) {
      const w = int(r, 0, 0xffff);
      if (k === 5) {
        const x = r() < 0.7 ? w | 0x8000 : w;
        return {
          prompt: `The 16-bit pattern <code>0x${hex(x, 16)}</code> as a signed (two's-complement) number?`, check: numAnswer(s16(x), 10), answer: String(s16(x)),
          explain: `The top bit weighs −32 768: ${x & 0x8000 ? `−32 768 + ${x & 0x7fff}` : String(x)} = ${s16(x)}. As unsigned the same bits are ${x}.`,
        };
      }
      // a and b with different signs half the time: then the signed and unsigned orders disagree
      let b = int(r, 0, 0xffff);
      if (r() < 0.5 && ((w ^ b) & 0x8000) === 0) b ^= 0x8000;
      if (b === w) b = (w + 1) & 0xffff;
      const ltu = w < b, lt = s16(w) < s16(b);
      const order = `As unsigned, ${w} ${ltu ? '<' : '≥'} ${b}; as signed, ${s16(w)} ${lt ? '<' : '≥'} ${s16(b)}.`;
      if (k === 6) {
        const signed = r() < 0.5;
        return {
          prompt: `Is <code>0x${hex(w, 16)}</code> &lt; <code>0x${hex(b, 16)}</code> as <b>${signed ? 'signed' : 'unsigned'}</b> 16-bit numbers? (yes / no)`, placeholder: 'yes / no',
          check: yesNo(signed ? lt : ltu), answer: (signed ? lt : ltu) ? 'yes' : 'no',
          explain: `${order} The orders differ exactly when the top bits do: signed, a word with bit 15 set is negative.`,
        };
      }
      const cout = w >= b;
      return {
        prompt: `In 16 bits, a = <code>0x${hex(w, 16)}</code>, b = <code>0x${hex(b, 16)}</code>: does a + ¬b + 1 (that is a − b) carry out of bit 15? (yes / no)`, placeholder: 'yes / no',
        check: yesNo(cout), answer: cout ? 'yes' : 'no',
        explain: `a + ¬b + 1 = a + (65 536 − b): it carries out exactly when a ≥ b as unsigned numbers. ${order} So a &lt; b unsigned ⇔ no carry out: sltu is ¬cout.`,
      };
    }
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

// ---- Boolean expressions (lib/boolexpr.ts) --------------------------------------------------------

export { evalBool, parseBool };
export { minimumCover, primes, type Term };

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

/**
 * Expressions to simplify, each with its derivation: `steps` are equal expressions, the last one minimal (its literal
 * count is the target the checker uses; tests/content-acts012.test.ts proves every step equal to `src`), `why` names
 * the laws used. One notation throughout: ¬ for NOT, · for AND. The second half come from the levels' circuits.
 */
export const SIMPLIFY: { src: string; vars: string[]; steps: string[]; why: string }[] = [
  { src: 'a·b + a·¬b', vars: ['a', 'b'], steps: ['a·(b + ¬b)', 'a'], why: 'Distribute, then complement: b + ¬b = 1.' },
  { src: 'a + a·b', vars: ['a', 'b'], steps: ['a·(1 + b)', 'a'], why: 'Absorption: 1 + b = 1.' },
  { src: '¬(¬a + ¬b)', vars: ['a', 'b'], steps: ['¬¬a·¬¬b', 'a·b'], why: 'De Morgan, then double negation.' },
  { src: 'a·b + ¬a·c + b·c', vars: ['a', 'b', 'c'], steps: ['a·b + ¬a·c + (a + ¬a)·b·c', 'a·b·(1 + c) + ¬a·c·(1 + b)', 'a·b + ¬a·c'], why: 'Consensus: b·c is covered by whichever of a·b, ¬a·c holds.' },
  { src: '(a + b)·(a + c)', vars: ['a', 'b', 'c'], steps: ['a + a·c + a·b + b·c', 'a + b·c'], why: 'Multiply out (a·a = a), then absorption: the dual distributive law.' },
  { src: '¬(a·b)·¬(¬a·b)', vars: ['a', 'b'], steps: ['(¬a + ¬b)·(a + ¬b)', '¬b + ¬a·a', '¬b'], why: 'De Morgan on both, then (x + y)·(z + y) = y + x·z and ¬a·a = 0.' },
  { src: '¬a·¬b·c + ¬a·b·c + a·¬b·c + a·b·c', vars: ['a', 'b', 'c'], steps: ['¬a·c·(¬b + b) + a·c·(¬b + b)', '¬a·c + a·c', 'c'], why: 'Terms that differ in one variable merge, twice.' },
  { src: '¬(¬a·¬b)·¬a', vars: ['a', 'b'], steps: ['(a + b)·¬a', 'a·¬a + ¬a·b', '¬a·b'], why: 'De Morgan, distribute, a·¬a = 0.' },
  { src: 'a·(¬a + b)', vars: ['a', 'b'], steps: ['a·¬a + a·b', 'a·b'], why: 'Distribute, a·¬a = 0.' },
  { src: '(a + ¬b)·(¬a + ¬b)', vars: ['a', 'b'], steps: ['¬b + a·¬a', '¬b'], why: '(x + y)·(z + y) = y + x·z, and a·¬a = 0.' },
  { src: 'a·b·c + a·b·¬c + a·¬b·c', vars: ['a', 'b', 'c'], steps: ['a·b + a·¬b·c', 'a·(b + ¬b·c)', 'a·(b + c)', 'a·b + a·c'], why: 'Merge the first two, then b + ¬b·c = b + c. a·(b + c) has 3 literals but is not a sum of products; as one it is 4.' },
  { src: '¬(a + b·¬a)', vars: ['a', 'b'], steps: ['¬(a + b)', '¬a·¬b'], why: 'a + ¬a·b = a + b, then De Morgan.' },
  // from the levels
  { src: '¬(a·a)', vars: ['a'], steps: ['¬a'], why: 'Idempotence, a·a = a: NOT from NAND, inputs tied.' },
  { src: '¬(¬(a·b)·¬(a·b))', vars: ['a', 'b'], steps: ['¬¬(a·b)', 'a·b'], why: 'Idempotence, then double negation: AND from two NANDs.' },
  { src: '¬(¬a·¬b)', vars: ['a', 'b'], steps: ['¬¬a + ¬¬b', 'a + b'], why: 'De Morgan: OR from three NANDs.' },
  { src: '¬(¬(a·¬(a·b))·¬(b·¬(a·b)))', vars: ['a', 'b'], steps: ['a·¬(a·b) + b·¬(a·b)', 'a·(¬a + ¬b) + b·(¬a + ¬b)', 'a·¬b + ¬a·b'], why: 'De Morgan on the outer NAND and on the shared ¬(a·b): the 4-NAND XOR is a ⊕ b.' },
  { src: '¬(¬(s·b)·¬(¬s·a))', vars: ['s', 'a', 'b'], steps: ['s·b + ¬s·a'], why: 'De Morgan: a NAND of NANDs is an OR of ANDs. The 2:1 multiplexer in NAND–NAND form.' },
  { src: '¬s·a + s·b + a·b', vars: ['s', 'a', 'b'], steps: ['¬s·a + s·b'], why: 'Consensus: a·b holds only where ¬s·a or s·b already does. What is left is the 2:1 multiplexer.' },
  { src: 'a·b + a·c + b·c + a·b·c', vars: ['a', 'b', 'c'], steps: ['a·b + a·c + b·c'], why: 'Absorption: a·b·c is inside a·b. The full adder\'s carry, the majority of three.' },
  { src: 'a·b + c·(a ⊕ b)', vars: ['a', 'b', 'c'], steps: ['a·b + a·¬b·c + ¬a·b·c', 'a·b + a·c + b·c'], why: 'Expand the XOR; a·b + a·¬b·c = a·(b + c), and the same for b: the full adder\'s carry as par builds it is the majority.' },
  { src: '¬(a + b + c + d)', vars: ['a', 'b', 'c', 'd'], steps: ['¬a·¬b·¬c·¬d'], why: 'De Morgan over four inputs: the zero detect.' },
  { src: '¬(a ⊕ b)', vars: ['a', 'b'], steps: ['¬(a·¬b + ¬a·b)', '(¬a + b)·(a + ¬b)', 'a·b + ¬a·¬b'], why: 'De Morgan twice, multiply out, a·¬a = 0: one bit of the equality test.' },
  { src: '¬a·¬b·c·e + ¬a·¬b·c·¬e', vars: ['a', 'b', 'c', 'e'], steps: ['¬a·¬b·c·(e + ¬e)', '¬a·¬b·c'], why: 'A decoder line ANDed with e and with ¬e: e drops out.' },
  { src: '¬c·b·¬a + ¬c·b·a + c·¬b·a + c·b·a', vars: ['c', 'b', 'a'], steps: ['¬c·b·(¬a + a) + c·a·(¬b + b)', '¬c·b + c·a'], why: 'The primes below 8 (2, 3, 5, 7) merge in pairs: c ? a : b, a multiplexer, the prime detector\'s lower half.' },
];

const boolean: Drill = {
  id: 'boolean', title: 'Simplify', goal: 6,
  how: 'Write an equivalent expression with no more literals (variable occurrences) than asked. NOT: ¬ (or \' or ~); AND: · or juxtaposition; OR: +.',
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
      placeholder: '¬a·b + c', answer: constant ?? q.steps[q.steps.length - 1],
      check: (t) => checkExpr(t, k, L),
      explain: `<code>${[q.src, ...q.steps].join('</code> = <code>')}</code>. ${q.why}`,
    };
  },
};

// ---- RV16 encoding --------------------------------------------------------------------------

/** A random RV16I instruction as assembly text: every format, negative immediates half the time. */
export function randomInstr16(r: () => number): string {
  const reg = (lo = 1) => REG_NAMES16[int(r, lo, 7)];
  const imm6 = () => (r() < 0.5 ? int(r, -32, -1) : int(r, 0, 31));
  const pick = <T>(xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)];
  switch (pick(['R', 'I', 'SH', 'U', 'B', 'S', 'J'] as const)) {
    case 'R': return `${pick(['add', 'sub', 'and', 'or', 'xor', 'sll', 'srl', 'sra', 'slt', 'sltu'])} ${reg()}, ${reg(0)}, ${reg(0)}`;
    case 'I': {
      const op = pick(['addi', 'lw', 'jalr']);
      return op === 'addi' ? `addi ${reg()}, ${reg(0)}, ${imm6()}` : `${op} ${op === 'jalr' ? reg(0) : reg()}, ${imm6()}(${reg(0)})`;
    }
    case 'SH': return `${pick(['slli', 'srli', 'srai'])} ${reg()}, ${reg(0)}, ${int(r, 0, 15)}`;
    case 'U': return `lui ${reg()}, ${int(r, 0, 1023)}`;
    case 'B': return `${pick(['beq', 'bne', 'blt', 'bge'])} ${reg(0)}, ${reg(0)}, ${imm6()}`;
    case 'S': return `sw ${reg(0)}, ${imm6()}(${reg(0)})`;
    case 'J': {
      const rd = reg(0), off = r() < 0.5 ? int(r, -256, -1) : int(r, 1, 255);
      return `jal ${rd}, ${off}`;
    }
  }
}

/** A word's fields as its format cuts them: [bits, label] from bit 15 down. */
function fieldCut(w: number): [string, string][] {
  const d = decode16(w), f = d.spec?.fmt, b = bin(w, 16);
  const cut = (widths: number[], labels: string[]): [string, string][] => {
    let at = 0;
    return widths.map((n, i) => [b.slice(at, (at += n)), labels[i]]);
  };
  if (f === 'R') return cut([3, 3, 3, 3, 4], ['f3', 'rs2', 'rs1', 'rd', 'op']);
  if (f === 'I') return cut([6, 3, 3, 4], ['imm[5:0]', 'rs1', 'rd', 'op']);
  if (f === 'SH') return cut([2, 4, 3, 3, 4], ['type', 'shift', 'rs1', 'rd', 'op']);
  if (f === 'S' || f === 'B') return cut([3, 3, 3, 3, 4], ['imm[5:3]', 'rs2', 'rs1', 'imm[2:0]', 'op']);
  if (f === 'J') return cut([9, 3, 4], ['imm[8:0]', 'rd', 'op']);
  if (f === 'U') return cut([9, 3, 1, 3], ['imm[9:1]', 'rd', 'imm[0]', 'op']);
  return cut([16], ['word']);
}

const regText = (k: number) => `${REG_NAMES16[k]} = x${k}`;

/** Why a word is what it is, field by field (both directions of the drill show it). */
export function explain16(w: number): string {
  const d = decode16(w), s = d.spec!, op = w & 15;
  const cut = fieldCut(w).map(([bits, l]) => `<code>${bits}</code> ${l}`).join(' · ');
  const parts: string[] = [];
  const signed = (bits: string, v: number) => `${bits} = ${v}${v < 0 ? ` (bit ${bits.length - 1} set: −${2 ** (bits.length - 1)} + ${v + 2 ** (bits.length - 1)})` : ''}`;
  switch (s.fmt) {
    case 'R':
      parts.push(`op ${bin(op, 4)} = ${op === 1 ? 'OP' : 'OPX'}, R-format: f3 = ${bin((w >> 13) & 7, 3)} → <code>${s.name}</code>`, `rd ${regText(d.rd)}`, `rs1 ${regText(d.rs1)}`, `rs2 ${regText(d.rs2)}`);
      break;
    case 'I':
      parts.push(`op ${bin(op, 4)} = ${s.name.toUpperCase()}, I-format`, `rd ${regText(d.rd)}`, `rs1 ${regText(d.rs1)}`, `imm = bits 15:10 = ${signed(bin(d.imm & 63, 6), d.imm)}`);
      break;
    case 'SH':
      parts.push(`op 0101 = SHI: bits 15:14 = ${bin((w >> 14) & 3, 2)} → <code>${s.name}</code> (00 sll, 01 srl, 10 sra)`, `rd ${regText(d.rd)}`, `rs1 ${regText(d.rs1)}`, `shift = bits 13:10 = ${d.imm}`);
      break;
    case 'S': case 'B':
      parts.push(`op ${bin(op, 4)} = ${s.name.toUpperCase()}, S/B-format: no rd, its bits 6:4 are imm[2:0]`, `rs1 ${regText(d.rs1)}`, `rs2 ${regText(d.rs2)}`,
        `imm = {bits 15:13, bits 6:4} = {${bin((w >> 13) & 7, 3)}, ${bin((w >> 4) & 7, 3)}} = ${signed(bin(d.imm & 63, 6), d.imm)}`);
      break;
    case 'J':
      parts.push('op 1100 = JAL, J-format', `rd ${regText(d.rd)}`, `imm = bits 15:7 = ${signed(bin(d.imm & 511, 9), d.imm)} words`);
      break;
    case 'U': {
      const k = d.imm >> 6;
      parts.push(`op ${bin(op, 4)}: bits 2:0 = 111 is LUI, bit 3 is imm[0]`, `rd ${regText(d.rd)}`, `imm10 = {bits 15:7, bit 3} = ${bin(k, 10)} = ${k}, loaded as ${k} × 64 = 0x${hex(d.imm, 16)}`);
      break;
    }
    default:
      break;
  }
  return `${cut}. ${parts.join('; ')}. <code>${grp(bin(w, 16))}</code> = 0x${hex(w, 16)} = <code>${disasm16(w)}</code>.`;
}

/** What differs between a decoded answer and the word asked about, named by field (null: the same instruction). */
function decodeDiff(got: number, want: number): string | null {
  if (decodeSame(got, want)) return null;
  const a = decode16(got), b = decode16(want);
  if (!a.spec || a.spec !== b.spec) return 'a different instruction: read op (bits 3:0) first, then f3 or the shift type';
  const f = b.spec!.fmt, out: string[] = [];
  if (!['S', 'B'].includes(f) && a.rd !== b.rd) out.push('rd');
  if (!['U', 'J'].includes(f) && a.rs1 !== b.rs1) out.push('rs1');
  if (['R', 'S', 'B'].includes(f) && a.rs2 !== b.rs2) out.push('rs2');
  if (f !== 'R' && a.imm !== b.imm) out.push(f === 'SH' ? 'the shift amount' : 'the immediate');
  if (!out.length) return 'a different instruction';
  return `the right instruction, but ${out.join(' and ')} ${out.length > 1 ? 'differ' : 'differs'}`;
}

/** Which of the target word's fields a wrong encoding got wrong. */
function encodeDiff(got: number, want: number): string {
  let at = 15;
  const wrong = fieldCut(want).filter(([bits]) => {
    const hi = at, lo = (at -= bits.length) + 1;
    const m = ((1 << (hi - lo + 1)) - 1) << lo;
    return (got & m) !== (want & m);
  }).map(([, l]) => l);
  return `wrong in ${wrong.join(', ')}`;
}

const isa16: Drill = {
  id: 'isa16', title: 'Encode and decode', goal: 6,
  how: 'Encode: give the 16-bit word in hex. Decode: write the instruction (zero ra sp a0 a1 a2 t0 t1, or x0–x7; immediates in decimal; a branch or jal offset as a number of words). Fields: op [3:0], rd [6:4], rs1 [9:7], rs2 [12:10], f3 [15:13]; S and B put imm[5:3] in 15:13 and imm[2:0] in 6:4.',
  make(r) {
    const text = randomInstr16(r);
    const a = assemble16(text);
    const w = a.words[0];
    if (r() < 0.5) {
      const hexOk = numAnswer(w, 16);
      return {
        prompt: `Encode <code>${text}</code> as a 16-bit word (hex).`, placeholder: '0x....', answer: `0x${hex(w, 16)}`, explain: explain16(w),
        check: (t) => {
          const c = hexOk(t);
          if (c.ok || c.why !== 'not that value') return c;
          const v = parseNum(/^0x/i.test(t.trim()) ? t.trim().replace(/[_\s]/g, '') : `0x${t.trim().replace(/[_\s]/g, '')}`);
          return { ok: false, why: v === null || v < 0 || v > 0xffff ? 'a 16-bit word: four hex digits' : encodeDiff(v, w) };
        },
      };
    }
    return {
      prompt: `Decode <code>0x${hex(w, 16)}</code> (${grp(bin(w, 16))}).`, placeholder: 'add a0, a1, a2',
      check: (t) => {
        const b = assemble16(t);
        if (b.errors.length) return { ok: false, why: b.errors[0].message };
        if (b.words.length !== 1) return { ok: false, why: 'one instruction, not a pseudo-instruction that expands to several' };
        const why = decodeDiff(b.words[0], w);
        return why ? { ok: false, why } : { ok: true };
      },
      answer: disasm16(w), explain: explain16(w),
    };
  },
};

/** Same instruction, ignoring fields the format does not use. */
export function decodeSame(x: number, y: number): boolean {
  const a = decode16(x), b = decode16(y);
  if (!a.spec || a.spec !== b.spec) return false;
  const f = a.spec.fmt;
  return a.imm === b.imm && (f === 'S' || f === 'B' || a.rd === b.rd) && (f === 'U' || f === 'J' || a.rs1 === b.rs1)
    && (!['R', 'S', 'B'].includes(f) || a.rs2 === b.rs2);
}

// ---- floating point (binary16) -------------------------------------------------------------------

/** binary16 bits of a value exactly representable as a normal number (or 0). */
function f16bits(v: number): number {
  if (v === 0) return Object.is(v, -0) ? 0x8000 : 0;
  const s = v < 0 ? 1 : 0;
  let a = Math.abs(v), e = 0;
  while (a >= 2) { a /= 2; e++; }
  while (a < 1) { a *= 2; e--; }
  return (s << 15) | ((e + 15) << 10) | Math.round((a - 1) * 1024);
}
const f16value = (w: number): number => {
  const s = w >> 15 ? -1 : 1, e = (w >> 10) & 31, m = w & 1023;
  if (e === 31) return m ? NaN : s * Infinity;
  return e ? s * (1 + m / 1024) * 2 ** (e - 15) : s * (m / 1024) * 2 ** -14;
};

const KIND_WORDS: Record<string, string[]> = {
  zero: ['zero', '0', '+0', '-0', '−0'], subnormal: ['subnormal', 'denormal', 'denormalized'], normal: ['normal'],
  infinity: ['infinity', 'inf', '+inf', '-inf', '∞', '+∞', '−∞', 'infinite'], NaN: ['nan', 'not a number'],
};

/** A pattern of the asked kind (zero, subnormal, normal, infinity, NaN). */
function f16of(r: () => number, kind: string): number {
  const s = r() < 0.5 ? 0x8000 : 0;
  if (kind === 'zero') return s;
  if (kind === 'subnormal') return s | int(r, 1, 1023);
  if (kind === 'infinity') return s | 0x7c00;
  if (kind === 'NaN') return s | 0x7c00 | int(r, 1, 1023);
  return s | (int(r, 1, 30) << 10) | int(r, 0, 1023);
}

/** Round 1.m|x × 2^e (m: 10 bits kept, x: 3 more bits) to binary16, nearest even. */
function roundQuestion(r: () => number): Question {
  const e = int(r, -4, 6), sg = r() < 0.3 ? 1 : 0;
  let m = int(r, 0, 1023);
  if (r() < 0.2) m = 1023; // the carry into the exponent
  const x = r() < 0.35 ? 4 : int(r, 1, 7); // 4 = exactly halfway: a tie
  const g = x >> 2, st = x & 3 ? 1 : 0, up = g && (st || m & 1) ? 1 : 0;
  const m2 = m + up, e2 = m2 === 1024 ? e + 1 : e;
  const w = (sg << 15) | ((e2 + 15) << 10) | (m2 & 1023);
  return {
    prompt: `Round <b>${sg ? '−' : ''}1.${bin(m, 10)}<u>${bin(x, 3)}</u>₂ × 2^${e}</b> to binary16, to nearest even (hex). The underlined bits do not fit.`,
    placeholder: '0x....', check: numAnswer(w, 16), answer: `0x${hex(w, 16)}`,
    explain: `Guard bit G = ${g}, sticky S = OR of the rest = ${st}, last kept bit = ${m & 1}: ${up ? `round up${g && !st ? ' (a tie, to the even neighbour)' : ''}` : g && !st ? 'a tie, the kept bits are already even: keep' : 'keep'}.${m2 === 1024 ? ' 1.111…1 + 1 carries: the fraction becomes 0 and the exponent goes up.' : ''} Sign ${sg}, exponent ${e2} + 15 = ${e2 + 15}, fraction ${bin(m2 & 1023, 10)}.`,
  };
}

const float: Drill = {
  id: 'float', title: 'binary16', goal: 6,
  how: 'binary16: 1 sign bit, 5 exponent bits (bias 15), 10 fraction bits with a hidden leading 1. Exponent field 0: zero or a subnormal (no hidden bit); all 1s: infinity (fraction 0) or NaN. Give values in decimal (fractions like 0.375 are fine), patterns in hex, kinds in words.',
  make(r) {
    const q = r();
    if (q < 0.2) {
      const kind = ['zero', 'subnormal', 'normal', 'infinity', 'NaN'][int(r, 0, 4)];
      const w = f16of(r, kind);
      const e = (w >> 10) & 31, m = w & 1023;
      return {
        prompt: `What is the binary16 pattern <code>0x${hex(w, 16)}</code>: zero, subnormal, normal, infinity or NaN?`, placeholder: 'normal',
        check: (t) => {
          const a = t.trim().toLowerCase();
          const k = Object.keys(KIND_WORDS).find((x) => KIND_WORDS[x].includes(a));
          return k ? { ok: k === kind, why: k === kind ? undefined : 'not that kind' } : { ok: false, why: 'answer zero, subnormal, normal, infinity or NaN' };
        },
        answer: kind, explain: `exponent field ${bin(e, 5)}, fraction ${m ? 'not ' : ''}0: ${kind}.`,
      };
    }
    if (q < 0.45) return roundQuestion(r);
    const e = int(r, -4, 6), m = int(r, 0, 7) * 128, s = r() < 0.3 ? -1 : 1;
    const v = s * (1 + m / 1024) * 2 ** e;
    const w = f16bits(v);
    if (r() < 0.5) {
      return {
        prompt: `Encode <b>${v}</b> as binary16 (hex).`, placeholder: '0x....', check: numAnswer(w, 16), answer: `0x${hex(w, 16)}`,
        explain: `${v} = ${s < 0 ? '−' : ''}1.${(m / 1024).toString(2).slice(2) || '0'}₂ × 2^${e}: sign ${s < 0 ? 1 : 0}, exponent ${e} + 15 = ${e + 15}, fraction ${bin(m, 10)}.`,
      };
    }
    return {
      prompt: `What value does the binary16 pattern <code>0x${hex(w, 16)}</code> hold?`, placeholder: '1.5',
      check: (t) => { const x = Number(t.trim()); return { ok: Number.isFinite(x) && x === f16value(w), why: Number.isFinite(x) ? 'not that value' : 'write a decimal number' }; },
      answer: String(f16value(w)), explain: `sign ${w >> 15}, exponent ${(w >> 10) & 31} − 15 = ${((w >> 10) & 31) - 15}, fraction 1.${bin(w & 1023, 10)}₂.`,
    };
  },
};

// ---- quantities, yes / no, figures ----------------------------------------------------------------

const PREFIX: Record<string, number> = { '': 1, m: 1e-3, 'µ': 1e-6, u: 1e-6, k: 1e3 };

/** A number with an optional unit, in `unit`: a bare number is taken in `unit`, a prefixed base unit converts
 *  (1440 mW = 1.44 W, 0.0082 s = 8.2 ms). Null when it is not a quantity of that kind. */
export function parseQty(s: string, unit: 'V' | 'ms' | 'W'): number | null {
  const t = s.trim().replace(/−/g, '-').replace(/\s+/g, '').replace(/,/g, '.');
  const m = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-zµ]*)$/i);
  if (!m) return null;
  const x = Number(m[1]), u = m[2].toLowerCase();
  if (!u) return x;
  const base = unit === 'ms' ? 's' : unit.toLowerCase();
  if (!u.endsWith(base)) return null;
  const f = PREFIX[u.slice(0, -base.length)];
  if (f === undefined) return null;
  return unit === 'ms' ? (x * f) / 1e-3 : x * f;
}

/** Within `tol` of `want` (absolute, or relative when `rel`); `signed`: say so when only the sign is wrong. */
function qtyAnswer(want: number, unit: 'V' | 'ms' | 'W', tol: number, rel = false, signed = false): Question['check'] {
  return (a) => {
    const x = parseQty(a, unit);
    if (x === null) return { ok: false, why: `write a number (in ${unit})` };
    const lim = (rel ? tol * Math.abs(want) : tol) + 1e-9;
    if (Math.abs(x - want) <= lim) return { ok: true };
    if (signed && Math.abs(-x - want) <= lim) return { ok: false, why: 'the right size, the wrong sign' };
    return { ok: false, why: `not within ${rel ? `${tol * 100} %` : `${tol} ${unit}`} of the model` };
  };
}

function yesNo(want: boolean): Question['check'] {
  return (t) => {
    const y = /^\s*(y|yes|1|true|closed)\s*$/i.test(t), n = /^\s*(n|no|0|false|open)\s*$/i.test(t);
    return { ok: (y && want) || (n && !want), why: y || n ? 'no' : 'yes or no' };
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (x: number) => x.toFixed(1), f2 = (x: number) => x.toFixed(2);
/** A polyline's points in integer pixels, the inner points of flat runs dropped (keeps a figure small). */
function pts(p: [number, number][]): string {
  const q = p.map(([x, y]) => [Math.round(x), Math.round(y)] as const);
  return q.filter((c, i) => i === 0 || i === q.length - 1 || q[i - 1][1] !== c[1] || q[i + 1][1] !== c[1])
    .map(([x, y]) => `${x},${y}`).join(' ');
}
const svgOpen = (w: number, h: number, label: string) =>
  `<svg class="cp-fig" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">`;
const txt = (x: number, y: number, s: string, cls = 'tk', anchor = 'middle') =>
  `<text x="${Math.round(x)}" y="${Math.round(y)}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
const ln = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
  `<line x1="${Math.round(x1)}" y1="${Math.round(y1)}" x2="${Math.round(x2)}" y2="${Math.round(y2)}" class="${cls}"/>`;

/** Grid lines gathered into one path per class (a line element each would double a figure's size). */
class Grid {
  private d: Record<string, string> = {};
  v(x: number, y0: number, y1: number, cls: string): void { this.d[cls] = `${this.d[cls] ?? ''}M${Math.round(x)} ${Math.round(y0)}V${Math.round(y1)}`; }
  h(y: number, x0: number, x1: number, cls: string): void { this.d[cls] = `${this.d[cls] ?? ''}M${Math.round(x0)} ${Math.round(y)}H${Math.round(x1)}`; }
  svg(): string { return Object.entries(this.d).map(([c, d]) => `<path d="${d}" class="${c}"/>`).join(''); }
}

// ---- the relay (Act P) ------------------------------------------------------------------------------

/** A relay to ask about: the chapter's, or one with another coil or spring (so the numbers are not learnt by heart). */
interface RelayCase { p: RelayParams; what: string }

function relayCase(r: () => number): RelayCase {
  const k = r();
  if (k < 0.5) return { p: RELAY, what: 'The chapter\'s relay' };
  if (k < 0.75) {
    const Rc = [300, 500, 600][int(r, 0, 2)];
    return { p: { ...RELAY, Rc }, what: `The relay rewound with ${Rc < RELAY.Rc ? 'thicker' : 'thinner'} wire (${RELAY.N} turns, ${Rc} Ω instead of ${RELAY.Rc} Ω)` };
  }
  const F0 = [0.8, 1.2][int(r, 0, 1)];
  return { p: { ...RELAY, F0 }, what: `The relay with its return spring preloaded to ${F0} N instead of ${RELAY.F0} N` };
}

const staticCache = new Map<string, { pull: number; drop: number }>();
/** relayStatic, rounded to its 10 mV grid. */
export function relayThresholds(p: RelayParams): { pull: number; drop: number } {
  const key = `${p.Rc}|${p.F0}|${p.N}`;
  let v = staticCache.get(key);
  if (!v) {
    const s = relayStatic(p);
    if (s.pull === null || s.drop === null) throw new Error('relay drill: no thresholds');
    v = { pull: Math.round(s.pull * 100) / 100, drop: Math.round(s.drop * 100) / 100 };
    staticCache.set(key, v);
  }
  return v;
}

const runCache = new Map<string, RelayRun>();
function relayRun(V: number, p: RelayParams): RelayRun {
  const key = `${V}|${p.Rc}|${p.F0}|${p.e}|${p.Rq}`;
  let run = runCache.get(key);
  if (!run) { run = relaySim(V, p); runCache.set(key, run); }
  return run;
}

/** The settled pull at the open and the closed gap against supply voltage, with the spring's force at each end. */
function pullChart(p: RelayParams, vmax: number): string {
  const W = 340, H = 164, X0 = 34, X1 = 326, Y0 = 142, Y1 = 28, FMAX = 3;
  const x = (V: number) => X0 + (V / vmax) * (X1 - X0), y = (F: number) => Y0 - (F / FMAX) * (Y0 - Y1);
  const g = new Grid();
  let t = '';
  for (let V = 0; V <= vmax; V++) {
    g.v(x(V), Y1, Y0, V % 5 ? 'gr' : 'gr2');
    if (V % 5 === 0) t += txt(x(V), Y0 + 12, `${V}${V === vmax ? ' V' : ''}`);
  }
  for (let F = 0; F <= FMAX; F += 0.5) {
    const whole = Number.isInteger(F);
    g.h(y(F), X0, X1, whole ? 'gr2' : 'gr');
    if (whole) t += txt(X0 - 4, y(F) + 3, `${F}${F === FMAX ? ' N' : ''}`, 'tk', 'end');
  }
  let o = svgOpen(W, H, 'Magnet pull and spring force against supply voltage') + g.svg() + t;
  const curve = (gap: number) => {
    const c: [number, number][] = [];
    for (let k = 0; k <= 120; k++) {
      const V = (vmax * k) / 120, F = relayPull(V, gap, p);
      c.push([x(V), y(Math.min(F, FMAX))]);
      if (F >= FMAX) break;
    }
    return c;
  };
  const open = curve(0), closed = curve(p.travel), held = p.F0 + p.k * p.travel;
  o += ln(X0, y(p.F0), X1, y(p.F0), 'c1 dash') + ln(X0, y(held), X1, y(held), 'c2 dash');
  o += `<polyline points="${pts(open)}" class="c1"/><polyline points="${pts(closed)}" class="c2"/>`;
  // A legend, not labels on the curves: each pull shares its colour with the spring force it must beat.
  o += txt(X0, 10, '— pull, armature out', 'lb1', 'start') + txt(X0 + 122, 10, `- - preload ${f2(p.F0)} N`, 'lb1', 'start');
  o += txt(X0, 22, '— pull, armature in', 'lb2', 'start') + txt(X0 + 122, 22, `- - spring at the stop ${f2(held)} N`, 'lb2', 'start');
  return `${o}</svg>`;
}

/** A run between absolute times t0 and t1: coil current, armature travel and the make contact, against time after `zero`. */
function runChart(run: RelayRun, t0: number, t1: number, zero: number, after: string): string {
  const W = 340, H = 170, X0 = 34, X1 = 302, Y0 = 108, Y1 = 22, CY0 = 134, CY1 = 120;
  const x = (t: number) => X0 + ((t - t0) / (t1 - t0)) * (X1 - X0);
  const win = run.s.filter((q) => q.t >= t0 - 1e-9 && q.t <= t1 + 1e-9);
  const imax = Math.max(10, Math.ceil((Math.max(...win.map((q) => q.i)) * 1e3 * 1.08) / 10) * 10);
  const yI = (mA: number) => Y0 - (mA / imax) * (Y0 - Y1), yX = (mm: number) => Y0 - (mm / 0.8) * (Y0 - Y1);
  const g = new Grid();
  let o = txt(X0, 10, '— coil current (mA)', 'lb1', 'start') + txt(X0 + 120, 10, '— armature (mm)', 'lb2', 'start') + txt(X0 + 214, 10, '— contact', 'lb3', 'start');
  const k0 = Math.ceil((t0 - zero) * 1e3 - 1e-9), k1 = Math.floor((t1 - zero) * 1e3 + 1e-9), every = k1 - k0 > 12 ? 2 : 1;
  for (let k = k0; k <= k1; k++) {
    const X = x(zero + k / 1e3);
    g.v(X, Y1, CY0, k === 0 ? 'ax' : k % (2 * every) ? 'gr' : 'gr2');
    if (k % every === 0) o += txt(X, CY0 + 12, String(k));
  }
  o += txt(X1, CY0 + 26, `ms ${after}`, 'tk', 'end');
  const step = imax > 60 ? 20 : 10;
  for (let mA = 0; mA <= imax; mA += step) {
    g.h(yI(mA), X0, X1, 'gr');
    o += txt(X0 - 4, yI(mA) + 3, String(mA), 'tk', 'end');
  }
  for (const mm of [0, 0.4, 0.8]) o += txt(X1 + 4, yX(mm) + 3, String(mm), 'tk', 'start');
  o = svgOpen(W, H, `Coil current, armature travel and contact against time ${after}`) + g.svg() + o;
  // Current and travel are smooth: at most ~75 points each keeps the figure near 3 kB.
  const stride = Math.max(1, Math.ceil(win.length / 75)), cs = win.filter((_, j) => j % stride === 0 || j === win.length - 1);
  o += `<polyline points="${pts(cs.map((q) => [x(q.t), yI(q.i * 1e3)]))}" class="c1"/>`;
  o += `<polyline points="${pts(cs.map((q) => [x(q.t), yX(q.x * 1e3)]))}" class="c2"/>`;
  // The contact from its exact events (a bounce can be shorter than a sample).
  let on = run.ev.filter((e) => e.t < t0).at(-1)?.closed ?? false;
  const cp: [number, number][] = [[x(t0), on ? CY1 : CY0]];
  for (const e of run.ev) if (e.t >= t0 && e.t <= t1) { cp.push([x(e.t), on ? CY1 : CY0], [x(e.t), e.closed ? CY1 : CY0]); on = e.closed; }
  cp.push([x(t1), on ? CY1 : CY0]);
  o += `<polyline points="${cp.map(([a, b]) => `${f1(a)},${b}`).join(' ')}" class="c3"/>`;
  o += txt(X1 + 4, CY1 + 3, 'closed', 'tk', 'start') + txt(X1 + 4, CY0 + 3, 'open', 'tk', 'start');
  return `${o}</svg>`;
}

/** The shortest opening of the make contact while the coil is on (s): one under ~60 µs is not readable on a chart. */
function shortestOpen(run: RelayRun): number {
  const on = run.ev.filter((e) => e.t < T_OFF);
  let m = Infinity;
  for (let k = 1; k < on.length; k++) if (on[k].closed) m = Math.min(m, on[k].t - on[k - 1].t);
  return m;
}

const relay: Drill = {
  id: 'relay', title: 'Pull-in and drop-out', goal: 6,
  how: 'Read the numbers off the model\'s curves. Voltages in V within ±0.3 V (hysteresis ±0.5 V), times in ms within ±0.3 ms, power and the turn-off spike within ±2 %; bounces exact; yes or no. A unit is optional (1440 mW and 0.0082 s are read as such).',
  make(r) {
    const k = r();
    if (k < 0.45) {
      const c = relayCase(r), { pull, drop } = relayThresholds(c.p), held = c.p.F0 + c.p.k * c.p.travel;
      const why = `Released, the armature is out: the pull at the full gap must beat the preload (${f2(c.p.F0)} N), first at <b>${f2(pull)} V</b>. Operated, the gap is closed and the pull (∝ (N·I)² / gap², saturating) far larger: it holds the stretched spring (${f2(held)} N) down to <b>${f2(drop)} V</b>.`;
      if (k < 0.31) {
        const which = k < 0.12 ? 'pull' : k < 0.24 ? 'drop' : 'hyst';
        const want = which === 'pull' ? pull : which === 'drop' ? drop : pull - drop;
        const ask = which === 'pull' ? 'the <b>pull-in</b> voltage, the lowest supply that closes a released relay (V)'
          : which === 'drop' ? 'the <b>drop-out</b> voltage, below which an operated relay lets go (V)'
            : 'the <b>hysteresis</b>, pull-in minus drop-out (V)';
        return {
          prompt: `${c.what}: settled magnet pull and spring force against supply voltage. Read ${ask}.<br>${pullChart(c.p, 5 * Math.ceil((pull + 2) / 5))}`,
          placeholder: which === 'hyst' ? 'V (±0.5)' : 'V (±0.3)', check: qtyAnswer(want, 'V', which === 'hyst' ? 0.5 : 0.3), answer: `${f2(want)} V`,
          explain: `${why}${which === 'hyst' ? ` ${f2(pull)} − ${f2(drop)} = ${f2(pull - drop)} V: a Schmitt trigger made of iron, so a noisy coil line does not chatter.` : ''}`,
        };
      }
      const operated = r() < 0.5, lo = Math.max(0.5, drop - 2);
      let V = 0;
      do V = Math.round((r() < 0.5 ? drop + r() * (pull - drop) : lo + r() * (pull + 6 - lo)) * 2) / 2;
      while (Math.abs(V - pull) < 0.4 || Math.abs(V - drop) < 0.4);
      const closed = operated ? V > drop : V >= pull;
      return {
        prompt: `${c.what}, <b>${operated ? 'operated' : 'released'}</b>, its supply set to <b>${V} V</b> and left until the coil current settles. Is the make contact closed? (yes / no)<br>${pullChart(c.p, 5 * Math.ceil(Math.max(pull + 2, V + 1) / 5))}`,
        placeholder: 'yes / no', check: yesNo(closed), answer: closed ? 'yes' : 'no',
        explain: `${operated ? `Operated: it stays in above the drop-out, ${f2(drop)} V.` : `Released: it pulls in only from the pull-in, ${f2(pull)} V, up.`}${V > drop && V < pull ? ` Between ${f2(drop)} and ${f2(pull)} V the answer depends on where the armature already is.` : ''} ${why}`,
      };
    }
    if (k < 0.85) {
      const which = k < 0.55 ? 'touch' : k < 0.65 ? 'settled' : k < 0.75 ? 'bounces' : 'release';
      for (;;) {
        const V = int(r, 18, 28);
        const e = which === 'settled' || which === 'bounces' ? [0.4, 0.5, 0.55, 0.6, 0.7][int(r, 0, 4)] : RELAY.e;
        const Rq = which === 'release' ? [1000, 2000, 4000, 8000][int(r, 0, 3)] : RELAY.Rq;
        const p = { ...RELAY, e, Rq }, run = relayRun(V, p), s = relaySummary(run, p);
        if (s.firstTouch === null || s.settled === null || s.release === null || shortestOpen(run) < 60e-6) continue;
        const ms = (t: number) => t * 1e3;
        const what = `The chapter's relay${e !== RELAY.e ? ` with contacts of restitution e = ${e}` : ''}${Rq !== RELAY.Rq ? ` and a ${Rq} Ω quench resistor` : ''}, switched on at <b>${V} V</b>`;
        if (which === 'release') {
          return {
            prompt: `${what}, then off. How long after switch-off does the make contact open (ms)?<br>${runChart(run, T_OFF - 1e-3, T_OFF + s.release + 1.5e-3, T_OFF, 'after switch-off')}`,
            placeholder: 'ms (±0.3)', check: qtyAnswer(ms(s.release), 'ms', 0.3), answer: `${f1(ms(s.release))} ms`,
            explain: `The current decays through coil and quench resistor, τ = L / (${RELAY.Rc} + ${Rq}) Ω, and the armature lets go once the pull falls below the stretched spring: ${f2(ms(s.release))} ms. A larger quench resistor releases faster but spikes higher (−${Rq} Ω × the current).`,
          };
        }
        const chart = runChart(run, T_ON, T_ON + s.settled + 1.5e-3, T_ON, 'after switch-on');
        if (which === 'touch') {
          return {
            prompt: `${what}. How long after switch-on does the make contact first touch (ms)?<br>${chart}`,
            placeholder: 'ms (±0.3)', check: qtyAnswer(ms(s.firstTouch), 'ms', 0.3), answer: `${f1(ms(s.firstTouch))} ms`,
            explain: `The current climbs with τ = L / R until the pull beats the preload; then the armature moves, the gap shrinks, L rises and the current dips. First touch at ${f2(ms(s.firstTouch))} ms: a higher supply reaches the pull-in current sooner on the same exponential.`,
          };
        }
        if (which === 'settled') {
          return {
            prompt: `${what}. When does the make contact close for good, its last bounce over (ms after switch-on)?<br>${chart}`,
            placeholder: 'ms (±0.3)', check: qtyAnswer(ms(s.settled), 'ms', 0.3), answer: `${f1(ms(s.settled))} ms`,
            explain: `First touch at ${f2(ms(s.firstTouch))} ms, ${s.bounces} bounce${s.bounces === 1 ? '' : 's'}, at rest from ${f2(ms(s.settled))} ms. The simulator's relay step (${RELAY_STEP_MS} ms) is this time for the chapter's relay at ${RELAY_SUPPLY} V: nothing may read the contact earlier.`,
          };
        }
        return {
          prompt: `${what}. How many times does the make contact open again after its first touch while the coil is on (bounces)?<br>${chart}`,
          placeholder: 'a count', answer: String(s.bounces),
          check: (t) => { const n = parseNum(t); return n === null ? { ok: false, why: 'a count' } : { ok: n === s.bounces, why: 'count the dips of the contact trace' }; },
          explain: `${s.bounces} opening${s.bounces === 1 ? '' : 's'} between ${f2(ms(s.firstTouch))} and ${f2(ms(s.settled))} ms. Each impact keeps e = ${e} of the blade's speed: livelier contacts (larger e) bounce more and longer.`,
        };
      }
    }
    if (k < 0.92) {
      const Rc = [300, 400, 400, 500, 600][int(r, 0, 4)], V = [12, 24, 24, 36, 48][int(r, 0, 4)];
      const p = { ...RELAY, Rc }, P = relaySummary(relayRun(V, p), p).power;
      return {
        prompt: `A ${Rc} Ω relay coil on <b>${V} V</b>, operated. What power does it draw (W)?`,
        placeholder: 'W (±2 %)', check: qtyAnswer(P, 'W', 0.02, true), answer: `${P.toPrecision(3)} W`,
        explain: `P = V² / R = ${V}² / ${Rc} = ${P.toPrecision(3)} W, all of it heat, for as long as the relay holds. ${Z3.relays} of them: ${((P * Z3.relays) / 1e3).toPrecision(2)} kW (the Z3 drew about ${Z3.power / 1e3} kW).`,
      };
    }
    const V = int(r, 18, 28), Rq = [1000, 2000, 4000, 8000][int(r, 0, 3)];
    const p = { ...RELAY, Rq }, run = relayRun(V, p), s = relaySummary(run, p);
    const iOff = run.s.find((q) => Math.abs(q.t - T_OFF) < 1e-9)!.i;
    return {
      prompt: `The chapter's relay on <b>${V} V</b> carries ${f2(iOff * 1e3)} mA when its supply is cut; a <b>${Rq} Ω</b> quench resistor across the coil takes the current. The coil terminal voltage just after switch-off (V)?`,
      placeholder: 'V (±2 %)', check: qtyAnswer(s.spike, 'V', 0.02, true, true), answer: `${s.spike.toPrecision(3)} V`,
      explain: `The inductance keeps the current flowing the same way, now through the resistor: v = −Rq·i = −${Rq} Ω × ${f2(iOff * 1e3)} mA = ${s.spike.toFixed(1)} V. Without a path the contact that cut the coil would arc. A larger Rq releases faster (τ = L / (Rc + Rq)), and the spike grows with it.`,
    };
  },
};

// ---- punched cards (Act P) ------------------------------------------------------------------------------

/** Columns of a card (12 rows each), holes filled; optional column numbers above. */
function cardFig(cols: readonly number[], numbers: boolean): string {
  const P = 14, R = 11, L = 24, T = numbers ? 16 : 6, W = L + cols.length * P + 6, H = T + 12 * R + 6;
  let o = svgOpen(W, H, `${cols.length} card column${cols.length === 1 ? '' : 's'}, rows 12 to 9`);
  o += `<path d="M ${L + 2} ${T - 4} H ${W - 1} V ${H - 1} H ${L - 4} V ${T + 2} Z" class="pc"/>`;
  ROWS.forEach((name, i) => {
    o += txt(L - 8, T + i * R + R / 2 + 3, name, 'tk', 'end');
    o += ln(L, T + i * R + R / 2, L + cols.length * P, T + i * R + R / 2, 'pg');
  });
  cols.forEach((m, c) => {
    if (numbers) o += txt(L + c * P + P / 2, T - 7, String(c + 1));
    for (let i = 0; i < 12; i++) if (m & (1 << i)) o += `<rect x="${L + c * P + P / 2 - 3}" y="${T + i * R + 1.5}" width="6" height="8" class="ph"/>`;
  });
  return `${o}</svg>`;
}

/** Why a column says what it says. */
function codeWhy(ch: string): string {
  const rows = rowsOfChar(ch)!;
  if (/[0-9]/.test(ch)) return `${ch}: a digit is one hole, in its own row.`;
  if (/[A-I]/.test(ch)) return `${ch} = ${rows}: zone 12 with the digits 1–9 is A–I.`;
  if (/[J-R]/.test(ch)) return `${ch} = ${rows}: zone 11 with 1–9 is J–R.`;
  if (/[S-Z]/.test(ch)) return `${ch} = ${rows}: zone 0 with 2–9 is S–Z (0-1 is the slash).`;
  return `${esc(ch)} = ${rows}: ${rows.includes('8') ? 'a sign is a zone (or none), a digit and the 8 row.' : rows.includes('-') ? 'a zone and a digit that no letter uses.' : 'a zone alone.'}`;
}

/** Characters a learner can type (¢ and ¬ are on no keyboard; a blank column makes no question). */
const TYPEABLE = CHARSET.filter((c) => c !== ' ' && c !== '¢' && c !== '¬');
/** Short source-card texts (a blank column is a space). */
export const CARD_WORDS = ['READ', 'PUNCH', 'STOP', 'CALL', 'END', 'GOTO', 'IF(X)', 'X=Y+1', 'A*B', 'I=1,9', 'SUM', 'LOAD', 'HALT', 'JUMP', 'Z3', 'IBM', '$1.50', 'N-1', 'A/B', 'DO 10'];

function pickChar(r: () => number): string {
  const u = r();
  const pool = TYPEABLE.filter(u < 0.6 ? (c) => /[A-Z]/.test(c) : u < 0.8 ? (c) => /[0-9]/.test(c) : (c) => !/[A-Z0-9]/.test(c));
  return pool[int(r, 0, pool.length - 1)];
}

const hollerith: Drill = {
  id: 'hollerith', title: 'Read a card', goal: 6,
  how: 'Rows from the top: zones 12, 11, 0, then digits 1–9. Characters as typed (case does not matter). Rows as <code>12-3-8</code> (any order; spaces or commas work too). Object cards: the word in row 9, column 1 its most significant bit; values in hex, columns as numbers (<code>1 4 7</code>).',
  make(r) {
    const k = r();
    if (k < 0.25) {
      const ch = pickChar(r), m = punchOf(ch)!;
      return {
        prompt: `What character does this column hold?<br>${cardFig([m], false)}`, placeholder: 'A', answer: ch, explain: codeWhy(ch),
        check: (t) => {
          const a = t.trim().toUpperCase();
          if (a.length !== 1) return { ok: false, why: 'one character' };
          const rows = rowsOfChar(a);
          return { ok: a === ch, why: rows === null ? 'not a character the 029 punches' : `${esc(a)} is ${rows || 'a blank column'}` };
        },
      };
    }
    if (k < 0.5) {
      const ch = pickChar(r), m = punchOf(ch)!;
      return {
        prompt: `Which rows does the 029 punch for <code>${esc(ch)}</code>?`, placeholder: '12-3-8', answer: rowsOf(m), explain: codeWhy(ch),
        check: (t) => {
          const toks = t.trim().split(/[\s,;\-–/+]+/).filter(Boolean);
          if (!toks.length) return { ok: false, why: 'rows, like 12-3' };
          let a = 0;
          for (const x of toks) {
            const i = (ROWS as readonly string[]).indexOf(x);
            if (i < 0) return { ok: false, why: `there is no row ${esc(x)} (rows: 12, 11, 0–9)` };
            a |= 1 << i;
          }
          const c = charOf(a);
          return { ok: a === m, why: c === null ? 'no character has those holes' : `those holes are ${c === ' ' ? 'a blank' : esc(c)}` };
        },
      };
    }
    if (k < 0.7) {
      const word = CARD_WORDS[int(r, 0, CARD_WORDS.length - 1)];
      const cols = textCard(word).cols.slice(0, word.length);
      return {
        prompt: `Columns 1–${word.length} of a source card: what was punched?<br>${cardFig(cols, true)}`, placeholder: 'READ', answer: word,
        explain: `${[...word].map((c) => (c === ' ' ? 'a blank column' : `${esc(c)} ${rowsOfChar(c)}`)).join(', ')}.`,
        check: (t) => {
          const a = t.trim().toUpperCase();
          if (a === word) return { ok: true };
          if (a.length !== word.length) return { ok: false, why: `${word.length} columns, ${word.length} characters (a blank column is a space)` };
          const i = [...a].findIndex((c, j) => c !== word[j]);
          return { ok: false, why: `column ${i + 1} is not ${esc(a[i])}` };
        },
      };
    }
    const bits = [8, 12, 16][int(r, 0, 2)], w0 = int(r, 1, 2 ** bits - 1);
    const card = objectCard(w0, '', seqText(0), bits);
    const holes = card.cols.slice(0, bits).flatMap((m, c) => (m & ROW9 ? [c + 1] : []));
    const value = wordOf(card, bits), hx = `0x${hex(value, bits)}`;
    const why = `${grp(bin(value, bits))}: column c holds bit ${bits} − c, so column 1 is the most significant bit (2^${bits - 1}) and column ${bits} the least.`;
    if (k < 0.85) {
      return {
        prompt: `The word columns of an object card (${bits} bits, row 9 only). Its value in hex?<br>${cardFig(card.cols.slice(0, bits), true)}`,
        placeholder: '0x..', check: numAnswer(value, 16), answer: hx, explain: why,
      };
    }
    return {
      prompt: `An object card holds the ${bits}-bit word <b>${hx}</b>. Which of columns 1–${bits} get a hole in row 9?<br>${cardFig(new Array<number>(bits).fill(0), true)}`,
      placeholder: '1 4 7', answer: holes.join(' '), explain: why,
      check: (t) => {
        const toks = t.trim().split(/[\s,;]+/).filter(Boolean);
        const ns = toks.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
        if (!toks.length || ns.some((n) => !(n >= 1 && n <= bits))) return { ok: false, why: `column numbers 1–${bits}` };
        const got = [...new Set(ns)].sort((a, b) => a - b);
        return { ok: got.join(' ') === holes.join(' '), why: `those holes read 0x${hex(got.reduce((w, c) => w + 2 ** (bits - c), 0), bits)}` };
      },
    };
  },
};

export const DRILLS: Record<string, Drill> = { binary, twos, kmap, boolean, isa16, float, relay, hollerith };
