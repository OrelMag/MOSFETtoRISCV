// Level 0, continued: the other parts of a switch-level schematic. A resistor is a path that always
// conducts, more weakly than any transistor (ComponentDef.strength 1), so a node it alone reaches
// follows it and any conducting transistor overrides it: pull-ups, pull-downs, ratioed logic. A
// capacitor marks its node as one that keeps its charge (like NetDef.cap). Built from transistors:
// the transmission gate and the tri-state drivers, whose outputs can let go of a shared bus (Z).

import type { ComponentDef } from '../sim/types';
import { define } from './define';
import { GND, INV_CMOS, NMOS, PMOS, VDD } from './transistors';

export const RES: ComponentDef = define({
  id: 'res', name: 'Resistor', category: 'transistor', prim: 'res',
  summary: 'Always conducts, but more weakly than any transistor: a node it alone reaches follows it, any transistor path overrides it.',
  ports: [
    { name: 'a', width: 1, dir: 'inout' },
    { name: 'b', width: 1, dir: 'inout' },
  ],
  symbol: { kind: 'res' },
  notes: `In this model a resistor is a switch that is always on, at strength 1 (transistors are 2–4).
    Between VDD and a node it is a <em>pull-up</em>: the node reads 1 unless a transistor pulls it to 0,
    and then current flows through the resistor for as long as the transistor is on. That static current
    is what ratioed logic pays for saving the pull-up network. Two resistors pulling opposite ways
    give X (a divider: neither a valid 0 nor a valid 1).`,
  hdl: { verilog: '// A resistive switch: what passes through it is weakened to a pull strength.\nrtran r1 (a, b);' },
});

export const CAP: ComponentDef = define({
  id: 'cap', name: 'Capacitor', category: 'transistor', prim: 'cap',
  summary: 'A capacitor to GND: its node keeps its last value while nothing drives it (stored charge).',
  ports: [{ name: 'a', width: 1, dir: 'inout' }],
  symbol: { kind: 'cap' },
  notes: `Every node has some capacitance; a capacitor makes it the point. While a transistor or a rail
    drives the node, the capacitor follows; when every path is off the node is not Z but keeps its
    charge, the weakest value of all: a resistor or any transistor overrides it. A DRAM cell is one
    transistor and one of these. (Same as ticking “keeps charge” on a wire.)`,
  hdl: { verilog: '// A net with capacitance: keeps its value when every driver is off.\ntrireg n;' },
});

export const PULLUP: ComponentDef = define({
  id: 'pullup', name: 'Pull-up', category: 'transistor',
  summary: 'A resistor to VDD: the node is 1 unless something stronger (any transistor) pulls it down.',
  ports: [{ name: 'y', width: 1, dir: 'out', tri: true, doc: 'weak 1: any driver overrides it' }],
  symbol: { kind: 'pullup' },
  spec: () => [1],
  netlist: () => ({
    level: 'switch',
    pins: { y: [4, 10] },
    pinDirs: { y: 'up' },
    instances: [{ name: 'vdd', def: VDD, at: [3, 0] }, { name: 'r', def: RES, at: [3, 3] }],
    nets: [{ name: 'vdd', ends: ['vdd.p', 'r.a'] }, { name: 'y', ends: ['r.b', 'y'] }],
  }),
  hdl: { verilog: 'module pullup_r (output y);\n  pullup (y);   // a pull-strength 1 that any driver overrides\nendmodule' },
});

export const PULLDOWN: ComponentDef = define({
  id: 'pulldown', name: 'Pull-down', category: 'transistor',
  summary: 'A resistor to GND: the node is 0 unless something stronger (any transistor) pulls it up.',
  ports: [{ name: 'y', width: 1, dir: 'out', tri: true, doc: 'weak 0: any driver overrides it' }],
  symbol: { kind: 'pulldown' },
  spec: () => [0],
  netlist: () => ({
    level: 'switch',
    pins: { y: [4, 0] },
    pinDirs: { y: 'down' },
    instances: [{ name: 'r', def: RES, at: [3, 2] }, { name: 'gnd', def: GND, at: [3, 8] }],
    nets: [{ name: 'y', ends: ['r.a', 'y'] }, { name: 'gnd', ends: ['gnd.p', 'r.b'] }],
  }),
  hdl: { verilog: 'module pulldown_r (output y);\n  pulldown (y); // a pull-strength 0 that any driver overrides\nendmodule' },
});

/**
 * Transmission gate: an NMOS and a PMOS in parallel, driven by complementary enables. The NMOS
 * passes a good 0, the PMOS a good 1, so together they pass both, in either direction.
 */
export const TGATE: ComponentDef = define({
  id: 'tgate', name: 'Transmission gate', category: 'cell',
  summary: 'An NMOS and a PMOS in parallel: a switch that passes 0 and 1 equally well, both ways, while en = 1 (and en_n = 0). Two transistors.',
  ports: [
    { name: 'a', width: 1, dir: 'inout' },
    { name: 'b', width: 1, dir: 'inout' },
    { name: 'en', width: 1, dir: 'in' },
    { name: 'en_n', width: 1, dir: 'in', doc: 'the complement of en' },
  ],
  symbol: { kind: 'tgate' },
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 2], b: [20, 10], en: [1, 6], en_n: [20, 6] },
    pinDirs: { b: 'left', en_n: 'left' },
    instances: [
      { name: 'n', def: NMOS, at: [6, 4] },
      { name: 'p', def: PMOS, at: [12, 4], flip: true },
    ],
    nets: [
      { name: 'a', ends: ['a', 'n.d', 'p.s'], via: { 'n.d': [[9, 2]], 'p.s': [[12, 2]] } },
      { name: 'b', ends: ['b', 'n.s', 'p.d'], via: { 'n.s': [[9, 10]], 'p.d': [[12, 10]] } },
      { name: 'en', ends: ['en', 'n.g'] },
      { name: 'en_n', ends: ['en_n', 'p.g'] },
    ],
  }),
  notes: `Why both? An NMOS passing a 1 stops conducting once its output rises to within a threshold of its
    gate (a weak, degraded 1); a PMOS does the same with 0. In parallel each covers the other's weak value.
    The cost is the complementary enable: a transmission gate needs en and en_n (one more inverter if only en exists).
    Multiplexers and latches built from transmission gates are smaller than their NAND versions.`,
  hdl: { verilog: 'module tgate (inout a, b, input en, en_n);\n  cmos t (b, a, en, en_n);   // (out, in, ncontrol, pcontrol); or: tranif1 + tranif0\nendmodule' },
});

/**
 * Tri-state inverter (clocked CMOS): an inverter with an enable transistor in each half. en = 0
 * opens both stacks and the output floats.
 */
export const TRIINV: ComponentDef = define({
  id: 'triinv', name: 'Tri-state inverter', category: 'cell',
  summary: 'y = NOT a while en = 1; with en = 0 both stacks are open and y floats (Z), so several can share a bus. Six transistors (two for en_n).',
  ports: [
    { name: 'a', width: 1, dir: 'in' },
    { name: 'en', width: 1, dir: 'in' },
    { name: 'y', width: 1, dir: 'out', tri: true, doc: 'Z while en = 0' },
  ],
  symbol: { kind: 'triinv' },
  spec: ([a, en]) => [en ? (a ? 0 : 1) : -1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 12], en: [1, 15], y: [18, 12] },
    instances: [
      { name: 'vdd', def: VDD, at: [12, 0] },
      { name: 'p1', def: PMOS, at: [10, 2] },
      { name: 'p2', def: PMOS, at: [10, 7] },
      { name: 'n2', def: NMOS, at: [10, 13] },
      { name: 'n1', def: NMOS, at: [10, 18] },
      { name: 'gnd', def: GND, at: [12, 24] },
      { name: 'inv', def: INV_CMOS, at: [5, 8], label: 'en_n' },
    ],
    nets: [
      { name: 'a', ends: ['a', 'p1.g', 'n1.g'], via: { 'p1.g': [[3, 12], [3, 4]], 'n1.g': [[3, 12], [3, 20]] } },
      { name: 'en', ends: ['en', 'n2.g', 'inv.a'], via: { 'n2.g': [[4, 15]], 'inv.a': [[4, 15], [4, 9]] } },
      { name: 'en_n', ends: ['inv.y', 'p2.g'] },
      { name: 'vdd', ends: ['vdd.p', 'p1.s'] },
      { name: 'm1', ends: ['p1.d', 'p2.s'] },
      { name: 'y', ends: ['p2.d', 'n2.d', 'y'], via: { y: [[13, 12]] } },
      { name: 'm2', ends: ['n2.s', 'n1.d'] },
      { name: 'gnd', ends: ['gnd.p', 'n1.s'] },
    ],
  }),
  notes: `The inner pair (p2, n2) is the enable: both off and the output is connected to nothing. The outer pair
    (p1, n1) is an ordinary inverter on a. Putting the enable next to the output keeps the output's capacitance
    away from a while disabled. Clocked CMOS latches are two of these in a loop.`,
  hdl: {
    verilog: `module triinv (input a, en, output y);
  supply1 vdd; supply0 gnd;
  wire en_n, m1, m2;
  not  i0 (en_n, en);
  pmos p1 (m1, vdd, a);  pmos p2 (y, m1, en_n);
  nmos n2 (y, m2, en);   nmos n1 (m2, gnd, a);
endmodule

// The same behaviour in one line:  notif1 (y, a, en);`,
  },
});

/** Tri-state buffer: an inverter in front of a tri-state inverter. */
export const TRIBUF: ComponentDef = define({
  id: 'tribuf', name: 'Tri-state buffer', category: 'cell',
  summary: 'y = a while en = 1; y floats (Z) while en = 0. Several on one wire make a shared bus: enable one at a time. Eight transistors.',
  ports: [
    { name: 'a', width: 1, dir: 'in' },
    { name: 'en', width: 1, dir: 'in' },
    { name: 'y', width: 1, dir: 'out', tri: true, doc: 'Z while en = 0' },
  ],
  symbol: { kind: 'tribuf' },
  spec: ([a, en]) => [en ? a : -1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 5], en: [1, 1], y: [16, 5] },
    instances: [
      { name: 'inv', def: INV_CMOS, at: [3, 4] },
      { name: 't', def: TRIINV, at: [8, 3] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'inv.a'] },
      { name: 'a_n', ends: ['inv.y', 't.a'] },
      { name: 'en', ends: ['en', 't.en'], via: { 't.en': [[10, 1]] } },
      { name: 'y', ends: ['t.y', 'y'] },
    ],
  }),
  notes: `A bus needs exactly one enabled driver. None: the wire floats (Z), unless a pull-up or pull-down holds it.
    Two that disagree: a short from VDD to GND through both (X), the bug a bus arbiter exists to prevent.`,
  hdl: { verilog: 'module tribuf (input a, en, output y);\n  bufif1 b (y, a, en);   // or: assign y = en ? a : 1\'bz;\nendmodule' },
});

/**
 * Pseudo-NMOS inverter: the PMOS of a CMOS inverter replaced by a pull-up resistor. The NMOS wins
 * while it conducts (ratioed logic); the price is current from VDD to GND for as long as a = 1.
 */
export const INV_PSEUDO: ComponentDef = define({
  id: 'inv_pseudo', name: 'Pseudo-NMOS inverter', category: 'cell',
  summary: 'A pull-up resistor and one NMOS: the NMOS overrides the resistor while a = 1. One transistor, but it draws current from VDD to GND the whole time a = 1.',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'not' },
  spec: ([a]) => [a ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 9], y: [12, 5] },
    instances: [
      { name: 'pu', def: PULLUP, at: [7, 0] },
      { name: 'n1', def: NMOS, at: [5, 7] },
      { name: 'gnd', def: GND, at: [7, 12] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'n1.g'] },
      { name: 'y', ends: ['n1.d', 'pu.y', 'y'], via: { y: [[8, 5]] } },
      { name: 'gnd', ends: ['gnd.p', 'n1.s'] },
    ],
  }),
  hdl: {
    verilog: `module inv_pseudo (input a, output y);
  supply0 gnd;
  pullup  (y);           // the resistor: a pull-strength 1
  nmos n1 (y, gnd, a);   // strong 0 while a = 1: overrides the pull-up
endmodule`,
  },
});
