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
import { decode16, disasm16, encJ, encSB, hiLo as hiLo16, OP16, REG_NAMES16 } from '../riscv/rv16/isa16';
import { testset } from './drilltest';
import { F32, flagNames, fpAddX, fpCmpX, fpDivX, fpMinMaxX, fpMulX, fpSqrtX, fpValue, parts, type FpResult } from '../sim/fpref';

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

/** A text answer must be this number written in this base (the prefix is optional; a binary answer takes only 0 and 1, a hex one only hex digits). */
function numAnswer(want: number, base: 2 | 10 | 16): Question['check'] {
  const name = base === 2 ? 'binary' : base === 16 ? 'hexadecimal' : 'decimal';
  return (a) => {
    const t = a.trim().toLowerCase().replace(/[_\s]/g, '').replace(/−/g, '-');
    let v: number | null = null;
    if (base === 2) { const m = t.match(/^(?:0b)?([01]+)$/); v = m ? parseInt(m[1], 2) : null; }
    else if (base === 16) { const m = t.match(/^(?:0x)?([0-9a-f]+)$/); v = m ? parseInt(m[1], 16) : null; }
    else v = /^-?\d+$/.test(t) ? parseInt(t, 10) : null;
    if (v === null) return { ok: false, why: `write a ${name} number` };
    return { ok: v === want, why: v === want ? undefined : 'not that value' };
  };
}

// -- octal, binary fractions, flags, shifts and the other signed forms (the last kinds of the 'binary' and 'twos' drills) --

const oct = (v: number, digits: number) => v.toString(8).padStart(digits, '0');

/** A text answer must be this number written in octal (the prefix 0o is optional). */
function octAnswer(want: number): Question['check'] {
  return (a) => {
    const m = a.trim().toLowerCase().replace(/[_\s]/g, '').match(/^(?:0o)?([0-7]+)$/);
    if (!m) return { ok: false, why: 'write an octal number (digits 0 to 7)' };
    const v = parseInt(m[1], 8);
    return { ok: v === want, why: v === want ? undefined : 'not that value' };
  };
}

/** A fraction (dyadic, so exact in a double) written in decimal (0.8125) or in binary (0.1101, prefix 0b optional). */
function fracAnswer(want: number, base: 2 | 10): Question['check'] {
  return (a) => {
    const t = a.trim().toLowerCase().replace(/[_\s]/g, '');
    let v: number | null = null;
    if (base === 2) { const m = t.match(/^(?:0b)?0?\.([01]+)$/); v = m ? parseInt(m[1], 2) / 2 ** m[1].length : null; }
    else v = /^\d*\.?\d+$/.test(t) ? parseFloat(t) : null;
    if (v === null) return { ok: false, why: base === 2 ? 'write a binary fraction such as 0.101' : 'write a decimal fraction such as 0.625' };
    return { ok: v === want, why: v === want ? undefined : 'not that value' };
  };
}

/** C and V as two digits, C first (10, 0 1, 1,1). */
function flagsAnswer(c: boolean, v: boolean): Question['check'] {
  return (a) => {
    const m = a.trim().match(/^([01])\s*[,;]?\s*([01])$/);
    if (!m) return { ok: false, why: 'two digits: C then V, such as 10' };
    const ok = m[1] === (c ? '1' : '0') && m[2] === (v ? '1' : '0');
    return { ok, why: ok ? undefined : 'not those flags' };
  };
}

/** The 'binary' drill's kinds 7 to 10: octal both ways, a binary fraction both ways. */
function binaryExtra(r: () => number, k: number): Question {
  const g3 = (n: number) => bin(n, 9).replace(/(...)(?=.)/g, '$1 ');
  if (k === 7) {
    const n = int(r, 64, 511);
    return { prompt: `Write the octal number <b>${oct(n, 3)}</b> in binary (9 bits).`, placeholder: '000 000 000', check: numAnswer(n, 2), answer: g3(n), explain: `One octal digit per three bits: ${[...oct(n, 3)].map((c) => `${c} = ${bin(parseInt(c, 8), 3)}`).join(', ')}.` };
  }
  if (k === 8) {
    const n = int(r, 64, 511);
    return { prompt: `Write <code>${g3(n)}</code> in octal.`, placeholder: '0o...', check: octAnswer(n), answer: oct(n, 3), explain: `Three bits per octal digit, from the right: ${g3(n).split(' ').map((g) => `${g} = ${parseInt(g, 2)}`).join(', ')}.` };
  }
  const len = int(r, 3, 5), n = int(r, 1, 2 ** len - 1), v = n / 2 ** len;
  if (k === 9) {
    return { prompt: `What is the binary fraction <code>0.${bin(n, len)}</code> in decimal?`, placeholder: '0.625', check: fracAnswer(v, 10), answer: String(v), explain: `The bits after the point weigh 1/2, 1/4, 1/8 …: ${[...bin(n, len)].map((b, i) => (b === '1' ? `1/${2 ** (i + 1)}` : '')).filter(Boolean).join(' + ')} = ${n}/${2 ** len} = ${v}.` };
  }
  let x = v;
  const steps: string[] = [];
  for (let i = 0; i < len; i++) { x *= 2; steps.push(`${x} → ${x >= 1 ? 1 : 0}`); if (x >= 1) x -= 1; }
  return { prompt: `Write <b>${v}</b> as a binary fraction (it is exact).`, placeholder: '0.101', check: fracAnswer(v, 2), answer: `0.${bin(n, len)}`, explain: `Double it and keep the integer bit, again and again: ${steps.join(', ')}.` };
}

/** The 'twos' drill's kinds 8 to 11: C and V of an 8-bit add, sra against div, the other signed readings. */
function twosExtra(r: () => number, k: number): Question {
  if (k === 8) {
    const a = int(r, 0, 255), b = r() < 0.5 ? int(r, 0, 255) : (a & 0x80 ? int(r, 0x80, 0xff) : int(r, 0, 0x7f));
    const s = (a + b) & 0xff, c = a + b > 255, v = ((a ^ s) & (b ^ s) & 0x80) !== 0;
    return {
      prompt: `An 8-bit add: <code>0x${hex(a, 8)}</code> + <code>0x${hex(b, 8)}</code>. What are the flags C and V (two digits, C first)?`, placeholder: 'CV, e.g. 10', check: flagsAnswer(c, v), answer: `${c ? 1 : 0}${v ? 1 : 0}`,
      explain: `The sum is ${a + b} = 0x${hex(s, 8)} after dropping the carry. C = ${c ? 1 : 0}: ${a} + ${b} ${c ? 'does not fit' : 'fits'} in 8 bits unsigned. V = ${v ? 1 : 0}: as signed, ${s8(a)} + ${s8(b)} = ${s8(a) + s8(b)} ${v ? 'is outside' : 'is inside'} −128 … 127.`,
    };
  }
  if (k === 9 || k === 10) {
    const sh = int(r, 1, 3);
    let x = -int(r, 3, 127);
    if (x % 2 ** sh === 0) x -= 1;
    const want = k === 9 ? Math.floor(x / 2 ** sh) : Math.trunc(x / 2 ** sh);
    return {
      prompt: k === 9 ? `<code>srai</code> (arithmetic shift right) of ${x} by <b>${sh}</b>: the result in decimal?` : `<code>div</code> (signed division) of ${x} by <b>${2 ** sh}</b>: the result in decimal?`,
      check: numAnswer(want, 10), answer: String(want),
      explain: k === 9 ? `A right shift copies the sign bit in and drops the low bits, which rounds toward −∞: floor(${x} / ${2 ** sh}) = ${want}.` : `div rounds toward zero: ${x} / ${2 ** sh} = ${x / 2 ** sh}, cut to ${want}. (srai by ${sh} would give ${Math.floor(x / 2 ** sh)}.)`,
    };
  }
  const v = int(r, 0x81, 0xfe), sm = r() < 0.5;
  const want = sm ? -(v & 0x7f) : -(~v & 0xff);
  return {
    prompt: `The 8-bit pattern <code>${grp(bin(v, 8))}</code> read as <b>${sm ? 'sign-magnitude' : "one's complement"}</b>: the number in decimal?`, check: numAnswer(want, 10), answer: String(want),
    explain: sm ? `The top bit is the sign (negative), the other seven bits the size: ${v & 0x7f}, so ${want}. (Two's complement would say ${s8(v)}.)` : `The top bit is set, so it is negative: invert every bit to get the size, ${grp(bin(~v & 0xff, 8))} = ${-want}, so ${want}. (Two's complement would say ${s8(v)}.)`,
  };
}

const binary: Drill = {
  id: 'binary', title: 'Binary and hex', goal: 8,
  how: 'Type the number in the base asked for (a bit as 0 or 1). Prefixes (0x, 0b, 0o) are optional; spaces are ignored. 8-bit and 16-bit words, unsigned; octal and binary fractions too.',
  make(r) {
    const k = int(r, 0, 10);
    if (k >= 7) return binaryExtra(r, k);
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
  how: 'Answer in decimal (signed), as a pattern, as the two flags (C then V), or yes / no, as asked. 8-bit two\'s complement: −128 … 127; 16-bit: −32 768 … 32 767.',
  make(r) {
    const k = int(r, 0, 11);
    if (k >= 8) return twosExtra(r, k);
    const v = int(r, 0, 255);
    if (k >= 5) {
      const w = int(r, 0, 0xffff);
      if (k === 5) {
        const x = r() < 0.7 ? w | 0x8000 : w;
        return {
          prompt: `The 16-bit pattern <code>0x${hex(x, 16)}</code> as a signed (two's-complement) number?`, check: numAnswer(s16(x), 10), answer: String(s16(x)),
          explain: `The top bit weighs −32 768: ${x & 0x8000 ? `−32 768 + ${x & 0x7fff}` : String(x)} = ${s16(x)}. As unsigned the same bits are ${x}.`,
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
        explain: `a + ¬b + 1 = a + (65 536 − b): it carries out exactly when a ≥ b as unsigned numbers. ${order} So a &lt; b unsigned ⇔ no carry out: sltu is ¬cout.`,
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
        check: (t) => { const y = /^\s*(y|yes|1|true)\s*$/i.test(t), n = /^\s*(n|no|0|false)\s*$/i.test(t); return { ok: (y && ovf) || (n && !ovf), why: y || n ? '' : 'answer yes or no' }; },
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
  how: 'Write an equivalent expression with no more literals (variable occurrences) than asked. NOT: ¬ (or \' or ~); AND: · or juxtaposition; OR: +; ⊕ is XOR (1 when its two inputs differ; ^ also works).',
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

// ---- floating point, beyond encoding: modes, spacing, special values, subnormal arithmetic ----------

const MODE_NAMES = ['RNE', 'RTZ', 'RDN', 'RUP', 'RMM'] as const;
const MODE_WORDS = ['to nearest, ties to even', 'towards zero', 'towards −∞', 'towards +∞', 'to nearest, ties away from zero (max magnitude)'];

/** x rounded to an integer in RISC-V mode rm (0 RNE, 1 RTZ, 2 RDN, 3 RUP, 4 RMM), x a multiple of ¼. */
export function roundMode(x: number, rm: number): number {
  const lo = Math.floor(x), hi = Math.ceil(x), f = x - lo;
  const nearest = f < 0.5 ? lo : f > 0.5 ? hi : rm === 0 ? (lo % 2 === 0 ? lo : hi) : (x < 0 ? lo : hi);
  const r = rm === 0 || rm === 4 ? nearest : rm === 1 ? Math.trunc(x) : rm === 2 ? lo : hi;
  return r === 0 ? 0 : r;   // no −0
}

/** Round a tie (or a quarter) to an integer under one of the five rounding modes. */
function modeQuestion(r: () => number): Question {
  const rm = int(r, 0, 4), k = int(r, -9, 9), tie = r() < 0.7;
  const x = tie ? k + 0.5 : k + [0.25, 0.75][int(r, 0, 1)];
  const want = roundMode(x, rm);
  const f = x - Math.floor(x);
  return {
    prompt: `RISC-V rounding mode <b>${MODE_NAMES[rm]}</b> (${MODE_WORDS[rm]}): convert <b>${x < 0 ? '−' : ''}${Math.abs(x)}</b> to an integer (fcvt.w.s).`,
    placeholder: '3', check: numAnswer(want, 10), answer: String(want),
    explain: `${x} lies between ${Math.floor(x)} and ${Math.ceil(x)}${f === 0.5 ? ', exactly halfway (G = 1, S = 0): a tie' : f < 0.5 ? ', nearer the lower one' : ', nearer the upper one'}. ${MODE_NAMES[rm]}: ${
      rm === 0 ? (f === 0.5 ? 'a tie goes to the even neighbour' : 'the nearer one') : rm === 1 ? 'drop the fraction, towards zero' : rm === 2 ? 'the lower one, whatever the sign' : rm === 3 ? 'the upper one, whatever the sign' : (f === 0.5 ? 'a tie goes away from zero' : 'the nearer one')} → ${want}.`,
  };
}

/** The gap between adjacent floats near x: 2^(e − M). */
function ulpQuestion(r: () => number): Question {
  const h = r() < 0.5, M = h ? 10 : 23, name = h ? 'binary16' : 'float32';
  const e0 = h ? int(r, -8, 14) : int(r, -10, 30);
  const x = +((1 + r() * 0.99) * 2 ** e0).toPrecision(3);
  const e = Math.floor(Math.log2(x)), k = e - M;
  return {
    prompt: `The gap between adjacent ${name} values near <b>${x}</b> is 2<sup>k</sup>. What is k?`, placeholder: '−13', check: numAnswer(k, 10), answer: String(k),
    explain: `${x} lies in [2^${e}, 2^${e + 1}), where ${name} has ${M} fraction bits: the gap is 2^${e} / 2^${M} = 2^${k}.`,
  };
}

/** Special results on RISC-V (float32): what is asked, the operation's result, and whether the answer is a yes / no. */
export const FLOAT_SPECIALS: [string, () => FpResult, boolean][] = (() => {
  const one = 0x3f800000, pz = 0, nz = 0x80000000, inf = 0x7f800000, qnan = 0x7fc00000;
  return [
    ['∞ − ∞', () => fpAddX(inf, inf, true, F32), false], ['0 × ∞', () => fpMulX(pz, inf, F32), false], ['0 / 0', () => fpDivX(pz, pz, F32), false],
    ['1 / −0', () => fpDivX(one, nz, F32), false], ['1 / +0', () => fpDivX(one, pz, F32), false], ['1 / ∞', () => fpDivX(one, inf, F32), false],
    ['−1 / ∞', () => fpDivX(one | 0x80000000, inf, F32), false], ['∞ + 1', () => fpAddX(inf, one, false, F32), false], ['√(−0)', () => fpSqrtX(nz, F32), false],
    ['√(−1)', () => fpSqrtX(one | 0x80000000, F32), false], ['fmin(NaN, 1)', () => fpMinMaxX(qnan, one, false, F32), false],
    ['fmax(1, NaN)', () => fpMinMaxX(one, qnan, true, F32), false], ['fmin(−0, +0)', () => fpMinMaxX(nz, pz, false, F32), false],
    ['fmax(−0, +0)', () => fpMinMaxX(nz, pz, true, F32), false], ['NaN == NaN (feq.s)', () => fpCmpX(qnan, qnan, 'eq', F32), true],
    ['NaN &lt; 1 (flt.s)', () => fpCmpX(qnan, one, 'lt', F32), true], ['+0 == −0 (feq.s)', () => fpCmpX(pz, nz, 'eq', F32), true],
  ];
})();

/** A special result as the word a learner types: NaN, ∞, −∞, +0, −0, a number, true / false. */
export function specialAnswer(res: FpResult, yesNo: boolean): string {
  if (yesNo) return res.y ? 'true' : 'false';
  const p = parts(res.y, F32);
  return p.kind === 'nan' ? 'NaN' : p.kind === 'inf' ? (p.sign ? '−∞' : '∞') : p.kind === 'zero' ? (p.sign ? '−0' : '+0') : String(fpValue(res.y, F32));
}
const canonSpecial = (t: string) => {
  const s = t.trim().toLowerCase().replace(/\s/g, '').replace(/[−–]/g, '-').replace(/infinity|inf/g, '∞').replace(/^\+∞$/, '∞');
  return s === '0' || s === '+0' ? '+0' : s === 'yes' ? 'true' : s === 'no' ? 'false' : s;
};

function specialQuestion(r: () => number): Question {
  const [what, run, yn] = FLOAT_SPECIALS[int(r, 0, FLOAT_SPECIALS.length - 1)];
  const res = run(), want = specialAnswer(res, yn);
  const fl = flagNames(res.fl);
  return {
    prompt: `On RISC-V (float32), what is <b>${what}</b>? ${yn ? 'Answer true or false.' : 'Answer NaN, ∞, −∞, +0, −0 or a number.'}`,
    placeholder: yn ? 'true' : 'NaN',
    check: (t) => { const ok = canonSpecial(t) === canonSpecial(want); return { ok, why: ok ? undefined : 'not that result' }; },
    answer: want, explain: `${what.replace('&lt;', '<')} = ${want}${fl !== '–' ? `, raising ${fl}` : ''}${want === 'NaN' ? '; every NaN an operation produces is the canonical 0x7FC00000' : ''}.`,
  };
}

/** Arithmetic on binary16 subnormals: sums of patterns (the spacing is uniform, so the patterns add), and a halving that is a tie. */
function subnormalQuestion(r: () => number): Question {
  if (r() < 0.5) {
    const a = int(r, 1, 1023), b = int(r, 1, 1023), s = a + b;
    return {
      prompt: `binary16: <code>0x${hex(a, 16)}</code> + <code>0x${hex(b, 16)}</code> (both subnormal). Give the sum's pattern (hex).`, placeholder: '0x....', check: numAnswer(s, 16), answer: `0x${hex(s, 16)}`,
      explain: `Below 2^−14 the spacing is the constant 2^−24, and so is the spacing of the first normal binade: the patterns add as integers, exactly (no rounding). ${a} + ${b} = ${s}${s >= 1024 ? ': 1024 is 0x0400, the smallest normal, so the sum carried from the fraction into the exponent field' : ''}.`,
    };
  }
  const k = int(r, 1, 1023), half = k / 2, w = Number.isInteger(half) ? half : (Math.floor(half) % 2 === 0 ? Math.floor(half) : Math.ceil(half));
  return {
    prompt: `binary16, round to nearest even: <code>0x${hex(k, 16)}</code> × 0.5 (a subnormal). Give the result's pattern (hex).`, placeholder: '0x....', check: numAnswer(w, 16), answer: `0x${hex(w, 16)}`,
    explain: `Halving shifts the fraction right by one place: ${k} / 2 = ${half}${Number.isInteger(half) ? ', exact' : `, a tie between ${Math.floor(half)} and ${Math.ceil(half)}: the even one is ${w}${w === 0 ? ' (so the smallest subnormal times 0.5 underflows to zero)' : ''}`}.`,
  };
}

/** The exercises beyond encoding (the last quarter of the drill's stream). */
function floatExtra(r: () => number): Question {
  const k = int(r, 0, 3);
  return k === 0 ? modeQuestion(r) : k === 1 ? ulpQuestion(r) : k === 2 ? specialQuestion(r) : subnormalQuestion(r);
}

const float: Drill = {
  id: 'float', title: 'binary16', goal: 6,
  how: 'binary16: 1 sign bit, 5 exponent bits (bias 15), 10 fraction bits with a hidden leading 1. Exponent field 0: zero or a subnormal (no hidden bit); all 1s: infinity (fraction 0) or NaN. Give values in decimal (fractions like 0.375 are fine), patterns in hex, kinds in words. Later questions ask for a rounding mode applied to a tie, the exponent k of the gap 2^k between floats near a value, a special result (NaN, ∞, −0, true or false) as RISC-V gives it, and sums or halvings of subnormal patterns.',
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
    if (q >= 0.75) return floatExtra(r);
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
    return { ok: (y && want) || (n && !want), why: y || n ? '' : 'answer yes or no' };
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

// ---- look-up tables (the FPGA chapter) ------------------------------------------------------------

/** A LUT4's input names, i0 … i3 (as the chapter's LUT: address = d c b a, a the lowest bit). */
const LUT_VARS = ['a', 'b', 'c', 'd'];
const listed = (vs: string[], last = 'and') => (vs.length < 3 ? vs.join(` ${last} `) : `${vs.slice(0, -1).join(', ')} ${last} ${vs[vs.length - 1]}`);

/** A function of four inputs in words, and its value at address i (0 … 15). */
export interface LutFn { say: string; f(i: number): number }

/** One of the drill's functions, drawn from r. Every one is exact: its configuration is read off f. */
export function lutFn(r: () => number): LutFn {
  const bit = (i: number, v: number) => (i >> v) & 1;
  const pick = (n: number): number[] => {
    const vs = [0, 1, 2, 3];
    for (let k = 3; k > 0; k--) { const j = int(r, 0, k); [vs[k], vs[j]] = [vs[j], vs[k]]; }
    return vs.slice(0, n).sort();
  };
  const names = (vs: number[]) => vs.map((v) => `<i>${LUT_VARS[v]}</i>`);
  const kind = int(r, 0, 8);
  if (kind === 0) { const vs = pick(int(r, 2, 3)); return { say: `1 only when ${listed(names(vs))} are all 1`, f: (i) => +vs.every((v) => bit(i, v)) }; }
  if (kind === 1) { const vs = pick(int(r, 2, 3)); return { say: `1 when any of ${listed(names(vs), 'or')} is 1`, f: (i) => +vs.some((v) => bit(i, v)) }; }
  if (kind === 2) { const vs = pick(int(r, 2, 3)); return { say: `1 when an odd number of ${listed(names(vs))} are 1`, f: (i) => vs.reduce((p, v) => p ^ bit(i, v), 0) }; }
  if (kind === 3) { const vs = pick(3); return { say: `1 when at least two of ${listed(names(vs))} are 1`, f: (i) => +(vs.filter((v) => bit(i, v)).length >= 2) }; }
  if (kind === 4) { const [x, y] = pick(2); const [nx, ny] = names([x, y]); return { say: `1 when ${nx} equals ${ny}, whatever the others`, f: (i) => +(bit(i, x) === bit(i, y)) }; }
  if (kind === 5) { const k = int(r, 1, 3); return { say: `1 when exactly ${k} of the four inputs ${k === 1 ? 'is' : 'are'} 1`, f: (i) => +([0, 1, 2, 3].filter((v) => bit(i, v)).length === k) }; }
  if (kind === 6) {
    const [x, y, z] = pick(3), s = int(r, 0, 2), sel = [x, y, z][s], [p, q] = [x, y, z].filter((_, j) => j !== s), [ns, np, nq] = names([sel, p, q]);
    return { say: `${np} when ${ns} is 0, ${nq} when ${ns} is 1 (a 2:1 multiplexer)`, f: (i) => (bit(i, sel) ? bit(i, q) : bit(i, p)) };
  }
  if (kind === 7) {
    const m = int(r, 0, 2);
    if (m === 0) return { say: '1 when the 4-bit number <i>dcba</i> is a prime', f: (i) => +[2, 3, 5, 7, 11, 13].includes(i) };
    if (m === 1) { const k = int(r, 3, 5); return { say: `1 when the 4-bit number <i>dcba</i> is a multiple of ${k} (0 counts)`, f: (i) => +(i % k === 0) }; }
    const k = int(r, 4, 12); return { say: `1 when the 4-bit number <i>dcba</i> is greater than ${k}`, f: (i) => +(i > k) };
  }
  return { say: '1 when the 2-bit number <i>ba</i> is greater than the 2-bit number <i>dc</i>', f: (i) => +((i & 3) > (i >> 2)) };
}

/** The 16 configuration bits of a function: bit i = its value at address i. */
export const lutCfg = (fn: LutFn): number => Array.from({ length: 16 }, (_, i) => fn.f(i) << i).reduce((a, b) => a | b, 0);
const rev16 = (v: number) => parseInt(bin(v, 16).split('').reverse().join(''), 2);

const lut: Drill = {
  id: 'lut', title: 'Program the LUT', goal: 6,
  how: 'Write the 16 configuration bits of a LUT4 that computes the function: bit i is the output when the address <i>dcba</i> = i (a the lowest input). In hex (0x…, four digits) or in binary (0b…, bit 15 first).',
  make(r) {
    const fn = lutFn(r), cfg = lutCfg(fn);
    const ones = Array.from({ length: 16 }, (_, i) => i).filter((i) => fn.f(i));
    const prompt = `A LUT4 with inputs <i>d c b a</i> (a the lowest) must output ${fn.say}. Its configuration?`;
    return {
      prompt, placeholder: '0x0000', answer: `0x${hex(cfg, 16)}`,
      explain: `The output is 1 at ${ones.length ? `address${ones.length > 1 ? 'es' : ''} ${ones.join(', ')}` : 'no address'}, so those bits are set: ${grp(bin(cfg, 16))} (bit 15 first) = 0x${hex(cfg, 16)}.`,
      check: (t) => {
        const s = t.trim().toLowerCase().replace(/[_\s]/g, '');
        // without a prefix, four digits can only be hex and sixteen 0s and 1s only binary
        const v = /^[0-9a-f]{4}$/.test(s) ? parseInt(s, 16) : /^[01]{16}$/.test(s) ? parseInt(s, 2) : parseNum(s);
        if (v === null || v < 0 || v > 0xffff) return { ok: false, why: 'write 16 bits: 0x and four hex digits, or 0b and sixteen bits' };
        if (v === cfg) return { ok: true };
        if (v === rev16(cfg)) return { ok: false, why: 'that is the table backwards: bit 0, at the right, is address 0' };
        if (v === (~cfg & 0xffff)) return { ok: false, why: 'every bit is inverted: that is the opposite function' };
        const wrong = Array.from({ length: 16 }, (_, i) => i).filter((i) => ((v >> i) & 1) !== fn.f(i));
        return { ok: false, why: `wrong at address${wrong.length > 1 ? 'es' : ''} ${wrong.slice(0, 4).join(', ')}${wrong.length > 4 ? ' …' : ''}` };
      },
    };
  },
};

// ---- fixed point and RISC-V division (the numbers chapters) ---------------------------------------------

/** A value as the chapters write it: the signed integer over 2^f, in decimal with no trailing zeros. */
export const fixedText = (raw: number, f: number): string => {
  const v = raw / 2 ** f;
  return Number.isInteger(v) ? String(v) : v.toFixed(f).replace(/0+$/, '');
};
/** The value of a word read as Qm.f with w = m + f bits: the signed integer / 2^f. */
export const qValue = (word: number, w: number, f: number): number => {
  const u = word & (2 ** w - 1);
  return (u >= 2 ** (w - 1) ? u - 2 ** w : u) / 2 ** f;
};

/** A number written in decimal ("-0.375"), as a fraction ("-3/8") or in hex / binary: its value. */
export function parseQty2(t: string): number | null {
  const x = t.trim().replace(/−/g, '-').replace(/\s/g, '');
  const m = x.match(/^(-?\d+)\/(\d+)$/);
  if (m) return Number(m[2]) === 0 ? null : Number(m[1]) / Number(m[2]);
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(x)) return Number(x);
  return parseNum(x);
}

const qName = (m: number, f: number) => `Q${m}.${f}`;

const fixed: Drill = {
  id: 'fixed', title: 'Fixed point', goal: 6,
  how: 'Qm.f is a two\'s complement word of m + f bits (the m includes the sign) read as the integer divided by 2^f. Give values in decimal (0.375) or as a fraction (3/8), a format as Qm.f, a shift as a number of places.',
  make(r) {
    const k = int(r, 0, 4);
    if (k === 0 || k === 1) {
      const w = k === 0 ? 8 : 16, f = w - 1;
      const word = int(r, 0, 2 ** w - 1);
      const raw = word >= 2 ** (w - 1) ? word - 2 ** w : word;
      const v = qValue(word, w, f);
      return {
        prompt: `What value does the ${w}-bit word <code>0x${hex(word, w)}</code> hold, read as <b>${qName(1, f)}</b>?`, placeholder: 'decimal or fraction',
        check: (t) => { const x = parseQty2(t); return x === null ? { ok: false, why: 'write a decimal number or a fraction' } : { ok: x === v, why: x === v ? undefined : 'not that value' }; },
        answer: fixedText(raw, f),
        explain: `As a signed integer the word is ${raw}; divided by 2^${f} = ${2 ** f} that is ${fixedText(raw, f)}. (The top bit weighs −1, the next ½, then ¼ …)`,
      };
    }
    if (k === 2) {
      const a = int(r, 1, 4), b = int(r, 3, 15), c = int(r, 1, 4), d = int(r, 3, 15);
      const want = qName(a + c, b + d);
      return {
        prompt: `Multiplying a <b>${qName(a, b)}</b> word by a <b>${qName(c, d)}</b> word gives a full-width product in which format?`, placeholder: 'Qm.f',
        check: (t) => { const m = t.trim().toUpperCase().match(/^Q(\d+)\.(\d+)$/); return m ? { ok: Number(m[1]) === a + c && Number(m[2]) === b + d, why: 'not that format' } : { ok: false, why: 'write it as Qm.f' }; },
        answer: want,
        explain: `Qa.b × Qc.d = Q(a+c).(b+d): the integer parts add (${a} + ${c}), so do the places after the point (${b} + ${d}). The product is ${a + b + c + d} bits long.`,
      };
    }
    if (k === 3) {
      const f = [7, 15][int(r, 0, 1)], other = int(r, 1, 3), g = int(r, 5, 12);
      return {
        prompt: `A Q1.${f} word times a ${qName(other, g)} word is a ${qName(1 + other, f + g)} product. By how many places is it shifted right to give a <b>${qName(1, f)}</b> result?`, placeholder: 'places',
        check: numAnswer(g, 10), answer: String(g),
        explain: `The product has ${f + g} places after the point and the result keeps ${f}: drop ${g}. (Two Q1.${f} words: the shift is ${f}, one fewer than the ${f + 1} bits of an operand.)`,
      };
    }
    const s2 = int(r, 2, 4), x = int(r, -120, 120), mode = ['floor', 'zero', 'half-up'][int(r, 0, 2)];
    const q = 2 ** s2;
    const want = mode === 'floor' ? Math.floor(x / q) : mode === 'zero' ? Math.trunc(x / q) : Math.floor((x + q / 2) / q);
    const how = mode === 'floor' ? `an arithmetic shift right by ${s2} (rounds down, toward −∞)` : mode === 'zero' ? `C division by ${q} (rounds toward zero)` : `rounding to nearest, ties up (add ${q / 2}, then shift right by ${s2})`;
    return {
      prompt: `Drop ${s2} bits from the signed integer <b>${x}</b> by ${how}. The result?`, placeholder: 'an integer',
      check: numAnswer(want, 10), answer: String(want),
      explain: `${x} / ${q} = ${x / q}. ` + (mode === 'floor' ? `Its floor is ${want}: a shift never rounds up, so a negative value moves further from zero.` : mode === 'zero' ? `Toward zero drops the fraction: ${want}. It differs from the shift only for a negative value with a nonzero remainder.` : `(${x} + ${q / 2}) >> ${s2} = ${want}.`),
    };
  },
};

/** RISC-V's four division results on 32-bit words (the spec: division by zero and the one overflow do not trap). */
export function divRem32(op: 'div' | 'divu' | 'rem' | 'remu', a: number, b: number): number {
  const au = a >>> 0, bu = b >>> 0, as = a | 0, bs = b | 0;
  switch (op) {
    case 'div': return bs === 0 ? -1 : as === -(2 ** 31) && bs === -1 ? as : Math.trunc(as / bs);
    case 'rem': return bs === 0 ? as : as === -(2 ** 31) && bs === -1 ? 0 : as % bs;
    case 'divu': return bu === 0 ? 0xffffffff : Math.floor(au / bu);
    default: return bu === 0 ? au : au % bu;
  }
}

const divrem: Drill = {
  id: 'divrem', title: 'RISC-V division', goal: 6,
  how: 'Operands are 32-bit words. div and rem are signed, divu and remu unsigned. Division never traps. Answer in decimal (signed for div / rem) or as a 0x pattern.',
  make(r) {
    const op = (['div', 'rem', 'divu', 'remu'] as const)[int(r, 0, 3)], signed = op === 'div' || op === 'rem';
    const kind = int(r, 0, 5);
    let a = signed ? int(r, -200, 200) : int(r, 0, 400), b = signed ? int(r, -12, 12) : int(r, 1, 12);
    if (signed && b === 0) b = 3;
    if (kind === 0) b = 0;
    else if (kind === 1 && signed) { a = -(2 ** 31); b = -1; }
    else if (kind === 2 && !signed) { a = 0xfffffff0 + int(r, 0, 15); b = int(r, 2, 9); }
    const want = divRem32(op, a, b) >>> 0;
    const shown = (v: number) => (signed ? (v | 0) < -9999 ? `0x${hex(v >>> 0, 32)}` : String(v | 0) : (v >>> 0) > 9999 ? `0x${hex(v >>> 0, 32)}` : String(v >>> 0));
    return {
      prompt: `<code>${op}</code> with rs1 = <b>${shown(a)}</b> and rs2 = <b>${shown(b)}</b>: what does rd get?`, placeholder: 'decimal or 0x…',
      answer: String(signed ? want | 0 : want),
      check: (t) => {
        const x = parseNum(t);
        if (x === null) return { ok: false, why: 'write a decimal number or a 0x pattern' };
        if (x < -(2 ** 31) || x >= 2 ** 32) return { ok: false, why: 'rd is a 32-bit word' };
        return (x >>> 0) === want ? { ok: true } : { ok: false, why: 'not that value' };
      },
      explain: b === 0
        ? `Division by zero: ${op.startsWith('div') ? `the quotient is all ones (${signed ? '−1' : '0xFFFFFFFF'})` : 'the remainder is the dividend'}, and nothing traps.`
        : signed && (a | 0) === -(2 ** 31) && (b | 0) === -1 ? 'The one overflow: +2³¹ does not fit, so div gives −2³¹ again and rem gives 0.'
          : signed ? `Division truncates toward zero, so the remainder takes the sign of the dividend: ${a} = ${Math.trunc(a / b)} × ${b} + ${a % b}.`
            : `Unsigned: ${a >>> 0} = ${Math.floor((a >>> 0) / b)} × ${b} + ${(a >>> 0) % b}.`,
    };
  },
};

/** The linker's jobs at a relocation, in RV16 (the campaign's machine; chapter 'linking' does the same in RV32): a call's word, a
 *  branch's word with its split offset, an la's lui / addi split. Encoded by isa16's own encJ / encSB / hiLo, so the drill and the
 *  assembler cannot disagree (tests/content-linking.test.ts assembles each answer). */
const reloc: Drill = {
  id: 'reloc', title: 'Patch the jump', goal: 6,
  how: 'Be the linker, in RV16. For a <code>call</code> or a branch, give the 16-bit word (0x…) with the offset filled in: offsets count words, from the instruction itself. For an <code>la</code>, give the <code>lui</code> and <code>addi</code> immediates as two decimal numbers, "hi, lo".',
  make(r) {
    const kind = int(r, 0, 2);
    if (kind === 0) {
      const site = int(r, 0, 0x3ff), off = int(r, 0, 2) === 0 ? -Math.min(site, int(r, 1, 255)) : int(r, 1, 255);
      const target = site + off, want = encJ(1, off);
      return {
        prompt: `<code>call f</code> (<code>jal ra, f</code>) sits at word <b>0x${hex(site, 16)}</b>; the linker put <code>f</code> at <b>0x${hex(target, 16)}</b>. What word does it write?`, placeholder: '0x…',
        answer: `0x${hex(want, 16)}`,
        check: (t) => {
          const x = parseNum(t);
          if (x === null) return { ok: false, why: 'write the word as 0x followed by 4 hex digits' };
          if ((x & 0xffff) === want && x >= 0 && x <= 0xffff) return { ok: true };
          if ((x & 0x7f) !== (want & 0x7f)) return { ok: false, why: `the low 7 bits are rd (ra = 1) and the opcode (jal = 12): 0x${hex(want & 0x7f, 8)}` };
          return { ok: false, why: `the offset ${off} goes in bits 15..7, as 9 bits (two's complement when negative)` };
        },
        explain: `offset = 0x${hex(target, 16)} − 0x${hex(site, 16)} = ${off} words. Its 9 bits${off < 0 ? ` (${off} + 512 = ${off + 512})` : ''} go in bits 15..7 in one piece; rd = ra (1) in bits 6..4 and the jal opcode 12 in bits 3..0.`,
      };
    }
    if (kind === 1) {
      const site = int(r, 0x20, 0x3ff);
      let off = int(r, -32, 31);
      if (off === 0) off = 5;
      const target = site + off, want = encSB(OP16.BEQ, 3, 0, off), o6 = off & 63;
      return {
        prompt: `<code>beqz a0, done</code> (<code>beq a0, zero, done</code>) sits at word <b>0x${hex(site, 16)}</b>; <code>done</code> ended up at <b>0x${hex(target, 16)}</b>. What word does the linker write?`, placeholder: '0x…',
        answer: `0x${hex(want, 16)}`,
        check: (t) => {
          const x = parseNum(t);
          if (x === null) return { ok: false, why: 'write the word as 0x followed by 4 hex digits' };
          if ((x & 0xffff) === want && x >= 0 && x <= 0xffff) return { ok: true };
          if ((x & 0x1f8f) !== (want & 0x1f8f)) return { ok: false, why: 'the registers and the opcode are fixed: rs1 = a0 (3) in bits 9..7, rs2 = zero in 12..10, beq = 8 in 3..0' };
          return { ok: false, why: `the offset ${off} is 6 bits split in two: its top 3 in bits 15..13, its low 3 in bits 6..4 (the rd field a branch does not use)` };
        },
        explain: `offset = ${off} words, 6 bits ${bin(o6, 6)}. Bits 5..3 (${bin(o6 >> 3, 3)}) go to 15..13 and bits 2..0 (${bin(o6 & 7, 3)}) to 6..4, where a branch has no rd; rs1 = 3, rs2 = 0 and opcode 8 fill the rest.`,
      };
    }
    const v = int(r, 0, 3) === 0 ? (int(r, 0, 1022) << 6) | int(r, 32, 63) : int(r, 0, 0xffbf); // below 0xffe0, where hi would wrap to 0
    const { hi, lo } = hiLo16(v);
    return {
      prompt: `<code>la a0, msg</code> with <code>msg</code> placed at <b>0x${hex(v, 16)}</b>. It becomes <code>lui a0, hi</code> (a0 = hi × 64) and <code>addi a0, a0, lo</code>. What are hi and lo?`, placeholder: 'hi, lo',
      answer: `${hi}, ${lo}`,
      check: (t) => {
        const m = t.replace(/−/g, '-').split(/[,\s]+/).filter(Boolean).map(parseNum);
        if (m.length !== 2 || m.some((x) => x === null)) return { ok: false, why: 'two numbers: the lui immediate, then the addi immediate' };
        const [a, b] = m as number[];
        if (a === hi && b === lo) return { ok: true };
        if (((a * 64 + b) & 0xffff) === v && (b < -32 || b > 31)) return { ok: false, why: 'they add up, but the addi takes −32 … 31 only' };
        return { ok: false, why: `hi × 64 + lo must be 0x${hex(v, 16)} (${v})` };
      },
      explain: lo < 0
        ? `Bit 5 of 0x${hex(v, 16)} is 1, so its low 6 bits (${v & 63}) would read as ${lo} in the addi: round hi up to ${hi} and take lo = ${lo} (${hi} × 64 − ${-lo} = ${(hi * 64 + lo) & 0xffff}).`
        : `Bit 5 is 0: hi = ${hi}, the address over 64, and lo = ${lo}, its low 6 bits (${hi} × 64 + ${lo} = ${v}).`,
    };
  },
};

export const DRILLS: Record<string, Drill> = { binary, twos, kmap, boolean, isa16, float, relay, hollerith, lut, testset, fixed, divrem, reloc };
