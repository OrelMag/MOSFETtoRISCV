// A twisted pair and a coax as parts (DOM-free). The pair runs along x, the neighbour's field B points up (y), so a loop
// threads it by the z-extent of its two conductors. The helix is the drawing; the model counts n + 1 equal loops of
// alternating sign (phys/cable.ts), and each loop's lens is tinted by that sign.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, wire, type Anchor, type Part } from '../gl/parts';

export const LEN = 60, A = 3.2, H = 1.1, ROD = 0.38, SEG = 8, SLICES = 8;

export interface CablePalette { a: RGB; b: RGB; pos: RGBA; neg: RGBA; shield: RGBA; core: RGB; field: RGB }
export interface CableState { twists: number; coax: boolean; D: number; d: number }

/** Where conductor `which` (+1 / −1) is at u (0 to 1): the crossings in z fall at u = k / (n + 1). */
export function helix(n: number, which: 1 | -1, u: number): Vec3 {
  const psi = Math.PI * (n + 1) * u;
  return [(u - 0.5) * LEN, which * H * Math.cos(psi), -which * A * Math.sin(psi)];
}

export function cableParts(st: CableState, P: CablePalette): Part[] {
  const out: Part[] = [];
  // The neighbour's field: arrows rising through the cable, the same everywhere along it (the model's assumption).
  for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const x = (u - 0.5) * LEN;
    out.push(rod(P.field, [x, -9, -9], [x, 9, -9], 0.2), rod(P.field, [x, 9, -9], [x - 0.8, 7.4, -9], 0.2), rod(P.field, [x, 9, -9], [x + 0.8, 7.4, -9], 0.2));
  }
  if (st.coax) {
    const ro = 3, ri = Math.max(0.25, ro * (st.d / st.D));
    out.push(rod(P.shield, [-LEN / 2, 0, 0], [LEN / 2, 0, 0], ro), rod(P.core, [-LEN / 2, 0, 0], [LEN / 2, 0, 0], ri, 0.2));
    return out;
  }
  const n = Math.round(st.twists), L = n + 1, per = SEG * 2;
  for (const w of [1, -1] as const) {
    const pts = Array.from({ length: L * per + 1 }, (_, i) => helix(n, w, i / (L * per)));
    out.push(...wire(w === 1 ? P.a : P.b, pts, ROD, 0.2));
  }
  // Each loop's lens in the z-plane, sliced; alpha carries the sign by colour.
  for (let k = 0; k < L; k++) for (let j = 0; j < SLICES; j++) {
    const t0 = (k + j / SLICES) / L, t1 = (k + (j + 1) / SLICES) / L, h = A * Math.abs(Math.sin(Math.PI * L * ((t0 + t1) / 2))), x0 = (t0 - 0.5) * LEN, x1 = (t1 - 0.5) * LEN;
    out.push(box(k % 2 === 0 ? P.pos : P.neg, x0, x1, -0.12, 0.12, -h, h));
  }
  // Clamps where the pair is held together at both ends.
  out.push(box(P.core, -LEN / 2 - 1.4, -LEN / 2, -H - 0.6, H + 0.6, -1.4, 1.4), box(P.core, LEN / 2, LEN / 2 + 1.4, -H - 0.6, H + 0.6, -1.4, 1.4));
  return out;
}

export function cableAnchors(st: CableState): Anchor[] {
  const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.3, 1];
  const out: Anchor[] = [{ text: 'dB/dt, uniform along the cable', p: [0, 9.5, -9], side: 't', n: up }];
  if (st.coax) return [...out, { text: 'shield (return)', p: [-LEN * 0.3, 2.4, 0], side: 't', n: up }, { text: 'centre conductor', p: [LEN * 0.3, 0, 0], side: 'b', n: front, minor: true }];
  const L = Math.round(st.twists) + 1;
  for (let k = 0; k < L; k++) out.push({ text: k % 2 === 0 ? '+' : '−', p: [((k + 0.5) / L - 0.5) * LEN, 0, A * 1.5], side: 'b', n: front, minor: L > 8 });
  return out;
}
