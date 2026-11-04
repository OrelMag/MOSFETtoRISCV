// A chip package opened up, as parts (DOM-free, tested): board, lead frame, die paddle, die, pads and bond wires as arcs.
// The wires and the numbers are the same list: a signal wire is lit exactly when its output switches, and the ground
// wires carry the sum of those currents, so the drawing cannot show more current than the model has.

import type { RGB } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, wire, type Anchor, type Part } from '../gl/parts';
import { groundBounce, VIH, VIL, VIO } from '../phys/line';
import { padSwing } from './line';

export const SIGNALS = 16, GROUNDS = 4, PER_SIDE = 10, SEG = 8;
export interface PkState { n: number; g: number; lnh: number; rise: number }
export interface PkPalette { board: RGB; lead: RGB; paddle: RGB; die: RGB; pad: RGB; gold: RGB; ground: RGB; lit: RGB; bad: RGB }
export interface Bond { side: 1 | -1; z: number; ground: boolean; lit: boolean; pts: Vec3[] }

/** The pad slots signals use: 8 free per side, left and right alternating, so any n lights a symmetric set. */
const FREE = [0, 1, 2, 3, 6, 7, 8, 9];
const slotZ = (i: number) => (i - (PER_SIDE - 1) / 2) * 2;
/** Ground slots in the order they are bonded: the middle two on each side, where a real ground ring sits. */
const GROUND_SLOTS: [1 | -1, number][] = [[-1, 4], [1, 4], [-1, 5], [1, 5]];

/** Bounce (V) with `g` ground bond wires in parallel: L / g, which ignores their mutual inductance (a real set keeps more). */
export const bounceOf = (st: PkState): number => groundBounce(st.n, padSwing(), st.rise, st.lnh / st.g);

/** What line.ts's panel says of a bounce: the same thresholds, beyond VDD being where the linear formula stops being valid. */
export type Verdict = 'ok' | 'undefined' | 'high' | 'invalid';
export const verdictOf = (v: number): Verdict => (v >= VIO ? 'invalid' : v >= VIH ? 'high' : v >= VIL ? 'undefined' : 'ok');

const arc = (a: Vec3, b: Vec3, rise: number): Vec3[] =>
  Array.from({ length: SEG + 1 }, (_, i) => { const t = i / SEG; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + rise * Math.sin(Math.PI * t), a[2] + (b[2] - a[2]) * t]; });

export function bonds(st: PkState): Bond[] {
  const out: Bond[] = [], on = st.n > 0;
  FREE.forEach((i, j) => ([-1, 1] as const).forEach((side, s) => {
    const k = 2 * j + s;
    out.push({ side, z: slotZ(i), ground: false, lit: k < st.n, pts: arc([side * 9, 2.4, slotZ(i)], [side * 17, 0.9, slotZ(i)], 3) });
  }));
  GROUND_SLOTS.slice(0, st.g).forEach(([side, i]) => out.push({ side, z: slotZ(i), ground: true, lit: on, pts: arc([side * 9, 2.4, slotZ(i)], [side * 17, 0.9, slotZ(i)], 3.4) }));
  return out;
}

const glow = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

export function pkParts(st: PkState, P: PkPalette): Part[] {
  const out: Part[] = [], v = bounceOf(st), hot = Math.min(1, v / VIL);
  out.push(box(P.board, -42, 42, -2.4, -1, -26, 26));
  out.push(box(P.paddle, -13, 13, 0, 0.6, -12, 12), box(P.die, -10.5, 10.5, 0.6, 2.1, -10.5, 10.5, 0.3));
  // All 20 leads exist; a ground lead is only wired where the slider has bonded it.
  const wired = new Set(GROUND_SLOTS.slice(0, st.g).map(([s, i]) => `${s},${i}`));
  for (const side of [-1, 1] as const) for (let i = 0; i < PER_SIDE; i++) {
    const z = slotZ(i), isG = GROUND_SLOTS.some(([s, gi]) => s === side && gi === i), on = wired.has(`${side},${i}`);
    out.push(...wire(P.lead, [[side * 17, 0.5, z], [side * 23, 0.5, z], [side * 30, 0.5, z * 2.2], [side * 37, 0.5, z * 2.2]], 0.4, 0.5));
    out.push(box(P.lead, side * 37 - 1, side * 37 + 1, -1, 0.9, z * 2.2 - 0.9, z * 2.2 + 0.9, 0.5));
    // A bonded ground pad warms towards red as the bounce nears VIL.
    out.push({ ...box(isG && on ? P.ground : P.pad, side * 9 - 0.8, side * 9 + 0.8, 2.1, 2.5, z - 0.8, z + 0.8, 0.6), emissive: isG && on ? glow(P.bad, hot * 0.9) : undefined });
  }
  for (const b of bonds(st)) {
    const c = b.ground ? P.ground : P.gold;
    for (const p of wire(c, b.pts, b.ground ? 0.34 : 0.26, 0.7)) out.push(b.lit ? { ...p, emissive: glow(b.ground ? P.bad : P.lit, b.ground ? 0.35 + 0.65 * hot : 0.8) } : p);
  }
  return out;
}

export function pkAnchors(st: PkState): Anchor[] {
  const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.3, 1], g = GROUND_SLOTS[0];
  return [
    { text: 'die', p: [0, 2.1, 6], side: 'b', n: up },
    { text: 'signal bond wire', p: [13, 3.6, slotZ(9)], side: 'r', n: front },
    { text: 'lead frame', p: [30, 0.5, slotZ(9) * 2.2], side: 'b', n: front },
    { text: 'board', p: [0, -1, 26], side: 'b', n: front },
    { text: st.g > 1 ? `${st.g} ground bond wires in parallel` : 'ground bond wire', p: [g[0] * 13, 5.4, slotZ(g[1])], side: 't', n: front },
  ];
}
