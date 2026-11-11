// Level 10b: floating point (IEEE 754), parametric in the format (E exponent bits, M fraction bits)
// so that a tiny format can be tested exhaustively and float32 is the same circuit, bigger.
//   unpack → align (shift right, keep a sticky bit) → add / multiply → normalize (count leading
//   zeros, shift left, or right for subnormals) → round (any of the five RISC-V modes) → pack,
//   plus the special cases (zero, subnormal, infinity, NaN) and the exception flags. One
//   normalize-and-round unit serves the adder, the multiplier and integer-to-float conversion.

import { orientGeom, symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { LIB_MUX2, andN, busMux2, equal, incrementer, muxTree, type Mux2Kind } from './combinational';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR, XNOR, XOR } from './gates';
import { condNegate, divStep, treeMul } from './muldiv';
import { DFF, register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';
import {
  F32, FLAG, bias as fbias, fpAddX, fpClass, fpFmaX, fpCmpX, fpFromIntX, fpMinMaxX, fpMulX, fpToIntX, overflowToInf, RM, roundUp, type FpFormat,
} from '../sim/fpref';
import { Builder } from './builder';
import { laid, layered } from './layered';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const pow2ceil = (n: number) => 2 ** Math.ceil(Math.log2(n));
const log2c = (n: number) => Math.ceil(Math.log2(n));

// The column-by-column netlist builder (shared with the other arithmetic files).
export { Builder };

const K = (w: number, v: number) => constWord(w, v >>> 0);

// ---- building blocks -----------------------------------------------------------------------------

/** Leading-zero counter (n a power of two): a tree that merges (any-one, count) pairs from both halves. */
export function lzc(n: number): ComponentDef {
  return memo(`lzc${n}`, () => {
    const k = Math.log2(n);
    if (n === 2) {
      return define({
        id: 'lzc2', name: '2-bit leading-zero count', category: 'arithmetic',
        summary: 'c = NOT a[1] (one leading zero if the top bit is 0); v = a[1] OR a[0] (there is a one).',
        ports: [bus('a', 2, 'in'), bit('c', 'out'), bit('v', 'out')],
        symbol: { kind: 'box', label: 'LZC2' },
        spec: ([a]) => [(a & 2) ? 0 : 1, a ? 1 : 0],
        netlist: () => ({
          pins: { a: [0, 4], c: [20, 2], v: [20, 8] },
          instances: [{ name: 's', def: splitter([1, 1]), at: [3, 2] }, { name: 'n', def: NOT, at: [10, 1] }, { name: 'o', def: OR, at: [10, 6] }],
          nets: [
            { name: 'a', ends: ['a', 's.in'] }, { name: 'a1', ends: ['s.o1', 'n.a', 'o.a'] }, { name: 'a0', ends: ['s.o0', 'o.b'] },
            { name: 'c', ends: ['n.y', 'c'] }, { name: 'v', ends: ['o.y', 'v'] },
          ],
        }),
      });
    }
    const H = lzc(n / 2), MX = busMux2(k - 1);
    const hg = symbolGeom(H);
    return define({
      id: `lzc${n}`, name: `${n}-bit leading-zero count`, category: 'arithmetic',
      summary: `Two ${n / 2}-bit counters. If the upper half has a one, the count is its count; otherwise it is ${n / 2} plus the lower half's count. Depth grows with log n.`,
      ports: [bus('a', n, 'in'), bus('c', k, 'out'), bit('v', 'out')],
      symbol: { kind: 'box', label: `LZC${n}` },
      spec: ([a]) => {
        let c = 0;
        while (c < n && !(Math.floor(a / 2 ** (n - 1 - c)) % 2)) c++;
        return [a === 0 ? n - 1 : c, a ? 1 : 0];
      },
      netlist: () => ({
        pins: { a: [0, hg.h + 2], c: [hg.w + 40, 6], v: [hg.w + 40, 14] },
        instances: [
          { name: 's', def: splitter([n / 2, n / 2]), at: [3, hg.h] },
          { name: 'hi', def: H, at: [10, 2], label: 'upper half' },
          { name: 'lo', def: H, at: [10, hg.h + 8], label: 'lower half' },
          { name: 'mx', def: MX, at: [hg.w + 18, 2] },
          { name: 'n', def: NOT, at: [hg.w + 18, 14] },
          { name: 'm', def: merger([k - 1, 1]), at: [hg.w + 30, 4] },
          { name: 'o', def: OR, at: [hg.w + 30, 12] },
        ],
        nets: [
          { name: 'a', ends: ['a', 's.in'] }, { name: 'aH', ends: ['s.o1', 'hi.a'] }, { name: 'aL', ends: ['s.o0', 'lo.a'] },
          { name: 'cH', ends: ['hi.c', 'mx.b'] }, { name: 'cL', ends: ['lo.c', 'mx.a'] },
          { name: 'vH', ends: ['hi.v', 'mx.s', 'n.a', 'o.a'] }, { name: 'vL', ends: ['lo.v', 'o.b'] },
          { name: 'cLow', ends: ['mx.y', 'm.i0'] }, { name: 'cTop', ends: ['n.y', 'm.i1'] },
          { name: 'c', ends: ['m.out', 'c'] }, { name: 'v', ends: ['o.y', 'v'] },
        ],
      }),
    });
  });
}

/** Logarithmic left shifter (zero fill). */
export function shiftLeft(w: number, k: number, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  return memo(`shl${w}_${k}${mux.tag}`, () => {
    const b = new Builder();
    const s = b.op(splitter(ones(k)), ['s']);
    let cur = 'x';
    for (let j = 0; j < k; j++) {
      b.next();
      const d = 2 ** j;
      let shifted: string;
      if (d < w) {
        const sp = b.op(splitter([w - d, d]), [cur]);
        shifted = b.op1(merger([d, w - d]), [b.op1(K(d, 0), []), `${sp}.o0`]);
      } else shifted = b.op1(K(w, 0), []);
      cur = b.op1(mux.of(w), [cur, shifted, `${s}.o${j}`], `<< ${d}`);
    }
    b.wire(cur, 'y');
    return define({
      id: `shl${w}_${k}${mux.tag}`, name: `${w}-bit left shifter${mux.tag ? ' (RV16)' : ''}`, category: 'arithmetic',
      summary: `${k} stages; stage j shifts by 2^j when amount bit j is 1. Zeros enter from the right.`,
      ports: [bus('x', w, 'in'), bus('s', k, 'in'), bus('y', w, 'out')],
      symbol: { kind: 'box', label: '<<' },
      spec: w + k <= 40 ? ([x, s]) => [(x * 2 ** s) % 2 ** w] : undefined,
      netlist: () => ({ pins: { x: [0, 4], s: [0, 10], y: [b.right, 4] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Logarithmic right shifter that ORs every bit shifted out into a sticky bit. */
export function shiftRightSticky(w: number, k: number, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  return memo(`shrs${w}_${k}${mux.tag}`, () => {
    const b = new Builder();
    const s = b.op(splitter(ones(k)), ['s']);
    let cur = 'x';
    const st: string[] = [];
    for (let j = 0; j < k; j++) {
      b.next();
      const d = 2 ** j;
      let shifted: string, lost: string;
      if (d < w) {
        const sp = b.op(splitter([d, w - d]), [cur]);
        shifted = b.op1(merger([w - d, d]), [`${sp}.o1`, b.op1(K(d, 0), [])]);
        lost = d === 1 ? `${sp}.o0` : b.op1(NOT, [b.op1(isZero(d), [`${sp}.o0`])]);
      } else {
        shifted = b.op1(K(w, 0), []);
        lost = b.op1(NOT, [b.op1(isZero(w), [cur])]);
      }
      st.push(b.op1(AND, [`${s}.o${j}`, lost]));
      cur = b.op1(mux.of(w), [cur, shifted, `${s}.o${j}`], `>> ${d}`);
    }
    b.next();
    b.wire(cur, 'y');
    b.wire(st.length === 1 ? st[0] : b.op1(st.length === 2 ? OR : orN(st.length), st, 'sticky'), 'sticky');
    return define({
      id: `shrs${w}_${k}${mux.tag}`, name: `${w}-bit right shifter with sticky bit${mux.tag ? ' (RV16)' : ''}`, category: 'arithmetic',
      summary: 'Shifts right in log stages; any 1 that falls off the right end sets sticky, so rounding still knows the discarded part was not zero.',
      ports: [bus('x', w, 'in'), bus('s', k, 'in'), bus('y', w, 'out'), bit('sticky', 'out')],
      symbol: { kind: 'box', label: '>> sticky' },
      spec: w + k <= 40 ? ([x, s]) => [Math.floor(x / 2 ** s), x % 2 ** s ? 1 : 0] : undefined,
      netlist: laid(b, { room: true }),
    });
  });
}

/**
 * Incrementer with a parallel-prefix carry: bit i flips when every bit below it is 1, and those
 * "all ones below" signals come from a Kogge–Stone tree of ANDs (log2 n levels) instead of a
 * ripple of half adders (n levels). Used on the rounding paths, where the ripple was the longest chain.
 */
export function incFast(n: number): ComponentDef {
  return memo(`incf${n}`, () => {
    const b = new Builder();
    const sp = b.op(splitter(ones(n)), ['a']);
    // pre[i] = AND of bits 0 .. i (inclusive), by doubling spans
    let pre = Array.from({ length: n }, (_, i) => `${sp}.o${i}`);
    for (let d = 1; d < n; d *= 2) {
      b.next();
      pre = pre.map((p, i) => (i >= d ? b.op1(AND, [p, pre[i - d]]) : p));
    }
    b.next();
    const ys = Array.from({ length: n }, (_, i) => (i === 0 ? b.op1(NOT, [`${sp}.o0`]) : b.op1(XOR, [`${sp}.o${i}`, pre[i - 1]])));
    b.next();
    b.wire(b.op1(merger(ones(n)), ys), 'y');
    b.wire(pre[n - 1], 'cout');
    return define({
      id: `incf${n}`, name: `${n}-bit fast incrementer`, category: 'arithmetic',
      summary: `a + 1. Bit i flips when all lower bits are 1; a prefix tree of ANDs computes those conditions in ${Math.ceil(Math.log2(n))} levels instead of a ${n}-stage ripple.`,
      ports: [bus('a', n, 'in'), bus('y', n, 'out'), bit('cout', 'out')],
      symbol: { kind: 'box', label: '+1 (fast)' },
      spec: ([a]) => [(a + 1) % 2 ** n, a === 2 ** n - 1 ? 1 : 0],
      netlist: () => ({ pins: { a: [0, 4], y: [b.right, 4], cout: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Exponent arithmetic width: two's complement, wide enough for every intermediate exponent. */
const xeOf = (f: FpFormat) => (f.E + 3 <= 8 ? 8 : 16);

/** NOT (x = 0) for any width (a 1-bit word is its own "non-zero"). */
const nonZero = (b: Builder, x: string, w: number) => (w === 1 ? x : b.op1(NOT, [b.op1(isZero(w), [x])]));
/** OR of 1 to n signals. */
const anyOf = (b: Builder, xs: string[], label?: string) => (xs.length === 1 ? xs[0] : b.op1(xs.length === 2 ? OR : orN(xs.length), xs, label));
/** The 5-bit fflags word {NV, DZ, OF, UF, NX} from single bits ('' = 0). */
const flagWord = (b: Builder, fl: { nv?: string; dz?: string; of?: string; uf?: string; nx?: string }) => {
  const z = () => b.op1(TIE0, []);
  return b.op1(merger([1, 1, 1, 1, 1]), [fl.nx ?? z(), fl.uf ?? z(), fl.of ?? z(), fl.dz ?? z(), fl.nv ?? z()]);
};

/** Unpack an encoding: sign, effective exponent (subnormals use 1), significand with the hidden bit, and the class flags. */
export function fpUnpack(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpun${E}_${M}`, () => {
    const b = new Builder();
    const sp = b.op(splitter([M, E, 1]), ['x']);
    b.next();
    const ez = b.op1(isZero(E), [`${sp}.o1`], 'exp = 0');
    const eAll = b.op(splitter(ones(E)), [`${sp}.o1`]);
    const eo = b.op1(andN(E), Array.from({ length: E }, (_, i) => `${eAll}.o${i}`), 'exp = all 1s');
    const fz = b.op1(isZero(M), [`${sp}.o0`], 'frac = 0');
    const fq = b.op(splitter([M - 1, 1]), [`${sp}.o0`]);
    b.next();
    const hidden = b.op1(NOT, [ez], 'hidden bit');
    const e0 = b.op(splitter([1, E - 1]), [`${sp}.o1`]);
    const b0 = b.op1(OR, [`${e0}.o0`, ez]);
    const nfz = b.op1(NOT, [fz]);
    const nq = b.op1(NOT, [`${fq}.o1`], 'quiet bit = 0');
    b.next();
    b.wire(b.op1(merger([M, 1]), [`${sp}.o0`, hidden]), 'mant');
    b.wire(b.op1(merger([1, E - 1]), [b0, `${e0}.o1`]), 'exp');
    b.wire(b.op1(AND, [ez, fz]), 'zero');
    b.wire(b.op1(AND, [eo, fz]), 'inf');
    const nan = b.op1(AND, [eo, nfz]);
    b.wire(nan, 'nan');
    b.wire(b.op1(AND, [nan, nq]), 'snan');
    b.wire(`${sp}.o2`, 'sign');
    return define({
      id: `fpun${E}_${M}`, name: 'Float unpack', category: 'arithmetic',
      summary: 'Splits sign | exponent | fraction. The hidden leading 1 is present unless the exponent field is 0 (zero or subnormal); subnormals behave as if their exponent were 1. Exponent all ones means infinity (fraction 0) or NaN; a NaN whose top fraction bit (the quiet bit) is 0 is signaling.',
      ports: [bus('x', 1 + E + M, 'in'), bit('sign', 'out'), bus('exp', E, 'out'), bus('mant', M + 1, 'out'), bit('zero', 'out'), bit('inf', 'out'), bit('nan', 'out'), bit('snan', 'out')],
      symbol: { kind: 'box', label: 'UNPACK' },
      netlist: laid(b),
    });
  });
}

/**
 * The rounding decision for one magnitude, in any of the five modes: round up given the last
 * kept bit, the guard bit G and the sticky bit S, and whether an overflow goes to infinity
 * (otherwise it stops at the largest finite number).
 */
export const ROUND_DECIDE: ComponentDef = (() => {
  const b = new Builder();
  const r = b.op(splitter([1, 1, 1]), ['rm']);
  const nr = [0, 1, 2].map((i) => b.op1(NOT, [`${r}.o${i}`]));
  const ns = b.op1(NOT, ['sign']);
  const gs = b.name(b.op1(OR, ['g', 's'], 'inexact'), 'G|S');
  b.next();
  const rne = b.name(b.op1(andN(3), [nr[0], nr[1], nr[2]], 'RNE (000)'), 'RNE');
  const rdn = b.name(b.op1(andN(3), [nr[0], `${r}.o1`, nr[2]], 'RDN (010)'), 'RDN');
  const rup = b.name(b.op1(andN(3), [`${r}.o0`, `${r}.o1`, nr[2]], 'RUP (011)'), 'RUP');
  const rmm = b.name(b.op1(andN(3), [nr[0], nr[1], `${r}.o2`], 'RMM (100)'), 'RMM');
  const sl = b.op1(OR, ['s', 'lsb']);
  b.next();
  const upNE = b.op1(andN(3), [rne, 'g', sl], 'ties to even');
  const upDN = b.op1(andN(3), [rdn, 'sign', gs], 'down: away if negative');
  const upUP = b.op1(andN(3), [rup, ns, gs], 'up: away if positive');
  const upMM = b.op1(AND, [rmm, 'g'], 'ties away');
  const infDN = b.op1(AND, [rdn, 'sign']), infUP = b.op1(AND, [rup, ns]);
  b.next();
  b.wire(b.op1(orN(4), [upNE, upDN, upUP, upMM], 'round up'), 'up');
  b.wire(b.op1(orN(4), [rne, rmm, infDN, infUP], 'overflow → ∞'), 'toInf');
  return define({
    id: 'fpround', name: 'Rounding decision', category: 'arithmetic',
    summary: 'RNE rounds up when G and (S or the last bit); RTZ never; RDN when negative and inexact; RUP when positive and inexact; RMM whenever G. An overflow becomes ∞ in RNE and RMM, and in the direction being rounded towards; otherwise the largest finite number. Reserved modes (5, 6) behave as RTZ.',
    ports: [bus('rm', 3, 'in'), bit('sign', 'in'), bit('lsb', 'in'), bit('g', 'in'), bit('s', 'in'), bit('up', 'out'), bit('toInf', 'out')],
    symbol: { kind: 'box', label: 'ROUND?' },
    spec: ([rm, sign, lsb, g, s]) => [roundUp(rm, sign, !!lsb, !!g, !!s) ? 1 : 0, overflowToInf(rm, sign) ? 1 : 0],
    netlist: () => ({ pins: { rm: [0, 2], sign: [0, 6], lsb: [0, 10], g: [0, 14], s: [0, 18], up: [b.right, 4], toInf: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    hdl: {
      verilog: `module round_decide (input logic [2:0] rm, input logic sign, lsb, g, s, output logic up, toInf);
  always_comb case (rm)
    3'd0: begin up = g & (s | lsb);     toInf = 1'b1;  end   // RNE: ties to even
    3'd2: begin up = sign & (g | s);    toInf = sign;  end   // RDN: towards -inf
    3'd3: begin up = ~sign & (g | s);   toInf = ~sign; end   // RUP: towards +inf
    3'd4: begin up = g;                 toInf = 1'b1;  end   // RMM: ties away from zero
    default: begin up = 1'b0;           toInf = 1'b0;  end   // RTZ (and reserved 5, 6)
  endcase
endmodule`,
    },
  });
})();

// ---- normalize & round's blocks ------------------------------------------------------------------------------------------------
// Drawn as its stages (circuit eyeballing, 2026-11-08): the shift amounts, the left shift, the right shift for a subnormal, the
// rounding, the packing. The gates are the ones the flat drawing had.

/** Bit length of a non-negative integer below 2^53. */
const bitLen = (x: number) => { let n = 0; while (x >= 1) { x = Math.floor(x / 2); n++; } return n; };

/** The shift amounts: count the leading zeros; shift them out (L) as far as the exponent allows, or right (R) below it. */
function nrAmount(f: FpFormat, w: number): ComponentDef {
  const { E, M } = f;
  return memo(`fnr_amt${E}_${M}_${w}`, () => {
    const XE = xeOf(f), P = pow2ceil(w + 1), k = Math.log2(P), T = 2 ** XE;
    const b = new Builder(10, 8, 4);
    b.pins('mant', 'exp');
    // leading zeros (padded with ones below, so an all-zero significand counts w)
    const pad = b.op1(merger([P - w, w]), [b.op1(K(P - w, 2 ** (P - w) - 1), [], undefined, 'ones'), 'mant'], undefined, 'pad');
    b.next();
    const lz = b.op(lzc(P), [pad], 'leading zeros', 'lz');
    b.next();
    const c = b.op1(merger([k, XE - k]), [`${lz}.c`, b.op1(K(XE - k, 0), [], undefined, 'cz')], undefined, 'cw');
    const em1 = `${b.op(koggeStone(XE), ['exp', b.op1(K(XE, 2 ** XE - 1), [], undefined, 'm1'), b.op1(TIE0, [], undefined, 'c0')], 'exp − 1', 'dec')}.s`;
    b.next();
    const t = b.op(addSubFast(XE), [em1, c, b.op1(TIE1, [], undefined, 'one')], 'exp − 1 − lz', 'room');
    const canNorm = b.name(b.op1(NOT, [`${t}.n`], 'can normalize?', 'can'), 'canNormalize');
    const es = b.op(splitter([k, XE - 1 - k, 1]), [em1], undefined, 'es');
    const em1Neg = `${es}.o2`;
    const negEm1 = b.op(addSubFast(XE), [b.op1(K(XE, 0), [], undefined, 'zero'), em1, b.op1(TIE1, [], undefined, 'one2')], '1 − exp', 'neg');
    b.next();
    const Lalt = b.op1(busMux2(k), [`${es}.o0`, b.op1(K(k, 0), [], undefined, 'l0'), em1Neg], 'as far as exp allows', 'lalt');
    b.wire(b.op1(busMux2(k), [Lalt, `${lz}.c`, canNorm], 'left shift', 'lsel'), 'L');
    const ns = b.op(splitter([k, XE - k]), [`${negEm1}.s`], undefined, 'ns');
    const hiNZ = b.op1(NOT, [b.op1(isZero(XE - k), [`${ns}.o1`], undefined, 'hiz')], undefined, 'hinz');
    const Rsat = b.op1(busMux2(k), [`${ns}.o0`, b.op1(K(k, 2 ** k - 1), [], undefined, 'rmax'), hiNZ], 'saturate', 'rsat');
    b.wire(b.op1(bitwise('and', k), [Rsat, b.op1(fanout(k), [em1Neg], undefined, 'neg1')], 'right shift', 'rgate'), 'R');
    const eNorm = b.op1(incFast(XE), [`${t}.s`], undefined, 'enorm');
    b.wire(b.op1(busMux2(XE), [b.op1(K(XE, 1), [], undefined, 'emin'), eNorm, canNorm], 'exponent after the shift', 'esel'), 'e');
    const ports = [bus('mant', w, 'in'), bus('exp', XE, 'in'), bus('L', k, 'out'), bus('R', k, 'out'), bus('e', XE, 'out')];
    return define({
      id: `fnr_amt${E}_${M}_${w}`, name: `Normalize & round: shift amounts (${w}-bit)`, category: 'arithmetic',
      summary: 'Count the leading zeros lz. If exp − 1 − lz ≥ 0 shift them all out (L = lz, the exponent drops by lz); else shift only as far as the smallest exponent allows (L = exp − 1, the result is subnormal); and when exp < 1 already, shift right instead (R = 1 − exp, saturated). e is the exponent after the shift.',
      ports, symbol: { kind: 'box', label: 'SHIFT AMOUNT' },
      spec: ([mant, exp]) => {
        const c = mant ? w - bitLen(mant) : w, em1 = (exp + T - 1) % T, t = (em1 - c + T) % T, can = t < T / 2, neg = em1 >= T / 2;
        const L = can ? c : neg ? 0 : em1 % P, n1 = (T - em1) % T, Rs = Math.floor(n1 / P) ? P - 1 : n1 % P;
        return [L, neg ? Rs : 0, can ? (t + 1) % T : 1];
      },
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** Rounding: the guard bit G and sticky bit S below the kept M + 1 bits decide (rounding mode rm), tininess after rounding. */
function nrRound(f: FpFormat, w: number): ComponentDef {
  const { E, M } = f;
  return memo(`fnr_round${E}_${M}_${w}`, () => {
    const b = new Builder(10, 8, 4);
    b.pins('m', 'sticky', 'stin', 'rm', 'sign');
    // G = first dropped bit, Rb = the next one, S2 = OR of everything below Rb
    const parts = b.op(splitter([w - M - 2, 1, M + 1]), ['m'], undefined, 'parts');
    b.name(`${parts}.o2`, 'kept'); // names for the pointers a re-placed drawing may draw
    let Rb: string, S2: string;
    if (w - M - 2 === 1) {
      Rb = `${parts}.o0`;
      S2 = anyOf(b, ['sticky', 'stin']);
    } else {
      const rs = b.op(splitter([w - M - 3, 1]), [`${parts}.o0`], undefined, 'rs');
      Rb = `${rs}.o1`;
      S2 = anyOf(b, [nonZero(b, `${rs}.o0`, w - M - 3), 'sticky', 'stin']);
    }
    b.name(Rb, 'R'); b.name(S2, 'below R');
    b.next();
    const S = b.name(b.op1(OR, [Rb, S2], 'sticky S', 'sor'), 'S');
    const G = b.name(`${parts}.o1`, 'G');
    const lsb = b.op(splitter([1, M]), [`${parts}.o2`], undefined, 'lsb');
    const kt = b.op(splitter([M, 1]), [`${parts}.o2`], undefined, 'kt');
    b.next();
    b.name(`${lsb}.o0`, 'lsb'); b.name(`${kt}.o1`, 'top bit'); b.name(`${kt}.o0`, 'fraction');
    const rd = b.op(ROUND_DECIDE, ['rm', 'sign', `${lsb}.o0`, G, S], 'round up?', 'rd');
    const inc = b.name(`${rd}.up`, 'up');
    b.wire(b.op1(OR, [G, S], 'inexact', 'nx'), 'inexact');
    // tininess after rounding: would rounding to M + 1 bits (G becomes the last bit) reach 2^emin?
    const kf = b.op(splitter(ones(M)), [`${kt}.o0`], undefined, 'kf');
    const fracOnes = b.op1(andN(M), Array.from({ length: M }, (_, i) => `${kf}.o${i}`), 'fraction all 1s', 'ones');
    const rd2 = b.op(ROUND_DECIDE, ['rm', 'sign', b.op1(TIE1, [], undefined, 'one'), Rb, S2], 'unbounded rounding', 'rd2');
    b.next();
    const mi = b.op(incFast(M + 1), [`${parts}.o2`], undefined, 'inc');
    b.wire(b.op1(busMux2(M + 1), [`${parts}.o2`, `${mi}.y`, inc], 'rounded', 'msel'), 'mr');
    b.wire(b.op1(AND, [inc, `${mi}.cout`], 'carry out', 'carry'), 'carry');
    const reach = b.op1(andN(3), [fracOnes, G, `${rd2}.up`], undefined, 'reach');
    b.next();
    b.wire(b.op1(AND, [b.op1(NOT, [`${kt}.o1`], undefined, 'nhid'), b.op1(NOT, [reach], undefined, 'nreach')], 'tiny?', 'tiny'), 'tiny');
    b.wire(`${rd}.toInf`, 'toInf');
    const ports = [bus('m', w, 'in'), bit('sticky', 'in'), bit('stin', 'in'), bus('rm', 3, 'in'), bit('sign', 'in'),
      bus('mr', M + 1, 'out'), bit('carry', 'out'), bit('toInf', 'out'), bit('inexact', 'out'), bit('tiny', 'out')];
    const D = w - M - 2;
    return define({
      id: `fnr_round${E}_${M}_${w}`, name: `Normalize & round: rounding (${w}-bit)`, category: 'arithmetic',
      summary: 'The top M + 1 bits are kept. G is the first bit below them, S the OR of everything further down (and the sticky bits). The rounding decision adds 1 or not; a carry out of the top is reported. inexact = G or S. tiny: the result would stay below 2^emin even rounded with an unbounded exponent.',
      ports, symbol: { kind: 'box', label: 'ROUND' },
      spec: ([m, sticky, stin, rm, sign]) => {
        const low = m % 2 ** D, G = Math.floor(m / 2 ** D) % 2, kept = Math.floor(m / 2 ** (D + 1));
        const Rb = D === 1 ? low : Math.floor(low / 2 ** (D - 1)) % 2;
        const S2 = (D === 1 ? 0 : low % 2 ** (D - 1)) || sticky || stin ? 1 : 0, S = Rb || S2 ? 1 : 0;
        const up = roundUp(rm, sign, !!(kept % 2), !!G, !!S), full = 2 ** (M + 1) - 1;
        const reach = kept % 2 ** M === 2 ** M - 1 && G && roundUp(rm, sign, true, !!Rb, !!S2);
        return [up ? (kept + 1) % (full + 1) : kept, up && kept === full ? 1 : 0, overflowToInf(rm, sign) ? 1 : 0, G || S ? 1 : 0,
          kept < 2 ** M && !reach ? 1 : 0];
      },
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** Packing: a carry bumps the exponent; past the top the result is ∞ or the largest finite number; zeros and subnormals get exponent 0. */
function nrPack(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fnr_pack${E}_${M}`, () => {
    const XE = xeOf(f), T = 2 ** XE;
    const b = new Builder(10, 8, 4);
    b.pins('mr', 'carry', 'toInf', 'inexact', 'tiny', 'e', 'sign');
    const eInc = b.op1(incFast(XE), ['e'], 'e + 1', 'einc');
    const geTop = b.op1(NOT, [`${b.op(addSubFast(XE), ['e', b.op1(K(XE, 2 ** E - 1), [], undefined, 'max'), b.op1(TIE1, [], undefined, 'one')], 'e ≥ max?', 'cmp')}.n`], undefined, 'ge');
    const atTop = b.op1(equal(XE), ['e', b.op1(K(XE, 2 ** E - 2), [], undefined, 'max1')], 'e = max − 1?', 'at');
    b.next();
    const ms = b.op(splitter([M, 1]), ['mr'], undefined, 'ms');
    b.name(`${ms}.o0`, 'fraction'); b.name(`${ms}.o1`, 'top bit'); b.name(geTop, 'e ≥ max'); // the pointers' names
    const hidden = b.op1(OR, [`${ms}.o1`, 'carry'], 'hidden bit', 'hid');
    const eF = b.op1(busMux2(XE), ['e', eInc, 'carry'], 'exp + carry', 'ef');
    b.next();
    const inf = b.name(b.op1(AND, [hidden, b.op1(OR, [geTop, b.op1(AND, ['carry', atTop], undefined, 'ct')], 'overflow?', 'ov')], undefined, 'inf'), 'ovf');
    const satMax = b.op1(AND, [inf, b.op1(NOT, ['toInf'], undefined, 'nti')], 'largest finite instead', 'sat');
    const ef = b.op(splitter([E, XE - E]), [eF], undefined, 'efs');
    b.name(`${ef}.o0`, 'exponent field');
    b.next();
    const expF = b.op1(bitwise('and', E), [`${ef}.o0`, b.op1(fanout(E), [hidden], undefined, 'hf')], 'exponent, 0 if subnormal', 'ez');
    const expOr = b.op(splitter([1, E - 1]), [b.op1(bitwise('or', E), [expF, b.op1(fanout(E), [inf], undefined, 'if')], 'all 1s on overflow', 'eo')], undefined, 'eos');
    b.name(`${expOr}.o0`, 'field bit 0'); b.name(`${expOr}.o1`, 'field bits 1+');
    const e0 = b.op1(AND, [`${expOr}.o0`, b.op1(NOT, [satMax], undefined, 'nsat')], undefined, 'e0');
    const fracOut = b.op1(bitwise('or', M), [b.op1(bitwise('and', M), [`${ms}.o0`, b.op1(fanout(M), [b.op1(NOT, [inf], undefined, 'ninf')], undefined, 'nf')], undefined, 'fz'),
      b.op1(fanout(M), [satMax], undefined, 'sf')], 'fraction', 'fo');
    b.next();
    b.wire(b.op1(merger([M, 1, E - 1, 1]), [fracOut, e0, `${expOr}.o1`, 'sign'], undefined, 'y'), 'y');
    b.wire(flagWord(b, { of: inf, uf: b.op1(AND, ['tiny', 'inexact'], 'UF', 'uf'), nx: b.op1(OR, ['inexact', inf], 'NX', 'nxo') }), 'flags');
    // the rounding's outputs in the order ROUND gives them, then the exponent and the sign
    const ports = [bus('mr', M + 1, 'in'), bit('carry', 'in'), bit('toInf', 'in'), bit('inexact', 'in'), bit('tiny', 'in'), bus('e', XE, 'in'), bit('sign', 'in'),
      bus('y', 1 + E + M, 'out'), bus('flags', 5, 'out')];
    return define({
      id: `fnr_pack${E}_${M}`, name: `Normalize & round: pack (${fmtName(f)})`, category: 'arithmetic',
      summary: 'A carry out of the rounding bumps the exponent. With no hidden bit the exponent field is 0 (a subnormal or zero). Past the top exponent: ∞, or the largest finite number when the rounding mode does not round toward ∞. Flags: OF on overflow, UF if tiny and inexact, NX if inexact or overflowed.',
      ports, symbol: { kind: 'box', label: 'PACK' },
      spec: ([mr, carry, toInf, nx, tiny, e, sign]) => {
        const geTop = (e - (2 ** E - 1) + T) % T < T / 2, atTop = e === 2 ** E - 2, hidden = Math.floor(mr / 2 ** M) || carry;
        const eF = carry ? (e + 1) % T : e, inf = !!hidden && (geTop || (!!carry && atTop)), sat = inf && !toInf;
        const ex = ((hidden ? eF % 2 ** E : 0) | (inf ? 2 ** E - 1 : 0)) - (sat ? 1 : 0);
        const frac = (inf ? 0 : mr % 2 ** M) | (sat ? 2 ** M - 1 : 0);
        return [frac + ex * 2 ** M + sign * 2 ** (E + M), (nx || inf ? 1 : 0) + (tiny && nx ? 2 : 0) + (inf ? 4 : 0)];
      },
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** Normalize & round's blocks, as the campaign's reference draws them (chips of their own). */
export const normRoundBlocks = (f: FpFormat, w: number): ComponentDef[] => [nrAmount(f, w), nrRound(f, w), nrPack(f)];

/** normRound's places (kept apart so a tuning script can move them). */
export const NR_AT: Record<'amt' | 'shl' | 'shr' | 'rnd' | 'pack', [number, number]> & { pins: Record<string, [number, number]> } = {
  amt: [8, 8], shl: [28, 4], shr: [40, 4], rnd: [60, 4], pack: [80, 4],
  pins: { mant: [0, 11], exp: [0, 13], stin: [0, 22], rm: [0, 24], sign: [0, 26], y: [100, 11], flags: [100, 13] },
};

/** Normalize & round's top level: shift amounts, the left shift, the right shift (subnormal), rounding, packing. */
function nrTop(f: FpFormat, w: number, mux: Mux2Kind): { instances: InstanceDef[]; nets: NetDef[]; pins: Record<string, [number, number]> } {
  const P = NR_AT, k = Math.log2(pow2ceil(w + 1));
  const instances: InstanceDef[] = [
    { name: 'amt', def: nrAmount(f, w), at: P.amt },
    { name: 'shl', def: shiftLeft(w, k, mux), at: P.shl, label: 'normalize' },
    { name: 'shr', def: shiftRightSticky(w, k, mux), at: P.shr, label: 'subnormal' },
    { name: 'rnd', def: nrRound(f, w), at: P.rnd },
    { name: 'pack', def: nrPack(f), at: P.pack },
  ];
  const nets: NetDef[] = [
    { name: 'mant', ends: ['mant', 'amt.mant', 'shl.x'], via: { 'shl.x': [[4, 11], [4, 6]] } }, { name: 'exp', ends: ['exp', 'amt.exp'] },
    { name: 'L', ends: ['amt.L', 'shl.s'] }, { name: 'R', ends: ['amt.R', 'shr.s'], via: { 'shr.s': [[38, 12], [38, 8]] } },
    { name: 'e', ends: ['amt.e', 'pack.e'], via: { 'pack.e': [[24, 14], [24, 16]] } },
    { name: 'normalized', ends: ['shl.y', 'shr.x'] }, { name: 'shifted', ends: ['shr.y', 'rnd.m'] }, { name: 'sticky', ends: ['shr.sticky', 'rnd.sticky'] },
    // stin, rm and sign come up to the rounding in a staircase
    { name: 'stin', ends: ['stin', 'rnd.stin'], via: { 'rnd.stin': [[56, 22], [56, 10]] } }, { name: 'rm', ends: ['rm', 'rnd.rm'], via: { 'rnd.rm': [[57, 24], [57, 12]] } },
    { name: 'sign', ends: ['sign', 'rnd.sign', 'pack.sign'], via: { 'rnd.sign': [[58, 26], [58, 14]], 'pack.sign': [[78, 26], [78, 18]] } },
    { name: 'rounded', ends: ['rnd.mr', 'pack.mr'] }, { name: 'carry', ends: ['rnd.carry', 'pack.carry'] }, { name: 'toInf', ends: ['rnd.toInf', 'pack.toInf'] },
    { name: 'inexact', ends: ['rnd.inexact', 'pack.inexact'] }, { name: 'tiny', ends: ['rnd.tiny', 'pack.tiny'] },
    { name: 'y', ends: ['pack.y', 'y'] }, { name: 'flags', ends: ['pack.flags', 'flags'] },
  ];
  return { instances, nets, pins: P.pins };
}

/**
 * Normalize and round: mant (w bits, its top bit has weight 2^exp) plus a sticky bit → the IEEE
 * encoding, rounded in mode rm, and the flags OF, UF, NX. Leading zeros are shifted out (left) as
 * far as the exponent allows; below the smallest exponent the significand is shifted right
 * instead (a subnormal). Tininess is detected after rounding: the result is tiny if, rounded to
 * M + 1 bits with an unbounded exponent, it would still be below 2^emin.
 */
export function normRound(f: FpFormat, w: number, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  const { E, M } = f;
  return memo(`fpnr${E}_${M}_${w}${mux.tag}`, () => {
    const XE = xeOf(f);
    if (w < M + 3) throw new Error('normRound: the significand needs a guard bit and a sticky bit below it');
    // the parts, made now (not when the drawing is first asked for): what they register is there as soon as the unit is
    nrAmount(f, w); nrRound(f, w); nrPack(f);
    const k = Math.log2(pow2ceil(w + 1));
    shiftLeft(w, k, mux); shiftRightSticky(w, k, mux);
    return define({
      id: `fpnr${E}_${M}_${w}${mux.tag}`, name: `Normalize & round (${w}-bit significand)${mux.tag ? ' (RV16)' : ''}`, category: 'arithmetic',
      summary: 'Counts leading zeros, shifts them out (or shifts right for a subnormal result), then rounds in mode rm using the guard bit G and the sticky bit S (round to nearest even: up if G and (S or the last kept bit)). A carry out of the rounding bumps the exponent; an exponent past the top becomes ∞ or the largest finite number, depending on the mode. Flags: NX if G or S, OF on overflow, UF if inexact and tiny after rounding.',
      ports: [bit('sign', 'in'), bus('exp', XE, 'in'), bus('mant', w, 'in'), bit('stin', 'in'), bus('rm', 3, 'in'), bus('y', 1 + E + M, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'NORMALIZE & ROUND' },
      netlist: () => nrTop(f, w, mux),
      hdl: {
        verilog: `// normalize & round (sketch): lz = leading zeros of mant; shift left by lz (or less, down to emin),
// shift right with sticky below emin; then
wire g = m[W-M-2], s = |m[W-M-3:0] | stin, lsb = m[W-M-1];
round_decide rd (.rm, .sign, .lsb, .g, .s, .up, .toInf);
wire [M:0] kept = m[W-1 -: M+1] + up;              // a carry out bumps the exponent
assign flags = {1'b0, 1'b0, ovf, tiny & (g | s), g | s | ovf};   // NV DZ OF UF NX
assign y = ovf ? (toInf ? {sign, {E{1'b1}}, {M{1'b0}}} : {sign, {E-1{1'b1}}, 1'b0, {M{1'b1}}})
               : {sign, e, kept[M-1:0]};`,
      },
    });
  });
}

const infValue = (b: Builder, f: FpFormat, sign: string) => b.op1(merger([f.M, f.E, 1]), [b.op1(K(f.M, 0), []), b.op1(K(f.E, 2 ** f.E - 1), []), sign]);
const nanValue = (b: Builder, f: FpFormat) => b.op1(K(1 + f.E + f.M, (2 ** f.E - 1) * 2 ** f.M + 2 ** (f.M - 1)), []);
const fmtName = (f: FpFormat) => (f.E === 8 && f.M === 23 ? 'float32' : f.E === 5 && f.M === 10 ? 'binary16' : `E${f.E}M${f.M}`);
const isMode = (b: Builder, rm: string, m: number, label?: string) => b.op1(equal(3), [rm, b.op1(K(3, m), [])], label);

/**
 * The special cases shared by the arithmetic units: NaN out (canonical) if `nan`, else infinity
 * of sign `infSign` if `anyInf`, else the rounded result; the flags are the rounding flags unless
 * the result is special, in which case only NV (`invalid`) can be raised.
 */
function specials(b: Builder, f: FpFormat, nr: string, nrFlags: string, nan: string, anyInf: string, infSign: string, invalid: string, dz?: string, mux: Mux2Kind = LIB_MUX2): void {
  const N = 1 + f.E + f.M;
  const y1 = b.op1(mux.of(N), [nr, infValue(b, f, infSign), anyInf], 'infinity');
  b.wire(b.op1(mux.of(N), [y1, nanValue(b, f), nan], 'NaN'), 'y');
  const special = b.op1(OR, [nan, anyInf]);
  b.wire(b.op1(busMux2(5), [nrFlags, flagWord(b, { nv: invalid, dz }), special], 'flags'), 'flags');
}

// ---- the adder's blocks -------------------------------------------------------------------------------------------------------
// The adder is drawn as its stages (circuit eyeballing, 2026-11-08): the control nets between them (which operand is larger,
// subtract, the signs) are box ports, not wires that cross every stage. The gates are the ones the flat drawing had.

/** The operand widths the adder's stages share. */
const addWidths = (f: FpFormat) => { const WA = f.M + 3; return { N: 1 + f.E + f.M, XE: xeOf(f), WA, kA: log2c(WA + 1), WS: f.M + 4 }; };

/** Signs: b's effective sign (sub flips it), the larger operand's sign, and whether the significands are subtracted. */
export const FADD_SIGN: ComponentDef = (() => {
  const b = new Builder(10, 8, 4);
  b.pins('sa', 'sb', 'sub', 'big');
  const sbEff = b.name(b.op1(XOR, ['sb', 'sub'], 'b sign (−b for fsub)', 'nb'), 'signB');
  b.next();
  b.wire(b.op1(MUX2, [sbEff, 'sa', 'big'], 'larger sign', 'bigs'), 'signBig');
  b.wire(b.op1(XOR, ['sa', sbEff], 'subtract?', 'sx'), 'effSub');
  b.wire(sbEff, 'signB');
  const ports = [bit('sa', 'in'), bit('sb', 'in'), bit('sub', 'in'), bit('big', 'in'), bit('effSub', 'out'), bit('signBig', 'out'), bit('signB', 'out')];
  return define({
    id: 'fadd_sign', name: 'FP adder: signs', category: 'arithmetic',
    summary: 'b\'s sign XOR sub (a − b is a + (−b)); the result takes the larger operand\'s sign; the significands are subtracted when the two signs differ.',
    ports, symbol: { kind: 'box', label: 'SIGNS' },
    spec: ([sa, sb, sub, big]) => { const nb = sb ^ sub; return [sa ^ nb, big ? sa : nb, nb]; },
    netlist: () => layered(ports, b, { gap: 8 }),
  });
})();

/** Which operand is larger in magnitude (the patterns without their signs, one subtractor), and the swap that puts it first. */
export function faddSwap(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fadd_swap${E}_${M}`, () => {
    const { N } = addWidths(f);
    // drawn by hand: the compare on top, fed straight from a and b; the four muxes in a column, each pair of inputs crossing once
    // on its way into its two muxes; which is larger reaches the selects as a label
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter([E + M, 1]), at: [5, 5] }, { name: 'sb', def: splitter([E + M, 1]), at: [8, 9] },
      { name: 'one', def: TIE1, at: [6, 15] },
      { name: 'cmp', def: addSubFast(E + M), at: [12, 3], label: '|a| ≥ |b| ?' },
      { name: 'eB', def: busMux2(E), at: [34, 16], label: 'larger exponent' }, { name: 'eS', def: busMux2(E), at: [34, 26], label: 'smaller exponent' },
      { name: 'mB', def: busMux2(M + 1), at: [34, 36], label: 'larger significand' }, { name: 'mS', def: busMux2(M + 1), at: [34, 46], label: 'smaller significand' },
    ];
    const nets: NetDef[] = [
      { name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] },
      { name: '|a|', ends: ['sa.o0', 'cmp.a'] }, { name: '|b|', ends: ['sb.o0', 'cmp.b'] }, { name: '1', ends: ['one.y', 'cmp.sub'] },
      { name: 'big', ends: ['cmp.cout', 'big', 'eB.s', 'eS.s', 'mB.s', 'mS.s'], tags: ['eB.s', 'eS.s', 'mB.s', 'mS.s'] },
      { name: 'eb', ends: ['eb', 'eB.a', 'eS.b'] }, { name: 'ea', ends: ['ea', 'eB.b', 'eS.a'] },
      { name: 'mb', ends: ['mb', 'mB.a', 'mS.b'] }, { name: 'ma', ends: ['ma', 'mB.b', 'mS.a'] },
      { name: 'eBig', ends: ['eB.y', 'eBig'] }, { name: 'eSmall', ends: ['eS.y', 'eSmall'] },
      { name: 'mBig', ends: ['mB.y', 'mBig'] }, { name: 'mSmall', ends: ['mS.y', 'mSmall'] },
    ];
    const pins: Record<string, [number, number]> = { a: [0, 7], b: [0, 11], eb: [0, 18], ea: [0, 20], mb: [0, 38], ma: [0, 40],
      big: [44, 7], eBig: [44, 19], eSmall: [44, 29], mBig: [44, 39], mSmall: [44, 49] };
    const ports = [bus('ea', E, 'in'), bus('ma', M + 1, 'in'), bus('eb', E, 'in'), bus('mb', M + 1, 'in'), bus('a', N, 'in'), bus('b', N, 'in'),
      bus('eBig', E, 'out'), bus('eSmall', E, 'out'), bit('big', 'out'), bus('mSmall', M + 1, 'out'), bus('mBig', M + 1, 'out')];
    const mag = (x: number) => x % 2 ** (E + M);
    return define({
      id: `fadd_swap${E}_${M}`, name: `FP adder: compare and swap (${fmtName(f)})`, category: 'arithmetic',
      summary: `|a| ≥ |b| from one ${E + M}-bit subtractor on the patterns without their sign bits (the exponent field sits above the fraction, so they compare in numeric order); four multiplexers then route the larger operand's exponent and significand to one side, the smaller's to the other.`,
      ports, symbol: { kind: 'box', label: 'SWAP' },
      spec: ([ea, ma, eb, mb, a, bb]) => { const g = mag(a) >= mag(bb); return g ? [ea, eb, 1, mb, ma] : [eb, ea, 0, ma, mb]; },
      netlist: () => ({ pins, instances, nets }),
    });
  });
}

/** The exponent difference, saturated to what the aligner can shift, and the larger exponent + 1 for normalize & round. */
export function faddExp(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fadd_exp${E}_${M}`, () => {
    const { XE, kA } = addWidths(f);
    const b = new Builder(10, 10, 4);
    b.pins('eBig', 'eSmall');
    const d = b.op(addSubFast(E), ['eBig', 'eSmall', b.op1(TIE1, [], undefined, 'one')], 'exponent difference', 'diff');
    b.next();
    let dsat: string;
    if (kA < E) {
      const ds = b.op(splitter([kA, E - kA]), [`${d}.s`], undefined, 'ds');
      const big = b.op1(NOT, [b.op1(isZero(E - kA), [`${ds}.o1`], 'too far?', 'far')], undefined, 'nfar');
      b.next();
      dsat = b.op1(busMux2(kA), [`${ds}.o0`, b.op1(K(kA, 2 ** kA - 1), [], undefined, 'max'), big], 'saturate', 'sat');
    } else dsat = kA === E ? `${d}.s` : b.op1(merger([E, kA - E]), [`${d}.s`, b.op1(K(kA - E, 0), [], undefined, 'zx')], undefined, 'dz');
    b.wire(dsat, 'd');
    b.wire(b.op1(incFast(XE), [b.op1(merger([E, XE - E]), ['eBig', b.op1(K(XE - E, 0), [], undefined, 'z')], undefined, 'ez')], 'larger + 1', 'inc'), 'ex');
    const ports = [bus('eBig', E, 'in'), bus('eSmall', E, 'in'), bus('d', kA, 'out'), bus('ex', XE, 'out')];
    return define({
      id: `fadd_exp${E}_${M}`, name: `FP adder: exponents (${fmtName(f)})`, category: 'arithmetic',
      summary: kA < E ? `The shift amount: larger − smaller exponent, saturated to ${2 ** kA - 1} (by then everything falls into the sticky bit). And the larger exponent + 1: the sum keeps a carry place above the significand.`
        : 'The shift amount: larger − smaller exponent. And the larger exponent + 1: the sum keeps a carry place above the significand.',
      ports, symbol: { kind: 'box', label: 'EXP' },
      spec: ([eB, eS]) => { const dd = (eB - eS + 2 ** E) % 2 ** E; return [kA < E ? (dd >= 2 ** kA ? 2 ** kA - 1 : dd) : dd, (eB + 1) % 2 ** XE]; },
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** The smaller significand, with two 0s below it, shifted right by d: what falls off becomes the sticky bit at the bottom. */
export function faddAlign(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fadd_align${E}_${M}`, () => {
    const { WA, kA, WS } = addWidths(f);
    const b = new Builder(10, 8, 4);
    b.pins('m', 'd');
    const al = b.op(shiftRightSticky(WA, kA), [b.op1(merger([2, M + 1]), [b.op1(K(2, 0), [], undefined, 'gr'), 'm'], undefined, 'mx'), 'd'], 'align', 'shr');
    b.next();
    b.wire(b.op1(merger([1, WA]), [`${al}.sticky`, `${al}.y`], undefined, 'my'), 'y');
    const ports = [bus('d', kA, 'in'), bus('m', M + 1, 'in'), bus('y', WS, 'out')];
    const shr = shiftRightSticky(WA, kA);
    return define({
      id: `fadd_align${E}_${M}`, name: `FP adder: align (${fmtName(f)})`, category: 'arithmetic',
      summary: `The smaller significand, two 0s below it (guard and round), shifted right by the exponent difference in the sticky shifter; the bits that fall off are ORed into one sticky bit at the bottom of the ${WS}-bit word.`,
      ports, symbol: { kind: 'box', label: 'ALIGN' },
      spec: ([d, m]) => { const [y, st] = shr.spec!([m * 4, d]); return [y * 2 + st]; },
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** {larger, 000} ± {aligned, sticky} in one adder / subtractor, with a carry place on top (never set by a subtraction). */
export function faddAdd(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fadd_add${E}_${M}`, () => {
    const { WA, WS } = addWidths(f);
    const b = new Builder(10, 8, 4);
    b.pins('mBig', 's', 'effSub');
    const opB = b.op1(merger([1, 2, M + 1]), [b.op1(TIE0, [], undefined, 'z0'), b.op1(K(2, 0), [], undefined, 'z1'), 'mBig'], undefined, 'big');
    b.next();
    const sum = b.op(addSubFast(WS), [opB, 's', 'effSub'], 'add / subtract', 'as');
    b.next();
    const top = b.op1(AND, [`${sum}.cout`, b.op1(NOT, ['effSub'], undefined, 'nsub')], 'carry', 'cy');
    b.next();
    b.wire(b.op1(merger([WS, 1]), [`${sum}.s`, top], undefined, 'sm'), 'sum');
    const ports = [bus('s', WS, 'in'), bus('mBig', M + 1, 'in'), bit('effSub', 'in'), bus('sum', WS + 1, 'out')];
    const add = addSubFast(WS);
    void WA;
    return define({
      id: `fadd_add${E}_${M}`, name: `FP adder: add or subtract (${fmtName(f)})`, category: 'arithmetic',
      summary: `The larger significand with three 0s below it, plus or minus the aligned one, in a ${WS}-bit fast adder / subtractor. A carry out of an addition is the sum's extra top bit; a subtraction's carry out only says it did not borrow.`,
      ports, symbol: { kind: 'box', label: 'ADD/SUB' },
      spec: ([s, mB, sub]) => { const [y, c] = add.spec!([mB * 8, s, sub]); return [y + (c && !sub ? 2 ** WS : 0)]; },
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** x − x: an exact cancellation gives +0, −0 in round-down; any other sum keeps the larger operand's sign. */
export function faddCancel(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fadd_cancel${E}_${M}`, () => {
    const { WS } = addWidths(f);
    const b = new Builder(10, 8, 4);
    b.pins('sum', 'effSub', 'signBig', 'rm');
    const zs = b.op1(isZero(WS + 1), ['sum'], 'sum = 0?', 'zero');
    b.next();
    const exact = b.name(b.op1(AND, ['effSub', zs], 'x − x', 'xx'), 'cancel');
    const rdn = isMode(b, 'rm', RM.RDN, 'RDN?');
    b.next();
    b.wire(b.op1(MUX2, ['signBig', rdn, exact], 'x − x = +0 (−0 in RDN)', 'sg'), 'sign');
    const ports = [bus('sum', WS + 1, 'in'), bit('effSub', 'in'), bit('signBig', 'in'), bus('rm', 3, 'in'), bit('sign', 'out')];
    return define({
      id: `fadd_cancel${E}_${M}`, name: `FP adder: sign of x − x (${fmtName(f)})`, category: 'arithmetic',
      summary: 'A subtraction that comes out exactly 0 gives +0, except −0 when rounding down (rm = RDN); any other result keeps the larger operand\'s sign.',
      ports, symbol: { kind: 'box', label: 'x − x' },
      spec: ([sum, sub, sB, rm]) => [sub && sum === 0 ? (rm === RM.RDN ? 1 : 0) : sB],
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** Hand-drawn blocks' places: each starts from a column layout; FP_LAY[block][part or 'pin:name'] moves a part or a pin by hand. */
export const FP_LAY: Record<string, Record<string, [number, number]>> = {
  // the class flags come in a staircase from below; ∞ and NaN replace the rounded result on top, NV alone the flags below
  fnf_select: { sbig: [10, 0], ssmall: [10, 8], sg: [20, 4], negsel: [16, 16], cancel: [16, 22], rdnk: [23, 15], rdn: [30, 12], zsign: [40, 6],
    msel: [34, 28], esel: [34, 36], 'pin:signB': [0, 2], 'pin:sa': [0, 4], 'pin:ge': [0, 7], 'pin:rm': [0, 15], 'pin:neg': [0, 17], 'pin:eq': [0, 23],
    'pin:fm': [0, 30], 'pin:nm': [0, 32], 'pin:near': [0, 35], 'pin:ne': [0, 38], 'pin:fe': [0, 40], 'pin:sign': [50, 9], 'pin:m': [50, 31], 'pin:e': [50, 39] },
  fmul_special: { rs: [36, 5], km: [26, 1], ke: [33, 3], iv: [40, 1], inf: [20, 12], iz: [20, 17], zi: [20, 22], nv: [28, 18], nan: [36, 21], y1: [44, -2], kn: [49, 2],
    yo: [56, -1], sp: [52, 16], fw: [52, 23], z3: [48, 25], z2: [48, 27], z1: [48, 29], z0: [48, 31], fl: [56, 26],
    'pin:ry': [0, 0], 'pin:ia': [0, 13], 'pin:ib': [0, 15], 'pin:zb': [0, 20], 'pin:za': [0, 25], 'pin:snb': [0, 28], 'pin:sna': [0, 30], 'pin:nb': [0, 32], 'pin:na': [0, 34],
    'pin:rflags': [0, 38], 'pin:y': [66, 2], 'pin:flags': [66, 29] },
  fadd_special: { infs: [20, 3], inf: [20, 12], ii: [20, 17], nv: [30, 19], nan: [38, 21], km: [33, 1], ke: [26, 3], iv: [40, 1], y1: [44, -2], kn: [49, 2], yo: [56, -1],
    sp: [52, 16], fw: [52, 23], z3: [48, 25], z2: [48, 27], z1: [48, 29], z0: [48, 31], fl: [56, 26],
    'pin:ry': [0, 0], 'pin:signB': [0, 5], 'pin:sa': [0, 7], 'pin:ia': [0, 13], 'pin:ib': [0, 15], 'pin:effSub': [0, 22], 'pin:snb': [0, 26], 'pin:sna': [0, 28],
    'pin:nb': [0, 30], 'pin:na': [0, 32], 'pin:rflags': [0, 36], 'pin:y': [66, 2], 'pin:flags': [66, 29] },
};
export type Part = Omit<InstanceDef, 'at'>;
/** Corner points for the nets reaching the given ends (end → points from the driver), set on a block's hand-drawn nets. */
export const withVias = (nets: NetDef[], vias: Record<string, [number, number][]>): NetDef[] =>
  nets.map((n) => { const v = Object.entries(vias).filter(([e]) => n.ends.includes(e)); return v.length ? { ...n, via: { ...n.via, ...Object.fromEntries(v) } } : n; });

/** A block drawn in columns (parts top to bottom in each), inputs down the left, outputs down the right; FP_LAY overrides. */
export function fpColumns(key: string, cols: (Part | false)[][], ins: string[], outs: string[], nets: NetDef[]): { instances: InstanceDef[]; nets: NetDef[]; pins: Record<string, [number, number]> } {
  const over = FP_LAY[key] ?? {};
  const instances: InstanceDef[] = [];
  let x = 8;
  for (const col of cols) {
    let y = 0, w = 0;
    for (const p of col) {
      if (!p) continue;
      const g = orientGeom(p.def, p.flip, p.rot);
      instances.push({ ...p, at: over[p.name] ?? [x, y] });
      y += g.h + 2; w = Math.max(w, g.w);
    }
    x += w + 6;
  }
  const pins: Record<string, [number, number]> = {};
  ins.forEach((p, i) => (pins[p] = over[`pin:${p}`] ?? [0, 2 + 2 * i]));
  outs.forEach((p, i) => (pins[p] = over[`pin:${p}`] ?? [x, 2 + 2 * i]));
  return { instances, nets, pins };
}

/**
 * The special cases' common back: ∞ (sign `sign`) over the rounded result where `inf`, the canonical NaN over that where
 * `nan`; the flags are NV alone (from `nv`) for a special result, else the rounding's. The gates specials() makes.
 */
function specialBack(f: FpFormat, mux: Mux2Kind, sign: string, inf: string[], nan: string[], nv: string[]): { cols: Part[][]; nets: NetDef[] } {
  const { E, M } = f, N = 1 + E + M;
  const cols: Part[][] = [
    [{ name: 'km', def: K(M, 0) }, { name: 'ke', def: K(E, 2 ** E - 1) }],
    [{ name: 'iv', def: merger([M, E, 1]), label: '∞' }, { name: 'z0', def: TIE0 }, { name: 'z1', def: TIE0 }, { name: 'z2', def: TIE0 }, { name: 'z3', def: TIE0 }],
    [{ name: 'y1', def: mux.of(N), label: 'infinity' }, { name: 'fw', def: merger([1, 1, 1, 1, 1]), flip: true, rot: 2 }, { name: 'sp', def: OR, label: 'special?' }],
    [{ name: 'kn', def: K(N, (2 ** E - 1) * 2 ** M + 2 ** (M - 1)), label: 'NaN' }, { name: 'yo', def: mux.of(N), label: 'NaN' }, { name: 'fl', def: busMux2(5), flip: true, rot: 2, label: 'flags' }],
  ];
  const nets: NetDef[] = [
    { name: 'rounded', ends: ['ry', 'y1.a'] }, { name: '0', ends: ['km.y', 'iv.i0'] }, { name: 'all 1s', ends: ['ke.y', 'iv.i1'] }, { name: '∞ sign', ends: [sign, 'iv.i2'] },
    { name: '∞', ends: ['iv.out', 'y1.b'] }, { name: 'an ∞', ends: [...inf, 'y1.s', 'sp.a'] }, { name: 'y1', ends: ['y1.y', 'yo.a'] }, { name: 'NaN', ends: ['kn.y', 'yo.b'] },
    { name: 'NaN?', ends: [...nan, 'yo.s', 'sp.b'] }, { name: 'y', ends: ['yo.y', 'y'] },
    ...[0, 1, 2, 3].map((i): NetDef => ({ name: `0 ${i}`, ends: [`z${i}.y`, `fw.i${i}`] })), { name: 'NV', ends: [...nv, 'fw.i4'] },
    { name: 'NV only', ends: ['fw.out', 'fl.b'] }, { name: 'round flags', ends: ['rflags', 'fl.a'] }, { name: 'special', ends: ['sp.y', 'fl.s'] }, { name: 'flags', ends: ['fl.y', 'flags'] },
  ];
  return { cols, nets };
}

/** The adder's special cases: invalid (a signaling NaN, or ∞ − ∞), NaN in or out, an infinite operand; else the rounded sum. */
export function faddSpecial(f: FpFormat, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  const { E, M } = f;
  return memo(`fadd_special${E}_${M}${mux.tag}`, () => {
    const { N } = addWidths(f);
    const key = 'fadd_special';
    const back = specialBack(f, mux, 'infs.y', ['inf.y'], ['nan.y'], ['nv.y']);
    const cols: Part[][] = [
      [{ name: 'infs', def: MUX2, label: '∞\'s sign' }, { name: 'inf', def: OR, label: 'an ∞' }, { name: 'ii', def: andN(3), label: '∞ − ∞' }],
      [{ name: 'nv', def: orN(3), flip: true, rot: 2, label: 'invalid' }],
      [{ name: 'nan', def: orN(3), flip: true, rot: 2, label: 'NaN?' }],
      ...back.cols,
    ];
    const nets: NetDef[] = [
      { name: 'ia', ends: ['ia', 'infs.s', 'inf.a', 'ii.i0'] }, { name: 'ib', ends: ['ib', 'inf.b', 'ii.i1'] }, { name: 'effSub', ends: ['effSub', 'ii.i2'] },
      { name: 'signB', ends: ['signB', 'infs.a'] }, { name: 'sa', ends: ['sa', 'infs.b'] },
      { name: 'sna', ends: ['sna', 'nv.i0'] }, { name: 'snb', ends: ['snb', 'nv.i1'] }, { name: '∞ − ∞', ends: ['ii.y', 'nv.i2'] },
      { name: 'na', ends: ['na', 'nan.i0'] }, { name: 'nb', ends: ['nb', 'nan.i1'] }, { name: 'nv', ends: ['nv.y', 'nan.i2', 'fw.i4'] },
      ...back.nets.filter((n) => n.name !== 'NV'),
    ];
    const ports = [bus('ry', N, 'in'), bus('rflags', 5, 'in'), bit('ia', 'in'), bit('ib', 'in'), bit('na', 'in'), bit('nb', 'in'), bit('sna', 'in'), bit('snb', 'in'),
      bit('effSub', 'in'), bit('sa', 'in'), bit('signB', 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')];
    const nanBits = (2 ** E - 1) * 2 ** M + 2 ** (M - 1);
    return define({
      id: `fadd_special${E}_${M}${mux.tag}`, name: `FP adder: special cases (${fmtName(f)}${mux.tag ? ', RV16' : ''})`, category: 'arithmetic',
      summary: 'Invalid (NV) is a signaling NaN in, or ∞ − ∞. Any NaN in, or invalid, gives the canonical NaN; else an infinite operand gives ∞ with its sign; else the rounded sum. A special result raises only NV.',
      ports, symbol: { kind: 'box', label: 'SPECIAL' },
      spec: ([ry, rfl, ia, ib, na, nb, sna, snb, sub, sa, sB]) => {
        const nv = sna || snb || (ia && ib && sub) ? 1 : 0, nan = na || nb || nv, inf = ia || ib;
        const infv = (ia ? sa : sB) * 2 ** (N - 1) + (2 ** E - 1) * 2 ** M;
        return [nan ? nanBits : inf ? infv : ry, nan || inf ? nv * FLAG.NV : rfl];
      },
      netlist: () => fpColumns(key, cols, ['ry', 'signB', 'sa', 'ia', 'ib', 'effSub', 'sna', 'snb', 'na', 'nb', 'rflags'], ['y', 'flags'], nets),
    });
  });
}

/** The adder's blocks, as the campaign's reference draws them (chips of their own, the level gives what is inside them). */
export const faddBlocks = (f: FpFormat, mux: Mux2Kind = LIB_MUX2): ComponentDef[] =>
  [faddSwap(f), FADD_SIGN, faddExp(f), faddAlign(f), faddAdd(f), faddCancel(f), faddSpecial(f, mux)];

/** Where the adder's stages sit, and the wires between them (hand-drawn: stages left to right, the control ports between). */
function faddTop(f: FpFormat, mux: Mux2Kind): { instances: InstanceDef[]; nets: NetDef[]; pins: Record<string, [number, number]> } {
  const { WS } = addWidths(f);
  const instances: InstanceDef[] = [
    { name: 'ua', def: fpUnpack(f), at: [6, 2], label: 'unpack a' },
    { name: 'ub', def: fpUnpack(f), at: [6, 22], label: 'unpack b' },
    { name: 'swap', def: faddSwap(f), at: [30, 4] },
    { name: 'sign', def: FADD_SIGN, at: [48, 24] },
    { name: 'exp', def: faddExp(f), at: [50, 5] },
    { name: 'align', def: faddAlign(f), at: [72, 8] },
    { name: 'add', def: faddAdd(f), at: [86, 9] },
    { name: 'z', def: TIE0, at: [106, 14] },
    { name: 'nr', def: normRound(f, WS + 1), at: [110, 7], label: 'normalize & round' },
    { name: 'cancel', def: faddCancel(f), at: [110, 22] },
    { name: 'special', def: faddSpecial(f, mux), at: [140, 10] },
  ];
  // labels for what runs far: the raw patterns into the compare, the class flags into the special cases, the signs and rm
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'ua.x', 'swap.a'], tags: ['swap.a'] }, { name: 'b', ends: ['b', 'ub.x', 'swap.b'], tags: ['swap.b'] },
    { name: 'ea', ends: ['ua.exp', 'swap.ea'] }, { name: 'eb', ends: ['ub.exp', 'swap.eb'] },
    { name: 'ma', ends: ['ua.mant', 'swap.ma'] }, { name: 'mb', ends: ['ub.mant', 'swap.mb'] },
    { name: 'sa', ends: ['ua.sign', 'sign.sa', 'special.sa'], tags: true }, { name: 'sb', ends: ['ub.sign', 'sign.sb'] }, { name: 'sub', ends: ['sub', 'sign.sub'] },
    { name: 'aBigger', ends: ['swap.big', 'sign.big'] },
    { name: 'eBig', ends: ['swap.eBig', 'exp.eBig'] }, { name: 'eSmall', ends: ['swap.eSmall', 'exp.eSmall'] },
    { name: 'mBig', ends: ['swap.mBig', 'add.mBig'], via: { 'add.mBig': [[84, 15], [84, 13]] } }, { name: 'mSmall', ends: ['swap.mSmall', 'align.m'] },
    { name: 'shift', ends: ['exp.d', 'align.d'] }, { name: 'aligned', ends: ['align.y', 'add.s'] },
    { name: 'effSub', ends: ['sign.effSub', 'add.effSub', 'cancel.effSub', 'special.effSub'], tags: true },
    { name: 'signBig', ends: ['sign.signBig', 'cancel.signBig'] }, { name: 'signB', ends: ['sign.signB', 'special.signB'], tags: true },
    { name: 'sum', ends: ['add.sum', 'nr.mant', 'cancel.sum'] }, { name: 'sign', ends: ['cancel.sign', 'nr.sign'], tags: true },
    { name: 'eBig + 1', ends: ['exp.ex', 'nr.exp'], tags: true }, { name: 'sticky in', ends: ['z.y', 'nr.stin'] },
    { name: 'rm', ends: ['rm', 'cancel.rm', 'nr.rm'], tags: true },
    { name: 'rounded', ends: ['nr.y', 'special.ry'] }, { name: 'round flags', ends: ['nr.flags', 'special.rflags'] },
    ...(['inf', 'nan', 'snan'] as const).flatMap((c): NetDef[] => [
      { name: `${c} a`, ends: [`ua.${c}`, `special.${c === 'inf' ? 'ia' : c === 'nan' ? 'na' : 'sna'}`], tags: true },
      { name: `${c} b`, ends: [`ub.${c}`, `special.${c === 'inf' ? 'ib' : c === 'nan' ? 'nb' : 'snb'}`], tags: true },
    ]),
    { name: 'y', ends: ['special.y', 'y'] }, { name: 'flags', ends: ['special.flags', 'flags'] },
  ];
  return { instances, nets, pins: { a: [0, 10], b: [0, 30], sub: [0, 42], rm: [0, 46], y: [160, 21], flags: [160, 23] } };
}

/** a ± b: swap so |big| ≥ |small|, align small by the exponent difference, add or subtract, normalize & round. */
export function fpAdd(f: FpFormat, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  const { E, M } = f;
  return memo(`fpadd${E}_${M}${mux.tag}`, () => {
    const { N } = addWidths(f);
    return define({
      id: `fpadd${E}_${M}${mux.tag}`, name: `${fmtName(f)} adder / subtractor${mux.tag ? ' (RV16)' : ''}`, category: 'arithmetic',
      summary: 'Compare magnitudes and swap; shift the smaller significand right by the exponent difference (guard, round and sticky bits keep track of what falls off); add or subtract; normalize and round in mode rm. Then the special cases: NaN in or ∞ − ∞ gives NaN (NV for ∞ − ∞ or a signaling NaN), an infinite operand gives infinity.',
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bit('sub', 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FADD' },
      spec: ([a, bb, s, rm]) => { const r = fpAddX(a, bb, !!s, f, rm); return [r.y, r.fl]; },
      netlist: () => faddTop(f, mux),
      hdl: { verilog: `// behaviourally: assign {y, flags} = sub ? fsub(a, b, rm) : fadd(a, b, rm);   (IEEE 754 binary)` },
    });
  });
}

// ---- the multiplier's blocks --------------------------------------------------------------------------------------------------
// Drawn as its stages like the adder: sign, significand product, exponent sum, normalize & round, special cases.

/** The product's exponent: ea + eb − bias + 1 (the product's top bit weighs 2), on the extended exponent width. */
export function fmulExp(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fmul_exp${E}_${M}`, () => {
    const XE = xeOf(f), B = fbias(f);
    const b = new Builder(10, 10, 4);
    b.pins('ea', 'eb');
    const za = b.op1(merger([E, XE - E]), ['ea', b.op1(K(XE - E, 0), [], undefined, 'za0')], undefined, 'za');
    const zb = b.op1(merger([E, XE - E]), ['eb', b.op1(K(XE - E, 0), [], undefined, 'zb0')], undefined, 'zb');
    b.next();
    const s1 = b.op(koggeStone(XE), [za, zb, b.op1(TIE0, [], undefined, 'c1')], 'ea + eb', 'sum');
    b.next();
    const s2 = b.op(koggeStone(XE), [`${s1}.s`, b.op1(K(XE, (1 - B + 2 ** XE) % 2 ** XE), [], undefined, 'k'), b.op1(TIE0, [], undefined, 'c2')], '− bias + 1', 'bias');
    b.wire(`${s2}.s`, 'e');
    const ports = [bus('ea', E, 'in'), bus('eb', E, 'in'), bus('e', XE, 'out')];
    return define({
      id: `fmul_exp${E}_${M}`, name: `FP multiplier: exponent (${fmtName(f)})`, category: 'arithmetic',
      summary: `ea + eb carries the bias twice: take one off (− ${B}), and add 1 because the product of two significands in [1, 2) has its top bit at weight 2. Two ${XE}-bit adders, with room for the sum's overflow and underflow.`,
      ports, symbol: { kind: 'box', label: 'EXP' },
      spec: ([ea, eb]) => [(ea + eb + 1 - B + 2 ** XE) % 2 ** XE],
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** The multiplier's special cases: NV for a signaling NaN or ∞ × 0, the canonical NaN, or ∞ with the product's sign. */
export function fmulSpecial(f: FpFormat, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  const { E, M } = f;
  return memo(`fmul_special${E}_${M}${mux.tag}`, () => {
    const N = 1 + E + M;
    const key = 'fmul_special';
    const back = specialBack(f, mux, 'rs.o1', ['inf.y'], ['nan.y'], ['nv.y']);
    // ∞ takes the product's sign, which normalize & round passes through as the rounded result's top bit
    const cols: Part[][] = [
      [{ name: 'inf', def: OR, label: 'an ∞' }, { name: 'iz', def: AND, label: '∞ × 0' }, { name: 'zi', def: AND, label: '0 × ∞' }],
      [{ name: 'rs', def: splitter([N - 1, 1]) }, { name: 'nv', def: orN(4), flip: true, rot: 2, label: 'invalid' }],
      [{ name: 'nan', def: orN(3), flip: true, rot: 2, label: 'NaN?' }],
      ...back.cols,
    ];
    const nets: NetDef[] = [
      { name: 'ia', ends: ['ia', 'inf.a', 'iz.a'] }, { name: 'ib', ends: ['ib', 'inf.b', 'zi.a'] }, { name: 'zb', ends: ['zb', 'iz.b'] }, { name: 'za', ends: ['za', 'zi.b'] },
      // the two ∞ × 0 terms into the balanced tree's second pair (either order)
      { name: '∞ × 0', ends: ['iz.y', 'nv.i3'] }, { name: '0 × ∞', ends: ['zi.y', 'nv.i2'] }, { name: 'sna', ends: ['sna', 'nv.i0'] }, { name: 'snb', ends: ['snb', 'nv.i1'] },
      { name: 'na', ends: ['na', 'nan.i0'] }, { name: 'nb', ends: ['nb', 'nan.i1'] }, { name: 'nv', ends: ['nv.y', 'nan.i2', 'fw.i4'] },
      { name: 'rounded', ends: ['ry', 'y1.a', 'rs.in'] },
      ...back.nets.filter((n) => n.name !== 'NV' && n.name !== 'rounded'),
    ];
    // a's class flags on top, b's below, the rounded product between: as they arrive on the multiplier's drawing
    const ports = [bit('sna', 'in'), bit('na', 'in'), bit('ia', 'in'), bit('za', 'in'), bus('ry', N, 'in'), bus('rflags', 5, 'in'),
      bit('zb', 'in'), bit('ib', 'in'), bit('nb', 'in'), bit('snb', 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')];
    const nanBits = (2 ** E - 1) * 2 ** M + 2 ** (M - 1);
    return define({
      id: `fmul_special${E}_${M}${mux.tag}`, name: `FP multiplier: special cases (${fmtName(f)}${mux.tag ? ', RV16' : ''})`, category: 'arithmetic',
      summary: 'Invalid (NV) is a signaling NaN in, or ∞ × 0 either way round. Any NaN in, or invalid, gives the canonical NaN; else an infinite operand gives ∞ with the product\'s sign (the rounded result\'s top bit: normalize & round passes it through); else the rounded product. A zero needs no case: a zero significand rounds to a signed zero.',
      ports, symbol: { kind: 'box', label: 'SPECIAL' },
      spec: ([sna, na, ia, za, ry, rfl, zb, ib, nb, snb]) => {
        const s = Math.floor(ry / 2 ** (N - 1));
        const nv = sna || snb || (ia && zb) || (za && ib) ? 1 : 0, nan = na || nb || nv, inf = ia || ib;
        return [nan ? nanBits : inf ? s * 2 ** (N - 1) + (2 ** E - 1) * 2 ** M : ry, nan || inf ? nv * FLAG.NV : rfl];
      },
      // the staircases drawn by hand: each class flag turns up where it crosses nothing
      netlist: () => fpColumns(key, cols, ['ry', 'ia', 'ib', 'zb', 'za', 'snb', 'sna', 'nb', 'na', 'rflags'], ['y', 'flags'], withVias(nets, {
        'rs.in': [[24, 0], [24, 7]], 'nv.i2': [[25, 24], [25, 21]], 'nv.i1': [[26, 28], [26, 23]], 'nv.i0': [[27, 30], [27, 25]], 'nan.i1': [[34, 32], [34, 24]],
        'nan.i0': [[35, 34], [35, 26]], 'fl.a': [[54, 38], [54, 30]],
      })),
    });
  });
}

/** The multiplier's blocks, as the campaign's reference draws them. */
export const fmulBlocks = (f: FpFormat, mux: Mux2Kind = LIB_MUX2): ComponentDef[] => [fmulExp(f), fmulSpecial(f, mux)];

/** fmulTop's places (kept apart so a tuning script can move them). */
export const FMUL_AT: Record<'ua' | 'ub' | 'sign' | 'mul' | 'exp' | 'z' | 'nr' | 'special', [number, number]> & { pins: Record<string, [number, number]> } = {
  ua: [6, 0], ub: [6, 18], sign: [19, 16], exp: [27, 14], mul: [42, 14], z: [58, 16], nr: [62, 9], special: [94, 0],
  pins: { a: [0, 8], b: [0, 26], rm: [0, 36], y: [114, 11], flags: [114, 13] },
};

/** Where the multiplier's stages sit (hand-drawn: unpack, product and exponent side by side, normalize & round, special cases). */
function fmulTop(f: FpFormat, mux: Mux2Kind): { instances: InstanceDef[]; nets: NetDef[]; pins: Record<string, [number, number]> } {
  const { M } = f, P = FMUL_AT;
  const instances: InstanceDef[] = [
    { name: 'ua', def: fpUnpack(f), at: P.ua, flip: true, rot: 2, label: 'unpack a' }, // mirrored top to bottom: its class flags along the top edge
    { name: 'ub', def: fpUnpack(f), at: P.ub, label: 'unpack b' },
    { name: 'sign', def: XOR, at: P.sign, label: 'sign' },
    { name: 'mul', def: treeMul(M + 1), at: P.mul, label: 'significand product' },
    { name: 'exp', def: fmulExp(f), at: P.exp },
    { name: 'z', def: TIE0, at: P.z },
    { name: 'nr', def: normRound(f, 2 * M + 2), at: P.nr, label: 'normalize & round' },
    { name: 'special', def: fmulSpecial(f, mux), at: P.special },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'ua.x'] }, { name: 'b', ends: ['b', 'ub.x'] },
    { name: 'sa', ends: ['ua.sign', 'sign.a'] }, { name: 'sb', ends: ['ub.sign', 'sign.b'] },
    { name: 'ma', ends: ['ua.mant', 'mul.a'], via: { 'mul.a': [[39, 10], [39, 16]] } }, { name: 'mb', ends: ['ub.mant', 'mul.b'], via: { 'mul.b': [[40, 24], [40, 18]] } },
    { name: 'ea', ends: ['ua.exp', 'exp.ea'] }, { name: 'eb', ends: ['ub.exp', 'exp.eb'] },
    { name: 'sign', ends: ['sign.y', 'nr.sign'], via: { 'nr.sign': [[24, 18], [24, 11]] } },
    { name: 'product', ends: ['mul.p', 'nr.mant'], via: { 'nr.mant': [[57, 17], [57, 15]] } }, { name: 'exponent', ends: ['exp.e', 'nr.exp'], via: { 'nr.exp': [[37, 17], [37, 13]] } },
    { name: 'sticky in', ends: ['z.y', 'nr.stin'] }, { name: 'rm', ends: ['rm', 'nr.rm'], via: { 'nr.rm': [[60, 36], [60, 19]] } },
    { name: 'rounded', ends: ['nr.y', 'special.ry'], via: { 'special.ry': [[85, 14], [85, 10]] } }, { name: 'round flags', ends: ['nr.flags', 'special.rflags'], via: { 'special.rflags': [[86, 16], [86, 12]] } },
    ...(['inf', 'zero', 'nan', 'snan'] as const).flatMap((c): NetDef[] => {
      const p = c === 'inf' ? 'i' : c === 'zero' ? 'z' : c === 'nan' ? 'n' : 'sn';
      // b's flags run under normalize & round and turn up just before the special cases, in a staircase that crosses nothing
      const k = ['zero', 'inf', 'nan', 'snan'].indexOf(c), [x, y] = [88 + k, 26 + 2 * k];
      return [{ name: `${c} a`, ends: [`ua.${c}`, `special.${p}a`] }, { name: `${c} b`, ends: [`ub.${c}`, `special.${p}b`], via: { [`special.${p}b`]: [[x, y], [x, y - 12]] } }];
    }),
    { name: 'y', ends: ['special.y', 'y'] }, { name: 'flags', ends: ['special.flags', 'flags'] },
  ];
  return { instances, nets, pins: P.pins };
}

/** a × b: multiply significands (a tree multiplier), add exponents, normalize & round. */
export function fpMul(f: FpFormat, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  const { E, M } = f;
  return memo(`fpmul${E}_${M}${mux.tag}`, () => {
    const N = 1 + E + M;
    fmulExp(f); fmulSpecial(f, mux); normRound(f, 2 * M + 2); treeMul(M + 1); // the parts, made now: they register as soon as the unit is
    return define({
      id: `fpmul${E}_${M}${mux.tag}`, name: `${fmtName(f)} multiplier${mux.tag ? ' (RV16)' : ''}`, category: 'arithmetic',
      summary: `Sign = XOR, exponent = ea + eb − bias, significand = a ${M + 1}×${M + 1} tree multiplier (the multiply chapter), then the shared normalize & round unit. ∞ × 0 is NaN (NV).`,
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FMUL' },
      spec: ([a, bb, rm]) => { const r = fpMulX(a, bb, f, rm); return [r.y, r.fl]; },
      netlist: () => fmulTop(f, mux),
      hdl: { verilog: '// behaviourally: assign {y, flags} = fmul(a, b, rm);   (IEEE 754 binary)' },
    });
  });
}

/** Integer → float (fcvt.s.w / fcvt.s.wu): take the magnitude and let normalize & round do the rest. */
export function fpFromInt(f: FpFormat, w = 32, mux: Mux2Kind = LIB_MUX2): ComponentDef {
  const { E, M } = f;
  return memo(`fpcvt${E}_${M}_${w}${mux.tag}`, () => {
    const XE = xeOf(f), N = 1 + E + M;
    const b = new Builder();
    const sp = b.op(splitter([w - 1, 1]), ['x']);
    const neg = b.op1(AND, [`${sp}.o1`, 'signed'], 'negative?');
    b.next();
    const mag = b.op1(condNegate(w), ['x', neg], '|x|');
    b.next();
    const nr = b.op(normRound(f, w, mux), [neg, b.op1(K(XE, w - 1 + fbias(f)), []), mag, b.op1(TIE0, []), 'rm'], 'normalize & round');
    b.wire(`${nr}.y`, 'y');
    b.wire(`${nr}.flags`, 'flags');
    return define({
      id: `fpcvt${E}_${M}_${w}${mux.tag}`, name: `int${w} → ${fmtName(f)}${mux.tag ? ' (RV16)' : ''}`, category: 'arithmetic',
      summary: `The magnitude of the integer is a significand whose top bit has weight 2^${w - 1}. Normalize & round shifts out the leading zeros; integers above 2^${M + 1} lose low bits and are rounded in mode rm (NX).`,
      ports: [bus('x', w, 'in'), bit('signed', 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'INT→FLOAT' },
      spec: ([x, s, rm]) => { const r = fpFromIntX(x, !!s, f, rm, w); return [r.y, r.fl]; },
      netlist: () => ({ pins: { x: [0, 4], signed: [0, 10], rm: [0, 14], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Float → integer, part 1: place the significand with its hidden bit at weight 2^(w−1) and shift it to the binary point (G and a sticky bit below). */
export function fpToIntAlign(f: FpFormat, w = 32): ComponentDef {
  const { E, M } = f;
  return memo(`fptoia${E}_${M}_${w}`, () => {
    const XE = xeOf(f), k = log2c(w + 2);
    if (w < M + 1) throw new Error('fpToInt: the integer must be at least as wide as the significand');
    const b = new Builder();
    const u = b.op(fpUnpack(f), ['a'], 'unpack');
    b.next();
    const ze = b.op1(merger([E, XE - E]), [`${u}.exp`, b.op1(K(XE - E, 0), [])]);
    const sAmt = b.op(addSubFast(XE), [b.op1(K(XE, w - 1 + fbias(f)), []), ze, b.op1(TIE1, [])], `(${w - 1} + bias) − exp`);
    b.next();
    const ss = b.op(splitter([k, XE - 1 - k, 1]), [`${sAmt}.s`]);
    const sat = b.op1(busMux2(k), [`${ss}.o0`, b.op1(K(k, 2 ** k - 1), []), nonZero(b, `${ss}.o1`, XE - 1 - k)], 'shift');
    const T = b.op1(merger([w - M, M + 1]), [b.op1(K(w - M, 0), []), `${u}.mant`]);
    b.next();
    const sh = b.op(shiftRightSticky(w + 1, k), [T, sat], 'align to the binary point');
    b.wire(`${sh}.y`, 't');
    b.wire(`${sh}.sticky`, 'sticky');
    b.wire(`${u}.sign`, 'sign');
    b.wire(`${u}.nan`, 'nan');
    b.wire(b.op1(orN(3), [`${u}.nan`, `${u}.inf`, `${ss}.o2`], 'NaN, ∞ or exponent too big'), 'bad');
    return define({
      id: `fptoia${E}_${M}_${w}`, name: `${fmtName(f)} → int${w}: align`, category: 'arithmetic',
      summary: `The significand is placed with its hidden bit at weight 2^${w - 1} and shifted right by (${w - 1} + bias) − exponent: t holds the integer part and, below it, G; everything further down is ORed into sticky. bad: NaN, ∞, or an exponent too big for any integer.`,
      ports: [bus('a', 1 + E + M, 'in'), bus('t', w + 1, 'out'), bit('sticky', 'out'), bit('sign', 'out'), bit('nan', 'out'), bit('bad', 'out')],
      symbol: { kind: 'box', label: 'F→I ALIGN' },
      netlist: laid(b, { keepOrder: true }),
    });
  });
}

/** Float → integer, part 2: round in mode rm, check the range, negate, or saturate with NV. */
export function fpToIntRound(f: FpFormat, w = 32): ComponentDef {
  const { E, M } = f;
  return memo(`fptoir${E}_${M}_${w}`, () => {
    const b = new Builder();
    const gi = b.op(splitter([1, w]), ['t']);
    const il = b.op(splitter([1, w - 1]), [`${gi}.o1`]);
    const rd = b.op(ROUND_DECIDE, ['rm', 'sign', `${il}.o0`, `${gi}.o0`, 'sticky'], 'round up?');
    const nx0 = b.op1(OR, [`${gi}.o0`, 'sticky'], 'inexact');
    b.next();
    const inc = b.op(incFast(w), [`${gi}.o1`]);
    const I = b.name(b.op1(busMux2(w), [`${gi}.o1`, `${inc}.y`, `${rd}.up`], 'rounded'), 'n');
    const carry = b.op1(AND, [`${rd}.up`, `${inc}.cout`]);
    b.next();
    // range: signed needs n ≤ 2^(w−1) − 1 (n ≤ 2^(w−1) if negative); unsigned n < 2^w, or n = 0 if negative
    const ts = b.op(splitter([w - 1, 1]), [I]);
    const lowZ = b.op1(isZero(w - 1), [`${ts}.o0`]);
    const nc = b.op1(NOT, [carry]), nTop = b.op1(NOT, [`${ts}.o1`]);
    const allZ = b.op1(AND, [lowZ, nTop]);
    b.next();
    const okSP = b.op1(AND, [nc, nTop]), okSN = b.op1(AND, [nc, b.op1(OR, [nTop, lowZ])]);
    const okUN = b.op1(AND, [nc, allZ]);
    b.next();
    const okS = b.op1(MUX2, [okSP, okSN, 'sign']), okU = b.op1(MUX2, [nc, okUN, 'sign']);
    const ok = b.op1(MUX2, [okU, okS, 'signed'], 'in range?');
    b.next();
    const invalid = b.name(b.op1(OR, ['bad', b.op1(NOT, [ok])], 'invalid'), 'NV');
    const val = b.op1(condNegate(w), [I, 'sign'], '±n');
    const satNeg = b.op1(AND, ['sign', b.op1(NOT, ['nan'])]);
    const nsn = b.op1(NOT, [satNeg]);
    const satTop = b.op1(MUX2, [nsn, satNeg, 'signed']);
    b.next();
    const satV = b.op1(merger([w - 1, 1]), [b.op1(fanout(w - 1), [nsn]), satTop], 'saturate');
    b.wire(b.op1(busMux2(w), [val, satV, invalid], 'result'), 'y');
    b.wire(flagWord(b, { nv: invalid, nx: b.op1(AND, [nx0, b.op1(NOT, [invalid])]) }), 'flags');
    return define({
      id: `fptoir${E}_${M}_${w}`, name: `${fmtName(f)} → int${w}: round`, category: 'arithmetic',
      summary: 'Round the aligned value in mode rm (G and sticky), check the range of the signed or unsigned result, negate a negative one; NaN, ∞ and out-of-range values saturate to the largest integer of their sign (NaN counts as positive) with NV, otherwise NX if inexact.',
      ports: [bus('t', w + 1, 'in'), bit('sticky', 'in'), bit('sign', 'in'), bit('nan', 'in'), bit('bad', 'in'), bit('signed', 'in'), bus('rm', 3, 'in'), bus('y', w, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'F→I ROUND' },
      netlist: laid(b, { room: true }),
    });
  });
}

/**
 * Float → integer (fcvt.w.s / fcvt.wu.s): place the significand so that its hidden bit has weight
 * 2^(w−1), shift right by (w − 1) − exponent keeping G and a sticky bit, round in mode rm, then
 * check the range. NaN, ∞ and out-of-range values saturate and raise NV. Two boxes (align, round),
 * which the pipelined FPU puts in two stages.
 */
export function fpToInt(f: FpFormat, w = 32): ComponentDef {
  const { E, M } = f;
  return memo(`fptoint${E}_${M}_${w}`, () => {
    const b = new Builder();
    const al = b.op(fpToIntAlign(f, w), ['a'], 'align');
    b.next();
    const rd = b.op(fpToIntRound(f, w), [`${al}.t`, `${al}.sticky`, `${al}.sign`, `${al}.nan`, `${al}.bad`, 'signed', 'rm'], 'round and saturate');
    b.wire(`${rd}.y`, 'y');
    b.wire(`${rd}.flags`, 'flags');
    const lim = (s: number) => (s ? `−2^${w - 1} … 2^${w - 1} − 1` : `0 … 2^${w} − 1`);
    return define({
      id: `fptoint${E}_${M}_${w}`, name: `${fmtName(f)} → int${w}`, category: 'arithmetic',
      summary: `The significand is placed with its hidden bit at weight 2^${w - 1} and shifted right by (${w - 1} + bias) − exponent; the bit below the binary point is G, everything further down sticky. Round in mode rm, then saturate: results outside ${lim(1)} (signed) or ${lim(0)} (unsigned), NaN and ∞ give the largest integer of their sign (NaN counts as positive) and raise NV.`,
      ports: [bus('a', 1 + E + M, 'in'), bit('signed', 'in'), bus('rm', 3, 'in'), bus('y', w, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FLOAT→INT' },
      spec: ([a, s, rm]) => { const r = fpToIntX(a, !!s, f, rm, w); return [r.y, r.fl]; },
      netlist: () => ({ pins: { a: [0, 4], signed: [0, 10], rm: [0, 14], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `module fcvt_w_s (input logic [31:0] a, input logic signed_, input logic [2:0] rm,
                 output logic [31:0] y, output logic [4:0] flags);
  logic sign; logic [7:0] e; logic [23:0] m;  logic nan, inf;
  fp_unpack u (.x(a), .sign, .exp(e), .mant(m), .nan, .inf, .zero(), .snan());
  wire signed [15:0] sh = 16'd158 - e;              // (31 + bias) - exp: shift to the binary point
  logic [32:0] t; logic st;                         // {integer, G}, and the sticky bit
  shift_right_sticky #(33) s (.x({m, 9'b0}), .s(sh[15:6] ? 6'd63 : sh[5:0]), .y(t), .sticky(st));
  logic up;  round_decide rd (.rm, .sign, .lsb(t[1]), .g(t[0]), .s(st), .up, .toInf());
  wire [32:0] n = t[32:1] + up;
  wire ok = signed_ ? (sign ? n <= 33'h80000000 : n <= 33'h7fffffff) : (sign ? n == 0 : ~n[32]);
  wire nv = nan | inf | sh[15] | ~ok;
  wire satNeg = sign & ~nan;
  assign y = nv ? {signed_ ? satNeg : ~satNeg, {31{~satNeg}}} : (sign ? -n[31:0] : n[31:0]);
  assign flags = {nv, 3'b000, ~nv & (t[0] | st)};
endmodule`,
      },
    });
  });
}

/** feq / flt / fle: magnitude compare plus the sign rules (−0 = +0, NaN compares false). */
export function fpCompare(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpcmp${E}_${M}`, () => {
    const b = new Builder();
    const ua = b.op(fpUnpack(f), ['a'], 'unpack a'), ub = b.op(fpUnpack(f), ['b'], 'unpack b');
    const ma = b.op(splitter([E + M, 1]), ['a']), mb = b.op(splitter([E + M, 1]), ['b']);
    b.next();
    const ge = b.name(`${b.op(addSubFast(E + M), [`${ma}.o0`, `${mb}.o0`, b.op1(TIE1, [])], '|a| ≥ |b|')}.cout`, '|a|≥|b|');
    const eq = b.name(b.op1(equal(E + M), [`${ma}.o0`, `${mb}.o0`], '|a| = |b|'), '|a|=|b|');
    const nan = b.name(b.op1(OR, [`${ua}.nan`, `${ub}.nan`]), 'unordered');
    const z2 = b.name(b.op1(AND, [`${ua}.zero`, `${ub}.zero`], '±0 = ±0'), 'bothZero');
    const same = b.op1(XNOR, [`${ua}.sign`, `${ub}.sign`]);
    const sa = `${ua}.sign`;
    b.next();
    const nsa = b.op1(NOT, [sa]), nz2 = b.op1(NOT, [z2]), neq = b.op1(NOT, [eq]), nge = b.op1(NOT, [ge]), nnan = b.op1(NOT, [nan]);
    b.next();
    const eqR = b.op1(OR, [b.op1(AND, [same, eq]), z2]);
    const ltR = b.op1(orN(3), [
      b.op1(andN(3), [b.op1(XOR, [sa, `${ub}.sign`]), sa, nz2]),
      b.op1(andN(3), [same, nsa, nge]),
      b.op1(andN(4), [same, sa, ge, neq]),
    ]);
    b.next();
    const eqO = b.op1(AND, [eqR, nnan]), ltO = b.op1(AND, [ltR, nnan]);
    b.wire(eqO, 'eq');
    b.wire(ltO, 'lt');
    b.wire(b.op1(OR, [eqO, ltO]), 'le');
    b.wire(nan, 'unord');
    b.wire(b.op1(OR, [`${ua}.snan`, `${ub}.snan`], 'signaling?'), 'snan');
    return define({
      id: `fpcmp${E}_${M}`, name: `${fmtName(f)} comparator`, category: 'arithmetic',
      summary: 'Sign-magnitude makes comparison nearly integer comparison: for two positive numbers the bit patterns order like integers; for two negatives the order flips. −0 equals +0, and any NaN makes every comparison false (unord). flt and fle raise NV on any NaN, feq only on a signaling one (snan).',
      ports: [bus('a', 1 + E + M, 'in'), bus('b', 1 + E + M, 'in'), bit('eq', 'out'), bit('lt', 'out'), bit('le', 'out'), bit('unord', 'out'), bit('snan', 'out')],
      symbol: { kind: 'box', label: 'FCMP' },
      spec: ([a, bb]) => [fpCmpX(a, bb, 'eq', f).y, fpCmpX(a, bb, 'lt', f).y, fpCmpX(a, bb, 'le', f).y, fpCmpX(a, bb, 'lt', f).fl ? 1 : 0, fpCmpX(a, bb, 'eq', f).fl ? 1 : 0],
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], eq: [b.right, 2], lt: [b.right, 6], le: [b.right, 10], unord: [b.right, 14], snan: [b.right, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * fmin / fmax (IEEE 754-2019 minimumNumber / maximumNumber): a comparator picks a or b; a NaN
 * operand loses to a number, two NaNs give the canonical NaN, −0 counts as smaller than +0, and
 * only a signaling NaN raises NV.
 */
export function fpMinMax(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpminmax${E}_${M}`, () => {
    const N = 1 + E + M;
    const b = new Builder();
    const ua = b.op(fpUnpack(f), ['a'], 'unpack a'), ub = b.op(fpUnpack(f), ['b'], 'unpack b');
    const c = b.op(fpCompare(f), ['a', 'b'], 'compare');
    b.next();
    const z2 = b.op1(AND, [`${ua}.zero`, `${ub}.zero`]);
    const nsa = b.op1(NOT, [`${ua}.sign`]), nsb = b.op1(NOT, [`${ub}.sign`]);
    const naN = b.op1(NOT, [`${ua}.nan`]);
    b.next();
    const aLess = b.name(b.op1(OR, [`${c}.lt`, b.op1(andN(3), [z2, `${ua}.sign`, nsb])], 'a < b (−0 < +0)'), 'aLess');
    const aMore = b.name(b.op1(OR, [b.op1(NOT, [`${c}.le`]), b.op1(andN(3), [z2, nsa, `${ub}.sign`])], 'a > b'), 'aMore');
    b.next();
    const want = b.op1(MUX2, [aLess, aMore, 'max']);
    const pickA = b.name(b.op1(OR, [`${ub}.nan`, b.op1(AND, [naN, want])], 'take a?'), 'pickA');
    const both = b.op1(AND, [`${ua}.nan`, `${ub}.nan`], 'both NaN');
    b.next();
    const y1 = b.op1(busMux2(N), ['b', 'a', pickA]);
    b.wire(b.op1(busMux2(N), [y1, nanValue(b, f), both], 'NaN'), 'y');
    b.wire(flagWord(b, { nv: `${c}.snan` }), 'flags');
    return define({
      id: `fpminmax${E}_${M}`, name: `${fmtName(f)} min / max`, category: 'arithmetic',
      summary: 'A comparator and a multiplexer. RISC-V follows IEEE 754-2019 minimumNumber / maximumNumber: if one operand is NaN the other is returned, two NaNs give the canonical NaN, −0 < +0, and NV only for a signaling NaN.',
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bit('max', 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FMIN/FMAX' },
      spec: ([a, bb, mx]) => { const r = fpMinMaxX(a, bb, !!mx, f); return [r.y, r.fl]; },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], max: [0, 16], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `module fminmax (input logic [31:0] a, b, input logic max, output logic [31:0] y, output logic [4:0] flags);
  logic eq, lt, le, unord, snan;  fcmp c (.a, .b, .eq, .lt, .le, .unord, .snan);
  wire z2 = ~|a[30:0] & ~|b[30:0];                  // both zero: -0 < +0
  wire aLess = lt | (z2 & a[31] & ~b[31]), aMore = ~le | (z2 & ~a[31] & b[31]);
  wire aNaN = &a[30:23] & |a[22:0], bNaN = &b[30:23] & |b[22:0];
  assign y = aNaN & bNaN ? 32'h7fc00000 : (bNaN | (~aNaN & (max ? aMore : aLess))) ? a : b;
  assign flags = {snan, 4'b0};
endmodule`,
      },
    });
  });
}

/** fclass: one bit per class, from the unpack flags. */
export function fpClassify(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpclass${E}_${M}`, () => {
    const b = new Builder();
    const u = b.op(fpUnpack(f), ['a'], 'unpack');
    const ms = b.op(splitter([M, 1]), [`${u}.mant`]);
    b.next();
    const s = `${u}.sign`, ns = b.op1(NOT, [s]);
    const sub = b.name(b.op1(AND, [b.op1(NOT, [`${ms}.o1`]), b.op1(NOT, [`${u}.zero`])], 'subnormal'), 'sub');
    const normal = b.name(b.op1(AND, [`${ms}.o1`, b.op1(NOT, [b.op1(OR, [`${u}.inf`, `${u}.nan`])])], 'normal'), 'norm');
    const qnan = b.op1(AND, [`${u}.nan`, b.op1(NOT, [`${u}.snan`])], 'quiet NaN');
    b.next();
    const cls = [
      [s, `${u}.inf`], [s, normal], [s, sub], [s, `${u}.zero`], [ns, `${u}.zero`], [ns, sub], [ns, normal], [ns, `${u}.inf`],
    ].map(([x, y]) => b.op1(AND, [x, y]));
    b.next();
    b.wire(b.op1(merger(ones(10)), [...cls, `${u}.snan`, qnan]), 'y');
    return define({
      id: `fpclass${E}_${M}`, name: `${fmtName(f)} classify`, category: 'arithmetic',
      summary: 'fclass.s: a one-hot 10-bit mask. Bits 0–7: −∞, −normal, −subnormal, −0, +0, +subnormal, +normal, +∞; bit 8 signaling NaN, bit 9 quiet NaN. Software tests a class with one AND.',
      ports: [bus('a', 1 + E + M, 'in'), bus('y', 10, 'out')],
      symbol: { kind: 'box', label: 'FCLASS' },
      spec: ([a]) => [fpClass(a, f)],
      netlist: () => ({ pins: { a: [0, 4], y: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- division and square root: iterative digit recurrences -------------------------------------

/**
 * Normalize a significand: shift out its leading zeros (a subnormal's) so the top bit is 1, and
 * lower the exponent to match. The exponent comes out XE bits wide, two's complement (it can drop
 * below 1). Division and square root need normalized operands; addition and multiplication don't.
 */
export function fpPrenorm(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fppre${E}_${M}`, () => {
    const XE = xeOf(f), P = pow2ceil(M + 1), k = Math.log2(P);
    const b = new Builder();
    const pad = P === M + 1 ? 'mant' : b.op1(merger([P - M - 1, M + 1]), [b.op1(K(P - M - 1, 2 ** (P - M - 1) - 1), []), 'mant']);
    b.next();
    const lz = b.op(lzc(P), [pad], 'leading zeros');
    b.next();
    b.wire(b.op1(shiftLeft(M + 1, k), ['mant', `${lz}.c`], 'normalize'), 'm');
    const ze = b.op1(merger([E, XE - E]), ['exp', b.op1(K(XE - E, 0), [])]);
    const zl = b.op1(merger([k, XE - k]), [`${lz}.c`, b.op1(K(XE - k, 0), [])]);
    b.wire(`${b.op(addSubFast(XE), [ze, zl, b.op1(TIE1, [])], 'exp − lz')}.s`, 'e');
    return define({
      id: `fppre${E}_${M}`, name: 'Prenormalize', category: 'arithmetic',
      summary: 'A subnormal significand has leading zeros. Count them, shift them out, and subtract the count from the exponent, so every non-zero operand looks like 1.f × 2^e (e may now be below the format\'s minimum).',
      ports: [bus('mant', M + 1, 'in'), bus('exp', E, 'in'), bus('m', M + 1, 'out'), bus('e', XE, 'out')],
      symbol: { kind: 'box', label: 'PRENORM' },
      spec: ([m, e]) => {
        if (m === 0) return [0, (e - (P > M + 1 ? M + 1 : M) + 2 ** XE) % 2 ** XE];
        let z = 0;
        while (m * 2 ** z < 2 ** M) z++;
        return [m * 2 ** z, (e - z + 2 ** XE) % 2 ** XE];
      },
      netlist: () => ({ pins: { mant: [0, 4], exp: [0, 10], m: [b.right, 4], e: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The control of an iterative unit: start (while idle) loads the datapath registers (load) and
 * sets busy; every busy cycle is one step (en); after n steps done is 1 for one cycle, with the
 * result on the outputs, and busy falls. n + 2 cycles from start to the edge that retires.
 */
export function iterControl(n: number): ComponentDef {
  return memo(`iterctl${n}`, () => {
    const cw = log2c(n + 1);
    const b = new Builder();
    const nb = b.op1(NOT, ['run.q']);
    const load = b.name(b.op1(AND, ['start', nb], 'load'), 'load');
    b.next();
    const en = b.name(b.op1(OR, [load, 'run.q'], 'step'), 'en');
    const inc = b.op1(incrementer(cw), ['cnt.q']);
    const eq = b.op1(equal(cw), ['cnt.q', b.op1(K(cw, n), [])], `count = ${n}?`);
    b.next();
    b.wire(b.op1(busMux2(cw), [inc, b.op1(K(cw, 0), []), load]), 'cnt.d');
    b.wire(en, 'cnt.en');
    b.add(register(cw), 'step count', 'cnt');
    const done = b.name(b.op1(AND, ['run.q', eq], 'done'), 'done');
    b.next();
    b.wire(b.op1(OR, [load, b.op1(AND, ['run.q', b.op1(NOT, [done])])], 'busy next'), 'run.d');
    b.add(DFF, 'busy', 'run');
    b.wire('clk', 'cnt.clk');
    b.wire('clk', 'run.clk');
    b.wire(load, 'load');
    b.wire(en, 'en');
    b.wire(done, 'done');
    b.wire('run.q', 'busy');
    return define({
      id: `iterctl${n}`, name: `Iteration control (${n} steps)`, category: 'sequential',
      summary: `A busy flip-flop and a step counter. start while idle loads the datapath (load) and sets busy; each busy cycle steps it (en = load OR busy); when the count reaches ${n}, done = 1 for one cycle and busy clears. ${n + 2} cycles from start to the edge that consumes the result.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bit('load', 'out'), bit('en', 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'ITER CTL' },
      netlist: () => ({ pins: { start: [0, 4], clk: [0, 10], load: [b.right, 2], en: [b.right, 6], done: [b.right, 10], busy: [b.right, 14] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `module iter_ctl #(parameter int N = ${n}) (input logic clk, start, output logic load, en, done, busy);
  logic [$clog2(N+1)-1:0] count;
  assign load = start & ~busy;
  assign en   = load | busy;
  assign done = busy & (count == N);
  always_ff @(posedge clk) begin
    if (en) count <= load ? '0 : count + 1;
    busy <= load | (busy & ~done);
  end
endmodule`,
      },
    });
  });
}

/**
 * One step of the restoring square root: bring down the next two radicand bits (r' = 4r + x2), try
 * to subtract 4q + 1 (the trial value for appending a 1 to the root), keep the difference if it fits.
 */
export function sqrtStep(n: number): ComponentDef {
  return memo(`sqrtstep${n}`, () => {
    const W = n + 3;
    const b = new Builder();
    const full = b.name(b.op1(merger([2, n + 1]), ['x2', 'r'], "r' = 4r + x2"), "r'");
    const t = b.name(b.op1(merger([2, n, 1]), [b.op1(K(2, 1), []), 'q', b.op1(TIE0, [])], 't = 4q + 1'), 't');
    b.next();
    const sub = b.op(addSubFast(W), [full, t, b.op1(TIE1, [])], "r' − t");
    b.next();
    const fits = b.name(`${sub}.cout`, 'fits');
    const ro = b.op(splitter([n + 1, 2]), [b.op1(busMux2(W), [full, `${sub}.s`, fits], 'keep?')]);
    const qs = b.op(splitter([n - 1, 1]), ['q']);
    b.next();
    b.wire(`${ro}.o0`, 'rout');
    b.wire(b.op1(merger([1, n - 1]), [fits, `${qs}.o0`]), 'qout');
    return define({
      id: `sqrtstep${n}`, name: `${n}-bit square-root step`, category: 'arithmetic',
      summary: "Long-hand square root, one bit per step: shift the next two radicand bits into the remainder (r' = 4r + x2), try subtracting 4q + 1, which is (2q + 1)² − (2q)² scaled: if it fits, the next root bit is 1. Same shape as a division step, with a divisor that is the root found so far.",
      ports: [bus('r', n + 1, 'in'), bus('x2', 2, 'in'), bus('q', n, 'in'), bus('rout', n + 1, 'out'), bus('qout', n, 'out')],
      symbol: { kind: 'box', label: 'SQRT STEP' },
      spec: ([r, x2, q]) => {
        const f2 = r * 4 + x2, t = q * 4 + 1, fit = f2 >= t;
        return [(fit ? f2 - t : f2) % 2 ** (n + 1), (q * 2 + (fit ? 1 : 0)) % 2 ** n];
      },
      netlist: () => ({ pins: { r: [0, 4], x2: [0, 10], q: [0, 16], rout: [b.right, 4], qout: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `wire [N+2:0] r2 = {r, x2};               // 4r + next two radicand bits
wire [N+2:0] d  = r2 - {1'b0, q, 2'b01};    // try 4q + 1
wire fits = ~d[N+2];
assign rout = fits ? d[N:0] : r2[N:0];
assign qout = {q[N-2:0], fits};`,
      },
    });
  });
}

/** Wire a register into a Builder: d, en, clk (q is read as `${name}.q`). */
function reg(b: Builder, name: string, w: number, d: string, en: string, label: string): void {
  b.wire(d, `${name}.d`);
  b.wire(en, `${name}.en`);
  b.wire('clk', `${name}.clk`);
  b.add(register(w), label, name);
}

/**
 * The special results of a division: NaN for NaN in, 0/0 and ∞/∞ (NV, or for a signaling NaN);
 * ∞ for ∞/x and x/0 (DZ when x is finite); 0 for 0/x and x/∞.
 */
function divSpecials(b: Builder, f: FpFormat, ua: string, ub: string, sign: string, nr: string): void {
  const N = 1 + f.E + f.M;
  const z2 = b.op1(AND, [`${ua}.zero`, `${ub}.zero`]), i2 = b.op1(AND, [`${ua}.inf`, `${ub}.inf`]);
  const invalid = b.name(b.op1(orN(4), [`${ua}.snan`, `${ub}.snan`, z2, i2], 'invalid'), 'NV');
  const nan = b.op1(orN(4), [`${ua}.nan`, `${ub}.nan`, z2, i2], 'NaN?');
  const finA = b.op1(NOT, [b.op1(orN(3), [`${ua}.zero`, `${ua}.inf`, `${ua}.nan`])], 'a finite, ≠ 0');
  b.next();
  const dz = b.name(b.op1(AND, [`${ub}.zero`, finA], 'x / 0'), 'DZ');
  const inf = b.op1(OR, [`${ua}.inf`, `${ub}.zero`], '∞ result');
  const zero = b.op1(OR, [`${ua}.zero`, `${ub}.inf`], '0 result');
  b.next();
  const zv = b.op1(merger([N - 1, 1]), [b.op1(K(N - 1, 0), []), sign]);
  const y0 = b.op1(busMux2(N), [`${nr}.y`, zv, zero], 'zero');
  const y1 = b.op1(busMux2(N), [y0, infValue(b, f, sign), inf], 'infinity');
  b.wire(b.op1(busMux2(N), [y1, nanValue(b, f), nan], 'NaN'), 'y');
  const special = b.op1(orN(3), [nan, inf, zero]);
  b.wire(b.op1(busMux2(5), [`${nr}.flags`, flagWord(b, { nv: invalid, dz: dz }), special], 'flags'), 'flags');
}

/** Output pins down the right edge, 4 apart. */
const outPins = (b: Builder, names: string[]): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [b.right, 4 + 4 * i] as [number, number]]));

/** Pre-rounding outputs of the iterative units, for a pipeline that rounds in a later stage. */
const preRoundPorts = (f: FpFormat, n: number): PortDef[] => [bit('sign', 'out'), bus('e', xeOf(f), 'out'), bus('m', n, 'out'), bit('sticky', 'out'),
  bit('nan', 'out'), bit('invalid', 'out'), bit('dz', 'out'), bit('inf', 'out'), bit('infSign', 'out')];

// ---- the divider's blocks -----------------------------------------------------------------------------------------------------
// The iterative divider is drawn as its stages (circuit eyeballing, 2026-11-08), like the adder: the core that makes one quotient
// bit a clock, the exponent, normalize & round, the special cases. The gates are the ones the flat drawing had.

/** The iterative core: control, the dividend fed in bit by bit, one restoring step a clock, the remainder and quotient registers, the sticky bit. */
export function fdivCore(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fdiv_core${E}_${M}`, () => {
    const n = M + 4, w = M + 1;
    // drawn by hand: the step in the middle, its remainder loop above (mux, register, back over the top) and its quotient loop
    // below (the new bit merged in, mux, register, back under to the splitter that feeds its top bit to the step); the
    // dividend's setup and the control below on the left
    const instances: InstanceDef[] = [
      { name: 'step', def: divStep(w), at: [24, 10], label: 'restoring step' },
      { name: 'rmux', def: busMux2(w), at: [44, 11], label: 'step or load' }, { name: 'R', def: register(w), at: [52, 12], label: 'remainder' },
      { name: 'nz', def: isZero(w), at: [64, 13], label: 'remainder = 0?' }, { name: 'nn', def: NOT, at: [73, 14] },
      { name: 'qn', def: merger([1, n - 1]), at: [41, 14] },
      { name: 'qmux', def: busMux2(n), at: [44, 22], label: 'shift or load' }, { name: 'Q', def: register(n), at: [52, 23], label: 'quotient / dividend bits' },
      { name: 'qs', def: splitter([n - 1, 1]), at: [19, 11] },
      { name: 'k0', def: K(n - 1, 0), at: [5, 29] }, { name: 'q0', def: merger([n - 1, 1]), at: [12, 29] },
      { name: 'sa', def: splitter([1, M]), at: [6, 32] },
      { name: 't0', def: TIE0, at: [8, 36] }, { name: 'r0', def: merger([M, 1]), at: [12, 34] },
      { name: 'ctl', def: iterControl(n), at: [40, 34], label: 'control' },
    ];
    const nets: NetDef[] = [
      { name: 'ma', ends: ['ma', 'sa.in'] }, { name: 'mb', ends: ['mb', 'step.d'] }, { name: 'start', ends: ['start', 'ctl.start'] },
      { name: 'clk', ends: ['clk', 'ctl.clk', 'R.clk', 'Q.clk'], tags: true },
      { name: 'ma0', ends: ['sa.o0', 'q0.i1'] }, { name: 'ma top', ends: ['sa.o1', 'r0.i0'] }, { name: '0', ends: ['t0.y', 'r0.i1'] }, { name: 'zeros', ends: ['k0.y', 'q0.i0'] },
      { name: 'R0', ends: ['r0.out', 'rmux.b'] }, { name: 'Q0', ends: ['q0.out', 'qmux.b'] },
      { name: 'r', ends: ['R.q', 'step.r', 'nz.a'] }, { name: 'r′', ends: ['step.rout', 'rmux.a'] }, { name: 'rd', ends: ['rmux.y', 'R.d'] },
      { name: 'q', ends: ['Q.q', 'qs.in', 'q'] }, { name: 'q top', ends: ['qs.o1', 'step.qin'] }, { name: 'q rest', ends: ['qs.o0', 'qn.i1'] },
      { name: 'q bit', ends: ['step.q', 'qn.i0'] }, { name: 'q′', ends: ['qn.out', 'qmux.a'] }, { name: 'qd', ends: ['qmux.y', 'Q.d'] },
      { name: 'load', ends: ['ctl.load', 'rmux.s', 'qmux.s'], tags: true }, { name: 'en', ends: ['ctl.en', 'R.en', 'Q.en'], tags: true },
      { name: 'r = 0', ends: ['nz.z', 'nn.a'] }, { name: 'sticky', ends: ['nn.y', 'sticky'] },
      { name: 'done', ends: ['ctl.done', 'done'] }, { name: 'busy', ends: ['ctl.busy', 'busy'] },
    ];
    const ports: PortDef[] = [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('ma', w, 'in'), bus('mb', w, 'in'),
      bus('q', n, 'out'), bit('sticky', 'out'), bit('done', 'out'), bit('busy', 'out')];
    return define({
      id: `fdiv_core${E}_${M}`, name: `FP divider: the iterative core (${fmtName(f)})`, category: 'arithmetic',
      summary: `start loads the remainder with the dividend's top bits; then each clock the restoring step tries remainder − divisor, keeps the difference when it does not borrow, and shifts the quotient bit in: ${n} steps. A remainder left over is the sticky bit.`,
      ports, symbol: { kind: 'box', label: 'DIVIDER CORE' },
      netlist: () => ({ instances, nets, pins: { mb: [0, 16], ma: [0, 34], start: [0, 39], clk: [0, 48], sticky: [80, 15], q: [80, 26], done: [80, 40], busy: [80, 42] } }),
    });
  });
}

/** The quotient's exponent: ea − eb + bias (the significands' quotient lies in (½, 2), normalize & round corrects by one). */
export function fdivExp(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fdiv_exp${E}_${M}`, () => {
    const XE = xeOf(f), B = fbias(f);
    const b = new Builder(10, 8, 4);
    b.pins('ea', 'eb');
    const ed = b.op(addSubFast(XE), ['ea', 'eb', b.op1(TIE1, [])], 'ea − eb', 'sub');
    b.next();
    b.wire(`${b.op(koggeStone(XE), [`${ed}.s`, b.op1(K(XE, B), []), b.op1(TIE0, [])], '+ bias', 'add')}.s`, 'e');
    const ports: PortDef[] = [bus('ea', XE, 'in'), bus('eb', XE, 'in'), bus('e', XE, 'out')];
    return define({
      id: `fdiv_exp${E}_${M}`, name: `FP divider: exponent (${fmtName(f)})`, category: 'arithmetic',
      summary: 'ea − eb + bias, in the unpacked exponent\'s width (two\'s complement: a tiny or huge quotient is found by normalize & round).',
      ports, symbol: { kind: 'box', label: 'EXPONENT' },
      spec: ([ea, eb]) => [(((ea - eb + B) % 2 ** XE) + 2 ** XE) % 2 ** XE],
      netlist: () => layered(ports, b, { gap: 8 }),
    });
  });
}

/** The divider's special cases: NaN, 0 / 0 and ∞ / ∞ (NV), x / 0 (∞ with DZ), ∞ / x, 0 / x and x / ∞; else the rounded quotient. */
export function fdivSpecial(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fdiv_special${E}_${M}`, () => {
    const N = 1 + E + M;
    // drawn by hand: the result's three multiplexers along the top (zero, infinity, NaN, each select from below), the class
    // tests below them in two columns, the flags' multiplexer at the bottom
    const instances: InstanceDef[] = [
      { name: 'nv', def: orN(4), at: [22, 13], label: 'invalid' }, { name: 'nan', def: orN(4), at: [22, 22], label: 'NaN?' },
      { name: 'zz', def: AND, at: [10, 30], label: '0 / 0' }, { name: 'ii', def: AND, at: [10, 36], label: '∞ / ∞' },
      { name: 'fo', def: orN(3), at: [10, 42] }, { name: 'fin', def: NOT, at: [16, 44], label: 'a finite, ≠ 0' },
      { name: 'inf', def: OR, at: [22, 34], label: '∞ result' }, { name: 'zero', def: OR, at: [22, 40], label: '0 result' },
      { name: 'dz', def: AND, at: [30, 43], label: 'x / 0' }, { name: 'sp', def: orN(3), at: [34, 25], label: 'special' },
      { name: 'kz', def: K(N - 1, 0), at: [36, 1] }, { name: 'zv', def: merger([N - 1, 1]), at: [44, 4] },
      { name: 'm0', def: busMux2(N), at: [48, 2], label: 'zero' },
      { name: 'km', def: K(M, 0), at: [43, 9] }, { name: 'ke', def: K(E, 2 ** E - 1), at: [43, 11] }, { name: 'infv', def: merger([M, E, 1]), at: [53, 9] },
      { name: 'm1', def: busMux2(N), at: [56, 3], label: 'infinity' },
      { name: 'kn', def: K(N, (2 ** E - 1) * 2 ** M + 2 ** (M - 1)), at: [59, 11] }, { name: 'm2', def: busMux2(N), at: [66, 4], label: 'NaN' },
      { name: 't0', def: TIE0, at: [56, 53] }, { name: 't1', def: TIE0, at: [56, 55] }, { name: 't2', def: TIE0, at: [56, 57] },
      { name: 'fw', def: merger([1, 1, 1, 1, 1]), at: [60, 53] }, { name: 'fm', def: busMux2(5), at: [66, 50], label: 'flags' },
    ];
    const nets: NetDef[] = [
      { name: 'sna', ends: ['sna', 'nv.i0'] }, { name: 'snb', ends: ['snb', 'nv.i1'] }, { name: 'na', ends: ['na', 'nan.i0', 'fo.i2'] }, { name: 'nb', ends: ['nb', 'nan.i1'] },
      { name: 'za', ends: ['za', 'zz.a', 'fo.i0', 'zero.a'] }, { name: 'zb', ends: ['zb', 'zz.b', 'inf.b', 'dz.a'] },
      { name: 'ia', ends: ['ia', 'ii.a', 'fo.i1', 'inf.a'] }, { name: 'ib', ends: ['ib', 'ii.b', 'zero.b'] },
      { name: '0 / 0', ends: ['zz.y', 'nv.i2', 'nan.i2'] }, { name: '∞ / ∞', ends: ['ii.y', 'nv.i3', 'nan.i3'] },
      { name: 'a special', ends: ['fo.y', 'fin.a'] }, { name: 'a finite', ends: ['fin.y', 'dz.b'] },
      { name: 'NV', ends: ['nv.y', 'fw.i4'] }, { name: 'DZ', ends: ['dz.y', 'fw.i3'] },
      { name: 'nan', ends: ['nan.y', 'm2.s', 'sp.i0'] }, { name: 'inf', ends: ['inf.y', 'm1.s', 'sp.i1'] }, { name: 'zero', ends: ['zero.y', 'm0.s', 'sp.i2'] },
      { name: 'special', ends: ['sp.y', 'fm.s'] },
      { name: 'ry', ends: ['ry', 'm0.a'] }, { name: 'sign', ends: ['sign', 'zv.i1', 'infv.i2'] },
      { name: 'zeros', ends: ['kz.y', 'zv.i0'] }, { name: '±0', ends: ['zv.out', 'm0.b'] }, { name: 'y0', ends: ['m0.y', 'm1.a'] },
      { name: 'mant 0', ends: ['km.y', 'infv.i0'] }, { name: 'exp max', ends: ['ke.y', 'infv.i1'] }, { name: '±∞', ends: ['infv.out', 'm1.b'] },
      { name: 'y1', ends: ['m1.y', 'm2.a'] }, { name: 'qNaN', ends: ['kn.y', 'm2.b'] }, { name: 'y', ends: ['m2.y', 'y'] },
      { name: 'nx', ends: ['t0.y', 'fw.i0'] }, { name: 'uf', ends: ['t1.y', 'fw.i1'] }, { name: 'of', ends: ['t2.y', 'fw.i2'] },
      { name: 'rflags', ends: ['rflags', 'fm.a'] }, { name: 'NV DZ', ends: ['fw.out', 'fm.b'] }, { name: 'flags', ends: ['fm.y', 'flags'] },
    ];
    const pins: Record<string, [number, number]> = { ry: [0, 4], sign: [0, 7], sna: [0, 14], snb: [0, 16], na: [0, 23], nb: [0, 25],
      za: [0, 31], zb: [0, 33], ia: [0, 37], ib: [0, 39], rflags: [0, 52], y: [78, 7], flags: [78, 53] };
    const ports: PortDef[] = [bus('ry', N, 'in'), bus('rflags', 5, 'in'), bit('sign', 'in'), bit('za', 'in'), bit('ia', 'in'), bit('na', 'in'), bit('sna', 'in'),
      bit('zb', 'in'), bit('ib', 'in'), bit('nb', 'in'), bit('snb', 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')];
    const nanBits = (2 ** E - 1) * 2 ** M + 2 ** (M - 1);
    return define({
      id: `fdiv_special${E}_${M}`, name: `FP divider: special cases (${fmtName(f)})`, category: 'arithmetic',
      summary: 'Invalid (NV) is a signaling NaN in, 0 / 0 or ∞ / ∞, and those give the canonical NaN, as any NaN in does. x / 0 with x finite and ≠ 0 is ∞ with DZ; ∞ / x is ∞; 0 / x and x / ∞ are 0, with the quotient\'s sign. A special result raises only NV or DZ.',
      ports, symbol: { kind: 'box', label: 'SPECIAL' },
      spec: ([ry, rfl, s, za, ia, na, sna, zb, ib, nb, snb]) => {
        const zz = za && zb, ii = ia && ib, nv = sna || snb || zz || ii ? 1 : 0, nan = na || nb || zz || ii;
        const dz = zb && !(za || ia || na) ? 1 : 0, inf = ia || zb, zero = za || ib;
        const y = nan ? nanBits : inf ? s * 2 ** (N - 1) + (2 ** E - 1) * 2 ** M : zero ? s * 2 ** (N - 1) : ry;
        return [y, nan || inf || zero ? nv * FLAG.NV + dz * FLAG.DZ : rfl];
      },
      netlist: () => ({ instances, nets, pins }),
    });
  });
}

/** The divider's top: unpack and prenormalize both operands, the core, the exponent and the sign beside it, normalize & round, the special cases. */
function fdivTop(f: FpFormat): { instances: InstanceDef[]; nets: NetDef[]; pins: Record<string, [number, number]> } {
  const n = f.M + 4;
  const at = new Map<string, [number, number]>(), defs = new Map<string, ComponentDef>();
  const put = (name: string, def: ComponentDef, xy: [number, number]) => { at.set(name, xy); defs.set(name, def); };
  const P = (inst: string, port: string): [number, number] => { const a = at.get(inst)!, p = symbolGeom(defs.get(inst)!).ports[port].pos; return [a[0] + p[0], a[1] + p[1]]; };
  const align = (name: string, def: ComponentDef, x: number, port: string, y: number) => put(name, def, [x, y - symbolGeom(def).ports[port].pos[1]]);
  const right = (inst: string) => at.get(inst)![0] + symbolGeom(defs.get(inst)!).w;
  const bottom = (inst: string) => at.get(inst)![1] + symbolGeom(defs.get(inst)!).h;
  put('ua', fpUnpack(f), [6, 6]);
  put('ub', fpUnpack(f), [6, bottom('ua') + 8]);
  align('pa', fpPrenorm(f), right('ua') + 8, 'mant', P('ua', 'mant')[1]);
  align('pb', fpPrenorm(f), right('ub') + 8, 'mant', P('ub', 'mant')[1]);
  const CX = right('pa') + 10, core = fdivCore(f);
  align('core', core, CX, 'ma', P('pa', 'm')[1]);
  put('exp', fdivExp(f), [CX, Math.max(bottom('core') + 6, P('pb', 'e')[1] - symbolGeom(fdivExp(f)).ports.eb.pos[1])]);
  put('sign', XOR, [CX + 4, bottom('exp') + 6]);
  const NX = Math.max(right('core'), right('exp')) + 12;
  align('nr', normRound(f, n), NX, 'mant', P('core', 'q')[1]);
  const SX = right('nr') + 10;
  align('special', fdivSpecial(f), SX, 'ry', P('nr', 'y')[1]);
  const labels: Record<string, string> = { ua: 'unpack a', ub: 'unpack b', pa: 'normalize a', pb: 'normalize b', sign: 'sign', nr: 'normalize & round' };
  const instances: InstanceDef[] = [...at.keys()].map((name) => ({ name, def: defs.get(name)!, at: at.get(name), label: labels[name] }));
  // wires along the data path; labels for what runs far: the signs, the class flags into the special cases, rm, the clock
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'ua.x'] }, { name: 'b', ends: ['b', 'ub.x'] },
    { name: 'ma', ends: ['ua.mant', 'pa.mant'] }, { name: 'ea', ends: ['ua.exp', 'pa.exp'] },
    { name: 'mb', ends: ['ub.mant', 'pb.mant'] }, { name: 'eb', ends: ['ub.exp', 'pb.exp'] },
    { name: 'dividend', ends: ['pa.m', 'core.ma'] }, { name: 'divisor', ends: ['pb.m', 'core.mb'] },
    { name: 'ea′', ends: ['pa.e', 'exp.ea'], tags: true }, { name: 'eb′', ends: ['pb.e', 'exp.eb'] },
    { name: 'start', ends: ['start', 'core.start'] }, { name: 'clk', ends: ['clk', 'core.clk'], tags: true },
    { name: 'sa', ends: ['ua.sign', 'sign.a'], tags: true }, { name: 'sb', ends: ['ub.sign', 'sign.b'], tags: true },
    { name: 'sign', ends: ['sign.y', 'nr.sign', 'special.sign'], tags: true },
    { name: 'e', ends: ['exp.e', 'nr.exp'] }, { name: 'quotient', ends: ['core.q', 'nr.mant'] }, { name: 'sticky', ends: ['core.sticky', 'nr.stin'] },
    { name: 'rm', ends: ['rm', 'nr.rm'], tags: true },
    { name: 'rounded', ends: ['nr.y', 'special.ry'] }, { name: 'round flags', ends: ['nr.flags', 'special.rflags'] },
    ...(['zero', 'inf', 'nan', 'snan'] as const).flatMap((c): NetDef[] => {
      const p = c === 'zero' ? 'z' : c === 'inf' ? 'i' : c === 'nan' ? 'n' : 'sn';
      return [{ name: `${c} a`, ends: [`ua.${c}`, `special.${p}a`], tags: true }, { name: `${c} b`, ends: [`ub.${c}`, `special.${p}b`], tags: true }];
    }),
    { name: 'y', ends: ['special.y', 'y'] }, { name: 'flags', ends: ['special.flags', 'flags'] },
    { name: 'done', ends: ['core.done', 'done'], tags: true }, { name: 'busy', ends: ['core.busy', 'busy'], tags: true },
  ];
  const ox = right('special') + 8, oy = P('special', 'y')[1];
  return {
    instances, nets,
    pins: { start: [0, at.get('ua')![1] - 3], a: [0, P('ua', 'x')[1]], b: [0, P('ub', 'x')[1]], rm: [0, bottom('sign') + 4], clk: [0, bottom('sign') + 8],
      y: [ox, oy], flags: [ox, oy + 2], done: [ox, oy + 6], busy: [ox, oy + 8] },
  };
}

/**
 * a / b, iteratively: prenormalize both significands, then one restoring division step per
 * clock (the integer divider's step, the divide chapter) produces M + 4 quotient bits, most significant
 * first, and the final remainder is the sticky bit. Normalize & round finishes in the done cycle;
 * with round = false the unit stops before it (the pipelined FPU rounds in its X stage) and
 * outputs the quotient, its exponent and sign, the sticky bit and the special cases instead.
 */
export function fpDiv(f: FpFormat, round = true): ComponentDef {
  const { E, M } = f;
  return memo(`fpdiv${E}_${M}${round ? '' : '_pre'}`, () => {
    const XE = xeOf(f), N = 1 + E + M, n = M + 4;
    const b = new Builder();
    const ua = b.op(fpUnpack(f), ['a'], 'unpack a'), ub = b.op(fpUnpack(f), ['b'], 'unpack b');
    const ctl = b.op(iterControl(n), ['clk', 'start'], 'control');
    b.next();
    const pa = b.op(fpPrenorm(f), [`${ua}.mant`, `${ua}.exp`], 'normalize a'), pb = b.op(fpPrenorm(f), [`${ub}.mant`, `${ub}.exp`], 'normalize b');
    b.next();
    // the dividend enters bit by bit: its top M bits start as the remainder, its last bit and then zeros follow
    const sa = b.op(splitter([1, M]), [`${pa}.m`]);
    const R0 = b.op1(merger([M, 1]), [`${sa}.o1`, b.op1(TIE0, [])]);
    const Q0 = b.op1(merger([n - 1, 1]), [b.op1(K(n - 1, 0), []), `${sa}.o0`]);
    const qs = b.op(splitter([n - 1, 1]), ['Q.q']);
    b.next();
    const st = b.op(divStep(M + 1), ['R.q', `${qs}.o1`, `${pb}.m`], 'restoring step');
    b.next();
    const Qn = b.op1(merger([1, n - 1]), [`${st}.q`, `${qs}.o0`]);
    reg(b, 'R', M + 1, b.op1(busMux2(M + 1), [`${st}.rout`, R0, `${ctl}.load`]), `${ctl}.en`, 'remainder');
    reg(b, 'Q', n, b.op1(busMux2(n), [Qn, Q0, `${ctl}.load`]), `${ctl}.en`, 'quotient / dividend bits');
    b.next();
    const ed = b.op(addSubFast(XE), [`${pa}.e`, `${pb}.e`, b.op1(TIE1, [])], 'ea − eb');
    const eq = b.op(koggeStone(XE), [`${ed}.s`, b.op1(K(XE, fbias(f)), []), b.op1(TIE0, [])], '+ bias');
    const sign = b.op1(XOR, [`${ua}.sign`, `${ub}.sign`], 'sign');
    const stk = nonZero(b, 'R.q', M + 1);
    b.next();
    if (round) {
      const nr = b.op(normRound(f, n), [sign, `${eq}.s`, 'Q.q', stk, 'rm'], 'normalize & round');
      b.next();
      divSpecials(b, f, ua, ub, sign, nr);
    } else {
      const z2 = b.op1(AND, [`${ua}.zero`, `${ub}.zero`]), i2 = b.op1(AND, [`${ua}.inf`, `${ub}.inf`]);
      const finA = b.op1(NOT, [b.op1(orN(3), [`${ua}.zero`, `${ua}.inf`, `${ua}.nan`])], 'a finite, ≠ 0');
      const zero = b.op1(OR, [`${ua}.zero`, `${ub}.inf`], '0 result');
      const nz = b.op1(NOT, [zero]);
      b.next();
      b.wire(b.op1(orN(4), [`${ua}.snan`, `${ub}.snan`, z2, i2], 'invalid'), 'invalid');
      b.wire(b.op1(orN(4), [`${ua}.nan`, `${ub}.nan`, z2, i2], 'NaN?'), 'nan');
      b.wire(b.op1(AND, [`${ub}.zero`, finA], 'x / 0'), 'dz');
      b.wire(b.op1(OR, [`${ua}.inf`, `${ub}.zero`], '∞ result'), 'inf');
      b.wire(sign, 'infSign');
      b.wire(sign, 'sign');
      b.wire(`${eq}.s`, 'e');
      b.wire(b.op1(bitwise('and', n), ['Q.q', b.op1(fanout(n), [nz])], 'quotient (0 for a zero result)'), 'm');
      b.wire(b.op1(AND, [stk, nz]), 'sticky');
    }
    b.wire(`${ctl}.done`, 'done');
    b.wire(`${ctl}.busy`, 'busy');
    return define({
      id: `fpdiv${E}_${M}${round ? '' : '_pre'}`, name: `${fmtName(f)} divider (iterative${round ? '' : ', unrounded'})`, category: 'arithmetic',
      summary: `Radix-2 restoring division of the normalized significands: one quotient bit per clock, ${n} steps (M + 1 bits, a guard bit and two more so that a quotient below 1 still has them), the final remainder ≠ 0 is the sticky bit. Exponent = ea − eb + bias. ${n + 2} cycles from start to the edge that writes the result. x / 0 = ∞ with DZ; 0 / 0 and ∞ / ∞ are NaN with NV.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', N, 'in'), bus('b', N, 'in'), bus('rm', 3, 'in'),
        ...(round ? [bus('y', N, 'out'), bus('flags', 5, 'out')] : preRoundPorts(f, n)), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'FDIV (iterative)' },
      netlist: () => (round ? fdivTop(f) : { pins: { start: [0, 2], a: [0, 6], b: [0, 10], rm: [0, 14], clk: [0, 18], ...outPins(b, ['sign', 'e', 'm', 'sticky', 'nan', 'invalid', 'dz', 'inf', 'infSign', 'done', 'busy']) }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `module fdiv_iter (input logic clk, start, input logic [31:0] a, b, input logic [2:0] rm,
                  output logic [31:0] y, output logic [4:0] flags, output logic done, busy);
  logic [23:0] ma, mb;  logic signed [15:0] ea, eb;         // prenormalized: ma, mb in [1, 2)
  fp_prenorm na (.x(a), .m(ma), .e(ea)), nb (.x(b), .m(mb), .e(eb));
  logic load, en;  iter_ctl #(27) ctl (.clk, .start, .load, .en, .done, .busy);
  logic [23:0] r;  logic [26:0] q;                         // remainder, quotient (MSB first)
  wire [24:0] r2 = {r, q[26]};  wire [24:0] d = r2 - {1'b0, mb};  wire fits = ~d[24];
  always_ff @(posedge clk) if (en) begin
    r <= load ? {1'b0, ma[23:1]} : (fits ? d[23:0] : r2[23:0]);
    q <= load ? {ma[0], 26'b0}    : {q[25:0], fits};
  end
  normround #(27) nr (.sign(a[31] ^ b[31]), .exp(ea - eb + 16'd127), .mant(q), .stin(|r), .rm, .y(yr), .flags(fr));
  // + special cases: NaN, 0/0, inf/inf (NV); x/0 = inf (DZ); inf/x = inf; 0/x, x/inf = 0
endmodule`,
      },
    });
  });
}

/**
 * √a, iteratively: prenormalize, make the exponent even (doubling the significand if it was
 * odd), then one restoring square-root step per clock produces M + 3 root bits; the remainder
 * is the sticky bit. The result exponent is the halved exponent, the root lies in [1, 2).
 */
export function fpSqrt(f: FpFormat, round = true): ComponentDef {
  const { E, M } = f;
  return memo(`fpsqrt${E}_${M}${round ? '' : '_pre'}`, () => {
    const XE = xeOf(f), N = 1 + E + M, n = M + 3, XW = M + 2 + ((M + 2) % 2);
    const b = new Builder();
    const u = b.op(fpUnpack(f), ['a'], 'unpack');
    const ctl = b.op(iterControl(n), ['clk', 'start'], 'control');
    b.next();
    const p = b.op(fpPrenorm(f), [`${u}.mant`, `${u}.exp`], 'normalize');
    b.next();
    // the bias is odd, so the unbiased exponent is odd exactly when the biased one is even
    const es = b.op(splitter([1, XE - 1]), [`${p}.e`]);
    const odd = b.name(b.op1(NOT, [`${es}.o0`], 'exponent odd?'), 'odd');
    const xOdd = b.op1(merger([1, M + 1]), [b.op1(TIE0, []), `${p}.m`]);
    const xEven = b.op1(merger([M + 1, 1]), [`${p}.m`, b.op1(TIE0, [])]);
    b.next();
    let X = b.name(b.op1(busMux2(M + 2), [xEven, xOdd, odd], 'radicand in [1, 4)'), 'X');
    if (XW > M + 2) X = b.op1(merger([1, M + 2]), [b.op1(TIE0, []), X]);
    const xs = b.op(splitter([XW - 2, 2]), ['X.q']);
    b.next();
    const st = b.op(sqrtStep(n), ['R.q', `${xs}.o1`, 'Q.q'], 'restoring step');
    const Xn = b.op1(merger([2, XW - 2]), [b.op1(K(2, 0), []), `${xs}.o0`]);
    b.next();
    reg(b, 'X', XW, b.op1(busMux2(XW), [Xn, X, `${ctl}.load`]), `${ctl}.en`, 'radicand bits');
    reg(b, 'R', n + 1, b.op1(busMux2(n + 1), [`${st}.rout`, b.op1(K(n + 1, 0), []), `${ctl}.load`]), `${ctl}.en`, 'remainder');
    reg(b, 'Q', n, b.op1(busMux2(n), [`${st}.qout`, b.op1(K(n, 0), []), `${ctl}.load`]), `${ctl}.en`, 'root');
    b.next();
    // result exponent: floor((e − bias) / 2) + bias = (e + bias) >> 1, arithmetic
    const eb = b.op(splitter([1, XE - 2, 1]), [`${b.op(koggeStone(XE), [`${p}.e`, b.op1(K(XE, fbias(f)), []), b.op1(TIE0, [])], 'e + bias')}.s`]);
    const er = b.op1(merger([XE - 2, 1, 1]), [`${eb}.o1`, `${eb}.o2`, `${eb}.o2`], '÷ 2');
    const stk = nonZero(b, 'R.q', n + 1);
    b.next();
    const neg = b.op1(andN(3), [`${u}.sign`, b.op1(NOT, [`${u}.zero`]), b.op1(NOT, [`${u}.nan`])], 'a < 0');
    if (round) {
      const nr = b.op(normRound(f, n), [b.op1(TIE0, []), er, 'Q.q', stk, 'rm'], 'normalize & round');
      b.next();
      const passA = b.op1(OR, [`${u}.zero`, `${u}.inf`], '±0, +∞: itself');
      b.next();
      const nan = b.op1(OR, [`${u}.nan`, neg], 'NaN?');
      const invalid = b.name(b.op1(OR, [`${u}.snan`, neg], 'invalid'), 'NV');
      const y1 = b.op1(busMux2(N), [`${nr}.y`, 'a', passA]);
      b.next();
      b.wire(b.op1(busMux2(N), [y1, nanValue(b, f), nan], 'NaN'), 'y');
      b.wire(b.op1(busMux2(5), [`${nr}.flags`, flagWord(b, { nv: invalid }), b.op1(OR, [nan, passA])], 'flags'), 'flags');
    } else {
      const nz = b.op1(NOT, [`${u}.zero`]);
      b.next();
      b.wire(b.op1(OR, [`${u}.nan`, neg], 'NaN?'), 'nan');
      b.wire(b.op1(OR, [`${u}.snan`, neg], 'invalid'), 'invalid');
      b.wire(b.op1(TIE0, []), 'dz');
      b.wire(b.op1(AND, [`${u}.inf`, b.op1(NOT, [`${u}.sign`])], '+∞'), 'inf');
      b.wire(b.op1(TIE0, []), 'infSign');
      b.wire(b.op1(AND, [`${u}.sign`, `${u}.zero`], '√−0 = −0'), 'sign');
      b.wire(er, 'e');
      b.wire(b.op1(bitwise('and', n), ['Q.q', b.op1(fanout(n), [nz])], 'root (0 for ±0)'), 'm');
      b.wire(b.op1(AND, [stk, nz]), 'sticky');
    }
    b.wire(`${ctl}.done`, 'done');
    b.wire(`${ctl}.busy`, 'busy');
    return define({
      id: `fpsqrt${E}_${M}${round ? '' : '_pre'}`, name: `${fmtName(f)} square root (iterative${round ? '' : ', unrounded'})`, category: 'arithmetic',
      summary: `Radix-2 restoring square root: the radicand (the significand, doubled if the exponent is odd) feeds two bits per clock into the remainder; each step tries 4q + 1 and appends one root bit. ${n} steps, ${n + 2} cycles. The exponent is halved; √−0 = −0, the root of a negative number is NaN with NV.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', N, 'in'), bus('rm', 3, 'in'),
        ...(round ? [bus('y', N, 'out'), bus('flags', 5, 'out')] : preRoundPorts(f, n)), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'FSQRT (iterative)' },
      netlist: () => ({ pins: { start: [0, 2], a: [0, 6], rm: [0, 10], clk: [0, 14], ...outPins(b, round ? ['y', 'flags', 'done', 'busy'] : ['sign', 'e', 'm', 'sticky', 'nan', 'invalid', 'dz', 'inf', 'infSign', 'done', 'busy']) }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `module fsqrt_iter (input logic clk, start, input logic [31:0] a, input logic [2:0] rm,
                   output logic [31:0] y, output logic [4:0] flags, output logic done, busy);
  logic [23:0] m;  logic signed [15:0] e;  fp_prenorm na (.x(a), .m, .e);
  wire odd = ~e[0];                                       // bias is odd: unbiased e odd <=> biased even
  logic load, en;  iter_ctl #(26) ctl (.clk, .start, .load, .en, .done, .busy);
  logic [25:0] x, q;  logic [26:0] r;
  wire [28:0] r2 = {r, x[25:24]};  wire [28:0] d = r2 - {1'b0, q, 2'b01};  wire fits = ~d[28];
  always_ff @(posedge clk) if (en) begin
    x <= load ? {1'b0, odd ? {m, 1'b0} : {1'b0, m}} : {x[23:0], 2'b00};
    r <= load ? '0 : (fits ? d[26:0] : r2[26:0]);
    q <= load ? '0 : {q[24:0], fits};
  end
  normround #(26) nr (.sign(1'b0), .exp((e + 16'sd127) >>> 1), .mant(q), .stin(|r), .rm, .y(yr), .flags(fr));
  // + special cases: NaN, negative (NV), +-0 and +inf pass through
endmodule`,
      },
    });
  });
}

/** x + y + z: a row of full adders (carry-save), then one prefix adder. */
function sum3(b: Builder, w: number, x: string, y: string, z: string, label?: string): string {
  const xy = b.op1(bitwise('xor', w), [x, y]);
  const s0 = b.op1(bitwise('xor', w), [xy, z]);
  const c0 = b.op1(bitwise('or', w), [b.op1(bitwise('and', w), [x, y]), b.op1(bitwise('and', w), [xy, z])]);
  const cs = b.op(splitter([w - 1, 1]), [c0]);
  return `${b.op(koggeStone(w), [s0, b.op1(merger([1, w - 1]), [b.op1(TIE0, []), `${cs}.o0`]), b.op1(TIE0, [])], label)}.s`;
}
/** x + y + z + k (k a constant): two carry-save rows, then one prefix adder. */
function sum4(b: Builder, w: number, x: string, y: string, z: string, k: number, label?: string): string {
  const xy = b.op1(bitwise('xor', w), [x, y]);
  const s0 = b.op1(bitwise('xor', w), [xy, z]);
  const c0 = b.op1(bitwise('or', w), [b.op1(bitwise('and', w), [x, y]), b.op1(bitwise('and', w), [xy, z])]);
  const cs = b.op(splitter([w - 1, 1]), [c0]);
  return sum3(b, w, s0, b.op1(merger([1, w - 1]), [b.op1(TIE0, []), `${cs}.o0`]), b.op1(K(w, k), []), label);
}

// ---- fused multiply-add ----------------------------------------------------------------------
// Three boxes, which are also the three stages of the pipelined FPU: multiply (unpack,
// prenormalize, exact product, exponent difference), add (align, add, negate) and round.

const fmaDims = (f: FpFormat) => { const W0 = 2 * f.M + 2, WA = W0 + 2; return { XE: xeOf(f), W0, WA, WS: W0 + 3, kA: log2c(WA + 1) }; };

/**
 * FMA stage 1: unpack and prenormalize a, b, c; the exact product (2M + 2 bits); its exponent;
 * which of product and addend has the larger exponent (the base); how far to shift the other;
 * and the special cases (NaN, ∞, invalid), which are known from the operands alone.
 */
export function fmaMultiply(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fmamul${E}_${M}`, () => {
    const { XE, W0, kA } = fmaDims(f), N = 1 + E + M, B = fbias(f);
    const b = new Builder();
    const ua = b.op(fpUnpack(f), ['a'], 'unpack a'), ub = b.op(fpUnpack(f), ['b'], 'unpack b'), uc = b.op(fpUnpack(f), ['c'], 'unpack c');
    b.next();
    const pa = b.op(fpPrenorm(f), [`${ua}.mant`, `${ua}.exp`], 'normalize a');
    const pb = b.op(fpPrenorm(f), [`${ub}.mant`, `${ub}.exp`], 'normalize b');
    const pc = b.op(fpPrenorm(f), [`${uc}.mant`, `${uc}.exp`], 'normalize c');
    const ps = b.name(b.op1(XOR, [b.op1(XOR, [`${ua}.sign`, `${ub}.sign`]), 'negProd'], 'product sign'), 'signP');
    const sc = b.name(b.op1(XOR, [`${uc}.sign`, 'negC'], 'addend sign'), 'signC');
    b.next();
    b.wire(b.op1(treeMul(M + 1), [`${pa}.m`, `${pb}.m`], 'exact product'), 'p');
    b.wire(`${pc}.m`, 'mc');
    const effSub = b.name(b.op1(XOR, [ps, sc], 'subtract?'), 'effSub');
    b.wire(effSub, 'effSub');
    const pZero = b.op1(OR, [`${ua}.zero`, `${ub}.zero`], 'product = 0');
    // exponents, each in one carry-propagate addition: eP = ea + eb + 1 − bias, and both
    // eP − eC and eC − eP at once, so that |eP − eC| needs no negation afterwards
    const K1 = (1 - B + 2 ** XE) % 2 ** XE, inv = (x: string) => b.op1(bitwise('xor', XE), [x, b.op1(K(XE, 2 ** XE - 1), [])]);
    const ea = `${pa}.e`, eb = `${pb}.e`, ec = `${pc}.e`;
    const ep = b.name(sum3(b, XE, ea, eb, b.op1(K(XE, K1), []), 'ea + eb + 1 − bias'), 'eP');
    const d = b.name(sum4(b, XE, ea, eb, inv(ec), (K1 + 1) % 2 ** XE, 'eP − eC'), 'eP−eC');
    const nd = b.name(sum4(b, XE, inv(ea), inv(eb), ec, (2 - K1 + 2 ** XE) % 2 ** XE, 'eC − eP'), 'eC−eP');
    b.next();
    const dNeg = b.name(b.op(splitter([XE - 1, 1]), [d]) + '.o1', 'eP<eC');
    // the base is the operand with the larger exponent; a zero product always yields to c, a zero c to the product
    const cBig = b.name(b.op1(AND, [b.op1(NOT, [`${uc}.zero`]), b.op1(OR, [pZero, dNeg])], 'c bigger?'), 'cBig');
    const ad = b.op(splitter([kA, XE - kA]), [b.op1(busMux2(XE), [d, nd, dNeg], '|eP − eC|')]);
    b.next();
    b.wire(b.op1(busMux2(kA), [`${ad}.o0`, b.op1(K(kA, 2 ** kA - 1), []), nonZero(b, `${ad}.o1`, XE - kA)], 'shift'), 'dsat');
    b.wire(cBig, 'cBig');
    b.wire(b.op1(busMux2(XE), [ep, `${pc}.e`, cBig]), 'eB');
    b.wire(b.op1(MUX2, [ps, sc, cBig]), 'sB');
    // special cases
    const pInf = b.op1(OR, [`${ua}.inf`, `${ub}.inf`]);
    const infZero = b.op1(OR, [b.op1(AND, [`${ua}.inf`, `${ub}.zero`]), b.op1(AND, [`${ua}.zero`, `${ub}.inf`])], '∞ × 0');
    const pNaN = b.op1(OR, [`${ua}.nan`, `${ub}.nan`]);
    const infDiff = b.op1(andN(4), [pInf, b.op1(NOT, [pNaN]), `${uc}.inf`, effSub], '∞ − ∞');
    b.next();
    const invalid = b.op1(orN(5), [`${ua}.snan`, `${ub}.snan`, `${uc}.snan`, infZero, infDiff], 'invalid');
    b.wire(invalid, 'invalid');
    b.wire(b.op1(orN(4), [`${ua}.nan`, `${ub}.nan`, `${uc}.nan`, invalid], 'NaN?'), 'nan');
    b.wire(b.op1(OR, [pInf, `${uc}.inf`]), 'anyInf');
    b.wire(b.op1(MUX2, [sc, ps, pInf]), 'infSign');
    return define({
      id: `fmamul${E}_${M}`, name: `${fmtName(f)} FMA stage 1: multiply`, category: 'arithmetic',
      summary: `Unpacks and prenormalizes a, b, c; multiplies the significands exactly (${W0} bits); computes the product's exponent and compares it with c's: the larger one is the base, the other will be shifted right by dsat. The special cases (NaN, ∞, ∞ × 0, ∞ − ∞, signaling NaNs) are decided here, from the operands alone.`,
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bus('c', N, 'in'), bit('negProd', 'in'), bit('negC', 'in'),
        bus('p', W0, 'out'), bus('mc', M + 1, 'out'), bus('dsat', kA, 'out'), bit('cBig', 'out'), bus('eB', XE, 'out'), bit('sB', 'out'), bit('effSub', 'out'),
        bit('nan', 'out'), bit('invalid', 'out'), bit('anyInf', 'out'), bit('infSign', 'out')],
      symbol: { kind: 'box', label: 'FMA 1: MULTIPLY' },
      netlist: () => ({
        pins: { a: [0, 4], b: [0, 8], c: [0, 12], negProd: [0, 16], negC: [0, 20], p: [b.right, 2], mc: [b.right, 6], dsat: [b.right, 10], cBig: [b.right, 14], eB: [b.right, 18], sB: [b.right, 22], effSub: [b.right, 26], nan: [b.right, 30], invalid: [b.right, 34], anyInf: [b.right, 38], infSign: [b.right, 42] },
        instances: b.instances, nets: b.nets(),
      }),
    });
  });
}

/**
 * FMA stage 2: widen c to the product's width, shift the smaller operand right (guard bits and a
 * sticky bit), add or subtract, and take the magnitude: a sign, an exponent and a 2M + 6-bit sum.
 */
export function fmaAdd(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fmaadd${E}_${M}`, () => {
    const { XE, W0, WA, WS, kA } = fmaDims(f);
    const b = new Builder();
    const Cw = b.name(b.op1(merger([M + 1, M + 1]), [b.op1(K(M + 1, 0), []), 'mc'], 'c, as wide'), 'cWide');
    b.next();
    const mB = b.name(b.op1(busMux2(W0), ['p', Cw, 'cBig'], 'base'), 'mBig');
    const mS = b.op1(busMux2(W0), [Cw, 'p', 'cBig']);
    b.next();
    const al = b.op(shiftRightSticky(WA, kA), [b.op1(merger([2, W0]), [b.op1(K(2, 0), []), mS]), 'dsat'], 'align');
    b.next();
    const opB = b.op1(merger([1, 2, W0]), [b.op1(TIE0, []), b.op1(K(2, 0), []), mB]);
    const opS = b.op1(merger([1, WA]), [`${al}.sticky`, `${al}.y`]);
    const sum = b.op(addSubFast(WS), [opB, opS, 'effSub'], 'add / subtract');
    b.next();
    const neg = b.name(b.op1(AND, ['effSub', b.op1(NOT, [`${sum}.cout`])], 'negative?'), 'neg');
    const mag = b.op1(condNegate(WS), [`${sum}.s`, neg], '|sum|');
    const top = b.op1(AND, [`${sum}.cout`, b.op1(NOT, ['effSub'])]);
    b.next();
    const sm = b.name(b.op1(merger([WS, 1]), [mag, top]), 'sum');
    const zs = b.op1(isZero(WS + 1), [sm]);
    const exactZero = b.op1(AND, ['effSub', zs], 'cancelled');
    b.wire(b.op1(MUX2, [b.op1(XOR, ['sB', neg]), isMode(b, 'rm', RM.RDN, 'RDN?'), exactZero], 'sign (+0, −0 in RDN)'), 'sign');
    b.wire(b.op1(incFast(XE), ['eB']), 'ex');
    b.wire(sm, 'sum');
    return define({
      id: `fmaadd${E}_${M}`, name: `${fmtName(f)} FMA stage 2: align and add`, category: 'arithmetic',
      summary: `The smaller operand is shifted right by dsat into a ${WA}-bit field (two guard bits; the rest ORed into a sticky bit), then one ${WS}-bit addition or subtraction. A difference can go negative only when the exponents are within 3, where the shift is exact; it is then negated. An exact zero is +0 (−0 when rounding down).`,
      ports: [bus('p', W0, 'in'), bus('mc', M + 1, 'in'), bus('dsat', kA, 'in'), bit('cBig', 'in'), bus('eB', XE, 'in'), bit('sB', 'in'), bit('effSub', 'in'), bus('rm', 3, 'in'),
        bit('sign', 'out'), bus('ex', XE, 'out'), bus('sum', WS + 1, 'out')],
      symbol: { kind: 'box', label: 'FMA 2: ADD' },
      netlist: () => ({
        pins: { p: [0, 2], mc: [0, 6], dsat: [0, 10], cBig: [0, 14], eB: [0, 18], sB: [0, 22], effSub: [0, 26], rm: [0, 30], sign: [b.right, 4], ex: [b.right, 10], sum: [b.right, 16] },
        instances: b.instances, nets: b.nets(),
      }),
    });
  });
}

/** FMA stage 3: one normalize & round of the wide sum, then the special results decided in stage 1. */
export function fmaRound(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fmarnd${E}_${M}`, () => {
    const { XE, WS } = fmaDims(f), N = 1 + E + M;
    const b = new Builder();
    const nr = b.op(normRound(f, WS + 1), ['sign', 'ex', 'sum', b.op1(TIE0, []), 'rm'], 'normalize & round (once)');
    b.next();
    specials(b, f, `${nr}.y`, `${nr}.flags`, 'nan', 'anyInf', 'infSign', 'invalid', 'dz');
    return define({
      id: `fmarnd${E}_${M}`, name: `${fmtName(f)} FMA stage 3: round`, category: 'arithmetic',
      summary: `Normalize & round on ${WS + 1} bits, the only rounding of the whole operation; then NaN or ∞ if stage 1 said so (and then only NV, or DZ for a division by zero, as flags).`,
      ports: [bit('sign', 'in'), bus('ex', XE, 'in'), bus('sum', WS + 1, 'in'), bus('rm', 3, 'in'), bit('nan', 'in'), bit('invalid', 'in'), bit('anyInf', 'in'), bit('infSign', 'in'), bit('dz', 'in'),
        bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FMA 3: ROUND' },
      netlist: () => ({
        pins: { sign: [0, 2], ex: [0, 6], sum: [0, 10], rm: [0, 14], nan: [0, 18], invalid: [0, 22], anyInf: [0, 26], infSign: [0, 30], dz: [0, 34], y: [b.right, 6], flags: [b.right, 12] },
        instances: b.instances, nets: b.nets(),
      }),
    });
  });
}

/**
 * ±a × b ± c with one rounding: stage 1 (multiply), stage 2 (align and add), stage 3 (round).
 * The product is kept exact (2M + 2 bits); c is placed at the top of an equally wide field; the one
 * with the larger exponent is the base; one wide addition; one normalize & round. negProd negates
 * the product, negC the addend: fmadd (0, 0), fmsub (0, 1), fnmsub (1, 0), fnmadd (1, 1).
 */
export function fpFma(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpfma${E}_${M}`, () => {
    const { W0, WS } = fmaDims(f), N = 1 + E + M;
    const S1 = fmaMultiply(f), S2 = fmaAdd(f), S3 = fmaRound(f);
    const b = new Builder();
    const s1 = b.op(S1, ['a', 'b', 'c', 'negProd', 'negC'], 'multiply');
    b.next();
    const s2 = b.op(S2, [`${s1}.p`, `${s1}.mc`, `${s1}.dsat`, `${s1}.cBig`, `${s1}.eB`, `${s1}.sB`, `${s1}.effSub`, 'rm'], 'align and add');
    b.next();
    const s3 = b.op(S3, [`${s2}.sign`, `${s2}.ex`, `${s2}.sum`, 'rm', `${s1}.nan`, `${s1}.invalid`, `${s1}.anyInf`, `${s1}.infSign`, b.op1(TIE0, [])], 'round');
    b.wire(`${s3}.y`, 'y');
    b.wire(`${s3}.flags`, 'flags');
    return define({
      id: `fpfma${E}_${M}`, name: `${fmtName(f)} fused multiply-add`, category: 'arithmetic',
      summary: `±(a × b) ± c rounded once, in three boxes (the stages of the pipelined FPU): the ${M + 1} × ${M + 1} product kept exact (${W0} bits) and the exponents compared; the smaller operand aligned with guard and sticky bits and one ${WS}-bit addition (negated if it went negative); one normalize & round on ${WS + 1} bits. ∞ × 0 is invalid even if c is a quiet NaN.`,
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bus('c', N, 'in'), bit('negProd', 'in'), bit('negC', 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FMA' },
      spec: ([a, bb, c, np, nc, rm]) => { const r = fpFmaX(a, bb, c, !!np, !!nc, f, rm); return [r.y, r.fl]; },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 8], c: [0, 12], negProd: [0, 16], negC: [0, 20], rm: [0, 24], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `module fma32 (input logic [31:0] a, b, c, input logic negProd, negC, input logic [2:0] rm,
              output logic [31:0] y, output logic [4:0] flags);
  logic [23:0] ma, mb, mc;  logic signed [15:0] ea, eb, ec;          // prenormalized: 1.f x 2^e
  fp_prenorm na (.x(a), .m(ma), .e(ea)), nb (.x(b), .m(mb), .e(eb)), nc (.x(c), .m(mc), .e(ec));
  wire [47:0] p  = ma * mb;                                           // exact, in [1, 4)
  wire signed [15:0] ep = ea + eb - 16'sd126;                         // exponent of p[47]
  wire [47:0] cw = {mc, 24'b0};
  wire sp = a[31] ^ b[31] ^ negProd, sc = c[31] ^ negC, sub = sp ^ sc;
  wire cBig = ~cZero & (pZero | ec > ep);                             // base: the larger exponent
  wire [15:0] d = cBig ? ec - ep : ep - ec;
  // ---- stage 2
  logic [49:0] s;  logic st;                                          // smaller one, aligned, sticky
  shift_right_sticky #(50) al (.x({cBig ? p : cw, 2'b00}), .s(d > 63 ? 6'd63 : d[5:0]), .y(s), .sticky(st));
  wire [51:0] sum = {1'b0, cBig ? cw : p, 3'b000} + (sub ? -{1'b0, s, st} : {1'b0, s, st});
  wire negative = sub & sum[51];                                      // only when the exponents are close: exact
  wire [51:0] mag = negative ? -sum : sum;
  // ---- stage 3
  normround #(52) nr (.sign((cBig ? sc : sp) ^ negative), .exp((cBig ? ec : ep) + 1), .mant(mag), .stin(1'b0), .rm, .y(yr), .flags(fr));
  // + special cases: NaN in, inf x 0 (NV even with a quiet NaN c), inf - inf (NV), infinite terms; exact zero is +0 (-0 in RDN)
endmodule`,
      },
    });
  });
}

/**
 * fdiv / fsqrt with operand latches, for a pipeline: the operands are captured when an operation
 * starts and fed from the latches while it runs, so the forwarding paths that supplied them may
 * move on. Both units share the latches and stop before rounding (the pipeline's X stage rounds);
 * the outputs come from the one selected by sqrt, the root padded to the quotient's width.
 */
export function fpDivSqrtHeld(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpdsh${E}_${M}`, () => {
    const N = 1 + E + M, XE = xeOf(f), n = M + 4;
    const DV = fpDiv(f, false), SQ = fpSqrt(f, false);
    const b = new Builder();
    const ldD = b.op1(AND, ['div', b.op1(NOT, ['dv.busy'])]), ldS = b.op1(AND, ['sqrt', b.op1(NOT, ['sq.busy'])]);
    const hold = b.name(b.op1(OR, ['dv.busy', 'sq.busy'], 'running'), 'hold');
    b.next();
    const ld = b.name(b.op1(OR, [ldD, ldS], 'capture'), 'capture');
    reg(b, 'La', N, 'a', ld, 'a held');
    reg(b, 'Lb', N, 'b', ld, 'b held');
    reg(b, 'Lr', 3, 'rm', ld, 'rm held');
    b.next();
    const A = b.op1(busMux2(N), ['a', 'La.q', hold]), Bv = b.op1(busMux2(N), ['b', 'Lb.q', hold]), R = b.op1(busMux2(3), ['rm', 'Lr.q', hold]);
    b.next();
    b.add(DV, 'divider', 'dv');
    b.add(SQ, 'square root', 'sq');
    for (const [p, d] of [['clk', 'clk'], ['start', 'div'], ['a', A], ['b', Bv], ['rm', R]] as const) b.wire(d, `dv.${p}`);
    for (const [p, d] of [['clk', 'clk'], ['start', 'sqrt'], ['a', A], ['rm', R]] as const) b.wire(d, `sq.${p}`);
    b.next();
    const sqm = b.op1(merger([1, n - 1]), [b.op1(TIE0, []), 'sq.m']);
    b.wire(b.op1(busMux2(n), ['dv.m', sqm, 'sqrt']), 'm');
    b.wire(b.op1(busMux2(XE), ['dv.e', 'sq.e', 'sqrt']), 'e');
    for (const o of ['sign', 'sticky', 'nan', 'invalid', 'dz', 'inf', 'infSign', 'done']) b.wire(b.op1(MUX2, [`dv.${o}`, `sq.${o}`, 'sqrt']), o);
    b.wire(R, 'rmOut');
    b.wire(hold, 'busy');
    const outs = ['sign', 'e', 'm', 'sticky', 'nan', 'invalid', 'dz', 'inf', 'infSign', 'rmOut', 'done', 'busy'];
    return define({
      id: `fpdsh${E}_${M}`, name: `${fmtName(f)} divide / square root (unrounded, operand latches)`, category: 'arithmetic',
      summary: 'The iterative divider and square-root unit behind one set of operand latches: in the start cycle the live operands are used and captured; while the unit runs it reads the latches, so the pipeline\'s forwarding paths are free to move on. It stops before rounding: quotient or root, exponent, sign, sticky bit and special cases go down the FP pipe to the shared rounder.',
      ports: [bit('clk', 'in', 'bottom', true), bit('div', 'in'), bit('sqrt', 'in'), bus('a', N, 'in'), bus('b', N, 'in'), bus('rm', 3, 'in'),
        bit('sign', 'out'), bus('e', XE, 'out'), bus('m', n, 'out'), bit('sticky', 'out'), bit('nan', 'out'), bit('invalid', 'out'), bit('dz', 'out'), bit('inf', 'out'), bit('infSign', 'out'),
        bus('rmOut', 3, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'FDIV / FSQRT' },
      netlist: () => ({ pins: { div: [0, 2], sqrt: [0, 5], a: [0, 8], b: [0, 11], rm: [0, 14], clk: [0, 17], ...outPins(b, outs) }, instances: b.instances, nets: b.nets() }),
    });
  });
}

const FPU_VERILOG = `module fpu32 (input logic clk, go, input logic [31:0] a, b, c, xa, input logic [6:0] op, funct7, input logic [2:0] funct3,
              input logic [4:0] rs2, input logic [2:0] frm, output logic [31:0] y, output logic [4:0] flags, output logic stall);
  wire [2:0] rm = funct3 == 3'd7 ? frm : funct3;       // dynamic rounding mode
  wire sgn = ~rs2[0];                                   // fcvt.w.s / fcvt.s.w vs the unsigned forms
  logic [31:0] add, mul, mm, toi, cvt;  logic [4:0] fa, fm, fmm, fti, fcv;  logic [9:0] cls;
  logic eq, lt, le, unord, snan;
  fadd    u_add (.a, .b, .sub(funct7[2]), .rm, .y(add), .flags(fa));
  fmul    u_mul (.a, .b, .rm, .y(mul), .flags(fm));
  fcmp    u_cmp (.a, .b, .eq, .lt, .le, .unord, .snan);
  fminmax u_mm  (.a, .b, .max(funct3[0]), .y(mm), .flags(fmm));
  fcvt_w_s u_ti (.a, .signed_(sgn), .rm, .y(toi), .flags(fti));
  fcvt_s_w u_cv (.x(xa), .signed_(sgn), .rm, .y(cvt), .flags(fcv));
  fclass  u_cl  (.a, .y(cls));
  logic [31:0] dq, sq;  logic [4:0] fd, fs;  logic dDone, sDone;
  wire isDiv = go & funct7[6:2] == 5'b00011, isSqrt = go & funct7[6:2] == 5'b01011;
  fdiv_iter  u_dv (.clk, .start(isDiv), .a, .b, .rm, .y(dq), .flags(fd), .done(dDone), .busy());
  fsqrt_iter u_sq (.clk, .start(isSqrt), .a, .rm, .y(sq), .flags(fs), .done(sDone), .busy());
  assign stall = (isDiv & ~dDone) | (isSqrt & ~sDone);   // the CPU holds the instruction
  logic [31:0] fq;  logic [4:0] ff;
  fma32 u_fma (.a, .b, .c, .negProd(op[3]), .negC(op[2]), .rm, .y(fq), .flags(ff));   // fmadd fmsub fnmsub fnmadd
  logic [31:0] yo;  logic [4:0] fo;
  assign {y, flags} = op[6:4] == 3'b100 ? {fq, ff} : {yo, fo};
  wire sj = funct3[1] ? a[31] ^ b[31] : funct3[0] ? ~b[31] : b[31];
  wire cb = funct3[1] ? eq : funct3[0] ? lt : le;
  always_comb case (funct7[6:3])   // OP-FP
    4'h0: {yo, fo} = {add, fa};                                          // fadd.s / fsub.s
    4'h1: {yo, fo} = funct7[2] ? {dq, fd} : {mul, fm};                    // fdiv.s, fmul.s
    4'h2: {yo, fo} = funct7[2] ? {mm, fmm} : {{sj, a[30:0]}, 5'b0};       // fmin/fmax.s, fsgnj*.s
    4'h5: {yo, fo} = {sq, fs};                                           // fsqrt.s
    4'ha: {yo, fo} = {31'b0, cb, (funct3[1] ? snan : unord), 4'b0};       // feq / flt / fle.s
    4'hc: {yo, fo} = {toi, fti};                                         // fcvt.w[u].s
    4'hd: {yo, fo} = {cvt, fcv};                                         // fcvt.s.w[u]
    4'he: {yo, fo} = {funct3[0] ? {22'b0, cls} : a, 5'b0};               // fclass.s, fmv.x.w
    4'hf: {yo, fo} = {xa, 5'b0};                                         // fmv.w.x
    default: {yo, fo} = '0;
  endcase
endmodule`;

/**
 * The CPU's FPU: all of RV32F. OP-FP instructions are selected by funct7 (funct5): fadd.s, fsub.s,
 * fmul.s, fdiv.s, fsqrt.s, fsgnj[n|x].s, fmin/fmax.s, feq/flt/fle.s, fcvt.w[u].s, fcvt.s.w[u],
 * fmv.x.w, fclass.s, fmv.w.x; the four fused multiply-adds by their opcode (op). a, b, c are the
 * f-register operands (c = rs3), xa the integer rs1. The rounding mode is funct3, or frm when
 * funct3 = 7 (dynamic); flags go to fflags. fdiv.s and fsqrt.s are iterative: while they run,
 * stall = 1 and the CPU holds the instruction (go = it is OP-FP).
 */
export const FPU32: ComponentDef = (() => {
  const f = F32;
  const b = new Builder();
  const f7 = b.op(splitter([2, 1, 1, 1, 1, 1]), ['funct7']);
  const f3 = b.op(splitter([1, 1, 1]), ['funct3']);
  const r2 = b.op(splitter([1, 4]), ['rs2']);
  const as = b.op(splitter([31, 1]), ['a']), bs = b.op(splitter([31, 1]), ['b']);
  b.next();
  const dyn = b.op1(andN(3), [`${f3}.o0`, `${f3}.o1`, `${f3}.o2`], 'rm = dyn?');
  const nr2 = b.op1(NOT, [`${r2}.o0`], 'signed?');
  b.next();
  const rm = b.name(b.op1(busMux2(3), ['funct3', 'frm', dyn], 'rounding mode'), 'rm');
  b.next();
  const add = b.op(fpAdd(f), ['a', 'b', `${f7}.o1`, rm], 'adder');
  const mul = b.op(fpMul(f), ['a', 'b', rm], 'multiplier');
  const cmp = b.op(fpCompare(f), ['a', 'b'], 'comparator');
  const mm = b.op(fpMinMax(f), ['a', 'b', `${f3}.o0`], 'min / max');
  const cvt = b.op(fpFromInt(f), ['xa', nr2, rm], 'int → float');
  const toI = b.op(fpToInt(f), ['a', nr2, rm], 'float → int');
  const cls = b.op1(fpClassify(f), ['a'], 'classify');
  const ops = b.op(splitter([2, 1, 1, 1, 1, 1]), ['op']);
  const fma = b.op(fpFma(f), ['a', 'b', 'c', `${ops}.o2`, `${ops}.o1`, rm], 'fused multiply-add');
  const isFma = b.name(b.op1(andN(3), [`${ops}.o5`, b.op1(NOT, [`${ops}.o4`]), b.op1(NOT, [`${ops}.o3`])], 'FMADD group?'), 'isFMA');
  const f5 = b.op1(merger([1, 1, 1, 1, 1]), [`${f7}.o1`, `${f7}.o2`, `${f7}.o3`, `${f7}.o4`, `${f7}.o5`], 'funct5');
  const isDiv = b.name(b.op1(AND, ['go', b.op1(equal(5), [f5, b.op1(K(5, 0b00011), [])], 'fdiv?')]), 'isDiv');
  const isSqrt = b.name(b.op1(AND, ['go', b.op1(equal(5), [f5, b.op1(K(5, 0b01011), [])], 'fsqrt?')]), 'isSqrt');
  b.next();
  const dv = b.op(fpDiv(f), ['clk', isDiv, 'a', 'b', rm], 'divider (iterative)');
  const sq = b.op(fpSqrt(f), ['clk', isSqrt, 'a', rm], 'square root (iterative)');
  const waitD = b.op1(AND, [isDiv, b.op1(NOT, [`${dv}.done`])]), waitS = b.op1(AND, [isSqrt, b.op1(NOT, [`${sq}.done`])]);
  b.wire(b.op1(OR, [waitD, waitS], 'stall'), 'stall');
  b.next();
  const sj = b.op1(muxTree(2, 1), [`${bs}.o1`, b.op1(NOT, [`${bs}.o1`]), b.op1(XOR, [`${as}.o1`, `${bs}.o1`]), `${bs}.o1`, b.op1(merger([1, 1]), [`${f3}.o0`, `${f3}.o1`])], 'sign injection');
  const sgnj = b.op1(merger([31, 1]), [`${as}.o0`, sj]);
  const cbit = b.op1(muxTree(2, 1), [`${cmp}.le`, `${cmp}.lt`, `${cmp}.eq`, b.op1(TIE0, []), b.op1(merger([1, 1]), [`${f3}.o0`, `${f3}.o1`])]);
  const cmp32 = b.op1(merger([1, 31]), [cbit, b.op1(constWord(31, 0), [])]);
  const cmpNV = b.op1(MUX2, [`${cmp}.unord`, `${cmp}.snan`, `${f3}.o1`], 'feq is quiet');
  const cls32 = b.op1(merger([10, 22]), [cls, b.op1(K(22, 0), [])]);
  const sel = b.name(b.op1(merger([1, 1, 1, 1]), [`${f7}.o2`, `${f7}.o3`, `${f7}.o4`, `${f7}.o5`]), 'op');
  b.next();
  const g1 = b.op1(busMux2(32), [`${mul}.y`, `${dv}.y`, `${f7}.o1`], 'fmul / fdiv');
  const g2 = b.op1(busMux2(32), [sgnj, `${mm}.y`, `${f7}.o1`], 'sgnj / min-max');
  const g14 = b.op1(busMux2(32), ['a', cls32, `${f3}.o0`], 'fmv.x.w / fclass');
  const fl2 = b.op1(busMux2(5), [b.op1(K(5, 0), []), `${mm}.flags`, `${f7}.o1`]);
  const fl1 = b.op1(busMux2(5), [`${mul}.flags`, `${dv}.flags`, `${f7}.o1`]);
  const nvW = flagWord(b, { nv: cmpNV });
  b.next();
  const z = b.op1(K(32, 0), []), z5 = b.op1(K(5, 0), []);
  const ins = Array.from({ length: 16 }, () => z), fls = Array.from({ length: 16 }, () => z5);
  ins[0] = `${add}.y`; ins[1] = g1; ins[2] = g2; ins[5] = `${sq}.y`; ins[10] = cmp32; ins[12] = `${toI}.y`; ins[13] = `${cvt}.y`; ins[14] = g14; ins[15] = 'xa';
  fls[0] = `${add}.flags`; fls[1] = fl1; fls[2] = fl2; fls[5] = `${sq}.flags`; fls[10] = nvW; fls[12] = `${toI}.flags`; fls[13] = `${cvt}.flags`;
  const yOp = b.op1(muxTree(4, 32), [...ins, sel], 'OP-FP result');
  const fOp = b.op1(muxTree(4, 5), [...fls, sel], 'OP-FP flags');
  b.next();
  b.wire(b.op1(busMux2(32), [yOp, `${fma}.y`, isFma], 'result'), 'y');
  b.wire(b.op1(busMux2(5), [fOp, `${fma}.flags`, isFma], 'flags'), 'flags');
  return define({
    id: 'fpu32', name: 'Floating-point unit (RV32F)', category: 'cpu',
    summary: 'fadd.s, fsub.s, fmul.s, the four fused multiply-adds, sign injection, min / max, compares, conversions both ways, moves and fclass in one cycle; fdiv.s (29 cycles) and fsqrt.s (28 cycles) on iterative units that stall the CPU. Any rounding mode (funct3, or frm when funct3 = 7). The opcode picks fma, otherwise funct7 picks the result and the exception flags.',
    ports: [bit('clk', 'in', 'bottom', true), bus('a', 32, 'in'), bus('b', 32, 'in'), bus('c', 32, 'in'), bus('xa', 32, 'in'), bus('op', 7, 'in'), bus('funct7', 7, 'in'), bus('funct3', 3, 'in'), bus('rs2', 5, 'in'), bus('frm', 3, 'in'), bit('go', 'in'),
      bus('y', 32, 'out'), bus('flags', 5, 'out'), bit('stall', 'out')],
    symbol: { kind: 'box', label: 'FPU' },
    netlist: () => ({ pins: { a: [0, 4], b: [0, 8], c: [0, 12], xa: [0, 16], op: [0, 20], funct7: [0, 24], funct3: [0, 28], rs2: [0, 32], frm: [0, 36], go: [0, 40], clk: [0, 44], y: [b.right, 8], flags: [b.right, 14], stall: [b.right, 20] }, instances: b.instances, nets: b.nets() }),
    hdl: { verilog: FPU_VERILOG },
  });
})();


/**
 * Which floating-point instruction is this? flw / fsw / OP-FP, and for OP-FP whether the result
 * goes to an integer register (compares, fmv.x.w, fclass, fcvt.w.s) or a floating-point one.
 */
export const FP_DECODE: ComponentDef = (() => {
  const b = new Builder();
  const isFlw = b.name(b.op1(equal(7), ['op', b.op1(K(7, 0b0000111), [])], 'flw?'), 'isFLW');
  const isFsw = b.name(b.op1(equal(7), ['op', b.op1(K(7, 0b0100111), [])], 'fsw?'), 'isFSW');
  const isOp = b.name(b.op1(equal(7), ['op', b.op1(K(7, 0b1010011), [])], 'OP-FP?'), 'isOPFP');
  const o7 = b.op(splitter([1, 1, 2, 1, 1, 1]), ['op']);
  const isFma = b.name(b.op1(andN(5), [`${o7}.o0`, `${o7}.o1`, `${o7}.o5`, b.op1(NOT, [`${o7}.o4`]), b.op1(NOT, [`${o7}.o3`])], 'fmadd … fnmadd? (100xx11)'), 'isFMA');
  const f7 = b.op(splitter([2, 1, 1, 1, 1, 1]), ['funct7']);
  const os = b.op(splitter([2, 1, 4]), ['op']);
  b.next();
  const toInt = b.op1(andN(3), [isOp, `${f7}.o5`, b.op1(NOT, [`${f7}.o2`])], 'result → x');
  const toF = b.op1(AND, [isOp, b.op1(NOT, [toInt])], 'result → f');
  const mem = b.op1(OR, [isFlw, isFsw]);
  b.next();
  b.wire(isFlw, 'flw');
  b.wire(isFsw, 'fsw');
  b.wire(toInt, 'toInt');
  b.wire(b.op1(orN(3), [toF, isFlw, isFma], 'write f register'), 'fWrite');
  // flw / fsw look like lw / sw to the integer control unit: clear opcode bit 2
  b.wire(b.op1(merger([2, 1, 4]), [`${os}.o0`, b.op1(AND, [`${os}.o1`, b.op1(NOT, [mem])]), `${os}.o2`], 'as lw / sw'), 'opInt');
  b.wire(isOp, 'opfp');
  b.wire(b.op1(OR, [isOp, isFma], 'raises flags'), 'fpOp');
  b.wire(isFma, 'fma');
  return define({
    id: 'fpdec', name: 'Floating-point decoder', category: 'cpu',
    summary: 'Recognises flw, fsw, the OP-FP group and the four fused multiply-adds (opcodes 0x43, 0x47, 0x4B, 0x4F). flw and fsw are passed to the integer control unit disguised as lw and sw (same address calculation); only their register file differs. OP-FP results go to an f register, except compares, fclass, fcvt.w[u].s and fmv.x.w, which write an x register; fma results always go to an f register. opfp starts the iterative units; fpOp (OP-FP or fma) lets the exception flags into fflags.',
    ports: [bus('op', 7, 'in'), bus('funct7', 7, 'in'), bit('flw', 'out'), bit('fsw', 'out'), bit('toInt', 'out'), bit('fWrite', 'out'), bus('opInt', 7, 'out'), bit('opfp', 'out'), bit('fpOp', 'out'), bit('fma', 'out')],
    symbol: { kind: 'box', label: 'FP DECODE' },
    netlist: () => ({ pins: { op: [0, 4], funct7: [0, 10], flw: [b.right, 2], fsw: [b.right, 6], toInt: [b.right, 10], fWrite: [b.right, 14], opInt: [b.right, 18], opfp: [b.right, 22], fpOp: [b.right, 26], fma: [b.right, 30] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The floating-point control and status register, in the FPU path of the single-cycle CPU (this
 * CPU has no other CSRs): frm (3 bits) and fflags (5 bits), read and written by csrrw / csrrs /
 * csrrc (and their immediate forms) at addresses fflags 0x001, frm 0x002 and fcsr 0x003. Every
 * OP-FP instruction ORs its exception flags into fflags (they are sticky until software clears them).
 */
export const FCSR: ComponentDef = (() => {
  const b = new Builder();
  const isSys = b.op1(equal(7), ['op', b.op1(K(7, 0b1110011), [])], 'SYSTEM?');
  const f3 = b.op(splitter([1, 1, 1]), ['funct3']);
  const addr = b.op1(merger([5, 7]), ['rs2', 'funct7'], 'csr address');
  const r1z = b.op1(isZero(5), ['rs1']);
  b.next();
  const as = b.op(splitter([1, 1, 10]), [addr]);
  const hi0 = b.op1(isZero(10), [`${as}.o2`]);
  const lo = b.op1(OR, [`${as}.o0`, `${as}.o1`]);
  const opNZ = b.op1(OR, [`${f3}.o0`, `${f3}.o1`]);
  b.next();
  const hit = b.name(b.op1(andN(4), [isSys, opNZ, hi0, lo], 'fflags / frm / fcsr?'), 'hit');
  const isW = b.op1(AND, [`${f3}.o0`, b.op1(NOT, [`${f3}.o1`])], 'csrrw?');
  const writes = b.name(b.op1(AND, [hit, b.op1(OR, [isW, b.op1(NOT, [r1z])])], 'writes?'), 'writes');
  const a2 = b.op1(AND, [`${as}.o1`, b.op1(NOT, [`${as}.o0`])], 'frm alone');
  b.next();
  // the register's present value, in fcsr layout {frm, fflags}
  const ffq = 'flagsReg.q', frmq = 'frmReg.q';
  const old8 = b.name(b.op1(merger([5, 3]), [ffq, frmq], 'fcsr'), 'fcsr');
  // the source: rs1's value or the 5-bit immediate, aligned to the field being written
  const xs = b.op(splitter([8, 24]), ['xa']);
  const imm8 = b.op1(merger([5, 3]), ['rs1', b.op1(K(3, 0), [])]);
  const src = b.op1(busMux2(8), [`${xs}.o0`, imm8, `${f3}.o2`], 'rs1 / imm');
  const ssp = b.op(splitter([3, 5]), [src]);
  const srcFrm = b.op1(merger([5, 3]), [b.op1(K(5, 0), []), `${ssp}.o0`]);
  b.next();
  const srcA = b.op1(busMux2(8), [src, srcFrm, a2], 'align');
  b.next();
  const setv = b.op1(bitwise('or', 8), [old8, srcA]);
  const clrv = b.op1(bitwise('and', 8), [old8, b.op1(bitwise('xor', 8), [srcA, b.op1(K(8, 255), [])])]);
  b.next();
  const nv = b.op(splitter([5, 3]), [b.op1(muxTree(2, 8), [old8, srcA, setv, clrv, b.op1(merger([1, 1]), [`${f3}.o0`, `${f3}.o1`])], 'new value')]);
  const weF = b.op1(AND, [writes, `${as}.o0`], 'write fflags?');
  const weR = b.op1(AND, [writes, `${as}.o1`], 'write frm?');
  b.next();
  const keep = b.op1(busMux2(5), [ffq, `${nv}.o0`, weF]);
  const acc = b.op1(bitwise('and', 5), ['flags', b.op1(fanout(5), ['fpOp'])]);
  b.next();
  b.wire(b.op1(bitwise('or', 5), [keep, acc], 'accrue'), 'flagsReg.d');
  b.add(register(5), 'fflags', 'flagsReg');
  b.wire(b.op1(TIE1, []), 'flagsReg.en');
  b.wire(`${nv}.o1`, 'frmReg.d');
  b.wire(weR, 'frmReg.en');
  b.add(register(3), 'frm', 'frmReg');
  b.wire('clk', 'flagsReg.clk');
  b.wire('clk', 'frmReg.clk');
  b.next();
  // read: fflags (0x001) or frm (0x002) in the low bits, or both (0x003)
  const low5 = b.op1(busMux2(5), [ffq, b.op1(merger([3, 2]), [frmq, b.op1(K(2, 0), [])]), a2]);
  const both = b.op1(AND, [`${as}.o0`, `${as}.o1`]);
  const high3 = b.op1(bitwise('and', 3), [frmq, b.op1(fanout(3), [both])]);
  b.next();
  b.wire(b.op1(merger([5, 3, 24]), [low5, high3, b.op1(K(24, 0), [])], 'read value'), 'rdata');
  b.wire(hit, 'hit');
  b.wire(frmq, 'frm');
  b.wire(old8, 'fcsr');
  return define({
    id: 'fcsr', name: 'fcsr (frm + fflags)', category: 'cpu',
    summary: 'Two small registers: frm, the dynamic rounding mode used when an instruction says rm = 7, and fflags, the accrued exceptions NV DZ OF UF NX. csrrw / csrrs / csrrc (and the immediate forms) on 0x001, 0x002 or 0x003 read the old value into rd and write, set or clear bits. Every OP-FP instruction ORs its flags in: they stay set until software clears them, so one check after a long loop finds any exception in it.',
    ports: [bit('clk', 'in', 'bottom', true), bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('rs1', 5, 'in'), bus('funct7', 7, 'in'), bus('rs2', 5, 'in'), bus('xa', 32, 'in'), bus('flags', 5, 'in'), bit('fpOp', 'in'),
      bus('frm', 3, 'out'), bus('rdata', 32, 'out'), bit('hit', 'out'), bus('fcsr', 8, 'out')],
    symbol: { kind: 'box', label: 'fcsr' },
    netlist: () => ({
      pins: { op: [0, 2], funct3: [0, 6], rs1: [0, 10], funct7: [0, 14], rs2: [0, 18], xa: [0, 22], flags: [0, 26], fpOp: [0, 30], clk: [0, 34], frm: [b.right, 4], rdata: [b.right, 10], hit: [b.right, 16], fcsr: [b.right, 22] },
      instances: b.instances, nets: b.nets(),
    }),
    hdl: {
      verilog: `module fcsr (input logic clk, input logic [31:0] instr, xa, input logic [4:0] flags, input logic fpOp,
             output logic [2:0] frm, output logic [31:0] rdata, output logic hit);
  logic [4:0] fflags;
  wire [11:0] a = instr[31:20];  wire [2:0] f3 = instr[14:12];  wire [4:0] zimm = instr[19:15];
  assign hit = instr[6:0] == 7'b1110011 && f3[1:0] != 0 && a[11:2] == 0 && a[1:0] != 0;
  wire [7:0] old = {frm, fflags};
  wire [7:0] s0 = f3[2] ? {3'b0, zimm} : xa[7:0];
  wire [7:0] src = a == 12'h002 ? {s0[2:0], 5'b0} : s0;   // frm alone sits in bits 7:5
  logic [7:0] nv;
  always_comb case (f3[1:0]) 2'd1: nv = src; 2'd2: nv = old | src; default: nv = old & ~src; endcase
  wire wr = hit & (f3[1:0] == 2'd1 | zimm != 0);       // csrrs / csrrc with x0 do not write
  always_ff @(posedge clk) begin
    fflags <= (wr & a[0] ? nv[4:0] : fflags) | (fpOp ? flags : 5'b0);   // sticky
    if (wr & a[1]) frm <= nv[7:5];
  end
  assign rdata = a == 12'h002 ? {29'b0, frm} : a == 12'h001 ? {27'b0, fflags} : {24'b0, frm, fflags};
endmodule`,
    },
  });
})();
