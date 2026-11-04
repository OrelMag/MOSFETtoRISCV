// The DRAM array as parts (DOM-free). Row 0 is the front row, columns run along x. Every cell and bit line is a column
// standing on the plate: its HEIGHT is the simulator's level (a fraction of VDD) and its footprint area is proportional to
// its capacitance, so a column's volume is its charge. Charge sharing is then visible: open a row and the cell's volume
// pours into the four times wider bit-line column until both stand at the same height.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { BITLINE_C, CELL_C } from '../lib/dram';
import type { DramSnap } from './dram3dbench';

export const PITCH = 10, HMAX = 18, R_CELL = 1.8, PAD = 0.3, BL_Z = -30;
/** Footprint radius from capacitance: area is proportional to C. */
export const R_BL = R_CELL * Math.sqrt(BITLINE_C / CELL_C);
export const X_OF = (c: number) => (c - 1.5) * PITCH;
export const Z_OF = (r: number) => (1.5 - r) * PITCH;

export interface DramPalette { plate: RGB; line: RGB; charge: RGB; open: RGB; unknown: RGBA; bl: RGB; wl: RGB }

export function dramParts(s: DramSnap, P: DramPalette): Part[] {
  const out: Part[] = [];
  const rows = s.cell.length, cols = s.bl.length, x0 = X_OF(0) - 7, x1 = X_OF(cols - 1) + 7, zf = Z_OF(0) + 7, zb = BL_Z - 6;
  out.push(box(P.plate, x0, x1, -1.2, 0, zb, zf));
  for (let r = 0; r < rows; r++) {
    const z = Z_OF(r) + 4.4, lit = r === s.open;
    out.push(rod(lit ? P.wl : P.line, [x0 + 1, 0.3, z], [x1 - 1, 0.3, z], lit ? 0.55 : 0.35, lit ? 0.3 : 0));
  }
  for (let c = 0; c < cols; c++) {
    const x = X_OF(c) + 4.6;
    out.push(rod(P.line, [x, 0.3, zf - 1], [x, 0.3, BL_Z], 0.35), rod(P.line, [x, 0.3, BL_Z], [X_OF(c), 0.3, BL_Z], 0.35));
  }
  const column = (x: number, z: number, r: number, lv: number, c: RGB): void => {
    out.push(cyl(P.line, x, z, 0, PAD, r * 1.08));
    if (!Number.isFinite(lv)) { out.push(cyl(P.unknown, x, z, PAD, PAD + HMAX * 0.5, r)); return; }
    if (lv * HMAX > 0.02) out.push(cyl(c, x, z, PAD, PAD + lv * HMAX, r, 0.2));
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) column(X_OF(c), Z_OF(r), R_CELL, s.cell[r][c], r === s.open ? P.open : P.charge);
  for (let c = 0; c < cols; c++) column(X_OF(c), BL_Z, R_BL, s.bl[c], P.bl);
  // The VDD/2 line the bit lines are precharged to: a thin ring of rods at the half height of a full column.
  const hy = PAD + HMAX / 2;
  out.push(rod(P.line, [x0, hy, zf], [x0, hy, zb], 0.2), rod(P.line, [x0, hy, zb], [x0 + 3, hy, zb], 0.2));
  return out;
}

export function dramAnchors(s: DramSnap): Anchor[] {
  const up: Vec3 = [0, 1, 0], left: Vec3 = [-1, 0.2, 0.4];
  const r = s.open >= 0 ? s.open : 0;
  return [
    { text: `word line, row ${r}${s.open >= 0 ? ' (up)' : ''}`, p: [X_OF(0) - 7, 0.3, Z_OF(r) + 4.4], side: 'l', n: left },
    { text: 'bit line: 4x the capacitance', p: [X_OF(1), PAD + HMAX + 1, BL_Z], side: 't', n: up },
    { text: 'VDD/2', p: [X_OF(0) - 7, PAD + HMAX / 2, Z_OF(0) + 7], side: 'l', n: left, minor: true },
  ];
}
