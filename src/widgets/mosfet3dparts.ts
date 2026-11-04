// The MOSFET in 3D, as parts (DOM-free): source and drain islands, the channel as a sheet whose thickness along x is the
// model's inversion charge (mosphys.ts), oxide and gate above it. W runs along z, L along x, both to scale of each other.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { channelCharge, VDD, VT } from './mosphys';

const W0 = 16, L0 = 12, SD = 11, JUNCTION = 3.6, DEPTH = 8, OX = 0.9, POLY = 3.6, RIM = 3, SEGS = 28;
/** The sheet's drawn thickness at the largest charge the sliders reach. */
export const SHEET_MAX = 2.6;
const Q_MAX = VDD - VT;

export interface MosState { vg: number; vd: number; w: number; l: number; lift: number }
export interface MosPalette { si: RGB; p: RGB; pClear: RGBA; n: RGB; poly: RGB; oxide: RGBA; metal: RGB; charge: RGB; carrier: RGB; dim: RGB }
/** A carrier in the channel: x from source (0) to drain (1), z across the width (−1 to 1). */
export interface Carrier { x: number; z: number }

/** The sheet's thickness at x (0 to 1): proportional to the inversion charge. */
export const sheetAt = (s: Pick<MosState, 'vg' | 'vd'>, x: number): number => (SHEET_MAX * channelCharge(s.vg - VT, s.vd, x)) / Q_MAX;

export function mosParts(st: MosState, P: MosPalette, carriers: readonly Carrier[]): Part[] {
  const hl = (L0 * st.l) / 2, hw = (W0 * st.w) / 2, xEnd = hl + SD, zEnd = hw + RIM, out: Part[] = [];
  // The body under everything, and around the islands: the part between them stays clear, so the channel shows.
  out.push(box(P.si, -xEnd - RIM, xEnd + RIM, -DEPTH, -JUNCTION, -zEnd, zEnd));
  out.push(box(P.si, -xEnd - RIM, xEnd + RIM, -JUNCTION, 0, hw, zEnd), box(P.si, -xEnd - RIM, xEnd + RIM, -JUNCTION, 0, -zEnd, -hw));
  out.push(box(P.si, -xEnd - RIM, -xEnd, -JUNCTION, 0, -hw, hw), box(P.si, xEnd, xEnd + RIM, -JUNCTION, 0, -hw, hw));
  out.push(box(P.n, -xEnd, -hl, -JUNCTION, 0, -hw, hw), box(P.n, hl, xEnd, -JUNCTION, 0, -hw, hw));
  out.push(box(P.pClear, -hl, hl, -JUNCTION, 0, -hw, hw));
  // The channel, segment by segment.
  for (let k = 0; k < SEGS; k++) {
    const t = sheetAt(st, (k + 0.5) / SEGS);
    if (t <= 0.01) continue;
    const x0 = -hl + (2 * hl * k) / SEGS, x1 = -hl + (2 * hl * (k + 1)) / SEGS;
    out.push({ ...box(P.charge, x0, x1, -t, 0, -hw, hw, 0.1), emissive: [P.charge[0] * 0.35, P.charge[1] * 0.35, P.charge[2] * 0.35] });
  }
  for (const c of carriers) {
    const t = sheetAt(st, c.x), x = -hl + 2 * hl * c.x, y = -Math.max(0.3, t / 2), z = c.z * hw * 0.92;
    out.push(box(P.carrier, x - 0.3, x + 0.3, y - 0.3, y + 0.3, z - 0.3, z + 0.3));
  }
  // Oxide and gate, and the three contacts.
  out.push(box(P.oxide, -hl, hl, 0, OX, -hw, hw));
  const gy = OX + st.lift;
  out.push(box(P.poly, -hl, hl, gy, gy + POLY, -hw, hw, 0.15));
  out.push(cyl(P.metal, 0, 0, gy + POLY, gy + POLY + 3, 1.1, 0.4));
  for (const x of [-(hl + SD / 2), hl + SD / 2]) out.push(cyl(P.metal, x, 0, 0, 3.4, 1.1, 0.4));
  // W and L as dimension lines at the front.
  const zd = hw + RIM + 1.4;
  out.push(rod(P.dim, [-hl, 0.2, zd], [hl, 0.2, zd], 0.22), rod(P.dim, [xEnd + RIM + 1.4, 0.2, -hw], [xEnd + RIM + 1.4, 0.2, hw], 0.22));
  return out;
}

export function mosAnchors(st: MosState): Anchor[] {
  const hl = (L0 * st.l) / 2, hw = (W0 * st.w) / 2, xEnd = hl + SD, gy = OX + st.lift, up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.4, 1];
  return [
    { text: 'source', p: [-(hl + SD / 2), 3.4, 0], side: 't', n: up },
    { text: 'drain', p: [hl + SD / 2, 3.4, 0], side: 't', n: up },
    { text: 'gate', p: [0, gy + POLY + 3, 0], side: 't', n: up },
    { text: 'channel', p: [-hl * 0.6, -0.5, hw], side: 'l', n: front },
    { text: `L = ${st.l}×`, p: [hl * 0.5, 0.2, hw + RIM + 1.4], side: 'b', n: front },
    { text: `W = ${st.w}×`, p: [xEnd + RIM + 1.4, 0.2, 0], side: 'r', n: [1, 0.4, 0] },
    { text: 'oxide', p: [hl, OX / 2, hw], side: 'r', n: front, minor: true },
    { text: 'p-type body', p: [-(xEnd + RIM) * 0.6, -DEPTH + 2, hw + RIM], side: 'b', n: front, minor: true },
  ];
}
