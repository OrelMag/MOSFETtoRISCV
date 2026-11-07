// The DSP core's address generator (chapter "A DSP core"): the step of one pointer, and the generator with its four pointers, window and
// modifier. dsp/iss24.ts aguStep is the specification.

import { aguStep } from '../dsp/iss24';
import type { ComponentDef, NetDef, PortDef } from '../sim/types';
import { constWord, reverseWire } from './alu';
import { Builder } from './builder';
import { Sheet } from './dsp24draw';
import { busMux2, decoder, equal, muxTree, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, OR } from './gates';
import { register } from './sequential';
import { TIE0 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);

const STEP_PORTS: PortDef[] = [bus('p', 8, 'in'), bus('mode', 3, 'in'), bus('base', 8, 'in'), bus('len', 8, 'in'), bus('m', 8, 'in'), bus('y', 8, 'out')];

/** One pointer's next value after an access. */
export const DSP24_AGU_STEP: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('p', 'mode', 'base', 'len', 'm');
  const md = b.op(decoder(3), ['mode'], 'which mode');
  const Y = (i: number) => b.name(`${md}.y${i}`, `m${i}`, true);
  const [y0, y2, y3, y4, y5, y6, y7] = [0, 2, 3, 4, 5, 6, 7].map(Y);
  const isM = b.op1(OR, [y3, y7], 'step is m');
  const neg = b.name(b.op1(orN(3), [y2, y5, y7], 'step is negative'), 'neg', true);
  const negw = b.op1(merger(ones(8), 2), Array(8).fill(neg), 'neg × 8');
  const one = b.op1(constWord(8, 1), [], '1');
  b.next();
  const stepv = b.op1(busMux2(8), [one, 'm', isM], '1 or m');
  const rp = b.op1(reverseWire(8), ['p'], 'bit-reversed p');
  const rm = b.op1(reverseWire(8), ['m'], 'bit-reversed m');
  const e0 = b.op(rca(8), ['base', 'len', b.op1(TIE0, [])], 'end = base + len');
  b.next();
  const sx = b.op1(bitwise('xor', 8), [stepv, negw], 'step or ¬step');
  const em1 = b.op(rca(8), [`${e0}.s`, b.op1(constWord(8, 255), []), b.op1(TIE0, [])], 'end − 1');
  const rs = b.op(rca(8), [rp, rm, b.op1(TIE0, [])], 'reverse-carry add');
  b.next();
  const t = b.name(`${b.op(rca(8), ['p', sx, neg], 'p ± step')}.s`, 't', true);
  const pr = b.op1(reverseWire(8), [`${rs}.s`], 'reversed back');
  b.next();
  const eqT = b.op1(equal(8), [t, `${e0}.s`], 'next = end?');
  const eqP = b.op1(equal(8), ['p', 'base'], 'p = base?');
  b.next();
  const hit = b.op1(OR, [b.op1(AND, [y4, eqT]), b.op1(AND, [y5, eqP])], 'at the window edge');
  const wrapv = b.op1(busMux2(8), ['base', `${em1}.s`, y5], 'base, or end − 1');
  b.next();
  const cres = b.op1(busMux2(8), [t, wrapv, hit], 'step or wrap');
  b.next();
  const r1 = b.op1(busMux2(8), [cres, 'p', y0], 'mode 0: stay');
  b.next();
  b.wire(b.op1(busMux2(8), [r1, pr, y6], 'mode 6: bit-reversed'), 'y');
  const R = b.right;
  return define({
    id: 'dsp24_agu_step', name: 'Address step (DSP core)', category: 'cpu',
    summary: 'The next value of a pointer after an access: +1, −1, +m or −m (one 8-bit adder, the step inverted for a minus), the same wrapping at the edge of a circular window (base, length) by comparing with the window end, or a bit-reversed step (reverse the bits, add the reversed modifier, reverse back).',
    ports: STEP_PORTS,
    symbol: { kind: 'box', label: 'STEP' },
    spec: ([p, mode, base, len, m]) => [aguStep(p, mode, base, len, m)],
    netlist: () => ({ pins: { ...pinsAt(ins(STEP_PORTS), 0, 4), y: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

const AGU_PORTS: PortDef[] = [
  bus('sel', 2, 'in'), bus('mode', 3, 'in'), bit('act', 'in'), bit('we', 'in'), bus('wsel', 3, 'in'), bus('wd', 8, 'in'), bus('rsel', 3, 'in'), bit('clk', 'in', true),
  bus('a', 8, 'out'), bus('q', 8, 'out'),
];

/**
 * An address generator: four pointers, a window base and length and a modifier (each an 8-bit register). The pointer `sel` names
 * is the address (a); when the instruction accesses the memory (act) with a mode other than 0 the pointer takes its next
 * value at the clock edge. we writes wd into the register wsel names (0 to 3 the pointers, 4 base, 5 length, 6 modifier); q reads rsel's.
 */
export const DSP24_AGU: ComponentDef = (() => {
  // Drawn by hand (the mockup's AGU), on a 14-unit row pitch: the seven registers (p0..p3, base, length, modifier) in one column, each
  // with its own row; the read multiplexer (8:1, pitch 14) has an input on every register row, so those seven wires run straight. The
  // address multiplexer and the STEP block sit in the gaps between two of those rows and take their inputs from short taps, so each
  // crosses only the rows between. The write enables come from the left (pointer select, then the steps AND, then the OR), the
  // decoder of the register index from below. What reaches many places (sel, we, mode, wd, steps, the clock) and the new pointer coming
  // back from STEP are labels.
  const S = new Sheet();
  const P = 14; // row pitch
  const R = (i: number) => 16 + P * i;              // the q row of p0..p3, base, length, modifier (i = 0..6)
  const RX = 70;                                    // the registers' column
  const XG = 30, XO = 48;                           // the AND and the OR of each pointer's enable
  const XD = 62;                                    // the trunk that carries the next pointer to the four d pins
  const XU = 112;                                   // the read multiplexer
  // above: which mode steps
  S.place('u2', splitter(ones(3), 2), 24, 2);
  S.place('u3', orN(3), 30, 2, 'mode ≠ 0');
  S.place('u4', AND, 40, 3, 'steps');
  // pointer select (pitch 14: y_i on the AND's b row) and the steps / enable gates
  S.alignY('u0', decoder(2, false, P), 14, 'y0', R(0) + 1, 'which pointer');
  const gates = [0, 1, 2, 3].map((i) => {
    const a = `u${5 + 2 * i}`, o = `u${6 + 2 * i}`;
    S.alignY(a, AND, XG, 'y', R(i));
    S.alignY(o, OR, XO, 'y', R(i) + 1, `enable p${i}`);
    return [a, o];
  });
  // register-index decoder (below, compact): its outputs climb to the ORs and to the enables of base, length, modifier
  S.place('u1', decoder(3, true), 14, R(6) + P + 2, 'write enable of one');
  S.alignY('u13', busMux2(8), 54, 'y', 4, 'step or written value');
  const R8 = register(8);
  for (let i = 0; i < 4; i++) S.place(`p${i}`, R8, RX, R(i) - 3, `p${i}`);
  S.place('base', R8, RX, R(4) - 3, 'base');
  S.place('len', R8, RX, R(5) - 3, 'length');
  S.place('mod', R8, RX, R(6) - 3, 'modifier');
  // address multiplexer: in the gap between the p1 and p2 rows; STEP in the gap between base and length
  S.place('u14', muxTree(2, 8), 88, R(1) + 2, 'address');
  S.place('u17', DSP24_AGU_STEP, 96, R(4) + 1, 'next pointer');
  S.alignY('u16', muxTree(3, 8, P), XU, 'd0', R(0), 'read a register');
  S.alignY('u15', constWord(8, 0), 104, 'y', R(6) + P, '0');
  const tx = [85, 83, 81, 84];                      // the taps of p0..p3 to the address multiplexer
  const tap = (i: number): [number, number][] => [[tx[i], R(i)], [tx[i], S.P('u14', `d${i}`)[1]]];
  const V = (...p: [number, number][]) => p;
  const nets: NetDef[] = [
    { name: 'sel', ends: ['sel', 'u0.a', 'u14.s'], tags: true },
    { name: 'wsel', ends: ['wsel', 'u1.a'], tags: true },
    { name: 'we', ends: ['we', 'u1.en', 'u13.s'], tags: true },
    { name: 'mode', ends: ['mode', 'u2.in', 'u17.mode'], tags: true },
    { ends: ['u2.o0', 'u3.i0'] }, { ends: ['u2.o1', 'u3.i1'] }, { ends: ['u2.o2', 'u3.i2'] },
    { ends: ['u3.y', 'u4.a'] },
    { name: 'act', ends: ['act', 'u4.b'], tags: true },
    { name: 'steps', ends: ['u4.y', ...gates.map(([a]) => `${a}.a`)], tags: true },
    ...gates.flatMap(([a, o], i) => {
      const xt = 36 + 1.5 * i, s = S.P('u1', `y${i}`)[1];
      return [
        { ends: [`u0.y${i}`, `${a}.b`] },
        { ends: [`u1.y${i}`, `${o}.b`], via: { [`${o}.b`]: V([xt, s], [xt, R(i) + 2]) } },
        { ends: [`${a}.y`, `${o}.a`] },
      ];
    }),
    { name: 'wd', ends: ['wd', 'u13.b', 'base.d', 'len.d', 'mod.d'], tags: true },
    { ends: ['u13.y', 'p0.d', 'p1.d', 'p2.d', 'p3.d'], trunk: XD },
    ...[0, 1, 2, 3].map((i) => ({ name: `en${i}`, ends: [`${gates[i][1]}.y`, `p${i}.en`] })),
    { name: 'clk', ends: ['clk', 'p0.clk', 'p1.clk', 'p2.clk', 'p3.clk', 'base.clk', 'len.clk', 'mod.clk'], tags: true },
    ...[4, 5, 6].map((i) => {
      const xt = 36 + 1.5 * i, s = S.P('u1', `y${i}`)[1], e = ['base', 'len', 'mod'][i - 4];
      return { ends: [`u1.y${i}`, `${e}.en`], via: { [`${e}.en`]: V([xt, s], [xt, R(i) + 1]) } };
    }),
    ...[0, 1, 2, 3].map((i) => ({ name: `P${i}`, ends: [`p${i}.q`, `u16.d${i}`, `u14.d${i}`], via: { [`u14.d${i}`]: tap(i) } })),
    { name: 'base', ends: ['base.q', 'u16.d4', 'u17.base'], via: { 'u17.base': V([82, R(4)], [82, S.P('u17', 'base')[1]]) } },
    { name: 'len', ends: ['len.q', 'u16.d5', 'u17.len'], via: { 'u17.len': V([84, R(5)], [84, S.P('u17', 'len')[1]]) } },
    { name: 'mod', ends: ['mod.q', 'u16.d6', 'u17.m'], via: { 'u17.m': V([86, R(6)], [86, S.P('u17', 'm')[1]]) } },
    { ends: ['u15.y', 'u16.d7'] },
    { name: 'rsel', ends: ['rsel', 'u16.s'], tags: true },
    { name: 'a0', ends: ['u14.y', 'u17.p', 'a'], via: { 'u17.p': [[94, S.P('u14', 'y')[1]], [94, S.P('u17', 'p')[1]]], a: [[94, S.P('u14', 'y')[1]], [94, 8], [XU + 16, 8]] } },
    { name: 'next', ends: ['u17.y', 'u13.a'], tags: true },
    { ends: ['u16.y', 'q'] },
  ];
  return define({
    id: 'dsp24_agu', name: 'Address generator (DSP core)', category: 'cpu',
    summary: 'Four 8-bit pointers with a circular window (base, length) and a modifier. The address is the pointer an instruction names; after the access it steps by its mode in the same clock: +1, −1, +m, −m, round the window, or bit-reversed.',
    ports: AGU_PORTS,
    symbol: { kind: 'box', label: 'AGU' },
    netlist: () => ({
      pins: { sel: [0, 12], mode: [0, 4], act: [0, 8], we: [0, 24], wsel: [0, 20], wd: [0, 28], rsel: [0, 32], clk: [0, 36], a: [XU + 16, 8], q: [XU + 16, S.P('u16', 'y')[1]] },
      instances: S.instances(), nets,
    }),
  });
})();
