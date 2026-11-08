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

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { andN, busMux2, decoder, equal } from './combinational';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR, XOR } from './gates';
import { Builder } from './builder';
import { ROUND_DECIDE, faddSpecial, fpUnpack, incFast, lzc, shiftLeft, shiftRightSticky } from './fpu';
import { layered } from './layered';
import { TIE0, TIE1 } from './transistors';
import { bitwise } from './wide';
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

/** n inverters side by side (the library has no inverter word: an XOR with ones would cost three NANDs a bit more). */
const notCache = new Map<number, ComponentDef>();
function notWord(n: number): ComponentDef {
  let d = notCache.get(n);
  if (d) return d;
  const P = 6;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), P), at: [4, 0] },
    { name: 'my', def: merger(ones(n), P), at: [17, 1] },
  ];
  const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'y', ends: ['my.out', 'y'] }];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `g${i}`, def: NOT, at: [10, 2 + P * i] });
    nets.push({ ends: [`sa.o${i}`, `g${i}.a`] }, { ends: [`g${i}.y`, `my.i${i}`] });
  }
  d = define({
    id: `fpnfnot${n}`, name: `${n}-bit NOT`, category: 'gate',
    summary: `${n} inverters side by side: bit i of the result is the complement of bit i of the input.`,
    ports: [bus('a', n, 'in'), bus('y', n, 'out')],
    symbol: { kind: 'box', label: `NOT${n}` },
    spec: ([a]) => [2 ** n - 1 - a],
    netlist: () => ({ pins: { a: [1, (P * n) / 2], y: [21, 1 + (P * n) / 2] }, instances, nets }),
  });
  notCache.set(n, d);
  return d;
}

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
    const A = bitwise('and', n), O = bitwise('or', n), N = notWord(n);
    const na = b.op1(N, ['a'], 'NOT a'), nb = b.op1(N, ['b'], 'NOT b');
    b.next();
    // per bit of a + ¬b: T propagates a carry, G generates one, Z kills one
    const t = b.op1(bitwise('xor', n), ['a', nb], 'T = a xor ¬b (propagate)');
    const g = b.op1(A, ['a', nb], 'G = a and ¬b (generate)');
    const z = b.op1(A, [na, 'b'], 'Z = ¬a and b (kill)');
    b.next();
    // the neighbours: G and Z of the bit below (a 1 / 0 enters at the bottom: the +1 of the subtraction), T of the bit above (a 1 enters at the top)
    const gs = b.op(splitter([n - 1, 1]), [g]), zs = b.op(splitter([n - 1, 1]), [z]), ts = b.op(splitter([1, n - 1]), [t]);
    const gd = b.op1(merger([1, n - 1]), [b.op1(TIE1, []), `${gs}.o0`], 'G of the bit below');
    const zd = b.op1(merger([1, n - 1]), [b.op1(TIE0, []), `${zs}.o0`], 'Z of the bit below');
    const tu = b.op1(merger([n - 1, 1]), [`${ts}.o1`, b.op1(TIE1, [])], 'T of the bit above');
    b.next();
    const ngd = b.op1(N, [gd]), nzd = b.op1(N, [zd]), ntu = b.op1(N, [tu]);
    b.next();
    const x1 = b.op1(O, [b.op1(A, [g, nzd]), b.op1(A, [z, ngd])], 'f if T above: G·¬Z below + Z·¬G below');
    const x0 = b.op1(O, [b.op1(A, [z, nzd]), b.op1(A, [g, ngd])], 'f if ¬T above: Z·¬Z below + G·¬G below');
    b.next();
    const f = b.op1(O, [b.op1(A, [tu, x1]), b.op1(A, [ntu, x0])], 'f: first 1 = leading one (± 1)');
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

// ---- the adder's blocks ----------------------------------------------------------------------------
// Drawn as its stages like fpAdd (circuit eyeballing, 2026-11-08): the control nets between them (which exponent is larger,
// near or far, subtract) are box ports. The gates are the ones the flat drawing had.

/** Signs: b's effective sign (sub flips it) and whether the significands are subtracted. */
export const FNF_SIGN: ComponentDef = (() => {
  const b = new Builder(10, 8, 4);
  b.pins('sa', 'sub', 'sb');
  const sbEff = b.op1(XOR, ['sb', 'sub'], 'b sign (−b for fsub)', 'nb');
  b.next();
  b.wire(b.op1(XOR, ['sa', sbEff], 'subtract?', 'sx'), 'effSub');
  b.wire(sbEff, 'signB');
  const ports = [bit('sa', 'in'), bit('sub', 'in'), bit('sb', 'in'), bit('signB', 'out'), bit('effSub', 'out')];
  return define({
    id: 'fnf_sign', name: 'Near / far adder: signs', category: 'arithmetic',
    summary: 'b\'s sign XOR sub (a − b is a + (−b)); the significands are subtracted when the two signs differ.',
    ports, symbol: { kind: 'box', label: 'SIGNS' },
    spec: ([sa, sub, sb]) => [sb ^ sub, sa ^ sb ^ sub],
    netlist: () => layered(ports, b, { gap: 8 }),
  });
})();

/** The exponents: both differences (the borrow says which is larger), the larger exponent and that minus 1, and near or far. */
function nfExp(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fnf_exp${E}_${M}`, () => {
    // drawn by hand: the two differences on top (the lower one's borrow is ge), the two decrements below, the three muxes in a
    // column (the lower two mirrored, their selects on top); ea and eb run down two trunks on the left; near from the difference's upper bits on the right
    const instances: InstanceDef[] = [
      { name: 'dba', def: addSubFast(E), at: [8, 2], label: 'eb − ea' }, { name: 'one_ba', def: TIE1, at: [5, 8] },
      { name: 'dab', def: addSubFast(E), at: [8, 14], label: 'ea − eb' }, { name: 'one_ab', def: TIE1, at: [5, 20] },
      { name: 'deca', def: koggeStone(E), at: [12, 30], label: 'ea − 1' }, { name: 'decak', def: K(E, 2 ** E - 1), at: [5, 33] }, { name: 'decac', def: TIE0, at: [7, 36] },
      { name: 'decb', def: koggeStone(E), at: [12, 40], label: 'eb − 1' }, { name: 'decbk', def: K(E, 2 ** E - 1), at: [5, 43] }, { name: 'decbc', def: TIE0, at: [7, 46] },
      { name: 'dsel', def: busMux2(E), at: [30, 8], label: '|exponent difference|' },
      { name: 'esel', def: busMux2(E), at: [30, 24], flip: true, rot: 2, label: 'larger exponent' }, // mirrored: ge comes in from above
      { name: 'm1sel', def: busMux2(E), at: [30, 38], flip: true, rot: 2, label: 'e − 1 (formed before the swap)' },
      { name: 'dsp', def: splitter([1, E - 1]), at: [38, 9] },
      { name: 'zero', def: isZero(E - 1), at: [41, 10] }, { name: 'nz', def: NOT, at: [48, 11] }, { name: 'small', def: NOT, at: [52, 11], label: 'd ≤ 1' },
      { name: 'isnear', def: AND, at: [57, 9], label: 'near: subtract, d ≤ 1' },
    ];
    const nets: NetDef[] = [
      { name: 'ea', ends: ['ea', 'dba.b', 'dab.a', 'esel.b', 'deca.a'] }, { name: 'eb', ends: ['eb', 'dba.a', 'dab.b', 'esel.a', 'decb.a'] },
      { name: '1', ends: ['one_ba.y', 'dba.sub'] }, { name: '1 ', ends: ['one_ab.y', 'dab.sub'] },
      { name: 'eb − ea', ends: ['dba.s', 'dsel.a'] }, { name: 'ea − eb', ends: ['dab.s', 'dsel.b'] },
      { name: 'aExp≥bExp', ends: ['dab.cout', 'dsel.s', 'esel.s', 'm1sel.s', 'ge'], via: { 'm1sel.s': [[36, 18], [36, 36], [32, 36]] } },
      { name: '−1', ends: ['decbk.y', 'decb.b'] }, { name: '0', ends: ['decbc.y', 'decb.cin'] }, { name: '−1 ', ends: ['decak.y', 'deca.b'] }, { name: '0 ', ends: ['decac.y', 'deca.cin'] },
      { name: 'eb − 1', ends: ['decb.s', 'm1sel.a'] }, { name: 'ea − 1', ends: ['deca.s', 'm1sel.b'] },
      { name: 'd', ends: ['dsel.y', 'dsp.in', 'd'], via: { d: [[36, 11], [36, 16]] } },
      { name: 'd1', ends: ['dsp.o0', 'd1'], via: { d1: [[40, 10], [40, 8]] } }, { name: 'd upper', ends: ['dsp.o1', 'zero.a'] },
      { name: 'upper = 0', ends: ['zero.z', 'nz.a'] }, { name: 'd ≥ 2', ends: ['nz.y', 'small.a'] }, { name: 'd ≤ 1', ends: ['small.y', 'isnear.b'] },
      { name: 'effSub', ends: ['effSub', 'isnear.a'], via: { 'isnear.a': [[55, 0], [55, 10]] } }, { name: 'near', ends: ['isnear.y', 'near'] },
      { name: 'eBig', ends: ['esel.y', 'eBig'] }, { name: 'eBig − 1', ends: ['m1sel.y', 'eBigM1'] },
    ];
    const pins: Record<string, [number, number]> = { effSub: [0, 0], ea: [0, 7], eb: [0, 5], ge: [66, 18], d1: [66, 8], near: [66, 11], d: [66, 16], eBig: [66, 27], eBigM1: [66, 41] };
    const ports = [bus('ea', E, 'in'), bit('effSub', 'in'), bus('eb', E, 'in'), bit('ge', 'out'), bus('eBig', E, 'out'), bus('d', E, 'out'), bus('eBigM1', E, 'out'),
      bit('d1', 'out'), bit('near', 'out')];
    const T = 2 ** E;
    return define({
      id: `fnf_exp${E}_${M}`, name: `Near / far adder: exponents (${fmtName(f)})`, category: 'arithmetic',
      summary: 'Both differences ea − eb and eb − ea at once: the first one\'s borrow says which exponent is larger (ge) and picks d = |difference|, the larger exponent, and that exponent minus 1 (formed before the swap, for the near path). near: a subtraction with d ≤ 1.',
      ports, symbol: { kind: 'box', label: 'EXP' },
      spec: ([ea, sub, eb]) => {
        const ge = ea >= eb ? 1 : 0, d = ge ? ea - eb : eb - ea, eB = ge ? ea : eb;
        return [ge, eB, d, (eB - 1 + T) % T, d & 1, sub && d <= 1 ? 1 : 0];
      },
      netlist: () => ({ pins, instances, nets }),
    });
  });
}

/** The significands, larger exponent first (no magnitude compare: when d = 0 the near path sorts them out). */
function nfSwap(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fnf_swap${E}_${M}`, () => {
    const b = new Builder(10, 8, 4);
    b.pins('ma', 'mb', 'ge');
    b.wire(b.op1(busMux2(M + 1), ['mb', 'ma', 'ge'], 'larger exponent\'s', 'big'), 'mBig');
    b.wire(b.op1(busMux2(M + 1), ['ma', 'mb', 'ge'], 'smaller exponent\'s', 'small'), 'mSmall');
    const ports = [bus('ma', M + 1, 'in'), bus('mb', M + 1, 'in'), bit('ge', 'in'), bus('mBig', M + 1, 'out'), bus('mSmall', M + 1, 'out')];
    return define({
      id: `fnf_swap${E}_${M}`, name: `Near / far adder: swap (${fmtName(f)})`, category: 'arithmetic',
      summary: 'The significand with the larger exponent first. By exponent alone: when the exponents are equal either may be the larger, and the near path, which forms both differences, sorts that out.',
      ports, symbol: { kind: 'box', label: 'SWAP' },
      spec: ([ma, mb, ge]) => (ge ? [ma, mb] : [mb, ma]),
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** Pick the path's result, and the sign: the larger operand's, the other one's when the near path's X − Y went negative, ±0 for x − x. */
function nfSelect(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fnf_select${E}_${M}`, () => {
    const XE = xeOf(f), w = M + 5;
    const b = new Builder(10, 8, 4);
    b.pins('nm', 'ne', 'neg', 'eq', 'fm', 'fe', 'near', 'ge', 'sa', 'signB', 'rm');
    const sB = b.op1(MUX2, ['signB', 'sa', 'ge'], 'larger exponent\'s sign', 'sbig');
    const sS = b.op1(MUX2, ['sa', 'signB', 'ge'], 'the other sign', 'ssmall');
    b.next();
    const negSel = b.op1(AND, ['near', 'neg'], 'near, X < Y', 'negsel');
    const zero = b.op1(AND, ['near', 'eq'], 'x − x', 'cancel');
    b.next();
    const sg1 = b.op1(MUX2, [sB, sS, negSel], 'sign of the bigger', 'sg');
    const sign = b.op1(MUX2, [sg1, b.op1(equal(3), ['rm', b.op1(K(3, RM.RDN), [], undefined, 'rdnk')], 'RDN?', 'rdn'), zero], 'x − x = +0 (−0 in RDN)', 'zsign');
    b.wire(sign, 'sign');
    b.wire(b.op1(busMux2(w), ['fm', 'nm', 'near'], 'select the path', 'msel'), 'm');
    b.wire(b.op1(busMux2(XE), ['fe', 'ne', 'near'], 'and its exponent', 'esel'), 'e');
    const ports = [bus('nm', w, 'in'), bus('ne', XE, 'in'), bit('neg', 'in'), bit('eq', 'in'), bus('fm', w, 'in'), bus('fe', XE, 'in'), bit('near', 'in'), bit('ge', 'in'),
      bit('sa', 'in'), bit('signB', 'in'), bus('rm', 3, 'in'), bit('sign', 'out'), bus('e', XE, 'out'), bus('m', w, 'out')];
    return define({
      id: `fnf_select${E}_${M}`, name: `Near / far adder: select (${fmtName(f)})`, category: 'arithmetic',
      summary: 'One path\'s significand and exponent, the other\'s discarded. The sign is the larger exponent\'s operand\'s, or the other one\'s when the near path found X < Y; an exact x − x is +0, −0 when rounding down.',
      ports, symbol: { kind: 'box', label: 'SELECT' },
      spec: ([nm, ne, neg, eq, fm, fe, near, ge, sa, sB0, rm]) => {
        const sB = ge ? sa : sB0, sS = ge ? sB0 : sa;
        const sign = near && eq ? (rm === RM.RDN ? 1 : 0) : near && neg ? sS : sB;
        return [sign, near ? ne : fe, near ? nm : fm];
      },
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** The near / far adder's own blocks (the paths, the rounder and the special cases are drawn with them). */
export const fnfBlocks = (f: FpFormat): ComponentDef[] => [FNF_SIGN, nfExp(f), nfSwap(f), nfSelect(f)];

/** Where the near / far adder's stages sit (kept apart so a tuning script can move them). */
export const FNF_AT: Record<'ua' | 'ub' | 'sign' | 'exp' | 'swap' | 'far' | 'near' | 'sel' | 'rnd' | 'special', [number, number]> & { pins: Record<string, [number, number]> } = {
  ua: [6, 0], ub: [6, 22], sign: [20, 15], exp: [40, 13], swap: [58, 4], near: [84, -1], far: [83, 16], sel: [98, -2], rnd: [114, 5], special: [128, 12],
  pins: { a: [0, 8], b: [0, 30], sub: [0, 19], rm: [0, 40], y: [150, 24], flags: [150, 26] },
};

/** The near / far adder's top level: unpack, signs and exponents, swap, the two paths side by side, select, round, special cases. */
function nfTop(f: FpFormat, near: ComponentDef): { instances: InstanceDef[]; nets: NetDef[]; pins: Record<string, [number, number]> } {
  const P = FNF_AT;
  const instances: InstanceDef[] = [
    { name: 'ua', def: fpUnpack(f), at: P.ua, flip: true, rot: 2, label: 'unpack a' }, // mirrored top to bottom: its class flags along the top edge
    { name: 'ub', def: fpUnpack(f), at: P.ub, label: 'unpack b' },
    { name: 'sign', def: FNF_SIGN, at: P.sign },
    { name: 'exp', def: nfExp(f), at: P.exp },
    { name: 'swap', def: nfSwap(f), at: P.swap },
    { name: 'far', def: farPath(f), at: P.far, label: 'far path' },
    { name: 'near', def: near, at: P.near, label: 'near path' },
    { name: 'sel', def: nfSelect(f), at: P.sel },
    { name: 'rnd', def: roundPack(f), at: P.rnd, label: 'round' },
    { name: 'special', def: faddSpecial(f), at: P.special },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'ua.x'] }, { name: 'b', ends: ['b', 'ub.x'] },
    { name: 'sa', ends: ['ua.sign', 'sign.sa', 'sel.sa', 'special.sa'], tags: ['sel.sa', 'special.sa'] }, { name: 'sb', ends: ['ub.sign', 'sign.sb'] }, { name: 'sub', ends: ['sub', 'sign.sub'] },
    { name: 'signB', ends: ['sign.signB', 'sel.signB', 'special.signB'], tags: true },
    { name: 'effSub', ends: ['sign.effSub', 'exp.effSub', 'far.sub', 'special.effSub'], tags: ['far.sub', 'special.effSub'] },
    { name: 'ea', ends: ['ua.exp', 'exp.ea'], via: { 'exp.ea': [[38, 12], [38, 18]] } }, { name: 'eb', ends: ['ub.exp', 'exp.eb'], via: { 'exp.eb': [[38, 26], [38, 22]] } },
    { name: 'ma', ends: ['ua.mant', 'swap.ma'], via: { 'swap.ma': [[55, 10], [55, 6]] } }, { name: 'mb', ends: ['ub.mant', 'swap.mb'], via: { 'swap.mb': [[56, 28], [56, 8]] } },
    { name: 'aExp≥bExp', ends: ['exp.ge', 'swap.ge', 'sel.ge'], tags: ['sel.ge'] },
    { name: 'd', ends: ['exp.d', 'far.d'] }, { name: 'd1', ends: ['exp.d1', 'near.d1'] },
    { name: 'eBig', ends: ['exp.eBig', 'far.eB', 'near.eB'] }, { name: 'eBig−1', ends: ['exp.eBigM1', 'near.em1'] },
    { name: 'near', ends: ['exp.near', 'sel.near'], tags: true },
    { name: 'mBig', ends: ['swap.mBig', 'far.mB', 'near.mB'] }, { name: 'mSmall', ends: ['swap.mSmall', 'far.mS', 'near.mS'] },
    { name: 'far m', ends: ['far.m', 'sel.fm'] }, { name: 'far e', ends: ['far.e', 'sel.fe'] },
    { name: 'near m', ends: ['near.m', 'sel.nm'] }, { name: 'near e', ends: ['near.e', 'sel.ne'] },
    { name: 'X < Y', ends: ['near.neg', 'sel.neg'] }, { name: 'X = Y', ends: ['near.eq', 'sel.eq'] },
    { name: 'rm', ends: ['rm', 'sel.rm', 'rnd.rm'], tags: true },
    { name: 'sign', ends: ['sel.sign', 'rnd.sign'] }, { name: 'e', ends: ['sel.e', 'rnd.e'] }, { name: 'm', ends: ['sel.m', 'rnd.m'] },
    { name: 'rounded', ends: ['rnd.y', 'special.ry'] }, { name: 'round flags', ends: ['rnd.flags', 'special.rflags'] },
    ...(['inf', 'nan', 'snan'] as const).flatMap((c): NetDef[] => [
      { name: `${c} a`, ends: [`ua.${c}`, `special.${c === 'inf' ? 'ia' : c === 'nan' ? 'na' : 'sna'}`], tags: true },
      { name: `${c} b`, ends: [`ub.${c}`, `special.${c === 'inf' ? 'ib' : c === 'nan' ? 'nb' : 'snb'}`], tags: true },
    ]),
    { name: 'y', ends: ['special.y', 'y'] }, { name: 'flags', ends: ['special.flags', 'flags'] },
  ];
  return { instances, nets, pins: P.pins };
}

// ---- the adder -------------------------------------------------------------------------------------

/** a ± b with a near path and a far path (see the file header): the same function as fpAdd, shallower and larger. */
export function fpAddNearFar(f: FpFormat, anticipate = true): ComponentDef {
  const { E, M } = f;
  const tag = anticipate ? 'fpnf' : 'fpnfc';
  return memo(`${tag}${E}_${M}`, () => {
    const N = 1 + E + M;
    return define({
      id: `${tag}${E}_${M}`, name: `${fmtName(f)} near / far adder${anticipate ? '' : ' (no anticipation)'}`, category: 'arithmetic',
      summary: 'The dual-path adder: swap by exponent only (no magnitude compare); a far path (effective addition, or exponents differing by 2 or more: long right shift, sticky, at most two places of left shift) and a near path (a subtraction with exponents within 1: no aligner, a leading-zero anticipator running beside the subtractor); a select; one shared rounder. Same results and flags as the single-path adder, in fewer gate delays and more gates.',
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bit('sub', 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FADD n/f' },
      spec: ([a, bb, s, rm]) => { const r = fpAddX(a, bb, !!s, f, rm); return [r.y, r.fl]; },
      netlist: () => nfTop(f, anticipate ? nearPath(f) : nearPathCounted(f)),
      hdl: { verilog: `// behaviourally: assign {y, flags} = sub ? fsub(a, b, rm) : fadd(a, b, rm);   (IEEE 754 binary)` },
    });
  });
}
