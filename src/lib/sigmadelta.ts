// A sigma-delta converter's digital half, and an LMS filter, in gates (chapters "Converters" and "Filters that learn"). dsp/converters.ts and dsp/adaptive.ts are compared with them every clock
// (tests/dsp-converters.test.ts, dsp-adaptive.test.ts). Nothing here saturates: the integrators are sized not to overflow, and the LMS words wrap if they are driven too hard, which the chapter shows.

import { type LmsSpec } from '../dsp/adaptive';
import { SD_GUARD } from '../dsp/converters';
import { cicWidth } from '../dsp/multirate';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { addSub, rca } from './combinational';
import { define } from './define';
import { cut, placed } from './fft';
import { NOT } from './gates';
import { cicDecimator } from './multirate';
import { treeMul } from './muldiv';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkPort: PortDef = { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true };

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
function built(b: Builder, ports: PortDef[]) {
  const R = b.right;
  let li = 0, ri = 0;
  const pins: Record<string, [number, number]> = {};
  for (const p of ports) {
    if (p.side === 'bottom') pins[p.name] = [8, b.height + 3];
    else if (p.dir === 'in') pins[p.name] = [0, 2 + 3 * li++];
    else pins[p.name] = [R, 2 + 3 * ri++];
  }
  return { pins, instances: b.instances, nets: b.nets() };
}

/** Wiring: the feedback word. +full scale or −full scale differ only above the top input bit: below it zeros, then a 1, then the inverse of the decision. */
function feedbackWord(w: number, W: number): ComponentDef {
  return memo(`sd_fb${w}_${W}`, () => define({
    id: `sd_fb${w}_${W}`, name: 'Wiring: ± full scale', category: 'plumbing',
    summary: 'The one-bit DAC of a digital loop costs nothing: the word for +full scale and the word for −full scale differ only in their top bits, which are the decision\'s inverse.',
    ports: [bit('z', 'in'), bit('one', 'in'), bit('nb', 'in'), bus('y', W, 'out')], symbol: { kind: 'box', label: '±FS', w: 6, h: 4 }, prim: 'alias',
    alias: Array.from({ length: W }, (_, i): [string, number, string, number] => [i < w - 1 ? 'z' : i === w - 1 ? 'one' : 'nb', 0, 'y', i]),
  }));
}

/** The digital loop of a one-bit sigma-delta modulator, order 1 or 2. In a real converter the integrators are analogue; here they are words, so the loop's arithmetic can be checked exactly. */
export function sdModulator(order: 1 | 2, w: number): ComponentDef {
  const W = w + SD_GUARD;
  return memo(`sd${order}_${w}`, () => {
    const b = new Builder(10, 12, 6);
    b.pins('u', 'clk');
    const gnd = b.op(TIE0, [], undefined, 'gnd'), one = b.op(TIE1, [], undefined, 'one');
    const r1 = b.add(register(W), 'integrator 1', 'r1');
    const r2 = order === 2 ? b.add(register(W), 'integrator 2', 'r2') : '';
    const rb = b.op(register(1), ['', `${one}.y`, 'clk'], 'the bit', 'rb');
    b.next();
    const last = order === 2 ? `${r2}.q` : `${r1}.q`;
    const sign = b.op1(cut(W, W - 1, 1), [last], 'sign', 'sign');
    const dec = b.op1(NOT, [sign], 'decide', 'dec');
    const nb = b.op1(NOT, [dec], undefined, 'nb');
    const fb = b.op1(feedbackWord(w, W), [`${gnd}.y`, `${one}.y`, nb], undefined, 'fb');
    const ux = b.op1(placed(w, 0, W), ['u'], undefined, 'ux');
    b.wire(dec, `${rb}.d`);
    b.next();
    const a1 = b.op(rca(W), [`${r1}.q`, ux, `${gnd}.y`], 'y₁ + u', 'a1');
    const s1 = b.op(addSub(W), [`${a1}.s`, fb, `${one}.y`], '− v', 's1');
    b.wire(`${s1}.s`, `${r1}.d`); b.wire(`${one}.y`, `${r1}.en`); b.wire('clk', `${r1}.clk`);
    if (order === 2) {
      b.next();
      const a2 = b.op(rca(W), [`${r2}.q`, `${s1}.s`, `${gnd}.y`], 'y₂ + y₁', 'a2');
      const s2 = b.op(addSub(W), [`${a2}.s`, fb, `${one}.y`], '− v', 's2');
      b.wire(`${s2}.s`, `${r2}.d`); b.wire(`${one}.y`, `${r2}.en`); b.wire('clk', `${r2}.clk`);
    }
    b.next();
    b.wire(`${rb}.q`, 'bit'); b.wire(`${r1}.q`, 'y1');
    if (order === 2) b.wire(`${r2}.q`, 'y2');
    const ports = [bus('u', w, 'in'), clkPort, bit('bit', 'out'), bus('y1', W, 'out'), ...(order === 2 ? [bus('y2', W, 'out')] : [])];
    return define({
      id: `sd${order}_${w}`, name: `Sigma-delta loop, order ${order}`, category: 'sequential',
      summary: `${order} running sum${order === 2 ? 's' : ''} of the input less what the bit said last time, and a decision from the sign of the last one. Noise is pushed up in frequency, and the average of the bits follows the input.`,
      ports, symbol: { kind: 'box', label: 'ΣΔ', w: 8 }, netlist: () => built(b, ports),
    });
  });
}

/** Wiring: the bit as a two-bit word, +1 or −1. */
const BIT_WORD: ComponentDef = define({
  id: 'sd_bitword', name: 'Wiring: 1 → +1, 0 → −1', category: 'plumbing', summary: 'A two-bit word: its low bit is always 1, and its sign is the bit\'s inverse.',
  ports: [bit('one', 'in'), bit('nb', 'in'), bus('y', 2, 'out')], symbol: { kind: 'box', label: '±1', w: 4, h: 2 }, prim: 'alias', alias: [['one', 0, 'y', 0], ['nb', 0, 'y', 1]],
});

/** The whole digital side: the loop's bits, then chapter "Changing the rate"'s CIC, down to words at the low rate. */
export function sdConverter(order: 1 | 2, w: number, N: number, R: number): ComponentDef {
  return memo(`sdadc${order}_${w}_${N}_${R}`, () => {
    const b = new Builder(10, 12, 6);
    b.pins('u', 'clk');
    const one = b.op(TIE1, [], undefined, 'one');
    const m = b.op(sdModulator(order, w), ['u', 'clk'], 'the loop', 'loop');
    b.next();
    const nb = b.op1(NOT, [`${m}.bit`], undefined, 'nb');
    const word = b.op1(BIT_WORD, [`${one}.y`, nb], undefined, 'word');
    b.next();
    const c = b.op(cicDecimator(N, R, 2), [word, 'clk'], 'decimate', 'cic');
    b.next();
    b.wire(`${m}.bit`, 'bit'); b.wire(`${c}.y`, 'y'); b.wire(`${c}.valid`, 'valid');
    const ports = [bus('u', w, 'in'), clkPort, bit('bit', 'out'), bus('y', cicWidth(N, R, 2), 'out'), bit('valid', 'out')];
    return define({
      id: `sdadc${order}_${w}_${N}_${R}`, name: `Sigma-delta, then a CIC (÷ ${R})`, category: 'arithmetic',
      summary: `A stream of single bits at the high rate goes in to a CIC of order ${N}, and words of many bits leave at a ${R}th of the rate.`,
      ports, symbol: { kind: 'box', label: 'ADC', w: 8 }, netlist: () => built(b, ports),
    });
  });
}

// ---- LMS -----------------------------------------------------------------------------------------------------------------------------------------

/** One tap: the sample it holds, its coefficient, one multiplier to use it and one to learn. */
export function lmsTap(o: LmsSpec): ComponentDef {
  const { wx, w, f, s } = o;
  return memo(`lms_tap${wx}_${w}_${f}_${s}`, () => {
    const b = new Builder(10, 12, 6);
    b.pins('xin', 'e', 'clk');
    const gnd = b.op(TIE0, [], undefined, 'gnd'), one = b.op(TIE1, [], undefined, 'one');
    const c = b.add(register(w), 'coefficient', 'c');
    const rx = b.op(register(wx), ['xin', `${one}.y`, 'clk'], 'sample', 'rx');
    b.next();
    const xw = b.op1(placed(wx, 0, w), [`${rx}.q`], undefined, 'xw');
    const y = b.op1(treeMul(w, true), [`${c}.q`, xw], 'c × x', 'muly');
    const g = b.op1(treeMul(w, true), ['e', xw], 'e × x', 'mulg');
    b.next();
    const yo = b.op1(cut(2 * w, f, w), [y], `≫ ${f}`, 'yc'), step = b.op1(cut(2 * w, s, w), [g], `≫ ${s}`, 'gc');
    b.next();
    const nc = b.op(rca(w), [`${c}.q`, step, `${gnd}.y`], 'c + step', 'addc');
    b.wire(`${nc}.s`, `${c}.d`); b.wire(`${one}.y`, `${c}.en`); b.wire('clk', `${c}.clk`);
    b.next();
    b.wire(yo, 'y'); b.wire(`${c}.q`, 'c'); b.wire(`${rx}.q`, 'xout');
    const ports = [bus('xin', wx, 'in'), bus('e', w, 'in'), clkPort, bus('y', w, 'out'), bus('c', w, 'out'), bus('xout', wx, 'out')];
    return define({
      id: `lms_tap${wx}_${w}_${f}_${s}`, name: 'LMS tap', category: 'arithmetic',
      summary: 'A sample and a coefficient. One multiplier gives this tap\'s share of the output, and one works out how far the error says to move the coefficient. Two multipliers a tap: learning costs as much again as filtering.',
      ports, symbol: { kind: 'box', label: 'TAP', w: 8 }, netlist: () => built(b, ports),
    });
  });
}

/** n taps in a row, their outputs summed, and the error fed back to all of them. */
export function lmsFilter(o: LmsSpec): ComponentDef {
  const { n, wx, w } = o;
  return memo(`lms${n}_${wx}_${w}_${o.f}_${o.s}`, () => {
    const b = new Builder(10, 12, 4);
    b.pins('x', 'd', 'clk');
    const gnd = b.op(TIE0, [], undefined, 'gnd'), one = b.op(TIE1, [], undefined, 'one');
    const dw = b.op1(placed(wx, 0, w), ['d'], undefined, 'dw');
    b.next();
    const tap = lmsTap(o), names: string[] = [];
    let feed = 'x';
    for (let k = 0; k < n; k++) { const t = b.add(tap, `tap ${k}`, `t${k}`); names.push(t); b.wire(feed, `${t}.xin`); b.wire('clk', `${t}.clk`); feed = `${t}.xout`; }
    b.next();
    let sum = `${names[0]}.y`;
    for (let k = 1; k < n; k++) sum = `${b.op(rca(w), [sum, `${names[k]}.y`, `${gnd}.y`], undefined, `s${k}`)}.s`;
    b.next();
    const err = b.op(addSub(w), [dw, sum, `${one}.y`], 'e = d − y', 'err');
    for (let k = 0; k < n; k++) b.wire(`${err}.s`, `${names[k]}.e`);
    b.next();
    b.wire(sum, 'y'); b.wire(`${err}.s`, 'e');
    for (let k = 0; k < n; k++) b.wire(`${names[k]}.c`, `c${k}`);
    const ports = [bus('x', wx, 'in'), bus('d', wx, 'in'), clkPort, bus('y', w, 'out'), bus('e', w, 'out'), ...Array.from({ length: n }, (_, k) => bus(`c${k}`, w, 'out'))];
    return define({
      id: `lms${n}_${wx}_${w}_${o.f}_${o.s}`, name: `LMS filter (${n} taps)`, category: 'arithmetic',
      summary: `A filter whose ${n} coefficients each move a little at every clock, in the direction that shrinks the error. No one tells it the answer: it has only d, and its own output to compare with.`,
      ports, symbol: { kind: 'box', label: 'LMS', w: 8 }, netlist: () => built(b, ports),
    });
  });
}
