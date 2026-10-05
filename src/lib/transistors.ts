// Level 0: transistors and CMOS cells (switch level).

import type { ComponentDef } from '../sim/types';
import { define } from './define';

export const NMOS: ComponentDef = define({
  id: 'nmos', name: 'NMOS transistor', category: 'transistor', prim: 'nmos',
  summary: 'A voltage-controlled switch: conducts between drain and source when the gate is 1.',
  ports: [
    { name: 'g', width: 1, dir: 'in', doc: 'gate' },
    { name: 'd', width: 1, dir: 'inout', doc: 'drain' },
    { name: 's', width: 1, dir: 'inout', doc: 'source' },
  ],
  symbol: { kind: 'nmos' },
  notes: `An n-channel MOSFET. A positive gate voltage pulls electrons into a thin channel under the
    gate oxide, connecting drain and source. NMOS passes a strong 0, so it is used in
    <em>pull-down</em> networks towards GND.`,
  hdl: { verilog: '// Verilog has a switch-level primitive for exactly this:\nnmos n1 (d, s, g);  // (drain, source, gate)' },
});

export const PMOS: ComponentDef = define({
  id: 'pmos', name: 'PMOS transistor', category: 'transistor', prim: 'pmos',
  summary: 'The complement of NMOS: conducts when the gate is 0.',
  ports: [
    { name: 'g', width: 1, dir: 'in', doc: 'gate' },
    { name: 's', width: 1, dir: 'inout', doc: 'source' },
    { name: 'd', width: 1, dir: 'inout', doc: 'drain' },
  ],
  symbol: { kind: 'pmos' },
  notes: `A p-channel MOSFET. It conducts when its gate is <em>low</em> and passes a strong 1, so it
    is used in <em>pull-up</em> networks towards VDD. The bubble on the gate marks the inversion.`,
  hdl: { verilog: 'pmos p1 (d, s, g);  // (drain, source, gate)' },
});

export const VDD: ComponentDef = define({
  id: 'vdd', name: 'VDD', category: 'transistor', prim: 'vdd',
  summary: 'The positive supply rail: logic 1.',
  ports: [{ name: 'p', width: 1, dir: 'out' }],
  symbol: { kind: 'vdd' },
  hdl: { verilog: 'supply1 vdd;' },
});

export const GND: ComponentDef = define({
  id: 'gnd', name: 'GND', category: 'transistor', prim: 'gnd',
  summary: 'Ground: logic 0.',
  ports: [{ name: 'p', width: 1, dir: 'out' }],
  symbol: { kind: 'gnd' },
  hdl: { verilog: 'supply0 gnd;' },
});

/** Stand-alone switch demos for chapter 1: one transistor, a load, an input. */
export const NMOS_SWITCH: ComponentDef = define({
  id: 'nmos_switch', name: 'NMOS as a switch', category: 'transistor',
  summary: 'One NMOS between an output node and GND. Gate = 1 pulls the node to 0; gate = 0 leaves it floating (Z).',
  ports: [{ name: 'g', width: 1, dir: 'in' }, { name: 'out', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: 'NMOS switch' },
  netlist: () => ({
    level: 'switch',
    pins: { g: [1, 7], out: [12, 4] },
    instances: [
      { name: 'n1', def: NMOS, at: [5, 5] },
      { name: 'gnd', def: GND, at: [7, 11] },
    ],
    nets: [
      { name: 'g', ends: ['g', 'n1.g'] },
      { name: 'out', ends: ['n1.d', 'out'] },
      { name: 'gnd', ends: ['gnd.p', 'n1.s'] },
    ],
  }),
});

export const PMOS_SWITCH: ComponentDef = define({
  id: 'pmos_switch', name: 'PMOS as a switch', category: 'transistor',
  summary: 'One PMOS between VDD and an output node. Gate = 0 pulls the node to 1; gate = 1 leaves it floating (Z).',
  ports: [{ name: 'g', width: 1, dir: 'in' }, { name: 'out', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: 'PMOS switch' },
  netlist: () => ({
    level: 'switch',
    pins: { g: [1, 5], out: [12, 8] },
    instances: [
      { name: 'vdd', def: VDD, at: [7, 0] },
      { name: 'p1', def: PMOS, at: [5, 3] },
    ],
    nets: [
      { name: 'g', ends: ['g', 'p1.g'] },
      { name: 'vdd', ends: ['vdd.p', 'p1.s'] },
      { name: 'out', ends: ['p1.d', 'out'] },
    ],
  }),
});

export const INV_CMOS: ComponentDef = define({
  id: 'inv_cmos', name: 'CMOS inverter', category: 'cell',
  summary: 'One PMOS pull-up and one NMOS pull-down: exactly one of them conducts for a valid input.',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'not' },
  spec: ([a]) => [a ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 8], y: [12, 8] },
    instances: [
      { name: 'vdd', def: VDD, at: [7, 0] },
      { name: 'p1', def: PMOS, at: [5, 3] },
      { name: 'n1', def: NMOS, at: [5, 9] },
      { name: 'gnd', def: GND, at: [7, 14] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'p1.g', 'n1.g'], trunk: 3 },
      { name: 'vdd', ends: ['vdd.p', 'p1.s'] },
      { name: 'y', ends: ['p1.d', 'n1.d', 'y'] },
      { name: 'gnd', ends: ['gnd.p', 'n1.s'] },
    ],
  }),
  hdl: {
    verilog: `module inv_cmos (input a, output y);
  supply1 vdd; supply0 gnd;
  pmos p1 (y, vdd, a);   // pull-up:   on when a = 0
  nmos n1 (y, gnd, a);   // pull-down: on when a = 1
endmodule`,
  },
});

export const NOR_CMOS: ComponentDef = define({
  id: 'nor_cmos', name: 'CMOS NOR', category: 'cell',
  summary: 'Two PMOS in series (pull-up), two NMOS in parallel (pull-down).',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'nor' },
  spec: ([a, b]) => [a | b ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 4], b: [1, 9], y: [17, 12] },
    instances: [
      { name: 'vdd', def: VDD, at: [12, 0] },
      { name: 'p1', def: PMOS, at: [10, 2] },
      { name: 'p2', def: PMOS, at: [10, 7] },
      { name: 'n2', def: NMOS, at: [4, 13] },
      { name: 'n1', def: NMOS, at: [10, 13] },
      { name: 'gnd', def: GND, at: [9, 19] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'p1.g', 'n1.g'], trunk: 8.5 },
      { name: 'b', ends: ['b', 'p2.g', 'n2.g'], trunk: 2.5 },
      { name: 'vdd', ends: ['vdd.p', 'p1.s'] },
      { name: 'm', ends: ['p1.d', 'p2.s'] },
      { name: 'y', ends: ['p2.d', 'n1.d', 'n2.d', 'y'] },
      { name: 'gnd', ends: ['gnd.p', 'n1.s', 'n2.s'] },
    ],
  }),
  hdl: {
    verilog: `module nor_cmos (input a, b, output y);
  supply1 vdd; supply0 gnd;
  wire m;
  pmos p1 (m, vdd, a);  pmos p2 (y, m, b);     // series pull-up
  nmos n1 (y, gnd, a);  nmos n2 (y, gnd, b);   // parallel pull-down
endmodule`,
  },
});

/**
 * The brick. At gate level the NAND is a primitive with one unit of delay; open it and you
 * find its four transistors.
 */
export const NAND: ComponentDef = define({
  id: 'nand', name: 'NAND', category: 'gate', prim: 'nand',
  summary: 'Output is 0 only when both inputs are 1. Four transistors. Every gate above this level is built from it.',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'nand' },
  spec: ([a, b]) => [a & b ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 5], b: [1, 17], y: [19, 8] },
    instances: [
      { name: 'vdd', def: VDD, at: [10, 0] },
      { name: 'p1', def: PMOS, at: [6, 3] },
      { name: 'p2', def: PMOS, at: [12, 3] },
      { name: 'n1', def: NMOS, at: [12, 10] },
      { name: 'n2', def: NMOS, at: [12, 15] },
      { name: 'gnd', def: GND, at: [14, 20] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'p1.g', 'n1.g'], trunk: 3 },
      { name: 'b', ends: ['b', 'p2.g', 'n2.g'], trunk: 10.5 },
      { name: 'vdd', ends: ['vdd.p', 'p1.s', 'p2.s'] },
      { name: 'y', ends: ['p2.d', 'p1.d', 'n1.d', 'y'] },
      { name: 'm', ends: ['n1.s', 'n2.d'] },
      { name: 'gnd', ends: ['gnd.p', 'n2.s'] },
    ],
  }),
  hdl: {
    verilog: `module nand2 (input a, b, output y);
  assign y = ~(a & b);
endmodule

// The same cell at switch level:
module nand2_cmos (input a, b, output y);
  supply1 vdd; supply0 gnd;
  wire m;
  pmos p1 (y, vdd, a);  pmos p2 (y, vdd, b);   // parallel pull-up
  nmos n1 (y, m, a);    nmos n2 (m, gnd, b);   // series pull-down
endmodule`,
  },
  notes: `Why NAND and not AND? A CMOS stage is naturally <em>inverting</em>: the pull-down
    network pulls the output low when its condition is true. An AND needs a NAND plus an
    inverter (6 transistors). NAND also beats NOR: its slow PMOS devices sit in parallel and its
    fast NMOS devices in series, which is the cheaper way round.`,
});

/** Tie cells: constant 0 / 1, wired straight to a rail. */
export const TIE0: ComponentDef = define({
  id: 'tie0', name: 'Constant 0', category: 'plumbing',
  summary: 'A wire tied to GND.',
  ports: [{ name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: '0', w: 2, h: 2 },
  behavior: { eval: () => [0] },
  spec: () => [0],
  netlist: () => ({
    level: 'switch', pins: { y: [6, 1] },
    instances: [{ name: 'gnd', def: GND, at: [1, 2] }],
    nets: [{ ends: ['gnd.p', 'y'] }],
  }),
});

export const TIE1: ComponentDef = define({
  id: 'tie1', name: 'Constant 1', category: 'plumbing',
  summary: 'A wire tied to VDD.',
  ports: [{ name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: '1', w: 2, h: 2 },
  behavior: { eval: () => [1] },
  spec: () => [1],
  netlist: () => ({
    level: 'switch', pins: { y: [6, 2] },
    instances: [{ name: 'vdd', def: VDD, at: [1, 0] }],
    nets: [{ ends: ['vdd.p', 'y'] }],
  }),
});
