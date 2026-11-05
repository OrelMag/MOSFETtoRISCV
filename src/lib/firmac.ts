// The FIR filter with one multiplier, in gates (chapter "FIR design"). A ring of sample registers turns one place a cycle, a ROM gives the tap for the
// head, one signed multiplier and one guarded accumulator add them up, and N cycles later the sum is rounded once and clamped once into the output.
// dsp/firdesign.ts MacModel is the specification, cycle for cycle (tests/dsp-firdesign.test.ts); the constant multiplier is dsp/firdesign.ts csdOf.

import { csdOf, macAccWidth, type MacConfig } from '../dsp/firdesign';
import { satTo, wrapTo } from '../dsp/fixed';
import { stats } from '../sim/stats';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2, incrementer, rca } from './combinational';
import { define, splitter } from './define';
import { cut, placed, roundUp } from './fft';
import { limitWord } from './fixedpt';
import { AND, NOT } from './gates';
import { lookupRom } from './modem';
import { treeMul } from './muldiv';
import { nonZero } from './pipeline';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { notBus } from './viterbi';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const uns = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;
const clockPort = (): PortDef => bit('clk', 'in', 'bottom');

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
function hash(words: readonly number[]): string {
  let h = 2166136261;
  for (const w of words) { h ^= w >>> 0; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}
const bitsFor = (n: number): number => Math.max(1, Math.ceil(Math.log2(n)));

// ---- a clamp for more than one guard bit ---------------------------------------------------------------------------------------------

/**
 * n bits down to w. The top n − w + 1 bits are all the same exactly when the value fits, so "does not fit" is: some bit is 1 and some bit is 0 (two
 * OR trees, the second behind inverters). Then the output is the largest word of the true sign. clampWord(w) is this at n = w + 1.
 */
export function clampWide(n: number, w: number): ComponentDef {
  if (n - w < 1) throw new Error('clampWide: needs at least one bit above the word');
  return memo(`fxclampw${n}_${w}`, () => {
    const m = n - w + 1, b = new Builder(6, 10, 4);
    b.pins('x');
    const top = b.op1(cut(n, w - 1, m), ['x'], 'bits that must agree', 'top');
    b.next();
    const inv = b.op1(notBus(m), [top], undefined, 'inv');
    const anyOne = b.op1(nonZero(m), [top], 'some bit is 1', 'ones');
    const low = b.op1(cut(n, 0, w), ['x'], 'the word', 'low');
    b.next();
    const anyZero = b.op1(nonZero(m), [inv], 'some bit is 0', 'zeros');
    const sign = b.op1(cut(n, n - 1, 1), ['x'], 'true sign', 'sign');
    const nsign = b.op1(NOT, [sign], undefined, 'nsign');
    b.next();
    const lim = b.op1(limitWord(w), [sign, nsign], undefined, 'lim');
    const over = b.op1(AND, [anyOne, anyZero], 'do not fit?', 'over');
    b.next();
    const mux = b.op1(busMux2(w), [low, lim, over], 'keep or clamp', 'pick');
    b.next();
    b.wire(mux, 'y');
    b.wire(over, 'sat');
    const R = b.right;
    return define({
      id: `fxclampw${n}_${w}`, name: `${n}-bit to ${w}-bit clamp`, category: 'arithmetic',
      summary: `Takes ${n} bits to ${w}. If the top ${m} bits are not all alike the value does not fit, and the output is the largest word of its sign.`,
      ports: [bus('x', n, 'in'), bus('y', w, 'out'), bit('sat', 'out')],
      symbol: { kind: 'box', label: 'CLAMP', w: 8 },
      spec: ([x]) => { const v = wrapTo(x, n), y = satTo(v, w); return [uns(y, w), y === v ? 0 : 1]; },
      netlist: () => ({ pins: { x: [0, 8], y: [R, 6], sat: [R, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the parts of the MAC ---------------------------------------------------------------------------------------------------------------

/** Counts 0 … N − 1: it comes back to 0 after the cycle in which `clr` (the last tap) is high. */
export function firCounter(kb: number): ComponentDef {
  return memo(`firctr${kb}`, () => {
    const b = new Builder(10, 10, 4);
    b.pins('clr', 'clk');
    const one = b.op1(TIE1, [], 'always counting', 'one');
    const zero = b.op1(constWord(kb, 0), [], undefined, 'zero');
    b.next();
    const k = b.op(register(kb), ['', one, 'clk'], 'tap number', 'kreg');
    b.next();
    const inc = b.op1(incrementer(kb), [`${k}.q`], 'k + 1', 'inc');
    b.next();
    const mux = b.op1(busMux2(kb), [inc, zero, 'clr'], 'back to 0 after the last', 'wrap');
    b.wire(mux, `${k}.d`);
    b.wire(`${k}.q`, 'k');
    const R = b.right;
    return define({
      id: `firctr${kb}`, name: `${kb}-bit tap counter`, category: 'sequential',
      summary: 'Counts the taps of a time-shared filter: k + 1 each clock, back to 0 after the last one.',
      ports: [bit('clr', 'in'), clockPort(), bus('k', kb, 'out')],
      symbol: { kind: 'box', label: 'TAP k', w: 8 },
      netlist: () => ({ pins: { clr: [0, 8], clk: [0, 22], k: [R, 8] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The tap for each k, and two flags: `first` (k = 0) and `last` (k = N − 1), read off the same word. */
export function firRom(taps: readonly number[], w: number): ComponentDef {
  const N = taps.length, kb = bitsFor(N), id = `firrom${w}_${N}_${hash(taps)}`;
  return memo(id, () => {
    const data = Array.from({ length: 2 ** kb }, (_, i) => (i < N ? uns(taps[i], w) + (i === N - 1 ? 2 ** w : 0) + (i === 0 ? 2 ** (w + 1) : 0) : 0));
    const rom = lookupRom(`${id}_lut`, 'ROM: taps and flags', kb, w + 2, data, `${N} words: the tap, then a bit that is 1 at the last tap, then one that is 1 at the first.`);
    const b = new Builder(10, 10, 4);
    b.pins('addr');
    const r = b.op(rom, ['addr'], 'tap k', 'rom');
    b.next();
    const sp = b.op(splitter([w, 1, 1], 4), [`${r}.data`], undefined, 'sp');
    b.next();
    b.wire(`${sp}.o0`, 'c'); b.wire(`${sp}.o1`, 'last'); b.wire(`${sp}.o2`, 'first');
    const R = b.right;
    return define({
      id, name: `Tap ROM, ${N} taps`, category: 'memory',
      summary: `The ${N} tap words of a filter and, with each, whether it is the first or the last: the counter's wrap and the accumulator's restart come from here.`,
      ports: [bus('addr', kb, 'in'), bus('c', w, 'out'), bit('last', 'out'), bit('first', 'out')],
      symbol: { kind: 'box', label: 'TAPS', w: 8 },
      spec: ([a]) => { const d = data[a] ?? 0; return [d % 2 ** w, Math.floor(d / 2 ** w) % 2, Math.floor(d / 2 ** (w + 1))]; },
      netlist: () => ({ pins: { addr: [0, 6], c: [R, 6], last: [R, 12], first: [R, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * N sample registers in a ring. While the last tap has not come, every register takes its neighbour's word (the head sees x[n], x[n−1], …); in the
 * last cycle only the head loads, the new sample, and the others hold: the oldest has just been used and falls out of the ring.
 */
export function firRing(N: number, w: number): ComponentDef {
  return memo(`firring${N}_${w}`, () => {
    const b = new Builder(10, 8, 3);
    b.pins('x', 'last', 'clk');
    const one = b.op1(TIE1, [], 'head always loads', 'one');
    const nlast = b.op1(NOT, ['last'], 'hold in the last cycle', 'nlast');
    b.name(nlast, 'hold', true);
    // data flows left to right: the oldest sample sits leftmost, the head rightmost, and the head's word goes round again along the label `wrap`
    for (let j = N - 1; j >= 1; j--) {
      b.next();
      b.op(register(w), ['', nlast, 'clk'], j === N - 1 ? 'oldest' : undefined, `r${j}`);
    }
    b.next();
    const mux = b.op1(busMux2(w), ['r1.q', 'x', 'last'], 'new sample in the last cycle', 'in');
    b.next();
    b.op(register(w), [mux, one, 'clk'], 'head: x[n−k]', 'r0');
    for (let j = 1; j < N; j++) b.wire(j === N - 1 ? 'r0.q' : `r${j + 1}.q`, `r${j}.d`);
    b.name('r0.q', 'wrap', true);
    b.wire('r0.q', 'head');
    const R = b.right;
    return define({
      id: `firring${N}_${w}`, name: `${N}-word sample ring`, category: 'memory',
      summary: `${N} registers of ${w} bits that turn one place a clock: the head shows x[n], x[n−1], … one tap after another, and takes the new sample in the last cycle.`,
      ports: [bus('x', w, 'in'), bit('last', 'in'), clockPort(), bus('head', w, 'out')],
      symbol: { kind: 'box', label: 'SAMPLES', w: 8 },
      netlist: () => ({ pins: { x: [0, 6], last: [0, 14], clk: [0, 22], head: [R + 12, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** acc ← (first ? 0 : acc) + product. The product is sign-extended into the guarded width. */
export function firAcc(A: number, w: number): ComponentDef {
  return memo(`firacc${A}_${w}`, () => {
    const b = new Builder(10, 10, 4);
    b.pins('p', 'first', 'clk');
    const ext = b.op1(placed(2 * w, 0, A), ['p'], `${2 * w} → ${A} bits`, 'ext');
    const zero = b.op1(constWord(A, 0), [], 'start afresh', 'zero');
    const cin = b.op1(TIE0, [], 'no carry in', 'cin');
    const one = b.op1(TIE1, [], 'always loads', 'one');
    b.next();
    const gate = b.op1(busMux2(A), ['', zero, 'first'], 'zero at the first tap', 'gate');
    b.next();
    const add = b.op(rca(A), [gate, ext, cin], `${A}-bit sum`, 'add');
    b.next();
    const areg = b.op(register(A), [`${add}.s`, one, 'clk'], 'accumulator', 'areg');
    b.wire(`${areg}.q`, `${gate.split('.')[0]}.a`);
    b.wire(`${areg}.q`, 'acc');
    const R = b.right;
    return define({
      id: `firacc${A}_${w}`, name: `${A}-bit guarded accumulator`, category: 'arithmetic',
      summary: `Adds each ${2 * w}-bit product to a ${A}-bit register, starting afresh at the first tap. The ${A - 2 * w} bits above the product are guard bits: the sum cannot wrap.`,
      ports: [bus('p', 2 * w, 'in'), bit('first', 'in'), clockPort(), bus('acc', A, 'out')],
      symbol: { kind: 'box', label: 'ACC', w: 8 },
      netlist: () => ({ pins: { p: [0, 6], first: [0, 14], clk: [0, 22], acc: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The finished sum to a word: drop `frac` places with the first dropped bit added back (round half up), then clamp once. */
export function firOut(A: number, w: number, frac: number): ComponentDef {
  return memo(`firout${A}_${w}_${frac}`, () => {
    const b = new Builder(10, 10, 4);
    b.pins('acc');
    const hi = b.op1(cut(A, frac, A - frac), ['acc'], `drop ${frac} bits`, 'hi');
    const lo = b.op1(cut(A, frac - 1, 1), ['acc'], 'first dropped bit', 'lo');
    b.next();
    const r = b.op1(roundUp(A - frac), [hi, lo], 'round half up', 'round');
    b.next();
    const cl = b.op(clampWide(A - frac, w), [r], 'clamp once', 'clamp');
    b.next();
    b.wire(`${cl}.y`, 'y');
    b.wire(`${cl}.sat`, 'sat');
    const R = b.right;
    return define({
      id: `firout${A}_${w}_${frac}`, name: 'Round and clamp', category: 'arithmetic',
      summary: `${A} bits to ${w}: wires drop the low ${frac}, half adders add the first dropped bit back, one clamp catches what does not fit. Done once per output, not per product.`,
      ports: [bus('acc', A, 'in'), bus('y', w, 'out'), bit('sat', 'out')],
      symbol: { kind: 'box', label: 'ROUND', w: 8 },
      spec: ([a]) => {
        const v = wrapTo(a, A), r = wrapTo(Math.floor((v + 2 ** (frac - 1)) / 2 ** frac), A - frac), y = satTo(r, w);
        return [uns(y, w), y === r ? 0 : 1];
      },
      netlist: () => ({ pins: { acc: [0, 6], y: [R, 6], sat: [R, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the filter ---------------------------------------------------------------------------------------------------------------------------

/**
 * The whole filter. Ports: x (the sample, read at the end of the cycle in which `take` is 1), y and sat (the last finished output and whether it was
 * clamped), k (the tap this cycle), acc (the running sum). One output every N clocks; y holds for N clocks.
 */
export function firMac(cfg: MacConfig): ComponentDef {
  const { taps, w, frac } = cfg, N = taps.length, A = macAccWidth(cfg), kb = bitsFor(N), id = `firmac${w}_${frac}_${cfg.guard}_${N}_${hash(taps)}`;
  if (N < 2 || frac < 1) throw new Error('firMac: at least two taps and one fractional bit');
  return memo(id, () => {
    const b = new Builder(10, 10, 4);
    b.pins('x', 'clk');
    const ctr = b.op(firCounter(kb), ['', 'clk'], 'which tap', 'ctr');
    b.next();
    const rom = b.op(firRom(taps, w), [`${ctr}.k`], 'tap and flags', 'tapsrom');
    b.next();
    const ring = b.op(firRing(N, w), ['x', `${rom}.last`, 'clk'], 'samples', 'ring');
    b.next();
    const mul = b.op(treeMul(w, true), [`${ring}.head`, `${rom}.c`], `${w} × ${w}, signed`, 'mul');
    b.next();
    const acc = b.op(firAcc(A, w), [`${mul}.p`, `${rom}.first`, 'clk'], undefined, 'accum');
    b.next();
    const out = b.op(firOut(A, w, frac), [`${acc}.acc`], undefined, 'rnd');
    b.next();
    const yr = b.op(register(w), [`${out}.y`, `${rom}.first`, 'clk'], 'output, held', 'yreg');
    const sr = b.op(register(1), [`${out}.sat`, `${rom}.first`, 'clk'], 'clamped?', 'sreg');
    b.wire(`${rom}.last`, `${ctr}.clr`);
    b.wire(`${rom}.last`, 'take');
    b.wire(`${ctr}.k`, 'k');
    b.wire(`${acc}.acc`, 'acc');
    b.wire(`${yr}.q`, 'y');
    b.wire(`${sr}.q`, 'sat');
    const R = b.right;
    return define({
      id, name: `FIR, ${N} taps on one multiplier`, category: 'arithmetic',
      summary: `A ${N}-tap filter in ${N} clocks a sample: a ring of ${w}-bit samples, a ROM of taps, one ${w} × ${w} signed multiplier, a ${A}-bit accumulator, rounded once and clamped once.`,
      ports: [bus('x', w, 'in'), clockPort(), bus('y', w, 'out'), bit('sat', 'out'), bit('take', 'out'), bus('k', kb, 'out'), bus('acc', A, 'out')],
      symbol: { kind: 'box', label: 'FIR', w: 8 },
      netlist: () => ({ pins: { x: [0, 6], clk: [0, 22], y: [R, 6], sat: [R, 14], take: [R, 22], k: [R, 30], acc: [R, 38] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- a constant multiplier in canonical signed digits ----------------------------------------------------------------------------------------

/** Bits a w-bit signed word times the constant c needs. */
export const csdWidth = (c: number, w: number): number => w + Math.ceil(Math.log2(Math.abs(c) + 1));

/** y = c · a by shifts and adders, one adder for each non-zero digit after the first: the multiplier a constant tap needs. */
export function csdMultiplier(c: number, w: number): ComponentDef {
  const ow = csdWidth(c, w), id = `csdmul${w}_${c < 0 ? 'm' : 'p'}${Math.abs(c)}`;
  return memo(id, () => {
    // the digits of c, the ones of the opposite sign last, so that a positive digit starts the sum when there is one
    const digits = csdOf(c).sort((p, q) => Number(p.neg) - Number(q.neg) || q.pos - p.pos);
    const b = new Builder(10, 10, 4);
    b.pins('a');
    const cin1 = b.op1(TIE1, [], 'for a subtraction', 'one');
    const cin0 = b.op1(TIE0, [], 'no carry in', 'zero');
    const term = (d: { pos: number }, nm: string) => {
      if (d.pos === 0) return b.op1(placed(w, 0, ow), ['a'], `× 2^${d.pos}`, nm);
      const z = b.op1(TIE0, [], undefined, `${nm}z`);
      return b.op1(placed(w, d.pos, ow), ['a', z], `× 2^${d.pos}`, nm);
    };
    let sum = '';
    if (digits.length === 0) sum = b.op1(constWord(ow, 0), [], 'c = 0', 'none');
    digits.forEach((d, i) => {
      b.next();
      const t = term(d, `t${i}`);
      b.next();
      if (i === 0) {
        if (d.neg) {
          const nt = b.op1(notBus(ow), [t], undefined, `n${i}`), z0 = b.op1(constWord(ow, 0), [], 'start from 0', 'z0');
          sum = `${b.op(rca(ow), [z0, nt, cin1], '0 − term', 'add0')}.s`;
        } else sum = t;
      } else if (d.neg) {
        const nt = b.op1(notBus(ow), [t], undefined, `n${i}`);
        sum = `${b.op(rca(ow), [sum, nt, cin1], `− 2^${d.pos}`, `add${i}`)}.s`;
      } else sum = `${b.op(rca(ow), [sum, t, cin0], `+ 2^${d.pos}`, `add${i}`)}.s`;
    });
    b.next();
    b.wire(sum, 'y');
    const R = b.right;
    const terms = digits.length;
    return define({
      id, name: `× ${c}, shifts and adders`, category: 'arithmetic',
      summary: `A signed ${w}-bit word times the constant ${c}: ${terms} signed power${terms === 1 ? '' : 's'} of two, so ${terms === 0 ? 'no adder' : `${digits.some((d) => !d.neg) ? terms - 1 : terms} adder${(digits.some((d) => !d.neg) ? terms - 1 : terms) === 1 ? '' : 's'}`}. The shifts are wiring.`,
      ports: [bus('a', w, 'in'), bus('y', ow, 'out')],
      symbol: { kind: 'box', label: `×${c}`, w: 8 },
      spec: ([a]) => [uns(c * wrapTo(a, w), ow)],
      netlist: () => ({ pins: { a: [0, 6], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- what each way of building the filter costs ---------------------------------------------------------------------------------------------

export interface FirCost { name: string; nands: number; mults: number; cycles: number; note: string }
const nands = (d: ComponentDef): number => stats(d).nands;

/** Counted from the gates: multipliers, adders and registers priced with stats(), the time-shared filter counted whole. */
export function firCosts(cfg: MacConfig): FirCost[] {
  const { taps, w } = cfg, N = taps.length, A = macAccWidth(cfg), mul = nands(treeMul(w, true)), add = nands(rca(A)), reg = nands(register(w));
  const half = Math.ceil(N / 2), mul1 = nands(treeMul(w + 1, true)), pre = nands(rca(w + 1));
  return [
    { name: 'Direct form, all parallel', nands: N * mul + (N - 1) * add + (N - 1) * reg, mults: N, cycles: 1, note: `${N} multipliers, ${N - 1} adders, ${N - 1} sample registers` },
    { name: 'Folded: add the pair, then multiply', nands: half * mul1 + (N >> 1) * pre + (half - 1) * add + (N - 1) * reg, mults: half, cycles: 1, note: `${half} multipliers one bit wider, ${N >> 1} pre-adders, ${half - 1} adders` },
    { name: 'Folded, taps in shifts and adders', nands: taps.slice(0, half).reduce((t, c) => t + nands(csdMultiplier(c, w + 1)), 0) + (N >> 1) * pre + (half - 1) * add + (N - 1) * reg, mults: 0, cycles: 1, note: `${half} constant multipliers, no general multiplier at all` },
    { name: 'Transposed form, mirror taps sharing a product', nands: half * mul + (N - 1) * add + (N - 1) * nands(register(A)), mults: half, cycles: 1, note: `${half} multipliers fed by the input at once, ${N - 1} accumulator-wide registers` },
    { name: 'One multiplier, N clocks a sample', nands: nands(firMac(cfg)), mults: 1, cycles: N, note: `the gates built here: ring, ROM, one multiplier, accumulator, rounding` },
  ];
}
