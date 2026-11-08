// Hollerith's pin press as parts (DOM-free, tested). One position per option of the chapter's census card (cards/census.ts):
// a spring pin above it, a mercury cup below it, a counter dial at the front. A pin stops on the card unless the card has
// a hole there; only a pin that reaches the mercury closes its circuit, and only at the bottom of the stroke. Every pin is
// the same length and rides up against its own spring when the card stops it. Beside the press, two relays (married:
// yes, born: abroad) with their make contacts in series (AND) or in parallel (OR) drive an eleventh dial.
//
// The dials are the 1890 counters: a face of 100 divisions with two hands, the long one a turn per 100 counts, the short
// one a turn per 10 000, each stepped by its own magnet (Columbia University Computing History, "Hollerith 1890 Census
// Tabulator"; Truesdell, The Development of Punch Card Tabulation, 1965).

import type { RGB } from '../gl/instances';
import { quatAxisAngle, type Vec3 } from '../gl/math';
import { box, cyl, rod, wire, type Anchor, type Part } from '../gl/parts';
import { FIELDS, type Wiring } from '../cards/census';

export interface Pos { field: number; opt: number; k: number; x: number; z: number }
/** The census card's positions in field order; k is also the position's dial. */
export const POSITIONS: Pos[] = FIELDS.flatMap((f, field) => f.opts.map((_, opt) => ({ field, opt, k: 0, x: (opt - 1.5) * 6, z: (field - 1.5) * 5 })))
  .map((p, k) => ({ ...p, k }));
export const N = POSITIONS.length;

export const CARD_TOP = 18, HG_TOP = 6, FREE = 14, REACH = 26, HEAD_UP = 46;
/** Every pin's length; a free pin's top sits PIN_LEN − FREE above the head's guide plate. */
export const PIN_LEN = FREE + 6;
/** The pin box's lid, the springs' fixed end, this far above the guide plate. */
export const LID = 22;
/** The head's underside (the guide plate) at stroke s (0 raised, 1 down). */
export const headY = (s: number): number => HEAD_UP - REACH * s;
/** Where a pin's tip is: it hangs FREE below the head until the card (or the mercury, through a hole) stops it. */
export const pinTip = (s: number, hole: boolean): number => Math.max(headY(s) - FREE, hole ? HG_TOP : CARD_TOP);
/** The pin's top: a rigid pin, so a stopped one rides up into the head by as much as it was stopped. */
export const pinTop = (s: number, hole: boolean): number => pinTip(s, hole) + PIN_LEN;
/** The spring's length between the pin's collar and the lid: shorter on a pin the card holds back. */
export const springLen = (s: number, hole: boolean): number => headY(s) + LID - pinTop(s, hole);
/** The pin has reached its mercury: the circuit is closed. */
export const reaches = (s: number, hole: boolean): boolean => hole && pinTip(s, hole) <= HG_TOP;
/** The holes of a card, per position. */
export const holesOf = (p: readonly number[]): boolean[] => POSITIONS.map((q) => p[q.field] === q.opt);
export const closedOf = (s: number, holes: readonly boolean[]): boolean[] => holes.map((h) => reaches(s, h));
/** The positions whose cups feed the two relays: married yes, born abroad. */
export const RELAY_POS: [number, number] = [POSITIONS.findIndex((q) => q.field === 2 && q.opt === 0), POSITIONS.findIndex((q) => q.field === 3 && q.opt === 1)];

/** The counter's hands (radians, clockwise from 12): long a turn per 100, short a turn per 10 000. */
export const handAngles = (n: number): [number, number] => [(n / 100) * 2 * Math.PI, (n / 10000) * 2 * Math.PI];

export interface PressPose { s: number; holes: boolean[] | null; counts: number[]; wiring: Wiring; relayCount: number }
export interface PressPalette { frame: RGB; metal: RGB; card: RGB; hg: RGB; live: RGB; cup: RGB; face: RGB; hand: RGB; brass: RGB; pad: RGB; coil: RGB }

export const dialX = (k: number) => (k - (N - 1) / 2) * 5.4;
const DIAL_Y = 11, DIAL_Z = 26.8, RACK_TOP = 17;
const RX = 42, RZ: [number, number] = [-6, 6];
const lit = (c: RGB, k = 0.5): RGB => [c[0] * k, c[1] * k, c[2] * k];
const FACE_ROT = quatAxisAngle([1, 0, 0], Math.PI / 2);

/** A counter: face, 10 major ticks, two hands, and its stepping magnet on the rack; lit while its circuit is closed. */
function counter(out: Part[], x: number, n: number, on: boolean, P: PressPalette): void {
  out.push({ ...cyl(on ? P.live : P.face, 0, 0, -0.4, 0.4, 2.4), pos: [x, DIAL_Y, DIAL_Z], rot: FACE_ROT, emissive: on ? lit(P.live, 0.5) : undefined });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * 2 * Math.PI;
    out.push({ ...box(P.hand, -0.09, 0.09, -0.32, 0.32, -0.05, 0.05), pos: [x + 2 * Math.sin(a), DIAL_Y + 2 * Math.cos(a), DIAL_Z + 0.45], rot: quatAxisAngle([0, 0, 1], -a) });
  }
  const [al, as] = handAngles(n), c: Vec3 = [x, DIAL_Y, DIAL_Z + 0.55];
  out.push(rod(P.hand, c, [x + 2.1 * Math.sin(al), DIAL_Y + 2.1 * Math.cos(al), DIAL_Z + 0.55], 0.16, 0.2));
  out.push(rod(P.hand, c, [x + 1.2 * Math.sin(as), DIAL_Y + 1.2 * Math.cos(as), DIAL_Z + 0.65], 0.3, 0.2));
  out.push({ ...cyl(on ? P.live : P.coil, x, DIAL_Z - 1.2, RACK_TOP, RACK_TOP + 2.4, 0.9, 0.3), emissive: on ? lit(P.live, 0.6) : undefined });
}

export function pressParts(p: PressPose, P: PressPalette): Part[] {
  const out: Part[] = [], hy = headY(p.s), closed = p.holes ? closedOf(p.s, p.holes) : POSITIONS.map(() => false);
  out.push(box(P.frame, -30, 30, -4, 0, -15, 15), box(P.pad, -30, 36, -4, 0, 15, 28));
  // The dial rack, with an eleventh dial for the relays.
  out.push(box(P.frame, -30, 36, 0, RACK_TOP, 24.8, 25.9));
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
  // Two guide posts and the pin box riding on them: a guide plate the pins slide through, side plates, the lid the
  // springs push against, and the lever at the side.
  for (const sx of [-1, 1]) out.push(cyl(P.frame, sx * 22, -13, 0, HEAD_UP + LID + 6, 1.1), box(P.frame, sx * 22 - 1.6, sx * 22 + 1.6, hy, hy + LID + 2, -14.6, -11.4));
  out.push(box(P.metal, -17, 17, hy, hy + 2, -11.6, 11.6, 0.3), box(P.metal, -17, 17, hy + LID, hy + LID + 2, -11.6, 11.6, 0.3));
  // Open at the sides and front, so the springs show: four corner columns and a back plate.
  for (const sx of [-1, 1]) for (const z of [-11.6, 11.6]) out.push(box(P.metal, sx * 17 - 0.7, sx * 17 + 0.7, hy + 2, hy + LID, z - 0.7, z + 0.7, 0.3));
  out.push(box(P.metal, -17, 17, hy + 2, hy + LID, -13.4, -11.6));
  out.push(rod(P.brass, [17, hy + LID + 1, 0], [30, hy + LID + 1, 0], 0.8, 0.4), cyl(P.brass, 30, 0, hy + LID + 1, hy + LID + 13, 0.8, 0.4), box(P.brass, 28.6, 31.4, hy + LID + 13, hy + LID + 16, -1.4, 1.4, 0.4));
  for (const q of POSITIONS) {
    const hole = p.holes?.[q.k] ?? false, tip = pinTip(p.s, hole), top = pinTop(p.s, hole), on = closed[q.k];
    out.push({ ...cyl(on ? P.live : P.metal, q.x, q.z, tip, top, 0.65, 0.5), emissive: on ? lit(P.live, 0.6) : undefined });
    out.push(cyl(P.brass, q.x, q.z, top - 0.8, top, 1.1, 0.3));
    // The spring: six turns between the collar and the lid, closer together the further the pin was pushed up.
    const len = springLen(p.s, hole);
    for (let i = 0; i < 6; i++) { const y = top + (len * (i + 0.5)) / 6; out.push(cyl(P.brass, q.x, q.z, y - 0.14, y + 0.14, 0.95, 0.4)); }
  }
  for (const q of POSITIONS) counter(out, dialX(q.k), p.counts[q.k], closed[q.k], P);

  // The relays on a board of their own: a coil each, fed from its cup (wires out of the base's side), an armature
  // pulled down onto its make contact while the coil is energized.
  const ins = RELAY_POS.map((k) => closed[k]), conducts = p.wiring === 'and' ? ins[0] && ins[1] : ins[0] || ins[1];
  out.push(box(P.frame, 31, 56, -4, 0, -14, 14));
  const feed = [[[30.5, 0.3, 2.5], [36, 0.3, 2.5], [36, 0.3, RZ[0]], [RX - 1.8, 0.3, RZ[0]]], [[30.5, 0.3, 7.5], [38, 0.3, 7.5], [38, 0.3, RZ[1]], [RX - 1.8, 0.3, RZ[1]]]] as Vec3[][];
  RZ.forEach((z, i) => {
    out.push(...wire(ins[i] ? P.live : P.frame, feed[i], 0.25, 0.1));
    out.push({ ...cyl(ins[i] ? P.live : P.coil, RX, z, 0, 6, 1.8, 0.3), emissive: ins[i] ? lit(P.live, 0.5) : undefined });
    const lift = ins[i] ? 0 : 0.8;
    out.push(box(P.metal, RX - 2.4, RX - 1.6, 0, 7.4, z - 1, z + 1), box(P.metal, RX - 2.4, RX + 4.4, 6.6 + lift, 7.2 + lift, z - 0.9, z + 0.9, 0.4));
    out.push(box(P.brass, RX + 3.6, RX + 4.6, 0, 6.6, z - 0.7, z + 0.7, 0.4));
  });
  // The contact circuit, from the battery post to the eleventh dial: series for AND, parallel for OR.
  const c = conducts ? P.live : P.frame, Y = 9, piv = (i: number): Vec3 => [RX - 2, 7.4, RZ[i]], con = (i: number): Vec3 => [RX + 4.1, 6.6, RZ[i]];
  out.push(cyl(P.frame, 34, 0, 0, Y, 0.7, 0.2));
  const runs: Vec3[][] = p.wiring === 'and'
    ? [[[34, Y, 0], [34, Y, RZ[0]], [RX - 2, Y, RZ[0]], piv(0)], [con(0), [RX + 6, 6.6, RZ[0]], [RX + 6, Y + 2, RZ[0]], [RX - 3.4, Y + 2, RZ[0]], [RX - 3.4, Y + 2, RZ[1]], [RX - 2, Y + 2, RZ[1]], piv(1)],
      [con(1), [52, 6.6, RZ[1]]]]
    : [[[34, Y, 0], [34, Y, RZ[0]], [RX - 2, Y, RZ[0]], piv(0)], [[34, Y, 0], [34, Y, RZ[1]], [RX - 2, Y, RZ[1]], piv(1)],
      [con(0), [52, 6.6, RZ[0]], [52, 6.6, RZ[1]]], [con(1), [52, 6.6, RZ[1]]]];
  runs.push([[52, 6.6, RZ[1]], [52, 6.6, 23], [dialX(N), 6.6, 23], [dialX(N), DIAL_Y - 2.4, DIAL_Z - 0.4]]);
  for (const r of runs) out.push(...wire(c, r, 0.22, 0.1));
  counter(out, dialX(N), p.relayCount, conducts, P);
  return out;
}

export function pressAnchors(p: PressPose): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0], hy = headY(p.s);
  const s8 = POSITIONS[8];
  return [
    { text: 'spring pin', p: [s8.x, hy - 6, s8.z], side: 'l', n: front },
    { text: 'spring', p: [POSITIONS[3].x, hy + LID - 3, 11.6], side: 't', n: front, minor: true },
    { text: 'pin box', p: [0, hy + LID + 2, -11.6], side: 't', n: up },
    { text: 'lever', p: [30, hy + LID + 16, 0], side: 'r', n: up },
    { text: 'card', p: [15, CARD_TOP - 1, 8], side: 'r', n: front },
    { text: 'mercury cup', p: [POSITIONS[9].x, 6, POSITIONS[9].z + 2.3], side: 'r', n: front, minor: true },
    { text: 'dials', p: [dialX(0) - 2.4, DIAL_Y, DIAL_Z], side: 'l', n: front },
    { text: p.wiring === 'and' ? 'relays in series' : 'relays in parallel', p: [RX + 1, 7.4, RZ[0] - 1], side: 'r', n: up },
    { text: p.wiring === 'and' ? 'married AND abroad' : 'married OR abroad', p: [dialX(N) + 2.4, DIAL_Y, DIAL_Z], side: 'r', n: front, minor: true },
  ];
}
