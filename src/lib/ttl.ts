// Appendix C's 74xx chips (Ben Eater's breadboard computer): each a library part built from our gates, with the logic
// of its TI datasheet, so the drill goes module → chip → flip-flop → NAND → MOSFET. The real chips are bipolar TTL; here
// their logic is CMOS NANDs (the chapter says so once). Every 3-state output (the 173's Q, the 245's B, the 189's
// outputs) is modelled as value AND enable: a disabled output reads 0, as on a bus with pull-downs, and the computer's
// bus is the OR of its drivers (docs/SAP.md). Buses group a chip's pins (A1–A4 → a[0..3]); TTL_PINS maps every DIP
// pin to its port bit (the breadboard view and the chip's pin card).

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { wordsHash, romLevels, type RomLeaf } from './bigmem';
import { Builder } from './builder';
import { andN, busMux2, decoder, muxTree, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOR, NOT, OR, XOR } from './gates';
import { NAND } from './transistors';
import { D_LATCH } from './sequential';
import { DFF_R, NAND3 } from './seqparts';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);
const outs = (ps: PortDef[]) => ps.filter((p) => p.dir === 'out').map((p) => p.name);
const bitOf = (v: number, i: number) => (v >> i) & 1;

/** A Builder netlist with the component's inputs on the left and outputs on the right. */
function built(b: Builder, ports: PortDef[], step = 4) {
  const R = b.right;
  return () => ({ pins: { ...pinsAt(ins(ports), 0, step), ...pinsAt(outs(ports), R, step) }, instances: b.instances, nets: b.nets() });
}

// ---- DIP pinouts ---------------------------------------------------------------------------------------------------

/** One DIP pin: its datasheet name and the port bit it is (none: VCC, GND, or a pin that is not simulated). */
export interface TtlPin { name: string; port?: string; bit?: number }

const P = (name: string, port?: string, b = 0): TtlPin => (port ? { name, port, bit: b } : { name });
const VCC = P('VCC'), GND = P('GND');

/** Quad 2-input gates (00, 08, 32, 86): 1A 1B 1Y 2A 2B 2Y GND 3Y 3A 3B 4Y 4A 4B VCC. */
const QUAD_PINS: TtlPin[] = [
  P('1A', 'a', 0), P('1B', 'b', 0), P('1Y', 'y', 0), P('2A', 'a', 1), P('2B', 'b', 1), P('2Y', 'y', 1), GND,
  P('3Y', 'y', 2), P('3A', 'a', 2), P('3B', 'b', 2), P('4Y', 'y', 3), P('4A', 'a', 3), P('4B', 'b', 3), VCC,
];

/**
 * Every chip's pins, by TTL_PINS key (ttlKind(def)): index n − 1 is DIP pin n. Pin 1 is top left beside the notch,
 * counted down the left side and up the right (the last pin, VCC on all but the 555, top right).
 */
export const TTL_PINS: Record<string, TtlPin[]> = {
  ls00: QUAD_PINS, ls08: QUAD_PINS, ls32: QUAD_PINS, ls86: QUAD_PINS,
  ls02: [
    P('1Y', 'y', 0), P('1A', 'a', 0), P('1B', 'b', 0), P('2Y', 'y', 1), P('2A', 'a', 1), P('2B', 'b', 1), GND,
    P('3A', 'a', 2), P('3B', 'b', 2), P('3Y', 'y', 2), P('4A', 'a', 3), P('4B', 'b', 3), P('4Y', 'y', 3), VCC,
  ],
  ls04: [
    P('1A', 'a', 0), P('1Y', 'y', 0), P('2A', 'a', 1), P('2Y', 'y', 1), P('3A', 'a', 2), P('3Y', 'y', 2), GND,
    P('4Y', 'y', 3), P('4A', 'a', 3), P('5Y', 'y', 4), P('5A', 'a', 4), P('6Y', 'y', 5), P('6A', 'a', 5), VCC,
  ],
  ls138: [
    P('A', 'a', 0), P('B', 'a', 1), P('C', 'a', 2), P('G2A', 'g2a_n'), P('G2B', 'g2b_n'), P('G1', 'g1'), P('Y7', 'y_n', 7), GND,
    P('Y6', 'y_n', 6), P('Y5', 'y_n', 5), P('Y4', 'y_n', 4), P('Y3', 'y_n', 3), P('Y2', 'y_n', 2), P('Y1', 'y_n', 1), P('Y0', 'y_n', 0), VCC,
  ],
  ls139: [
    P('1G', 'g1_n'), P('1A', 'a1', 0), P('1B', 'a1', 1), P('1Y0', 'y1_n', 0), P('1Y1', 'y1_n', 1), P('1Y2', 'y1_n', 2), P('1Y3', 'y1_n', 3), GND,
    P('2Y3', 'y2_n', 3), P('2Y2', 'y2_n', 2), P('2Y1', 'y2_n', 1), P('2Y0', 'y2_n', 0), P('2B', 'a2', 1), P('2A', 'a2', 0), P('2G', 'g2_n'), VCC,
  ],
  ls157: [
    P('A/B', 's'), P('1A', 'a', 0), P('1B', 'b', 0), P('1Y', 'y', 0), P('2A', 'a', 1), P('2B', 'b', 1), P('2Y', 'y', 1), GND,
    P('3Y', 'y', 2), P('3B', 'b', 2), P('3A', 'a', 2), P('4Y', 'y', 3), P('4B', 'b', 3), P('4A', 'a', 3), P('G', 'g_n'), VCC,
  ],
  ls161: [
    P('CLR', 'clr_n'), P('CLK', 'clk'), P('A', 'd', 0), P('B', 'd', 1), P('C', 'd', 2), P('D', 'd', 3), P('ENP', 'enp'), GND,
    P('LOAD', 'load_n'), P('ENT', 'ent'), P('QD', 'q', 3), P('QC', 'q', 2), P('QB', 'q', 1), P('QA', 'q', 0), P('RCO', 'rco'), VCC,
  ],
  ls173: [
    P('M', 'm'), P('N', 'n'), P('1Q', 'q', 0), P('2Q', 'q', 1), P('3Q', 'q', 2), P('4Q', 'q', 3), P('CLK', 'clk'), GND,
    P('G1', 'g1_n'), P('G2', 'g2_n'), P('4D', 'd', 3), P('3D', 'd', 2), P('2D', 'd', 1), P('1D', 'd', 0), P('CLR', 'clr'), VCC,
  ],
  ls189: [
    P('A0', 'a', 0), P('ME', 'cs_n'), P('WE', 'we_n'), P('D1', 'd', 0), P('Q1', 'q_n', 0), P('D2', 'd', 1), P('Q2', 'q_n', 1), GND,
    P('Q3', 'q_n', 2), P('D3', 'd', 2), P('Q4', 'q_n', 3), P('D4', 'd', 3), P('A3', 'a', 3), P('A2', 'a', 2), P('A1', 'a', 1), VCC,
  ],
  ls245: [
    P('DIR', 'dir'), P('A1', 'a', 0), P('A2', 'a', 1), P('A3', 'a', 2), P('A4', 'a', 3), P('A5', 'a', 4), P('A6', 'a', 5), P('A7', 'a', 6),
    P('A8', 'a', 7), GND, P('B8', 'b', 7), P('B7', 'b', 6), P('B6', 'b', 5), P('B5', 'b', 4), P('B4', 'b', 3), P('B3', 'b', 2),
    P('B2', 'b', 1), P('B1', 'b', 0), P('G', 'oe_n'), VCC,
  ],
  ls273: [
    P('CLR', 'clr_n'), P('1Q', 'q', 0), P('1D', 'd', 0), P('2D', 'd', 1), P('2Q', 'q', 1), P('3Q', 'q', 2), P('3D', 'd', 2), P('4D', 'd', 3),
    P('4Q', 'q', 3), GND, P('CLK', 'clk'), P('5Q', 'q', 4), P('5D', 'd', 4), P('6D', 'd', 5), P('6Q', 'q', 5), P('7Q', 'q', 6),
    P('7D', 'd', 6), P('8D', 'd', 7), P('8Q', 'q', 7), VCC,
  ],
  ls283: [
    P('Σ2', 's', 1), P('B2', 'b', 1), P('A2', 'a', 1), P('Σ1', 's', 0), P('A1', 'a', 0), P('B1', 'b', 0), P('C0', 'c0'), GND,
    P('C4', 'c4'), P('Σ4', 's', 3), P('B4', 'b', 3), P('A4', 'a', 3), P('Σ3', 's', 2), P('A3', 'a', 2), P('B3', 'b', 2), VCC,
  ],
  ls76: [
    P('1CLK', 'clk1'), P('1PRE', 'pre1_n'), P('1CLR', 'clr1_n'), P('1J', 'j1'), VCC, P('2CLK', 'clk2'), P('2PRE', 'pre2_n'), P('2CLR', 'clr2_n'),
    P('2J', 'j2'), P('2Q', 'q2_n'), P('2Q', 'q2'), P('2K', 'k2'), GND, P('1Q', 'q1_n'), P('1Q', 'q1'), P('1K', 'k1'),
  ],
  at28c16: [
    P('A7', 'addr', 7), P('A6', 'addr', 6), P('A5', 'addr', 5), P('A4', 'addr', 4), P('A3', 'addr', 3), P('A2', 'addr', 2),
    P('A1', 'addr', 1), P('A0', 'addr', 0), P('I/O0', 'data', 0), P('I/O1', 'data', 1), P('I/O2', 'data', 2), GND,
    P('I/O3', 'data', 3), P('I/O4', 'data', 4), P('I/O5', 'data', 5), P('I/O6', 'data', 6), P('I/O7', 'data', 7), P('CE', 'ce_n'),
    P('A10', 'addr', 10), P('OE', 'oe_n'), P('WE', 'we_n'), P('A9', 'addr', 9), P('A8', 'addr', 8), VCC,
  ],
  ne555: [GND, P('TRIG'), P('OUT'), P('RESET'), P('CTRL'), P('THR'), P('DIS'), VCC],
};

/** Overbars the datasheets draw (active-low pins), by key: their names as in TTL_PINS. */
export const TTL_ACTIVE_LOW: Record<string, string[]> = {
  ls138: ['G2A', 'G2B', 'Y0', 'Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'Y7'], ls139: ['1G', '2G', '1Y0', '1Y1', '1Y2', '1Y3', '2Y0', '2Y1', '2Y2', '2Y3'],
  ls157: ['G'], ls161: ['CLR', 'LOAD'], ls173: ['G1', 'G2'], ls189: ['ME', 'WE', 'Q1', 'Q2', 'Q3', 'Q4'], ls245: ['G'], ls273: ['CLR'],
  ls76: ['1PRE', '1CLR', '2PRE', '2CLR'], at28c16: ['CE', 'OE', 'WE'], ne555: ['RESET'],
};

/** The 74xx part numbers as printed on the package, by key. */
export const TTL_PART: Record<string, string> = {
  ls00: '74LS00', ls02: '74LS02', ls04: '74LS04', ls08: '74LS08', ls32: '74LS32', ls86: '74LS86', ls138: '74LS138', ls139: '74LS139',
  ls157: '74LS157', ls161: '74LS161', ls173: '74LS173', ls189: '74LS189', ls245: '74LS245', ls273: '74LS273', ls283: '74LS283',
  ls76: '74LS76', at28c16: '28C16', ne555: 'NE555',
};

/** A chip's TTL_PINS key (an EEPROM of any contents is 'at28c16'), or null for a part that is not one of these chips. */
export function ttlKind(d: ComponentDef): string | null {
  if (d.id.startsWith('at28c16_')) return 'at28c16';
  if (d.id.startsWith('ls189_i')) return 'ls189';
  return d.id in TTL_PINS ? d.id : null;
}

// ---- gate packages -------------------------------------------------------------------------------------------------

function quad(id: string, part: string, g: ComponentDef, f: (a: number, b: number) => number, what: string): ComponentDef {
  const n = 4, Pt = 6;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), Pt), at: [4, 0] },
    { name: 'sb', def: splitter(ones(n), Pt), at: [7, 2] },
    { name: 'my', def: merger(ones(n), Pt), at: [17, 1] },
  ];
  const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] }, { name: 'y', ends: ['my.out', 'y'] }];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `g${i + 1}`, def: g, at: [10, 2 + Pt * i] });
    nets.push({ ends: [`sa.o${i}`, `g${i + 1}.a`] }, { ends: [`sb.o${i}`, `g${i + 1}.b`] }, { ends: [`g${i + 1}.y`, `my.i${i}`] });
  }
  return define({
    id, name: `${part} quad 2-input ${what}`, category: 'ttl',
    summary: `Four independent 2-input ${what} gates in one 14-pin package: bit i of y depends only on bits i of a and b.`,
    ports: [bus('a', 4, 'in'), bus('b', 4, 'in'), bus('y', 4, 'out')],
    symbol: { kind: 'box', label: part },
    spec: ([a, b]) => [f(a, b) & 15],
    netlist: () => ({ pins: { a: [0, 12], b: [0, 16], y: [24, 13] }, instances, nets }),
  });
}

export const LS00 = quad('ls00', '74LS00', NAND, (a, b) => ~(a & b), 'NAND');
export const LS02 = quad('ls02', '74LS02', NOR, (a, b) => ~(a | b), 'NOR');
export const LS08 = quad('ls08', '74LS08', AND, (a, b) => a & b, 'AND');
export const LS32 = quad('ls32', '74LS32', OR, (a, b) => a | b, 'OR');
export const LS86 = quad('ls86', '74LS86', XOR, (a, b) => a ^ b, 'XOR');

export const LS04: ComponentDef = (() => {
  const n = 6, Pt = 4;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), Pt), at: [4, 0] },
    { name: 'my', def: merger(ones(n), Pt), at: [16, 0] },
  ];
  const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'y', ends: ['my.out', 'y'] }];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `g${i + 1}`, def: NOT, at: [9, 1 + Pt * i] });
    nets.push({ ends: [`sa.o${i}`, `g${i + 1}.a`] }, { ends: [`g${i + 1}.y`, `my.i${i}`] });
  }
  return define({
    id: 'ls04', name: '74LS04 hex inverter', category: 'ttl',
    summary: 'Six independent inverters in one 14-pin package. The modules use them where a chip pin is active low.',
    ports: [bus('a', 6, 'in'), bus('y', 6, 'out')],
    symbol: { kind: 'box', label: '74LS04' },
    spec: ([a]) => [~a & 63],
    netlist: () => ({ pins: { a: [0, 12], y: [22, 12] }, instances, nets }),
  });
})();

// ---- decoders and multiplexers -------------------------------------------------------------------------------------

const LS138_PORTS: PortDef[] = [bus('a', 3, 'in'), bit('g1', 'in'), bit('g2a_n', 'in'), bit('g2b_n', 'in'), bus('y_n', 8, 'out')];

export const LS138: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(LS138_PORTS));
  const n2a = b.op1(NOT, ['g2a_n']), n2b = b.op1(NOT, ['g2b_n']);
  b.next();
  const en = b.name(b.op1(andN(3), ['g1', n2a, n2b], 'G1 · ¬G2A · ¬G2B'), 'en', true);
  b.next();
  const dec = b.op(decoder(3, true), ['a', en], '3 → 8');
  b.next();
  const inv = Array.from({ length: 8 }, (_, i) => b.op1(NOT, [`${dec}.y${i}`]));
  b.next();
  b.wire(b.op1(merger(ones(8), 4), inv), 'y_n');
  return define({
    id: 'ls138', name: '74LS138 3-to-8 decoder', category: 'ttl',
    summary: 'One of eight outputs goes low: the one the 3-bit input names, while G1 = 1 and G2A = G2B = 0. The step decoder of the control unit.',
    ports: LS138_PORTS,
    symbol: { kind: 'box', label: '74LS138' },
    spec: ([a, g1, g2a, g2b]) => [g1 && !g2a && !g2b ? ~(1 << a) & 255 : 255],
    netlist: built(b, LS138_PORTS),
  });
})();

const LS139_PORTS: PortDef[] = [bit('g1_n', 'in'), bus('a1', 2, 'in'), bit('g2_n', 'in'), bus('a2', 2, 'in'), bus('y1_n', 4, 'out'), bus('y2_n', 4, 'out')];

export const LS139: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(LS139_PORTS));
  const e1 = b.op1(NOT, ['g1_n']), e2 = b.op1(NOT, ['g2_n']);
  b.next();
  const d1 = b.op(decoder(2, true), ['a1', e1], '1: 2 → 4'), d2 = b.op(decoder(2, true), ['a2', e2], '2: 2 → 4');
  b.next();
  const i1 = [0, 1, 2, 3].map((i) => b.op1(NOT, [`${d1}.y${i}`])), i2 = [0, 1, 2, 3].map((i) => b.op1(NOT, [`${d2}.y${i}`]));
  b.next();
  b.wire(b.op1(merger(ones(4), 4), i1), 'y1_n');
  b.wire(b.op1(merger(ones(4), 4), i2), 'y2_n');
  const half = (g: number, a: number) => (g ? 15 : ~(1 << a) & 15);
  return define({
    id: 'ls139', name: '74LS139 dual 2-to-4 decoder', category: 'ttl',
    summary: 'Two independent 2-to-4 decoders with active-low enables and outputs. Ben\'s display uses one to light its four digits in turn.',
    ports: LS139_PORTS,
    symbol: { kind: 'box', label: '74LS139' },
    spec: ([g1, a1, g2, a2]) => [half(g1, a1), half(g2, a2)],
    netlist: built(b, LS139_PORTS),
  });
})();

const LS157_PORTS: PortDef[] = [bus('a', 4, 'in'), bus('b', 4, 'in'), bit('s', 'in'), bit('g_n', 'in'), bus('y', 4, 'out')];

export const LS157: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(LS157_PORTS));
  const m = b.op1(busMux2(4), ['a', 'b', 's'], 'A or B');
  const en = b.op1(NOT, ['g_n'], 'strobe');
  b.next();
  const rep = b.op1(merger(ones(4), 2), [en, en, en, en]);
  b.next();
  b.wire(b.op1(bitwise('and', 4), [m, rep], 'gated'), 'y');
  return define({
    id: 'ls157', name: '74LS157 quad 2-to-1 multiplexer', category: 'ttl',
    summary: 'Four 2-to-1 multiplexers sharing one select (A/B) and an active-low strobe G (G = 1: every output 0). Picks the DIP switches or the computer in programming mode.',
    ports: LS157_PORTS,
    symbol: { kind: 'box', label: '74LS157' },
    spec: ([a, bb, s, g]) => [g ? 0 : s ? bb : a],
    netlist: built(b, LS157_PORTS),
  });
})();

// ---- arithmetic and the bus transceiver ----------------------------------------------------------------------------

const LS283_PORTS: PortDef[] = [bus('a', 4, 'in'), bus('b', 4, 'in'), bit('c0', 'in'), bus('s', 4, 'out'), bit('c4', 'out')];

export const LS283: ComponentDef = (() => {
  const R = rca(4), g = symbolGeom(R);
  const X = 8;
  return define({
    id: 'ls283', name: '74LS283 4-bit adder', category: 'ttl',
    summary: 'Adds two 4-bit numbers and a carry in: Σ = A + B + C0, carry out C4. Two in a row make the computer\'s 8-bit adder (the first one\'s C4 into the second\'s C0).',
    ports: LS283_PORTS,
    symbol: { kind: 'box', label: '74LS283' },
    spec: ([a, b, c]) => { const s = a + b + c; return [s & 15, s >> 4]; },
    netlist: () => ({
      pins: {
        a: [0, g.ports.a.pos[1]], b: [0, g.ports.b.pos[1]], c0: [0, g.h + 4],
        s: [X + g.w + 8, g.ports.s.pos[1]], c4: [X + g.w + 8, g.ports.cout.pos[1]],
      },
      instances: [{ name: 'add', def: R, at: [X, 0], label: 'four full adders' }],
      nets: [
        { name: 'a', ends: ['a', 'add.a'] }, { name: 'b', ends: ['b', 'add.b'] }, { name: 'c0', ends: ['c0', 'add.cin'] },
        { name: 's', ends: ['add.s', 's'] }, { name: 'c4', ends: ['add.cout', 'c4'] },
      ],
    }),
  });
})();

const LS245_PORTS: PortDef[] = [bit('dir', 'in'), bit('oe_n', 'in'), bus('a', 8, 'in'), bus('b', 8, 'out')];

/**
 * The octal bus transceiver, A → B only: the computer ties DIR high and every module drives the bus from A. A disabled
 * output reads 0 (pull-downs): b = a while G = 0 and DIR = 1, else 0.
 */
export const LS245: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(LS245_PORTS));
  const en = b.name(b.op1(AND, ['dir', b.op1(NOT, ['oe_n'])], 'DIR · ¬G'), 'en', true);
  b.next();
  const rep = b.op1(merger(ones(8), 1), Array(8).fill(en));
  b.next();
  b.wire(b.op1(bitwise('and', 8), ['a', rep], 'drive'), 'b');
  return define({
    id: 'ls245', name: '74LS245 octal bus transceiver', category: 'ttl',
    summary: 'Puts a module\'s value on the bus while its output enable G is low (DIR = 1: A to B). A 3-state output: here a disabled one reads 0 and the bus ORs its drivers.',
    ports: LS245_PORTS,
    symbol: { kind: 'box', label: '74LS245' },
    spec: ([dir, oe, a]) => [dir && !oe ? a : 0],
    netlist: built(b, LS245_PORTS),
  });
})();

// ---- flip-flops ----------------------------------------------------------------------------------------------------

const DFFE_R_PORTS: PortDef[] = [bit('d', 'in'), bit('en', 'in'), bit('clk', 'in', true), bit('rst_n', 'in'), bit('q', 'out')];

/** The resettable flip-flop with a load enable: a multiplexer before DFF_R keeps q while en = 0. */
export const DFFE_R: ComponentDef = (() => {
  const b = new Builder(16, 8, 4);
  b.pins(...ins(DFFE_R_PORTS));
  const m = b.op(MUX2, ['', 'd', 'en'], 'keep or load');
  b.next();
  const q = b.name(b.op1(DFF_R, [`${m}.y`, 'clk', 'rst_n'], undefined, 'ff'), 'q', true);
  b.wire(q, `${m}.a`);
  b.wire(q, 'q');
  return define({
    id: 'dffe_r', name: 'D flip-flop with enable and reset', category: 'sequential',
    summary: 'Loads D at the rising edge only while en = 1 (a multiplexer feeds q back otherwise); rst_n = 0 clears it at once, clock or not.',
    ports: DFFE_R_PORTS,
    symbol: { kind: 'box', label: 'DFFE R' },
    ff: { d: 'd', q: 'q', clk: 'clk', en: 'en' },
    netlist: built(b, DFFE_R_PORTS),
  });
})();

const LS173_PORTS: PortDef[] = [
  bit('m', 'in'), bit('n', 'in'), bit('g1_n', 'in'), bit('g2_n', 'in'), bit('clr', 'in'), bit('clk', 'in', true), bus('d', 4, 'in'), bus('q', 4, 'out'),
];

/**
 * 4-bit D register: loads D at the rising edge while G1 = G2 = 0; CLR = 1 clears it; the outputs drive while M = N = 0
 * (3-state: 0 otherwise). The A, B, instruction, address and flags registers are 173s.
 */
export const LS173: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(LS173_PORTS));
  const load = b.name(b.op1(NOR, ['g1_n', 'g2_n'], 'load'), 'load', true);
  const oe = b.name(b.op1(NOR, ['m', 'n'], 'drive'), 'oe', true);
  const rst = b.name(b.op1(NOT, ['clr']), 'rst_n', true);
  const sd = b.op(splitter(ones(4), 4), ['d'], 'D');
  b.next();
  const q = [0, 1, 2, 3].map((i) => b.name(b.op1(DFFE_R, [`${sd}.o${i}`, load, 'clk', rst], `bit ${i}`, `ff${i}`), `q${i}`));
  b.next();
  const mq = b.op1(merger(ones(4), 2), q);
  const rep = b.op1(merger(ones(4), 2), [oe, oe, oe, oe]);
  b.next();
  b.wire(b.op1(bitwise('and', 4), [mq, rep], '3-state'), 'q');
  return define({
    id: 'ls173', name: '74LS173 4-bit register', category: 'ttl',
    summary: 'Four D flip-flops: they load D at the rising clock edge while G1 = G2 = 0 (data enable), CLR = 1 clears them, and the outputs drive only while M = N = 0.',
    ports: LS173_PORTS,
    symbol: { kind: 'box', label: '74LS173' },
    netlist: built(b, LS173_PORTS),
  });
})();

const LS273_PORTS: PortDef[] = [bit('clr_n', 'in'), bit('clk', 'in', true), bus('d', 8, 'in'), bus('q', 8, 'out')];

/** Octal D flip-flop with clear: the output register (clocked by CLK · OI). */
export const LS273: ComponentDef = (() => {
  const b = new Builder(16, 10, 2);
  b.pins(...ins(LS273_PORTS));
  const sd = b.op(splitter(ones(8), 4), ['d'], 'D');
  b.next();
  const q = Array.from({ length: 8 }, (_, i) => b.op1(DFF_R, [`${sd}.o${i}`, 'clk', 'clr_n'], undefined, `ff${i}`));
  b.next();
  b.wire(b.op1(merger(ones(8), 2), q), 'q');
  return define({
    id: 'ls273', name: '74LS273 octal D flip-flop', category: 'ttl',
    summary: 'Eight D flip-flops on one clock with an active-low clear. No enable: the output module clocks it with CLK AND OI.',
    ports: LS273_PORTS,
    symbol: { kind: 'box', label: '74LS273' },
    netlist: built(b, LS273_PORTS),
  });
})();

const LS161_PORTS: PortDef[] = [
  bit('clr_n', 'in'), bit('clk', 'in', true), bus('d', 4, 'in'), bit('enp', 'in'), bit('ent', 'in'), bit('load_n', 'in'), bus('q', 4, 'out'), bit('rco', 'out'),
];

/**
 * 4-bit synchronous counter: at the rising edge it loads D while LOAD = 0, else counts while ENP = ENT = 1; CLR = 0
 * clears it at once (asynchronously). RCO = ENT and Q = 15. The program counter and the step counter.
 */
export const LS161: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(LS161_PORTS));
  const sd = b.op(splitter(ones(4), 4), ['d'], 'D');
  const cnt = b.name(b.op1(AND, ['enp', 'ent'], 'count'), 'count', true);
  const ld = b.name(b.op1(NOT, ['load_n'], 'load'), 'load', true);
  b.next();
  // q comes back from the flip-flops (labels): toggle bit i when every bit below is 1
  const t1 = b.op1(AND, [cnt, '']), t2 = b.op1(AND, [t1, '']), t3 = b.op1(AND, [t2, '']);
  const t = [cnt, t1, t2, t3];
  b.next();
  const x = [0, 1, 2, 3].map((i) => b.op(XOR, ['', t[i]], `q${i} next`));
  b.next();
  const m = [0, 1, 2, 3].map((i) => b.op1(MUX2, [`${x[i]}.y`, `${sd}.o${i}`, ld]));
  b.next();
  const q = [0, 1, 2, 3].map((i) => b.name(b.op1(DFF_R, [m[i], 'clk', 'clr_n'], `bit ${i}`, `ff${i}`), `q${i}`, true));
  b.next();
  q.forEach((qi, i) => b.wire(qi, `${x[i]}.a`));
  [t1, t2, t3].forEach((ti, i) => b.wire(q[i], `${ti.slice(0, ti.indexOf('.'))}.b`));
  b.wire(b.op1(merger(ones(4), 2), q), 'q');
  b.wire(b.op1(andN(5), ['ent', ...q], 'ripple carry'), 'rco');
  return define({
    id: 'ls161', name: '74LS161 4-bit counter', category: 'ttl',
    summary: 'Counts at the rising clock edge while ENP = ENT = 1, loads D instead while LOAD = 0, and clears at once while CLR = 0. RCO = 1 at 15 (with ENT), for chaining.',
    ports: LS161_PORTS,
    symbol: { kind: 'box', label: '74LS161' },
    netlist: built(b, LS161_PORTS),
  });
})();

// ---- RAM -----------------------------------------------------------------------------------------------------------

/** Four D latches on one enable: a word of the 74LS189. */
export const LATCH4: ComponentDef = (() => {
  const Pt = 8, X = 10, Y0 = 3;
  const g = symbolGeom(D_LATCH);
  const instances: InstanceDef[] = [
    { name: 'sd', def: splitter(ones(4), Pt), at: [6, Y0 + g.ports.d.pos[1] - Pt / 2] },
    { name: 'mq', def: merger(ones(4), Pt), at: [X + g.w + 3, Y0 + g.ports.q.pos[1] - Pt / 2] },
  ];
  const nets: NetDef[] = [{ name: 'd', ends: ['d', 'sd.in'] }, { name: 'q', ends: ['mq.out', 'q'] }];
  const e = ['e'];
  for (let i = 0; i < 4; i++) {
    instances.push({ name: `l${i}`, def: D_LATCH, at: [X, Y0 + Pt * i] });
    nets.push({ name: `d${i}`, ends: [`sd.o${i}`, `l${i}.d`] }, { name: `q${i}`, ends: [`l${i}.q`, `mq.i${i}`] });
    e.push(`l${i}.e`);
  }
  nets.push({ name: 'e', ends: e, trunk: 8.5 });
  const mid = (Pt * 4) / 2;
  return define({
    id: 'latch4', name: '4-bit latch', category: 'sequential',
    summary: 'Four D latches sharing one enable: transparent while e = 1, holding while e = 0. A word of the 74LS189.',
    ports: [bus('d', 4, 'in'), bit('e', 'in'), bus('q', 4, 'out')],
    symbol: { kind: 'box', label: 'LATCH4' },
    netlist: () => ({
      pins: { d: [1, Y0 + g.ports.d.pos[1] - Pt / 2 + mid], e: [1, Y0 + Pt * 4 + 1], q: [X + g.w + 8, Y0 + g.ports.q.pos[1] - Pt / 2 + mid] },
      instances, nets,
    }),
  });
})();

/** The 16 × 4 store of the 74LS189: a 4 → 16 decoder enabling one latch word, a 16:1 multiplexer reading one (ram()'s drawing). */
export const RAM16X4L: ComponentDef = (() => {
  const N = 16, R = LATCH4, rg = symbolGeom(R);
  const pitch = Math.max(rg.h + 4, 10);
  const D = decoder(4, true, pitch), M = muxTree(4, 4, pitch);
  const dg = symbolGeom(D), mg = symbolGeom(M);
  const dAt: [number, number] = [6, 2];
  const dOut = (i: number) => dAt[1] + dg.ports[`y${i}`].pos[1];
  const xR = dAt[0] + dg.w + 8;
  const rTop = (i: number) => dOut(i) - rg.ports.e.pos[1];
  const xM = xR + rg.w + 7;
  const mTop = rTop(0) + rg.ports.q.pos[1] - mg.ports.d0.pos[1];
  const instances: InstanceDef[] = [{ name: 'dec', def: D, at: dAt }, { name: 'rmux', def: M, at: [xM, mTop] }];
  const nets: NetDef[] = [];
  const din = ['d'];
  for (let i = 0; i < N; i++) {
    instances.push({ name: `w${i}`, def: R, at: [xR, rTop(i)] });
    nets.push({ name: `en${i}`, ends: [`dec.y${i}`, `w${i}.e`] }, { name: `q${i}`, ends: [`w${i}.q`, `rmux.d${i}`] });
    din.push(`w${i}.d`);
  }
  const bottom = Math.max(rTop(N - 1) + rg.h, dAt[1] + dg.h, mTop + mg.h) + 3;
  const addrY = dAt[1] + dg.ports.a.pos[1];
  const sx = xM + mg.ports.s.pos[0];
  nets.push({ name: 'a', ends: ['a', 'dec.a', 'rmux.s'], via: { 'rmux.s': [[2, addrY], [2, bottom + 2], [sx, bottom + 2]] } });
  nets.push({ name: 'we', ends: ['we', 'dec.en'] });
  nets.push({ name: 'd', ends: din, trunk: xR - 3 });
  nets.push({ name: 'q', ends: ['rmux.y', 'q'] });
  return define({
    id: 'ram16x4l', name: '16×4 latch memory', category: 'memory',
    summary: '16 words of 4 latches: while we = 1 the addressed word is transparent to d (a level-sensitive write, as in the 74LS189); q reads the addressed word.',
    ports: [bus('a', 4, 'in'), bus('d', 4, 'in'), bit('we', 'in'), bus('q', 4, 'out')],
    symbol: { kind: 'box', label: 'RAM 16×4' },
    netlist: () => ({
      pins: { a: [0, addrY], we: [0, dAt[1] + dg.ports.en.pos[1]], d: [0, bottom], q: [xM + mg.w + 4, mTop + mg.ports.y.pos[1]] },
      instances, nets,
    }),
  });
})();

const LS189_PORTS: PortDef[] = [bus('a', 4, 'in'), bit('cs_n', 'in'), bit('we_n', 'in'), bus('d', 4, 'in'), bus('q_n', 4, 'out')];

/**
 * 64-bit RAM, 16 × 4: writes D into word A while ME = WE = 0 (level sensitive), reads word A inverted while ME = 0 and
 * WE = 1 (3-state: 0 otherwise). Ben's RAM module inverts the outputs back with a 74LS04.
 */
export const LS189: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(LS189_PORTS));
  const we = b.name(b.op1(NOR, ['cs_n', 'we_n'], 'write'), 'we', true);
  const sel = b.op1(NOT, ['cs_n']);
  b.next();
  const mem = b.op1(RAM16X4L, ['a', 'd', we], '16 words', 'mem');
  const oe = b.op1(AND, [sel, 'we_n'], 'read');
  b.next();
  const noe = b.op1(NOT, [oe]);
  const sq = b.op(splitter(ones(4), 4), [mem]);
  b.next();
  const y = [0, 1, 2, 3].map((i) => b.op1(NOR, [`${sq}.o${i}`, noe], `Q${i + 1}`));
  b.next();
  b.wire(b.op1(merger(ones(4), 2), y), 'q_n');
  return define({
    id: 'ls189', name: '74LS189 16×4 RAM', category: 'ttl',
    summary: '64 bits of RAM as 16 words of 4: while ME = WE = 0 the word at A takes D; while ME = 0 and WE = 1 the outputs show that word inverted. Two make the computer\'s 16 bytes.',
    ports: LS189_PORTS,
    symbol: { kind: 'box', label: '74LS189' },
    netlist: built(b, LS189_PORTS),
  });
})();

/** Power-on hints making a 74LS189 at `path` (an instance path in the top) hold `words` (low 4 bits each). */
export function ls189Init(path: string, words: ArrayLike<number>, into: Record<string, 0 | 1> = {}): Record<string, 0 | 1> {
  const pre = path ? `${path}.` : '';
  for (let i = 0; i < Math.min(16, words.length); i++) {
    for (let j = 0; j < 4; j++) {
      if (!bitOf(words[i], j)) continue;
      into[`${pre}mem.w${i}.l${j}.sr.q`] = 1;
      into[`${pre}mem.w${i}.l${j}.sr.q_n`] = 0;
    }
  }
  return into;
}

const loaded189 = new Map<string, ComponentDef>();

/** The 16 nibbles of a loaded 74LS189's id (word 0 first), from its words. */
export const ls189Key = (words: ArrayLike<number>) => Array.from({ length: 16 }, (_, i) => ((words[i] ?? 0) & 15).toString(16)).join('');

/**
 * A 74LS189 that holds `words` at power-on: id `ls189_i<16 hex nibbles>` (lib/resolve.ts rebuilds it from the id),
 * the plain LS189 for an empty one. The sandbox's SAP-1 places it in its RAM chip: a chip's own wires cannot carry
 * hints into a part's latches, a part's id can (as a RAM part's initial contents ride in its ref).
 */
export function ls189With(words: ArrayLike<number>): ComponentDef {
  const key = ls189Key(words);
  if (!/[^0]/.test(key)) return LS189;
  let d = loaded189.get(key);
  if (d) return d;
  d = {
    ...LS189, id: `ls189_i${key}`,
    summary: `${LS189.summary} Holds its words at power-on.`,
    powerOn: ls189Init('', Array.from(key, (c) => parseInt(c, 16))),
  };
  loaded189.set(key, d);
  return d;
}

// ---- the dual JK flip-flop (Ben's display multiplexer: a 2-bit counter) --------------------------------------------

const DLSR_PORTS: PortDef[] = [bit('d', 'in'), bit('e', 'in'), bit('pre_n', 'in'), bit('clr_n', 'in'), bit('q', 'out'), bit('q_n', 'out')];

/** A D latch with asynchronous preset and clear (active low): the D_LATCH_R pattern on both sides. */
export const D_LATCH_SR: ComponentDef = (() => {
  const b = new Builder(16, 8, 4);
  b.pins(...ins(DLSR_PORTS));
  const nd = b.op1(NOT, ['d']);
  b.next();
  const s = b.op1(NAND3, ['d', 'e', 'clr_n'], 'set side');
  const r = b.op1(NAND3, [nd, 'e', 'pre_n'], 'reset side');
  b.next();
  const q = b.op(NAND3, [s, '', 'pre_n'], undefined, 'q1');
  const qn = b.op(NAND3, [r, '', 'clr_n'], undefined, 'q2');
  b.name(`${q}.y`, 'q', true);
  b.name(`${qn}.y`, 'q_n', true);
  b.wire(`${qn}.y`, `${q}.b`);
  b.wire(`${q}.y`, `${qn}.b`);
  b.wire(`${q}.y`, 'q');
  b.wire(`${qn}.y`, 'q_n');
  return define({
    id: 'd_latch_sr', name: 'D latch with preset and clear', category: 'sequential',
    summary: 'A D latch whose NANDs take a third input each: pre_n = 0 forces q = 1, clr_n = 0 forces q = 0, enable or not.',
    ports: DLSR_PORTS,
    symbol: { kind: 'box', label: 'D latch SR' },
    powerOn: { q: 0, q_n: 1 },
    netlist: built(b, DLSR_PORTS),
  });
})();

const JKN_PORTS: PortDef[] = [bit('j', 'in'), bit('k', 'in'), bit('clk', 'in', true), bit('pre_n', 'in'), bit('clr_n', 'in'), bit('q', 'out'), bit('q_n', 'out')];

/** JK flip-flop on the falling edge with preset and clear: one half of the 74LS76. */
export const JKFF_N: ComponentDef = (() => {
  const b = new Builder(16, 8, 4);
  b.pins(...ins(JKN_PORTS));
  const nk = b.op1(NOT, ['k']);
  const nq = b.op(NOT, [''], '¬q');
  const nclk = b.op1(NOT, ['clk']);
  b.next();
  const set = b.op1(AND, ['j', `${nq}.y`], 'set');
  const keep = b.op(AND, [nk, ''], 'keep');
  b.next();
  const d = b.op1(OR, [set, `${keep}.y`], 'next');
  const mi = b.op1(NOT, [nclk]);
  b.next();
  const ma = b.op(D_LATCH_SR, [d, mi, 'pre_n', 'clr_n'], 'master', 'master');
  b.next();
  const sl = b.op(D_LATCH_SR, [`${ma}.q`, nclk, 'pre_n', 'clr_n'], 'slave', 'slave');
  const q = b.name(`${sl}.q`, 'q', true);
  b.wire(q, `${nq}.a`);
  b.wire(q, `${keep}.b`);
  b.wire(q, 'q');
  b.wire(`${sl}.q_n`, 'q_n');
  return define({
    id: 'jkff_n', name: 'JK flip-flop (falling edge, preset, clear)', category: 'sequential',
    summary: 'd = j·¬q + ¬k·q into a master–slave pair that changes on the falling clock edge; pre_n = 0 sets, clr_n = 0 clears, at once. Half a 74LS76.',
    ports: JKN_PORTS,
    symbol: { kind: 'box', label: 'JK ↓' },
    netlist: built(b, JKN_PORTS),
  });
})();

const LS76_PORTS: PortDef[] = [
  bit('clk1', 'in'), bit('pre1_n', 'in'), bit('clr1_n', 'in'), bit('j1', 'in'), bit('k1', 'in'),
  bit('clk2', 'in'), bit('pre2_n', 'in'), bit('clr2_n', 'in'), bit('j2', 'in'), bit('k2', 'in'),
  bit('q1', 'out'), bit('q1_n', 'out'), bit('q2', 'out'), bit('q2_n', 'out'),
];

export const LS76: ComponentDef = (() => {
  const b = new Builder(16, 10, 6);
  b.pins(...ins(LS76_PORTS));
  const f1 = b.op(JKFF_N, ['j1', 'k1', 'clk1', 'pre1_n', 'clr1_n'], 'FF 1', 'ff1');
  const f2 = b.op(JKFF_N, ['j2', 'k2', 'clk2', 'pre2_n', 'clr2_n'], 'FF 2', 'ff2');
  for (const [f, n] of [[f1, '1'], [f2, '2']]) { b.wire(`${f}.q`, `q${n}`); b.wire(`${f}.q_n`, `q${n}_n`); }
  return define({
    id: 'ls76', name: '74LS76 dual JK flip-flop', category: 'ttl',
    summary: 'Two JK flip-flops that change on the falling clock edge, with active-low preset and clear. Ben\'s display counts its digits with one (J = K = 1: a divide by two each).',
    ports: LS76_PORTS,
    symbol: { kind: 'box', label: '74LS76' },
    netlist: built(b, LS76_PORTS),
  });
})();

// ---- the 28C16 EEPROM ----------------------------------------------------------------------------------------------

const leafCache = new Map<string, ComponentDef>();
/** A 2^k ≤ 256-word bank of the EEPROM: a multiplexer tree whose inputs are tied to the bytes. */
const eepromLeaf: RomLeaf = (k, w, content) => {
  const key = `${k}_${w}_${wordsHash(content)}`;
  const hit = leafCache.get(key);
  if (hit) return hit;
  const words = Uint32Array.from(content);
  const M = muxTree(k, w, 4), mg = symbolGeom(M);
  const d: ComponentDef = {
    id: `eebank${key}`, name: `ROM ${2 ** k}×${w}`, category: 'memory',
    summary: `${2 ** k} bytes, read-only: a multiplexer tree whose inputs are tied to the bits.`,
    ports: [bus('addr', k, 'in'), bus('data', w, 'out')],
    symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : words[a % words.length]], delay: 3 * k },
    preferBehavior: true,
    netlist: () => {
      const instances: InstanceDef[] = [{ name: 'mux', def: M, at: [16, 0] }];
      const nets: NetDef[] = [{ name: 'addr', ends: ['addr', 'mux.s'] }, { name: 'data', ends: ['mux.y', 'data'] }];
      words.forEach((v, i) => {
        instances.push({ name: `c${i}`, def: constWord(w, v), at: [6, mg.ports[`d${i}`].pos[1] - 1], label: `[${i}]` });
        nets.push({ ends: [`c${i}.y`, `mux.d${i}`] });
      });
      return { pins: { addr: [0, mg.h + 4], data: [16 + mg.w + 6, mg.ports.y.pos[1]] }, instances, nets };
    },
  };
  leafCache.set(key, d);
  return d;
};

const EEPROM_PORTS: PortDef[] = [bus('addr', 11, 'in'), bit('ce_n', 'in'), bit('oe_n', 'in'), bit('we_n', 'in'), bus('data', 8, 'out')];
const eeproms = new Map<string, ComponentDef>();

/**
 * A 28C16 EEPROM (2K × 8) holding `image`: data = the byte at addr while CE = OE = 0, else 0 (3-state). Never written
 * here (WE is drawn, not simulated: the chapter programs it off board). Simulated as a lookup; its structure is the
 * ROM tree. Memoized by content.
 */
export function eeprom2k(image: ArrayLike<number>): ComponentDef {
  const content = Uint32Array.from({ length: 2048 }, (_, i) => (image[i] ?? 0) & 0xff);
  const h = wordsHash(content);
  let d = eeproms.get(h);
  if (d) return d;
  const rom = romLevels(11, 8, false, content, `eerom_${h}`, eepromLeaf);
  const b = new Builder(16, 10, 4);
  b.pins('addr', 'ce_n', 'oe_n');
  const r = b.op1(rom, ['addr'], '2048 bytes', 'rom');
  const en = b.name(b.op1(NOR, ['ce_n', 'oe_n'], 'CE · OE'), 'en', true);
  b.next();
  const rep = b.op1(merger(ones(8), 1), Array(8).fill(en));
  b.next();
  b.wire(b.op1(bitwise('and', 8), [r, rep], '3-state'), 'data');
  const nl = built(b, EEPROM_PORTS);
  d = define({
    id: `at28c16_${h}`, name: '28C16 EEPROM (2K × 8)', category: 'ttl',
    summary: '2048 bytes of electrically erasable ROM: the byte at A0–A10 on I/O0–7 while CE = OE = 0. The control unit holds its microcode in two, the display its digit patterns in one.',
    ports: EEPROM_PORTS,
    symbol: { kind: 'box', label: '28C16' },
    behavior: {
      eval: ([a, ce, oe]) => (ce < 0 || oe < 0 ? [-1] : ce || oe ? [0] : [a < 0 ? -1 : content[a & 2047]]),
      delay: 12,
    },
    preferBehavior: true,
    romBytes: 2048,
    spec: ([a, ce, oe]) => [ce || oe ? 0 : content[a & 2047]],
    netlist: nl,
  });
  eeproms.set(h, d);
  return d;
}

// ---- the 555 -------------------------------------------------------------------------------------------------------

/**
 * The NE555 timer: drawn on the breadboards (the clock's astable, monostable and switch debouncer; the display's
 * multiplexing clock), never simulated: the stage's clock stands in for it. No ports.
 */
export const NE555: ComponentDef = define({
  id: 'ne555', name: 'NE555 timer', category: 'ttl',
  summary: 'The 555 timer: an analog part (two comparators, a flip-flop and a discharge transistor). On the breadboards it makes the clock; here it is drawn, not simulated: the stage\'s clock stands in for it.',
  ports: [],
  symbol: { kind: 'box', label: 'NE555', w: 8, h: 6 },
});

/** Every 74xx chip of the computer's kit, in the order the chapter introduces them. */
export const TTL_CHIPS: ComponentDef[] = [LS173, LS245, LS04, LS08, LS00, LS02, LS32, LS86, LS283, LS189, LS157, LS161, LS138, LS139, LS273, LS76, NE555];

