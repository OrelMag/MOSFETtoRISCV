// Small circuits for Appendix A's first steps, drawn by hand: the two-phase bit and one line of a
// precharged bus. Both are built from the 6502's own cells, so what the learner pokes here is what
// the chip is made of.

import type { ComponentDef } from '../../sim/types';
import { define } from '../define';
import { NINV } from '../nmos';
import { GND, NMOS, VDD } from '../transistors';
import { DLAT } from './cells';

/** A master–slave bit from two dynamic latches on opposite phases: 6 transistors (4 + 2 loads). */
export const MS_BIT: ComponentDef = define({
  id: 'm65_msbit', name: 'Two-phase bit', category: 'cell',
  summary: 'A dynamic latch open in φ1, then one open in φ2: a bit that moves one stage per phase and is never transparent end to end, because φ1 and φ2 are never high together.',
  ports: [{ name: 'd', width: 1, dir: 'in' }, { name: 'p1', width: 1, dir: 'in' }, { name: 'p2', width: 1, dir: 'in' }, { name: 'q', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: 'MS BIT' },
  netlist: () => ({
    level: 'switch',
    pins: { d: [1, 4], p1: [1, 6], p2: [1, 10], q: [40, 4] },
    instances: [{ name: 'master', def: DLAT, at: [8, 2] }, { name: 'slave', def: DLAT, at: [24, 2] }],
    nets: [
      { name: 'd', ends: ['d', 'master.d'] },
      { name: 'p1', ends: ['p1', 'master.en'] },
      { name: 'p2', ends: ['p2', 'slave.en'], via: { 'slave.en': [[20, 10], [20, 6]] } },
      { name: 'm', ends: ['master.nq', 'slave.d'] },
      { name: 'q', ends: ['slave.nq', 'q'] },
    ],
  }),
});

/**
 * One line of a precharged bus: φ2 precharges it to 1 through a transistor from VDD; in φ1 a
 * source pulls it to 0 when it is enabled and its bit is 0 (two series pull-downs), so two enabled
 * sources give the AND of their bits; a destination's pass transistor copies the line into a
 * storage node.
 */
export const BUS_LINE: ComponentDef = define({
  id: 'm65_busline', name: 'Precharged bus line', category: 'cell',
  summary: 'Precharged to 1 by φ2; in φ1 an enabled source whose bit is 0 pulls it low (two enabled sources: the AND of their bits); ld copies it into a storage node.',
  ports: [
    { name: 'p2', width: 1, dir: 'in' }, { name: 'en_a', width: 1, dir: 'in' }, { name: 'a', width: 1, dir: 'in' },
    { name: 'en_b', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' }, { name: 'ld', width: 1, dir: 'in' },
    { name: 'bus', width: 1, dir: 'out' }, { name: 'q', width: 1, dir: 'out' },
  ],
  symbol: { kind: 'box', label: 'BUS LINE' },
  netlist: () => ({
    level: 'switch',
    pins: { p2: [1, 4], en_a: [1, 11], a: [1, 16], en_b: [1, 23], b: [1, 25], ld: [1, 27], bus: [62, 8], q: [62, 13] },
    instances: [
      { name: 'vdd', def: VDD, at: [9, 0] },
      { name: 'pre', def: NMOS, at: [7, 2] },
      { name: 'ena', def: NMOS, at: [16, 9] }, { name: 'va', def: NMOS, at: [16, 14] }, { name: 'ga', def: GND, at: [18, 19] },
      { name: 'inva', def: NINV, at: [9, 15] },
      { name: 'enb', def: NMOS, at: [30, 9] }, { name: 'vb', def: NMOS, at: [30, 14] }, { name: 'gb', def: GND, at: [32, 19] },
      { name: 'invb', def: NINV, at: [23, 15] },
      { name: 'pass', def: NMOS, at: [42, 9] },
      { name: 'i1', def: NINV, at: [48, 12] }, { name: 'i2', def: NINV, at: [54, 12] },
    ],
    nets: [
      { name: 'vdd', ends: ['vdd.p', 'pre.d'] },
      { name: 'p2', ends: ['p2', 'pre.g'] },
      { name: 'bus', ends: ['pre.s', 'ena.d', 'enb.d', 'pass.d', 'bus'], trunk: 8, cap: 20 },
      { name: 'en_a', ends: ['en_a', 'ena.g'] },
      { name: 'a', ends: ['a', 'inva.a'] },
      { name: 'na', ends: ['inva.y', 'va.g'] },
      { name: 'ma', ends: ['ena.s', 'va.d'] },
      { name: 'gnda', ends: ['ga.p', 'va.s'] },
      { name: 'en_b', ends: ['en_b', 'enb.g'], via: { 'enb.g': [[28, 23], [28, 11]] } },
      { name: 'b', ends: ['b', 'invb.a'], via: { 'invb.a': [[21, 25], [21, 16]] } },
      { name: 'nb', ends: ['invb.y', 'vb.g'] },
      { name: 'mb', ends: ['enb.s', 'vb.d'] },
      { name: 'gndb', ends: ['gb.p', 'vb.s'] },
      { name: 'ld', ends: ['ld', 'pass.g'], via: { 'pass.g': [[38, 27], [38, 11]] } },
      { name: 'st', ends: ['pass.s', 'i1.a'], cap: true },
      { name: 'nst', ends: ['i1.y', 'i2.a'] },
      { name: 'q', ends: ['i2.y', 'q'] },
    ],
  }),
});
