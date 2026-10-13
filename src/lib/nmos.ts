// NMOS depletion-load logic, the 1975 way (Appendix A): no PMOS on the die, so a gate is a pull-down
// network of enhancement transistors under one always-on depletion-mode load. An n-input gate costs
// n + 1 transistors instead of CMOS's 2n, and conducts from VDD to GND whenever its output is 0.

import type { ComponentDef, InstanceDef, NetDef } from '../sim/types';
import { define } from './define';
import { GND, NMOS, VDD } from './transistors';

export const DEP: ComponentDef = define({
  id: 'dep', name: 'Depletion load', category: 'transistor', prim: 'dep',
  summary: 'A depletion-mode NMOS with its gate tied to its source: always on, weakly. The pull-up of every NMOS gate.',
  ports: [
    { name: 'd', width: 1, dir: 'inout', doc: 'drain (to VDD)' },
    { name: 's', width: 1, dir: 'inout', doc: 'source = gate (the output node)' },
  ],
  symbol: { kind: 'dep' },
  notes: `An implant shifts its threshold below zero, so the channel exists with no gate voltage. With the
    gate tied to the source it behaves as a current source: a resistor that does not waste area. Any
    enhancement transistor pulling the node to GND wins over it (ratioed logic: the pull-down is made a
    few times stronger), so the node is 0 whenever some pull-down conducts and 1 otherwise.`,
  hdl: { verilog: '// a depletion load is a weak always-on path: Verilog\'s resistive switch\nrtran load (vdd, y);' },
});

/** An NMOS gate's common part: VDD, the load at x, the output node y at row 8. */
function loadTop(x: number): InstanceDef[] {
  return [{ name: 'vdd', def: VDD, at: [x + 2, 0] }, { name: 'ld', def: DEP, at: [x, 3] }];
}

export const NINV: ComponentDef = define({
  id: 'ninv', name: 'NMOS inverter', category: 'cell',
  summary: 'A depletion load over one pull-down transistor: 2 transistors. Draws current while its output is 0.',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'not' },
  spec: ([a]) => [a ? 0 : 1],
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 11], y: [12, 8] },
    instances: [...loadTop(5), { name: 'n1', def: NMOS, at: [5, 9] }, { name: 'gnd', def: GND, at: [7, 14] }],
    nets: [
      { name: 'vdd', ends: ['vdd.p', 'ld.d'] },
      { name: 'a', ends: ['a', 'n1.g'] },
      { name: 'y', ends: ['ld.s', 'n1.d', 'y'] },
      { name: 'gnd', ends: ['gnd.p', 'n1.s'] },
    ],
  }),
  hdl: { verilog: 'module ninv (input a, output y);\n  supply0 gnd; supply1 vdd;\n  rtran ld (vdd, y);   // depletion load\n  nmos n1 (y, gnd, a);\nendmodule' },
});

/** Input names a, b, … (never y, the output); i0, i1, … for wide gates. */
const ins = (n: number) => Array.from({ length: n }, (_, i) => (n <= 24 ? String.fromCharCode(97 + i) : `i${i}`));
const norCache = new Map<number, ComponentDef>();
const nandCache = new Map<number, ComponentDef>();

/**
 * NOR of n inputs: n pull-downs side by side under one load (n + 1 transistors). NMOS designers'
 * favourite gate: parallel pull-downs keep the ratio with minimum-size transistors.
 */
export function nnor(n: number): ComponentDef {
  let d = norCache.get(n);
  if (d) return d;
  const names = ins(n);
  const xs = names.map((_, i) => 5 + 6 * i);
  d = define({
    id: `nnor${n}`, name: `NMOS NOR${n}`, category: 'cell',
    summary: `${n} parallel pull-downs under a depletion load: ${n + 1} transistors (CMOS: ${2 * n}).`,
    ports: [...names.map((p) => ({ name: p, width: 1, dir: 'in' as const })), { name: 'y', width: 1, dir: 'out' }],
    symbol: { kind: 'nor' },
    spec: (v) => [v.some((b) => b) ? 0 : 1],
    netlist: () => ({
      level: 'switch',
      pins: { ...Object.fromEntries(names.map((p, i) => [p, [xs[i] - 1, 17] as [number, number]])), y: [xs[n - 1] + 7, 8] },
      pinDirs: Object.fromEntries(names.map((p) => [p, 'up' as const])),
      instances: [
        ...loadTop(xs[0]),
        ...names.map((_, i): InstanceDef => ({ name: `n${i}`, def: NMOS, at: [xs[i], 9] })),
        ...names.map((_, i): InstanceDef => ({ name: `g${i}`, def: GND, at: [xs[i] + 2, 14] })),
      ],
      nets: [
        { name: 'vdd', ends: ['vdd.p', 'ld.d'] },
        { name: 'y', ends: ['ld.s', ...names.map((_, i) => `n${i}.d`), 'y'], trunk: 8 },
        ...names.map((p, i): NetDef => ({ name: p, ends: [p, `n${i}.g`], via: { [`n${i}.g`]: [[xs[i] - 1, 11]] } })),
        ...names.map((_, i): NetDef => ({ name: `gnd${i}`, ends: [`g${i}.p`, `n${i}.s`] })),
      ],
    }),
  });
  norCache.set(n, d);
  return d;
}

/** NAND of n inputs: n pull-downs in series (n + 1 transistors; each must be wider to keep the ratio). */
export function nnand(n: number): ComponentDef {
  let d = nandCache.get(n);
  if (d) return d;
  const names = ins(n);
  const ys = names.map((_, i) => 9 + 5 * i);
  d = define({
    id: `nnand${n}`, name: `NMOS NAND${n}`, category: 'cell',
    summary: `${n} series pull-downs under a depletion load: ${n + 1} transistors (CMOS: ${2 * n}).`,
    ports: [...names.map((p) => ({ name: p, width: 1, dir: 'in' as const })), { name: 'y', width: 1, dir: 'out' }],
    symbol: { kind: 'nand' },
    spec: (v) => [v.every((b) => b) ? 0 : 1],
    netlist: () => ({
      level: 'switch',
      pins: { ...Object.fromEntries(names.map((p, i) => [p, [1, ys[i] + 2] as [number, number]])), y: [12, 8] },
      instances: [
        ...loadTop(5),
        ...names.map((_, i): InstanceDef => ({ name: `n${i}`, def: NMOS, at: [5, ys[i]] })),
        { name: 'gnd', def: GND, at: [7, ys[n - 1] + 5] },
      ],
      nets: [
        { name: 'vdd', ends: ['vdd.p', 'ld.d'] },
        { name: 'y', ends: ['ld.s', 'n0.d', 'y'] },
        ...names.map((p, i): NetDef => ({ name: p, ends: [p, `n${i}.g`] })),
        ...names.slice(1).map((_, i): NetDef => ({ name: `m${i}`, ends: [`n${i}.s`, `n${i + 1}.d`] })),
        { name: 'gnd', ends: ['gnd.p', `n${n - 1}.s`] },
      ],
    }),
  });
  nandCache.set(n, d);
  return d;
}

export const NNOR2 = nnor(2), NNOR3 = nnor(3), NNAND2 = nnand(2);
