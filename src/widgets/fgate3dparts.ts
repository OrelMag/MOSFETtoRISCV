// A NAND string of four floating-gate cells: its dimensions, the voltages and fields a pulse stands for, and where each drawn
// electron sits (DOM-free, tested). fgate3dkit.ts draws it; the charge is phys/fgate.ts's, so the picture cannot say anything the
// rule does not.

import type { Vec3 } from '../gl/math';
import { CELLS, type Bank } from '../phys/fgate';

export const PITCH = 16, HALF = 6;
/** Layer heights: substrate top at 0, tunnel oxide to FG0, floating gate FG0..FG1, ONO (oxide / nitride / oxide, ONO_T each) to CG0,
 *  control gate to CG1. Real: tunnel oxide 8-10 nm, ONO ~15 nm equivalent oxide (thicker than the tunnel oxide: drawn 3 : 4.5),
 *  floating gate 50-100 nm (drawn thinner, as everything is); Pavan et al., Proc. IEEE 85 (1997). */
export const FG0 = 3, FG1 = 8, ONO_T = 1.5, CG0 = FG1 + 3 * ONO_T, CG1 = CG0 + 3.5;
/** Tunnel-oxide thickness (nm) the drawing stands for, the programming voltage a pulse stands for, the field FN tunnelling needs (MV/cm). */
export const T_TUNNEL_NM = 8, V_PGM = 20, FN_MV_CM = 10;
/** Coupling ratio GCR = C_ONO / (C_ONO + C_tox + ...): the fraction of the control-gate voltage the floating gate takes. The model's
 *  Vt = 1 + 5q is the 0.6 case: the window per full charge is Q / C_ONO = WINDOW_K / GCR volts. */
export const GCR_MODEL = 0.6, WINDOW_K = 5 * GCR_MODEL;
export const windowOf = (gcr: number): number => WINDOW_K / gcr;
/** Volts across the tunnel oxide while V_PGM is on the control gate and the channel is at 0 V, and the field (MV/cm). */
export const toxVolts = (gcr: number): number => gcr * V_PGM;
export const toxField = (gcr: number): number => (toxVolts(gcr) / T_TUNNEL_NM) * 10;

export const cellX = (i: number): number => (i - (CELLS - 1) / 2) * PITCH;
export interface FgPose {
  bank: Bank; reading: boolean; programming: boolean; fly?: { cell: number; n0: number; n1: number; t: number };
  /** An erase under way: the electrons each cell held, leaving down through the tunnel oxide into the p-well; t 0..1. */
  erase?: { from: number[]; t: number };
  /** How hard the tunnel oxide is stressed (0..1, a pulse or an erase on): its colour warms. */
  field?: number;
}

const COLS = 5;
/** Where electron k sits in a floating gate: 5 across, two deep, two layers high, filled in that order. */
export function slot(cell: number, k: number): Vec3 {
  const c = k % COLS, r = Math.floor(k / COLS) % 2, l = Math.floor(k / (2 * COLS));
  return [cellX(cell) + (c - (COLS - 1) / 2) * 2, FG0 + (FG1 - FG0) * (0.3 + 0.4 * l), (r - 0.5) * 5];
}
/** Where electron k of a cell is while it leaves (t 0..1): straight down from its slot into the p-well. */
export function leaving(cell: number, k: number, t: number): Vec3 {
  const p = slot(cell, k), e = t * t * (3 - 2 * t);
  return [p[0], p[1] + (-4 - p[1]) * e, p[2]];
}
