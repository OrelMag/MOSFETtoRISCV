// The DRAM array as parts (DOM-free). Row 0 is the front row, columns run along x. Every charge stands on the plate as a
// solid whose HEIGHT is the simulator's level (a fraction of VDD) and whose footprint AREA is proportional to its
// capacitance, so its volume is its charge. A cell is a round column; a bit line is what it is on silicon, a long line,
// here a trough behind its column of cells whose length grows with its capacitance (more cells hang on a longer line), with
// the reference line beside it. Open a row and a cell's volume pours into its bit line until both stand at one height; the
// sense amplifier where the pair begins then drives them apart, to the rails.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { CELL_C } from '../lib/dram';
import type { DramSnap } from './dram3dbench';

export const PITCH = 10, HMAX = 18, R_CELL = 1.8, PAD = 0.3;
/** A cell's footprint, and a bit line's width: its length is then its capacitance over this width. */
export const A_CELL = Math.PI * R_CELL * R_CELL, W_LINE = 2.6;
export const X_OF = (c: number) => (c - 1.5) * PITCH;
export const Z_OF = (r: number) => (1.5 - r) * PITCH;
/** A column's bit line and reference line, along x; where both begin (the amplifier's end) and how long they run. */
export const BL_X = (c: number) => X_OF(c) + 4.6, BLB_X = (c: number) => X_OF(c) + 7.6;
export const LINE_Z0 = Z_OF(3) - 9;
/** Length of a bit line `ratio` times a cell's capacitance: area ∝ C, so ratio × A_CELL over the width. */
export const lineLength = (ratio: number) => (ratio * A_CELL) / W_LINE;

export interface DramPalette { plate: RGB; line: RGB; charge: RGB; open: RGB; unknown: RGBA; bl: RGB; blb: RGB; wl: RGB; amp: RGB; half: RGBA; fet: RGB }

/** A trough of level `lv` from z0 back by `len`, W_LINE wide at x. */
function trough(out: Part[], P: DramPalette, x: number, z0: number, len: number, lv: number, c: RGB): void {
  const z1 = z0 - len;
  out.push(box(P.line, x - W_LINE / 2 - 0.25, x + W_LINE / 2 + 0.25, 0, PAD, z1 - 0.25, z0 + 0.25));
  if (!Number.isFinite(lv)) { out.push(box(P.unknown, x - W_LINE / 2, x + W_LINE / 2, PAD, PAD + HMAX * 0.5, z1, z0)); return; }
  if (lv * HMAX > 0.02) out.push(box(c, x - W_LINE / 2, x + W_LINE / 2, PAD, PAD + lv * HMAX, z1, z0, 0.2));
}

export function dramParts(s: DramSnap, P: DramPalette): Part[] {
  const out: Part[] = [], L = lineLength(s.ratio);
  const rows = s.cell.length, cols = s.bl.length, x0 = X_OF(0) - 7, x1 = X_OF(cols - 1) + 10, zf = Z_OF(0) + 7, zb = LINE_Z0 - L - 4;
  // The plate in tiles (the flat view sorts faces by their middles; one long slab would be drawn over the lines).
  const tile = 12;
  for (let z = zf; z > zb; z -= tile) out.push(box(P.plate, x0, x1, -1.2, 0, Math.max(zb, z - tile), z));
  // Word lines: one a row, raised (lit) on the open row.
  for (let r = 0; r < rows; r++) {
    const z = Z_OF(r) + 4.4, lit = r === s.open;
    out.push(rod(lit ? P.wl : P.line, [x0 + 1, 0.3, z], [x1 - 1, 0.3, z], lit ? 0.55 : 0.35, lit ? 0.3 : 0));
  }
  for (let c = 0; c < cols; c++) {
    // The bit line's wire past its cells to the amplifier.
    out.push(rod(P.line, [BL_X(c), 0.3, zf - 1], [BL_X(c), 0.3, LINE_Z0 + 2.5], 0.35));
    // The sense amplifier at the head of the pair: lit while it drives them.
    const amp = box(s.sensed ? P.amp : P.line, BL_X(c) - 1.6, BLB_X(c) + 1.6, 0, s.sensed ? 1.6 : 1.0, LINE_Z0 + 0.6, LINE_Z0 + 3.4, 0.4);
    if (s.sensed) amp.emissive = [P.amp[0] * 0.5, P.amp[1] * 0.5, P.amp[2] * 0.5];
    out.push(amp);
    trough(out, P, BL_X(c), LINE_Z0, L, s.bl[c], P.bl);
    trough(out, P, BLB_X(c), LINE_Z0, L, s.blb[c], P.blb);
  }
  // Cells: a column each, and the access transistor joining it to its bit line (lit, conducting, on the open row).
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = X_OF(c), z = Z_OF(r), lv = s.cell[r][c], open = r === s.open;
    out.push(cyl(P.line, x, z, 0, PAD, R_CELL * 1.08));
    if (!Number.isFinite(lv)) out.push(cyl(P.unknown, x, z, PAD, PAD + HMAX * 0.5, R_CELL));
    else if (lv * HMAX > 0.02) out.push(cyl(open ? P.open : P.charge, x, z, PAD, PAD + lv * HMAX, R_CELL, 0.2));
    const fet = box(open ? P.wl : P.fet, x + 2.2, x + 3.9, 0, open ? 1.4 : 0.9, z - 0.7, z + 0.7, 0.3);
    if (open) fet.emissive = [P.wl[0] * 0.35, P.wl[1] * 0.35, P.wl[2] * 0.35];
    out.push(fet);
  }
  // VDD/2, what both lines are precharged to: a glass sheet at half height over the lines.
  out.push(box(P.half, BL_X(0) - 2.5, BLB_X(cols - 1) + 2.5, PAD + HMAX / 2 - 0.08, PAD + HMAX / 2 + 0.08, LINE_Z0 - L, LINE_Z0));
  return out;
}

export function dramAnchors(s: DramSnap): Anchor[] {
  const up: Vec3 = [0, 1, 0], left: Vec3 = [-1, 0.2, 0.4], L = lineLength(s.ratio);
  const r = s.open >= 0 ? s.open : 0, c = s.bl.length - 1;
  return [
    { text: s.open >= 0 ? `word line, row ${r}: up, above VDD + VT` : `word line, row ${r}`, p: [X_OF(0) - 7, 0.3, Z_OF(r) + 4.4], side: 'l', n: left },
    { text: `bit line: ${s.ratio}× a cell (${s.ratio * CELL_C} fF)`, p: [BL_X(1), PAD + HMAX * 0.62, LINE_Z0 - L * 0.5], side: 't', n: up },
    { text: s.sensed ? 'sense amplifiers: driving' : 'sense amplifiers', p: [BLB_X(c) + 1.6, 1.2, LINE_Z0 + 2], side: 'r', n: up },
    { text: 'reference bit line', p: [BLB_X(c), PAD + HMAX * 0.55, LINE_Z0 - L * 0.7], side: 'r', n: up, minor: true },
    { text: 'access transistor', p: [X_OF(c) + 3.9, 1.2, Z_OF(0)], side: 'r', n: up, minor: true },
    { text: 'VDD/2', p: [BL_X(0) - 2.5, PAD + HMAX / 2, LINE_Z0 - L * 0.3], side: 'l', n: left, minor: true },
  ];
}
