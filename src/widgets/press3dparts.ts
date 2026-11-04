// Hollerith's pin press as parts (DOM-free, tested). One position per option of the chapter's census card (cards/census.ts):
// a spring pin above it, a mercury cup below it, a dial at the front. A pin stops on the card unless the card has a hole
// there; only a pin that reaches the mercury closes its circuit, and only at the bottom of the stroke.

import type { RGB } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { FIELDS, STACK } from '../cards/census';

export interface Pos { field: number; opt: number; k: number; x: number; z: number }
/** The census card's positions in field order; k is also the position's dial. */
export const POSITIONS: Pos[] = FIELDS.flatMap((f, field) => f.opts.map((_, opt) => ({ field, opt, k: 0, x: (opt - 1.5) * 6, z: (field - 1.5) * 5 })))
  .map((p, k) => ({ ...p, k }));
export const N = POSITIONS.length;

export const CARD_TOP = 18, HG_TOP = 6, FREE = 14, REACH = 26, HEAD_UP = 46;
/** The head's underside at stroke s (0 raised, 1 down). */
export const headY = (s: number): number => HEAD_UP - REACH * s;
/** Where a pin's tip is: it hangs FREE below the head until the card (or the mercury, through a hole) stops it. */
export const pinTip = (s: number, hole: boolean): number => Math.max(headY(s) - FREE, hole ? HG_TOP : CARD_TOP);
/** The pin has reached its mercury: the circuit is closed. */
export const reaches = (s: number, hole: boolean): boolean => hole && pinTip(s, hole) <= HG_TOP;
/** The holes of a card, per position. */
export const holesOf = (p: readonly number[]): boolean[] => POSITIONS.map((q) => p[q.field] === q.opt);
export const closedOf = (s: number, holes: readonly boolean[]): boolean[] => holes.map((h) => reaches(s, h));

export interface PressPose { s: number; holes: boolean[] | null; counts: number[] }
export interface PressPalette { frame: RGB; metal: RGB; card: RGB; hg: RGB; live: RGB; cup: RGB; face: RGB; hand: RGB; brass: RGB; pad: RGB }

const dialX = (k: number) => (k - (N - 1) / 2) * 5.4;
const lit = (c: RGB, k = 0.5): RGB => [c[0] * k, c[1] * k, c[2] * k];
/** A dial's pointer angle: a full turn is the whole stack, as censusWidget's dials. */
export const dialAngle = (n: number): number => (n / STACK) * 2 * Math.PI;

export function pressParts(p: PressPose, P: PressPalette): Part[] {
  const out: Part[] = [], hy = headY(p.s), closed = p.holes ? closedOf(p.s, p.holes) : POSITIONS.map(() => false);
  out.push(box(P.frame, -30, 30, -4, 0, -15, 15), box(P.pad, -30, 30, -4, 0, 15, 27));
  // Cups with their mercury; a cup lights green when a pin stands in it.
  for (const q of POSITIONS) {
    out.push(cyl(P.cup, q.x, q.z, 0, 7, 2.3), cyl(closed[q.k] ? P.live : P.hg, q.x, q.z, 6, 7.3, 1.7, 0.6));
    if (closed[q.k]) out[out.length - 1].emissive = lit(P.live, 0.6);
  }
  // The card on two rails, with a real hole wherever the card is punched; no card: the rails are bare.
  for (const sx of [-1, 1]) out.push(box(P.frame, sx * 16.5 - 1, sx * 16.5 + 1, 0, CARD_TOP - 2, -12, 12));
  if (p.holes) {
    const cuts = [-12, ...[0, 1, 2, 3].flatMap((i) => [(i - 1.5) * 5 - 1.5, (i - 1.5) * 5 + 1.5]), 12];
    for (let band = 0; band <= 4; band++) { // full-width strips between the rows of holes
      const z0 = band === 0 ? -12 : cuts[2 * band], z1 = band === 4 ? 12 : cuts[2 * band + 1];
      out.push(box(P.card, -15, 15, CARD_TOP - 2, CARD_TOP, z0, z1));
    }
    for (let i = 0; i < 4; i++) {
      let x = -15;
      for (const q of POSITIONS.filter((q) => q.field === i && p.holes![q.k])) { out.push(box(P.card, x, q.x - 1.5, CARD_TOP - 2, CARD_TOP, cuts[2 * i + 1], cuts[2 * i + 2])); x = q.x + 1.5; }
      out.push(box(P.card, x, 15, CARD_TOP - 2, CARD_TOP, cuts[2 * i + 1], cuts[2 * i + 2]));
    }
  }
  // Two guide posts, the head riding on them, the pins hanging through it, the lever at the side.
  for (const sx of [-1, 1]) out.push(cyl(P.frame, sx * 22, -13, 0, 58, 1.1), box(P.frame, sx * 22 - 1.6, sx * 22 + 1.6, hy + 1, hy + 7, -14.6, -11.4));
  out.push(box(P.metal, -17, 17, hy, hy + 7, -11.6, 11.6, 0.3), box(P.metal, -17, 17, hy + 2, hy + 6, -13.4, -11.6));
  out.push(rod(P.brass, [17, hy + 4, 0], [30, hy + 4, 0], 0.8, 0.4), cyl(P.brass, 30, 0, hy + 4, hy + 22, 0.8, 0.4), box(P.brass, 28.6, 31.4, hy + 22, hy + 25, -1.4, 1.4, 0.4));
  for (const q of POSITIONS) {
    const tip = pinTip(p.s, p.holes?.[q.k] ?? false), on = closed[q.k];
    out.push(cyl(on ? P.live : P.metal, q.x, q.z, tip, hy + 2, 0.65, 0.5), cyl(P.brass, q.x, q.z, hy - 4, hy, 0.9, 0.3));
    if (on) out[out.length - 2].emissive = lit(P.live, 0.6);
  }
  // The dials: a face on the front rack, a pointer a full turn for the whole stack, lit while its pin has made contact.
  for (const q of POSITIONS) {
    const x = dialX(q.k), a = dialAngle(p.counts[q.k]), c: Vec3 = [x, 11, 27.4];
    out.push({ ...box(P.face, x - 2.4, x + 2.4, 8.6, 13.4, 26.4, 27.2), emissive: closed[q.k] ? lit(P.live, 0.5) : undefined, color: closed[q.k] ? P.live : P.face });
    out.push(rod(P.hand, c, [x + 2 * Math.sin(a), 11 + 2 * Math.cos(a), 27.4], 0.22, 0.2));
  }
  return out;
}

export function pressAnchors(p: PressPose): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0], hy = headY(p.s);
  return [
    { text: 'spring pin', p: [POSITIONS[8].x, hy - 6, POSITIONS[8].z], side: 'l', n: front },
    { text: 'pin head', p: [0, hy + 7, -11.6], side: 't', n: up },
    { text: 'lever', p: [30, hy + 25, 0], side: 'r', n: up },
    { text: 'card', p: [15, CARD_TOP - 1, 8], side: 'r', n: front },
    { text: 'mercury cup', p: [POSITIONS[9].x, 6, POSITIONS[9].z + 2.3], side: 'r', n: front, minor: true },
    { text: 'dials', p: [dialX(0) - 2.4, 11, 27.4], side: 'l', n: front },
  ];
}
