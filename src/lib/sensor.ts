// The image-sensor chapter's circuits. PIXEL_4T: the four-transistor pixel at switch level (photodiode and floating
// diffusion as charge nets, reset, transfer, source follower, row select, the column's load). columnAdcRow(n, cols): a
// row of single-slope column ADCs in gates with digital correlated double sampling (one ramp counter shared by every
// column, a comparator and an up/down counter per column: count down while the ramp is below the reset level, up while
// it is below the signal level, and what is left is the difference: Sony's column ADC, Nitta et al., ISSCC 2006).
//
// What the switch level can and cannot show: the solver has bits, weak levels and shared charge, not a source
// follower's analog output. A dark pixel's column reads H (a threshold below the supply, as a real follower's does), a
// bright pixel's reads 0. The voltages in between come from phys/imagesensor.ts in the chapter's panel. A real pinned
// photodiode empties completely into the floating diffusion (its pinning voltage sits below FD's reset level); here the
// two nets share their charge, which is enough for full light against none.

import { Builder } from './builder';
import { magComparator } from './coding';
import { AND } from './gates';
import { upDownCounter } from './seqparts';
import { constWord } from './alu';
import { define } from './define';
import { CAP, PULLDOWN } from './switchparts';
import { GND, NMOS, VDD } from './transistors';
import type { ComponentDef } from '../sim/types';
import { C_FD_FF } from '../phys/imagesensor';

/** The photodiode's capacitance in the drawing (fF): about four times FD's, so full light pulls FD below LEVEL_LO when
 *  they share. */
export const PD_C = 10;
export const FD_C = Math.round(C_FD_FF * 10) / 10;

export const PIXEL_4T: ComponentDef = define({
  id: 'pixel4t', name: '4T pixel (switch level)', category: 'memory',
  summary: 'A pinned photodiode, a transfer gate TX onto the floating diffusion FD, a reset transistor, a source follower and a row-select switch onto the column, whose load is the column\'s current source (a pull-down here).',
  ports: [
    { name: 'rst', width: 1, dir: 'in', doc: 'reset: FD to the supply' },
    { name: 'tx', width: 1, dir: 'in', doc: 'transfer: the photodiode onto FD' },
    { name: 'light', width: 1, dir: 'in', doc: 'light: photo-electrons empty the photodiode (a stand-in for the photocurrent)' },
    { name: 'sel', width: 1, dir: 'in', doc: 'row select: the follower onto the column' },
    { name: 'col', width: 1, dir: 'out', doc: 'column line' },
  ],
  symbol: { kind: 'box', label: '4T PIXEL', w: 12, h: 10 },
  netlist: () => ({
    level: 'switch',
    pins: { rst: [0, 4], tx: [0, 10], light: [0, 17], sel: [0, 24], col: [40, 21] },
    instances: [
      { name: 'vdd1', def: VDD, at: [20, 0], label: 'VDD' },
      { name: 'reset', def: NMOS, at: [18, 2], label: 'RST' },
      { name: 'xfer', def: NMOS, at: [10, 8], label: 'TX' },
      { name: 'pd', def: CAP, at: [12, 14], label: `PD ${PD_C} fF` },
      { name: 'photo', def: NMOS, at: [4, 15], label: 'light' },
      { name: 'gnd1', def: GND, at: [6, 21] },
      { name: 'fd', def: CAP, at: [24, 12], label: `FD ${FD_C} fF` },
      { name: 'vdd2', def: VDD, at: [30, 3] },
      { name: 'sf', def: NMOS, at: [28, 6], label: 'SF' },
      { name: 'rs', def: NMOS, at: [28, 15], label: 'SEL' },
      { name: 'load', def: PULLDOWN, at: [30, 24], label: 'column load' },
    ],
    nets: [
      { name: 'rst', ends: ['rst', 'reset.g'] },
      { name: 'tx', ends: ['tx', 'xfer.g'] },
      { name: 'light', ends: ['light', 'photo.g'] },
      { name: 'sel', ends: ['sel', 'rs.g'], via: { 'rs.g': [[2, 24], [2, 27], [26, 27], [26, 17]] } },
      { ends: ['vdd1.p', 'reset.d'] },
      { ends: ['vdd2.p', 'sf.d'] },
      { ends: ['gnd1.p', 'photo.s'] },
      { name: 'PD', cap: PD_C, ends: ['xfer.s', 'pd.a', 'photo.d'] },
      { name: 'FD', cap: FD_C, ends: ['reset.s', 'xfer.d', 'fd.a', 'sf.g'] },
      { name: 'sfo', ends: ['sf.s', 'rs.d'] },
      { name: 'col', ends: ['rs.s', 'load.y', 'col'] },
    ],
  }),
  hdl: { verilog: `module pixel4t (input rst, tx, light, sel, output col);
  supply1 vdd; supply0 gnd;
  trireg pd, fd;               // the photodiode and the floating diffusion keep their charge
  nmos reset (fd, vdd, rst);
  nmos xfer (fd, pd, tx);
  nmos photo (pd, gnd, light); // stands in for the photocurrent
  wire sfo;
  nmos sf (sfo, vdd, fd);      // source follower (a switch here)
  nmos rs (col, sfo, sel);
  pulldown (col);              // the column's current source
endmodule` },
});

/**
 * One row of single-slope column ADCs with digital CDS. Pins: v (the column samples, cols × n bits: the reset level
 * during the first conversion, the signal level during the second), up (0: count down, the reset conversion; 1: up,
 * the signal conversion), go (the ramp runs), start (load the ramp with 0), clr (clear every column's count), clk.
 * Outputs: ramp, and per column the count (n + 1 bits, two's complement: signal − reset).
 */
export function columnAdcRow(n: number, cols: number): ComponentDef {
  const id = `coladc${n}x${cols}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const b = new Builder(10, 10);
  b.pins('up', 'go', 'start', 'clr', 'clk', ...Array.from({ length: cols }, (_, c) => `v${c}`));
  const zero = b.op1(constWord(n, 0), [], '0');
  const zw = b.op1(constWord(n + 1, 0), [], '0');
  const one = b.op1(constWord(1, 1), [], '1');
  b.next();
  const ramp = b.op(upDownCounter(n), [one, 'go', 'start', zero, 'clk'], 'ramp', 'ramp');
  b.name(`${ramp}.q`, 'ramp', true);
  b.next();
  for (let c = 0; c < cols; c++) b.op(magComparator(n), [`${ramp}.q`, `v${c}`], `ramp < v${c}`, `cmp${c}`);
  b.next();
  for (let c = 0; c < cols; c++) b.op1(AND, [`cmp${c}.lt`, 'go'], `count${c}?`, `en${c}`);
  b.next();
  for (let c = 0; c < cols; c++) {
    const k = b.op(upDownCounter(n + 1), ['up', `en${c}.y`, 'clr', zw, 'clk'], `col ${c}`, `cnt${c}`);
    b.name(`${k}.q`, `d${c}`, true);
  }
  b.next();
  b.wire(`${ramp}.q`, 'ramp');
  for (let c = 0; c < cols; c++) b.wire(`cnt${c}.q`, `d${c}`);
  const R = b.right;
  const pins: Record<string, [number, number]> = { up: [0, 2], go: [0, 6], start: [0, 10], clr: [0, 14], clk: [0, 18 + 4 * cols], ramp: [R, 2] };
  for (let c = 0; c < cols; c++) { pins[`v${c}`] = [0, 18 + 4 * c]; pins[`d${c}`] = [R, 6 + 4 * c]; }
  const def = define({
    id, name: `${cols} column ADCs, ${n} bits, digital CDS`, category: 'sequential',
    summary: `One ${n}-bit ramp counter shared by ${cols} columns. Each column counts while the ramp is below its sample: down for the reset level, then up for the signal level, so its counter ends at signal − reset (correlated double sampling done in the count).`,
    ports: [
      { name: 'up', width: 1, dir: 'in' }, { name: 'go', width: 1, dir: 'in' }, { name: 'start', width: 1, dir: 'in' },
      { name: 'clr', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true },
      ...Array.from({ length: cols }, (_, c) => ({ name: `v${c}`, width: n, dir: 'in' as const })),
      { name: 'ramp', width: n, dir: 'out' },
      ...Array.from({ length: cols }, (_, c) => ({ name: `d${c}`, width: n + 1, dir: 'out' as const })),
    ],
    symbol: { kind: 'box', label: 'COLUMN ADCs' },
    netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
  });
  cache.set(id, def);
  return def;
}
const cache = new Map<string, ComponentDef>();
