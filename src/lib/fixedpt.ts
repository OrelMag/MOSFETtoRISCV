// Fixed-point words in gates (chapter "Numbers that fit"): one guard bit, and a clamp that reads it. Every spec is dsp/fixed.ts.

import { addOverflows, fracMul as fracMulModel, satAdd, satTo, wrapTo } from '../dsp/fixed';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { busMux2, rca } from './combinational';
import { define } from './define';
import { cut, placed, roundUp } from './fft';
import { NOT, XOR } from './gates';
import { treeMul } from './muldiv';
import { TIE0 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const uns = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Wiring: the limit a word clamps to. From the sign s and its inverse: s on top, ¬s below, so 100…0 or 011…1. */
export function limitWord(w: number): ComponentDef {
  return memo(`fxlimit${w}`, () => define({
    id: `fxlimit${w}`, name: `Wiring: the ${w}-bit limit`, category: 'plumbing',
    summary: 'The largest word of this sign: the sign on top, its inverse in every bit below. Only wires.',
    ports: [bit('s', 'in'), bit('n', 'in'), bus('y', w, 'out')], symbol: { kind: 'box', label: 'limit', w: 6, h: 4 }, prim: 'alias',
    alias: Array.from({ length: w }, (_, i): [string, number, string, number] => (i === w - 1 ? ['s', 0, 'y', i] : ['n', 0, 'y', i])),
  }));
}

/** w + 1 bits down to w: the two top bits differ exactly when the value does not fit, and then the top one is its true sign. */
export function clampWord(w: number): ComponentDef {
  return memo(`fxclamp${w}`, () => {
    const b = new Builder(6, 10, 4);
    b.pins('x');
    const top = b.op1(cut(w + 1, w, 1), ['x'], 'true sign', 'top');
    const under = b.op1(cut(w + 1, w - 1, 1), ['x'], 'top bit that fits', 'under');
    const low = b.op1(cut(w + 1, 0, w), ['x'], 'the word', 'low');
    b.next();
    const nt = b.op1(NOT, [top], undefined, 'inv');
    const over = b.op1(XOR, [top, under], 'do not fit?', 'over');
    b.next();
    const lim = b.op1(limitWord(w), [top, nt], undefined, 'lim');
    b.next();
    const mux = b.op1(busMux2(w), [low, lim, over], 'keep or clamp', 'pick');
    b.next();
    b.wire(mux, 'y');
    b.wire(over, 'sat');
    const R = b.right;
    return define({
      id: `fxclamp${w}`, name: `${w}-bit clamp`, category: 'arithmetic',
      summary: `Takes ${w + 1} bits to ${w}. If the top two differ the value does not fit, and the output is the largest word of its sign.`,
      ports: [bus('x', w + 1, 'in'), bus('y', w, 'out'), bit('sat', 'out')],
      symbol: { kind: 'box', label: 'CLAMP', w: 8 },
      spec: ([x]) => { const v = wrapTo(x, w + 1), y = satTo(v, w); return [uns(y, w), y === v ? 0 : 1]; },
      netlist: () => ({ pins: { x: [0, 8], y: [R, 6], sat: [R, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** a + b clamped: one more bit than the word, an adder, and the clamp. */
export function satAdder(w: number): ComponentDef {
  return memo(`satadd${w}`, () => {
    const b = new Builder(6, 10, 4);
    b.pins('a', 'b');
    const xa = b.op1(placed(w, 0, w + 1), ['a'], 'a guard bit', 'xa');
    const xb = b.op1(placed(w, 0, w + 1), ['b'], 'a guard bit', 'xb');
    const zero = b.op1(TIE0, [], undefined, 'zero');
    b.next();
    const add = b.op(rca(w + 1), [xa, xb, zero], `${w + 1}-bit sum`, 'add');
    b.next();
    const cl = b.op(clampWord(w), [`${add}.s`], undefined, 'clamp');
    b.next();
    b.wire(`${cl}.y`, 'y');
    b.wire(`${cl}.sat`, 'sat');
    const R = b.right;
    return define({
      id: `satadd${w}`, name: `${w}-bit saturating adder`, category: 'arithmetic',
      summary: 'a + b that stops at full scale: an adder one bit wider than the word, and a clamp. The price of failing softly.',
      ports: [bus('a', w, 'in'), bus('b', w, 'in'), bus('y', w, 'out'), bit('sat', 'out')],
      symbol: { kind: 'box', label: 'SAT+', w: 8 },
      spec: ([x, y]) => { const a = wrapTo(x, w), c = wrapTo(y, w); return [uns(satAdd(a, c, w), w), addOverflows(a, c, w) ? 1 : 0]; },
      netlist: () => ({ pins: { a: [0, 2], b: [0, 8], y: [R, 6], sat: [R, 14] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Q1.(w−1) × Q1.(w−1): the multiplier keeps 2w bits, wires take w + 1 of them, the first dropped bit rounds, the clamp catches −1 × −1. */
export function fracMultiplier(w: number): ComponentDef {
  return memo(`fracmul${w}`, () => {
    const b = new Builder(6, 10, 4);
    b.pins('a', 'b');
    const m = b.op(treeMul(w, true), ['a', 'b'], `${w} × ${w}, signed`, 'mul');
    b.next();
    const hi = b.op1(cut(2 * w, w - 1, w + 1), [`${m}.p`], 'drop the spare sign', 'hi');
    const lo = b.op1(cut(2 * w, w - 2, 1), [`${m}.p`], 'first bit dropped', 'lo');
    b.next();
    const r = b.op1(roundUp(w + 1), [hi, lo], 'round half up', 'round');
    b.next();
    const cl = b.op(clampWord(w), [r], undefined, 'clamp');
    b.next();
    b.wire(`${cl}.y`, 'y');
    b.wire(`${cl}.sat`, 'sat');
    const R = b.right;
    return define({
      id: `fracmul${w}`, name: `Q1.${w - 1} multiplier`, category: 'arithmetic',
      summary: 'A signed multiplier, then wires for the binary point, a rounder and a clamp. The clamp is there for one input pair: −1 × −1.',
      ports: [bus('a', w, 'in'), bus('b', w, 'in'), bus('y', w, 'out'), bit('sat', 'out')],
      symbol: { kind: 'box', label: '×Q', w: 8 },
      spec: ([x, y]) => { const a = wrapTo(x, w), c = wrapTo(y, w), v = fracMulModel(a, c, w); return [uns(v, w), a === -(2 ** (w - 1)) && c === a ? 1 : 0]; },
      netlist: () => ({ pins: { a: [0, 2], b: [0, 8], y: [R, 6], sat: [R, 14] }, instances: b.instances, nets: b.nets() }),
    });
  });
}
