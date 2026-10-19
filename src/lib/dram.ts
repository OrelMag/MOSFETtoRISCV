// A DRAM array at switch level (chapter 34). 1T1C cells hang on a bit line; a second bit line of
// the same capacitance, with no cells, is the reference. Both are precharged and equalized to VDD/2;
// raising a word line shares the cell's charge with its bit line, which moves by a few tens of
// millivolts (SwitchSim's charge levels); the sense amplifier compares the pair, drives them to the
// rails, and so writes the row back. The cells leak (NetDef.leak): a row must be refreshed (read and
// restored) before a stored 1 falls below what the amplifier can tell from VDD/2.

import { symbolGeom } from '../sim/geometry';
import { SENSE_OFFSET } from '../sim/switchsim';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { WRITE_DRIVER } from './arrays';
import { NMOS_STRONG } from './cells';
import { decoder } from './combinational';
import { define } from './define';
import { CAP } from './switchparts';
import { GND, INV_CMOS, NMOS, PMOS, VDD } from './transistors';

/** Capacitances in fF (relative weights for the solver): a cell, a bit line (four cells' worth), the data lines. */
export const CELL_C = 25, BITLINE_C = 100, DATA_C = 50;
/** A stored 1 halves every this many clock cycles (SwitchSim.leak; silicon: tens of milliseconds, scaled down to be seen). */
export const CELL_HALFLIFE = 250;

const bit = (name: string, dir: 'in' | 'out' | 'inout', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });

/** Half the supply: the level both bit lines are precharged to. */
export const VHALF: ComponentDef = define({
  id: 'vhalf', name: 'VDD/2', category: 'transistor', prim: 'vhalf',
  summary: 'A rail at half the supply: the precharge level of DRAM bit lines. Not a logic level (it reads as X), a level.',
  ports: [{ name: 'p', width: 1, dir: 'out' }],
  symbol: { kind: 'vdd', label: 'VDD/2' },
  notes: `A DRAM chip makes it on the die from VDD. Precharging both bit lines to the middle means a read moves
    one of them up or down by the same small amount for a 1 or a 0, and the sense amplifier only has to tell
    which way.`,
  hdl: { verilog: '// no logic level: an analog supply at VDD/2' },
});

/**
 * The DRAM sense amplifier: two cross-coupled inverters between the bit lines, powered through a
 * head and a foot transistor when en rises. Drawn with its 8 transistors; simulated as a primitive,
 * because what it does (amplify a ~110 mV difference: 0.1 VDD at 1.1 V) is below the switch model's resolution.
 */
export const DRAM_SA: ComponentDef = define({
  id: 'dramsa', name: 'DRAM sense amplifier', category: 'memory', prim: 'sense', offset: SENSE_OFFSET,
  summary: 'When en rises, compares the two bit lines and drives the higher one to VDD and the other to GND: the small read signal becomes a full bit, and the row is written back. Below 15 mV of difference it cannot tell (X).',
  ports: [bit('en', 'in'), bit('bl', 'inout', 'top'), bit('blb', 'inout', 'top')],
  symbol: { kind: 'box', label: 'SENSE', w: 14, h: 4, portPos: { bl: 1, blb: 13 } },
  netlist: () => ({
    level: 'switch',
    pins: { bl: [-4, 13], blb: [24, 13], en: [-4, 24] },
    pinDirs: { bl: 'right', blb: 'left', en: 'right' },
    instances: [
      { name: 'inv', def: INV_CMOS, at: [0, 3], label: 'en̄' },
      { name: 'v', def: VDD, at: [9, 0] },
      { name: 'he', def: PMOS, at: [7, 2], label: 'head' },
      { name: 'p0', def: PMOS, at: [3, 8] }, { name: 'p1', def: PMOS, at: [14, 8] },
      { name: 'n0', def: NMOS, at: [3, 14] }, { name: 'n1', def: NMOS, at: [14, 14] },
      { name: 'fe', def: NMOS, at: [7, 20], label: 'foot' },
      { name: 'g', def: GND, at: [9, 25] },
    ],
    nets: [
      { name: 'en', ends: ['en', 'fe.g', 'inv.a'], via: { 'inv.a': [[-2, 24], [-2, 4]] } },
      { name: 'en̄', ends: ['inv.y', 'he.g'] },
      { ends: ['v.p', 'he.s'] },
      { name: 'sap', ends: ['he.d', 'p0.s', 'p1.s'] },
      { name: 'bl', ends: ['bl', 'p0.d', 'n0.d', 'p1.g', 'n1.g'], via: { 'p1.g': [[10, 13], [10, 10]], 'n1.g': [[10, 13], [10, 16]] } },
      { name: 'bl̄', ends: ['blb', 'p1.d', 'n1.d', 'p0.g', 'n0.g'], via: { 'p0.g': [[20, 13], [20, 7], [1, 7], [1, 10]], 'n0.g': [[20, 13], [20, 19], [1, 19], [1, 16]] } },
      { name: 'san', ends: ['n0.s', 'n1.s', 'fe.d'] },
      { ends: ['fe.s', 'g.p'] },
    ],
  }),
  notes: `Both inverters start balanced at VDD/2; the line a few tens of millivolts higher turns the opposite pull-down
    on a little harder, which pulls the other line lower, which turns this side's pull-up on harder: positive
    feedback until both lines sit at the rails. The word line is still up, so the cell is recharged to a full
    level at the same time: a DRAM read destroys the cell's charge and always writes it back. A real amplifier
    has an offset (transistor mismatch) of some millivolts; below it the outcome is a coin toss, here an X.`,
  hdl: { verilog: '// analog: when en rises, the higher of bl / blb goes to VDD, the other to GND' },
});

/**
 * A cell of the array: chapter 22's 1T1C cell with its storage node inside (a capacitor of CELL_C
 * that leaks) and a two-way bit line: the cell drives it when it is read.
 */
export const DRAM_BIT: ComponentDef = define({
  id: 'drambit', name: 'DRAM cell (array)', category: 'memory',
  summary: 'One access transistor and a 25 fF capacitor. Word line high: the cell and its bit line share their charge (a read) or the bit line sets it (a write, a restore). Word line low: it holds, and leaks.',
  ports: [bit('wl', 'in'), bit('bl', 'inout')],
  symbol: { kind: 'box', label: '1T1C', w: 6, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { wl: [0, 6], bl: [6, 0] },
    pinDirs: { bl: 'down' },
    instances: [{ name: 'a', def: NMOS, at: [3, 4] }, { name: 'c', def: CAP, at: [5, 10] }],
    nets: [
      { name: 'wl', ends: ['wl', 'a.g'] },
      { name: 'bl', ends: ['bl', 'a.d'] },
      { name: 'storage', cap: CELL_C, leak: CELL_HALFLIFE, ends: ['a.s', 'c.a'] },
    ],
  }),
});

/**
 * A bit line's capacitance as a part (the campaign's column, m_sense): a sandbox wire has no capacitance
 * value of its own, and what a read moves the line by depends on the ratio of cell to line.
 */
export const BITLINE_CAP: ComponentDef = define({
  id: 'blcap', name: 'Bit line capacitance', category: 'memory',
  summary: `The capacitance of a bit line, ${BITLINE_C} fF: four cells' worth here (hundreds of cells hang on a real one). The node keeps its charge while nothing drives it, and a cell joined to it shares its charge with it.`,
  ports: [bit('a', 'inout', 'top')],
  symbol: { kind: 'box', label: `${BITLINE_C} fF`, w: 6, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { a: [3, 0] },
    pinDirs: { a: 'down' },
    instances: [{ name: 'c', def: CAP, at: [3, 4] }],
    nets: [{ name: 'line', cap: BITLINE_C, ends: ['a', 'c.a'] }],
  }),
  hdl: { verilog: '// a capacitance of 100 fF to GND (no logic)' },
});

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/**
 * One DRAM column: precharge and equalize to VDD/2 (pre = 1), R cells on the bit line, a column
 * select pair to the data lines (csel = 1) and the sense amplifier (sae = 1). The reference bit
 * line has the same capacitance and no cells.
 */
export function dramColumn(R: number): ComponentDef {
  return memo(`dramcol${R}`, () => {
    const bg = symbolGeom(DRAM_BIT), P = bg.h + 2;
    const yc = 12 + P * R, yS = yc + 8, yB = yS + 6;
    const instances: InstanceDef[] = [
      { name: 'vh0', def: VHALF, at: [9, 0] }, { name: 'vh1', def: VHALF, at: [21, 0] },
      { name: 'pa', def: NMOS, at: [7, 2] }, { name: 'pb', def: NMOS, at: [19, 2] },
      { name: 'eq', def: NMOS, at: [13, 6], label: 'equalize' },
      { name: 'ca', def: NMOS_STRONG, at: [3, yc] }, { name: 'cb', def: NMOS_STRONG, at: [24, yc] },
      { name: 'sa', def: DRAM_SA, at: [9, yS] },
    ];
    const bl = ['pa.s', 'eq.d', 'sa.bl', 'ca.d'], blb = ['pb.s', 'eq.s', 'sa.blb', 'cb.d'];
    const pins: Record<string, [number, number]> = { pre: [0, 8], sae: [0, yS + 2], csel: [0, yc + 2], dl: [6, yB], dlb: [27, yB] };
    const nets: NetDef[] = [
      { ends: ['vh0.p', 'pa.d'] }, { ends: ['vh1.p', 'pb.d'] },
      { name: 'pre', ends: ['pre', 'eq.g', 'pa.g', 'pb.g'], via: { 'pa.g': [[5, 8], [5, 4]], 'pb.g': [[12, 8], [12, 4]] } },
      { name: 'sae', ends: ['sae', 'sa.en'] },
      { name: 'csel', ends: ['csel', 'ca.g', 'cb.g'], via: { 'cb.g': [[1, yc + 2], [1, yc + 6], [23, yc + 6], [23, yc + 2]] } },
      { name: 'dl', ends: ['ca.s', 'dl'] }, { name: 'dl̄', ends: ['cb.s', 'dlb'] },
    ];
    for (let r = 0; r < R; r++) {
      instances.push({ name: `c${r}`, def: DRAM_BIT, at: [12, 12 + P * r], label: `row ${r}` });
      pins[`wl${r}`] = [0, 12 + P * r + bg.ports.wl.pos[1]];
      nets.push({ name: `wl${r}`, ends: [`wl${r}`, `c${r}.wl`] });
      bl.push(`c${r}.bl`);
    }
    nets.push({ name: 'bl', cap: BITLINE_C, ends: bl, trunk: 10 }, { name: 'bl̄', cap: BITLINE_C, ends: blb, trunk: 22 });
    const ports: PortDef[] = [bit('pre', 'in'), ...Array.from({ length: R }, (_, r) => bit(`wl${r}`, 'in')), bit('csel', 'in'), bit('sae', 'in'),
      bit('dl', 'inout', 'bottom'), bit('dlb', 'inout', 'bottom')];
    return define({
      id: `dramcol${R}`, name: `DRAM column (${R} cells)`, category: 'memory',
      summary: `${R} one-transistor cells on a bit line, a reference bit line, precharge to VDD/2, a sense amplifier and a column select: ${R} + 3 + 2 transistors, ${R} capacitors and an 8-transistor amplifier.`,
      ports, symbol: { kind: 'box', label: 'COLUMN', w: 8, portPos: { dl: 2, dlb: 6 } },
      netlist: () => ({ level: 'switch', pins, instances, nets }),
    });
  });
}

/**
 * An R × C DRAM array (R, C powers of two) at switch level. A row decoder raises word line `row`
 * while act = 1; a column decoder joins column `col` to the data lines while cs = 1; one write
 * driver, one output inverter. Protocol (what a controller does): precharge (pre = 1, then 0);
 * activate (act = 1: the row shares its charge with the bit lines); sense (sae = 1: the row is
 * amplified and written back, the row buffer holds it); read (cs = 1, dout) or write (cs = 1,
 * we = 1, din: the amplifier flips, the open cell follows); close (act = 0, sae = 0); precharge.
 */
export function dramArray(R: number, C: number): ComponentDef {
  const kr = Math.round(Math.log2(R)), kc = Math.round(Math.log2(C));
  return memo(`dram${R}x${C}`, () => {
    const COL = dramColumn(R), cg = symbolGeom(COL), RD = decoder(kr, true), rg = symbolGeom(RD), CD = decoder(kc, true), dg = symbolGeom(CD);
    const xc = 6 + rg.w + 14, dx = cg.w + 8, yc = 4;
    const yb = yc + cg.h + 8;
    const wg = symbolGeom(WRITE_DRIVER), yw = yb + 6 + dg.h;
    const instances: InstanceDef[] = [
      { name: 'rdec', def: RD, at: [6, yc + cg.ports.wl0.pos[1] - rg.ports.y0.pos[1]], label: 'row decoder' },
      { name: 'cdec', def: CD, at: [6, yb + 4], label: 'column decoder' },
      { name: 'wd', def: WRITE_DRIVER, at: [xc + 4, yw] },
      { name: 'out', def: INV_CMOS, at: [xc + 4 + wg.w + 8, yb + 6] },
    ];
    const nets: NetDef[] = [
      { name: 'row', ends: ['row', 'rdec.a'] }, { name: 'act', ends: ['act', 'rdec.en'] },
      { name: 'col', ends: ['col', 'cdec.a'] }, { name: 'cs', ends: ['cs', 'cdec.en'] },
      { name: 'we', ends: ['we', 'wd.we'] }, { name: 'din', ends: ['din', 'wd.d'] },
      { name: 'dout', ends: ['out.y', 'dout'] },
    ];
    const ctl: Record<string, string[]> = { pre: ['pre'], sae: ['sae'] };
    const wls: string[][] = Array.from({ length: R }, (_, r) => [`rdec.y${r}`]);
    const dl = ['wd.bl'], dlb = ['wd.blb', 'out.a'];
    for (let c = 0; c < C; c++) {
      const nm = `col${c}`;
      instances.push({ name: nm, def: COL, at: [xc + dx * c, yc], label: `bit ${c}` });
      ctl.pre.push(`${nm}.pre`);
      ctl.sae.push(`${nm}.sae`);
      for (let r = 0; r < R; r++) wls[r].push(`${nm}.wl${r}`);
      nets.push({ name: `csel ${c}`, ends: [`cdec.y${c}`, `${nm}.csel`], tags: [`${nm}.csel`] });
      dl.push(`${nm}.dl`);
      dlb.push(`${nm}.dlb`);
    }
    for (const [s, ends] of Object.entries(ctl)) nets.push({ name: s, ends, tags: ends.slice(1) });
    wls.forEach((ends, r) => nets.push({ name: `word ${r}`, ends, tags: ends.slice(2) }));
    nets.push({ name: 'dl', cap: DATA_C, ends: dl, trunk: yb + 2 }, { name: 'dl̄', cap: DATA_C, ends: dlb, trunk: yb + 6 });
    const right = xc + dx * C + 4;
    return define({
      id: `dram${R}x${C}`, name: `${R} × ${C} DRAM array`, category: 'memory',
      summary: `${R * C} bits of 1T1C cells (${R * C} transistors, ${R * C} capacitors) at switch level, with precharge to VDD/2, a sense amplifier per column (the row buffer), row and column decoders, a write driver.`,
      ports: [{ name: 'row', width: kr, dir: 'in' }, bit('act', 'in'), bit('pre', 'in'), bit('sae', 'in'),
        { name: 'col', width: kc, dir: 'in' }, bit('cs', 'in'), bit('we', 'in'), bit('din', 'in'), bit('dout', 'out')],
      symbol: { kind: 'box', label: `DRAM ${R}×${C}` },
      netlist: () => ({
        level: 'switch',
        pins: { row: [0, rg.ports.a.pos[1] + yc + cg.ports.wl0.pos[1] - rg.ports.y0.pos[1]], act: [0, rg.ports.en.pos[1] + yc + cg.ports.wl0.pos[1] - rg.ports.y0.pos[1]],
          pre: [0, yc + cg.ports.pre.pos[1]], sae: [0, yc + cg.ports.sae.pos[1]],
          col: [0, yb + 4 + dg.ports.a.pos[1]], cs: [0, yb + 4 + dg.ports.en.pos[1]],
          we: [0, yw + wg.ports.we.pos[1]], din: [0, yw + wg.ports.d.pos[1]], dout: [right, yb + 7] },
        instances, nets,
      }),
    });
  });
}

/** The chapter's arrays: 4 × 4 in the scenes, 8 × 8 on the workbench. */
export const DRAM4X4 = dramArray(4, 4);
export const DRAM8X8 = dramArray(8, 8);

