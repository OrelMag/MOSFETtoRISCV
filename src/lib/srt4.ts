// Radix-4 SRT division: quotient digits from {−2, …, +2}, two quotient bits per clock. The digit is
// chosen by comparing a carry-save estimate of the shifted remainder with four thresholds that depend
// on the top bits of the divisor. The thresholds are computed here from the containment conditions,
// not copied from a table, and the tests check the whole divider against Math.floor.

import type { ComponentDef, PortDef } from '../sim/types';
import { mask } from '../sim/values';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { andN, busMux2, muxTree, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { iterCtrl, srtNorm } from './divide';
import { fanout, koggeStone } from './fastadd';
import { shiftRightSticky } from './fpu';
import { AND, NOT, OR } from './gates';
import { csa } from './muldiv';
import { register } from './sequential';
import { NAND, TIE0, TIE1 } from './transistors';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const log2 = (n: number) => Math.round(Math.log2(n));

/** Fractional bits of the remainder estimate (its resolution is 1/16 of the divisor's unit). */
export const SRT4_EST_FRAC = 4;
/** Bits of the remainder estimate (two's complement), and of the divisor below its leading one. */
const EW = 8, DB = 3;

/**
 * Selection thresholds, in units of 1/16, for the 8 divisor intervals d ∈ [(8 + i)/16, (9 + i)/16):
 * [m2, m1, m0, m−1], where digit k is chosen when m_k ≤ estimate < m_(k+1). With redundancy
 * ρ = 2/3, digit k is correct for any shifted remainder y in [(k − 2/3)d, (k + 2/3)d]. The carry-save
 * estimate is low by less than 2/16, so m_k must satisfy, for every d in the interval,
 *   m_k ≥ (k − 2/3)·d            (the smallest estimate that picks k still allows k), and
 *   m_k + 1 ≤ (k − 1/3)·d        (the largest estimate that picks k − 1 still allows k − 1).
 * Each m_k is the smallest value meeting both; the function throws if an interval had none.
 */
export function srt4Thresholds(): number[][] {
  const R = 2 ** SRT4_EST_FRAC;
  return Array.from({ length: 8 }, (_, i) => {
    const lo = ((8 + i) * R) / 16, hi = ((9 + i) * R) / 16;
    return [2, 1, 0, -1].map((k) => {
      const c1 = 3 * k - 2, c2 = 3 * k - 1;
      const lower = Math.ceil((c1 * (c1 > 0 ? hi : lo)) / 3);
      const upper = Math.floor((c2 * (c2 > 0 ? lo : hi)) / 3) - 1;
      if (lower > upper) throw new Error(`radix-4 SRT: no threshold for digit ${k}, divisor interval ${i}`);
      return lower;
    });
  });
}

/** Reference selection: estimate e (8-bit two's complement), divisor interval i → digit −2..2. */
export function srt4Digit(e: number, i: number): number {
  const v = e >= 128 ? e - 256 : e;
  const [m2, m1, m0, mm1] = srt4Thresholds()[i];
  return v >= m2 ? 2 : v >= m1 ? 1 : v >= m0 ? 0 : v >= mm1 ? -1 : -2;
}

/**
 * The selection exactly as the hardware computes it: for each threshold, the sign of the 8-bit sum
 * s + c + NOT m + 1 (which wraps for estimates far outside the reachable range). Flags [p2, p1, n1, n2].
 */
export function srt4SelectHw(s: number, c: number, i: number): number[] {
  const lt = srt4Thresholds()[i].map((m) => (((s + c + (~m & 255) + 1) & 255) >= 128 ? 1 : 0));
  return [1 - lt[0], lt[0] & (1 - lt[1]), lt[2] & (1 - lt[3]), lt[3]];
}

/**
 * Radix-4 digit selection: add the top 8 bits of the remainder's sum and carry words (a fast 8-bit
 * adder), and compare the estimate with the four thresholds for this divisor interval, all at once.
 */
export const SRT4_SELECT: ComponentDef = (() => {
  const T = srt4Thresholds();
  const b = new Builder(14, 14);
  b.pins('s', 'c', 'd');
  const ks = [2, 1, 0, -1];
  // estimate < m  ⟺  s + c − m < 0  ⟺  the sign of s + c + NOT m + 1. A 3:2 row folds NOT m in, so each
  // comparison is one carry-save row and one 8-bit sign, instead of an adder followed by a comparator.
  const lt = ks.map((k, j) => {
    const nm = b.op(muxTree(DB, EW), [], `NOT m${k < 0 ? '−1' : k}`);
    T.forEach((row, i) => b.wire(b.op1(constWord(EW, ~row[j] & 255), []), `${nm}.d${i}`));
    b.wire('d', `${nm}.s`);
    return `${nm}.y`;
  }).map((nm, j) => {
    const r = b.op(csa(EW), ['s', 'c', nm]);
    const cs = b.op(splitter([EW - 1, 1]), [`${r}.c`]);
    const c2 = b.op1(merger([1, EW - 1]), [b.op1(TIE0, []), `${cs}.o0`]);
    const sum = b.op(koggeStone(EW), [`${r}.s`, c2, b.op1(TIE1, [])], `s + c − m${ks[j] < 0 ? '−1' : ks[j]}`);
    const sg = b.op(splitter([EW - 1, 1]), [`${sum}.s`]);
    return b.name(`${sg}.o1`, `below${j}`, true);
  });
  b.next();
  const p2 = b.op1(NOT, [lt[0]]);
  const p1 = b.op1(AND, [lt[0], b.op1(NOT, [lt[1]])], '+1');
  const n1 = b.op1(AND, [lt[2], b.op1(NOT, [lt[3]])], '−1');
  b.next();
  b.wire(p2, 'p2'); b.wire(p1, 'p1'); b.wire(n1, 'n1'); b.wire(lt[3], 'n2');
  const R = b.right;
  return define({
    id: 'srt4sel', name: 'Radix-4 SRT digit selection', category: 'arithmetic',
    summary: 'Compares the top 8 bits of the shifted remainder, still in carry-save form, with four thresholds chosen by the three divisor bits after its leading one: for each, one 3:2 row computes s + c − m and a fast 8-bit adder gives its sign. The four signs pick the digit: +2, +1, 0, −1 or −2. The thresholds are computed from the containment bounds of the redundant digit set (ρ = 2/3).',
    ports: [bus('s', EW, 'in'), bus('c', EW, 'in'), bus('d', DB, 'in'), bit('p2', 'out'), bit('p1', 'out'), bit('n1', 'out'), bit('n2', 'out')],
    symbol: { kind: 'box', label: 'SELECT ×4' },
    spec: ([s, c, d]) => srt4SelectHw(s, c, d),
    netlist: () => ({ pins: { s: [0, 4], c: [0, 8], d: [0, 12], p2: [R, 4], p1: [R, 8], n1: [R, 12], n2: [R, 16] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** One bit of −q·d: (p1·¬d_i) + (p2·¬d_(i−1)) + (n1·d_i) + (n2·d_(i−1)), two NAND levels and a wide NAND. */
const SRT4_TERM: ComponentDef = define({
  id: 'srt4term', name: 'Radix-4 SRT term bit', category: 'arithmetic',
  summary: 'The bit of −q·d for q ∈ {−2…2}: NOT d (q = +1) or NOT 2d (q = +2, d shifted one place), d or 2d for negative digits. The +1 that completes a negation goes into the carry word.',
  ports: [bit('p1', 'in'), bit('nd', 'in'), bit('p2', 'in'), bit('ndm', 'in'), bit('n1', 'in'), bit('dd', 'in'), bit('n2', 'in'), bit('dm', 'in'), bit('t', 'out')],
  symbol: { kind: 'box', label: '−q·d' },
  spec: ([p1, nd, p2, ndm, n1, dd, n2, dm]) => [(p1 & nd) | (p2 & ndm) | (n1 & dd) | (n2 & dm)],
  netlist: () => {
    const b = new Builder(16, 10, 6);
    b.pins('p1', 'nd', 'p2', 'ndm', 'n1', 'dd', 'n2', 'dm');
    const g = [['p1', 'nd'], ['p2', 'ndm'], ['n1', 'dd'], ['n2', 'dm']].map(([x, y]) => b.op1(NAND, [x, y]));
    b.next();
    const all = b.op1(andN(4), g);
    b.next();
    b.wire(b.op1(NOT, [all]), 't');
    return { pins: { p1: [0, 2], nd: [0, 6], p2: [0, 12], ndm: [0, 16], n1: [0, 22], dd: [0, 26], n2: [0, 32], dm: [0, 36], t: [b.right, 18] }, instances: b.instances, nets: b.nets() };
  },
  hdl: { verilog: 'assign t = (p1 & ~d[i]) | (p2 & ~d[i-1]) | (n1 & d[i]) | (n2 & d[i-1]);' },
});

/** −q·d as a W-bit word (d zero-extended; d_(−1) = 0). */
export function srt4Term(n: number, W: number): ComponentDef {
  return memo(`srt4terms${n}_${W}`, () => {
    const b = new Builder(8, 10, 6);
    b.pins('d', 'p1', 'p2', 'n1', 'n2');
    const sd = b.op(splitter(ones(n)), ['d']);
    const nd = b.op(splitter(ones(n)), [b.name(b.op1(bitwise('xor', n), ['d', b.op1(fanout(n), [b.op1(TIE1, [])])], 'NOT d'), '¬d')]);
    const one = b.op1(TIE1, []), zero = b.op1(TIE0, []);
    b.next();
    const di = (i: number) => (i >= 0 && i < n ? `${sd}.o${i}` : zero), ndi = (i: number) => (i >= 0 && i < n ? `${nd}.o${i}` : one);
    const ts: string[] = [];
    for (let i = 0; i <= n; i++) ts.push(b.op1(SRT4_TERM, ['p1', ndi(i), 'p2', ndi(i - 1), 'n1', di(i), 'n2', di(i - 1)], `bit ${i}`));
    // above bit n both d and 2d are 0: the term is 1 exactly for a positive digit (its inverted zeros)
    ts.push(b.op1(fanout(W - n - 1), [b.op1(OR, ['p1', 'p2'])], `bits ${n + 1}..${W - 1}`));
    b.next();
    b.wire(b.op1(merger([...ones(n + 1), W - n - 1]), ts), 't');
    const R = b.right;
    const M = (1n << BigInt(W)) - 1n;
    return define({
      id: `srt4terms${n}_${W}`, name: `Radix-4 SRT term (${W} bits)`, category: 'arithmetic',
      summary: 'The word −q·d for q ∈ {−2…2}, one 4-way AND-OR cell per bit: d and 2d are wires, inverting them is the NOT d already computed from the divisor register.',
      ports: [bus('d', n, 'in'), bit('p1', 'in'), bit('p2', 'in'), bit('n1', 'in'), bit('n2', 'in'), bus('t', W, 'out')],
      symbol: { kind: 'box', label: '−q·d' },
      spec: W <= 52 ? ([d, p1, p2, n1, n2]) => {
        const D = BigInt(d);
        let t = 0n;
        if (p1) t |= ~D & M;
        if (p2) t |= ~(D << 1n) & M;
        if (n1) t |= D;
        if (n2) t |= (D << 1n) & M;
        return [Number(t)];
      } : undefined,
      netlist: () => ({ pins: { d: [0, 4], p1: [0, 8], p2: [0, 12], n1: [0, 16], n2: [0, 20], t: [R, 8] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * One radix-4 SRT step: shift both remainder words two places (the next two dividend bits enter the
 * sum word), pick q ∈ {−2…2}, add −q·d with one carry-save row. Two quotient bits per step, and still
 * no carry chain across the word.
 */
export function srt4Step(n: number): ComponentDef {
  const W = n + 4;
  return memo(`srt4step${n}`, () => {
    const b = new Builder(10, 12);
    b.pins('s', 'c', 'x', 'd');
    const ss = b.op(splitter([W - 2, 2]), ['s']);
    const cs = b.op(splitter([W - 2, 2]), ['c']);
    const sd = b.op(splitter([n - 1 - DB, DB, 1]), ['d']);
    b.next();
    const s4 = b.name(b.op1(merger([2, W - 2]), ['x', `${ss}.o0`], '4s + x'), '4s+x', true);
    const c4 = b.name(b.op1(merger([2, W - 2]), [b.op1(constWord(2, 0), []), `${cs}.o0`], '4c'), '4c', true);
    b.next();
    const st = b.op(splitter([W - EW, EW]), [s4]);
    const ct = b.op(splitter([W - EW, EW]), [c4]);
    b.next();
    const sel = b.op(SRT4_SELECT, [`${st}.o1`, `${ct}.o1`, `${sd}.o1`], 'digit');
    const [p2, p1, n1, n2] = ['p2', 'p1', 'n1', 'n2'].map((p) => b.name(`${sel}.${p}`, p, true));
    b.next();
    const t = b.name(b.op1(srt4Term(n, W), ['d', p1, p2, n1, n2], '−q·d'), '−q·d');
    const pos = b.name(b.op1(OR, [p1, p2], 'q > 0'), 'q>0', true);
    b.next();
    const add = b.op(csa(W), [s4, c4, t], 'add −q·d');
    b.next();
    const csp = b.op(splitter([W - 1, 1]), [`${add}.c`]);
    b.next();
    b.wire(`${add}.s`, 'so');
    b.wire(b.op1(merger([1, W - 1]), [pos, `${csp}.o0`], 'carry'), 'co');
    for (const [nm, drv] of [['p2', p2], ['p1', p1], ['n1', n1], ['n2', n2]] as const) b.wire(drv, nm);
    const R = b.right;
    const MW = 1n << BigInt(W);
    return define({
      id: `srt4step${n}`, name: `${n}-bit radix-4 SRT step`, category: 'arithmetic',
      summary: `Two quotient bits per step: shift the carry-save remainder two places, pick q ∈ {−2…2} from 8 estimate bits and 3 divisor bits, add −q·d (d and 2d are wires) with ${W} independent full adders.`,
      ports: [bus('s', W, 'in'), bus('c', W, 'in'), bus('x', 2, 'in'), bus('d', n, 'in'), bus('so', W, 'out'), bus('co', W, 'out'),
        bit('p2', 'out'), bit('p1', 'out'), bit('n1', 'out'), bit('n2', 'out')],
      symbol: { kind: 'box', label: 'SRT4 STEP' },
      spec: 2 * W + n + 2 <= 64 ? ([s, c, x, d]) => {
        const S = (BigInt(s) % (MW / 4n)) * 4n + BigInt(x), C = (BigInt(c) % (MW / 4n)) * 4n;
        const top = (v: bigint) => Number(v >> BigInt(W - EW));
        const [p2, p1, n1, n2] = srt4SelectHw(top(S), top(C), (d >> (n - 1 - DB)) & 7);
        const D = BigInt(d), M = MW - 1n;
        let T = 0n;
        if (p1) T |= ~D & M;
        if (p2) T |= ~(D << 1n) & M;
        if (n1) T |= D;
        if (n2) T |= (D << 1n) & M;
        const so = S ^ C ^ T, co = ((((S & C) | (S & T) | (C & T)) << 1n) | (p1 | p2 ? 1n : 0n)) % MW;
        return [Number(so), Number(co), p2, p1, n1, n2];
      } : undefined,
      netlist: () => ({ pins: { s: [0, 4], c: [0, 8], x: [0, 12], d: [0, 16], so: [R, 4], co: [R, 8], p2: [R, 12], p1: [R, 16], n1: [R, 20], n2: [R, 24] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Resolve the remainder, fix a negative one, form q = (positive digits) − (negative digits) − fix, denormalize. */
export function srt4Finish(n: number): ComponentDef {
  const k = log2(n), W = n + 4, Q = n + 2;
  return memo(`srt4fin${n}`, () => {
    const b = new Builder(16, 10);
    b.pins('s', 'c', 'qp', 'qn', 'd', 'sh');
    const ADD = (w: number) => (w >= 16 ? koggeStone(w) : rca(w));
    const w = b.op(ADD(W), ['s', 'c', b.op1(TIE0, [])], 'resolve s + c');
    b.next();
    const ws = b.op(splitter([n, 3, 1]), [`${w}.s`]);
    const neg = b.name(`${ws}.o2`, 'negative', true);
    b.next();
    const pos = b.op1(NOT, [neg]);
    const dsel = b.op1(bitwise('and', n), ['d', b.op1(fanout(n), [neg])], 'd if < 0');
    const nqn = b.op1(bitwise('xor', Q), ['qn', b.op1(fanout(Q), [b.op1(TIE1, [])])], 'NOT qn');
    b.next();
    const rem = b.op(ADD(n), [`${ws}.o0`, dsel, b.op1(TIE0, [])], 'correct remainder');
    const q = b.op(ADD(Q), ['qp', nqn, pos], 'qp − qn');
    b.next();
    const qs = b.op(splitter([n, 2]), [`${q}.s`]);
    const r = b.op(shiftRightSticky(n, k), [`${rem}.s`, 'sh'], 'denormalize');
    b.next();
    b.wire(`${qs}.o0`, 'q');
    b.wire(`${r}.y`, 'r');
    const R = b.right;
    return define({
      id: `srt4fin${n}`, name: `${n}-bit radix-4 SRT finish`, category: 'arithmetic',
      summary: 'After the last step: the one carry-propagate addition of the remainder words, d added back if the remainder is negative, q = (positive digits) − (negative digits) with the same correction, and the remainder shifted back.',
      ports: [bus('s', W, 'in'), bus('c', W, 'in'), bus('qp', Q, 'in'), bus('qn', Q, 'in'), bus('d', n, 'in'), bus('sh', k, 'in'), bus('q', n, 'out'), bus('r', n, 'out')],
      symbol: { kind: 'box', label: 'FINISH' },
      netlist: () => ({ pins: { s: [0, 4], c: [0, 8], qp: [0, 12], qn: [0, 16], d: [0, 20], sh: [0, 24], q: [R, 8], r: [R, 16] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * Iterative radix-4 SRT divider (n even): normalize, n/2 + 1 steps of two quotient bits each (the
 * first remainder is the dividend's top bits shifted down two places, so it starts inside the
 * convergence range), finish. n/2 + 3 cycles; same ports as seqDivider.
 */
export function srt4Divider(n: number): ComponentDef {
  const k = log2(n), W = n + 4, Q = n + 2, m = n / 2 + 1;
  return memo(`srt4div${n}`, () => {
    const b = new Builder(10, 12);
    b.pins('clk', 'start', 'a', 'b');
    const ctl = b.op(iterCtrl(m), ['clk', 'start'], 'control');
    const nm = b.op(srtNorm(n), ['a', 'b']);
    const load = b.name(`${ctl}.load`, 'load', true), step = b.name(`${ctl}.step`, 'step', true);
    b.next();
    const hs = b.op(splitter([2, n - 2]), [`${nm}.hi`]);
    const w0 = b.op1(merger([n - 2, 6]), [`${hs}.o1`, b.op1(constWord(6, 0), [])], 'hi / 4');
    const x0 = b.op1(merger([n, 2]), [`${nm}.lo`, `${hs}.o0`], 'dividend bits');
    const mS = b.op(busMux2(W), ['', w0, load], 'load / step');
    const mC = b.op(busMux2(W), ['', b.op1(constWord(W, 0), []), load]);
    const mX = b.op(busMux2(Q), ['', x0, load]);
    const mN = b.op(busMux2(Q), ['', b.op1(constWord(Q, 0), []), load]);
    b.next();
    const S = b.name(b.op1(register(W), [`${mS}.y`, step, 'clk'], 'remainder: sum'), 'S', true);
    const C = b.name(b.op1(register(W), [`${mC}.y`, step, 'clk'], 'remainder: carry'), 'C', true);
    const X = b.name(b.op1(register(Q), [`${mX}.y`, step, 'clk'], 'dividend → +digits'), 'X', true);
    const QN = b.name(b.op1(register(Q), [`${mN}.y`, step, 'clk'], '−digits'), 'QN', true);
    const D = b.name(b.op1(register(n), [`${nm}.d`, load, 'clk'], 'divisor'), 'D', true);
    const SH = b.op1(register(k), [`${nm}.s`, load, 'clk'], 'shift');
    const Z = b.op1(register(1), [b.op1(isZero(n), ['b'], 'b = 0'), load, 'clk'], 'divide by 0');
    b.next();
    const xs = b.op(splitter([n, 2]), [X]);
    const qs = b.op(splitter([n, 2]), [QN]);
    b.next();
    const st = b.op(srt4Step(n), [S, C, `${xs}.o1`, D], 'two bits');
    b.next();
    const xn = b.name(b.op1(merger([1, 1, n]), [`${st}.p1`, `${st}.p2`, `${xs}.o0`], 'shift in +digit'), 'xNext', true);
    const nn = b.name(b.op1(merger([1, 1, n]), [`${st}.n1`, `${st}.n2`, `${qs}.o0`], 'shift in −digit'), 'nNext', true);
    b.name(`${st}.so`, 'sNext', true);
    b.name(`${st}.co`, 'cNext', true);
    b.wire(`${st}.so`, `${mS}.a`); b.wire(`${st}.co`, `${mC}.a`); b.wire(xn, `${mX}.a`); b.wire(nn, `${mN}.a`);
    b.next();
    const fin = b.op(srt4Finish(n), [S, C, X, QN, D, SH]);
    b.next();
    b.wire(b.op1(bitwise('or', n), [`${fin}.q`, b.op1(fanout(n), [Z])], 'q (all ones if b = 0)'), 'q');
    b.wire(`${fin}.r`, 'r');
    b.wire(`${ctl}.done`, 'done');
    b.wire(`${ctl}.busy`, 'busy');
    const R = b.right;
    return define({
      id: `srt4div${n}`, name: `${n}-bit iterative radix-4 SRT divider`, category: 'sequential',
      summary: `Two quotient bits per clock: ${m} radix-4 steps (digits −2…+2) after normalizing, ${m + 2} cycles in all against ${n + 2} for radix 2. Each step is longer (a wider estimate and four comparisons) but still has no carry chain.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', n, 'in'), bus('b', n, 'in'), bus('q', n, 'out'), bus('r', n, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: `SRT4 DIV${n}` },
      netlist: () => ({ pins: { clk: [0, 30], start: [0, 6], a: [0, 14], b: [0, 18], q: [R, 6], r: [R, 10], done: [R, 14], busy: [R, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Reference: what an n-bit divider must return (RISC-V: b = 0 gives all ones and a). */
export const divRef4 = (a: number, b: number, n: number) => (b === 0 ? [mask(n), a] : [Math.floor(a / b), a % b]);
