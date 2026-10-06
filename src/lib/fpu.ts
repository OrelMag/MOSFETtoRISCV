// Level 10b: floating point (IEEE 754), parametric in the format (E exponent bits, M fraction bits)
// so that a tiny format can be tested exhaustively and float32 is the same circuit, bigger.
//   unpack → align (shift right, keep a sticky bit) → add / multiply → normalize (count leading
//   zeros, shift left, or right for subnormals) → round (any of the five RISC-V modes) → pack,
//   plus the special cases (zero, subnormal, infinity, NaN) and the exception flags. One
//   normalize-and-round unit serves the adder, the multiplier and integer-to-float conversion.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { andN, busMux2, equal, incrementer, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR, XNOR, XOR } from './gates';
import { condNegate, divStep, treeMul } from './muldiv';
import { DFF, register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';
import {
  F32, bias as fbias, fpAddX, fpClass, fpFmaX, fpCmpX, fpFromIntX, fpMinMaxX, fpMulX, fpToIntX, overflowToInf, RM, roundUp, type FpFormat,
} from '../sim/fpref';

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

/**
 * A small netlist builder: instances are added in "columns" (left to right as data flows), and
 * nets are collected per driver, so a component can be written as a sequence of operations.
 * Every net is drawn as a named label unless it is short and local; these are arithmetic
 * blocks best read by drilling into the sub-units.
 */
export class Builder {
  instances: InstanceDef[] = [];
  private sinks = new Map<string, string[]>();
  private names = new Map<string, string>();
  private col = 0;
  private y = 0;
  private colW = 0;
  private x = 10;
  private n = 0;
  /** Start a new column. */
  next(): void {
    if (this.y === 0) return;
    this.x += this.colW + 12;
    this.y = 0;
    this.colW = 0;
    this.col++;
  }
  add(def: ComponentDef, label?: string, name?: string): string {
    const nm = name ?? `u${this.n++}`;
    const g = symbolGeom(def);
    this.instances.push({ name: nm, def, at: [this.x, this.y + 2], label });
    this.y += g.h + 4;
    this.colW = Math.max(this.colW, g.w);
    return nm;
  }
  /** Connect a driver ("inst.port" or a component pin) to a sink. */
  wire(drv: string, sink: string): void {
    if (!this.sinks.has(drv)) this.sinks.set(drv, []);
    this.sinks.get(drv)!.push(sink);
  }
  name(drv: string, n: string): string {
    this.names.set(drv, n);
    return drv;
  }
  /** Instantiate def and wire its inputs (in port order) from drivers; returns the instance name. */
  op(def: ComponentDef, inputs: string[], label?: string): string {
    const nm = this.add(def, label);
    const ins = def.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    inputs.forEach((d, i) => this.wire(d, `${nm}.${ins[i]}`));
    return nm;
  }
  /** Single-output helper: returns "inst.out". */
  op1(def: ComponentDef, inputs: string[], label?: string): string {
    const nm = this.op(def, inputs, label);
    return `${nm}.${def.ports.find((p) => p.dir === 'out')!.name}`;
  }
  get right(): number { return this.x + this.colW + 12; }
  get height(): number { return Math.max(...this.instances.map((i) => (i.at![1] + symbolGeom(i.def).h))); }
  nets(): NetDef[] {
    const out: NetDef[] = [];
    for (const [d, ss] of this.sinks) out.push({ name: this.names.get(d), ends: [d, ...ss], tags: ss.length > 1 || !d.includes('.') ? true : undefined });
    return out;
  }
}

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
export function shiftLeft(w: number, k: number): ComponentDef {
  return memo(`shl${w}_${k}`, () => {
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
      cur = b.op1(busMux2(w), [cur, shifted, `${s}.o${j}`], `<< ${d}`);
    }
    b.wire(cur, 'y');
    return define({
      id: `shl${w}_${k}`, name: `${w}-bit left shifter`, category: 'arithmetic',
      summary: `${k} stages; stage j shifts by 2^j when amount bit j is 1. Zeros enter from the right.`,
      ports: [bus('x', w, 'in'), bus('s', k, 'in'), bus('y', w, 'out')],
      symbol: { kind: 'box', label: '<<' },
      spec: w + k <= 40 ? ([x, s]) => [(x * 2 ** s) % 2 ** w] : undefined,
      netlist: () => ({ pins: { x: [0, 4], s: [0, 10], y: [b.right, 4] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Logarithmic right shifter that ORs every bit shifted out into a sticky bit. */
export function shiftRightSticky(w: number, k: number): ComponentDef {
  return memo(`shrs${w}_${k}`, () => {
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
      cur = b.op1(busMux2(w), [cur, shifted, `${s}.o${j}`], `>> ${d}`);
    }
    b.next();
    b.wire(cur, 'y');
    b.wire(st.length === 1 ? st[0] : b.op1(st.length === 2 ? OR : orN(st.length), st, 'sticky'), 'sticky');
    return define({
      id: `shrs${w}_${k}`, name: `${w}-bit right shifter with sticky bit`, category: 'arithmetic',
      summary: 'Shifts right in log stages; any 1 that falls off the right end sets sticky, so rounding still knows the discarded part was not zero.',
      ports: [bus('x', w, 'in'), bus('s', k, 'in'), bus('y', w, 'out'), bit('sticky', 'out')],
      symbol: { kind: 'box', label: '>> sticky' },
      spec: w + k <= 40 ? ([x, s]) => [Math.floor(x / 2 ** s), x % 2 ** s ? 1 : 0] : undefined,
      netlist: () => ({ pins: { x: [0, 4], s: [0, 10], y: [b.right, 4], sticky: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
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
      netlist: () => ({
        pins: { x: [0, 4], sign: [b.right, 2], exp: [b.right, 6], mant: [b.right, 10], zero: [b.right, 14], inf: [b.right, 18], nan: [b.right, 22], snan: [b.right, 26] },
        instances: b.instances, nets: b.nets(),
      }),
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

/**
 * Normalize and round: mant (w bits, its top bit has weight 2^exp) plus a sticky bit → the IEEE
 * encoding, rounded in mode rm, and the flags OF, UF, NX. Leading zeros are shifted out (left) as
 * far as the exponent allows; below the smallest exponent the significand is shifted right
 * instead (a subnormal). Tininess is detected after rounding: the result is tiny if, rounded to
 * M + 1 bits with an unbounded exponent, it would still be below 2^emin.
 */
export function normRound(f: FpFormat, w: number): ComponentDef {
  const { E, M } = f;
  return memo(`fpnr${E}_${M}_${w}`, () => {
    const XE = xeOf(f), P = pow2ceil(w + 1), k = Math.log2(P);
    if (w < M + 3) throw new Error('normRound: the significand needs a guard bit and a sticky bit below it');
    const b = new Builder();
    // 1. leading zeros (padded with ones below, so an all-zero significand counts w)
    const pad = b.op1(merger([P - w, w]), [b.op1(K(P - w, 2 ** (P - w) - 1), []), 'mant']);
    b.next();
    const lz = b.op(lzc(P), [pad], 'leading zeros');
    b.next();
    const c = b.name(b.op1(merger([k, XE - k]), [`${lz}.c`, b.op1(K(XE - k, 0), [])]), 'lz');
    const em1 = b.name(`${b.op(koggeStone(XE), ['exp', b.op1(K(XE, 2 ** XE - 1), []), b.op1(TIE0, [])], 'exp − 1')}.s`, 'exp−1');
    b.next();
    const t = b.op(addSubFast(XE), [em1, c, b.op1(TIE1, [])], 'exp − 1 − lz');
    const canNorm = b.name(b.op1(NOT, [`${t}.n`]), 'canNormalize');
    const es = b.op(splitter([k, XE - 1 - k, 1]), [em1]);
    const em1Neg = b.name(`${es}.o2`, 'exp<1');
    const negEm1 = b.op(addSubFast(XE), [b.op1(K(XE, 0), []), em1, b.op1(TIE1, [])], '1 − exp');
    b.next();
    const Lalt = b.op1(busMux2(k), [`${es}.o0`, b.op1(K(k, 0), []), em1Neg]);
    const L = b.name(b.op1(busMux2(k), [Lalt, `${lz}.c`, canNorm], 'left shift'), 'L');
    const ns = b.op(splitter([k, XE - k]), [`${negEm1}.s`]);
    const hiNZ = b.op1(NOT, [b.op1(isZero(XE - k), [`${ns}.o1`])]);
    const Rsat = b.op1(busMux2(k), [`${ns}.o0`, b.op1(K(k, 2 ** k - 1), []), hiNZ]);
    const R = b.name(b.op1(bitwise('and', k), [Rsat, b.op1(fanout(k), [em1Neg])], 'right shift'), 'R');
    const eNorm = b.op1(incFast(XE), [`${t}.s`]);
    const eAfter = b.name(b.op1(busMux2(XE), [b.op1(K(XE, 1), []), eNorm, canNorm]), 'e');
    // in parallel with the shifts and the rounding: e + 1 (for a carry out of the rounding) and the overflow tests on e
    const eInc = b.name(b.op1(incFast(XE), [eAfter], 'e + 1'), 'e+1');
    const geTop = b.name(b.op1(NOT, [`${b.op(addSubFast(XE), [eAfter, b.op1(K(XE, 2 ** E - 1), []), b.op1(TIE1, [])], 'e ≥ max?')}.n`]), 'e≥max');
    const atTop = b.name(b.op1(equal(XE), [eAfter, b.op1(K(XE, 2 ** E - 2), [])], 'e = max − 1?'), 'e=max−1');
    b.next();
    // 2. shift
    const sh1 = b.op1(shiftLeft(w, k), ['mant', L], 'normalize');
    b.next();
    const sh2 = b.op(shiftRightSticky(w, k), [sh1, R], 'subnormal');
    b.next();
    // 3. round: G = first dropped bit, Rb = the next one, S2 = OR of everything below Rb
    const parts = b.op(splitter([w - M - 2, 1, M + 1]), [`${sh2}.y`]);
    let Rb: string, S2: string;
    if (w - M - 2 === 1) {
      Rb = `${parts}.o0`;
      S2 = anyOf(b, [`${sh2}.sticky`, 'stin']);
    } else {
      const rs = b.op(splitter([w - M - 3, 1]), [`${parts}.o0`]);
      Rb = `${rs}.o1`;
      S2 = anyOf(b, [nonZero(b, `${rs}.o0`, w - M - 3), `${sh2}.sticky`, 'stin']);
    }
    const S = b.name(b.op1(OR, [Rb, S2]), 'S');
    const G = b.name(`${parts}.o1`, 'G');
    const lsb = b.op(splitter([1, M]), [`${parts}.o2`]);
    const kt = b.op(splitter([M, 1]), [`${parts}.o2`]);
    b.next();
    const rd = b.op(ROUND_DECIDE, ['rm', 'sign', `${lsb}.o0`, G, S], 'round up?');
    const inc = b.name(`${rd}.up`, 'roundUp');
    const nx0 = b.name(b.op1(OR, [G, S]), 'inexact');
    // tininess after rounding: would rounding to M + 1 bits (G becomes the last bit) reach 2^emin?
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
    const eF = b.name(b.op1(busMux2(XE), [eAfter, eInc, carry], 'exp + carry'), 'eFinal');
    const tiny = b.name(b.op1(AND, [b.op1(NOT, [`${kt}.o1`]), b.op1(NOT, [reach])], 'tiny?'), 'tiny');
    b.next();
    const inf = b.name(b.op1(AND, [hidden, b.op1(OR, [geTop, b.op1(AND, [carry, atTop])], 'overflow?')]), 'overflow');
    const satMax = b.name(b.op1(AND, [inf, b.op1(NOT, [`${rd}.toInf`])], 'largest finite instead'), 'satMax');
    const ef = b.op(splitter([E, XE - E]), [eF]);
    b.next();
    const expF = b.op1(bitwise('and', E), [`${ef}.o0`, b.op1(fanout(E), [hidden])]);
    const expOr = b.op(splitter([1, E - 1]), [b.op1(bitwise('or', E), [expF, b.op1(fanout(E), [inf])])]);
    const e0 = b.op1(AND, [`${expOr}.o0`, b.op1(NOT, [satMax])]);
    const fracOut = b.op1(bitwise('or', M), [b.op1(bitwise('and', M), [`${ms}.o0`, b.op1(fanout(M), [b.op1(NOT, [inf])])]), b.op1(fanout(M), [satMax])]);
    b.next();
    b.wire(b.op1(merger([M, 1, E - 1, 1]), [fracOut, e0, `${expOr}.o1`, 'sign']), 'y');
    b.wire(flagWord(b, { of: inf, uf: b.op1(AND, [tiny, nx0], 'UF'), nx: b.op1(OR, [nx0, inf], 'NX') }), 'flags');
    return define({
      id: `fpnr${E}_${M}_${w}`, name: 'Normalize & round', category: 'arithmetic',
      summary: 'Counts leading zeros, shifts them out (or shifts right for a subnormal result), then rounds in mode rm using the guard bit G and the sticky bit S (round to nearest even: up if G and (S or the last kept bit)). A carry out of the rounding bumps the exponent; an exponent past the top becomes ∞ or the largest finite number, depending on the mode. Flags: NX if G or S, OF on overflow, UF if inexact and tiny after rounding.',
      ports: [bit('sign', 'in'), bus('exp', XE, 'in'), bus('mant', w, 'in'), bit('stin', 'in'), bus('rm', 3, 'in'), bus('y', 1 + E + M, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'NORMALIZE & ROUND' },
      netlist: () => ({ pins: { sign: [0, 2], exp: [0, 6], mant: [0, 10], stin: [0, 14], rm: [0, 18], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
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
function specials(b: Builder, f: FpFormat, nr: string, nrFlags: string, nan: string, anyInf: string, infSign: string, invalid: string): void {
  const N = 1 + f.E + f.M;
  const y1 = b.op1(busMux2(N), [nr, infValue(b, f, infSign), anyInf], 'infinity');
  b.wire(b.op1(busMux2(N), [y1, nanValue(b, f), nan], 'NaN'), 'y');
  const special = b.op1(OR, [nan, anyInf]);
  b.wire(b.op1(busMux2(5), [nrFlags, flagWord(b, { nv: invalid }), special], 'flags'), 'flags');
}

/** a ± b: swap so |big| ≥ |small|, align small by the exponent difference, add or subtract, normalize & round. */
export function fpAdd(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpadd${E}_${M}`, () => {
    const XE = xeOf(f), WA = M + 3, kA = log2c(WA + 1), WS = M + 4, N = 1 + E + M;
    const b = new Builder();
    const ua = b.op(fpUnpack(f), ['a'], 'unpack a'), ub = b.op(fpUnpack(f), ['b'], 'unpack b');
    const ma = b.op(splitter([E + M, 1]), ['a']), mb = b.op(splitter([E + M, 1]), ['b']);
    b.next();
    const sbEff = b.name(b.op1(XOR, [`${ub}.sign`, 'sub'], 'b sign (−b for fsub)'), 'signB');
    const ge = b.name(`${b.op(addSubFast(E + M), [`${ma}.o0`, `${mb}.o0`, b.op1(TIE1, [])], '|a| ≥ |b| ?')}.cout`, 'aBigger');
    b.next();
    const eB = b.name(b.op1(busMux2(E), [`${ub}.exp`, `${ua}.exp`, ge], 'swap'), 'eBig');
    const eS = b.op1(busMux2(E), [`${ua}.exp`, `${ub}.exp`, ge]);
    const mB = b.name(b.op1(busMux2(M + 1), [`${ub}.mant`, `${ua}.mant`, ge]), 'mBig');
    const mS = b.op1(busMux2(M + 1), [`${ua}.mant`, `${ub}.mant`, ge]);
    const sB = b.name(b.op1(MUX2, [sbEff, `${ua}.sign`, ge]), 'signBig');
    const effSub = b.name(b.op1(XOR, [`${ua}.sign`, sbEff], 'subtract?'), 'effSub');
    b.next();
    const d = b.op(addSubFast(E), [eB, eS, b.op1(TIE1, [])], 'exponent difference');
    let dsat: string;
    if (kA < E) {
      const ds = b.op(splitter([kA, E - kA]), [`${d}.s`]);
      const big = b.op1(NOT, [b.op1(isZero(E - kA), [`${ds}.o1`])]);
      dsat = b.op1(busMux2(kA), [`${ds}.o0`, b.op1(K(kA, 2 ** kA - 1), []), big]);
    } else dsat = kA === E ? `${d}.s` : b.op1(merger([E, kA - E]), [`${d}.s`, b.op1(K(kA - E, 0), [])]);
    b.next();
    const al = b.op(shiftRightSticky(WA, kA), [b.op1(merger([2, M + 1]), [b.op1(K(2, 0), []), mS]), dsat], 'align');
    b.next();
    const opB = b.op1(merger([1, 2, M + 1]), [b.op1(TIE0, []), b.op1(K(2, 0), []), mB]);
    const opS = b.op1(merger([1, WA]), [`${al}.sticky`, `${al}.y`]);
    const sum = b.op(addSubFast(WS), [opB, opS, effSub], 'add / subtract');
    b.next();
    const top = b.op1(AND, [`${sum}.cout`, b.op1(NOT, [effSub])]);
    const sm = b.name(b.op1(merger([WS, 1]), [`${sum}.s`, top]), 'sum');
    const zs = b.op1(isZero(WS + 1), [sm]);
    const exactZero = b.name(b.op1(AND, [effSub, zs], 'x − x'), 'cancel');
    const sign = b.op1(MUX2, [sB, isMode(b, 'rm', RM.RDN, 'RDN?'), exactZero], 'x − x = +0 (−0 in RDN)');
    const ex = b.op1(incFast(XE), [b.op1(merger([E, XE - E]), [eB, b.op1(K(XE - E, 0), [])])]);
    b.next();
    const nr = b.op(normRound(f, WS + 1), [sign, ex, sm, b.op1(TIE0, []), 'rm'], 'normalize & round');
    b.next();
    const invalid = b.name(b.op1(orN(3), [`${ua}.snan`, `${ub}.snan`, b.op1(andN(3), [`${ua}.inf`, `${ub}.inf`, effSub])], 'invalid'), 'NV');
    const nan = b.op1(orN(3), [`${ua}.nan`, `${ub}.nan`, invalid], 'NaN?');
    const anyInf = b.op1(OR, [`${ua}.inf`, `${ub}.inf`]);
    const infS = b.op1(MUX2, [sbEff, `${ua}.sign`, `${ua}.inf`]);
    b.next();
    specials(b, f, `${nr}.y`, `${nr}.flags`, nan, anyInf, infS, invalid);
    return define({
      id: `fpadd${E}_${M}`, name: `${fmtName(f)} adder / subtractor`, category: 'arithmetic',
      summary: 'Compare magnitudes and swap; shift the smaller significand right by the exponent difference (guard, round and sticky bits keep track of what falls off); add or subtract; normalize and round in mode rm. Then the special cases: NaN in or ∞ − ∞ gives NaN (NV for ∞ − ∞ or a signaling NaN), an infinite operand gives infinity.',
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bit('sub', 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FADD' },
      spec: ([a, bb, s, rm]) => { const r = fpAddX(a, bb, !!s, f, rm); return [r.y, r.fl]; },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], sub: [0, 16], rm: [0, 20], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: { verilog: `// behaviourally: assign {y, flags} = sub ? fsub(a, b, rm) : fadd(a, b, rm);   (IEEE 754 binary)` },
    });
  });
}

/** a × b: multiply significands (a tree multiplier), add exponents, normalize & round. */
export function fpMul(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpmul${E}_${M}`, () => {
    const XE = xeOf(f), N = 1 + E + M, W = 2 * M + 2, B = fbias(f);
    const b = new Builder();
    const ua = b.op(fpUnpack(f), ['a'], 'unpack a'), ub = b.op(fpUnpack(f), ['b'], 'unpack b');
    b.next();
    const sign = b.op1(XOR, [`${ua}.sign`, `${ub}.sign`], 'sign');
    const p = b.name(b.op1(treeMul(M + 1), [`${ua}.mant`, `${ub}.mant`], 'significand product'), 'product');
    const za = b.op1(merger([E, XE - E]), [`${ua}.exp`, b.op1(K(XE - E, 0), [])]);
    const zb = b.op1(merger([E, XE - E]), [`${ub}.exp`, b.op1(K(XE - E, 0), [])]);
    b.next();
    const s1 = b.op(koggeStone(XE), [za, zb, b.op1(TIE0, [])], 'ea + eb');
    const s2 = b.op(koggeStone(XE), [`${s1}.s`, b.op1(K(XE, (1 - B + 2 ** XE) % 2 ** XE), []), b.op1(TIE0, [])], '− bias + 1');
    b.next();
    const nr = b.op(normRound(f, W), [sign, `${s2}.s`, p, b.op1(TIE0, []), 'rm'], 'normalize & round');
    b.next();
    const invalid = b.name(b.op1(orN(4), [`${ua}.snan`, `${ub}.snan`, b.op1(AND, [`${ua}.inf`, `${ub}.zero`]), b.op1(AND, [`${ua}.zero`, `${ub}.inf`])], 'invalid'), 'NV');
    const nan = b.op1(orN(3), [`${ua}.nan`, `${ub}.nan`, invalid], 'NaN?');
    const anyInf = b.op1(OR, [`${ua}.inf`, `${ub}.inf`]);
    b.next();
    specials(b, f, `${nr}.y`, `${nr}.flags`, nan, anyInf, sign, invalid);
    return define({
      id: `fpmul${E}_${M}`, name: `${fmtName(f)} multiplier`, category: 'arithmetic',
      summary: `Sign = XOR, exponent = ea + eb − bias, significand = a ${M + 1}×${M + 1} tree multiplier (chapter 20), then the shared normalize & round unit. ∞ × 0 is NaN (NV).`,
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FMUL' },
      spec: ([a, bb, rm]) => { const r = fpMulX(a, bb, f, rm); return [r.y, r.fl]; },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], rm: [0, 16], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: { verilog: '// behaviourally: assign {y, flags} = fmul(a, b, rm);   (IEEE 754 binary)' },
    });
  });
}

/** Integer → float (fcvt.s.w / fcvt.s.wu): take the magnitude and let normalize & round do the rest. */
export function fpFromInt(f: FpFormat, w = 32): ComponentDef {
  const { E, M } = f;
  return memo(`fpcvt${E}_${M}_${w}`, () => {
    const XE = xeOf(f), N = 1 + E + M;
    const b = new Builder();
    const sp = b.op(splitter([w - 1, 1]), ['x']);
    const neg = b.op1(AND, [`${sp}.o1`, 'signed'], 'negative?');
    b.next();
    const mag = b.op1(condNegate(w), ['x', neg], '|x|');
    b.next();
    const nr = b.op(normRound(f, w), [neg, b.op1(K(XE, w - 1 + fbias(f)), []), mag, b.op1(TIE0, []), 'rm'], 'normalize & round');
    b.wire(`${nr}.y`, 'y');
    b.wire(`${nr}.flags`, 'flags');
    return define({
      id: `fpcvt${E}_${M}_${w}`, name: `int${w} → ${fmtName(f)}`, category: 'arithmetic',
      summary: `The magnitude of the integer is a significand whose top bit has weight 2^${w - 1}. Normalize & round shifts out the leading zeros; integers above 2^${M + 1} lose low bits and are rounded in mode rm (NX).`,
      ports: [bus('x', w, 'in'), bit('signed', 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'INT→FLOAT' },
      spec: ([x, s, rm]) => { const r = fpFromIntX(x, !!s, f, rm, w); return [r.y, r.fl]; },
      netlist: () => ({ pins: { x: [0, 4], signed: [0, 10], rm: [0, 14], y: [b.right, 6], flags: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * Float → integer (fcvt.w.s / fcvt.wu.s): place the significand so that its hidden bit has weight
 * 2^(w−1), shift right by (w − 1) − exponent keeping G and a sticky bit, round in mode rm, then
 * check the range. NaN, ∞ and out-of-range values saturate and raise NV.
 */
export function fpToInt(f: FpFormat, w = 32): ComponentDef {
  const { E, M } = f;
  return memo(`fptoint${E}_${M}_${w}`, () => {
    const XE = xeOf(f), k = log2c(w + 2);
    if (w < M + 1) throw new Error('fpToInt: the integer must be at least as wide as the significand');
    const b = new Builder();
    const u = b.op(fpUnpack(f), ['a'], 'unpack');
    b.next();
    const ze = b.op1(merger([E, XE - E]), [`${u}.exp`, b.op1(K(XE - E, 0), [])]);
    const sAmt = b.op(addSubFast(XE), [b.op1(K(XE, w - 1 + fbias(f)), []), ze, b.op1(TIE1, [])], `(${w - 1} + bias) − exp`);
    b.next();
    const ss = b.op(splitter([k, XE - 1 - k, 1]), [`${sAmt}.s`]);
    const tooBig = b.name(`${ss}.o2`, 'exp too big');
    const sat = b.op1(busMux2(k), [`${ss}.o0`, b.op1(K(k, 2 ** k - 1), []), nonZero(b, `${ss}.o1`, XE - 1 - k)], 'shift');
    const T = b.op1(merger([w - M, M + 1]), [b.op1(K(w - M, 0), []), `${u}.mant`]);
    b.next();
    const sh = b.op(shiftRightSticky(w + 1, k), [T, sat], 'align to the binary point');
    b.next();
    const gi = b.op(splitter([1, w]), [`${sh}.y`]);
    const il = b.op(splitter([1, w - 1]), [`${gi}.o1`]);
    const rd = b.op(ROUND_DECIDE, ['rm', `${u}.sign`, `${il}.o0`, `${gi}.o0`, `${sh}.sticky`], 'round up?');
    const nx0 = b.op1(OR, [`${gi}.o0`, `${sh}.sticky`], 'inexact');
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
    const okS = b.op1(MUX2, [okSP, okSN, `${u}.sign`]), okU = b.op1(MUX2, [nc, okUN, `${u}.sign`]);
    const ok = b.op1(MUX2, [okU, okS, 'signed'], 'in range?');
    b.next();
    const invalid = b.name(b.op1(orN(4), [`${u}.nan`, `${u}.inf`, tooBig, b.op1(NOT, [ok])], 'invalid'), 'NV');
    const val = b.op1(condNegate(w), [I, `${u}.sign`], '±n');
    const satNeg = b.op1(AND, [`${u}.sign`, b.op1(NOT, [`${u}.nan`])]);
    const nsn = b.op1(NOT, [satNeg]);
    const satTop = b.op1(MUX2, [nsn, satNeg, 'signed']);
    b.next();
    const satV = b.op1(merger([w - 1, 1]), [b.op1(fanout(w - 1), [nsn]), satTop], 'saturate');
    b.wire(b.op1(busMux2(w), [val, satV, invalid], 'result'), 'y');
    b.wire(flagWord(b, { nv: invalid, nx: b.op1(AND, [nx0, b.op1(NOT, [invalid])]) }), 'flags');
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
    const sub = b.name(b.op1(AND, [b.op1(NOT, [`${ms}.o1`]), b.op1(NOT, [`${u}.zero`])], 'subnormal'), 'subnormal');
    const normal = b.name(b.op1(AND, [`${ms}.o1`, b.op1(NOT, [b.op1(OR, [`${u}.inf`, `${u}.nan`])])], 'normal'), 'normal');
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

/**
 * a / b, iteratively: prenormalize both significands, then one restoring division step per
 * clock (the integer divider's step, chapter 20) produces M + 4 quotient bits, most significant
 * first, and the final remainder is the sticky bit. Normalize & round finishes in the done cycle.
 */
export function fpDiv(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpdiv${E}_${M}`, () => {
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
    const nr = b.op(normRound(f, n), [sign, `${eq}.s`, 'Q.q', stk, 'rm'], 'normalize & round');
    b.next();
    divSpecials(b, f, ua, ub, sign, nr);
    b.wire(`${ctl}.done`, 'done');
    b.wire(`${ctl}.busy`, 'busy');
    return define({
      id: `fpdiv${E}_${M}`, name: `${fmtName(f)} divider (iterative)`, category: 'arithmetic',
      summary: `Radix-2 restoring division of the normalized significands: one quotient bit per clock, ${n} steps (M + 1 bits, a guard bit and two more so that a quotient below 1 still has them), the final remainder ≠ 0 is the sticky bit. Exponent = ea − eb + bias. ${n + 2} cycles from start to the edge that writes the result. x / 0 = ∞ with DZ; 0 / 0 and ∞ / ∞ are NaN with NV.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', N, 'in'), bus('b', N, 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'FDIV (iterative)' },
      netlist: () => ({ pins: { start: [0, 2], a: [0, 6], b: [0, 10], rm: [0, 14], clk: [0, 18], y: [b.right, 4], flags: [b.right, 8], done: [b.right, 12], busy: [b.right, 16] }, instances: b.instances, nets: b.nets() }),
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
export function fpSqrt(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpsqrt${E}_${M}`, () => {
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
    const nr = b.op(normRound(f, n), [b.op1(TIE0, []), er, 'Q.q', stk, 'rm'], 'normalize & round');
    b.next();
    const neg = b.op1(andN(3), [`${u}.sign`, b.op1(NOT, [`${u}.zero`]), b.op1(NOT, [`${u}.nan`])], 'a < 0');
    const passA = b.op1(OR, [`${u}.zero`, `${u}.inf`], '±0, +∞: itself');
    b.next();
    const nan = b.op1(OR, [`${u}.nan`, neg], 'NaN?');
    const invalid = b.name(b.op1(OR, [`${u}.snan`, neg], 'invalid'), 'NV');
    const y1 = b.op1(busMux2(N), [`${nr}.y`, 'a', passA]);
    b.next();
    b.wire(b.op1(busMux2(N), [y1, nanValue(b, f), nan], 'NaN'), 'y');
    b.wire(b.op1(busMux2(5), [`${nr}.flags`, flagWord(b, { nv: invalid }), b.op1(OR, [nan, passA])], 'flags'), 'flags');
    b.wire(`${ctl}.done`, 'done');
    b.wire(`${ctl}.busy`, 'busy');
    return define({
      id: `fpsqrt${E}_${M}`, name: `${fmtName(f)} square root (iterative)`, category: 'arithmetic',
      summary: `Radix-2 restoring square root: the radicand (the significand, doubled if the exponent is odd) feeds two bits per clock into the remainder; each step tries 4q + 1 and appends one root bit. ${n} steps, ${n + 2} cycles. The exponent is halved; √−0 = −0, the root of a negative number is NaN with NV.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', N, 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'FSQRT (iterative)' },
      netlist: () => ({ pins: { start: [0, 2], a: [0, 6], rm: [0, 10], clk: [0, 14], y: [b.right, 4], flags: [b.right, 8], done: [b.right, 12], busy: [b.right, 16] }, instances: b.instances, nets: b.nets() }),
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
    const s1 = b.op(koggeStone(XE), [`${pa}.e`, `${pb}.e`, b.op1(TIE0, [])], 'ea + eb');
    const effSub = b.name(b.op1(XOR, [ps, sc], 'subtract?'), 'effSub');
    b.wire(effSub, 'effSub');
    const pZero = b.op1(OR, [`${ua}.zero`, `${ub}.zero`], 'product = 0');
    b.next();
    const ep = b.name(`${b.op(koggeStone(XE), [`${s1}.s`, b.op1(K(XE, (1 - B + 2 ** XE) % 2 ** XE), []), b.op1(TIE0, [])], '− bias + 1')}.s`, 'eP');
    b.next();
    const d = b.op(addSubFast(XE), [ep, `${pc}.e`, b.op1(TIE1, [])], 'eP − eC');
    b.next();
    // the base is the operand with the larger exponent; a zero product always yields to c, a zero c to the product
    const cBig = b.name(b.op1(AND, [b.op1(NOT, [`${uc}.zero`]), b.op1(OR, [pZero, `${d}.n`])], 'c bigger?'), 'cBig');
    const ad = b.op(splitter([kA, XE - kA]), [b.op1(condNegate(XE), [`${d}.s`, `${d}.n`], '|eP − eC|')]);
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
    specials(b, f, `${nr}.y`, `${nr}.flags`, 'nan', 'anyInf', 'infSign', 'invalid');
    return define({
      id: `fmarnd${E}_${M}`, name: `${fmtName(f)} FMA stage 3: round`, category: 'arithmetic',
      summary: `Normalize & round on ${WS + 1} bits, the only rounding of the whole operation; then NaN or ∞ if stage 1 said so (and only NV as a flag in that case).`,
      ports: [bit('sign', 'in'), bus('ex', XE, 'in'), bus('sum', WS + 1, 'in'), bus('rm', 3, 'in'), bit('nan', 'in'), bit('invalid', 'in'), bit('anyInf', 'in'), bit('infSign', 'in'),
        bus('y', N, 'out'), bus('flags', 5, 'out')],
      symbol: { kind: 'box', label: 'FMA 3: ROUND' },
      netlist: () => ({
        pins: { sign: [0, 2], ex: [0, 6], sum: [0, 10], rm: [0, 14], nan: [0, 18], invalid: [0, 22], anyInf: [0, 26], infSign: [0, 30], y: [b.right, 6], flags: [b.right, 12] },
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
    const s3 = b.op(S3, [`${s2}.sign`, `${s2}.ex`, `${s2}.sum`, 'rm', `${s1}.nan`, `${s1}.invalid`, `${s1}.anyInf`, `${s1}.infSign`], 'round');
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
 * move on. Both units share the latches; y, flags and done come from the one selected by sqrt.
 */
export function fpDivSqrtHeld(f: FpFormat): ComponentDef {
  const { E, M } = f;
  return memo(`fpdsh${E}_${M}`, () => {
    const N = 1 + E + M;
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
    b.add(fpDiv(f), 'divider', 'dv');
    b.add(fpSqrt(f), 'square root', 'sq');
    for (const [p, d] of [['clk', 'clk'], ['start', 'div'], ['a', A], ['b', Bv], ['rm', R]] as const) b.wire(d, `dv.${p}`);
    for (const [p, d] of [['clk', 'clk'], ['start', 'sqrt'], ['a', A], ['rm', R]] as const) b.wire(d, `sq.${p}`);
    b.next();
    b.wire(b.op1(busMux2(N), ['dv.y', 'sq.y', 'sqrt']), 'y');
    b.wire(b.op1(busMux2(5), ['dv.flags', 'sq.flags', 'sqrt']), 'flags');
    b.wire(b.op1(MUX2, ['dv.done', 'sq.done', 'sqrt']), 'done');
    b.wire(hold, 'busy');
    return define({
      id: `fpdsh${E}_${M}`, name: `${fmtName(f)} divide / square root with operand latches`, category: 'arithmetic',
      summary: 'The iterative divider and square-root unit behind one set of operand latches: in the start cycle the live operands are used and captured; while the unit runs it reads the latches, so the pipeline\'s forwarding paths are free to move on.',
      ports: [bit('clk', 'in', 'bottom', true), bit('div', 'in'), bit('sqrt', 'in'), bus('a', N, 'in'), bus('b', N, 'in'), bus('rm', 3, 'in'), bus('y', N, 'out'), bus('flags', 5, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'FDIV / FSQRT' },
      netlist: () => ({ pins: { div: [0, 2], sqrt: [0, 5], a: [0, 8], b: [0, 11], rm: [0, 14], clk: [0, 17], y: [b.right, 4], flags: [b.right, 8], done: [b.right, 12], busy: [b.right, 16] }, instances: b.instances, nets: b.nets() }),
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
