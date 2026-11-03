// Wider CMOS gates at switch level (chapter 3's "Three and four inputs") and a NAND ring oscillator (chapter 2).
// NAND2 / NOR2 stay the hand-drawn cells of transistors.ts; these are the same pattern for n inputs: the series
// network is a column of n devices, the parallel one a row, and each input is one wire to its two transistors.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef } from '../sim/types';
import { define } from './define';
import { NOT } from './gates';
import { GND, NAND, NMOS, PMOS, VDD } from './transistors';

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

const INPUTS = ['a', 'b', 'c', 'd'];

/** n-input CMOS NAND (n = 3 or 4): n PMOS in parallel, n NMOS in series, 2n transistors. */
export function cmosNand(n: number): ComponentDef {
  if (n < 3 || n > 4) throw new Error('cmosNand: 3 or 4 inputs (2 is NAND)');
  return memo(`nand${n}_cmos`, () => {
    const ins = INPUTS.slice(0, n), sX = 6 + 6 * n;
    const instances: InstanceDef[] = [{ name: 'vdd', def: VDD, at: [10, 0] }];
    const nets: NetDef[] = [];
    const vdd = ['vdd.p'], y: string[] = [];
    ins.forEach((nm, k) => {
      instances.push({ name: `p${k + 1}`, def: PMOS, at: [6 + 6 * k, 3] }, { name: `n${k + 1}`, def: NMOS, at: [sX, 10 + 5 * k] });
      vdd.push(`p${k + 1}.s`);
      y.push(`p${k + 1}.d`);
      nets.push({ name: nm, ends: [nm, `p${k + 1}.g`, `n${k + 1}.g`], trunk: 6 + 6 * k - 1.5 });
      if (k < n - 1) nets.push({ name: `m${k + 1}`, ends: [`n${k + 1}.s`, `n${k + 2}.d`] });
    });
    instances.push({ name: 'gnd', def: GND, at: [sX + 2, 10 + 5 * n] });
    nets.push({ name: 'vdd', ends: vdd }, { name: 'y', ends: [...y, 'n1.d', 'y'] }, { name: 'gnd', ends: ['gnd.p', `n${n}.s`] });
    const pins: Record<string, [number, number]> = { y: [sX + 8, 8] };
    ins.forEach((nm, k) => (pins[nm] = [1, 12 + 5 * k]));
    return define({
      id: `nand${n}_cmos`, name: `CMOS NAND${n}`, category: 'cell',
      summary: `${n} PMOS in parallel (pull-up), ${n} NMOS in series (pull-down): ${2 * n} transistors, a stack ${n} deep.`,
      ports: [...ins.map((nm) => ({ name: nm, width: 1, dir: 'in' as const })), { name: 'y', width: 1, dir: 'out' as const }],
      symbol: { kind: 'box', label: `NAND${n}` },
      spec: (v) => [v.every((b) => b) ? 0 : 1],
      netlist: () => ({ level: 'switch', pins, instances, nets }),
      hdl: { verilog: `module nand${n}_cmos (input ${ins.join(', ')}, output y);\n  supply1 vdd; supply0 gnd;\n  wire ${Array.from({ length: n - 1 }, (_, i) => `m${i + 1}`).join(', ')};\n  // parallel pull-up, series pull-down\nendmodule` },
    });
  });
}

/** n-input CMOS NOR (n = 3): n PMOS in series, n NMOS in parallel. */
export function cmosNor(n: number): ComponentDef {
  if (n < 3 || n > 4) throw new Error('cmosNor: 3 or 4 inputs (2 is NOR_CMOS)');
  return memo(`nor${n}_cmos`, () => {
    const ins = INPUTS.slice(0, n), sX = 6 + 6 * n, R = 5 + 5 * n + 4;
    const instances: InstanceDef[] = [{ name: 'vdd', def: VDD, at: [sX + 2, 0] }];
    const nets: NetDef[] = [];
    const gnd = ['gnd.p'], y: string[] = [`p${n}.d`];
    ins.forEach((nm, k) => {
      instances.push({ name: `p${k + 1}`, def: PMOS, at: [sX, 2 + 5 * k] }, { name: `n${k + 1}`, def: NMOS, at: [6 + 6 * k, R] });
      gnd.push(`n${k + 1}.s`);
      y.push(`n${k + 1}.d`);
      nets.push({ name: nm, ends: [nm, `p${k + 1}.g`, `n${k + 1}.g`], trunk: 6 + 6 * k - 1.5 });
      if (k < n - 1) nets.push({ name: `m${k + 1}`, ends: [`p${k + 1}.d`, `p${k + 2}.s`] });
    });
    instances.push({ name: 'gnd', def: GND, at: [10, R + 6] });
    nets.push({ name: 'vdd', ends: ['vdd.p', 'p1.s'] }, { name: 'y', ends: [...y, 'y'] }, { name: 'gnd', ends: gnd });
    const pins: Record<string, [number, number]> = { y: [sX + 8, R - 2] };
    ins.forEach((nm, k) => (pins[nm] = [1, 4 + 5 * k]));
    return define({
      id: `nor${n}_cmos`, name: `CMOS NOR${n}`, category: 'cell',
      summary: `${n} PMOS in series (pull-up), ${n} NMOS in parallel (pull-down): ${2 * n} transistors, a pull-up stack ${n} deep.`,
      ports: [...ins.map((nm) => ({ name: nm, width: 1, dir: 'in' as const })), { name: 'y', width: 1, dir: 'out' as const }],
      symbol: { kind: 'box', label: `NOR${n}` },
      spec: (v) => [v.some((b) => b) ? 0 : 1],
      netlist: () => ({ level: 'switch', pins, instances, nets }),
      hdl: { verilog: `module nor${n}_cmos (input ${ins.join(', ')}, output y);\n  supply1 vdd; supply0 gnd;\n  // series pull-up, parallel pull-down\nendmodule` },
    });
  });
}

/**
 * A ring of n (odd) inverting stages: the first a NAND with an enable, the rest NOTs. With en = 0 the ring sits
 * still (every stage a known value); with en = 1 no stage can settle and the wave runs round: each stage flips
 * once per lap in each direction, so the period is 2n gate delays.
 */
export function ringOsc(n: number): ComponentDef {
  if (n < 3 || n % 2 === 0) throw new Error('ringOsc: an odd number of stages, at least 3');
  return memo(`ring${n}`, () => {
    const gN = symbolGeom(NAND), gI = symbolGeom(NOT), dx = 10, row = 6;
    const instances: InstanceDef[] = [{ name: 's0', def: NAND, at: [6, row - gN.ports.y.pos[1]], label: 'enable' }];
    for (let i = 1; i < n; i++) instances.push({ name: `s${i}`, def: NOT, at: [6 + dx * i, row - gI.ports.y.pos[1]] });
    const nets: NetDef[] = [{ name: 'en', ends: ['en', 's0.b'] }];
    for (let i = 0; i < n - 1; i++) nets.push({ name: `x${i}`, ends: [`s${i}.y`, `s${i + 1}.a`] });
    // the lap closes through a label, as on a schematic: the last stage drives the first one's other input
    nets.push({ name: 'y', ends: [`s${n - 1}.y`, 's0.a', 'y'], tags: ['s0.a'] });
    return define({
      id: `ring${n}`, name: `${n}-stage ring oscillator`, category: 'sequential',
      summary: `${n} inverting stages in a loop (one is a NAND with an enable). Period: 2 × ${n} = ${2 * n} gate delays.`,
      ports: [{ name: 'en', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
      symbol: { kind: 'box', label: `ring ×${n}` },
      netlist: () => ({ pins: { en: [1, row + 6], y: [6 + dx * n, row] }, instances, nets }),
      hdl: { verilog: `// a combinational loop: for simulation and teaching, not for synthesis\nwire [${n - 1}:0] x;\nassign x[0] = ~(en & x[${n - 1}]);\nassign x[${n - 1}:1] = ~x[${n - 2}:0];` },
    });
  });
}
