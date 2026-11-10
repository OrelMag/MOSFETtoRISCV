// The Apollo Guidance Computer's brick (Appendix F, the NOR3 ladder): a three-input NOR in resistor-transistor logic,
// and what the ladder's reference answers build from it alone.
//
// The gate, as drawn on MIT Instrumentation Laboratory drawing 2005011 (Schematic, Dual NOR Gate, April 1965) and as
// R-700 vol. III (E. C. Hall, 1972) p. 9-10 describes the Block I gate: three NPN transistors with their emitters to
// ground and their collectors joined, one collector resistor to B+, and one base resistor in front of each input,
// "three NPN bipolar transistors and four resistors connected as a modified direct-coupled transistor logic or DCTL
// NOR gate". Here the NPNs are NMOS switches and the collector resistor is a pull-up (PULLUP: weaker than any
// transistor, so any input at 1 pulls y to 0). The three base resistors only limit each transistor's base current;
// at switch level they change no value, so they are counted (statsOf: 3 transistors, 4 resistors) but not simulated.
// Block II packed two such gates on one chip in a 10-lead flatpack (R-700 p. 13; drawing 2005011 shows the pair).

import { Builder } from './builder';
import { define } from './define';
import { layered } from './layered';
import { PULLUP } from './switchparts';
import { GND, NMOS } from './transistors';
import type { ComponentDef } from '../sim/types';

const bit = (name: string, dir: 'in' | 'out') => ({ name, width: 1, dir });

export const NOR3_RTL: ComponentDef = define({
  id: 'nor3_rtl', name: 'NOR3 (RTL, as in the AGC)', category: 'gate',
  summary: 'y = ¬(a + b + c): three transistors to ground in parallel under one collector resistor, the Apollo Guidance Computer\'s only logic gate. Counted as drawn on MIT drawing 2005011, 3 transistors and 4 resistors; the three base resistors only limit current, so the simulation leaves them out.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('c', 'in'), bit('y', 'out')],
  symbol: { kind: 'box', label: 'NOR3' },
  spec: ([a, b, c]) => [a || b || c ? 0 : 1],
  statsOf: () => ({ nands: 0, transistors: 3, resistors: 4, capacitors: 0, relays: 0, triodes: 0, diodes: 0, depletion: 0, parts: 5, descendants: 5, levels: 1, nor3: 1 }),
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 9], b: [1, 13], c: [1, 17], y: [26, 5] },
    instances: [
      { name: 'rc', def: PULLUP, at: [21, 0], label: 'collector resistor' },
      { name: 'qa', def: NMOS, at: [6, 7] },
      { name: 'qb', def: NMOS, at: [11, 11] },
      { name: 'qc', def: NMOS, at: [16, 15] },
      { name: 'gnd', def: GND, at: [21, 22] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'qa.g'] },
      { name: 'b', ends: ['b', 'qb.g'] },
      { name: 'c', ends: ['c', 'qc.g'] },
      { name: 'y', ends: ['rc.y', 'qa.d', 'qb.d', 'qc.d', 'y'] },
      { name: 'gnd', ends: ['gnd.p', 'qa.s', 'qb.s', 'qc.s'] },
    ],
  }),
  hdl: {
    verilog: `module nor3_rtl (input a, input b, input c, output y);
  supply0 gnd;
  pullup  (y);           // the collector resistor
  nmos qa (y, gnd, a);   // the three transistors (the base resistors are left out: they change no value)
  nmos qb (y, gnd, b);
  nmos qc (y, gnd, c);
endmodule`,
  },
});

/** A gate of a NOR3 circuit: its output net and its inputs (one to three nets; a gate with fewer ties the rest to its first). */
export type NorGate = [out: string, ins: string[]];
/** A sub-block of a NOR3 circuit: an instance of another NOR3 circuit, its inputs and outputs as nets in port order. */
export interface NorBlock { name: string; def: ComponentDef; ins: string[]; outs: string[] }

/**
 * A circuit of NOR3 gates and smaller NOR3 circuits, laid out by logic depth (lib/layered.ts), every net a wire.
 * Parts in order; inputs are pin names or nets the parts drive. A gate is instance g_<its output net>.
 */
export function norCircuit(d: { id: string; name: string; summary: string; ins: string[]; outs: Record<string, string>; parts: (NorGate | NorBlock)[]; spec?: ComponentDef['spec']; column?: Record<string, number> }): ComponentDef {
  const parts: NorBlock[] = d.parts.map((x) => (Array.isArray(x)
    ? { name: `g_${x[0]}`, def: NOR3_RTL, ins: [0, 1, 2].map((i) => x[1][Math.min(i, x[1].length - 1)]), outs: [x[0]] }
    : x));
  const portsOf = (def: ComponentDef, dir: 'in' | 'out') => def.ports.filter((p) => p.dir === dir).map((p) => p.name);
  const driver = new Map<string, string>();
  for (const q of parts) portsOf(q.def, 'out').forEach((p, i) => q.outs[i] && driver.set(q.outs[i], `${q.name}.${p}`));
  const b = new Builder(8, 10, 4);
  for (const q of parts) b.add(q.def, undefined, q.name);
  const drv = (net: string) => driver.get(net) ?? net;
  for (const q of parts) {
    portsOf(q.def, 'in').forEach((p, i) => b.wire(drv(q.ins[i]), `${q.name}.${p}`));
    for (const o of q.outs) b.name(drv(o), o);
  }
  const outs = Object.keys(d.outs);
  for (const [p, net] of Object.entries(d.outs)) b.wire(drv(net), p);
  b.pins(...d.ins);
  const ports = [...d.ins.map((n) => bit(n, 'in')), ...outs.map((n) => bit(n, 'out'))];
  return define({
    id: d.id, name: d.name, category: 'gate', summary: d.summary,
    ports,
    symbol: { kind: 'box', label: d.name.toUpperCase() },
    ...(d.spec ? { spec: d.spec } : {}),
    netlist: () => ({ ...layered(ports, b, { gap: 8, ...(d.column ? { column: d.column } : {}), wires: Object.fromEntries(b.nets().map((n) => [n.ends[0], true])) }), level: 'switch' }),
  });
}

// ---- the ladder's reference answers ----------------------------------------------------------

/** nor_basic: NOT, OR and AND of a and b (na = ¬a, o = a + b, y = a·b): 5 gates, ¬a shared by NOT and AND. */
export const NOR_BASIC = norCircuit({
  id: 'nor_basic', name: 'NOT, OR, AND in NOR3', summary: 'na = ¬a, o = a + b, y = a·b, every gate a NOR3: a gate with its inputs tied is a NOT; NOR then NOT is OR; NOR of the two inverted inputs is AND (De Morgan).',
  ins: ['a', 'b'], outs: { na: 'na', o: 'o', y: 'y' },
  parts: [['na', ['a']], ['nb', ['b']], ['nab', ['a', 'b']], ['o', ['nab']], ['y', ['na', 'nb']]],
  spec: ([a, b]) => [a ? 0 : 1, a | b, a & b],
});

/** z = ¬(x ⊕ y) from four NORs, and n = NOR(x, y), the first of them, which the full adder's carry reads. */
export const NOR_XNOR = norCircuit({
  id: 'nor_xnor', name: 'XNOR in NOR3', summary: 'z = ¬(x ⊕ y) from four NOR gates, the 4-NAND XOR with every gate a NOR (the dual of XOR is XNOR); n = NOR(x, y), its first gate, is an output too.',
  ins: ['x', 'y'], outs: { z: 'z', n: 'n' },
  parts: [['n', ['x', 'y']], ['p', ['x', 'n']], ['q', ['y', 'n']], ['z', ['p', 'q']]],
  spec: ([x, y]) => [x ^ y ? 0 : 1, x | y ? 0 : 1],
});

/**
 * nor_fa: a full adder from nine NOR gates. It is the 9-NAND adder with every NAND a NOR: that swaps each gate's
 * function for its dual, and both outputs are self-dual (s = a ⊕ b ⊕ ci and the majority are their own duals),
 * so the same wiring adds. The first XNOR gives h = ¬(a ⊕ b); the second, of h and ci, is the sum.
 */
export const NOR_FA = norCircuit({
  id: 'nor_fa', name: 'Full adder in NOR3', summary: 'The 9-NAND full adder with every gate a NOR: s = a ⊕ b ⊕ ci and co the majority are self-dual, so the dual wiring adds too. Two 4-gate XNORs and the carry gate: 9 NOR3 gates.',
  ins: ['a', 'b', 'ci'], outs: { s: 's', co: 'co' },
  parts: [
    { name: 'xa', def: NOR_XNOR, ins: ['a', 'b'], outs: ['h', 'n1'] },
    { name: 'xb', def: NOR_XNOR, ins: ['h', 'ci'], outs: ['s', 'n5'] },
    ['co', ['n1', 'n5']],
  ],
  spec: ([a, b, c]) => [a ^ b ^ c, a + b + c > 1 ? 1 : 0],
});

/** A gated latch, open while en_n = 0: set = NOR(¬d, en_n), reset = NOR(d, en_n), into a cross-coupled NOR pair. */
export const NOR_LATCH = norCircuit({
  id: 'nor_latch', name: 'Latch in NOR3', summary: 'q follows d while en_n = 0 and holds while en_n = 1: two NOR gates set and reset a cross-coupled pair, which holds a bit while both are 0. d and ¬d both come in (a flip-flop\'s slave takes them from its master). 4 NOR3 gates.',
  ins: ['d', 'dn', 'en_n'], outs: { q: 'q', qn: 'qn' },
  parts: [['s', ['dn', 'en_n']], ['r', ['d', 'en_n']], ['q', ['r', 'qn']], ['qn', ['s', 'q']]],
  column: { g_s: 0, g_r: 0, g_q: 1, g_qn: 1 },
});

/** m = en ? d : q, and its inverse: the register's enable, in front of its master latch. */
export const NOR_ENMUX = norCircuit({
  id: 'nor_enmux', name: 'Enable mux in NOR3', summary: 'm = en ? d : q (the register\'s own q, read as ¬q from qn) and mn = ¬m: en·d and ¬en·q as NORs of inverted inputs, their NOR is ¬m, one more gate m. 6 NOR3 gates.',
  ins: ['d', 'en', 'qn'], outs: { m: 'm', mn: 'mn' },
  parts: [['enn', ['en']], ['dn', ['d']], ['x1', ['enn', 'dn']], ['x2', ['en', 'qn']], ['mn', ['x1', 'x2']], ['m', ['mn']]],
});

/**
 * nor_reg: a 1-bit register: q takes d at the rising edge of clk while en = 1, else holds. The enable's multiplexer
 * chooses d or the register's own q; the master latch is open while clk = 0 (clk itself is its active-low enable),
 * the slave while clk = 1 (one inverter), and it takes the master's q and ¬q, so it needs no inverter of its own.
 */
export const NOR_REG = norCircuit({
  id: 'nor_reg', name: 'Register bit in NOR3', summary: 'q takes d at the rising edge of clk while en = 1, else holds: the enable\'s multiplexer, a master latch open while clk = 0 and a slave open while clk = 1, each a cross-coupled NOR pair. 15 NOR3 gates.',
  ins: ['d', 'en', 'clk'], outs: { q: 'q' },
  parts: [
    { name: 'mux', def: NOR_ENMUX, ins: ['d', 'en', 'qn'], outs: ['m', 'mn'] },
    { name: 'master', def: NOR_LATCH, ins: ['m', 'mn', 'clk'], outs: ['qm', 'qmn'] },
    ['ckn', ['clk']],
    { name: 'slave', def: NOR_LATCH, ins: ['qm', 'qmn', 'ckn'], outs: ['q', 'qn'] },
  ],
  column: { mux: 0, master: 1, g_ckn: 2, slave: 3 },
});
