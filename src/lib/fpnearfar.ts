// A faster floating-point adder: the dual-path (near / far) design with leading-zero anticipation.
//
// fpAdd (fpu.ts) is one serial path: compare magnitudes, swap, subtract exponents, align, add,
// count the leading zeros of the sum, shift, round. Two observations split it.
//   far path   effective addition, or a subtraction with |exponent difference| ≥ 2: a long right
//              shift to align (with a sticky bit), but the sum needs at most 2 places of left shift
//              (1 for an addition) and never leaves the normal range: no leading-zero count.
//   near path  a subtraction with |exponent difference| ≤ 1: at most one place of alignment, so
//              nothing is lost (no sticky) and no aligner is needed, but the difference may cancel
//              to any depth. The shift amount is *anticipated* from the operands (lza) while the
//              subtractor still runs, so the normalizing shifter starts when the difference appears.
// Both paths end in a normalized significand and an exponent; one select, then one shared rounder.
//
// Bit-identical to fpAdd, flags included (tests/fpnearfar.test.ts); it costs more NANDs and
// is shallower, by the amounts the same test pins.

import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { andN, busMux2, decoder, equal } from './combinational';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR, XOR } from './gates';
import { Builder } from './builder';
import { ROUND_DECIDE, fpUnpack, incFast, lzc, shiftLeft, shiftRightSticky } from './fpu';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';
import { fpAddX, RM, type FpFormat } from '../sim/fpref';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const pow2ceil = (n: number) => 2 ** Math.ceil(Math.log2(n));
const log2c = (n: number) => Math.ceil(Math.log2(n));
const K = (w: number, v: number) => constWord(w, v >>> 0);
/** Exponent arithmetic width, as fpu.ts's: two's complement, wide enough for every intermediate exponent. */
const xeOf = (f: FpFormat) => (f.E + 3 <= 8 ? 8 : 16);
const fmtName = (f: FpFormat) => (f.E === 8 && f.M === 23 ? 'float32' : f.E === 5 && f.M === 10 ? 'binary16' : `E${f.E}M${f.M}`);
const nonZero = (b: Builder, x: string, w: number) => (w === 1 ? x : b.op1(NOT, [b.op1(isZero(w), [x])]));
const zext = (b: Builder, x: string, from: number, to: number) => (from === to ? x : b.op1(merger([from, to - from]), [x, b.op1(K(to - from, 0), [])]));
const flagWord = (b: Builder, fl: { nv?: string }) => {
  const z = () => b.op1(TIE0, []);
  return b.op1(merger([1, 1, 1, 1, 1]), [z(), z(), z(), z(), fl.nv ?? z()]);
};

// ---- leading-zero anticipation ---------------------------------------------------------------------

/** Reference for lza: the pattern f (most significant first) over the padded word, forced by `lim`, and the count to its first 1. */
function lzaCount(a: number, b: number, lim: number, n: number): number {
  const at = (x: number, i: number) => (i < 0 || i >= n ? 0 : Math.floor(x / 2 ** i) % 2);
  const nb = (i: number) => 1 - at(b, i);
  const T = (i: number) => at(a, i) ^ nb(i), G = (i: number) => at(a, i) & nb(i), Z = (i: number) => (at(a, i) | nb(i)) ^ 1;
  const P = pow2ceil(n);
  const bitOf = (j: number): number => { // bit j of the padded word
    let v = Math.floor(lim / 2 ** j) % 2;
    if (j < P - n) return 1;
    const i = j - (P - n); // bit i of f
    const tUp = i + 1 > n - 1 ? 1 : T(i + 1);
    const gd = i === 0 ? 1 : G(i - 1), zd = i === 0 ? 0 : Z(i - 1);
    v |= tUp ? (G(i) & (zd ^ 1)) | (Z(i) & (gd ^ 1)) : (Z(i) & (zd ^ 1)) | (G(i) & (gd ^ 1));
    return v;
  };
  for (let j = P - 1; j >= 0; j--) if (bitOf(j)) return P - 1 - j;
  return P - 1; // all zero (only when P = n): the counter's answer
}

/**
 * Leading-zero anticipator: from the operands of A − B (A ≥ B, n bits) the count of leading zeros
 * of the difference, within one place and without waiting for the subtraction. Per bit, from
 * propagate / generate / zero of A and ¬B, a pattern f whose first 1 is at the difference's leading
 * one or one place above; a priority encoder counts to it. The count is the true one or one too small.
 * `lim` forces bits of the padded pattern (bit j = a count of P − 1 − j), which clamps the count from above:
 * the near path uses it to cap the shift at what the exponent allows, without a comparison behind the encoder.
 */
export function lza(n: number): ComponentDef {
  return memo(`fpnflza${n}`, () => {
    const P = pow2ceil(n), k = Math.log2(P);
    const b = new Builder();
    const ones_ = b.op1(K(n, 2 ** n - 1), []);
    const X = (x: number) => bitwise('xor', x);
    const na = b.op1(X(n), ['a', ones_], 'NOT a'), nb = b.op1(X(n), ['b', ones_], 'NOT b');
    const p = b.op1(X(n), ['a', 'b'], 'propagate: a xor b');
    b.next();
    const g = b.op1(bitwise('and', n), ['a', nb], 'generate: a and not b');
    const z = b.op1(bitwise('and', n), [na, 'b'], 'zero: not a, b');
    b.next();
    // the neighbours: G and Z of the bit below (a 1 / 0 enters at the bottom: the +1 of the subtraction), P of the bit above (a 0 enters at the top)
    const gs = b.op(splitter([n - 1, 1]), [g]), zs = b.op(splitter([n - 1, 1]), [z]), ps = b.op(splitter([1, n - 1]), [p]);
    const gd = b.op1(merger([1, n - 1]), [b.op1(TIE1, []), `${gs}.o0`], 'G of the bit below');
    const zd = b.op1(merger([1, n - 1]), [b.op1(TIE0, []), `${zs}.o0`], 'Z of the bit below');
    const pu = b.op1(merger([n - 1, 1]), [`${ps}.o1`, b.op1(TIE0, [])], 'P of the bit above');
    b.next();
    const ngd = b.op1(X(n), [gd, ones_]), nzd = b.op1(X(n), [zd, ones_]);
    b.next();
    const A = bitwise('and', n), O = bitwise('or', n);
    const x1 = b.op1(O, [b.op1(A, [g, nzd]), b.op1(A, [z, ngd])], 'f when the bit above does not propagate');
    const x0 = b.op1(O, [b.op1(A, [z, nzd]), b.op1(A, [g, ngd])], 'f when it propagates');
    b.next();
    const f = b.op1(O, [b.op1(A, [pu, x0]), b.op1(A, [b.op1(X(n), [pu, ones_]), x1])], 'f: first 1 = leading one (± 1)');
    b.next();
    const padded = P > n ? b.op1(merger([P - n, n]), [b.op1(K(P - n, 2 ** (P - n) - 1), []), f]) : f;
    const forced = b.op1(bitwise('or', P), [padded, 'lim'], 'force the clamp');
    b.next();
    const lz = b.op(lzc(P), [forced], 'priority encode');
    b.wire(`${lz}.c`, 'c');
    return define({
      id: `fpnflza${n}`, name: `${n}-bit leading-zero anticipator`, category: 'arithmetic',
      summary: 'Predicts the number of leading zeros of A − B (for A ≥ B) from the operands alone, in parallel with the subtraction: the count, or one less. A priority encoder over a per-bit pattern of propagate / generate / zero terms.',
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('lim', P, 'in'), bus('c', k, 'out')],
      symbol: { kind: 'box', label: 'LZA' },
      spec: ([a, bb, lim]) => [lzaCount(a, bb, lim, n)],
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], lim: [0, 16], c: [b.right, 4] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the paths -------------------------------------------------------------------------------------

/**
 * Far path: big alignment shift with sticky, add or subtract, then at most two places of left
 * shift (none after a carry-out). Inputs are already swapped by exponent: eB, mB the larger exponent's.
 */
function farPath(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpnffar${E}_${M}`, () => {
    const XE = xeOf(f), WA = M + 3, kA = log2c(WA + 1), WS = M + 4, w = WS + 1;
    const b = new Builder();
    let dsat: string;
    if (kA < E) {
      const ds = b.op(splitter([kA, E - kA]), ['d']);
      const big = b.op1(NOT, [b.op1(isZero(E - kA), [`${ds}.o1`])]);
      dsat = b.op1(busMux2(kA), [`${ds}.o0`, b.op1(K(kA, 2 ** kA - 1), []), big]);
    } else dsat = kA === E ? 'd' : b.op1(merger([E, kA - E]), ['d', b.op1(K(kA - E, 0), [])]);
    const eBz = b.name(zext(b, 'eB', E, XE), 'eBig');
    b.next();
    const al = b.op(shiftRightSticky(WA, kA), [b.op1(merger([2, M + 1]), [b.op1(K(2, 0), []), 'mS']), dsat], 'align', 'align');
    const em1 = b.op(koggeStone(XE), [eBz, b.op1(K(XE, 2 ** XE - 1), []), b.op1(TIE0, [])], 'e − 1');
    const ex = b.op1(incFast(XE), [eBz], 'e + 1');
    b.next();
    const opB = b.op1(merger([1, 2, M + 1]), [b.op1(TIE0, []), b.op1(K(2, 0), []), 'mB']);
    const opS = b.op1(merger([1, WA]), [`${al}.sticky`, `${al}.y`]);
    const sum = b.op(addSubFast(WS), [opB, opS, 'sub'], 'add / subtract', 'adder');
    b.next();
    const top = b.name(b.op1(AND, [`${sum}.cout`, b.op1(NOT, ['sub'])], 'carry out (an addition)'), 'carry');
    const sm = b.name(b.op1(merger([WS, 1]), [`${sum}.s`, top]), 'sum');
    const sp = b.op(splitter([WS - 1, 1, 1]), [sm]);
    const extra = b.name(b.op1(AND, ['sub', b.op1(NOT, [`${sp}.o1`])], 'two zeros (a subtraction)'), 'two');
    b.next();
    const sh = (x: string, label: string) => {
      const s = b.op(splitter([w - 1, 1]), [x]);
      return b.op1(merger([1, w - 1]), [b.op1(TIE0, []), `${s}.o0`], label);
    };
    const m1 = b.op1(busMux2(w), [sh(sm, '<< 1'), sm, top], 'one place left unless a carry');
    const eM = b.op1(busMux2(XE), [eBz, `${em1}.s`, extra]);
    b.next();
    const m2 = b.op1(busMux2(w), [m1, sh(m1, '<< 1'), extra], 'a second place after a deep cancellation');
    const e = b.op1(busMux2(XE), [eM, ex, top], 'exponent');
    b.wire(m2, 'm');
    b.wire(e, 'e');
    return define({
      id: `fpnffar${E}_${M}`, name: 'Far path', category: 'arithmetic',
      summary: 'For an addition, or a subtraction whose exponents differ by 2 or more: shift the smaller significand right by the difference (sticky bit kept), add or subtract, then normalize. The sum is in [1, 4) after an addition and in (½, 2) after a subtraction with d ≥ 2, so at most one place right (a carry) or two places left: two multiplexer rows, no leading-zero count, and the result is never subnormal unless both operands are.',
      ports: [bus('eB', E, 'in'), bus('mB', M + 1, 'in'), bus('mS', M + 1, 'in'), bus('d', E, 'in'), bit('sub', 'in'), bus('m', w, 'out'), bus('e', XE, 'out')],
      symbol: { kind: 'box', label: 'FAR' },
      netlist: () => ({ pins: { eB: [0, 4], mB: [0, 10], mS: [0, 16], d: [0, 22], sub: [0, 28], m: [b.right, 4], e: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * Near path: a subtraction of operands whose exponents differ by 0 or 1. The smaller significand is
 * shifted by at most one place, which keeps every bit (one more bit of width), so the difference is exact.
 * Both X − Y and Y − X are formed (for equal exponents either may be the larger), each with its own
 * anticipator; the sign of X − Y picks. The anticipated count drives the left shifter, and a
 * one-place correction follows (the count may be one short).
 */
function nearPath(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpnfnear${E}_${M}`, () => {
    const XE = xeOf(f), n = M + 2, w = M + 5, P = pow2ceil(n), k = Math.log2(P);
    const XN = Math.max(E, k) + 2; // a narrower exponent word: e − L stays within ±2^(XN−1)
    const b = new Builder();
    const X = b.name(b.op1(merger([1, M + 1]), [b.op1(TIE0, []), 'mB'], 'X = 2·mB'), 'X');
    const yUp = b.op1(merger([1, M + 1]), [b.op1(TIE0, []), 'mS'], '2·mS (equal exponents)');
    const yDn = b.op1(merger([M + 1, 1]), ['mS', b.op1(TIE0, [])], 'mS (one below)');
    const eBz = b.name(zext(b, 'eB', E, XN), 'eBig');
    const em1z = b.name(zext(b, 'em1', E, XN), 'e−1');
    // the clamp: a one at the pattern position of count e − 1 (none when e − 1 ≥ 2^k), so the encoder returns min(p, e − 1)
    let hiBig: string, em1lo: string;
    if (E > k) {
      const sp = b.op(splitter([k, E - k]), ['em1']);
      hiBig = b.name(nonZero(b, `${sp}.o1`, E - k), 'e−1≥2^k');
      em1lo = `${sp}.o0`;
    } else {
      hiBig = b.op1(TIE0, []);
      em1lo = zext(b, 'em1', E, k);
    }
    const dec = b.op(decoder(k, true), [em1lo, b.op1(NOT, [hiBig])], 'e − 1 → one-hot', 'clamp');
    const lim = b.op1(merger(ones(P)), Array.from({ length: P }, (_, j) => `${dec}.y${P - 1 - j}`), 'clamp pattern');
    b.next();
    const Y = b.name(b.op1(busMux2(n), [yUp, yDn, 'd1'], 'align: ≤ 1 place'), 'Y');
    b.next();
    const d1 = b.op(addSubFast(n), [X, Y, b.op1(TIE1, [])], 'X − Y', 'dxy');
    const d2 = b.op(addSubFast(n), [Y, X, b.op1(TIE1, [])], 'Y − X', 'dyx');
    const l1 = b.op(lza(n), [X, Y, lim], 'LZA of X − Y', 'lzxy');
    const l2 = b.op(lza(n), [Y, X, lim], 'LZA of Y − X', 'lzyx');
    const eq = b.op1(equal(n), [X, Y], 'X = Y ?', 'same');
    b.next();
    const neg = b.name(b.op1(NOT, [`${d1}.cout`], 'X < Y'), 'neg');
    b.next();
    const F = b.op1(busMux2(n), [`${d1}.s`, `${d2}.s`, neg], 'the magnitude');
    const p = b.name(b.op1(busMux2(k), [`${l1}.c`, `${l2}.c`, neg], 'shift = min(anticipated count, e − 1)'), 'L');
    const mant0 = b.op1(merger([3, n]), [b.op1(K(3, 0), []), F]);
    const pz = zext(b, p, k, XN);
    b.next();
    const sh1 = b.op(shiftLeft(w, k), [mant0, p], 'normalize by the anticipated count', 'shift');
    const u = b.op(addSubFast(XN), [eBz, pz, b.op1(TIE1, [])], 'e − L');
    const t = b.op(addSubFast(XN), [em1z, pz, b.op1(TIE1, [])], 'e − 1 − L');
    const same = b.op1(equal(k), [em1lo, p], 'L = e − 1 ?');
    const canMore = b.name(b.op1(OR, [hiBig, b.op1(NOT, [same])]), 'room');
    b.next();
    const ts = b.op(splitter([w - 1, 1]), [`${sh1}.y`]);
    const corr = b.name(b.op1(AND, [b.op1(NOT, [`${ts}.o1`]), canMore], 'top bit still 0 and room: one place more'), 'correct');
    b.next();
    const m2 = b.op1(busMux2(w), [`${sh1}.y`, b.op1(merger([1, w - 1]), [b.op1(TIE0, []), `${ts}.o0`], '<< 1'), corr], 'correction');
    const e2 = zext(b, b.op1(busMux2(XN), [`${u}.s`, `${t}.s`, corr], 'exponent'), XN, XE);
    b.wire(m2, 'm');
    b.wire(e2, 'e');
    b.wire(neg, 'neg');
    b.wire(eq, 'eq');
    return define({
      id: `fpnfnear${E}_${M}`, name: 'Near path', category: 'arithmetic',
      summary: 'For a subtraction whose exponents differ by at most 1: no sticky and no long aligner (the smaller operand moves at most one place, into an extra bit), both differences X − Y and Y − X, and the leading-zero count anticipated from the operands in parallel with them. The count may be one short; one correction shift follows. Massive cancellation costs one shifter, not a counter behind the adder.',
      ports: [bus('eB', E, 'in'), bus('em1', E, 'in'), bus('mB', M + 1, 'in'), bus('mS', M + 1, 'in'), bit('d1', 'in'), bus('m', w, 'out'), bus('e', XE, 'out'), bit('neg', 'out'), bit('eq', 'out')],
      symbol: { kind: 'box', label: 'NEAR' },
      netlist: () => ({ pins: { eB: [0, 4], em1: [0, 10], mB: [0, 16], mS: [0, 22], d1: [0, 28], m: [b.right, 4], e: [b.right, 10], neg: [b.right, 16], eq: [b.right, 22] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The near path without anticipation, for comparison: the count of leading zeros is taken from the
 * selected difference (a counter behind the subtractor and the sign select), the exponent limit by a
 * comparison behind the counter. Exact count, so no correction shift. Same ports and results as nearPath.
 */
function nearPathCounted(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpnfnearc${E}_${M}`, () => {
    const XE = xeOf(f), n = M + 2, w = M + 5, P = pow2ceil(n), k = Math.log2(P);
    const XN = Math.max(E, k) + 2;
    const b = new Builder();
    const X = b.name(b.op1(merger([1, M + 1]), [b.op1(TIE0, []), 'mB'], 'X = 2·mB'), 'X');
    const yUp = b.op1(merger([1, M + 1]), [b.op1(TIE0, []), 'mS'], '2·mS (equal exponents)');
    const yDn = b.op1(merger([M + 1, 1]), ['mS', b.op1(TIE0, [])], 'mS (one below)');
    const eBz = b.name(zext(b, 'eB', E, XN), 'eBig');
    let hiBig: string, em1lo: string;
    if (E > k) {
      const sp = b.op(splitter([k, E - k]), ['em1']);
      hiBig = b.name(nonZero(b, `${sp}.o1`, E - k), 'e−1≥2^k');
      em1lo = `${sp}.o0`;
    } else {
      hiBig = b.op1(TIE0, []);
      em1lo = zext(b, 'em1', E, k);
    }
    b.next();
    const Y = b.name(b.op1(busMux2(n), [yUp, yDn, 'd1'], 'align: ≤ 1 place'), 'Y');
    b.next();
    const d1 = b.op(addSubFast(n), [X, Y, b.op1(TIE1, [])], 'X − Y', 'dxy');
    const d2 = b.op(addSubFast(n), [Y, X, b.op1(TIE1, [])], 'Y − X', 'dyx');
    const eq = b.op1(equal(n), [X, Y], 'X = Y ?', 'same');
    b.next();
    const neg = b.name(b.op1(NOT, [`${d1}.cout`], 'X < Y'), 'neg');
    b.next();
    const F = b.op1(busMux2(n), [`${d1}.s`, `${d2}.s`, neg], 'the magnitude');
    b.next();
    const padded = P > n ? b.op1(merger([P - n, n]), [b.op1(K(P - n, 2 ** (P - n) - 1), []), F]) : F;
    const lz = b.op(lzc(P), [padded], 'count the leading zeros', 'count');
    const mant0 = b.op1(merger([3, n]), [b.op1(K(3, 0), []), F]);
    b.next();
    const p = `${lz}.c`;
    const cmp = b.op(addSubFast(k + 1), [zext(b, em1lo, k, k + 1), zext(b, p, k, k + 1), b.op1(TIE1, [])], '(e − 1) mod 2^k − count');
    const canNorm = b.name(b.op1(OR, [hiBig, b.op1(NOT, [`${cmp}.n`])]), 'canNormalize');
    b.next();
    const L = b.op1(busMux2(k), [em1lo, p, canNorm], 'shift = min(count, e − 1)');
    b.next();
    const sh1 = b.op(shiftLeft(w, k), [mant0, L], 'normalize', 'shift');
    const u = b.op(addSubFast(XN), [eBz, zext(b, L, k, XN), b.op1(TIE1, [])], 'e − L');
    b.wire(`${sh1}.y`, 'm');
    b.wire(zext(b, `${u}.s`, XN, XE), 'e');
    b.wire(neg, 'neg');
    b.wire(eq, 'eq');
    return define({
      id: `fpnfnearc${E}_${M}`, name: 'Near path (count after the subtract)', category: 'arithmetic',
      summary: 'The near path without anticipation: both differences, select by sign, count the leading zeros of the result, compare with the exponent, shift. For comparison with the anticipating version.',
      ports: [bus('eB', E, 'in'), bus('em1', E, 'in'), bus('mB', M + 1, 'in'), bus('mS', M + 1, 'in'), bit('d1', 'in'), bus('m', w, 'out'), bus('e', XE, 'out'), bit('neg', 'out'), bit('eq', 'out')],
      symbol: { kind: 'box', label: 'NEAR' },
      netlist: () => ({ pins: { eB: [0, 4], em1: [0, 10], mB: [0, 16], mS: [0, 22], d1: [0, 28], m: [b.right, 4], e: [b.right, 10], neg: [b.right, 16], eq: [b.right, 22] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * Round a normalized significand: m (M + 5 bits, the hidden bit on top unless the result is subnormal)
 * with exponent e. normRound's second half (the same rounding decision, increment, overflow and
 * tininess logic), without its leading-zero counter and shifters, which the paths have done.
 */
function roundPack(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpnfround${E}_${M}`, () => {
    const XE = xeOf(f), w = M + 5;
    const b = new Builder();
    const eInc = b.name(b.op1(incFast(XE), ['e'], 'e + 1'), 'e+1');
    const geTop = b.name(b.op1(NOT, [`${b.op(addSubFast(XE), ['e', b.op1(K(XE, 2 ** E - 1), []), b.op1(TIE1, [])], 'e ≥ max?')}.n`]), 'e≥max');
    const atTop = b.name(b.op1(equal(XE), ['e', b.op1(K(XE, 2 ** E - 2), [])], 'e = max − 1?'), 'e=max−1');
    const parts = b.op(splitter([w - M - 2, 1, M + 1]), ['m']);
    const rs = b.op(splitter([w - M - 3, 1]), [`${parts}.o0`]);
    const Rb = `${rs}.o1`, S2 = nonZero(b, `${rs}.o0`, w - M - 3);
    b.next();
    const S = b.name(b.op1(OR, [Rb, S2]), 'S');
    const G = b.name(`${parts}.o1`, 'G');
    const lsb = b.op(splitter([1, M]), [`${parts}.o2`]);
    const kt = b.op(splitter([M, 1]), [`${parts}.o2`]);
    b.next();
    const rd = b.op(ROUND_DECIDE, ['rm', 'sign', `${lsb}.o0`, G, S], 'round up?');
    const inc = b.name(`${rd}.up`, 'roundUp');
    const nx0 = b.name(b.op1(OR, [G, S]), 'inexact');
    const kf = b.op(splitter(ones(M)), [`${kt}.o0`]);
    const fracOnes = b.op1(andN(M), Array.from({ length: M }, (_, i) => `${kf}.o${i}`), 'fraction all 1s');
    const rd2 = b.op(ROUND_DECIDE, ['rm', 'sign', b.op1(TIE1, []), Rb, S2], 'unbounded rounding');
    b.next();
    const mi = b.op(incFast(M + 1), [`${parts}.o2`]);
    const mR = b.op1(busMux2(M + 1), [`${parts}.o2`, `${mi}.y`, inc]);
    const carry = b.name(b.op1(AND, [inc, `${mi}.cout`]), 'carry');
    const reach = b.op1(andN(3), [fracOnes, G, `${rd2}.up`]);
    b.next();
    const ms = b.op(splitter([M, 1]), [mR]);
    const hidden = b.name(b.op1(OR, [`${ms}.o1`, carry]), 'hidden');
    const eF = b.name(b.op1(busMux2(XE), ['e', eInc, carry], 'exp + carry'), 'eFinal');
    const tiny = b.name(b.op1(AND, [b.op1(NOT, [`${kt}.o1`]), b.op1(NOT, [reach])], 'tiny?'), 'tiny');
    b.next();
    const inf = b.name(b.op1(AND, [hidden, b.op1(OR, [geTop, b.op1(AND, [carry, atTop])], 'overflow?')]), 'ovf');
    const satMax = b.name(b.op1(AND, [inf, b.op1(NOT, [`${rd}.toInf`])], 'largest finite instead'), 'satMax');
    const ef = b.op(splitter([E, XE - E]), [eF]);
    b.next();
    const expF = b.op1(bitwise('and', E), [`${ef}.o0`, b.op1(fanout(E), [hidden])]);
    const expOr = b.op(splitter([1, E - 1]), [b.op1(bitwise('or', E), [expF, b.op1(fanout(E), [inf])])]);
    const e0 = b.op1(AND, [`${expOr}.o0`, b.op1(NOT, [satMax])]);
    const fracOut = b.op1(bitwise('or', M), [b.op1(bitwise('and', M), [`${ms}.o0`, b.op1(fanout(M), [b.op1(NOT, [inf])])]), b.op1(fanout(M), [satMax])]);
    b.next();
    b.wire(b.op1(merger([M, 1, E - 1, 1]), [fracOut, e0, `${expOr}.o1`, 'sign']), 'y');
    const z = () => b.op1(TIE0, []);
    b.wire(b.op1(merger([1, 1, 1, 1, 1]), [b.op1(OR, [nx0, inf], 'NX'), b.op1(AND, [tiny, nx0], 'UF'), inf, z(), z()]), 'flags');
    return define({
      id: `fpnfround${E}_${M}`, name: `Round (${w}-bit normalized significand)`, category: 'arithmetic',
      summary: 'The significand arrives normalized: round it in mode rm from the guard bit G and the sticky bit S, bump the exponent on a carry, resolve overflow and tininess. It is the rounding half of normalize & round, shared by both paths of the adder.',
      ports: [bit('sign', 'in'), bus('e', XE, 'in'), bus('m', w, 'in'), bus('rm', 3, 'in'), bus('y', 1 + E + M, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'ROUND' },
      netlist: () => ({ pins: { sign: [0, 2], e: [0, 6], m: [0, 10], rm: [0, 14], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the adder -------------------------------------------------------------------------------------

/** a ± b with a near path and a far path (see the file header): the same function as fpAdd, shallower and larger. */
export function fpAddNearFar(f: FpFormat, anticipate = true): ComponentDef {
  const { E, M } = f;
  const tag = anticipate ? 'fpnf' : 'fpnfc';
  return memo(`${tag}${E}_${M}`, () => {
    const XE = xeOf(f), w = M + 5, N = 1 + E + M;
    const b = new Builder();
    const ua = b.op(fpUnpack(f), ['a'], 'unpack a', 'ua'), ub = b.op(fpUnpack(f), ['b'], 'unpack b', 'ub');
    b.next();
    const sbEff = b.name(b.op1(XOR, [`${ub}.sign`, 'sub'], 'b sign (−b for fsub)'), 'signB');
    const effSub = b.name(b.op1(XOR, [`${ua}.sign`, sbEff], 'subtract?'), 'effSub');
    const dab = b.op(addSubFast(E), [`${ua}.exp`, `${ub}.exp`, b.op1(TIE1, [])], 'ea − eb', 'dab');
    const dba = b.op(addSubFast(E), [`${ub}.exp`, `${ua}.exp`, b.op1(TIE1, [])], 'eb − ea', 'dba');
    b.next();
    const ge = b.name(`${dab}.cout`, 'aExp≥bExp');
    const d = b.name(b.op1(busMux2(E), [`${dba}.s`, `${dab}.s`, ge], '|exponent difference|'), 'd');
    const eB = b.name(b.op1(busMux2(E), [`${ub}.exp`, `${ua}.exp`, ge], 'swap by exponent'), 'eBig');
    const dec1 = (x: string, lbl: string) => `${b.op(koggeStone(E), [x, b.op1(K(E, 2 ** E - 1), []), b.op1(TIE0, [])], lbl)}.s`;
    const em1 = b.name(b.op1(busMux2(E), [dec1(`${ub}.exp`, 'eb − 1'), dec1(`${ua}.exp`, 'ea − 1'), ge], 'e − 1 (formed before the swap)'), 'eBig−1');
    b.next();
    const mB = b.name(b.op1(busMux2(M + 1), [`${ub}.mant`, `${ua}.mant`, ge]), 'mBig');
    const mS = b.name(b.op1(busMux2(M + 1), [`${ua}.mant`, `${ub}.mant`, ge]), 'mSmall');
    const sB = b.name(b.op1(MUX2, [sbEff, `${ua}.sign`, ge]), 'signBig');
    const sS = b.op1(MUX2, [`${ua}.sign`, sbEff, ge]);
    const dsp = b.op(splitter([1, E - 1]), [d]);
    const near = b.name(b.op1(AND, [effSub, b.op1(NOT, [nonZero(b, `${dsp}.o1`, E - 1)])], 'near: subtract, d ≤ 1'), 'near');
    b.next();
    const far = b.op(farPath(f), [eB, mB, mS, d, effSub], 'far path', 'far');
    const nr = b.op(anticipate ? nearPath(f) : nearPathCounted(f), [eB, em1, mB, mS, `${dsp}.o0`], 'near path', 'near');
    b.next();
    const negSel = b.op1(AND, [near, `${nr}.neg`], 'near, X < Y');
    const zero = b.name(b.op1(AND, [near, `${nr}.eq`], 'x − x'), 'cancel');
    const sg1 = b.op1(MUX2, [sB, sS, negSel], 'sign of the bigger');
    const sign = b.op1(MUX2, [sg1, b.op1(equal(3), ['rm', b.op1(K(3, RM.RDN), [])], 'RDN?'), zero], 'x − x = +0 (−0 in RDN)');
    const m = b.op1(busMux2(w), [`${far}.m`, `${nr}.m`, near], 'select the path');
    const e = b.op1(busMux2(XE), [`${far}.e`, `${nr}.e`, near]);
    b.next();
    const rnd = b.op(roundPack(f), [sign, e, m, 'rm'], 'round', 'rnd');
    const invalid = b.name(b.op1(orN(3), [`${ua}.snan`, `${ub}.snan`, b.op1(andN(3), [`${ua}.inf`, `${ub}.inf`, effSub])], 'invalid'), 'NV');
    const nan = b.op1(orN(3), [`${ua}.nan`, `${ub}.nan`, invalid], 'NaN?');
    const anyInf = b.op1(OR, [`${ua}.inf`, `${ub}.inf`]);
    const infS = b.op1(MUX2, [sbEff, `${ua}.sign`, `${ua}.inf`]);
    b.next();
    const infV = b.op1(merger([M, E, 1]), [b.op1(K(M, 0), []), b.op1(K(E, 2 ** E - 1), []), infS]);
    const nanV = b.op1(K(N, (2 ** E - 1) * 2 ** M + 2 ** (M - 1)), []);
    const y1 = b.op1(busMux2(N), [`${rnd}.y`, infV, anyInf], 'infinity');
    b.wire(b.op1(busMux2(N), [y1, nanV, nan], 'NaN'), 'y');
    b.wire(b.op1(busMux2(5), [`${rnd}.flags`, flagWord(b, { nv: invalid }), b.op1(OR, [nan, anyInf])], 'flags'), 'flags');
    return define({
      id: `${tag}${E}_${M}`, name: `${fmtName(f)} near / far adder${anticipate ? '' : ' (no anticipation)'}`, category: 'arithmetic',
      summary: 'The dual-path adder: swap by exponent only (no magnitude compare); a far path (effective addition, or exponents differing by 2 or more: long right shift, sticky, at most two places of left shift) and a near path (a subtraction with exponents within 1: no aligner, a leading-zero anticipator running beside the subtractor); a select; one shared rounder. Same results and flags as the single-path adder, in fewer gate delays and more gates.',
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bit('sub', 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FADD n/f' },
      spec: ([a, bb, s, rm]) => { const r = fpAddX(a, bb, !!s, f, rm); return [r.y, r.fl]; },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], sub: [0, 16], rm: [0, 20], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: { verilog: `// behaviourally: assign {y, flags} = sub ? fsub(a, b, rm) : fadd(a, b, rm);   (IEEE 754 binary)` },
    });
  });
}
