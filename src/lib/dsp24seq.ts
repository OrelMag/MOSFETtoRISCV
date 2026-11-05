// The DSP core's sequencer (chapter "A DSP core"): the PC, the jumps and the hardware loop unit.

import type { ComponentDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { andN, busMux2, equal, incrementer, rca } from './combinational';
import { define, merger } from './define';
import { AND, NOT, OR } from './gates';
import { DFFE, register } from './sequential';
import { TIE0 } from './transistors';
import { Sheet } from './dsp24draw';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);

const LOOP_PORTS: PortDef[] = [
  bus('pc', 8, 'in'), bus('pc1', 8, 'in'), bit('isloop', 'in'), bus('cnt', 16, 'in'), bus('lend', 8, 'in'), bit('halt', 'in'), bit('clk', 'in', true),
  bit('back', 'out'), bus('ls', 8, 'out'),
];

/**
 * The hardware loop: a `loop` instruction loads start (the next instruction), end and count. When the PC reaches the end of an
 * active loop and the count is not 1, the next PC is the start and the count goes down; at 1 the loop ends and the PC goes on.
 * No branch instruction, no fetch to make it happen. A loop instruction at the end of a loop starts afresh; a halt changes nothing.
 */
export const DSP24_LOOP: ComponentDef = (() => {
  // Drawn by hand (the mockup's loop unit): the registers down the left, the end test and the count test across, the go-back gate at the
  // right. Data are wires; what reaches many places (isloop, halt, the clock) or comes back (the enables) is a label.
  const S = new Sheet();
  const R8 = register(8), R16 = register(16);
  const D = 8; // the registers' column (the enable gates sit to its left)
  S.place('u0', equal(8), D + 30, 19, 'PC = end?');
  S.place('u1', constWord(16, 1), D + 22, 43, '1');
  S.place('u2', constWord(16, 0xffff), D + 22, 34, '−1');
  S.place('u3', TIE0, D + 32, 28);
  S.place('u4', rca(16), D + 30, 31, 'count − 1');
  S.place('u5', NOT, D + 44, 25);
  S.place('u6', NOT, D + 44, 29);
  S.place('u7', andN(4), D + 52, 19, 'at the end of an active loop');
  S.place('u8', equal(16), D + 30, 40, 'count = 1?');
  S.place('u9', AND, D + 62, 22, 'last pass');
  S.place('u10', NOT, D + 60, 36);
  S.place('u11', AND, D + 66, 32, 'go back');
  S.place('u12', busMux2(16), D + 50, 32, 'count: new or − 1');
  S.place('ls', R8, D + 12, 0, 'start');
  S.place('le', R8, D + 12, 20, 'end');
  S.place('u13', OR, 10, 32);
  S.place('lc', R16, D + 12, 30, 'count');
  S.place('u14', OR, 10, 12);
  S.place('la', DFFE, D + 12, 10, 'active');
  const nets: NetDef[] = [
    { name: 'pc', ends: ['pc', 'u0.a'], via: { 'u0.a': [[D + 26, 18], [D + 26, 21]] } },
    { ends: ['u2.y', 'u4.b'] },
    { ends: ['u3.y', 'u4.cin'] },
    { name: 'isloop', ends: ['isloop', 'u5.a', 'u12.s', 'ls.en', 'le.en', 'u13.a', 'u14.a', 'la.d'], tags: true },
    { name: 'halt', ends: ['halt', 'u6.a'], tags: true },
    { ends: ['u0.eq', 'u7.i1'] },
    { ends: ['u5.y', 'u7.i2'] },
    { ends: ['u6.y', 'u7.i3'] },
    { ends: ['u1.y', 'u8.b'] },
    { name: 'atEnd', ends: ['u7.y', 'u9.a', 'u11.a', 'u13.b'], tags: ['u13.b'] },
    { ends: ['u8.eq', 'u9.b', 'u10.a'] },
    { ends: ['u10.y', 'u11.b'] },
    { ends: ['u4.s', 'u12.a'] },
    { name: 'cnt', ends: ['cnt', 'u12.b'], via: { 'u12.b': [[D + 48, 38], [D + 48, 36]] } },
    { name: 'pc1', ends: ['pc1', 'ls.d'] },
    { name: 'clk', ends: ['clk', 'ls.clk', 'le.clk', 'lc.clk', 'la.clk'], tags: true },
    { name: 'lend', ends: ['lend', 'le.d'] },
    { ends: ['u12.y', 'lc.d'], via: { 'lc.d': [[D + 58, 35], [D + 58, 52], [D + 8, 52], [D + 8, 32]] } },
    { ends: ['u13.y', 'lc.en'] },
    { ends: ['u9.y', 'u14.b'], tags: true },
    { ends: ['u14.y', 'la.en'] },
    { name: 'le', ends: ['le.q', 'u0.b'] },
    { name: 'lc', ends: ['lc.q', 'u4.a', 'u8.a'], trunk: D + 21 },
    { name: 'la', ends: ['la.q', 'u7.i0'], via: { 'u7.i0': [[D + 40, 13], [D + 40, 20]] } },
    { name: 'ls', ends: ['ls.q', 'ls'] },
    { ends: ['u11.y', 'back'] },
  ];
  return define({
    id: 'dsp24_loop', name: 'Loop unit (DSP core)', category: 'cpu',
    summary: 'Start, end and count registers and an active flag. At the end address of an active loop the next PC is the start, the count goes down, and at 1 the loop is over. This is how a tap costs one clock: the loop adds no instruction.',
    ports: LOOP_PORTS,
    symbol: { kind: 'box', label: 'LOOP' },
    netlist: () => ({
      pins: { pc1: [0, 2], isloop: [0, 5], halt: [0, 8], pc: [0, 18], lend: [0, 22], cnt: [0, 38], clk: [0, 48], back: [D + 84, 35], ls: [D + 84, 3] },
      instances: S.instances(), nets,
    }),
  });
})();

const SEQ_PORTS: PortDef[] = [
  bit('halt', 'in'), bit('jmp', 'in'), bit('jz', 'in'), bit('jnz', 'in'), bus('qa', 16, 'in'), bus('addr', 8, 'in'),
  bit('isloop', 'in'), bit('lreg', 'in'), bus('cnt', 10, 'in'), bus('lend', 8, 'in'), bit('clk', 'in', true),
  bus('pc', 8, 'out'),
];

/** The sequencer: PC, PC + 1, the jumps (jmp, jz, jnz on a register) and the loop unit, whose go-back wins over a jump. */
export const DSP24_SEQ: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('halt', 'jmp', 'jz', 'jnz', 'qa', 'addr', 'isloop', 'lreg', 'cnt', 'lend', 'clk');
  const inc = b.op(incrementer(8), [''], 'PC + 1');
  const z = b.op1(isZero(16), ['qa'], 'register = 0?');
  const cnt16 = b.op1(merger([10, 6], 2), ['cnt', b.op1(constWord(6, 0), [])], 'count, 10 bits');
  const nh = b.op1(NOT, ['halt']);
  b.next();
  const take = b.name(b.op1(orN(3), ['jmp', b.op1(AND, ['jz', z], 'jz taken'), b.op1(AND, ['jnz', b.op1(NOT, [z])], 'jnz taken')], 'jump taken'), 'take', true);
  const cnt = b.op1(busMux2(16), [cnt16, 'qa', 'lreg'], 'count: constant or register');
  b.next();
  const lp = b.op(DSP24_LOOP, ['', `${inc}.y`, 'isloop', cnt, 'lend', 'halt', 'clk'], 'Loop unit', 'loop');
  const m1 = b.op1(busMux2(8), [`${inc}.y`, 'addr', take], 'PC + 1 or the jump');
  b.next();
  const nxt = b.op1(busMux2(8), [m1, `${lp}.ls`, `${lp}.back`], 'the loop wins');
  b.next();
  const pc = b.name(b.op1(register(8), [nxt, nh, 'clk'], 'PC', 'pc'), 'pcv', true);
  b.wire(pc, `${inc}.a`);
  b.wire(pc, `${lp}.pc`);
  b.wire(pc, 'pc');
  const R = b.right;
  return define({
    id: 'dsp24_seq', name: 'Sequencer (DSP core)', category: 'cpu',
    summary: 'The PC with PC + 1, jmp / jz / jnz, and the loop unit: at a loop\'s end address the next PC is the loop start, ahead of any jump. A halt keeps the PC where it is.',
    ports: SEQ_PORTS,
    symbol: { kind: 'box', label: 'SEQUENCER' },
    netlist: () => ({ pins: { ...pinsAt(ins(SEQ_PORTS), 0, 4), pc: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();
