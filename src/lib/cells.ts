// Level 4b: memory cells at transistor level. The flip-flop register (level 3) costs dozens of
// transistors per bit; dense memories use a 6-transistor SRAM cell or a 1-transistor DRAM cell.
// Both rely on things a gate-level model cannot express: transistor strength (a write driver
// overpowers the cell) and stored charge (bit lines, DRAM capacitors). The switch-level
// simulator models both (NetDef.cap, ComponentDef.strength).

import type { ComponentDef } from '../sim/types';
import { define } from './define';
import { GND, NMOS, PMOS, VDD } from './transistors';

/** A wide (strong) NMOS: SRAM pull-downs and write drivers. */
export const NMOS_STRONG: ComponentDef = define({
  ...NMOS, id: 'nmos_strong', name: 'NMOS (wide, strong)', strength: 4,
  summary: 'A wider NMOS: more current, so it wins a fight against a narrower transistor.',
});

/** A narrow (weak) PMOS: SRAM pull-ups. */
export const PMOS_WEAK: ComponentDef = define({
  ...PMOS, id: 'pmos_weak', name: 'PMOS (narrow, weak)', strength: 2,
  summary: 'A narrow PMOS: just enough current to hold a node high, easily overpowered by a write driver.',
});

/**
 * The 6T SRAM cell: two cross-coupled inverters (the storage loop) and two access transistors
 * that connect q and q̄ to the bit lines while the word line is high. Pull-down (strong) >
 * access (normal) > pull-up (weak): reads cannot flip the cell, writes can.
 */
export const SRAM_CELL: ComponentDef = define({
  id: 'sram6t', name: '6T SRAM cell', category: 'memory',
  summary: 'Two cross-coupled inverters hold the bit; two access transistors connect it to the bit lines while the word line is high. Six transistors per bit.',
  ports: [{ name: 'wl', width: 1, dir: 'in' }, { name: 'bl', width: 1, dir: 'inout' }, { name: 'blb', width: 1, dir: 'inout' }],
  symbol: { kind: 'box', label: '6T', w: 6, h: 6 },
  netlist: () => ({
    level: 'switch',
    pins: { wl: [0, 26], bl: [2, 0], blb: [40, 0] },
    pinDirs: { bl: 'down', blb: 'down' },
    instances: [
      { name: 'a1', def: NMOS, at: [6, 9] },
      { name: 'vdd1', def: VDD, at: [16, 1] },
      { name: 'p1', def: PMOS_WEAK, at: [14, 4] },
      { name: 'n1', def: NMOS_STRONG, at: [14, 14] },
      { name: 'gnd1', def: GND, at: [16, 20] },
      { name: 'vdd2', def: VDD, at: [26, 1] },
      { name: 'p2', def: PMOS_WEAK, at: [24, 4] },
      { name: 'n2', def: NMOS_STRONG, at: [24, 14] },
      { name: 'gnd2', def: GND, at: [26, 20] },
      { name: 'a2', def: NMOS, at: [34, 9] },
    ],
    nets: [
      { name: 'wl', ends: ['wl', 'a1.g', 'a2.g'], via: { 'a1.g': [[4, 26], [4, 11]], 'a2.g': [[32, 26], [32, 11]] } },
      { name: 'bl', ends: ['bl', 'a1.d'], via: { 'a1.d': [[2, 7], [9, 7]] } },
      { name: 'blb', ends: ['blb', 'a2.d'], via: { 'a2.d': [[40, 7], [37, 7]] } },
      { ends: ['vdd1.p', 'p1.s'] }, { ends: ['vdd2.p', 'p2.s'] },
      { ends: ['gnd1.p', 'n1.s'] }, { ends: ['gnd2.p', 'n2.s'] },
      { name: 'q', ends: ['p1.d', 'n1.d', 'a1.s', 'p2.g', 'n2.g'], via: { 'a1.s': [[9, 12]], 'p2.g': [[20, 11], [20, 6]], 'n2.g': [[20, 11], [20, 16]] } },
      { name: 'q̄', ends: ['p2.d', 'n2.d', 'a2.s', 'p1.g', 'n1.g'], via: { 'a2.s': [[37, 12]], 'p1.g': [[30, 11], [30, 23], [12, 23], [12, 6]], 'n1.g': [[12, 23], [12, 16]] } },
    ],
  }),
  notes: `Sizing makes it work. Reading: the bit lines are precharged high and the side storing 0 pulls its bit line
    down through the access transistor and the strong pull-down, without the node rising enough to flip the cell.
    Writing: a strong driver pulls one bit line low; the access transistor overpowers the weak pull-up on that side and
    the loop flips. (In this model: pull-down strength 4 &gt; access 3 &gt; pull-up 2.)`,
  hdl: {
    verilog: `module sram6t (input wl, inout bl, blb);
  supply1 vdd; supply0 gnd;
  wire q, qb;
  rpmos p1 (q,  vdd, qb);  nmos n1 (q,  gnd, qb);   // inverter 1 (weak pull-up)
  rpmos p2 (qb, vdd, q);   nmos n2 (qb, gnd, q);    // inverter 2
  tranif1 a1 (bl,  q,  wl);                         // access transistors
  tranif1 a2 (blb, qb, wl);
endmodule`,
  },
});

/**
 * A two-cell SRAM column: shared bit lines with PMOS precharge, two write drivers (pull a bit line
 * low to write) and one word line per cell. The bit lines are capacitive: when nothing drives
 * them they keep their precharged value until a cell discharges one.
 */
export const SRAM_COLUMN: ComponentDef = define({
  id: 'sramcol2', name: 'SRAM column (2 cells)', category: 'memory',
  summary: 'Bit lines shared by every cell in the column, precharged high; a word line connects one cell. Read: the cell discharges bl (stored 0) or bl̄ (stored 1). Write: a strong driver pulls one bit line low and flips the cell.',
  ports: [
    { name: 'pre_n', width: 1, dir: 'in' }, { name: 'w0', width: 1, dir: 'in' }, { name: 'w1', width: 1, dir: 'in' },
    { name: 'wl0', width: 1, dir: 'in' }, { name: 'wl1', width: 1, dir: 'in' },
    { name: 'bl', width: 1, dir: 'out' }, { name: 'blb', width: 1, dir: 'out' },
  ],
  symbol: { kind: 'box', label: 'SRAM ×2' },
  netlist: () => ({
    level: 'switch',
    pins: { pre_n: [0, 4], w0: [0, 48], w1: [0, 52], wl0: [0, 20], wl1: [0, 32], bl: [42, 10], blb: [42, 14] },
    instances: [
      { name: 'vdd', def: VDD, at: [12, 0] },
      { name: 'pre0', def: PMOS, at: [10, 2] },
      { name: 'pre1', def: PMOS, at: [26, 2] },
      { name: 'vdd1', def: VDD, at: [28, 0] },
      { name: 'c0', def: SRAM_CELL, at: [14, 16], label: 'cell 0' },
      { name: 'c1', def: SRAM_CELL, at: [14, 28], label: 'cell 1' },
      { name: 'd0', def: NMOS_STRONG, at: [10, 44], label: 'write 0' },
      { name: 'd1', def: NMOS_STRONG, at: [26, 44], label: 'write 1' },
      { name: 'g0', def: GND, at: [12, 50] }, { name: 'g1', def: GND, at: [28, 50] },
    ],
    nets: [
      { name: 'pre_n', ends: ['pre_n', 'pre0.g', 'pre1.g'], via: { 'pre1.g': [[8, 4], [8, 1], [24, 1], [24, 4]] } },
      { ends: ['vdd.p', 'pre0.s'] }, { ends: ['vdd1.p', 'pre1.s'] },
      { name: 'bl', cap: true, ends: ['pre0.d', 'c0.bl', 'c1.bl', 'd0.d', 'bl'], trunk: 13 },
      { name: 'bl̄', cap: true, ends: ['pre1.d', 'c0.blb', 'c1.blb', 'd1.d', 'blb'], trunk: 29 },
      { name: 'wl0', ends: ['wl0', 'c0.wl'] }, { name: 'wl1', ends: ['wl1', 'c1.wl'] },
      { name: 'w0', ends: ['w0', 'd0.g'] }, { name: 'w1', ends: ['w1', 'd1.g'] },
      { ends: ['g0.p', 'd0.s'] }, { ends: ['g1.p', 'd1.s'] },
    ],
  }),
});

/**
 * The 1T1C DRAM cell: one access transistor and a capacitor. With the word line low the storage
 * node floats and keeps its charge (for a few tens of milliseconds, in silicon).
 */
export const DRAM_CELL: ComponentDef = define({
  id: 'dram1t1c', name: '1T1C DRAM cell', category: 'memory',
  summary: 'One transistor and one capacitor per bit. Word line high: the bit line charges or discharges the capacitor. Word line low: the charge stays (and slowly leaks away, hence refresh).',
  ports: [{ name: 'wl', width: 1, dir: 'in' }, { name: 'bl', width: 1, dir: 'in' }, { name: 'q', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: '1T1C' },
  netlist: () => ({
    level: 'switch',
    pins: { wl: [0, 6], bl: [6, 0], q: [20, 10] },
    pinDirs: { bl: 'down' },
    instances: [{ name: 'a', def: NMOS, at: [3, 4] }],
    nets: [
      { name: 'wl', ends: ['wl', 'a.g'] },
      { name: 'bl', ends: ['bl', 'a.d'] },
      { name: 'storage (C)', cap: true, ends: ['a.s', 'q'], via: { q: [[6, 10]] } },
    ],
  }),
});
