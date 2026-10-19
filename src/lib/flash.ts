// Chapter 35's flash at switch level. The floating-gate transistor (prim 'fgmos', SwitchSim) is an
// NMOS whose threshold is stored charge: erased it conducts at the read voltage, programmed it does
// not. A NOR array puts every cell between its bit line and a common source (one contact per cell,
// random reads); a NAND block puts eight in series between a string select and a ground select
// (one contact per string: density), and reads a cell by passing the others. Program pulls a bit
// line low for each 0 to write (a 1 inhibits), one pulse at a time; erase empties a whole block.

import { symbolGeom } from '../sim/geometry';
import { FG_READ, FG_STEP } from '../sim/switchsim';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { NMOS_STRONG } from './cells';
import { decoder } from './combinational';
import { define } from './define';
import { NOT, OR } from './gates';
import { PULLUP } from './switchparts';
import { GND, INV_CMOS, NMOS, NOR_CMOS, VDD } from './transistors';

const bit = (name: string, dir: 'in' | 'out' | 'inout', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

/** Threshold voltage of a floating gate holding charge q (erased 1 V, fully programmed 6 V), and the read voltage. */
export const vtOf = (q: number) => 1 + 5 * q;
export const V_READ = vtOf(FG_READ);

/** The floating-gate transistor: a flash cell. */
export const FG_CELL: ComponentDef = define({
  id: 'fgmos', name: 'Floating-gate transistor', category: 'memory', prim: 'fgmos',
  summary: `An NMOS with a second, insulated gate under its control gate. Charge trapped there raises the threshold: erased (Vt ${vtOf(0)} V) it conducts at the read voltage (${V_READ} V), programmed (Vt ≥ ${V_READ} V) it does not. The charge stays for years without power.`,
  ports: [bit('g', 'in'), bit('d', 'inout', 'top'), bit('s', 'inout', 'bottom'), bit('vp', 'in'), bit('pgm', 'in'), bit('ers', 'in')],
  symbol: { kind: 'box', label: 'FG', w: 5, h: 8, portPos: { d: 2.5, s: 2.5, g: 1, vp: 3, pgm: 5, ers: 7 } },
  notes: `Program: a high voltage on the control gate with the channel held at 0 V pulls electrons through the thin oxide onto
    the floating gate (here a rising pgm with g = 1 and the drain at 0 adds ${FG_STEP} of charge, ${Math.ceil(FG_READ / FG_STEP)} pulses to
    program; real devices program in steps and verify after each). Erase: a high voltage on the substrate pulls them all off
    again, for a whole block at once (a rising ers). vp is the pass voltage of a NAND string: above any threshold, the cell
    conducts whatever it holds. Mask ROM (chapter 10) is the same idea fixed at manufacture: a transistor there or not.`,
  hdl: { verilog: '// a floating-gate transistor: its threshold is stored charge (not Verilog)' },
});

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/**
 * One column's periphery, placed with the column at x: a pull-up on the bit line (trunk at x + 8), the
 * output inverter beside it, and the write driver at (xW, yW): a strong pull-down gated by
 * NOR(din, ¬pgm), so a 0 to write pulls the bit line low while pgm is high (a 1 leaves it high: inhibit).
 */
function columnIO(c: number, x: number, yTop: number, xW: number, yW: number, instances: InstanceDef[], nets: NetDef[], extraBl: string[]): void {
  instances.push(
    { name: `pu${c}`, def: PULLUP, at: [x + 7, yTop] },
    { name: `inv${c}`, def: INV_CMOS, at: [x + 11, yTop + 4] },
    { name: `w${c}`, def: NOR_CMOS, at: [xW - 6, yW], label: `write 0` },
    { name: `wd${c}`, def: NMOS_STRONG, at: [xW, yW] }, { name: `wg${c}`, def: GND, at: [xW + 2, yW + 5] },
  );
  nets.push(
    { name: `bit line ${c}`, ends: [`pu${c}.y`, `inv${c}.a`, `wd${c}.d`, ...extraBl], trunk: x + 8 },
    { name: `din${c}`, ends: [`din${c}`, `w${c}.a`], tags: [`w${c}.a`] },
    { name: `pull ${c}`, ends: [`w${c}.y`, `wd${c}.g`] },
    { ends: [`wd${c}.s`, `wg${c}.p`] },
    { name: `dout${c}`, ends: [`inv${c}.y`, `dout${c}`], tags: [`inv${c}.y`] },
  );
}

/**
 * An R × C NOR flash array. Read (rd = 1): the selected row's word line goes to the read voltage, the
 * common source line to ground; an erased cell pulls its bit line low (dout = 1), a programmed one
 * leaves it to the pull-up (dout = 0). Program (a pulse on pgm): the selected row's cells whose din is
 * 0 get one program pulse (their bit line pulled low; din = 1 inhibits). Erase (a pulse on ers): every
 * cell back to 1. While programming the source line is held high, so only the cells whose bit line is
 * pulled low see the field across their oxide.
 */
export function norArray(R: number, C: number): ComponentDef {
  const kr = Math.round(Math.log2(R));
  return memo(`nor${R}x${C}`, () => {
    const cg = symbolGeom(FG_CELL), D = decoder(kr, true), dg = symbolGeom(D);
    const X0 = 8 + dg.w + 14, DX = 30, Y0 = 14, PY = cg.h + 6;
    const yEnd = Y0 + PY * R, yW = yEnd + 2;
    const instances: InstanceDef[] = [
      { name: 'dec', def: D, at: [8, Y0], label: 'row decoder' },
      { name: 'sel', def: OR, at: [0, Y0 + dg.h + 4], label: 'rd or pgm' },
      { name: 'npg', def: NOT, at: [0, yW + 8], label: '¬pgm' },
      { name: 'ssw', def: NMOS, at: [X0 + DX * C - 2, yEnd + 4], label: 'to GND' }, { name: 'sg', def: GND, at: [X0 + DX * C, yEnd + 10] },
      { name: 'shi', def: NMOS, at: [X0 + DX * C + 6, yEnd + 4], label: 'high' }, { name: 'sv', def: VDD, at: [X0 + DX * C + 8, yEnd + 1] },
      { name: 'vpg', def: GND, at: [X0 + DX * C + 14, yEnd + 2] },
    ];
    const nets: NetDef[] = [
      { name: 'row', ends: ['row', 'dec.a'] },
      { name: 'wl on', ends: ['sel.y', 'dec.en'] },
      { ends: ['ssw.s', 'sg.p'] }, { ends: ['sv.p', 'shi.d'] },
    ];
    const pgmEnds = ['pgm', 'sel.b', 'npg.a', 'shi.g'], ersEnds = ['ers'], vpEnds = ['vpg.p'], slEnds = ['ssw.d', 'shi.s'], npgEnds = ['npg.y'];
    const wl: string[][] = Array.from({ length: R }, (_, r) => [`dec.y${r}`]);
    for (let c = 0; c < C; c++) {
      const x = X0 + DX * c, bl: string[] = [];
      for (let r = 0; r < R; r++) {
        const nm = `c${r}_${c}`;
        instances.push({ name: nm, def: FG_CELL, at: [x, Y0 + PY * r] });
        bl.push(`${nm}.d`);
        slEnds.push(`${nm}.s`);
        wl[r].push(`${nm}.g`);
        vpEnds.push(`${nm}.vp`);
        pgmEnds.push(`${nm}.pgm`);
        ersEnds.push(`${nm}.ers`);
      }
      columnIO(c, x, 0, x + 5, yW, instances, nets, bl);
      npgEnds.push(`w${c}.b`);
    }
    nets.push(
      { name: 'rd', ends: ['rd', 'sel.a', 'ssw.g'], tags: ['ssw.g'] },
      { name: 'pgm', ends: pgmEnds, tags: pgmEnds.slice(3) },
      { name: '¬pgm', ends: npgEnds, tags: npgEnds.slice(1) },
      { name: 'ers', ends: ersEnds, tags: ersEnds.slice(1) },
      { name: 'no pass', ends: vpEnds, tags: vpEnds.slice(1) },
      { name: 'source line', ends: slEnds, tags: slEnds.slice(2) },
      ...wl.map((ends, r) => ({ name: `word ${r}`, ends, tags: ends.slice(1) })),
    );
    const right = X0 + DX * C + 20;
    return define({
      id: `nor${R}x${C}`, name: `${R} × ${C} NOR flash array`, category: 'memory',
      summary: `${R * C} floating-gate cells, each between its bit line and a common source line: any cell is read directly (random access, a contact per cell). Program sets 0s a row at a time, pulse by pulse; erase sets every cell back to 1.`,
      ports: [bus('row', kr, 'in'), bit('rd', 'in'), bit('pgm', 'in'), bit('ers', 'in'), ...Array.from({ length: C }, (_, c) => bit(`din${c}`, 'in')), ...Array.from({ length: C }, (_, c) => bit(`dout${c}`, 'out'))],
      symbol: { kind: 'box', label: `NOR ${R}×${C}` },
      netlist: () => ({
        level: 'switch',
        pins: {
          row: [0, Y0 + dg.ports.a.pos[1]], rd: [-4, Y0 + dg.h + 5], pgm: [-4, yW + 9], ers: [-4, yW + 14],
          ...Object.fromEntries(Array.from({ length: C }, (_, c) => [`din${c}`, [-4, yW + 18 + 2 * c] as [number, number]])),
          ...Object.fromEntries(Array.from({ length: C }, (_, c) => [`dout${c}`, [right, 4 + 2 * c] as [number, number]])),
        },
        instances, nets,
      }),
    });
  });
}

/**
 * A NAND flash block: S strings of N cells in series, a string select at the bit-line end and a
 * ground select at the source end. Read (rd = 1): the selected row's word line at the read voltage,
 * every other at the pass voltage, both selects on; a string conducts (dout = 1) only if its selected
 * cell is erased. Program (a pulse on pgm): the selected row's cells whose din is 0 get a pulse (the bit
 * line low reaches them through the passed cells above; din = 1 inhibits). Erase: the whole block.
 */
export function nandBlock(S: number, N: number): ComponentDef {
  const kr = Math.round(Math.log2(N));
  return memo(`nand${S}x${N}`, () => {
    const cg = symbolGeom(FG_CELL), D = decoder(kr, true), dg = symbolGeom(D), PG = symbolGeom(NOR_CMOS);
    const X0 = 8 + dg.w + 24, DX = 30, Y0 = 22, PY = cg.h + 2;
    const yEnd = Y0 + 6 + PY * N;
    const instances: InstanceDef[] = [
      { name: 'dec', def: D, at: [8, Y0 + 4], label: 'row decoder' },
      { name: 'act', def: OR, at: [0, Y0 + dg.h + 8], label: 'rd or pgm' },
      { name: 'nact', def: NOT, at: [8, Y0 + dg.h + 14], label: '¬act' },
      { name: 'npg', def: NOT, at: [0, 6], label: '¬pgm' },
    ];
    const nets: NetDef[] = [{ name: 'row', ends: ['row', 'dec.a'] }];
    const xp = 8 + dg.w + 6;
    const words: string[][] = [], passes: string[][] = [], nactEnds = ['nact.y'];
    for (let r = 0; r < N; r++) {
      // the selected row at the read / program voltage (word r), every other at the pass voltage (pass r = NOR(sel, ¬act))
      const y = Y0 + 6 + PY * r + 1;
      instances.push({ name: `p${r}`, def: NOR_CMOS, at: [xp, y], label: `pass ${r}` });
      words.push([`dec.y${r}`, `p${r}.a`]);
      passes.push([`p${r}.y`]);
      nactEnds.push(`p${r}.b`);
    }
    void PG;
    const actEnds = ['act.y', 'dec.en', 'nact.a'], rdEnds = ['rd', 'act.a'], pgmEnds = ['pgm', 'act.b', 'npg.a'], ersEnds = ['ers'], npgEnds = ['npg.y'];
    for (let c = 0; c < S; c++) {
      const x = X0 + DX * c;
      // the string: select at the top, cells in series, ground select at the bottom
      instances.push(
        { name: `ss${c}`, def: NMOS, at: [x + 5, Y0 - 2], label: 'string select' },
        { name: `gs${c}`, def: NMOS, at: [x + 5, yEnd], label: 'ground select' }, { name: `gg${c}`, def: GND, at: [x + 7, yEnd + 5] },
      );
      nets.push({ ends: [`gs${c}.s`, `gg${c}.p`] });
      actEnds.push(`ss${c}.g`);
      rdEnds.push(`gs${c}.g`);
      let above = `ss${c}.s`;
      for (let r = 0; r < N; r++) {
        const nm = `c${r}_${c}`;
        instances.push({ name: nm, def: FG_CELL, at: [x + 8 - cg.ports.d.pos[0], Y0 + 6 + PY * r] });
        nets.push({ ends: [above, `${nm}.d`] });
        above = `${nm}.s`;
        words[r].push(`${nm}.g`);
        passes[r].push(`${nm}.vp`);
        pgmEnds.push(`${nm}.pgm`);
        ersEnds.push(`${nm}.ers`);
      }
      nets.push({ ends: [above, `gs${c}.d`] });
      columnIO(c, x, 0, x + 12, 8, instances, nets, [`ss${c}.d`]);
      npgEnds.push(`w${c}.b`);
    }
    nets.push(
      { name: 'act', ends: actEnds, tags: actEnds.slice(3) },
      { name: '¬act', ends: nactEnds },
      { name: 'rd', ends: rdEnds, tags: rdEnds.slice(2) },
      { name: 'pgm', ends: pgmEnds, tags: pgmEnds.slice(3) },
      { name: '¬pgm', ends: npgEnds, tags: npgEnds.slice(1) },
      { name: 'ers', ends: ersEnds, tags: ersEnds.slice(1) },
      ...words.map((ends, r) => ({ name: `word ${r}`, ends, tags: ends.slice(2) })),
      ...passes.map((ends, r) => ({ name: `pass ${r}`, ends, tags: ends.slice(1) })),
    );
    const right = X0 + DX * S + 18;
    return define({
      id: `nand${S}x${N}`, name: `NAND flash block (${S} strings × ${N} cells)`, category: 'memory',
      summary: `${S * N} floating-gate cells in ${S} strings of ${N} in series: one bit-line contact per string instead of per cell. A read passes the other ${N - 1} cells of each string; program and erase as in NOR, erase a whole block at a time.`,
      ports: [bus('row', kr, 'in'), bit('rd', 'in'), bit('pgm', 'in'), bit('ers', 'in'), ...Array.from({ length: S }, (_, c) => bit(`din${c}`, 'in')), ...Array.from({ length: S }, (_, c) => bit(`dout${c}`, 'out'))],
      symbol: { kind: 'box', label: `NAND ${S}×${N}` },
      netlist: () => ({
        level: 'switch',
        pins: {
          row: [0, Y0 + 4 + dg.ports.a.pos[1]], rd: [-4, Y0 + dg.h + 9], pgm: [-4, 7], ers: [-4, yEnd + 10],
          ...Object.fromEntries(Array.from({ length: S }, (_, c) => [`din${c}`, [-4, yEnd + 14 + 2 * c] as [number, number]])),
          ...Object.fromEntries(Array.from({ length: S }, (_, c) => [`dout${c}`, [right, 4 + 2 * c] as [number, number]])),
        },
        instances, nets,
      }),
    });
  });
}

export const NOR4X4 = norArray(4, 4);
export const NAND4X8 = nandBlock(4, 8);
