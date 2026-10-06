// An SRAM array at transistor level: rows of 6T cells on shared bit lines, a row decoder that
// raises one word line, precharge, write drivers and latch-type sense amplifiers. Everything is
// solved by the switch-level simulator (the decoder's gates expand to their transistors).

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { NMOS_STRONG, SRAM_CELL } from './cells';
import { decoder } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT } from './gates';
import { GND, INV_CMOS, NMOS, PMOS, VDD } from './transistors';

const bit = (name: string, dir: 'in' | 'out' | 'inout', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/**
 * Write driver: with we = 1, a strong NMOS pulls bl low to write 0, or bl̄ low to write 1. With we = 0
 * both are off and the bit lines float (precharged, or driven by a cell).
 */
export const WRITE_DRIVER: ComponentDef = define({
  id: 'wdrv', name: 'SRAM write driver', category: 'memory',
  summary: 'Two strong pull-downs, one per bit line, gated by we and the data bit. Strong enough to overpower a cell\'s weak pull-up through its access transistor.',
  ports: [bit('we', 'in'), bit('d', 'in'), bit('bl', 'inout', 'top'), bit('blb', 'inout', 'top')],
  symbol: { kind: 'box', label: 'WRITE', w: 22, h: 6, portPos: { bl: 3, blb: 19 } },
  netlist: () => ({
    level: 'switch',
    pins: { we: [0, 6], d: [0, 12], bl: [3, 0], blb: [27, 0] },
    pinDirs: { bl: 'down', blb: 'down' },
    instances: [
      { name: 'nd', def: NOT, at: [4, 11] },
      { name: 'w0', def: AND, at: [10, 9], label: 'write 0' },
      { name: 'w1', def: AND, at: [16, 15], label: 'write 1' },
      { name: 'p0', def: NMOS_STRONG, at: [17, 4] },
      { name: 'p1', def: NMOS_STRONG, at: [24, 8] },
      { name: 'g0', def: GND, at: [19, 9] },
      { name: 'g1', def: GND, at: [26, 13] },
    ],
    nets: [
      { name: 'we', ends: ['we', 'w0.a', 'w1.a'], trunk: 2 },
      { name: 'd', ends: ['d', 'nd.a', 'w1.b'], trunk: 3 },
      { name: '¬d', ends: ['nd.y', 'w0.b'] },
      { name: 'pull bl', ends: ['w0.y', 'p0.g'] },
      { name: 'pull bl̄', ends: ['w1.y', 'p1.g'] },
      { name: 'bl', ends: ['bl', 'p0.d'] },
      { name: 'bl̄', ends: ['blb', 'p1.d'] },
      { ends: ['g0.p', 'p0.s'] }, { ends: ['g1.p', 'p1.s'] },
    ],
  }),
  hdl: { verilog: 'nmos (bl,  gnd, we & ~d);   // strong\nnmos (blb, gnd, we &  d);' },
});

/**
 * Latch-type sense amplifier. While sae = 0, two PMOS pass gates connect its nodes to the bit lines,
 * which they follow; the latch is unpowered, so it cannot drive them (an unknown latch would otherwise
 * spoil a write). When sae rises the pass gates open and head and foot transistors power a pair of
 * cross-coupled inverters (one head and one foot per side: a shared one would join the two sides,
 * and so the two bit lines, while the latch is off), which latch whichever side is lower to 0 and the other to 1, and hold it
 * while the bit lines are precharged for the next access.
 */
export const SENSE_AMP: ComponentDef = define({
  id: 'senseamp', name: 'Sense amplifier (latch type)', category: 'memory',
  summary: 'Follows the bit lines while sae = 0 (its latch unpowered, so it never drives them); when sae rises it isolates itself and powers a cross-coupled pair, which latches the result. q = 1 when bl̄ was the lower bit line (the cell stores 1).',
  ports: [bit('sae', 'in'), bit('bl', 'inout', 'top'), bit('blb', 'inout', 'top'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'SENSE', w: 22, h: 6, portPos: { bl: 3, blb: 19 } },
  netlist: () => ({
    level: 'switch',
    pins: { bl: [3, 0], blb: [33, 0], sae: [0, 30], q: [46, 14] },
    pinDirs: { bl: 'down', blb: 'down' },
    instances: [
      { name: 'i0', def: PMOS, at: [0, 2], label: 'pass' },
      { name: 'i1', def: PMOS, at: [26, 2], label: 'pass' },
      { name: 'v0', def: VDD, at: [13, 2] }, { name: 'v1', def: VDD, at: [21, 2] },
      { name: 'h0', def: PMOS, at: [11, 4] }, { name: 'h1', def: PMOS, at: [19, 4] },
      { name: 'nsae', def: INV_CMOS, at: [36, 26] },
      { name: 'p0', def: PMOS, at: [11, 10] },
      { name: 'p1', def: PMOS, at: [19, 10] },
      { name: 'n0', def: NMOS, at: [11, 18] },
      { name: 'n1', def: NMOS, at: [19, 18] },
      { name: 'f0', def: NMOS, at: [11, 24] }, { name: 'f1', def: NMOS, at: [19, 24] },
      { name: 'g0', def: GND, at: [13, 28] }, { name: 'g1', def: GND, at: [21, 28] },
      { name: 'out', def: INV_CMOS, at: [36, 6] },
    ],
    nets: [
      { name: 'bl', ends: ['bl', 'i0.s'] },
      { name: 'bl̄', ends: ['blb', 'i1.s'], via: { 'i1.s': [[33, 1], [29, 1]] } },
      { name: 'sae', ends: ['sae', 'i0.g', 'i1.g', 'f0.g', 'f1.g', 'nsae.a'], via: { 'i0.g': [[2, 30], [2, 4]], 'i1.g': [[2, 30], [2, 35], [24, 35], [24, 4]] } },
      { ends: ['v0.p', 'h0.s'] }, { ends: ['v1.p', 'h1.s'] },
      { ends: ['h0.d', 'p0.s'] }, { ends: ['h1.d', 'p1.s'] },
      { name: '¬sae', ends: ['nsae.y', 'h0.g', 'h1.g'], tags: true },
      { name: 's', cap: true, ends: ['i0.d', 'p0.d', 'n0.d', 'p1.g', 'n1.g'], via: { 'i0.d': [[3, 15]], 'p1.g': [[17, 15], [17, 12]], 'n1.g': [[17, 15], [17, 20]] } },
      { name: 's̄', cap: true, ends: ['i1.d', 'p1.d', 'n1.d', 'p0.g', 'n0.g', 'out.a'], via: { 'i1.d': [[29, 15]], 'p0.g': [[10, 23], [10, 12]], 'n0.g': [[10, 23], [10, 20]] } },
      { ends: ['n0.s', 'f0.d'] }, { ends: ['n1.s', 'f1.d'] },
      { ends: ['g0.p', 'f0.s'] }, { ends: ['g1.p', 'f1.s'] },
      { name: 'q', ends: ['out.y', 'q'] },
    ],
  }),
  notes: `In silicon the bit line moves only ~100 mV before the sense amplifier fires: waiting for a full swing
    through one small cell would take far too long, and the regenerative latch turns the small difference into a full
    logic level. This simulator has no analog voltages, so the bit line here swings fully; the latch still shows the
    other job of a sense amplifier, holding the result while the bit lines are precharged again.`,
  hdl: { verilog: '// behaviour: q follows ~blb while sae = 0, holds while sae = 1\nalways_latch if (!sae) q = ~blb;' },
});

/**
 * One column of an SRAM array: precharge, R cells on the bit-line pair, a write driver and a sense
 * amplifier. The bit lines are capacitive and keep their charge when nothing drives them.
 */
export function sramColumn(R: number): ComponentDef {
  return memo(`sramcolio${R}`, () => {
    const cg = symbolGeom(SRAM_CELL), P = cg.h + 6;
    const y0 = 14, yW = y0 + P * R + 4, yS = yW + 14;
    const instances: InstanceDef[] = [
      { name: 'vdd0', def: VDD, at: [12, 0] }, { name: 'vdd1', def: VDD, at: [28, 0] },
      { name: 'pre0', def: PMOS, at: [10, 2], label: 'precharge' },
      { name: 'pre1', def: PMOS, at: [26, 2] },
      { name: 'wd', def: WRITE_DRIVER, at: [10, yW] },
      { name: 'sa', def: SENSE_AMP, at: [10, yS] },
    ];
    const blEnds = ['pre0.d', 'wd.bl', 'sa.bl'], blbEnds = ['pre1.d', 'wd.blb', 'sa.blb'];
    const nets: NetDef[] = [
      { name: 'pre_n', ends: ['pre_n', 'pre0.g', 'pre1.g'], via: { 'pre1.g': [[8, 4], [8, 1], [24, 1], [24, 4]] } },
      { ends: ['vdd0.p', 'pre0.s'] }, { ends: ['vdd1.p', 'pre1.s'] },
      { name: 'we', ends: ['we', 'wd.we'] }, { name: 'd', ends: ['d', 'wd.d'] },
      { name: 'sae', ends: ['sae', 'sa.sae'] }, { name: 'q', ends: ['sa.q', 'q'] },
    ];
    const pins: Record<string, [number, number]> = {
      pre_n: [0, 4], we: [0, yW + symbolGeom(WRITE_DRIVER).ports.we.pos[1]], d: [0, yW + symbolGeom(WRITE_DRIVER).ports.d.pos[1]],
      sae: [0, yS + symbolGeom(SENSE_AMP).ports.sae.pos[1]], q: [40, yS + symbolGeom(SENSE_AMP).ports.q.pos[1]],
    };
    for (let r = 0; r < R; r++) {
      const y = y0 + P * r;
      instances.push({ name: `c${r}`, def: SRAM_CELL, at: [16, y], label: `row ${r}` });
      blEnds.push(`c${r}.bl`);
      blbEnds.push(`c${r}.blb`);
      nets.push({ name: `wl${r}`, ends: [`wl${r}`, `c${r}.wl`] });
      pins[`wl${r}`] = [0, y + cg.ports.wl.pos[1]];
    }
    nets.push({ name: 'bl', cap: true, ends: blEnds, trunk: 13 }, { name: 'bl̄', cap: true, ends: blbEnds, trunk: 29 });
    return define({
      id: `sramcolio${R}`, name: `SRAM column (${R} cells, with I/O)`, category: 'memory',
      summary: `${R} 6T cells sharing one bit-line pair, with precharge, a write driver and a sense amplifier: everything one bit of an SRAM word needs. ${6 * R} transistors of storage.`,
      ports: [bit('pre_n', 'in'), ...Array.from({ length: R }, (_, r) => bit(`wl${r}`, 'in')), bit('we', 'in'), bit('d', 'in'), bit('sae', 'in'), bit('q', 'out')],
      symbol: { kind: 'box', label: 'COLUMN' },
      netlist: () => ({ level: 'switch', pins, instances, nets }),
    });
  });
}

/**
 * An R × C SRAM array (R a power of two): a row decoder raises one word line while wl = 1, every
 * column reads or writes its bit of that row. Protocol: precharge (pre_n = 0, then 1), then either
 * write (din, we = 1, wl = 1) or read (wl = 1, then sae = 1; dout holds while sae stays 1).
 */
export function sramArray(R: number, C: number): ComponentDef {
  const k = Math.round(Math.log2(R));
  return memo(`sram${R}x${C}`, () => {
    const COL = sramColumn(R), cg = symbolGeom(COL), D = decoder(k, true), dg = symbolGeom(D);
    const xc = 8 + dg.w + 16, dx = cg.w + 10;
    const yc = 4;
    const instances: InstanceDef[] = [
      { name: 'dec', def: D, at: [8, yc + cg.ports.wl0.pos[1] - dg.ports.y0.pos[1]], label: 'row decoder' },
      { name: 'sd', def: splitter(ones(C)), at: [xc - 6, cg.h + 12] },
      { name: 'mq', def: merger(ones(C)), at: [xc + dx * C, cg.h + 12] },
    ];
    const nets: NetDef[] = [
      { name: 'addr', ends: ['addr', 'dec.a'] }, { name: 'wl', ends: ['wl', 'dec.en'] },
      { name: 'din', ends: ['din', 'sd.in'] }, { name: 'dout', ends: ['mq.out', 'dout'] },
    ];
    const ctl: Record<string, string[]> = { pre_n: ['pre_n'], we: ['we'], sae: ['sae'] };
    const wls: string[][] = Array.from({ length: R }, (_, r) => [`dec.y${r}`]);
    for (let c = 0; c < C; c++) {
      const nm = `col${c}`;
      instances.push({ name: nm, def: COL, at: [xc + dx * c, yc], label: `bit ${c}` });
      for (const s of ['pre_n', 'we', 'sae']) ctl[s].push(`${nm}.${s}`);
      for (let r = 0; r < R; r++) wls[r].push(`${nm}.wl${r}`);
      nets.push({ name: `d${c}`, ends: [`sd.o${c}`, `${nm}.d`], tags: true }, { name: `q${c}`, ends: [`${nm}.q`, `mq.i${c}`], tags: true });
    }
    for (const [s, ends] of Object.entries(ctl)) nets.push({ name: s, ends, tags: ends.slice(1) });
    wls.forEach((ends, r) => nets.push({ name: `word ${r}`, ends, tags: ends.slice(2) }));
    const right = xc + dx * C + 8;
    return define({
      id: `sram${R}x${C}`, name: `${R} × ${C} SRAM array`, category: 'memory',
      summary: `${R} words of ${C} bits at transistor level: ${6 * R * C} transistors of 6T cells, plus a ${k}→${R} row decoder, and per column precharge, a write driver and a sense amplifier.`,
      ports: [bus('addr', k, 'in'), bit('wl', 'in'), bit('pre_n', 'in'), bit('we', 'in'), bus('din', C, 'in'), bit('sae', 'in'), bus('dout', C, 'out')],
      symbol: { kind: 'box', label: `SRAM ${R}×${C}` },
      netlist: () => ({
        level: 'switch',
        pins: { addr: [0, 6], wl: [0, 10], pre_n: [0, cg.h + 2], we: [0, cg.h + 6], din: [0, cg.h + 12], sae: [0, cg.h + 18], dout: [right, cg.h + 12] },
        instances, nets,
      }),
    });
  });
}

