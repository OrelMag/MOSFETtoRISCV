// The capstone "A filter to a mask": the gates of its reference answer and of the wrong answers it must refuse (campaign/capmask.ts). One sample a clock,
// x a 12-bit signed word, y a 14-bit one at the same scale (two bits of headroom). maskFir is the symmetric FIR folded in half, every tap a constant multiplier
// of shifts and adders (dsp/firdesign.ts csdOf, lib/firmac.ts csdMultiplier), the sum rounded once; maskIir is two of chapter "IIR and stability"'s biquads.

import { csdWidth, csdMultiplier } from './firmac';
import { type Words } from '../dsp/iir';
import { biquad } from './biquad';
import { Builder } from './builder';
import { rca } from './combinational';
import { constWord } from './alu';
import { define } from './define';
import { cut, placed, roundUp } from './fft';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import type { ComponentDef, PortDef } from '../sim/types';

export const MASK_X_BITS = 12;
export const MASK_Y_BITS = 14;

const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const cache = new Map<string, ComponentDef>();
const memo = (key: string, f: () => ComponentDef): ComponentDef => { let d = cache.get(key); if (!d) cache.set(key, (d = f())); return d; };
const hash = (words: readonly number[]): string => {
  let h = 2166136261;
  for (const w of words) { h ^= w >>> 0; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
};
const uns = (v: number, w: number): number => ((v % 2 ** w) + 2 ** w) % 2 ** w;

/** The smallest signed word that holds every sum of these tap words times a 12-bit sample: the accumulator the filter needs so that nothing can wrap. */
export const maskAccBits = (words: readonly number[]): number => Math.ceil(Math.log2(words.reduce((s, c) => s + Math.abs(c), 0) * 2 ** (MASK_X_BITS - 1) + 1)) + 1;

export interface MaskFir {
  /** Tap words, odd count, symmetric: the filter is words / 2^frac. */
  words: readonly number[];
  frac: number;
  /** The accumulator's width (maskAccBits: the least that cannot wrap). */
  accBits: number;
  /** A name for the drawing. */
  tag?: string;
}

/**
 * y[n] = round(Σ c[k] x[n−k] / 2^frac), read before the clock edge that takes x in. The N − 1 delayed samples are registers; the taps that mirror each other share
 * one multiplier behind a 13-bit pre-adder; every product is a shift-and-add constant multiplier; the products are summed in `accBits`, then the low `frac` bits are
 * dropped with the first dropped bit added back, and the rest is sign-extended to the 14-bit y (or, if the accumulator is too wide for y, its low 14 bits).
 */
export function maskFir(s: MaskFir): ComponentDef {
  const N = s.words.length, half = (N - 1) / 2, A = s.accBits, W = MASK_X_BITS, SW = W + 1, id = `maskfir${N}_${s.frac}_${A}_${hash(s.words)}`;
  if (N % 2 === 0 || N < 3) throw new Error('maskFir: an odd number of taps, at least three');
  return memo(id, () => {
    const b = new Builder(10, 10, 4);
    b.pins('x', 'clk');
    const one = b.op1(TIE1, [], 'always load', 'one'), zero = b.op1(TIE0, [], 'no carry in', 'zero');
    b.next();
    // the delay line: z1 … z(N−1), each a register of the one before it
    const q = ['x'];
    for (let k = 1; k < N; k++) q.push(`${b.op(register(W), ['', one, 'clk'], `x[n−${k}]`, `z${k}`)}.q`);
    for (let k = 1; k < N; k++) b.wire(q[k - 1], `z${k}.d`);
    b.next();
    // the products: the pair k and N − 1 − k added first, the centre tap alone
    const prods: { ref: string; w: number }[] = [];
    const mul = (c: number, a: string, label: string, nm: string) => {
      if (c === 0) return;
      prods.push({ ref: b.op1(csdMultiplier(c, SW), [a], label, nm), w: csdWidth(c, SW) });
    };
    for (let k = 0; k < half; k++) {
      const ea = b.op1(placed(W, 0, SW), [q[k]], undefined, `ea${k}`), eb = b.op1(placed(W, 0, SW), [q[N - 1 - k]], undefined, `eb${k}`);
      const pre = b.op(rca(SW), [ea, eb, zero], `x[n−${k}] + x[n−${N - 1 - k}]`, `pre${k}`);
      mul(s.words[k], `${pre}.s`, `× ${s.words[k]}`, `m${k}`);
    }
    mul(s.words[half], b.op1(placed(W, 0, SW), [q[half]], undefined, 'ec'), `× ${s.words[half]} (centre)`, `m${half}`);
    b.next();
    // the sum, in a word that cannot wrap
    const ext = prods.map((p, i) => b.op1(placed(p.w, 0, A), [p.ref], undefined, `px${i}`));
    b.next();
    let sum = ext[0];
    for (let i = 1; i < ext.length; i++) sum = `${b.op(rca(A), [sum, ext[i], zero], i === ext.length - 1 ? 'the sum' : undefined, `sum${i}`)}.s`;
    b.next();
    const hiW = A - s.frac;
    const hi = b.op1(cut(A, s.frac, hiW), [sum], `drop ${s.frac} bits`, 'hi'), lo = b.op1(cut(A, s.frac - 1, 1), [sum], 'first dropped bit', 'lo');
    b.next();
    const r = b.op1(roundUp(hiW), [hi, lo], 'round half up', 'round');
    b.next();
    const y = hiW < MASK_Y_BITS ? b.op1(placed(hiW, 0, MASK_Y_BITS), [r], 'sign-extend to 14 bits', 'yext') : hiW > MASK_Y_BITS ? b.op1(cut(hiW, 0, MASK_Y_BITS), [r], 'low 14 bits', 'ycut') : r;
    b.wire(y, 'y');
    const R = b.right;
    return define({
      id, name: `FIR, ${N} taps, folded${s.tag ? ` (${s.tag})` : ''}`, category: 'arithmetic',
      summary: `A ${N}-tap symmetric FIR, one sample a clock: ${N - 1} delay registers, ${half} pre-adders, ${prods.length} constant multipliers in shifts and adders, a ${A}-bit sum rounded once to 14 bits.`,
      ports: [bus('x', W, 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('y', MASK_Y_BITS, 'out')],
      symbol: { kind: 'box', label: 'FIR', w: 8 },
      netlist: () => ({ pins: { x: [0, 6], clk: [0, 22], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

export interface MaskIir {
  /** Each section's coefficient words (Q2.14), cascaded. */
  sections: readonly Words[];
  /** How the biquads drop their low bits: the rounding that is fed back. */
  round: 'half-up' | 'zero' | 'trunc';
}

/**
 * A cascade of biquads on the 12-bit sample taken as a 16-bit word two places up (two bits of headroom and of precision inside), rounded back to 14 bits at the end.
 * What the biquads drop is their rounding (`round`): the one that is fed back.
 */
export function maskIir(s: MaskIir): ComponentDef {
  const id = `maskiir${s.round}_${hash(s.sections.flatMap((w) => [w.b0, w.b1, w.b2, w.a1, w.a2]))}`;
  return memo(id, () => {
    const b = new Builder(10, 10, 4);
    b.pins('x', 'clk');
    const zero = b.op1(TIE0, [], 'zeros come in below', 'zero');
    let cur = b.op1(placed(MASK_X_BITS, 2, 16), ['x', zero], '12 → 16 bits, ×4', 'sx');
    s.sections.forEach((w, i) => {
      b.next();
      const k = (n: keyof Words, nm: string) => b.op1(constWord(16, uns(w[n], 16)), [], nm, `${nm}_${i}`);
      const bq = b.op(biquad(s.round), [cur, k('b0', 'b0'), k('b1', 'b1'), k('b2', 'b2'), k('a1', 'a1'), k('a2', 'a2'), 'clk'], `section ${i + 1}`, `bq${i}`);
      cur = `${bq}.y`;
    });
    b.next();
    const hi = b.op1(cut(16, 2, MASK_Y_BITS), [cur], 'drop 2 bits', 'hi'), lo = b.op1(cut(16, 1, 1), [cur], 'first dropped bit', 'lo');
    b.next();
    b.wire(b.op1(roundUp(MASK_Y_BITS), [hi, lo], 'round half up', 'round'), 'y');
    const R = b.right;
    return define({
      id, name: `IIR, ${s.sections.length} biquads (${s.round})`, category: 'arithmetic',
      summary: `${s.sections.length} biquads in a row, each ${s.round === 'zero' ? 'rounding toward zero' : s.round === 'trunc' ? 'flooring' : 'rounding half up'}.`,
      ports: [bus('x', MASK_X_BITS, 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('y', MASK_Y_BITS, 'out')],
      symbol: { kind: 'box', label: 'IIR', w: 8 },
      netlist: () => ({ pins: { x: [0, 6], clk: [0, 22], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}
