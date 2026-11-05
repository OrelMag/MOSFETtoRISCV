// The DSP core's address generator (chapter "A DSP core"): the step of one pointer, and the generator with its four pointers, window and
// modifier. dsp/iss24.ts aguStep is the specification.

import { aguStep } from '../dsp/iss24';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, reverseWire } from './alu';
import { Builder } from './builder';
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
  const b = new Builder(16, 12, 4);
  b.pins('sel', 'mode', 'act', 'we', 'wsel', 'wd', 'rsel', 'clk');
  const sd = b.op(decoder(2), ['sel'], 'which pointer');
  const wd = b.op(decoder(3, true), ['wsel', 'we'], 'write enable of one');
  const sm = b.op(splitter(ones(3), 2), ['mode']);
  const nz = b.name(b.op1(AND, [b.op1(orN(3), [`${sm}.o0`, `${sm}.o1`, `${sm}.o2`], 'mode ≠ 0'), 'act'], 'steps'), 'steps', true);
  b.next();
  const en: string[] = [];
  for (let i = 0; i < 4; i++) en.push(b.name(b.op1(OR, [`${wd}.y${i}`, b.op1(AND, [nz, `${sd}.y${i}`])], `enable p${i}`), `en${i}`, true));
  const next = b.op(busMux2(8), ['', 'wd', 'we'], 'step or written value');
  b.next();
  const p = [0, 1, 2, 3].map((i) => b.name(b.op1(register(8), [`${next}.y`, en[i], 'clk'], `p${i}`, `p${i}`), `P${i}`, true));
  const base = b.name(b.op1(register(8), ['wd', `${wd}.y4`, 'clk'], 'base', 'base'), 'base', true);
  const len = b.name(b.op1(register(8), ['wd', `${wd}.y5`, 'clk'], 'length', 'len'), 'len', true);
  const mod = b.name(b.op1(register(8), ['wd', `${wd}.y6`, 'clk'], 'modifier', 'mod'), 'mod', true);
  b.next();
  const a = b.name(b.op1(muxTree(2, 8), [...p, 'sel'], 'address'), 'a0', true);
  const q = b.op1(muxTree(3, 8), [...p, base, len, mod, b.op1(constWord(8, 0), [], '0'), 'rsel'], 'read a register');
  b.next();
  const step = b.op(DSP24_AGU_STEP, [a, 'mode', base, len, mod], 'next pointer');
  b.wire(`${step}.y`, `${next}.a`);
  b.wire(a, 'a');
  b.wire(q, 'q');
  const R = b.right;
  return define({
    id: 'dsp24_agu', name: 'Address generator (DSP core)', category: 'cpu',
    summary: 'Four 8-bit pointers with a circular window (base, length) and a modifier. The address is the pointer an instruction names; after the access it steps by its mode in the same clock: +1, −1, +m, −m, round the window, or bit-reversed.',
    ports: AGU_PORTS,
    symbol: { kind: 'box', label: 'AGU' },
    netlist: () => ({ pins: { ...pinsAt(ins(AGU_PORTS), 0, 4), a: [R, 8], q: [R, 16] }, instances: b.instances, nets: b.nets() }),
  });
})();
