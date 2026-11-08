// Kelvin's tide predictor as parts (DOM-free, tested). Each crank turns a harmonic of the chapter's series (comm/fourier.ts
// seriesOf: amplitude, phase, k cycles a period) and a Scotch yoke turns its angle into a vertical slide: the pulley hung on
// that slider sits d_i = (PEN_SCALE / 2) · A_i · cos(θ_i) below its rest height, θ_i = 2π k t / n + φ. One cord is fixed at one
// end, runs under every movable pulley and over a fixed one between each pair, and hangs a pen at the other end. The cord has
// a constant length, so the pen's height is found from that length (penTip), not from the sum: each movable pulley takes up
// two legs of cord, so the tip moves by 2 Σ d_i = PEN_SCALE · Σ A_i cos θ_i, which is the chapter's sumAt, and the tests hold
// the drawing to it.
//
// 1 unit = 10 mm. The overall box is the Science Museum's record of Thomson's 1872 machine (1820 × 1000 × 770 mm) and it has
// ten cranks; the pulley sizes and the interior layout are drawn, not measured (see the note in the view).

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, wire, type Anchor, type Part } from '../gl/parts';
import { PATTERNS, seriesOf, type Harmonic } from '../comm/fourier';

/** Ten components, as the 1872 machine. */
export const N_CRANKS = 10;
/** Pen travel per unit of the wave (level ±1 swings ±PEN_SCALE units). */
export const PEN_SCALE = 6;
/** Crank pitch, and the radii of a movable pulley, a fixed pulley and the cord; the cord rides a radius beyond the rim. */
export const PITCH = 11, R_MOV = 2.2, R_FIX = 2.8, R_CORD = 0.25;
/** The cord's radius round a movable pulley (a) and a fixed one (b): a + b = PITCH / 2, so every leg is vertical. */
export const A_ARC = R_MOV + R_CORD, B_ARC = R_FIX + R_CORD;
export const X0 = -(N_CRANKS - 1) / 2 * PITCH;
export const crankX = (i: number): number => X0 + i * PITCH;
/** Heights: crank hubs, movable pulleys at rest, the fixed pulleys' centres, the top rail, the base. */
export const HUB_Y = 18, C0 = 46, YF = 78, RAIL_Y = 96, BASE_T = 4;
/** The pen: its tip at rest, the cord's end above the tip, the x it hangs at, the paper band. */
export const Y0 = 58, PEN_DROP = 3;
export const PEN_X = crankX(N_CRANKS - 1) + PITCH / 2 + B_ARC;
export const PAPER_L = 64, PAPER_Y0 = 42, PAPER_Y1 = 74, PAPER_Z = -4;
/** Machine extent along x (base) and across it (z). */
export const BASE_X0 = -60, BASE_X1 = 122, DEPTH = 77;

// ---------------------------------------------------------------- the chapter's series on the cranks

export interface Tide {
  pat: number;
  bits: number[];
  /** Bits in the pattern's period. */
  n: number;
  dc: number;
  /** The first N_CRANKS harmonics of seriesOf, in order: harmonic i is crank i. */
  harms: Harmonic[];
}

export function tideOf(pat: number): Tide {
  const bits = PATTERNS[pat].bits, s = seriesOf(bits, 64);
  return { pat, bits, n: bits.length, dc: s.dc, harms: s.harmonics.slice(0, N_CRANKS) };
}

/** The crank's angle at time t (bits): the harmonic's own argument. */
export const angleOf = (h: Harmonic, n: number, t: number): number => (2 * Math.PI * h.k * t) / n + h.phase;
/** The throw of crank i: PEN_SCALE / 2 · A. */
export const throwOf = (h: Harmonic): number => (PEN_SCALE / 2) * h.amp;

/** How far each movable pulley has moved down the cord's way at time t; a crank switched off is disengaged (0). */
export function offsetsAt(td: Tide, on: readonly boolean[], t: number): number[] {
  return td.harms.map((h, i) => (on[i] ? throwOf(h) * Math.cos(angleOf(h, td.n, t)) : 0));
}

// ---------------------------------------------------------------- the cord

/** The cord's end at the fixed side rides on a clamp: it sits dc · PEN_SCALE above the fixed pulleys' level (the wave's mean). */
const anchorY = (dc: number): number => YF + PEN_SCALE * dc;
const legs = (d: readonly number[], dc: number): number => {
  let sum = anchorY(dc) - (C0 - d[0]); // the left leg of the first pulley
  d.forEach((di, i) => { sum += YF - (C0 - di); if (i > 0) sum += YF - (C0 - di); });
  return sum;
};
/** The cord's length: fixed. At rest (every d = 0, dc = 0) the pen's tip stands at Y0. */
const LENGTH = (() => { const d = Array(N_CRANKS).fill(0); return legs(d, 0) + (YF - (Y0 + PEN_DROP)); })();

/** Where the pen's tip is, found from the cord's constant length: what is left after the legs hangs from the last fixed pulley. */
export function penTip(d: readonly number[], dc: number): number {
  return YF - (LENGTH - legs(d, dc)) - PEN_DROP;
}

const ARC = 8;
/** The cord as a polyline: clamp, down, under each movable pulley, up, over each fixed one, down to the pen. */
export function cordPath(d: readonly number[], dc: number): Vec3[] {
  const pts: Vec3[] = [[crankX(0) - A_ARC, anchorY(dc), 0]];
  for (let i = 0; i < N_CRANKS; i++) {
    const x = crankX(i), c = C0 - d[i];
    for (let s = 0; s <= ARC; s++) { const f = Math.PI + (Math.PI * s) / ARC; pts.push([x + A_ARC * Math.cos(f), c + A_ARC * Math.sin(f), 0]); }
    const xf = x + PITCH / 2;
    for (let s = 0; s <= ARC; s++) { const f = Math.PI - (Math.PI * s) / ARC; pts.push([xf + B_ARC * Math.cos(f), YF + B_ARC * Math.sin(f), 0]); }
  }
  pts.push([PEN_X, penTip(d, dc) + PEN_DROP, 0]);
  return pts;
}
export const pathLength = (p: readonly Vec3[]): number => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);

// ---------------------------------------------------------------- the paper

/** The paper band's speed (units a bit) and the span of time it shows: two periods. */
export const paperSpeed = (n: number): number => PAPER_L / (2 * n);
const TRACE_N = 120;

/** The trace: pen height at the times the paper has carried to x (older ones further from the pen). */
export function traceOf(td: Tide, on: readonly boolean[], t: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [], span = 2 * td.n;
  for (let j = 0; j <= TRACE_N; j++) {
    const tj = t - (span * j) / TRACE_N;
    if (tj < 0) break;
    out.push({ x: PEN_X + (t - tj) * paperSpeed(td.n), y: penTip(offsetsAt(td, on, tj), td.dc) });
  }
  return out;
}

/** The pen's height as a level of the chapter's wave: (tip − Y0) / PEN_SCALE. */
export const levelOf = (tip: number): number => (tip - Y0) / PEN_SCALE;

// ---------------------------------------------------------------- the drawing

export interface TidePalette {
  iron: RGB; brass: RGB; wood: RGB; steel: RGB; cord: RGB; paper: RGB; ink: RGB; off: RGB; glass: RGBA; live: RGB;
}

const tiles = (out: Part[], c: RGB, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, nx: number, ny: number): void => {
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    out.push(box(c, x0 + ((x1 - x0) * i) / nx, x0 + ((x1 - x0) * (i + 1)) / nx, y0 + ((y1 - y0) * j) / ny, y0 + ((y1 - y0) * (j + 1)) / ny, z0, z1));
  }
};
const along = (c: RGB, x: number, y: number, z0: number, z1: number, r: number, spec = 0): Part => rod(c, [x, y, z0], [x, y, z1], r, spec);

export function tideParts(td: Tide, on: readonly boolean[], t: number, P: TidePalette, flat = false): Part[] {
  // The flat view sorts faces by their centre: a big paper tile would hide the marks lying on it, so they stand off the paper.
  const lift = flat ? 3 : 0;
  const out: Part[] = [], d = offsetsAt(td, on, t), tip = penTip(d, td.dc);
  // Wooden base, in tiles so the painter's sort does not hide the machine under it, and the cast-iron frame.
  tiles(out, P.wood, BASE_X0, BASE_X1, 0, BASE_T, -DEPTH / 2, DEPTH / 2, 14, 3);
  const postX = [crankX(0) - PITCH / 2 - 3, PEN_X + 3];
  for (const x of postX) for (const z of [-4.5, 4.5]) out.push(box(P.iron, x - 1.2, x + 1.2, BASE_T, 100, z - 1.2, z + 1.2, 0.1));
  tiles(out, P.iron, postX[0], postX[1], RAIL_Y, 100, -3, 3, 10, 1);
  // The paper band's table: iron legs, a wooden board, the band of paper.
  for (const z of [-30, 30]) out.push(box(P.iron, BASE_X1 - 2, BASE_X1, BASE_T, PAPER_Y0 - 2, z - 1.5, z + 1.5));
  tiles(out, P.wood, PEN_X - 3, PEN_X + PAPER_L + 3, PAPER_Y0 - 3, PAPER_Y1 + 3, PAPER_Z - 1.2, PAPER_Z, 8, 3);
  tiles(out, P.paper, PEN_X - 1, PEN_X + PAPER_L, PAPER_Y0, PAPER_Y1, PAPER_Z, PAPER_Z + 0.2, 8, 3);
  // Marks every bit, carried along with the paper.
  const v = paperSpeed(td.n);
  for (let m = Math.ceil(t - PAPER_L / v); m <= Math.floor(t); m++) {
    const x = PEN_X + (t - m) * v;
    if (x < PEN_X || x > PEN_X + PAPER_L - 0.3 || m < 0) continue;
    out.push(box(P.ink, x - 0.15, x + 0.15, PAPER_Y0, PAPER_Y0 + 2.2, PAPER_Z + 0.2 + lift, PAPER_Z + 0.35 + lift));
  }
  const tr = traceOf(td, on, t);
  out.push(...wire(P.ink, tr.map((q): Vec3 => [q.x, q.y, PAPER_Z + 0.45 + lift]), 0.28));

  for (let i = 0; i < N_CRANKS; i++) {
    const h = td.harms[i], x = crankX(i), engaged = on[i], r = throwOf(h), th = angleOf(h, td.n, t), yoke = HUB_Y - d[i], c = C0 - d[i];
    const ink = engaged ? P.brass : P.off;
    // Crank: hub, arm to the pin (the pin sits where the yoke's slot puts the slide), a steel pin through the yoke.
    const px = x + r * Math.sin(th), py = HUB_Y - r * Math.cos(th);
    out.push(along(P.steel, x, HUB_Y, 0, 4, 0.7, 0.4), along(ink, x, HUB_Y, 3.0, 3.8, 1.5, 0.4));
    out.push(rod(ink, [x, HUB_Y, 3.4], [px, py, 3.4], 0.45, 0.4));
    if (engaged) out.push(along(P.steel, px, py, 0.2, 4.2, 0.5, 0.4));
    // Yoke (a bar with a slot, drawn solid) and the two cast-iron uprights carrying the pulley's axle.
    out.push(box(P.iron, x - r - 1.4, x + r + 1.4, yoke - 0.6, yoke + 0.6, -2.4, 2.4));
    for (const z of [-2.0, 2.0]) out.push(box(P.iron, x - 0.35, x + 0.35, yoke, c, z - 0.3, z + 0.3));
    out.push(along(P.steel, x, c, -2.1, 2.1, 0.35, 0.4), along(P.brass, x, c, -1.1, 1.1, R_MOV, 0.4));
    // The fixed pulley between this crank and the next, on forks from the rail.
    const xf = x + PITCH / 2;
    out.push(along(P.steel, xf, YF, -2.1, 2.1, 0.35, 0.4), along(P.brass, xf, YF, -1.1, 1.1, R_FIX, 0.4));
    for (const z of [-2.0, 2.0]) out.push(box(P.iron, xf - 0.35, xf + 0.35, YF, RAIL_Y, z - 0.3, z + 0.3));
  }
  // The clamp the cord starts from, hung from the rail by a steel rod.
  const ay = anchorY(td.dc), ax = crankX(0) - A_ARC;
  out.push(box(P.brass, ax - 0.9, ax + 0.9, ay, ay + 1.4, -0.9, 0.9), rod(P.steel, [ax, ay + 1.4, 0], [ax, RAIL_Y, 0], 0.3, 0.4));
  // The cord, then the hanging weight: ink bottle and a glass pen touching the paper.
  out.push(...wire(P.cord, cordPath(d, td.dc), R_CORD));
  const bt = tip + PEN_DROP;
  out.push(cyl(P.ink, PEN_X, 0, tip + 0.6, bt, 1.1), rod(P.glass, [PEN_X, tip + 1.2, 0], [PEN_X, tip, PAPER_Z + 0.5 + lift], 0.3));
  return out;
}

export function tideAnchors(_td: Tide): Anchor[] {
  const front: Vec3 = [0, 0.1, 1];
  return [
    { text: 'cranks, one a harmonic', p: [crankX(2), HUB_Y - 5, 3.4], side: 'b', n: front },
    { text: 'slider and movable pulley', p: [crankX(6), C0 - 2, 2], side: 'b', n: front },
    { text: 'fixed pulleys', p: [crankX(1) + PITCH / 2, YF - 4, 0], side: 'b', n: front }, // below the row: above it the text runs off a phone's canvas
    { text: 'cord, fixed here', p: [crankX(0) - A_ARC, YF + 4, 0], side: 'r', n: front, minor: true },
    { text: 'ink bottle and pen', p: [PEN_X, Y0 + 2, 0], side: 'l', n: front },
    { text: 'moving paper', p: [PEN_X + 40, PAPER_Y0 - 1, PAPER_Z], side: 'b', n: front },
  ];
}
