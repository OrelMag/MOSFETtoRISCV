// A NAND string of four floating-gate cells as parts (DOM-free, tested): one silicon strip, per cell a tunnel oxide, a
// floating gate sealed in oxide, an ONO dielectric and a control gate that wraps the floating gate's sidewalls and has a
// wire. Charge is a count of electrons in the floating gate, taken from phys/fgate.ts, so the picture cannot say anything
// the rule does not.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';
import { CELLS, electrons, readConduction, stringConducts, type Bank } from '../phys/fgate';

export const PITCH = 16, HALF = 6, DEPTH = 7.5;
/** Layer heights: substrate top at 0, tunnel oxide to FG0, floating gate FG0..FG1, ONO (oxide / nitride / oxide, ONO_T each) to CG0,
 *  control gate to CG1. Real: tunnel oxide 8-10 nm, ONO ~15 nm equivalent oxide (thicker than the tunnel oxide: drawn 3 : 4.5),
 *  floating gate 50-100 nm (drawn thinner, as everything is); Pavan et al., Proc. IEEE 85 (1997). */
export const FG0 = 3, FG1 = 8, ONO_T = 1.5, CG0 = FG1 + 3 * ONO_T, CG1 = CG0 + 3.5, WIRE = 24;
export const TOX = FG0;
/** The control gate's sidewall reaches down beside the floating gate (NAND), WALL thick; the gap to the next cell's stays open. */
export const WALL = 1, WALL_OFF = 0.6, WALL_FOOT = 1.2;
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
export interface FgPalette { si: RGB; n: RGB; poly: RGB; oxide: RGB; nitride: RGB; metal: RGB; charge: RGB; carrier: RGB; hot: RGB }

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
const glow = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const oxideA = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], a];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function fgParts(p: FgPose, P: FgPalette): Part[] {
  const out: Part[] = [], on = p.reading ? readConduction(p.bank) : null, all = p.reading && stringConducts(p.bank);
  // Substrate (a p-well that lights while an erase is on) with the shared n+ source / drain regions between the cells.
  out.push({ ...box(P.si, -38, 38, -10, 0, -9.5, 9.5, 0.1), emissive: p.erase ? glow(P.hot, 0.35) : undefined });
  for (let k = 0; k <= CELLS; k++) {
    const x = (k - CELLS / 2) * PITCH;
    out.push({ ...box(P.n, x - 3, x + 3, -3, 0.02, -9.5, 9.5, 0.1), emissive: all ? glow(P.hot, 0.35) : undefined });
  }
  // The string's ends: a contact up from the first n+ to the bit line, and from the last to the common source line.
  for (const sg of [-1, 1]) {
    const x = sg * (CELLS / 2) * PITCH;
    out.push(rod(P.metal, [x, 0, 0], [x, WIRE + 3, 0], 0.7, 0.5), box(P.metal, Math.min(x, x + sg * 14), Math.max(x, x + sg * 14), WIRE + 3, WIRE + 4, -1, 1, 0.4));
  }
  for (let i = 0; i < CELLS; i++) {
    const x = cellX(i), sel = i === p.bank.sel;
    // The channel under the cell: a thin slab that lights while the cell conducts.
    out.push({ ...box(P.si, x - HALF, x + HALF, -0.5, 0.02, -DEPTH, DEPTH), color: on?.[i] ? P.hot : P.si, emissive: on?.[i] ? glow(P.hot, 0.55) : undefined });
    // Control gate: a top plate and two sidewalls down beside the floating gate; its wire goes up to a word-line pad, the only
    // conductor that reaches this cell.
    const cgE = sel ? glow(P.poly, 0.25) : undefined, o = HALF + WALL_OFF;
    out.push({ ...box(P.poly, x - o - WALL, x + o + WALL, CG0, CG1, -DEPTH, DEPTH, 0.2), emissive: cgE });
    for (const sg of [-1, 1]) out.push({ ...box(P.poly, x + sg * o, x + sg * (o + WALL), WALL_FOOT, CG0, -DEPTH, DEPTH, 0.2), emissive: cgE });
    out.push(rod(P.metal, [x, CG1, 0], [x, WIRE, 0], 0.5, 0.5));
    const live = p.programming ? sel : p.reading;
    out.push({ ...box(live ? P.hot : P.metal, x - 2.5, x + 2.5, WIRE, WIRE + 1.4, -2, 2, 0.4), emissive: live ? glow(P.hot, 0.5) : undefined });
    // The floating gate: no wire, a charge store; self-aligned under the control gate (same length).
    out.push({ ...box(P.poly, x - HALF, x + HALF, FG0, FG1, -DEPTH + 1.5, DEPTH - 1.5, 0.3), color: oxideA(glow(P.poly, 0.9), 0.45) });
    // Electrons: the count follows the charge; a pulse's new ones fly up from the channel, an erase's leave down into the well.
    const n = p.erase ? p.erase.from[i] : electrons(p.bank.q[i]);
    for (let k = 0; k < n; k++) {
      let pos = p.erase ? leaving(i, k, p.erase.t) : slot(i, k);
      const f = p.fly;
      if (f && f.cell === i && k >= f.n0 && k < f.n1) {
        const e = 1 - (1 - f.t) ** 2;
        pos = [pos[0], -0.8 + (pos[1] + 0.8) * e, pos[2]];
      }
      out.push({ ...box(P.carrier, -0.8, 0.8, -0.8, 0.8, -0.8, 0.8, 0.6), pos, emissive: glow(P.charge, 0.9), color: P.charge });
    }
  }
  // Dielectrics last, transparent: the tunnel oxide under the floating gate (warming with the field across it), the ONO above
  // it (oxide, nitride, oxide: the nitride the darker middle layer) and a thin oxide on the sidewalls, so the gate is sealed all round.
  const fld = p.field ?? 0;
  for (let i = 0; i < CELLS; i++) {
    const x = cellX(i), ox = oxideA(P.oxide, 0.5), z0 = -DEPTH + 1.5, z1 = DEPTH - 1.5;
    out.push(box(oxideA(mix(P.oxide, P.hot, 0.7 * fld), 0.55 + 0.2 * fld), x - HALF, x + HALF, 0.02, FG0, -DEPTH, DEPTH));
    out.push(box(ox, x - HALF, x + HALF, FG1, FG1 + ONO_T, z0, z1), box(oxideA(P.nitride, 0.6), x - HALF, x + HALF, FG1 + ONO_T, FG1 + 2 * ONO_T, z0, z1),
      box(ox, x - HALF, x + HALF, FG1 + 2 * ONO_T, CG0, z0, z1));
    for (const sg of [-1, 1]) out.push(box(ox, x + sg * HALF, x + sg * (HALF + WALL_OFF), FG0, CG0, z0, z1));
  }
  return out;
}

export function fgAnchors(p: FgPose): Anchor[] {
  const front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0], s = p.bank.sel, ex = (CELLS / 2) * PITCH;
  return [
    { text: 'word line (wired)', p: [cellX(0), WIRE + 0.7, 2], side: 'l', n: up },
    { text: 'control gate', p: [cellX(0) - HALF - WALL_OFF - WALL, (CG0 + CG1) / 2, DEPTH], side: 'l', n: front },
    { text: 'floating gate: no wire', p: [cellX(s) + HALF - 1.5, (FG0 + FG1) / 2, DEPTH - 1.5], side: 'r', n: front },
    { text: 'ONO', p: [cellX(CELLS - 1) + HALF, (FG1 + CG0) / 2, DEPTH - 1.5], side: 'r', n: front },
    { text: 'tunnel oxide', p: [cellX(CELLS - 1) + HALF, FG0 / 2, DEPTH], side: 'r', n: front },
    { text: 'n+', p: [ex - PITCH, -1.5, DEPTH], side: 'r', n: front },
    { text: 'channel', p: [cellX(0), -0.3, DEPTH], side: 'l', n: front },
    { text: p.erase ? 'p-well +20 V' : 'p substrate', p: [-14, -10, DEPTH], side: 'b', n: front },
    { text: 'bit line', p: [-ex - 13, WIRE + 3.5, 0], side: 'l', n: up, minor: true },
    { text: 'source line', p: [ex + 13, WIRE + 3.5, 0], side: 'r', n: up, minor: true },
  ];
}
