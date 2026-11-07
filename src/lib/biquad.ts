// The chapter "IIR and stability": a biquad in gates. Direct form I, so the whole sum has one rounding: five 16 × 16 signed multipliers
// (treeMul), a 35-bit accumulator (32-bit products + 3 guard bits for five terms), one rounder, one clamp, and the four delay registers.
// Data Q1.15, coefficients Q2.14 (−2 … 2 − 2⁻¹⁴); the feedback terms are subtracted in gates, so a₁ = −2 is a word and the lattice of
// chapter "IIR" is the lattice the hardware can reach. dsp/iir.ts Biquad is the model, compared at every clock (tests/dsp-iir.test.ts).

import { BQ, type BqRound } from '../dsp/iir';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { rca } from './combinational';
import { define, ones, splitter } from './define';
import { cut, placed, roundUp } from './fft';
import { clampWord } from './fixedpt';
import { AND } from './gates';
import { treeMul } from './muldiv';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { notBus } from './viterbi';
import { orN } from './wide';

const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();

/** The biquad. `round` is the one rounding: half-up (the default, and the first dropped bit added back) or toward zero (sign and any dropped bit). */
export function biquad(round: Extract<BqRound, 'half-up' | 'zero' | 'trunc'> = 'half-up'): ComponentDef {
  const key = round === 'zero' ? 'biquad16z' : round === 'trunc' ? 'biquad16t' : 'biquad16';
  let d = cache.get(key);
  if (d) return d;
  const { w, accW, drop } = BQ, hiW = accW - drop;
  const b = new Builder(10, 12, 4);
  b.pins('x', 'b0', 'b1', 'b2', 'a1', 'a2', 'clk');
  const load = b.op1(TIE1, [], 'always load', 'one');
  const gnd = b.op1(TIE0, [], 'no carry in', 'zero');
  b.next();
  // delay registers: x[n−1], x[n−2] from the input, y[n−1], y[n−2] from the output (named below, wired when y exists)
  const rx1 = b.op(register(w), ['x', load, 'clk'], 'x[n−1]', 'x1');
  const ry1 = b.op(register(w), ['', load, 'clk'], 'y[n−1]', 'y1');
  b.name(`${rx1}.q`, 'x1', true); b.name(`${ry1}.q`, 'y1', true);
  b.next();
  const rx2 = b.op(register(w), [`${rx1}.q`, load, 'clk'], 'x[n−2]', 'x2');
  const ry2 = b.op(register(w), [`${ry1}.q`, load, 'clk'], 'y[n−2]', 'y2');
  b.name(`${rx2}.q`, 'x2', true); b.name(`${ry2}.q`, 'y2', true);
  b.next();
  const mul = (n: string, a: string, c: string, label: string) => b.op(treeMul(w, true), [a, c], label, n);
  const mb0 = mul('mb0', 'x', 'b0', 'b₀ x[n]'), mb1 = mul('mb1', `${rx1}.q`, 'b1', 'b₁ x[n−1]'), mb2 = mul('mb2', `${rx2}.q`, 'b2', 'b₂ x[n−2]');
  const ma1 = mul('ma1', `${ry1}.q`, 'a1', 'a₁ y[n−1]'), ma2 = mul('ma2', `${ry2}.q`, 'a2', 'a₂ y[n−2]');
  b.next();
  const ext = (m: string, nm: string) => b.op1(placed(BQ.prod, 0, accW), [`${m}.p`], undefined, nm);
  const eb0 = ext(mb0, 'eb0'), eb1 = ext(mb1, 'eb1'), eb2 = ext(mb2, 'eb2'), ea1 = ext(ma1, 'ea1'), ea2 = ext(ma2, 'ea2');
  b.next();
  const add = rca(accW);
  const s01 = b.op(add, [eb0, eb1, `${gnd}`], 'b₀x + b₁x₁', 'sum01');
  const sa = b.op(add, [ea1, ea2, `${gnd}`], 'a₁y₁ + a₂y₂', 'sumA');
  b.next();
  const s012 = b.op(add, [`${s01}.s`, eb2, `${gnd}`], '+ b₂x₂', 'sum012');
  const nsa = b.op1(notBus(accW), [`${sa}.s`], 'subtract: invert, +1', 'inv');
  b.next();
  const acc = b.op(add, [`${s012}.s`, nsa, load], 'accumulator, Q3.29', 'acc');
  b.next();
  const hi = b.op1(cut(accW, drop, hiW), [`${acc}.s`], 'keep 15 fractional bits', 'hi');
  let c: string;
  if (round === 'zero') {
    const sign = b.op1(cut(accW, accW - 1, 1), [`${acc}.s`], 'sign', 'sign');
    const low = b.op1(cut(accW, 0, drop), [`${acc}.s`], 'dropped bits', 'low');
    const sp = b.op(splitter(ones(drop), 4), [low], undefined, 'bits');
    const any = b.op(orN(drop), [], 'any dropped bit set?', 'any');
    for (let i = 0; i < drop; i++) b.wire(`${sp}.o${i}`, `${any}.i${i}`);
    c = b.op1(AND, [sign, `${any}.y`], 'negative with a remainder: one up', 'up');
  } else if (round === 'trunc') c = gnd; // floor: the dropped bits are simply left off
  else c = b.op1(cut(accW, drop - 1, 1), [`${acc}.s`], 'first dropped bit', 'lo');
  b.next();
  const r = b.op1(roundUp(hiW, 'ROUND'), [hi, c], round === 'zero' ? 'toward zero' : round === 'trunc' ? 'floor' : 'round half up', 'round');
  b.next();
  const cl = b.op(clampWord(w, hiW), [r], 'the one clamp', 'clamp');
  b.next();
  b.wire(`${cl}.y`, 'y');
  b.wire(`${cl}.sat`, 'sat');
  b.wire(`${cl}.y`, `${ry1}.d`);
  b.wire(`${ry1}.q`, `${ry2}.d`);
  const R = b.right;
  d = define({
    id: key, name: `Biquad (${round === 'zero' ? 'rounds toward zero' : round === 'trunc' ? 'floors' : 'rounds half up'})`, category: 'arithmetic',
    summary: 'A second-order IIR section in direct form I: five signed multipliers, a 35-bit accumulator, one rounding and one clamp, and four delay registers. Data Q1.15, coefficients Q2.14.',
    ports: [bus('x', w, 'in'), bus('b0', w, 'in'), bus('b1', w, 'in'), bus('b2', w, 'in'), bus('a1', w, 'in'), bus('a2', w, 'in'),
      { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('y', w, 'out'), { name: 'sat', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: 'BIQUAD', w: 8 },
    netlist: () => ({ pins: { x: [0, 4], b0: [0, 8], b1: [0, 12], b2: [0, 16], a1: [0, 20], a2: [0, 24], clk: [0, 28], y: [R, 6], sat: [R, 18] }, instances: b.instances, nets: b.nets() }),
  });
  cache.set(key, d);
  return d;
}
