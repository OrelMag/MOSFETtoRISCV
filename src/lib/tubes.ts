// Prologue P2's vacuum tubes at switch level (prim 'triode' and 'diode', SwitchSim). A triode conducts from plate to
// cathode while its grid is 1, and only that way: it pulls its plate down (or its cathode up), never passes a signal
// back. Its plate resistor pulls the plate up: ratioed logic, like pseudo-NMOS. The plate swings between about 81 V
// (conducting) and 250 V (cut off) while a grid needs 0 V to conduct and −12.5 V to cut off, so every gate reads its
// inputs through a divider to −150 V (phys/triode.ts computes the levels). Strengths here say which path decides a
// node, not how many ohms it has: the tube (3) beats its plate resistor (1); the divider's top resistor (2) carries
// the plate's value to the grid whichever pulled the plate (a resistor as weak as the plate resistor would also carry
// the losing pull-up's 1 and make the grid X); its bottom leg (a bias resistor, 0) only holds a grid nothing else
// reaches. Values are logic levels; the voltages are in the labels.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { netlistOf } from '../sim/types';
import { FULL_ADDER } from './combinational';
import { define } from './define';
import { RES } from './switchparts';
import { GND, NAND } from './transistors';

const bit = (name: string, dir: 'in' | 'out' | 'inout', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });

export const TRIODE: ComponentDef = define({
  id: 'triode', name: 'Triode', category: 'transistor', prim: 'triode',
  summary: 'One section of a 6SN7: current flows from plate to cathode while the grid is 1, and never the other way.',
  ports: [
    { name: 'g', width: 1, dir: 'in', doc: 'grid' },
    { name: 'p', width: 1, dir: 'inout', doc: 'plate (anode)' },
    { name: 'k', width: 1, dir: 'inout', doc: 'cathode' },
  ],
  symbol: { kind: 'triode' },
  notes: `A heated cathode boils off electrons; the positive plate collects them. The grid, a wire mesh between the two,
    decides how many get through: at 0 V nearly all, below about −12.5 V (with the plate at 250 V) none. Electrons only
    leave the hot cathode, so current flows plate to cathode only: a triode can pull its plate down or its cathode up,
    but never carries a signal back the way a contact or a MOSFET channel does. In this model it is a one-way switch of
    strength 3 that the grid closes at 1. A 6SN7 holds two of these sections in one bulb.`,
  hdl: { verilog: '// a triode section: grid, plate, cathode (a vacuum tube: not Verilog)' },
});

export const DIODE: ComponentDef = define({
  id: 'vdiode', name: 'Vacuum diode', category: 'transistor', prim: 'diode',
  summary: 'One section of a 6AL5: a hot cathode and a plate, no grid. Current flows from plate (a) to cathode (k) only.',
  ports: [{ name: 'a', width: 1, dir: 'inout', doc: 'plate (anode)' }, { name: 'k', width: 1, dir: 'inout', doc: 'cathode' }],
  symbol: { kind: 'diode' },
  notes: `A tube with no grid: electrons go from the hot cathode to the plate whenever the plate is the more positive,
    never back. Wired from a node to several inputs, diodes let any input at 0 pull the node down while an input at 1
    cannot pull it up: an AND. In this model a one-way switch of strength 3 that is always closed.`,
  hdl: { verilog: '// a vacuum diode: anode, cathode (conducts one way: not Verilog)' },
});

/** The plate supply, +250 V: logic 1. */
export const B_PLUS: ComponentDef = define({
  id: 'bplus', name: 'B+ (+250 V)', category: 'transistor', prim: 'vdd',
  summary: 'The plate supply of a tube circuit, +250 V: logic 1.',
  ports: [{ name: 'p', width: 1, dir: 'out' }],
  symbol: { kind: 'vdd', label: '+250 V' },
  hdl: { verilog: 'supply1 bplus;' },
});

/** The bias supply, −150 V, at the bottom of every divider: logic 0. */
export const V_NEG: ComponentDef = define({
  id: 'vneg', name: 'Bias (−150 V)', category: 'transistor', prim: 'gnd',
  summary: 'The negative bias supply of a tube circuit, −150 V, at the bottom of every divider: logic 0.',
  ports: [{ name: 'p', width: 1, dir: 'out' }],
  symbol: { kind: 'gnd', label: '−150 V' },
  hdl: { verilog: 'supply0 vneg;' },
});

/** A divider's leg to the bias rail: weaker than any resistor, so it decides the grid only when nothing else does. */
export const RES_BIAS: ComponentDef = define({
  ...RES, id: 'res_bias', name: 'Bias resistor', strength: 0,
  summary: 'A resistor to a bias rail, at strength 0: any other resistor overrides it (a divider\'s bottom leg).',
  notes: `In a tube divider the top resistor (from the plate) and the bottom one (to −150 V) both conduct all the time,
    and the grid sits at the voltage between them. Which logic value that is depends on the plate, so in this model the
    top leg (strength 2) decides and the bottom leg (strength 0) only holds a grid nothing else reaches.`,
});

/** A divider's top resistor: it hands the plate's value, whichever path decided it, on to the next grid. */
export const RES_DIV: ComponentDef = define({
  ...RES, id: 'res_div', name: 'Divider resistor', strength: 2,
  summary: 'The top leg of a tube divider, at strength 2: between a plate resistor (1) and a tube (3), so the grid follows the plate.',
  notes: `The plate it reads is pulled up by its plate resistor and down by its tube; the tube wins. Seen from the grid, the
    plate is just a voltage, so the divider must carry the winner: in this model it is stronger than the plate resistor
    and weaker than the tube. (Its 625 kΩ is far more resistance than the plate's 22 kΩ: strength here is which path
    decides a node, not ohms.)`,
});

/** Resistor labels (the voltages and values are phys/triode.ts's). */
const R_PLATE = '22 kΩ', R_TOP = '625 kΩ', R_BOTTOM = '375 kΩ';

/**
 * A divider at column x (its resistors' left edge), top terminal at y: the top resistor, the bias resistor, the
 * bias rail. Its middle is `${p}1.b` / `${p}2.a`.
 */
function divider(p: string, x: number, y: number): { instances: InstanceDef[]; nets: NetDef[] } {
  return {
    instances: [
      { name: `${p}1`, def: RES_DIV, at: [x, y], label: R_TOP },
      { name: `${p}2`, def: RES_BIAS, at: [x, y + 5], label: R_BOTTOM },
      { name: `${p}n`, def: V_NEG, at: [x, y + 10] },
    ],
    nets: [{ name: `${p} bias`, ends: [`${p}2.b`, `${p}n.p`] }],
  };
}

/** A triode at (x, y) with its cathode on GND below it. */
const triodeAt = (name: string, x: number, y: number, flip = false): InstanceDef[] => [
  { name, def: TRIODE, at: [x, y], flip, label: name.toUpperCase() },
  { name: `${name}g`, def: GND, at: [x + 1, y + 6] },
];
const cathode = (name: string): NetDef => ({ name: `${name} cathode`, ends: [`${name}.k`, `${name}g.p`] });

/** A plate resistor at (x, y) under its B+ rail. */
const plateRes = (name: string, x: number, y: number): InstanceDef[] => [
  { name: `${name}v`, def: B_PLUS, at: [x, y - 1] },
  { name, def: RES, at: [x, y], label: R_PLATE },
];
const supply = (name: string): NetDef => ({ name: `${name} B+`, ends: [`${name}v.p`, `${name}.a`] });

/** The grid driven straight from the input: the triode as a switch (prologue P2, "The grid"). */
export const TRIODE_SWITCH: ComponentDef = define({
  id: 'triode_switch', name: 'Triode as a switch', category: 'transistor',
  summary: 'One triode under a plate resistor. Grid 1: current flows and the plate falls to 0. Grid 0: cut off, the resistor pulls the plate to 1.',
  ports: [bit('g', 'in'), bit('y', 'out')],
  symbol: { kind: 'box', label: 'triode' },
  spec: ([g]) => [g ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { g: [1, 10], y: [12, 7] },
    instances: [...plateRes('rl', 5, 3), ...triodeAt('v1', 4, 8)],
    nets: [
      supply('rl'), cathode('v1'),
      { name: 'g', ends: ['g', 'v1.g'] },
      { name: 'y', ends: ['rl.b', 'v1.p', 'y'] },
    ],
  }),
});

/** An inverter that reads a plate: the divider shifts it to grid levels. */
export const TUBE_INV: ComponentDef = define({
  id: 'tube_inv', name: 'Tube inverter', category: 'gate',
  summary: 'A triode, its plate resistor, and the divider that shifts the input (a plate: 81 or 250 V) down to grid levels (−46 or −3 V).',
  ports: [bit('a', 'in'), bit('y', 'out')],
  symbol: { kind: 'not' },
  spec: ([a]) => [a ? 0 : 1],
  netlist: () => {
    const d = divider('r', 4, 6);
    return {
      level: 'switch',
      pins: { a: [1, 6], y: [18, 7] },
      instances: [...d.instances, ...plateRes('rl', 12, 3), ...triodeAt('v1', 11, 8)],
      nets: [
        ...d.nets, supply('rl'), cathode('v1'),
        { name: 'a', ends: ['a', 'r1.a'] },
        { name: 'grid', ends: ['r1.b', 'r2.a', 'v1.g'] },
        { name: 'y', ends: ['rl.b', 'v1.p', 'y'] },
      ],
    };
  },
});

/** Two triodes on one plate resistor: either one conducting pulls the plate down. The tube's natural gate. */
export const TUBE_NOR: ComponentDef = define({
  id: 'tube_nor', name: 'Tube NOR', category: 'gate',
  summary: 'Two triodes in parallel under one plate resistor, each grid behind its own divider: the plate is 1 only while both are cut off.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'nor' },
  spec: ([a, b]) => [a | b ? 0 : 1],
  netlist: () => {
    const da = divider('ra', 4, 6), db = divider('rb', 4, 20);
    return {
      level: 'switch',
      pins: { a: [1, 6], b: [1, 20], y: [21, 7] },
      instances: [...da.instances, ...db.instances, ...plateRes('rl', 12, 3), ...triodeAt('va', 11, 8), ...triodeAt('vb', 11, 22)],
      nets: [
        ...da.nets, ...db.nets, supply('rl'), cathode('va'), cathode('vb'),
        { name: 'a', ends: ['a', 'ra1.a'] }, { name: 'b', ends: ['b', 'rb1.a'] },
        { name: 'grid a', ends: ['ra1.b', 'ra2.a', 'va.g'] },
        { name: 'grid b', ends: ['rb1.b', 'rb2.a', 'vb.g'] },
        { name: 'y', ends: ['rl.b', 'va.p', 'vb.p', 'y'], via: { 'vb.p': [[13, 7], [17, 7], [17, 20], [13, 20]] } },
      ],
    };
  },
});

/**
 * NAND, the brick: two diodes form an AND (an input at 0 pulls the junction down, one at 1 cannot pull it up), the
 * divider shifts the junction to the grid, the triode inverts. One triode section and a diode pair per NAND.
 */
export const TUBE_NAND: ComponentDef = define({
  id: 'tube_nand', name: 'Tube NAND', category: 'gate',
  summary: 'A diode AND (half a 6AL5 per input) into a triode inverter (half a 6SN7): the brick a NAND-mapped tube machine is built from.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'nand' },
  spec: ([a, b]) => [a & b ? 0 : 1],
  netlist: () => {
    const d = divider('r', 14, 7);
    return {
      level: 'switch',
      pins: { a: [1, 12], b: [1, 14], y: [27, 8] },
      instances: [
        { name: 'da', def: DIODE, at: [3, 6], label: 'D1' }, { name: 'db', def: DIODE, at: [8, 6], label: 'D2' },
        { name: 'rjv', def: B_PLUS, at: [14, 1] }, { name: 'rj', def: RES, at: [14, 2], label: '470 kΩ' },
        ...d.instances, ...plateRes('rl', 20, 3), ...triodeAt('v1', 19, 9),
      ],
      nets: [
        ...d.nets, supply('rl'), cathode('v1'), { name: 'rj B+', ends: ['rjv.p', 'rj.a'] },
        { name: 'a', ends: ['a', 'da.k'] }, { name: 'b', ends: ['b', 'db.k'] },
        { name: 'and', ends: ['rj.b', 'r1.a', 'da.a', 'db.a'] },
        { name: 'grid', ends: ['r1.b', 'r2.a', 'v1.g'] },
        { name: 'y', ends: ['rl.b', 'v1.p', 'y'] },
      ],
    };
  },
});

/**
 * Cathode follower: the plate on B+, the output taken from the cathode, which follows the grid. It inverts nothing and
 * gains nothing in voltage, but the tube drives its load hard, so one plate's divider can feed many grids through it.
 */
export const CATHODE_FOLLOWER: ComponentDef = define({
  id: 'cathode_follower', name: 'Cathode follower', category: 'gate',
  summary: 'The plate on B+, the output on the cathode: it follows the grid at grid levels, strong enough to drive many grids.',
  ports: [bit('a', 'in'), bit('y', 'out')],
  symbol: { kind: 'buf' },
  spec: ([a]) => [a],
  netlist: () => {
    const d = divider('r', 4, 6);
    return {
      level: 'switch',
      pins: { a: [1, 6], y: [18, 12] },
      instances: [
        ...d.instances,
        { name: 'v1v', def: B_PLUS, at: [12, 6] }, { name: 'v1', def: TRIODE, at: [11, 8], label: 'V1' },
        { name: 'rk', def: RES, at: [12, 13], label: '47 kΩ' }, { name: 'rkn', def: V_NEG, at: [12, 18] },
      ],
      nets: [
        ...d.nets,
        { name: 'a', ends: ['a', 'r1.a'] },
        { name: 'grid', ends: ['r1.b', 'r2.a', 'v1.g'] },
        { name: 'B+', ends: ['v1v.p', 'v1.p'] },
        { name: 'y', ends: ['v1.k', 'rk.a', 'y'] },
        { name: 'rk bias', ends: ['rk.b', 'rkn.p'] },
      ],
    };
  },
});

/**
 * The Eccles–Jordan flip-flop (1918): two triodes, each plate holding the other's grid through a divider. One of them
 * conducts and keeps the other cut off, which keeps it conducting. set (through a steering diode) turns on the right
 * tube, so the left plate rises: q = 1; reset turns on the left one. One twin triode holds one bit.
 */
export const ECCLES_JORDAN: ComponentDef = define({
  id: 'eccles_jordan', name: 'Eccles–Jordan flip-flop', category: 'sequential',
  summary: 'Two cross-coupled triodes (one 6SN7) and two steering diodes: a bit that holds itself, set and reset by a 1 on either grid.',
  ports: [bit('set', 'in', 'top'), bit('reset', 'in', 'top'), bit('q', 'out'), bit('nq', 'out')],
  symbol: { kind: 'box', label: 'E–J', w: 8, h: 4 },
  netlist: () => {
    const X = 2;
    const db = divider('rb', X + 1, 11), da = divider('ra', X + 33, 11);
    return {
      level: 'switch',
      pins: { set: [X + 30, 0], reset: [X + 8, 0], q: [X + 39, 10], nq: [0, 8] },
      pinDirs: { set: 'down', reset: 'down', nq: 'right' },
      instances: [
        ...db.instances, ...da.instances,
        ...plateRes('rla', X + 11, 3), ...plateRes('rlb', X + 25, 3),
        ...triodeAt('va', X + 10, 12), ...triodeAt('vb', X + 24, 12, true),
        { name: 'dr', def: DIODE, at: [X + 6, 2], label: 'D1' }, { name: 'ds', def: DIODE, at: [X + 28, 2], label: 'D2' },
      ],
      nets: [
        ...db.nets, ...da.nets, supply('rla'), supply('rlb'), cathode('va'), cathode('vb'),
        { name: 'q', ends: ['va.p', 'rla.b', 'ra1.a', 'q'], via: { 'ra1.a': [[X + 12, 10], [X + 34, 10]] } },
        { name: 'nq', ends: ['vb.p', 'rlb.b', 'rb1.a', 'nq'], via: { 'rb1.a': [[X + 26, 8], [X + 2, 8]] } },
        { name: 'grid a', ends: ['va.g', 'rb1.b', 'rb2.a', 'dr.k'], trunk: X + 8 },
        { name: 'grid b', ends: ['vb.g', 'ra1.b', 'ra2.a', 'ds.k'], trunk: X + 30 },
        { name: 'set', ends: ['set', 'ds.a'] }, { name: 'reset', ends: ['reset', 'dr.a'] },
      ],
    };
  },
});

/** The nine-NAND full adder (chapter 6) with every NAND a tube NAND: the brick principle, in tubes. */
export const TUBE_FA: ComponentDef = define({
  id: 'tube_fa', name: 'Tube full adder', category: 'arithmetic',
  summary: 'Chapter 6\'s nine-NAND full adder with every NAND built from tubes: 9 triode sections and 18 diodes.',
  ports: FULL_ADDER.ports,
  symbol: { kind: 'box', label: 'FA (tubes)' },
  spec: FULL_ADDER.spec,
  netlist: () => {
    const nl = netlistOf(FULL_ADDER)!;
    return { ...nl, level: 'switch', instances: nl.instances.map((i) => (i.def === NAND ? { ...i, def: TUBE_NAND } : i)) };
  },
});
