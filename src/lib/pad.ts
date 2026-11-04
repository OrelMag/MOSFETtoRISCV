// Chapter 41's I/O pad at switch level: the last transistors before the wire and the first after it. The output path is a
// tri-state driver (switchparts.ts TRIINV) behind a chain of inverters, each four times the last (chapter 2's sizing for
// a load of 64: 4×, 16×, 64×, then the 256× output stage); the input path is a small buffer reading the pin. A bidirectional
// pin: with en = 0 the pad lets go (Z) and whatever is on the wire reaches y.
//
// The switch-level solver has strengths, not widths, so the widths are labels on the drawing; phys/line.ts turns the
// output stage's width into the resistance the line model sees (padDriveOhms). The same cell with another final width is
// ioPad(w): the chain keeps a ratio of 4 and starts at w / 64.

import { rEff } from '../phys/line';
import type { ComponentDef } from '../sim/types';
import { define } from './define';
import { INV_CMOS } from './transistors';
import { TRIINV } from './switchparts';

/** Widths (unit transistors) of the inverter chain in front of the output stage, and of the output stage. */
export const PAD_CHAIN = [4, 16, 64] as const;
export const PAD_FINAL = 256;
/** The receiver's two inverters. */
export const PAD_RX = [1, 4] as const;

/** Effective drive resistance (Ω) of an output stage `w` wide: what the line model sees as the source resistance. */
export const padDriveOhms = (w = PAD_FINAL): number => rEff(w);

/** Capacitance (fF) of the pin as the driver sees it: the output stage's own drains, the receiver's first gate, an ESD structure and the pad (illustrative). */
export const PAD_PIN_FF = 1500;

const cache = new Map<number, ComponentDef>();

/** The pad with an output stage of `w` unit transistors (a multiple of 16, so the 4:1 chain has integer widths). */
export function ioPad(w = PAD_FINAL): ComponentDef {
  const hit = cache.get(w);
  if (hit) return hit;
  const first = w / 64;
  const widths = [first * 1, first * 4, first * 16];
  const def = define({
    id: w === PAD_FINAL ? 'io_pad' : `io_pad${w}`, name: w === PAD_FINAL ? 'I/O pad' : `I/O pad (${w}×)`, category: 'cell',
    summary: `A bidirectional pin: d goes out through an inverter chain (${widths.map((x) => `${x}×`).join(', ')}) and a ${w}× tri-state output stage while en = 1; with en = 0 the pin floats and y reads it through a two-inverter buffer.`,
    ports: [
      { name: 'd', width: 1, dir: 'in' },
      { name: 'en', width: 1, dir: 'in', side: 'top' },
      { name: 'pad', width: 1, dir: 'inout', side: 'right', doc: 'the pin: driven by the output stage while en = 1, Z otherwise' },
      { name: 'y', width: 1, dir: 'out', side: 'bottom', doc: 'the pin, as read by the input buffer' },
    ],
    symbol: { kind: 'box', label: 'I/O pad', w: 8, h: 6 },
    netlist: () => ({
      level: 'switch',
      pins: { d: [1, 5], en: [30, -3], pad: [44, 5], y: [60, 13] },
      pinDirs: { en: 'down', pad: 'left', y: 'left' },
      instances: [
        { name: 'i1', def: INV_CMOS, at: [4, 4], label: `${widths[0]}×` },
        { name: 'i2', def: INV_CMOS, at: [10, 4], label: `${widths[1]}×` },
        { name: 'i3', def: INV_CMOS, at: [16, 4], label: `${widths[2]}×` },
        { name: 'drv', def: TRIINV, at: [24, 3], label: `${w}×` },
        { name: 'rx1', def: INV_CMOS, at: [36, 11], label: `${PAD_RX[0]}×` },
        { name: 'rx2', def: INV_CMOS, at: [46, 11], label: `${PAD_RX[1]}×` },
      ],
      nets: [
        { name: 'd', ends: ['d', 'i1.a'] },
        { name: 'd1', ends: ['i1.y', 'i2.a'] },
        { name: 'd2', ends: ['i2.y', 'i3.a'] },
        { name: 'd3', ends: ['i3.y', 'drv.a'] },
        { name: 'en', ends: ['en', 'drv.en'] },
        { name: 'pad', ends: ['drv.y', 'pad', 'rx1.a'], via: { 'rx1.a': [[34, 5], [34, 12]] } },
        { name: 'r1', ends: ['rx1.y', 'rx2.a'] },
        { name: 'y', ends: ['rx2.y', 'y'] },
      ],
    }),
    notes: `Why a chain? The output stage is wide enough to charge a pin, a bond wire and a trace (here ${w}× the unit device, about ${Math.round(padDriveOhms(w))} Ω while it switches), so its gate is a load of ${w * 2} fF; the core's gate drives a 2 fF input. A ratio of about 4 per stage is the fastest way across. The solver sees strengths, not widths: the labels are the drawing's, and the line model reads the resistance from phys/line.ts.`,
    hdl: {
      verilog: `module io_pad (input d, en, inout pad, output y);
  // output: a chain of inverters, then a tri-state stage;  input: a buffer
  assign pad = en ? d : 1'bz;
  assign y = pad;
endmodule`,
    },
  });
  cache.set(w, def);
  return def;
}

export const IO_PAD: ComponentDef = ioPad();

/**
 * Two pads on one wire: A's driver and B's, the line between them a net. d / en drive A, rd / ren drive B; ya and yb are what
 * each input buffer reads, `line` the wire. Both enabled and disagreeing is a short from VDD to GND through both output stages.
 */
export const PAD_LINK: ComponentDef = define({
  id: 'pad_link', name: 'Two pads on a wire', category: 'cell',
  summary: 'Two I/O pads joined by a wire: either end can drive it, both at once is a fight.',
  ports: [
    { name: 'd', width: 1, dir: 'in' }, { name: 'en', width: 1, dir: 'in' },
    { name: 'rd', width: 1, dir: 'in' }, { name: 'ren', width: 1, dir: 'in' },
    { name: 'ya', width: 1, dir: 'out' }, { name: 'yb', width: 1, dir: 'out' },
    { name: 'line', width: 1, dir: 'out', tri: true, side: 'bottom', doc: 'the wire between the pins' },
  ],
  symbol: { kind: 'box', label: 'two pads' },
  netlist: () => ({
    level: 'switch',
    pins: { d: [1, 5], en: [12, -3], ya: [12, 14], line: [30, 14], yb: [49, 14], rd: [60, 5], ren: [49, -3] },
    pinDirs: { en: 'down', ren: 'down', ya: 'up', yb: 'up', line: 'up', rd: 'left' },
    instances: [
      { name: 'a', def: IO_PAD, at: [8, 2], label: 'chip A' },
      { name: 'b', def: IO_PAD, at: [45, 2], flip: true, label: 'chip B' },
    ],
    nets: [
      { name: 'd', ends: ['d', 'a.d'] },
      { name: 'en', ends: ['en', 'a.en'] },
      { name: 'line', ends: ['a.pad', 'b.pad', 'line'] },
      { name: 'ya', ends: ['a.y', 'ya'] },
      { name: 'yb', ends: ['b.y', 'yb'] },
      { name: 'rd', ends: ['rd', 'b.d'] },
      { name: 'ren', ends: ['ren', 'b.en'] },
    ],
  }),
  hdl: { verilog: '// two bidirectional pins on one wire' },
});
