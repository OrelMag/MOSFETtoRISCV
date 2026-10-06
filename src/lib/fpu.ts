// Level 10b: floating point (IEEE 754), parametric in the format (E exponent bits, M fraction bits)
// so that a tiny format can be tested exhaustively and float32 is the same circuit, bigger.
//   unpack → align (shift right, keep a sticky bit) → add / multiply → normalize (count leading
//   zeros, shift left, or right for subnormals) → round to nearest even → pack, plus the special
//   cases (zero, subnormal, infinity, NaN). One normalize-and-round unit serves the adder, the
//   multiplier and integer-to-float conversion.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { andN, busMux2, equal, incrementer, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR, XNOR, XOR } from './gates';
import { condNegate, treeMul } from './muldiv';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';
import { F32, bias as fbias, fpAddRef, fpFromIntRef, fpMulRef, type FpFormat } from '../sim/fpref';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
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
class Builder {
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

/** Exponent arithmetic width: two's complement, wide enough for every intermediate exponent. */
const xeOf = (f: FpFormat) => (f.E + 3 <= 8 ? 8 : 16);

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
    b.next();
    const hidden = b.op1(NOT, [ez], 'hidden bit');
    const e0 = b.op(splitter([1, E - 1]), [`${sp}.o1`]);
    const b0 = b.op1(OR, [`${e0}.o0`, ez]);
    const nfz = b.op1(NOT, [fz]);
    b.next();
    b.wire(b.op1(merger([M, 1]), [`${sp}.o0`, hidden]), 'mant');
    b.wire(b.op1(merger([1, E - 1]), [b0, `${e0}.o1`]), 'exp');
    b.wire(b.op1(AND, [ez, fz]), 'zero');
    b.wire(b.op1(AND, [eo, fz]), 'inf');
    b.wire(b.op1(AND, [eo, nfz]), 'nan');
    b.wire(`${sp}.o2`, 'sign');
    return define({
      id: `fpun${E}_${M}`, name: 'Float unpack', category: 'arithmetic',
      summary: 'Splits sign | exponent | fraction. The hidden leading 1 is present unless the exponent field is 0 (zero or subnormal); subnormals behave as if their exponent were 1. Exponent all ones means infinity (fraction 0) or NaN.',
      ports: [bus('x', 1 + E + M, 'in'), bit('sign', 'out'), bus('exp', E, 'out'), bus('mant', M + 1, 'out'), bit('zero', 'out'), bit('inf', 'out'), bit('nan', 'out')],
      symbol: { kind: 'box', label: 'UNPACK' },
      netlist: () => ({
        pins: { x: [0, 4], sign: [b.right, 2], exp: [b.right, 6], mant: [b.right, 10], zero: [b.right, 14], inf: [b.right, 18], nan: [b.right, 22] },
        instances: b.instances, nets: b.nets(),
      }),
    });
  });
}

/**
 * Normalize and round: mant (w bits, its top bit has weight 2^exp) plus a sticky bit → the IEEE
 * encoding, round to nearest even. Leading zeros are shifted out (left) as far as the exponent
 * allows; below the smallest exponent the significand is shifted right instead (a subnormal).
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
    const eNorm = b.op1(incrementer(XE), [`${t}.s`]);
    const eAfter = b.name(b.op1(busMux2(XE), [b.op1(K(XE, 1), []), eNorm, canNorm]), 'e');
    b.next();
    // 2. shift
    const sh1 = b.op1(shiftLeft(w, k), ['mant', L], 'normalize');
    b.next();
    const sh2 = b.op(shiftRightSticky(w, k), [sh1, R], 'subnormal');
    b.next();
    // 3. round to nearest even: G = first dropped bit, S = OR of the rest
    const parts = b.op(splitter([w - M - 2, 1, M + 1]), [`${sh2}.y`]);
    const restAny = b.op1(NOT, [b.op1(isZero(w - M - 2), [`${parts}.o0`])]);
    const S = b.name(b.op1(orN(3), [restAny, `${sh2}.sticky`, 'stin']), 'S');
    const G = b.name(`${parts}.o1`, 'G');
    const lsb = b.op(splitter([1, M]), [`${parts}.o2`]);
    const inc = b.name(b.op1(AND, [G, b.op1(OR, [S, `${lsb}.o0`])], 'round up?'), 'roundUp');
    b.next();
    const mi = b.op(incrementer(M + 1), [`${parts}.o2`]);
    const mR = b.op1(busMux2(M + 1), [`${parts}.o2`, `${mi}.y`, inc]);
    const carry = b.name(b.op1(AND, [inc, `${mi}.cout`]), 'carry');
    b.next();
    const ms = b.op(splitter([M, 1]), [mR]);
    const hidden = b.name(b.op1(OR, [`${ms}.o1`, carry]), 'hidden');
    const eF = b.name(`${b.op(koggeStone(XE), [eAfter, b.op1(K(XE, 0), []), carry], 'exp + carry')}.s`, 'eFinal');
    b.next();
    const ov = b.op(addSubFast(XE), [eF, b.op1(K(XE, 2 ** E - 1), []), b.op1(TIE1, [])], 'overflow?');
    const inf = b.name(b.op1(AND, [hidden, b.op1(NOT, [`${ov}.n`])]), 'overflow');
    const ef = b.op(splitter([E, XE - E]), [eF]);
    b.next();
    const expF = b.op1(bitwise('and', E), [`${ef}.o0`, b.op1(fanout(E), [hidden])]);
    const expOut = b.op1(bitwise('or', E), [expF, b.op1(fanout(E), [inf])]);
    const fracOut = b.op1(bitwise('and', M), [`${ms}.o0`, b.op1(fanout(M), [b.op1(NOT, [inf])])]);
    b.next();
    b.wire(b.op1(merger([M, E, 1]), [fracOut, expOut, 'sign']), 'y');
    return define({
      id: `fpnr${E}_${M}_${w}`, name: 'Normalize & round', category: 'arithmetic',
      summary: 'Counts leading zeros, shifts them out (or shifts right for a subnormal result), then rounds to nearest even using the guard bit G and the sticky bit S: round up if G and (S or the last kept bit). A carry out of the rounding bumps the exponent; an exponent past the top becomes infinity.',
      ports: [bit('sign', 'in'), bus('exp', XE, 'in'), bus('mant', w, 'in'), bit('stin', 'in'), bus('y', 1 + E + M, 'out')],
      symbol: { kind: 'box', label: 'NORMALIZE & ROUND' },
      netlist: () => ({ pins: { sign: [0, 2], exp: [0, 6], mant: [0, 10], stin: [0, 14], y: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

const infValue = (b: Builder, f: FpFormat, sign: string) => b.op1(merger([f.M, f.E, 1]), [b.op1(K(f.M, 0), []), b.op1(K(f.E, 2 ** f.E - 1), []), sign]);
const nanValue = (b: Builder, f: FpFormat) => b.op1(K(1 + f.E + f.M, (2 ** f.E - 1) * 2 ** f.M + 2 ** (f.M - 1)), []);
const fmtName = (f: FpFormat) => (f.E === 8 && f.M === 23 ? 'float32' : f.E === 5 && f.M === 10 ? 'binary16' : `E${f.E}M${f.M}`);

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
    const sign = b.op1(AND, [sB, b.op1(NOT, [b.op1(AND, [effSub, zs])])], 'x − x = +0');
    const ex = b.op1(incrementer(XE), [b.op1(merger([E, XE - E]), [eB, b.op1(K(XE - E, 0), [])])]);
    b.next();
    const nr = b.op1(normRound(f, WS + 1), [sign, ex, sm, b.op1(TIE0, [])], 'normalize & round');
    b.next();
    const nan = b.op1(orN(3), [`${ua}.nan`, `${ub}.nan`, b.op1(andN(3), [`${ua}.inf`, `${ub}.inf`, effSub])], 'NaN?');
    const anyInf = b.op1(OR, [`${ua}.inf`, `${ub}.inf`]);
    const infS = b.op1(MUX2, [sbEff, `${ua}.sign`, `${ua}.inf`]);
    b.next();
    const y1 = b.op1(busMux2(N), [nr, infValue(b, f, infS), anyInf], 'infinity');
    b.wire(b.op1(busMux2(N), [y1, nanValue(b, f), nan], 'NaN'), 'y');
    return define({
      id: `fpadd${E}_${M}`, name: `${fmtName(f)} adder / subtractor`, category: 'arithmetic',
      summary: 'Compare magnitudes and swap; shift the smaller significand right by the exponent difference (guard, round and sticky bits keep track of what falls off); add or subtract; normalize and round to nearest even. Then the special cases: NaN in or ∞ − ∞ gives NaN, an infinite operand gives infinity.',
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bit('sub', 'in'), bus('y', N, 'out')],
      symbol: { kind: 'box', label: 'FADD' },
      spec: ([a, bb, s]) => [fpAddRef(a, bb, !!s, f)],
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], sub: [0, 16], y: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
      hdl: { verilog: `// behaviourally: assign y = sub ? a - b : a + b;   (IEEE 754 binary, round to nearest even)` },
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
    const nr = b.op1(normRound(f, W), [sign, `${s2}.s`, p, b.op1(TIE0, [])], 'normalize & round');
    b.next();
    const nan = b.op1(orN(4), [`${ua}.nan`, `${ub}.nan`, b.op1(AND, [`${ua}.inf`, `${ub}.zero`]), b.op1(AND, [`${ua}.zero`, `${ub}.inf`])], 'NaN?');
    const anyInf = b.op1(OR, [`${ua}.inf`, `${ub}.inf`]);
    b.next();
    const y1 = b.op1(busMux2(N), [nr, infValue(b, f, sign), anyInf], 'infinity');
    b.wire(b.op1(busMux2(N), [y1, nanValue(b, f), nan], 'NaN'), 'y');
    return define({
      id: `fpmul${E}_${M}`, name: `${fmtName(f)} multiplier`, category: 'arithmetic',
      summary: `Sign = XOR, exponent = ea + eb − bias, significand = a ${M + 1}×${M + 1} tree multiplier (chapter 20), then the shared normalize & round unit. ∞ × 0 is NaN.`,
      ports: [bus('a', N, 'in'), bus('b', N, 'in'), bus('y', N, 'out')],
      symbol: { kind: 'box', label: 'FMUL' },
      spec: ([a, bb]) => [fpMulRef(a, bb, f)],
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], y: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
      hdl: { verilog: '// behaviourally: assign y = a * b;   (IEEE 754 binary, round to nearest even)' },
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
    b.wire(b.op1(normRound(f, w), [neg, b.op1(K(XE, w - 1 + fbias(f)), []), mag, b.op1(TIE0, [])], 'normalize & round'), 'y');
    return define({
      id: `fpcvt${E}_${M}_${w}`, name: `int${w} → ${fmtName(f)}`, category: 'arithmetic',
      summary: `The magnitude of the integer is a significand whose top bit has weight 2^${w - 1}. Normalize & round shifts out the leading zeros; integers above 2^${M + 1} lose low bits and are rounded to nearest even.`,
      ports: [bus('x', w, 'in'), bit('signed', 'in'), bus('y', N, 'out')],
      symbol: { kind: 'box', label: 'INT→FLOAT' },
      spec: ([x, s]) => [fpFromIntRef(x, !!s, f, w)],
      netlist: () => ({ pins: { x: [0, 4], signed: [0, 10], y: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
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
    return define({
      id: `fpcmp${E}_${M}`, name: `${fmtName(f)} comparator`, category: 'arithmetic',
      summary: 'Sign-magnitude makes comparison nearly integer comparison: for two positive numbers the bit patterns order like integers; for two negatives the order flips. −0 equals +0, and any NaN makes every comparison false.',
      ports: [bus('a', 1 + E + M, 'in'), bus('b', 1 + E + M, 'in'), bit('eq', 'out'), bit('lt', 'out'), bit('le', 'out')],
      symbol: { kind: 'box', label: 'FCMP' },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], eq: [b.right, 2], lt: [b.right, 6], le: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The CPU's FPU: the subset of RV32F this processor implements, selected by funct7 (funct5):
 * fadd.s, fsub.s, fmul.s, fsgnj[n|x].s, feq/flt/fle.s, fmv.x.w, fcvt.s.w[u], fmv.w.x.
 * a, b are the f-register operands, xa the integer rs1 (for conversions and fmv.w.x).
 */
export const FPU32: ComponentDef = (() => {
  const f = F32;
  const b = new Builder();
  const f7 = b.op(splitter([2, 1, 1, 1, 1, 1]), ['funct7']);
  const f3 = b.op(splitter([2, 1]), ['funct3']);
  const r2 = b.op(splitter([1, 4]), ['rs2']);
  const as = b.op(splitter([31, 1]), ['a']), bs = b.op(splitter([31, 1]), ['b']);
  b.next();
  const add = b.op1(fpAdd(f), ['a', 'b', `${f7}.o1`], 'adder');
  const mul = b.op1(fpMul(f), ['a', 'b'], 'multiplier');
  const cmp = b.op(fpCompare(f), ['a', 'b'], 'comparator');
  const cvt = b.op1(fpFromInt(f), ['xa', b.op1(NOT, [`${r2}.o0`])], 'int → float');
  b.next();
  const sj = b.op1(muxTree(2, 1), [`${bs}.o1`, b.op1(NOT, [`${bs}.o1`]), b.op1(XOR, [`${as}.o1`, `${bs}.o1`]), `${bs}.o1`, `${f3}.o0`], 'sign injection');
  const sgnj = b.op1(merger([31, 1]), [`${as}.o0`, sj]);
  const cbit = b.op1(muxTree(2, 1), [`${cmp}.le`, `${cmp}.lt`, `${cmp}.eq`, b.op1(TIE0, []), `${f3}.o0`]);
  const c32 = b.op1(constWord(31, 0), []);
  const cmp32 = b.op1(merger([1, 31]), [cbit, c32]);
  const sel = b.name(b.op1(merger([1, 1, 1, 1]), [`${f7}.o2`, `${f7}.o3`, `${f7}.o4`, `${f7}.o5`]), 'op');
  b.next();
  const z = b.op1(K(32, 0), []);
  const ins = Array.from({ length: 16 }, () => z);
  ins[0] = add; ins[1] = mul; ins[2] = sgnj; ins[10] = cmp32; ins[13] = cvt; ins[14] = 'a'; ins[15] = 'xa';
  b.wire(b.op1(muxTree(4, 32), [...ins, sel], 'result'), 'y');
  void TIE1;
  return define({
    id: 'fpu32', name: 'Floating-point unit (RV32F subset)', category: 'cpu',
    summary: 'fadd.s, fsub.s, fmul.s, sign injection, compares, moves and int→float conversion, all in one cycle, round to nearest even. funct7 picks the result.',
    ports: [bus('a', 32, 'in'), bus('b', 32, 'in'), bus('xa', 32, 'in'), bus('funct7', 7, 'in'), bus('funct3', 3, 'in'), bus('rs2', 5, 'in'), bus('y', 32, 'out')],
    symbol: { kind: 'box', label: 'FPU' },
    netlist: () => ({ pins: { a: [0, 4], b: [0, 8], xa: [0, 12], funct7: [0, 16], funct3: [0, 20], rs2: [0, 24], y: [b.right, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();
