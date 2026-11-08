// A twisted pair, its neighbour and a coax as parts (DOM-free). The pair runs along x, the neighbour's field B points up (y), so a loop
// threads it by the z-extent of its two conductors. The helix is the drawing; the model counts n + 1 loops of alternating sign
// (phys/cable.ts, equal unless the twist is uneven), and each loop's lens is tinted by that sign. The B arrows stand at z = 0, in the
// middle of each lens, so they pierce it; the E-field arrows reach both legs from the side.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, wire, type Anchor, type Part } from '../gl/parts';
import { COAX_PRESETS, DIELECTRICS, LAY_A_MM, LAY_B_MM, loopEdges, neighbourHalfTwists, type CoaxPreset, type Dielectric } from '../phys/cable';

export const LEN = 60, A = 3.2, H = 1.1, ROD = 0.38, SEG = 8, SEG2 = 4, SLICES = 8, NEIGHBOUR_Z = -13, MM = 1.8;

export type Neighbour = 'off' | 'same' | 'other';
export interface CablePalette { a: RGB; b: RGB; pos: RGBA; neg: RGBA; shield: RGBA; core: RGB; field: RGB; efield: RGB; diel: RGBA; jacket: RGBA }
export interface CableState { twists: number; coax: boolean; preset: string; diel: Dielectric; uneven: number; neighbour: Neighbour }

export const presetOf = (id: string): CoaxPreset => COAX_PRESETS.find((p) => p.id === id) ?? COAX_PRESETS[0];

/** Where conductor `which` (+1 / −1) is at u (0 to 1): the crossings in z fall at the loop edges (u = k / (n + 1) when equal). */
export function helix(n: number, which: 1 | -1, u: number, uneven = 0, dz = 0): Vec3 {
  const e = loopEdges(n, uneven);
  let k = 0;
  while (k < e.length - 2 && u >= e[k + 1]) k++;
  const psi = Math.PI * (k + (u - e[k]) / (e[k + 1] - e[k]));
  return [(u - 0.5) * LEN, which * H * Math.cos(psi), -which * A * Math.sin(psi) + dz];
}

function pairWires(n: number, uneven: number, dz: number, seg: number, P: CablePalette): Part[] {
  const out: Part[] = [], L = n + 1, e = loopEdges(n, uneven);
  for (const w of [1, -1] as const) {
    // sample each loop on its own so the crossings land exactly on the loop edges
    const pts: Vec3[] = [];
    for (let k = 0; k < L; k++) for (let j = 0; j <= seg * 2; j++) { if (k > 0 && j === 0) continue; pts.push(helix(n, w, e[k] + ((e[k + 1] - e[k]) * j) / (seg * 2), uneven, dz)); }
    out.push(...wire(w === 1 ? P.a : P.b, pts, ROD, 0.2));
  }
  return out;
}

export function cableParts(st: CableState, P: CablePalette): Part[] {
  const out: Part[] = [];
  if (st.coax) return coaxParts(st, P);
  const n = Math.round(st.twists), L = n + 1, e = loopEdges(n, st.uneven);
  // B: rising through the middle of each loop, the same everywhere along the cable (the model's assumption).
  for (let k = 0; k < L; k++) {
    const x = ((e[k] + e[k + 1]) / 2 - 0.5) * LEN;
    out.push(rod(P.field, [x, -9, 0], [x, 9, 0], 0.2), rod(P.field, [x, 9, 0], [x - 0.8, 7.4, 0], 0.2), rod(P.field, [x, 9, 0], [x + 0.8, 7.4, 0], 0.2));
  }
  // E: at each crossing the legs are level, so an electric field from the side reaches both alike.
  for (let k = 1; k < L; k++) {
    const x = (e[k] - 0.5) * LEN;
    out.push(rod(P.efield, [x, 0, 10], [x, 0, 4.6], 0.2), rod(P.efield, [x, 0, 4.6], [x - 0.7, 0, 6.2], 0.2), rod(P.efield, [x, 0, 4.6], [x + 0.7, 0, 6.2], 0.2));
  }
  out.push(...pairWires(n, st.uneven, 0, SEG, P));
  // Each loop's lens in the z-plane, sliced; alpha carries the sign by colour.
  for (let k = 0; k < L; k++) for (let j = 0; j < SLICES; j++) {
    const t0 = e[k] + ((e[k + 1] - e[k]) * j) / SLICES, t1 = e[k] + ((e[k + 1] - e[k]) * (j + 1)) / SLICES;
    const h = A * Math.abs(Math.sin(Math.PI * ((t0 + t1) / 2 - e[k]) / (e[k + 1] - e[k])));
    out.push(box(k % 2 === 0 ? P.pos : P.neg, (t0 - 0.5) * LEN, (t1 - 0.5) * LEN, -0.12, 0.12, -h, h));
  }
  // Clamps where the pair is held together at both ends.
  out.push(box(P.core, -LEN / 2 - 1.4, -LEN / 2, -H - 0.6, H + 0.6, -1.4, 1.4), box(P.core, LEN / 2, LEN / 2 + 1.4, -H - 0.6, H + 0.6, -1.4, 1.4));
  if (st.neighbour !== 'off') out.push(...pairWires(st.neighbour === 'same' ? n : neighbourHalfTwists(n), 0, NEIGHBOUR_Z, SEG2, P));
  return out;
}

/** A coax with its ends stripped back: jacket, braid (eight strands), dielectric, centre conductor, to scale in mm (MM units each). */
function coaxParts(st: CableState, P: CablePalette): Part[] {
  const p = presetOf(st.preset), rj = (p.jacket * MM) / 2, rb = (p.D * MM) / 2, rc = (p.d * MM) / 2, x0 = -LEN / 2, out: Part[] = [];
  const cut = { jacket: -LEN * 0.2, braid: LEN * 0.05, diel: LEN * 0.3 };
  out.push(rod(P.jacket, [x0, 0, 0], [cut.jacket, 0, 0], rj), rod(P.diel, [x0, 0, 0], [cut.diel, 0, 0], rb * 0.999), rod(P.core, [x0, 0, 0], [LEN / 2, 0, 0], rc, 0.2));
  // the braid: two sets of four strands wound opposite ways over three turns, a little outside the dielectric
  const rs = rb + 0.12, wires = 24;
  for (let s = 0; s < 8; s++) {
    const dir = s % 2 ? 1 : -1, a0 = (Math.PI * 2 * s) / 8, pts: Vec3[] = [];
    for (let i = 0; i <= wires; i++) { const x = x0 + ((cut.braid - x0) * i) / wires, a = a0 + dir * 3 * Math.PI * 2 * (i / wires); pts.push([x, rs * Math.cos(a), rs * Math.sin(a)]); }
    out.push(...wire(P.shield, pts, 0.1, 0.3));
  }
  return out;
}

export function cableAnchors(st: CableState): Anchor[] {
  const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.3, 1];
  if (st.coax) {
    const p = presetOf(st.preset), rj = (p.jacket * MM) / 2, rb = (p.D * MM) / 2;
    return [
      { text: 'jacket', p: [-LEN * 0.4, rj, 0], side: 't', n: up }, { text: 'braid (return)', p: [-LEN * 0.05, rb + 0.2, 0], side: 't', n: up },
      { text: `dielectric, ${DIELECTRICS[st.diel].name}`, p: [LEN * 0.18, rb, 0], side: 't', n: up, minor: true }, { text: 'centre conductor', p: [LEN * 0.4, 0, 0], side: 'b', n: front },
    ];
  }
  const L = Math.round(st.twists) + 1, out: Anchor[] = [{ text: 'dB/dt, uniform along the cable', p: [0, 9.5, 0], side: 't', n: up }, { text: 'E noise from the side: both legs alike', p: [-LEN * 0.25, 0, 10], side: 'l', n: front, minor: true }];
  const e = loopEdges(Math.round(st.twists), st.uneven);
  for (let k = 0; k < L; k++) out.push({ text: k % 2 === 0 ? '+' : '−', p: [((e[k] + e[k + 1]) / 2 - 0.5) * LEN, 0, A * 1.5], side: 'b', n: front, minor: L > 8 });
  if (st.neighbour !== 'off') {
    const lay = st.neighbour === 'same' ? LAY_A_MM : LAY_B_MM;
    out.push({ text: `neighbour, lay ${lay.toFixed(1)} mm`, p: [-LEN * 0.38, 0, NEIGHBOUR_Z], side: 't', n: front });
  }
  return out;
}
