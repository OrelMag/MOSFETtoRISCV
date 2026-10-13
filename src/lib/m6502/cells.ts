// Transistor cells of the 6502 (Appendix A), drawn by hand: NMOS gates beyond NOR / NAND, the bus
// driver, the latches. Every larger block of the chip is made of these and of nmos.ts's gates.

import type { ComponentDef, InstanceDef, NetDef } from '../../sim/types';
import { define } from '../define';
import { DEP, NINV } from '../nmos';
import { GND, NMOS, VDD } from '../transistors';

const cache = new Map<string, ComponentDef>();

/**
 * AND-OR-INVERT: y = NOT(sum of products), one series stack of pull-downs per product, all under
 * one depletion load. `expr` names inputs by letter: 'ab|c' is NOT(a·b + c). Inputs may repeat
 * (majority: 'ab|ac|bc'). NMOS's complex gate: any series-parallel pull-down costs a transistor
 * per literal plus the load.
 */
export function naoi(expr: string): ComponentDef {
  let d = cache.get(expr);
  if (d) return d;
  const prods = expr.split('|').map((p) => [...p]);
  const names = [...new Set(prods.flat())].sort();
  const xs = prods.map((_, j) => 6 + 7 * j);
  const deepest = Math.max(...prods.map((p) => p.length));
  const yG = 9 + 5 * deepest + 1;
  const instances: InstanceDef[] = [{ name: 'vdd', def: VDD, at: [xs[0] + 2, 0] }, { name: 'ld', def: DEP, at: [xs[0], 3] }];
  const nets: NetDef[] = [{ name: 'vdd', ends: ['vdd.p', 'ld.d'] }];
  const gates = new Map<string, string[]>(names.map((n) => [n, [n]]));
  prods.forEach((p, j) => {
    p.forEach((lit, k) => {
      instances.push({ name: `t${j}_${k}`, def: NMOS, at: [xs[j], 9 + 5 * k] });
      gates.get(lit)!.push(`t${j}_${k}.g`);
      if (k) nets.push({ name: `m${j}_${k}`, ends: [`t${j}_${k - 1}.s`, `t${j}_${k}.d`] });
    });
    instances.push({ name: `g${j}`, def: GND, at: [xs[j] + 2, yG] });
    nets.push({ name: `gnd${j}`, ends: [`g${j}.p`, `t${j}_${p.length - 1}.s`] });
  });
  nets.push({ name: 'y', ends: ['ld.s', ...prods.map((_, j) => `t${j}_0.d`), 'y'], trunk: 8 });
  for (const [n, es] of gates) nets.push({ name: n, ends: es, tags: true });
  const lits = prods.reduce((s, p) => s + p.length, 0);
  d = define({
    id: `naoi_${prods.map((p) => p.join('')).join('_')}`, name: `NMOS AOI ${expr}`, category: 'cell',
    summary: `NOT(${prods.map((p) => p.join('·')).join(' + ')}): ${lits} pull-downs (one series stack per product) under one load, ${lits + 1} transistors.`,
    ports: [...names.map((n) => ({ name: n, width: 1, dir: 'in' as const })), { name: 'y', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: 'AOI' },
    spec: (v) => {
      const val = Object.fromEntries(names.map((n, i) => [n, v[i]]));
      return [prods.some((p) => p.every((l) => val[l])) ? 0 : 1];
    },
    netlist: () => ({
      level: 'switch',
      pins: { ...Object.fromEntries(names.map((n, i) => [n, [1, 9 + 2 * i] as [number, number]])), y: [xs[xs.length - 1] + 8, 8] },
      instances, nets,
    }),
  });
  cache.set(expr, d);
  return d;
}

/**
 * Bus driver: two pull-downs in series between a precharged bus line and GND. The bus is pulled
 * low only while `en` (the source is selected, in φ1) and `v` (its bit is 0: the cell's inverted
 * output) are both 1; otherwise the bus keeps its precharged 1. Two transistors per bit per bus.
 */
export const PULL2: ComponentDef = define({
  id: 'm65_pull2', name: 'Bus pull-down', category: 'cell',
  summary: 'Two series pull-downs: the bus line goes to 0 while en = 1 and v = 1, else keeps its precharged 1.',
  ports: [{ name: 'en', width: 1, dir: 'in' }, { name: 'v', width: 1, dir: 'in' }, { name: 'bus', width: 1, dir: 'inout' }],
  symbol: { kind: 'box', label: 'PULL' },
  netlist: () => ({
    level: 'switch',
    pins: { en: [1, 5], v: [1, 10], bus: [12, 3] },
    instances: [{ name: 'n1', def: NMOS, at: [5, 3] }, { name: 'n2', def: NMOS, at: [5, 8] }, { name: 'gnd', def: GND, at: [7, 13] }],
    nets: [
      { name: 'en', ends: ['en', 'n1.g'] },
      { name: 'v', ends: ['v', 'n2.g'] },
      { name: 'bus', ends: ['bus', 'n1.d'] },
      { name: 'm', ends: ['n1.s', 'n2.d'] },
      { name: 'gnd', ends: ['gnd.p', 'n2.s'] },
    ],
  }),
});

/**
 * Dynamic latch: a pass transistor charges the gate of an inverter while `en` is 1; when `en`
 * falls, that charge is the stored bit (it leaks away in milliseconds: the clock must keep
 * running). Output inverted. Three transistors.
 */
export const DLAT: ComponentDef = define({
  id: 'm65_dlat', name: 'Dynamic latch', category: 'cell',
  summary: 'A pass transistor into an inverter\'s gate: transparent while en = 1, then the gate\'s charge holds the bit. nq = NOT stored bit.',
  ports: [{ name: 'd', width: 1, dir: 'in' }, { name: 'en', width: 1, dir: 'in' }, { name: 'nq', width: 1, dir: 'out' }, { name: 's', width: 1, dir: 'out', doc: 'the stored charge itself (for gate inputs only)' }],
  symbol: { kind: 'box', label: 'DLAT' },
  netlist: () => ({
    level: 'switch',
    pins: { d: [1, 3], en: [1, 7], nq: [20, 9], s: [20, 13] },
    instances: [{ name: 'pass', def: NMOS, at: [5, 5] }, { name: 'inv', def: NINV, at: [12, 8] }],
    nets: [
      { name: 'd', ends: ['d', 'pass.d'], via: { 'pass.d': [[8, 3]] } },
      { name: 'en', ends: ['en', 'pass.g'] },
      { name: 's', ends: ['pass.s', 'inv.a', 's'], cap: true, via: { s: [[10, 9], [10, 13]] } },
      { name: 'nq', ends: ['inv.y', 'nq'] },
    ],
  }),
});

/**
 * A storage node with refresh: q drives two inverters (nq, r = q again), and while `rf` is 1 a
 * pass transistor feeds r back onto q, restoring its charge. Loads reach q through pass
 * transistors from outside, in the other clock phase. Five transistors.
 */
export const SCELL: ComponentDef = define({
  id: 'm65_scell', name: 'Refreshed storage bit', category: 'cell',
  summary: 'q held as charge, restored from its own double inversion while rf = 1. Loaded from outside through a pass transistor in the other phase.',
  ports: [{ name: 'q', width: 1, dir: 'inout' }, { name: 'rf', width: 1, dir: 'in' }, { name: 'nq', width: 1, dir: 'out' }, { name: 'r', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: 'BIT' },
  netlist: () => ({
    level: 'switch',
    pins: { q: [1, 5], rf: [1, 11], nq: [24, 2], r: [24, 5] },
    instances: [
      { name: 'i1', def: NINV, at: [6, 4] },
      { name: 'i2', def: NINV, at: [14, 4] },
      { name: 'fb', def: NMOS, at: [10, 9] },
    ],
    nets: [
      { name: 'q', ends: ['q', 'i1.a', 'fb.s'], cap: true, via: { 'fb.s': [[4, 5], [4, 15], [13, 15]] } },
      { name: 'nq', ends: ['i1.y', 'i2.a', 'nq'], via: { nq: [[11, 5], [11, 2]] } },
      { name: 'r', ends: ['i2.y', 'r', 'fb.d'], via: { 'fb.d': [[19, 5], [19, 7], [13, 7]] } },
      { name: 'rf', ends: ['rf', 'fb.g'] },
    ],
  }),
});
