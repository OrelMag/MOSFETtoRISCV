// Changing the rate in gates (chapter "Changing the rate"): a CIC decimator, adders and registers only, and a polyphase decimator, M multipliers doing the work of R·M.
// dsp/multirate.ts's models are compared with both, every clock (tests/dsp-multirate.test.ts). Registers here wrap, by design: no part saturates.

import { cicWidth, polyTaps, type PolySpec } from '../dsp/multirate';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { addSub, decoder, muxTree, rca } from './combinational';
import { define } from './define';
import { cut, placed } from './fft';
import { AND, NOT } from './gates';
import { lookupRom } from './modem';
import { treeMul } from './muldiv';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkPort: PortDef = { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true };
const log2 = (n: number) => Math.round(Math.log2(n));

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

/** The word's next value is itself plus what comes in, at every clock of the high rate. An adder and a register. */
export function integrator(w: number): ComponentDef {
  return memo(`cic_int${w}`, () => {
    const b = new Builder(8, 12, 4);
    b.pins('a', 'clk');
    const gnd = b.op(TIE0, [], undefined, 'gnd'), one = b.op(TIE1, [], undefined, 'one');
    const r = b.add(register(w), 'keeps the sum', 'r');
    b.next();
    const s = b.op(rca(w), [`${r}.q`, 'a', `${gnd}.y`], 'adds, and wraps', 'add');
    b.wire(`${s}.s`, `${r}.d`); b.wire(`${one}.y`, `${r}.en`); b.wire('clk', `${r}.clk`);
    b.next();
    b.wire(`${r}.q`, 'y');
    const ports = [bus('a', w, 'in'), clkPort, bus('y', w, 'out')];
    return define({ id: `cic_int${w}`, name: 'Integrator', category: 'arithmetic', summary: 'A running sum, wrapping at the word. It never saturates and need not: only differences of it reach the output, and two\'s complement differences survive a wrap.', ports, symbol: { kind: 'box', label: '∫', w: 6 }, netlist: () => built(b, ports) });
  });
}

/** The difference from the last sample at the low rate: a subtractor, and a register that only loads on the strobe. */
export function comb(w: number): ComponentDef {
  return memo(`cic_comb${w}`, () => {
    const b = new Builder(8, 12, 4);
    b.pins('a', 'en', 'clk');
    const r = b.op(register(w), ['a', 'en', 'clk'], 'the last sample', 'r');
    const one = b.op(TIE1, [], undefined, 'one');
    b.next();
    const s = b.op(addSub(w), ['a', `${r}.q`, `${one}.y`], 'this − last', 'sub');
    b.next();
    b.wire(`${s}.s`, 'y');
    const ports = [bus('a', w, 'in'), bit('en', 'in'), clkPort, bus('y', w, 'out')];
    return define({ id: `cic_comb${w}`, name: 'Comb', category: 'arithmetic', summary: 'This sample minus the last one at the low rate. Runs at the low rate, so it can share a clock with the integrators and load only on the strobe.', ports, symbol: { kind: 'box', label: '1−z⁻¹', w: 8 }, netlist: () => built(b, ports) });
  });
}

/** A count of R clocks, and a strobe on the last: the only thing the rate change costs. */
export function rateCount(k: number): ComponentDef {
  return memo(`cic_cnt${k}`, () => {
    const b = new Builder(8, 12, 4);
    b.pins('clk');
    const gnd = b.op(TIE0, [], undefined, 'gnd'), one = b.op(TIE1, [], undefined, 'one'), c1 = b.op1(constWord(k, 1), [], undefined, 'c1');
    const r = b.add(register(k), 'count', 'r');
    b.next();
    const s = b.op(rca(k), [`${r}.q`, c1, `${gnd}.y`], '+ 1', 'add');
    b.wire(`${s}.s`, `${r}.d`); b.wire(`${one}.y`, `${r}.en`); b.wire('clk', `${r}.clk`);
    let acc = '';
    for (let j = 0; j < k; j++) { const c = b.op1(cut(k, j, 1), [`${r}.q`], undefined, `b${j}`); acc = acc ? b.op1(AND, [acc, c], undefined, `a${j}`) : c; }
    b.next();
    b.wire(acc, 'strobe'); b.wire(`${r}.q`, 'q');
    const ports = [clkPort, bus('q', k, 'out'), bit('strobe', 'out')];
    return define({ id: `cic_cnt${k}`, name: `Count of ${2 ** k}`, category: 'sequential', summary: 'Counts the clocks of the high rate. All ones means this is the last of the group, so an output is taken.', ports, symbol: { kind: 'box', label: `÷${2 ** k}`, w: 6 }, netlist: () => built(b, ports) });
  });
}

/** N integrators at the input's rate, a count of R, N combs at the output's rate. No multiplier, and R a power of two. */
export function cicDecimator(N: number, R: number, wIn: number): ComponentDef {
  const w = cicWidth(N, R, wIn), k = log2(R);
  return memo(`cic${N}_${R}_${wIn}`, () => {
    const b = new Builder(10, 12, 6);
    b.pins('x', 'clk');
    const ext = b.op1(placed(wIn, 0, w), ['x'], 'sign-extended', 'sx');
    b.next();
    let v = ext;
    for (let i = 0; i < N; i++) { v = b.op1(integrator(w), [v, 'clk'], `integrator ${i + 1}`, `int${i}`); b.next(); }
    const cnt = b.op(rateCount(k), ['clk'], `÷ ${R}`, 'cnt');
    const strobe = `${cnt}.strobe`;
    b.next();
    for (let i = 0; i < N; i++) { v = b.op1(comb(w), [v, strobe, 'clk'], `comb ${i + 1}`, `comb${i}`); b.next(); }
    const yr = b.op(register(w), [v, strobe, 'clk'], 'output', 'yr');
    const one = b.op(TIE1, [], undefined, 'one');
    const vr = b.op(register(1), [strobe, `${one}.y`, 'clk'], 'valid', 'vr');
    b.next();
    b.wire(`${yr}.q`, 'y'); b.wire(`${vr}.q`, 'valid');
    const ports = [bus('x', wIn, 'in'), clkPort, bus('y', w, 'out'), bit('valid', 'out')];
    return define({
      id: `cic${N}_${R}_${wIn}`, name: `CIC decimator (order ${N}, ÷ ${R})`, category: 'arithmetic',
      summary: `${N} running sums at the high rate, ${N} differences at the low one, ${w}-bit words throughout. It filters as ${N} moving averages of ${R} samples would, with no multiplier and no memory of the samples.`,
      ports, symbol: { kind: 'box', label: 'CIC', w: 8 }, netlist: () => built(b, ports),
    });
  });
}

/** A decimator of R by polyphase, with M multipliers for its R·M taps. */
export function polyDecimator(s: PolySpec): ComponentDef {
  const { R, M, w, taps } = s, k = log2(R), W = 2 * w + log2(R * M);
  return memo(`poly${R}_${M}_${w}_${taps.join('_').replace(/-/g, 'n')}`, () => {
    const b = new Builder(10, 12, 4);
    b.pins('x', 'clk');
    const cnt = b.op(rateCount(k), ['clk'], `÷ ${R}`, 'cnt');
    // the branch the next edge loads is R − 1 − cnt, which in binary is every bit of cnt inverted
    const inv = b.op1(notWord(k), [`${cnt}.q`], undefined, 'branch');
    const one = b.op(TIE1, [], undefined, 'one');
    const dec = b.op(decoder(k, true), [inv, `${one}.y`], 'which branch loads', 'dec');
    // the branch that loaded at the last edge, for the products below
    const lastR = b.op(register(k), [inv, `${one}.y`, 'clk'], 'branch just loaded', 'last');
    b.next();
    const lines: string[][] = [];
    for (let p = 0; p < R; p++) {
      const row: string[] = [];
      let d = 'x';
      for (let j = 0; j < M; j++) { const r = b.op(register(w), [d, `${dec}.y${p}`, 'clk'], j === 0 ? `branch ${p}` : undefined, `l${p}_${j}`); d = `${r}.q`; row.push(d); }
      lines.push(row);
    }
    b.next();
    const products: string[] = [];
    for (let j = 0; j < M; j++) {
      const sample = b.op1(muxTree(k, w), [...lines.map((row) => row[j]), `${lastR}.q`], `word ${j} of the branch`, `sm${j}`);
      const rom = lookupRom(`poly_rom${R}_${M}_${w}_${j}_${taps.slice(0, R * M).join('_').replace(/-/g, 'n')}`, `ROM: tap ${j} of each branch`, k, w, Array.from({ length: R }, (_, p) => ((taps[p + R * j] % 2 ** w) + 2 ** w) % 2 ** w), 'The coefficient this multiplier needs for each branch.');
      const c = b.op1(rom, [`${lastR}.q`], `h[p + ${R * j}]`, `co${j}`);
      products.push(b.op1(treeMul(w, true), [sample, c], `× ${j}`, `mul${j}`));
    }
    b.next();
    const gnd = b.op(TIE0, [], undefined, 'gnd');
    let sum = b.op1(placed(2 * w, 0, W), [products[0]], undefined, 'ext0');
    for (let j = 1; j < M; j++) sum = `${b.op(rca(W), [sum, b.op1(placed(2 * w, 0, W), [products[j]], undefined, `ext${j}`), `${gnd}.y`], undefined, `sum${j}`)}.s`;
    b.next();
    // first of a group: start from 0. The last of a group, branch 0: that sum is an output.
    const acc = b.add(register(W), 'the sum so far', 'acc');
    const isFirst = b.op1(allOnes(k), [`${lastR}.q`], 'first of a group', 'first');
    const isLast = b.op1(allZero(k), [`${lastR}.q`], 'last of a group', 'lastp');
    const kept = b.op1(gateWord(W), [`${acc}.q`, b.op1(NOT, [isFirst], undefined, 'nf')], undefined, 'kept');
    b.next();
    const add = b.op(rca(W), [kept, sum, `${gnd}.y`], 'sum + this branch', 'add');
    b.wire(`${add}.s`, `${acc}.d`); b.wire(`${one}.y`, `${acc}.en`); b.wire('clk', `${acc}.clk`);
    // nothing has loaded on the first clock, so that one is not an output
    const run = b.op(register(1), [`${one}.y`, `${one}.y`, 'clk'], 'running', 'run');
    const take = b.op1(AND, [isLast, `${run}.q`], 'take it', 'take');
    const yr = b.op(register(W), [`${add}.s`, take, 'clk'], 'output', 'yr'), vr = b.op(register(1), [take, `${one}.y`, 'clk'], 'valid', 'vr');
    b.next();
    b.wire(`${yr}.q`, 'y'); b.wire(`${vr}.q`, 'valid');
    const ports = [bus('x', w, 'in'), clkPort, bus('y', W, 'out'), bit('valid', 'out')];
    return define({
      id: `poly${R}_${M}_${w}_${taps.join('_').replace(/-/g, 'n')}`, name: `Polyphase decimator (÷ ${R}, ${R * M} taps)`, category: 'arithmetic',
      summary: `${R} branches of ${M} samples each and ${M} multipliers, one branch a clock. An ordinary filter of ${R * M} taps at this clock would take ${R * M} multipliers and throw away ${R - 1} results in ${R}.`,
      ports, symbol: { kind: 'box', label: 'POLY', w: 8 }, netlist: () => built(b, ports),
    });
  });
}

/** Every bit inverted. */
function notWord(k: number): ComponentDef {
  return memo(`poly_not${k}`, () => {
    const b = new Builder(8, 8, 4);
    b.pins('a');
    const m: string[] = [];
    for (let j = 0; j < k; j++) m.push(b.op1(NOT, [b.op1(cut(k, j, 1), ['a'], undefined, `b${j}`)], undefined, `n${j}`));
    b.next();
    b.wire(b.op1(joinBits(k), m, undefined, 'm'), 'y');
    const ports = [bus('a', k, 'in'), bus('y', k, 'out')];
    return define({ id: `poly_not${k}`, name: 'Every bit inverted', category: 'gate', summary: 'R − 1 − c, when R is a power of two.', ports, symbol: { kind: 'box', label: '¬', w: 4 }, spec: ([a]) => [2 ** k - 1 - a], netlist: () => built(b, ports) });
  });
}
function joinBits(k: number): ComponentDef {
  return memo(`poly_join${k}`, () => define({
    id: `poly_join${k}`, name: `Wiring: ${k} bits into a word`, category: 'plumbing', summary: 'Only wires.',
    ports: [...Array.from({ length: k }, (_, i) => bit(`b${i}`, 'in')), bus('y', k, 'out')], symbol: { kind: 'box', label: 'join', w: 4 }, prim: 'alias',
    alias: Array.from({ length: k }, (_, i): [string, number, string, number] => [`b${i}`, 0, 'y', i]),
  }));
}
function allOnes(k: number): ComponentDef {
  return memo(`poly_ones${k}`, () => {
    const b = new Builder(8, 8, 4);
    b.pins('a');
    let acc = '';
    for (let j = 0; j < k; j++) { const c = b.op1(cut(k, j, 1), ['a'], undefined, `b${j}`); acc = acc ? b.op1(AND, [acc, c], undefined, `a${j}`) : c; }
    b.next();
    b.wire(acc, 'y');
    const ports = [bus('a', k, 'in'), bit('y', 'out')];
    return define({ id: `poly_ones${k}`, name: 'All ones?', category: 'gate', summary: 'An AND of the bits.', ports, symbol: { kind: 'box', label: '=1…', w: 4 }, spec: ([a]) => [a === 2 ** k - 1 ? 1 : 0], netlist: () => built(b, ports) });
  });
}
function allZero(k: number): ComponentDef {
  return memo(`poly_zero${k}`, () => {
    const b = new Builder(8, 8, 4);
    b.pins('a');
    let acc = '';
    for (let j = 0; j < k; j++) { const c = b.op1(NOT, [b.op1(cut(k, j, 1), ['a'], undefined, `b${j}`)], undefined, `n${j}`); acc = acc ? b.op1(AND, [acc, c], undefined, `a${j}`) : c; }
    b.next();
    b.wire(acc, 'y');
    const ports = [bus('a', k, 'in'), bit('y', 'out')];
    return define({ id: `poly_zero${k}`, name: 'All zeros?', category: 'gate', summary: 'An AND of the inverted bits.', ports, symbol: { kind: 'box', label: '=0', w: 4 }, spec: ([a]) => [a === 0 ? 1 : 0], netlist: () => built(b, ports) });
  });
}
/** A word ANDed with one bit: the sum so far, or zero to start over. */
function gateWord(w: number): ComponentDef {
  return memo(`poly_gate${w}`, () => {
    const b = new Builder(8, 8, 4);
    b.pins('a', 'en');
    const m: string[] = [];
    for (let j = 0; j < w; j++) m.push(b.op1(AND, [b.op1(cut(w, j, 1), ['a'], undefined, `b${j}`), 'en'], undefined, `a${j}`));
    b.next();
    b.wire(b.op1(joinBits(w), m, undefined, 'm'), 'y');
    const ports = [bus('a', w, 'in'), bit('en', 'in'), bus('y', w, 'out')];
    return define({ id: `poly_gate${w}`, name: 'Keep or clear', category: 'gate', summary: 'The word, or zero.', ports, symbol: { kind: 'box', label: '&', w: 4 }, spec: ([a, en]) => [en ? a : 0], netlist: () => built(b, ports) });
  });
}

/** The chapter's scene: ÷ 4 with four multipliers, 16 taps. */
export const POLY_SPEC: PolySpec = { R: 4, M: 4, w: 8, taps: polyTaps(4, 4, 8) };
