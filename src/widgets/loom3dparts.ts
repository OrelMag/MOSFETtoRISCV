// A Jacquard head over the warp, as parts (DOM-free, tested). Nothing here is a second model of the weave: the card read at a
// pick, the hooks its holes leave on the griffe knife and the warp threads those hooks lift are cards.ts's loomPick (the
// loom widget's own rule: hook j lifts threads j, j + 8, j + 16, j + 24), and the cloth is that rule row by row.
//
// The mechanism follows the classical single-lift head (Posselt, The Jacquard Machine Analyzed and Explained, 1888): needles lie
// horizontally against the card on a square cylinder, each held forward by a spring; each needle carries one vertical hook, whose
// crook rests over a knife of the griffe. A hole lets the needle go into the card, so its hook stays over the knife and the rising
// griffe lifts it; solid card pushes the needle back, and the hook off the knife, so it stays down. A hook's neck cord runs down
// to the comber (harness) board, where it fans to its warp threads' harness cords, each ending in a lingoe (a weight).
//
// One pick, T from 0 to 1:
//   0 – .12   the cylinder moves in and presses the card on the needles (blank positions push needles and hooks back)
//   .12 – .35 the griffe rises, lifting the hooks still over its knife; their threads rise: the shed opens
//   .35 – .6  the shuttle carries the weft through the shed
//   .6 – .72  the beater (reed) beats the weft up to the fell and the cloth takes up a row
//   .72 – .85 the griffe sinks and the shed closes
//   .85 – .92 the cylinder withdraws, the hooks spring back over the knife
//   .92 – 1   the cylinder turns a quarter to bring the next card

import type { Anchor, Part } from '../gl/parts';
import { box, rod } from '../gl/parts';
import type { RGB } from '../gl/instances';
import { quatAxisAngle, type Vec3 } from '../gl/math';
import { HOOKS, PICKS, WARP, loomPick } from './cards';

export type Cards = readonly (readonly boolean[])[];

// ---------------------------------------------------------------- where everything is (1 unit is not to scale: see the note)

/** Warp thread w across the cloth (pitch 2); hook k across the head (pitch 8, the width of its card slot). */
export const THREAD_X = (w: number): number => (w - (WARP - 1) / 2) * 2;
export const HOOK_X = (k: number): number => (k - (HOOKS - 1) / 2) * 8;
/** Shed height at the harness, and the rows of the loom front to back (z). */
export const SHED = 10, Z_BEAM = -50, Z_HEDDLE = 0, Z_WEFT = -10, Z_FELL = 22, ROW_P = 1.3;
/** The head: hooks' bar from HOOK_Y0 to HOOK_Y1, the crook on top; the knife under it; needles and the card at NEEDLE_Y. */
export const HOOK_Y0 = 34, HOOK_Y1 = 52, KNIFE_Y = 48.8, NEEDLE_Y = 42, COMBER_Y = 16;
/** How far a blank position pushes its needle and hook back (the card is drawn thick to make it visible). */
export const PUSH = 4;
export const CYL_Z = -20, CYL_BACK = 8;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => t * t * (3 - 2 * t);
const seg = (T: number, a: number, b: number) => ease(clamp01((T - a) / (b - a)));
const mod = (a: number, n: number) => ((a % n) + n) % n;

// ---------------------------------------------------------------- the pose at pick p (1-based), time T

export interface Pose {
  p: number; T: number;
  /** The card read at this pick (index) and its holes. */
  card: number; holes: boolean[];
  /** Per hook: needle and hook pushed back by (0 or PUSH while pressed), and the lift of the hook above its rest. */
  push: number[]; hookLift: number[];
  /** The griffe's lift, the cylinder's withdrawal (0 pressed … 1 away) and the quarter turn done (0 … 1). */
  griffe: number; away: number; turn: number;
  /** Per warp thread: how far the harness has raised it. */
  threadLift: number[];
  /** Shuttle: direction of this pick, its x, whether a weft trails it; the weft's z and height; the reed's z. */
  dir: 1 | -1; shuttleX: number; weft: boolean; weftZ: number; weftY: number; reedZ: number;
  /** Rows completed in the cloth (as drawn) and the take-up in rows. */
  rows: number; takeUp: number;
}

export function poseOf(cards: Cards, p: number, T: number): Pose {
  const { card, hooks } = loomPick(cards, p), holes = Array.from({ length: HOOKS }, (_, j) => hooks.includes(j));
  const press = seg(T, 0, 0.12), away = 1 - press + seg(T, 0.85, 0.92);
  const griffe = SHED * (seg(T, 0.12, 0.35) - seg(T, 0.72, 0.85));
  const push = holes.map((on) => (on ? 0 : PUSH * (press - seg(T, 0.85, 0.92))));
  const hookLift = holes.map((on) => (on ? griffe : 0));
  const threadLift = Array.from({ length: WARP }, (_, w) => hookLift[w % HOOKS]);
  const dir: 1 | -1 = p % 2 === 1 ? 1 : -1, sh = seg(T, 0.35, 0.6), beat = seg(T, 0.6, 0.72), back = seg(T, 0.72, 0.8);
  const rows = p - 1 + (T >= 0.72 ? 1 : 0);
  return {
    p, T, card, holes, push, hookLift, griffe, away, turn: seg(T, 0.92, 1), threadLift, dir,
    shuttleX: dir * (-44 + 88 * sh), weft: T > 0.35 && T < 0.72, weftZ: Z_WEFT + (Z_FELL - Z_WEFT) * beat, weftY: 4 - 3.9 * beat,
    reedZ: Z_WEFT - 1.2 + (Z_FELL - Z_WEFT) * (beat - back), rows, takeUp: p - 1 + beat,
  };
}

/** The pose a stepped (reduced-motion) view shows after `done` picks: shed open, the row beaten up. */
export const steppedPose = (cards: Cards, done: number): Pose => (done > 0 ? poseOf(cards, done, 0.74) : poseOf(cards, 1, 0));

/** The cloth: row i (0-based pick) as per-thread flags, warp over the weft where the harness lifted the thread. */
export const clothRow = (cards: Cards, i: number): boolean[] => loomPick(cards, i + 1).threads;

// ---------------------------------------------------------------- the drawing

export interface LoomPalette {
  wood: RGB; iron: RGB; steel: RGB; spring: RGB; card: RGB; hole: RGB; warp: RGB; weft: RGB; cord: RGB; lead: RGB; brass: RGB; live: RGB;
}
const glow = (c: RGB, k = 0.5): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** A box in the cylinder's frame: x across, a along the face, r out from the axis, turned `ang` about the axis (x). */
function drumBox(c: RGB, x0: number, x1: number, a0: number, a1: number, r0: number, r1: number, ang: number, away: number): Part {
  const xc = (x0 + x1) / 2, ac = (a0 + a1) / 2, rc = (r0 + r1) / 2, co = Math.cos(ang), si = Math.sin(ang);
  return {
    kind: 'box', color: c, spec: 0,
    pos: [xc, NEEDLE_Y + ac * co - rc * si, CYL_Z - CYL_BACK * away + ac * si + rc * co],
    scale: [x1 - x0, a1 - a0, r1 - r0], rot: quatAxisAngle([1, 0, 0], ang),
  };
}
/** The card on the face at angle `ang`: pasteboard with a hole where `holes` says (four strips round it), a dark pocket in it. */
function cardOnDrum(out: Part[], P: LoomPalette, holes: readonly boolean[], ang: number, away: number): void {
  for (let k = 0; k < HOOKS; k++) {
    const x = HOOK_X(k);
    if (!holes[k]) { out.push(drumBox(P.card, x - 4, x + 4, -6, 6, 6, 10, ang, away)); continue; }
    out.push(
      drumBox(P.card, x - 4, x - 1.4, -6, 6, 6, 10, ang, away), drumBox(P.card, x + 1.4, x + 4, -6, 6, 6, 10, ang, away),
      drumBox(P.card, x - 1.4, x + 1.4, 1.4, 6, 6, 10, ang, away), drumBox(P.card, x - 1.4, x + 1.4, -6, -1.4, 6, 10, ang, away),
      drumBox(P.hole, x - 1.4, x + 1.4, -1.4, 1.4, 6, 6.15, ang, away));
  }
}

export function loomParts(cards: Cards, o: Pose, P: LoomPalette): Part[] {
  const out: Part[] = [], n = cards.length, y0 = HOOK_Y0;
  const live = (b: Part, on: boolean): Part => { if (on) b.emissive = glow(P.live, 0.6); return b; };

  // The wooden frame: bottom and top rails, four posts, the head's rails.
  const px = 40, zb = -34, zf = 16, yb = -14, yt = 70;
  for (const z of [zb, zf]) for (const [ya, yc] of [[yb, yb + 2], [26, 28], [yt - 2, yt]]) out.push(box(P.wood, -px - 1, px + 1, ya, yc, z - 1, z + 1));
  for (const x of [-px, px]) {
    out.push(box(P.wood, x - 1, x + 1, yb, yb + 2, Z_BEAM - 4, 74));
    for (const z of [zb, zf]) out.push(box(P.wood, x - 1, x + 1, yb, yt, z - 1, z + 1));
  }
  // Warp beam at the back, cloth beam at the front.
  out.push(rod(P.wood, [-px, 0, Z_BEAM - 2], [px, 0, Z_BEAM - 2], 3.4), rod(P.wood, [-px, -3, 68], [px, -3, 68], 3));

  // ---- the cylinder: a square prism on an axle, a card on each face, the chain beyond hanging behind it.
  const b = o.p - 1, drumZ = CYL_Z - CYL_BACK * o.away;
  out.push(rod(P.iron, [-px, NEEDLE_Y, drumZ], [px, NEEDLE_Y, drumZ], 1.2));
  out.push(drumBox(P.wood, -36, 36, -6, 6, -6, 6, 0, o.away)); // a square prism looks the same after every quarter turn
  // The prism turns with its faces: the 4 faces carry cards b − 1 … b + 2 (b: the card read this pick), one quarter turn a pick.
  const ang = (c: number) => -(c - b - o.turn) * (Math.PI / 2);
  const faces = [b - 1, b, b + 1, b + 2];
  for (const c of faces) cardOnDrum(out, P, cards[mod(c, n)], ang(c), o.away);
  // The rest of the chain hangs in a curtain behind (n − 4 cards; fewer than four make the faces repeat cards: the chain is a loop).
  for (let s = 0; s < n - 4; s++) {
    const idx = mod(b + 3 + s, n), z = drumZ - 14 - 2.4 * s;
    out.push(box(P.card, -32, 32, 20, 32, z - 0.5, z + 0.5));
    cards[idx].forEach((on, k) => { if (on) out.push(box(P.hole, HOOK_X(k) - 1.4, HOOK_X(k) + 1.4, 24.5, 27.5, z + 0.5, z + 0.6)); });
  }
  // Cards leaving the face run on over a lacing cord to the curtain.
  if (n > 4) out.push(rod(P.cord, [-33, 31, drumZ - 8], [-33, 31, drumZ - 14], 0.4), rod(P.cord, [33, 31, drumZ - 8], [33, 31, drumZ - 14], 0.4));

  // ---- needle board, spring board; needles with their springs, hooks and the griffe knife.
  for (let k = 0; k <= HOOKS; k++) {
    const xa = k === 0 ? -34 : HOOK_X(k - 1) + 3, xb = k === HOOKS ? 34 : HOOK_X(k) - 1.5;
    if (xb > xa) out.push(box(P.wood, xa, xb, 38, 46, -9, -7.8));
  }
  out.push(box(P.wood, -34, 34, 38, 46, 10, 14));
  for (let k = 0; k < HOOKS; k++) {
    const x = HOOK_X(k), d = o.push[k], lifted = o.holes[k] && o.hookLift[k] > 0.01;
    const nx = x + 1.8, lift = o.hookLift[k];
    // needle: tip to the collar (with the hook's eye) and on to the spring box
    out.push(rod(P.steel, [nx, NEEDLE_Y, -14 + d], [nx, NEEDLE_Y, 9 + d], 0.5, 0.4));
    out.push(box(P.steel, nx - 0.7, nx + 0.7, NEEDLE_Y - 0.7, NEEDLE_Y + 0.7, 3.2 + d, 4.4 + d));
    // spring: coils between the collar and the spring board, closer together when pushed back
    const coils = 6, sa = 4.4 + d, sb = 10;
    for (let c = 0; c < coils; c++) { const z = sa + ((c + 0.5) * (sb - sa)) / coils; out.push(rod(P.spring, [nx, NEEDLE_Y, z - 0.18], [nx, NEEDLE_Y, z + 0.18], 1.3, 0.3)); }
    // hook: the vertical bar, an eye round the needle, the crook over the knife; the neck cord below
    out.push(live(box(P.iron, x - 0.6, x + 0.6, y0 + lift, HOOK_Y1 + lift, -1 + d, 1 + d, 0.3), lifted));
    out.push(live(box(P.iron, x - 0.6, x + 0.6, HOOK_Y1 - 1.6 + lift, HOOK_Y1 + lift, -5 + d, 1 + d, 0.3), lifted));
    out.push(box(P.steel, x - 0.6, nx + 0.7, NEEDLE_Y - 0.5, NEEDLE_Y + 0.5, -0.6 + d, 0.6 + d));
  }
  // The griffe: a frame of iron with the knife, rising and falling.
  const g = o.griffe;
  out.push(box(P.iron, -35, 35, KNIFE_Y + g, KNIFE_Y + 1.6 + g, -4.6, -1.4, 0.5), box(P.iron, -37, 37, 30 + g, 31.5 + g, -4.6, -1.4));
  for (const x of [-36, 36]) out.push(box(P.iron, x - 0.7, x + 0.7, 30 + g, KNIFE_Y + 1.6 + g, -4.6, -1.4));

  // ---- comber board with the harness cords: hook neck → comber → the thread's heddle, the lingoe below.
  const holesX = Array.from({ length: WARP }, (_, w) => THREAD_X(w));
  for (let w = 0; w <= WARP; w++) {
    const xa = w === 0 ? -34 : holesX[w - 1] + 0.5, xb = w === WARP ? 34 : holesX[w] - 0.5;
    out.push(box(P.wood, xa, xb, COMBER_Y - 1, COMBER_Y + 1, -3, 3));
  }
  for (let w = 0; w < WARP; w++) {
    const k = w % HOOKS, x = holesX[w], lift = o.threadLift[w], on = lift > 0.01;
    const neck: Vec3 = [HOOK_X(k), y0 + o.hookLift[k], 0];
    out.push(live(rod(P.cord, [x, COMBER_Y, 0], neck, 0.3), on));
    out.push(live(rod(P.cord, [x, lift, 0], [x, COMBER_Y, 0], 0.3), on));
    out.push(box(P.brass, x - 0.5, x + 0.5, lift - 0.4, lift + 0.4, -0.5, 0.5));
    out.push(rod(P.cord, [x, lift, 0], [x, lift - 5, 0], 0.3), box(P.lead, x - 0.7, x + 0.7, lift - 9, lift - 5, -0.7, 0.7));
    // the warp thread: beam → heddle eye (raised) → fell
    const top: Vec3 = [x, lift, Z_HEDDLE];
    out.push(rod(P.warp, [x, 0, Z_BEAM - 2], top, 0.45), rod(P.warp, top, [x, 0, Z_FELL], 0.45));
  }

  // ---- shuttle and weft, the reed (beater), the cloth.
  if (o.weft) {
    const xe = Math.max(-33, Math.min(33, o.shuttleX)), xs = -o.dir * 33;
    if (Math.abs(xe - xs) > 0.2) out.push(rod(P.weft, [xs, o.weftY, o.weftZ], [xe, o.weftY, o.weftZ], 0.5));
  }
  out.push(box(P.wood, o.shuttleX - 5, o.shuttleX + 5, 2.7, 5.3, Z_WEFT - 1.8, Z_WEFT + 1.8, 0.4), box(P.brass, o.shuttleX + o.dir * 5, o.shuttleX + o.dir * 6.4, 3.4, 4.6, Z_WEFT - 0.6, Z_WEFT + 0.6));
  const rz = o.reedZ;
  out.push(box(P.brass, -35, 35, 12, 13.2, rz - 0.8, rz + 0.8, 0.4), box(P.brass, -35, 35, -4.5, -3.3, rz - 0.8, rz + 0.8, 0.4));
  for (let k = 0; k <= 16; k++) out.push(box(P.brass, -32 + k * 4 - 0.2, -32 + k * 4 + 0.2, -3.3, 12, rz - 0.4, rz + 0.4, 0.4));
  for (let i = Math.max(0, o.rows - PICKS); i < o.rows; i++) {
    const z = Z_FELL + (o.takeUp - 1 - i) * ROW_P;
    if (z > Z_FELL + (PICKS + 0.5) * ROW_P) continue;
    const row = clothRow(cards, i);
    for (let w = 0; w < WARP;) {
      let e = w; while (e + 1 < WARP && row[e + 1] === row[w]) e++;
      out.push(box(row[w] ? P.warp : P.weft, THREAD_X(w) - 0.98, THREAD_X(e) + 0.98, -0.8, 0.1, z - ROW_P / 2 + 0.05, z + ROW_P / 2 - 0.05));
      w = e + 1;
    }
  }
  return out;
}

/** The labels of the close-up on the head, or of the whole loom (fewer, so none collide). */
export function loomAnchors(cards: Cards, o: Pose, whole = false): Anchor[] {
  const front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0], z = CYL_Z - CYL_BACK * o.away, side: Vec3 = [0.5, 0.3, 0.8];
  const n = cards.length;
  const all: Anchor[] = [
    { text: 'cylinder (square prism)', p: [-30, NEEDLE_Y + 10, z], side: 'l', n: [0, 1, 0.3] },
    n > 4 ? { text: 'rest of the chain', p: [-32, 26, z - 14 - 2.4 * (n - 5)], side: 'l', n: [0, 0.3, 1], minor: true } : { text: 'chain of cards', p: [-32, 26, z - 14], side: 'l', n: side, minor: true },
    { text: 'sprung needles', p: [HOOK_X(0) + 1.8, NEEDLE_Y, -5], side: 'l', n: front, minor: true },
    { text: 'hooks', p: [HOOK_X(HOOKS - 1), 51, 0], side: 'r', n: front },
    { text: 'griffe knife', p: [35, KNIFE_Y + o.griffe, -3], side: 'r', n: front },
    { text: 'comber board', p: [34, COMBER_Y, 3], side: 'r', n: front, minor: true },
    { text: 'harness cords', p: [THREAD_X(0), 8, 0], side: 'l', n: front },
    { text: 'lingoes (weights)', p: [THREAD_X(0), -7, 0], side: 'l', n: front, minor: true },
    { text: 'shuttle', p: [o.shuttleX, 5.3, Z_WEFT], side: 't', n: up },
    { text: 'reed (beater)', p: [35, 13, o.reedZ], side: 'r', n: up, minor: true },
    { text: 'warp threads', p: [THREAD_X(0), 0, Z_BEAM + 8], side: 'l', n: up, minor: true },
    { text: 'cloth', p: [THREAD_X(WARP - 1), 0, Z_FELL + 14], side: 'r', n: up },
  ];
  const keep = whole ? ['cylinder (square prism)', 'griffe knife', 'shuttle', 'reed (beater)', 'warp threads', 'cloth'] : ['cylinder (square prism)', 'sprung needles', 'hooks', 'griffe knife', 'comber board', 'harness cords', 'lingoes (weights)', n > 4 ? 'rest of the chain' : 'chain of cards'];
  return all.filter((a) => keep.includes(a.text));
}
