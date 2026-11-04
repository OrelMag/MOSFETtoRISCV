// Chapter 45's modem in gates: a numerically controlled oscillator (phase accumulator + sine ROM), an FSK transmitter made of
// it, a stand-in for the line (a delay of whole sample clocks and a hit input that flips a sample's sign), and an FSK
// receiver that slices the sample's sign and counts the samples between rising edges. The integer cycle models are in
// comm/modem.ts; tests/comm-modem.test.ts compares every output every cycle. Everything here is NAND gates and the
// library's flip-flops; the line part stands for the copper (phys/line.ts is the analog model of that).

import { FTW_MARK, FTW_SPACE, ACC_BITS, RX_LONG, SINE_K, SINE_TABLE, SINE_W } from '../comm/modem';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { andN, busMux2, decoder, incrementer, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { DFF, DFFE, register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });
const clk = (name = 'clk'): PortDef => bit(name, 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** A lookup table in gates: a decoder raises one word line, each output bit ORs the lines whose word has that bit set (as romArray). */
function lookupRom(id: string, name: string, k: number, w: number, data: number[], summary: string): ComponentDef {
  return memo(id, () => {
    const b = new Builder(10, 14);
    b.pins('addr');
    const dec = b.op(decoder(k), ['addr'], 'word lines');
    b.next();
    const bits = Array.from({ length: w }, (_, j) => {
      const lines = data.map((v, i) => ((v >> j) & 1 ? `${dec}.y${i}` : '')).filter(Boolean);
      return lines.length === 1 ? lines[0] : b.op1(lines.length === 2 ? OR : orN(lines.length), lines, `bit ${j}`);
    });
    b.next();
    b.wire(b.op1(merger(ones(w)), bits), 'data');
    const R = b.right;
    return define({
      id, name, category: 'memory', summary,
      ports: [bus('addr', k, 'in'), bus('data', w, 'out')],
      symbol: { kind: 'box', label: 'ROM' },
      spec: ([a]) => [data[a]],
      netlist: () => ({ pins: { addr: [0, 6], data: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** One period of a sine in 64 steps of 6-bit offset binary: the sample's top bit is its sign. */
export const SINE_ROM: ComponentDef = lookupRom('rom_sine64', 'ROM: one sine period', SINE_K, SINE_W, SINE_TABLE,
  '64 words of 6 bits: 31.5 + 31.5 · sin(2π (i + ½) / 64), rounded. The top bit is 1 for the positive half, so it is the signal\'s sign.');

/**
 * A numerically controlled oscillator: a 13-bit phase accumulator adds the tuning word at every clock; its top six bits address the
 * sine ROM. The output frequency is word · f_clk / 2^13: the word is the frequency, and it can change on any clock without a
 * glitch in the phase.
 */
export const NCO: ComponentDef = memo('nco', () => define({
  id: 'nco', name: 'NCO (phase accumulator + sine ROM)', category: 'sequential',
  summary: `A ${ACC_BITS}-bit register adds the tuning word to itself at every clock edge; the top ${SINE_K} bits look up a sine. Frequency = word · f_clk / 2^${ACC_BITS}, and changing the word changes the frequency with the phase carried on (continuous-phase).`,
  ports: [bus('ftw', ACC_BITS, 'in'), clk(), bus('s', SINE_W, 'out')],
  symbol: { kind: 'box', label: 'NCO' },
  netlist: () => {
    const b = new Builder(10, 12);
    b.pins('ftw', 'clk');
    b.op(TIE0, [], 'no carry in', 'zero');
    const add = b.op(rca(ACC_BITS), ['acc.q', 'ftw', 'zero.y'], 'phase + word', 'add');
    b.next();
    const one = b.op(TIE1, [], 'always load', 'one');
    const acc = b.op(register(ACC_BITS), [`${add}.s`, `${one}.y`, 'clk'], 'phase accumulator', 'acc');
    b.name(`${acc}.q`, 'phase', true);
    b.next();
    const sp = b.op(splitter([ACC_BITS - SINE_K, SINE_K]), [`${acc}.q`], 'top bits', 'top');
    b.next();
    b.wire(b.op1(SINE_ROM, [`${sp}.o1`], 'sine table', 'sine'), 's');
    const R = b.right;
    return { pins: { ftw: [0, 3], clk: [0, 14], s: [R, 3] }, instances: b.instances, nets: b.nets() };
  },
  hdl: {
    verilog: `always_ff @(posedge clk) acc <= acc + ftw;
assign s = sine_rom[acc[${ACC_BITS - 1}:${ACC_BITS - SINE_K}]];`,
  },
}));

/** FSK_TX: bit 0 selects the space tone's tuning word, bit 1 the mark's; the NCO does the rest. */
export const FSK_TX: ComponentDef = memo('fsk_tx', () => define({
  id: 'fsk_tx', name: 'FSK transmitter (Bell 103, originating)', category: 'sequential',
  summary: `A multiplexer picks one of two tuning words (${FTW_SPACE} and ${FTW_MARK}: 1071 Hz for a 0, 1270 Hz for a 1 at 19 200 Hz) for the NCO. The phase is never reset, so the tone changes without a jump.`,
  ports: [bit('bit', 'in'), clk(), bus('s', SINE_W, 'out')],
  symbol: { kind: 'box', label: 'FSK TX' },
  netlist: () => {
    const b = new Builder(10, 12);
    b.pins('bit', 'clk');
    const sp = b.op1(constWord(ACC_BITS, FTW_SPACE), [], `space: ${FTW_SPACE}`, 'wsp');
    const mk = b.op1(constWord(ACC_BITS, FTW_MARK), [], `mark: ${FTW_MARK}`, 'wmk');
    b.next();
    const mx = b.op1(busMux2(ACC_BITS), [sp, mk, 'bit'], 'tuning word', 'mux');
    b.next();
    b.wire(b.op1(NCO, [mx, 'clk'], 'oscillator', 'nco'), 's');
    const R = b.right;
    return { pins: { bit: [0, 3], clk: [0, 14], s: [R, 3] }, instances: b.instances, nets: b.nets() };
  },
}));

/**
 * The line, as a part (roadmap decision 3): `stages` sample clocks of delay, and a hit input that flips the sample's sign in
 * the first stage (a burst of noise or a dropout, supplied by the learner or a seeded stream). It is the one box that does
 * not stand for gates: the copper's own physics is the analog model.
 */
export function modemLine(stages: number): ComponentDef {
  return memo(`modem_line${stages}`, () => define({
    id: `modem_line${stages}`, name: `Line (${stages} clocks of delay)`, category: 'sequential',
    summary: `A stand-in for the telephone line: the sample bus delayed by ${stages} clocks, and a hit input that inverts the sample's sign bit while it is 1. In the real chain this is copper, a hybrid transformer and the exchange; opened, the stage shows that model, with the delay's registers a button away.`,
    ports: [bus('s', SINE_W, 'in'), bit('hit', 'in'), clk(), bus('y', SINE_W, 'out')],
    symbol: { kind: 'box', label: 'LINE' }, modelPanel: 'phone',
    netlist: () => {
      const b = new Builder(10, 12);
      b.pins('s', 'hit', 'clk');
      const sp = b.op(splitter([SINE_W - 1, 1]), ['s'], undefined, 'sp');
      b.next();
      const x = b.op1(XOR, [`${sp}.o1`, 'hit'], 'flip the sign', 'flip');
      b.next();
      let cur = b.op1(merger([SINE_W - 1, 1]), [`${sp}.o0`, x], undefined, 'mg');
      b.next();
      const one = b.op1(TIE1, [], 'always load', 'one');
      for (let i = 0; i < stages; i++) { cur = b.op1(register(SINE_W), [cur, one, 'clk'], `delay ${i + 1}`, `d${i}`); b.next(); }
      b.wire(cur, 'y');
      const R = b.right;
      return { pins: { s: [0, 3], hit: [0, 9], clk: [0, 14], y: [R, 3] }, instances: b.instances, nets: b.nets() };
    },
  }));
}

/**
 * FSK_RX: the sample's sign bit is the slicer. A 5-bit counter counts the clocks since the sign last rose (saturating at 31);
 * at each rising edge the decision register loads "the period was shorter than 17 clocks" (a mark) and the counter restarts at 1.
 */
export const FSK_RX: ComponentDef = memo('fsk_rx', () => define({
  id: 'fsk_rx', name: 'FSK receiver (period counter)', category: 'sequential',
  summary: `Slice the sample's sign, find its rising edges, and measure the clocks between them: ${RX_LONG} or more is the low tone (0), fewer the high tone (1). A non-coherent demodulator: it needs no carrier phase, only edges. The decision updates once per carrier cycle.`,
  ports: [bus('s', SINE_W, 'in'), clk(), bit('d', 'out'), bus('period', 5, 'out')],
  symbol: { kind: 'box', label: 'FSK RX' },
  netlist: () => {
    const b = new Builder(10, 12);
    b.pins('s', 'clk');
    const sp = b.op(splitter([SINE_W - 1, 1]), ['s'], 'sign bit', 'sp');
    b.next();
    const prev = b.op(DFF, [`${sp}.o1`, 'clk'], 'sign one clock ago', 'prev');
    const np = b.op1(NOT, [`${prev}.q`], undefined, 'np');
    b.next();
    const rise = b.name(b.op1(AND, [`${sp}.o1`, np], 'rising edge of the sign', 'rise'), 'rise', true);
    b.next();
    const inc = b.op(incrementer(5), ['cnt.q'], 'count + 1', 'inc');
    const one = b.op1(constWord(5, 1), [], 'restart at 1', 'c1');
    b.next();
    const nx = b.op1(busMux2(5), [`${inc}.y`, one, rise], 'restart on an edge', 'nx');
    const bits = b.op(splitter(ones(5)), ['cnt.q'], undefined, 'cb');
    b.next();
    const sat = b.op1(andN(5), [0, 1, 2, 3, 4].map((i) => `${bits}.o${i}`), 'saturated (31)', 'sat');
    const lo = b.op1(orN(4), [0, 1, 2, 3].map((i) => `${bits}.o${i}`), 'any of the low four', 'lo');
    b.next();
    const nsat = b.op1(NOT, [sat], undefined, 'nsat');
    const long = b.op1(AND, [`${bits}.o4`, lo], 'period ≥ 17', 'long');
    b.next();
    const en = b.op1(OR, [rise, nsat], 'count unless saturated', 'en');
    const dn = b.op1(NOT, [long], 'a short period is a mark', 'dn');
    b.next();
    const cnt = b.op(register(5), [nx, en, 'clk'], 'period counter', 'cnt');
    const dr = b.op(DFFE, [dn, rise, 'clk'], 'decision', 'dec');
    b.name(`${cnt}.q`, 'period', true);
    b.wire(`${dr}.q`, 'd');
    b.wire(`${cnt}.q`, 'period');
    const R = b.right;
    return { pins: { s: [0, 3], clk: [0, 14], d: [R, 3], period: [R, 8] }, instances: b.instances, nets: b.nets() };
  },
}));

/** The scene: transmitter → line → receiver on one clock (bit timing shared; a real modem recovers it). */
export function fskLink(lineStages = 2): ComponentDef {
  return memo(`fsk_link${lineStages}`, () => define({
    id: `fsk_link${lineStages}`, name: 'FSK modem pair', category: 'sequential',
    summary: 'An FSK transmitter, the line and an FSK receiver on one clock. The bit input is held for 64 clocks per bit (300 baud at 19 200 Hz) by the panel; hit flips a sample\'s sign on the line.',
    ports: [bit('bit', 'in'), bit('hit', 'in'), clk(), bit('d', 'out'), bus('tx', SINE_W, 'out'), bus('rxin', SINE_W, 'out')],
    symbol: { kind: 'box', label: 'MODEM' },
    netlist: () => {
      const b = new Builder(10, 14);
      b.pins('bit', 'hit', 'clk');
      const tx = b.op(FSK_TX, ['bit', 'clk'], 'transmitter', 'tx');
      b.next();
      const ln = b.op(modemLine(lineStages), [`${tx}.s`, 'hit', 'clk'], 'the line', 'line');
      b.next();
      const rx = b.op(FSK_RX, [`${ln}.y`, 'clk'], 'receiver', 'rx');
      b.wire(`${tx}.s`, 'tx');
      b.wire(`${ln}.y`, 'rxin');
      b.wire(`${rx}.d`, 'd');
      const R = b.right;
      return { pins: { bit: [0, 3], hit: [0, 9], clk: [0, 20], d: [R, 3], tx: [R, 8], rxin: [R, 13] }, instances: b.instances, nets: b.nets() };
    },
  }));
}

/** The chapter's scene root and the line, registered so the library's checks (layout, routing) see them. */
export const MODEM_LINE: ComponentDef = modemLine(2);
export const FSK_LINK: ComponentDef = fskLink(2);
