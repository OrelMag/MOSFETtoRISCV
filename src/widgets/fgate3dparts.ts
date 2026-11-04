// A NAND string of four floating-gate cells as parts (DOM-free, tested): one silicon strip, per cell a tunnel oxide, a
// floating gate sealed in oxide, a control gate with a wire. Charge is a count of electrons in the floating gate, taken
// from phys/fgate.ts, so the picture cannot say anything the rule does not.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';
import { CELLS, electrons, readConduction, stringConducts, type Bank } from '../phys/fgate';

export const PITCH = 16, HALF = 6, DEPTH = 7.5;
/** Layer heights: substrate top at 0, tunnel oxide to TOX, floating gate FG0..FG1, interpoly oxide to CG0, control gate to CG1. */
export const TOX = 2.2, FG0 = 3, FG1 = 8, CG0 = 10, CG1 = 13, WIRE = 21;
export const cellX = (i: number): number => (i - (CELLS - 1) / 2) * PITCH;
export interface FgPose { bank: Bank; reading: boolean; programming: boolean; fly?: { cell: number; n0: number; n1: number; t: number } }
export interface FgPalette { si: RGB; n: RGB; poly: RGB; oxide: RGB; metal: RGB; charge: RGB; carrier: RGB; hot: RGB }

const COLS = 5;
/** Where electron k sits in a floating gate: 5 across, two deep, two layers high, filled in that order. */
export function slot(cell: number, k: number): Vec3 {
  const c = k % COLS, r = Math.floor(k / COLS) % 2, l = Math.floor(k / (2 * COLS));
  return [cellX(cell) + (c - (COLS - 1) / 2) * 2, FG0 + (FG1 - FG0) * (0.3 + 0.4 * l), (r - 0.5) * 5];
}
const glow = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const oxideA = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], a];

export function fgParts(p: FgPose, P: FgPalette): Part[] {
  const out: Part[] = [], on = p.reading ? readConduction(p.bank) : null, all = p.reading && stringConducts(p.bank);
  // Substrate with the shared n+ source / drain regions between the cells (the string's cells share them).
  out.push(box(P.si, -38, 38, -10, 0, -9.5, 9.5, 0.1));
  for (let k = 0; k <= CELLS; k++) {
    const x = (k - CELLS / 2) * PITCH;
    out.push({ ...box(P.n, x - 3, x + 3, -3, 0.02, -9.5, 9.5, 0.1), emissive: all ? glow(P.hot, 0.35) : undefined });
  }
  for (let i = 0; i < CELLS; i++) {
    const x = cellX(i), sel = i === p.bank.sel;
    // The channel under the cell: a thin slab that lights while the cell conducts.
    out.push({ ...box(P.si, x - HALF, x + HALF, -0.5, 0.02, -DEPTH, DEPTH), color: on?.[i] ? P.hot : P.si, emissive: on?.[i] ? glow(P.hot, 0.55) : undefined });
    // Control gate and its wire up to a word-line pad: the only conductor that reaches this cell.
    out.push({ ...box(P.poly, x - HALF, x + HALF, CG0, CG1, -DEPTH, DEPTH, 0.2), emissive: sel ? glow(P.poly, 0.25) : undefined });
    out.push(rod(P.metal, [x, CG1, 0], [x, WIRE, 0], 0.5, 0.5));
    const live = p.programming ? sel : p.reading;
    out.push({ ...box(live ? P.hot : P.metal, x - 2.5, x + 2.5, WIRE, WIRE + 1.4, -2, 2, 0.4), emissive: live ? glow(P.hot, 0.5) : undefined });
    // The floating gate: no wire, a charge store.
    out.push({ ...box(P.poly, x - HALF + 1.2, x + HALF - 1.2, FG0, FG1, -DEPTH + 1.5, DEPTH - 1.5, 0.3), color: oxideA(glow(P.poly, 0.9), 0.45) });
    // Electrons: the count follows the charge; a pulse's new ones fly up from the channel.
    const n = electrons(p.bank.q[i]);
    for (let k = 0; k < n; k++) {
      let pos = slot(i, k);
      const f = p.fly;
      if (f && f.cell === i && k >= f.n0 && k < f.n1) {
        const e = 1 - (1 - f.t) ** 2;
        pos = [pos[0], -0.8 + (pos[1] + 0.8) * e, pos[2]];
      }
      out.push({ ...box(P.carrier, -0.8, 0.8, -0.8, 0.8, -0.8, 0.8, 0.6), pos, emissive: glow(P.charge, 0.9), color: P.charge });
    }
  }
  // Oxide last, transparent, over each stack: tunnel oxide below the floating gate, interpoly oxide above and round it.
  for (let i = 0; i < CELLS; i++) {
    const x = cellX(i);
    out.push(box(oxideA(P.oxide, 0.3), x - HALF, x + HALF, 0.02, CG0, -DEPTH, DEPTH));
  }
  return out;
}

export function fgAnchors(p: FgPose): Anchor[] {
  const front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0], s = p.bank.sel;
  return [
    { text: 'word line (wired)', p: [cellX(0), WIRE + 0.7, 2], side: 'l', n: up },
    { text: 'control gate', p: [cellX(0) - HALF, (CG0 + CG1) / 2, DEPTH], side: 'l', n: front },
    { text: 'floating gate: no wire', p: [cellX(s) + HALF - 1.5, (FG0 + FG1) / 2, DEPTH - 1.5], side: 'r', n: front },
    { text: 'oxide', p: [cellX(CELLS - 1) + HALF, (TOX + FG0) / 2, DEPTH], side: 'r', n: front },
    { text: 'n+', p: [(CELLS / 2) * PITCH, -1.5, DEPTH], side: 'r', n: front },
    { text: 'channel', p: [cellX(0), -0.3, DEPTH], side: 'l', n: front },
    { text: 'p substrate', p: [0, -10, DEPTH], side: 'b', n: front },
  ];
}
