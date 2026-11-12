// Kelvin's tide predictor as parts (DOM-free, tested). Each crank turns a harmonic of the chapter's series (comm/fourier.ts
// seriesOf: amplitude, phase, k cycles a period); its pin sits d_i = (PEN_SCALE / 2) · A_i · cos(θ_i) below its rest height and
// e_i = (PEN_SCALE / 2) · A_i · sin(θ_i) to the side, θ_i = 2π k t / n + φ. One cord is fixed at one end, runs under every
// movable pulley and over a fixed one between each pair, and hangs a pen at the other end. The cord has a constant length,
// so the pen's height is found from that length (penTip: tangents and arcs round every pulley), not from the sum.
//
// Two mechanisms (Mech). The 1872 machine hung each movable pulley on its crank pin, so the pulley went round with the pin:
// "The motions of the pulley axles had horizontal as well as vertical motions, which introduced small errors and all later
// machines had strictly vertical motions" (P. L. Woodworth, An inventory of tide prediction machines, NOC Research &
// Consultancy Report 56, 2016, p. 15, after Cartwright 1999). 'pins' draws that: the legs tilt and the pen is the sum only
// nearly. 'yoke' is the later machines' slotted yoke: the pulley moves straight up and down (e = 0), every leg stays
// vertical, each pulley takes up two legs of cord, and the tip moves by 2 Σ d_i = PEN_SCALE · Σ A_i cos θ_i, which is the
// chapter's sumAt exactly; the tests hold the drawing to it, and bound the crank pins' error.
//
// 1 unit = 10 mm. The overall box is the Science Museum's record of Thomson's 1872 machine (1820 × 1000 × 770 mm) and it has
// ten cranks; the pulley sizes and the interior layout are drawn, not measured (see the note in the view).
//
// Two sets of cranks. The default is the chapter's: the first ten harmonics of a bit pattern (integer rates, the wave repeats
// every period). The "real tide" preset runs ten tidal constituents at their true speeds (degrees an hour), which are not
// multiples of one another, so the curve never repeats; M2 against S2 beats at 360 / (30.0000 - 28.9841) = 354.4 h, the
// spring-neap cycle. Both go through the same angleOf: a crank at k "cycles a period" of n turns 360 k / n a unit of time, and
// the constituents are written with n = 360 and k = the speed in degrees an hour.

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
/** The cord's radius round a movable pulley (a) and a fixed one (b): a + b = PITCH / 2, so every leg is vertical at rest. */
export const A_ARC = R_MOV + R_CORD, B_ARC = R_FIX + R_CORD;
export const X0 = -(N_CRANKS - 1) / 2 * PITCH;
export const crankX = (i: number): number => X0 + i * PITCH;
/** The 1872 machine's pulleys on crank pins, or the later machines' slotted yokes. */
export type Mech = 'pins' | 'yoke';
/** Heights: crank hubs (on a yoke machine; on crank pins the hub is at the pulley's rest height C0), movable pulleys at rest,
 * the fixed pulleys' centres, the top rail, the base. */
export const HUB_Y = 18, C0 = 46, YF = 78, RAIL_Y = 96, BASE_T = 4;
/** The pen: its tip at rest, the cord's end above the tip, the x it hangs at, the paper band. */
export const Y0 = 58, PEN_DROP = 3;
export const PEN_X = crankX(N_CRANKS - 1) + PITCH / 2 + B_ARC;
export const PAPER_L = 60, PAPER_Y0 = 42, PAPER_Y1 = 74, PAPER_Z = -4;
/** Machine extent along x (base) and across it (z). */
const RS = 4.3; // the crank slot's length
export const BASE_X0 = -60, BASE_X1 = 122, DEPTH = 77;

// ---------------------------------------------------------------- the chapter's series on the cranks

/** The preset after the chapter's patterns: ten tidal constituents at their true speeds. */
export const TIDE_PRESET = PATTERNS.length;

export interface Tide {
  pat: number;
  /** 'harmonics': the chapter's series (time in bits); 'tide': constituents (time in hours). */
  kind: 'harmonics' | 'tide';
  /** One name a crank: the harmonic's k, or the constituent's. */
  names: string[];
  /** The hand crank's own k (cycles an n): the cranks' gear ratios are k / handK. */
  handK: number;
  /** Time the paper shows, between its marks, a "Step", and a Run's 14 s; samples on the trace. */
  span: number; mark: number; stepT: number; runT: number; traceN: number;
  bits: number[];
  /** Bits in the pattern's period. */
  n: number;
  dc: number;
  /** The first N_CRANKS harmonics of seriesOf, in order: harmonic i is crank i. */
  harms: Harmonic[];
}

/**
 * The ten constituents: speeds in degrees an hour from the IHO / Doodson table (the list NOAA's tide-prediction material uses).
 * The 1872 machine's ten: "The 10 components were M2, S2, N2, K2, Q1, K1, L2, P1, M4 and MS4" (Woodworth 2016, p. 15; the
 * Science Museum's record 1876-1129 gives the count only). Amplitudes (m) and phases (degrees at t = 0) are illustrative of a
 * semi-diurnal port, not a real station's; t = 0 is a spring tide (M2 and S2 in phase).
 */
export const CONSTITUENTS: { name: string; speed: number; amp: number; phase: number }[] = [
  { name: 'M2', speed: 28.9841042, amp: 1.0, phase: 0 },
  { name: 'S2', speed: 30.0, amp: 0.34, phase: 0 },
  { name: 'N2', speed: 28.4397295, amp: 0.2, phase: 60 },
  { name: 'K1', speed: 15.0410686, amp: 0.1, phase: 200 },
  { name: 'L2', speed: 29.5284789, amp: 0.03, phase: 30 },
  { name: 'P1', speed: 14.9589314, amp: 0.03, phase: 200 },
  { name: 'K2', speed: 30.0821373, amp: 0.09, phase: 0 },
  { name: 'Q1', speed: 13.3986609, amp: 0.015, phase: 30 },
  { name: 'M4', speed: 57.9682084, amp: 0.04, phase: 90 },
  { name: 'MS4', speed: 58.9841042, amp: 0.03, phase: 90 },
];
/** One turn of the hand crank takes a mean solar day: 15 degrees an hour. */
export const HAND_DEG_H = 15;
/** Hours between the springs of two constituents' beat: 360 / (the difference of their speeds, degrees an hour). */
export const beatHours = (a: number, b: number): number => 360 / Math.abs(b - a);

export function tideOf(pat: number): Tide {
  if (pat === TIDE_PRESET) {
    return {
      pat, kind: 'tide', bits: [], n: 360, dc: 0, names: CONSTITUENTS.map((c) => c.name), handK: HAND_DEG_H,
      harms: CONSTITUENTS.map((c) => ({ k: c.speed, amp: c.amp, phase: (c.phase * Math.PI) / 180 })),
      span: 360, mark: 24, stepT: 24, runT: 360, traceN: 180,
    };
  }
  const bits = PATTERNS[pat].bits, s = seriesOf(bits, 64), harms = s.harmonics.slice(0, N_CRANKS);
  return { pat, kind: 'harmonics', bits, n: bits.length, dc: s.dc, names: harms.map((h) => String(h.k)), handK: 1, harms, span: 2 * bits.length, mark: 1, stepT: bits.length / 20, runT: bits.length, traceN: 120 };
}

/** The crank's angle at time t (bits): the harmonic's own argument. */
export const angleOf = (h: Harmonic, n: number, t: number): number => (2 * Math.PI * h.k * t) / n + h.phase;
/** The throw of crank i: PEN_SCALE / 2 · A. */
export const throwOf = (h: Harmonic): number => (PEN_SCALE / 2) * h.amp;
/** The throw in millimetres (1 unit = 10 mm). */
export const throwMm = (h: Harmonic): number => 10 * throwOf(h);
/** The hand crank's angle at time t. */
export const handAngle = (td: Tide, t: number): number => (2 * Math.PI * td.handK * t) / td.n;

// ---------------------------------------------------------------- the gearing

/** Centre distance between the main shaft and a crank shaft: every pair meshes, so the two pitch radii add up to it. */
export const GEAR_C = 4.8;
/** Height of the main shaft (on a yoke machine), and its z (behind the cranks). */
export const MAIN_Y = HUB_Y - GEAR_C, GEAR_Z = -8;
/** The crank hubs' and the main shaft's heights for a mechanism: on crank pins the hub is where the pulley rests. */
export const hubY = (m: Mech): number => (m === 'pins' ? C0 : HUB_Y);
export const mainY = (m: Mech): number => hubY(m) - GEAR_C;
/** A crank's speed over the hand crank's: k / handK. */
export const ratioOf = (td: Tide, h: Harmonic): number => h.k / td.handK;
/** Pitch radii (main-shaft wheel, crank-shaft wheel) of the pair giving ratio = r_main / r_crank at centre distance GEAR_C. */
export function gearRadii(ratio: number): [number, number] {
  return [(GEAR_C * ratio) / (1 + ratio), GEAR_C / (1 + ratio)];
}

/** How far each movable pulley has moved down the cord's way at time t; a crank switched off is disengaged (0). */
export function offsetsAt(td: Tide, on: readonly boolean[], t: number): number[] {
  return td.harms.map((h, i) => (on[i] ? throwOf(h) * Math.cos(angleOf(h, td.n, t)) : 0));
}
/** How far each movable pulley has moved sideways (+x): its crank pin's horizontal offset on 'pins', none on 'yoke'. */
export function sidewaysAt(td: Tide, on: readonly boolean[], t: number, m: Mech): number[] {
  return td.harms.map((h, i) => (on[i] && m === 'pins' ? throwOf(h) * Math.sin(angleOf(h, td.n, t)) : 0));
}

// ---------------------------------------------------------------- the cord

/** The cord's end at the fixed side rides on a clamp: it sits dc · PEN_SCALE above the fixed pulleys' level (the wave's mean). */
const anchorY = (dc: number): number => YF + PEN_SCALE * dc;

/** A turn of the cord round a pulley: centre, radius (the cord's), and the way it goes round (+1 anticlockwise: under a
 * movable pulley from left to right; −1 clockwise: over a fixed one). The clamp is a turn of radius 0. */
interface Turn { cx: number; cy: number; r: number; s: 1 | -1 }
const turnsOf = (d: readonly number[], e: readonly number[], dc: number): Turn[] => {
  const out: Turn[] = [{ cx: crankX(0) - A_ARC, cy: anchorY(dc), r: 0, s: 1 }];
  for (let i = 0; i < N_CRANKS; i++) {
    out.push({ cx: crankX(i) + e[i], cy: C0 - d[i], r: A_ARC, s: 1 }, { cx: crankX(i) + PITCH / 2, cy: YF, r: B_ARC, s: -1 });
  }
  return out;
};
/** The straight run from turn a to turn b: it leaves a and meets b on the sides their ways round them put it. */
function run(a: Turn, b: Turn): { p: [number, number]; q: [number, number]; len: number } {
  const dx = b.cx - a.cx, dy = b.cy - a.cy, L = Math.hypot(dx, dy), ra = -a.s * a.r, rb = -b.s * b.r;
  const phi = Math.atan2(dy, dx) - Math.asin((ra - rb) / L), nx = -Math.sin(phi), ny = Math.cos(phi);
  return { p: [a.cx + ra * nx, a.cy + ra * ny], q: [b.cx + rb * nx, b.cy + rb * ny], len: Math.sqrt(L * L - (ra - rb) ** 2) };
}
/** The angle a turn sweeps from where the cord meets it to where it leaves, the way it goes round: in [0, 2π). */
const sweep = (t: Turn, from: number, to: number): number => { const a = (t.s * (to - from)) % (2 * Math.PI); return a < 0 ? a + 2 * Math.PI : a; };
const angleAt = (t: Turn, p: readonly [number, number]): number => Math.atan2(p[1] - t.cy, p[0] - t.cx);
/** The cord from the clamp to where it leaves the last fixed pulley, straight down to the pen (angle 0 on that pulley):
 * its length, and the points it runs through (each arc sampled arc times). */
function belt(d: readonly number[], e: readonly number[], dc: number, arc = 0): { len: number; pts: Vec3[] } {
  const ts = turnsOf(d, e, dc), runs = ts.slice(1).map((b, i) => run(ts[i], b));
  let len = 0;
  const pts: Vec3[] = [[ts[0].cx, ts[0].cy, 0]];
  runs.forEach((r, i) => {
    len += r.len;
    const t = ts[i + 1], from = angleAt(t, r.q), to = i + 1 < runs.length ? angleAt(t, runs[i + 1].p) : 0, sw = sweep(t, from, to);
    len += t.r * sw;
    if (arc) for (let k = 0; k <= arc; k++) { const f = from + t.s * (sw * k) / arc; pts.push([t.cx + t.r * Math.cos(f), t.cy + t.r * Math.sin(f), 0]); }
  });
  return { len, pts };
}
const NONE: readonly number[] = Array(N_CRANKS).fill(0);
/** The cord's length: fixed. At rest (every d = 0, dc = 0) the pen's tip stands at Y0. */
const LENGTH = belt(NONE, NONE, 0).len + (YF - (Y0 + PEN_DROP));
/** The cord's whole length for these pulley positions and this pen tip (constant, by the tip penTip finds). */
export const cordLength = (d: readonly number[], dc: number, tip: number, e: readonly number[] = NONE): number => belt(d, e, dc).len + (YF - (tip + PEN_DROP));

/** Where the pen's tip is, found from the cord's constant length: what is left after the pulleys hangs from the last fixed one.
 * e: the movable pulleys' sideways offsets (crank pins); none on a yoke machine. */
export function penTip(d: readonly number[], dc: number, e: readonly number[] = NONE): number {
  return YF - (LENGTH - belt(d, e, dc).len) - PEN_DROP;
}

const ARC = 8;
/** The cord as a polyline: clamp, down, under each movable pulley, up, over each fixed one, down to the pen. */
export function cordPath(d: readonly number[], dc: number, e: readonly number[] = NONE): Vec3[] {
  const pts = belt(d, e, dc, ARC).pts;
  pts.push([PEN_X, penTip(d, dc, e) + PEN_DROP, 0]);
  return pts;
}
export const pathLength = (p: readonly Vec3[]): number => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);

// ---------------------------------------------------------------- the paper

/** The paper band's speed (units a bit) and the span of time it shows: two periods. */
export const paperSpeed = (td: Tide): number => PAPER_L / td.span;

/** The trace: pen height at the times the paper has carried to x (older ones further from the pen). */
export function traceOf(td: Tide, on: readonly boolean[], t: number, m: Mech = 'yoke'): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [], span = td.span;
  for (let j = 0; j <= td.traceN; j++) {
    const tj = t - (span * j) / td.traceN;
    if (tj < 0) break;
    out.push({ x: PEN_X + (t - tj) * paperSpeed(td), y: penTip(offsetsAt(td, on, tj), td.dc, sidewaysAt(td, on, tj, m)) });
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

export function tideParts(td: Tide, on: readonly boolean[], t: number, P: TidePalette, flat = false, m: Mech = 'yoke'): Part[] {
  // The flat view sorts faces by their centre: a big paper tile would hide the marks lying on it, so they stand off the paper.
  const lift = flat ? 3 : 0;
  const out: Part[] = [], d = offsetsAt(td, on, t), e = sidewaysAt(td, on, t, m), tip = penTip(d, td.dc, e), HY = hubY(m), MY = mainY(m);
  // Wooden base, in tiles so the painter's sort does not hide the machine under it, and the cast-iron frame.
  tiles(out, P.wood, BASE_X0, BASE_X1, 0, BASE_T, -DEPTH / 2, DEPTH / 2, 14, 3);
  const postX = [crankX(0) - PITCH / 2 - 3, PEN_X + 3];
  for (const x of postX) for (const z of [-4.5, 4.5]) out.push(box(P.iron, x - 1.2, x + 1.2, BASE_T, 100, z - 1.2, z + 1.2, 0.1));
  tiles(out, P.iron, postX[0], postX[1], RAIL_Y, 100, -3, 3, 10, 1);
  // The paper band's table: iron legs, a wooden board, the band of paper.
  for (const z of [-30, 30]) out.push(box(P.iron, BASE_X1 - 2, BASE_X1, BASE_T, PAPER_Y0 - 2, z - 1.5, z + 1.5));
  tiles(out, P.wood, PEN_X - 1, PEN_X + PAPER_L, PAPER_Y0 - 3, PAPER_Y1 + 3, PAPER_Z - 1.2, PAPER_Z, 8, 3);
  // The band runs from a supply roller to a take-up drum; the drums turn by the paper that has passed, so a mark on each moves.
  const rr = 1.6, rz = PAPER_Z + 0.2 - rr, v = paperSpeed(td), drumX = PEN_X + PAPER_L + rr, supplyX = PEN_X - 1 - rr;
  for (const x of [supplyX, drumX]) {
    out.push(rod(P.steel, [x, PAPER_Y0 - 2, rz], [x, PAPER_Y1 + 2, rz], rr, 0.4));
    const a = (t * v) / rr;
    out.push(rod(P.ink, [x, PAPER_Y1 + 2.05, rz], [x + rr * Math.cos(a), PAPER_Y1 + 2.05, rz + rr * Math.sin(a)], 0.2));
  }
  tiles(out, P.paper, PEN_X - 1, PEN_X + PAPER_L, PAPER_Y0, PAPER_Y1, PAPER_Z, PAPER_Z + 0.2, 8, 3);
  // Marks every bit (a day on the tide), carried along with the paper.
  for (let j = Math.ceil((t - PAPER_L / v) / td.mark); j <= Math.floor(t / td.mark); j++) {
    const m = j * td.mark, x = PEN_X + (t - m) * v;
    if (x < PEN_X || x > PEN_X + PAPER_L - 0.3 || m < 0) continue;
    out.push(box(P.ink, x - 0.15, x + 0.15, PAPER_Y0, PAPER_Y0 + 2.2, PAPER_Z + 0.2 + lift, PAPER_Z + 0.35 + lift));
  }
  const tr = traceOf(td, on, t, m);
  out.push(...wire(P.ink, tr.map((q): Vec3 => [q.x, q.y, PAPER_Z + 0.45 + lift]), 0.28));

  for (let i = 0; i < N_CRANKS; i++) {
    const h = td.harms[i], x = crankX(i), engaged = on[i], r = throwOf(h), th = angleOf(h, td.n, t), yoke = HUB_Y - d[i], c = C0 - d[i];
    const ink = engaged ? P.brass : P.off;
    // Crank: hub, arm to the pin. On a yoke machine the crank is in front and its pin runs in the yoke's slot; on crank pins
    // the crank is behind the pulley and the pulley turns on the pin itself.
    const px = x + r * Math.sin(th), py = HY - r * Math.cos(th), zc = m === 'pins' ? -2.6 : 3.4;
    out.push(along(P.steel, x, HY, GEAR_Z - 1, zc + 0.6, 0.7, 0.4), along(ink, x, HY, zc - 0.4, zc + 0.4, 1.5, 0.4));
    // The crank's radial slot sets the throw (a screw in the real machine) and a scale along it reads it, one tick a 10 mm.
    const ux = Math.sin(th), uy = -Math.cos(th), zs = m === 'pins' ? zc - 0.55 : zc + 0.55;
    out.push(rod(ink, [x, HY, zc], [x + RS * ux, HY + RS * uy, zc], 0.55, 0.4), rod(P.iron, [x + 0.4 * ux, HY + 0.4 * uy, zs], [x + (RS - 0.2) * ux, HY + (RS - 0.2) * uy, zs], 0.2));
    for (const s of [1, 2, 3]) out.push(rod(P.steel, [x + s * ux - 0.6 * uy, HY + s * uy + 0.6 * ux, zs + 0.03], [x + s * ux + 0.6 * uy, HY + s * uy - 0.6 * ux, zs + 0.03], 0.1));
    // The change wheels: one on the main shaft, one on this crank's shaft, meshing; a spoke on the crank wheel shows its turning.
    const [rm, rc] = gearRadii(ratioOf(td, h));
    out.push(along(engaged ? P.steel : P.off, x, MY, GEAR_Z - 0.6, GEAR_Z + 0.6, rm, 0.3), along(engaged ? P.brass : P.off, x, HY, GEAR_Z - 0.6, GEAR_Z + 0.6, rc, 0.3));
    out.push(rod(P.ink, [x, HY, GEAR_Z + 0.7], [x + Math.max(rc, 0.9) * ux, HY + Math.max(rc, 0.9) * uy, GEAR_Z + 0.7], 0.15));
    if (m === 'pins') {
      // The pulley on the crank pin: it goes round with the pin, sideways as well as up and down.
      out.push(along(P.steel, px, py, zc, 1.5, engaged ? 0.5 : 0.35, 0.4), along(P.brass, px, py, -1.1, 1.1, R_MOV, 0.4));
    } else {
      if (engaged) out.push(along(P.steel, px, py, 0.2, 4.2, 0.5, 0.4));
      // Yoke (a bar with a slot, drawn solid) and the two cast-iron uprights carrying the pulley's axle.
      out.push(box(P.iron, x - r - 1.4, x + r + 1.4, yoke - 0.6, yoke + 0.6, -2.4, 2.4));
      for (const z of [-2.0, 2.0]) out.push(box(P.iron, x - 0.35, x + 0.35, yoke, c, z - 0.3, z + 0.3));
      out.push(along(P.steel, x, c, -2.1, 2.1, 0.35, 0.4), along(P.brass, x, c, -1.1, 1.1, R_MOV, 0.4));
    }
    // The fixed pulley between this crank and the next, on forks from the rail.
    const xf = x + PITCH / 2;
    out.push(along(P.steel, xf, YF, -2.1, 2.1, 0.35, 0.4), along(P.brass, xf, YF, -1.1, 1.1, R_FIX, 0.4));
    for (const z of [-2.0, 2.0]) out.push(box(P.iron, xf - 0.35, xf + 0.35, YF, RAIL_Y, z - 0.3, z + 0.3));
  }
  // The main shaft with the hand crank at its left end, on two bearings.
  const sx0 = crankX(0) - 6, sx1 = crankX(N_CRANKS - 1) + 6, ha = handAngle(td, t);
  out.push(rod(P.steel, [sx0, MY, GEAR_Z], [sx1, MY, GEAR_Z], 0.5, 0.4));
  for (const x of [sx0 + 0.8, sx1 - 0.8]) out.push(box(P.iron, x - 1, x + 1, BASE_T, MY + 1.4, GEAR_Z - 1.4, GEAR_Z + 1.4));
  const hz = GEAR_Z + 5 * Math.sin(ha), hy = MY + 5 * Math.cos(ha);
  out.push(rod(P.iron, [sx0 - 0.5, MY, GEAR_Z], [sx0 - 0.5, hy, hz], 0.45), rod(P.wood, [sx0 - 0.5, hy, hz], [sx0 - 3.5, hy, hz], 0.8));
  // The clamp the cord starts from, hung from the rail by a steel rod.
  const ay = anchorY(td.dc), ax = crankX(0) - A_ARC;
  out.push(box(P.brass, ax - 0.9, ax + 0.9, ay, ay + 1.4, -0.9, 0.9), rod(P.steel, [ax, ay + 1.4, 0], [ax, RAIL_Y, 0], 0.3, 0.4));
  // The cord, then the hanging weight: ink bottle and a glass pen touching the paper.
  out.push(...wire(P.cord, cordPath(d, td.dc, e), R_CORD));
  const bt = tip + PEN_DROP;
  out.push(cyl(P.ink, PEN_X, 0, tip + 0.6, bt, 1.1), rod(P.glass, [PEN_X, tip + 1.2, 0], [PEN_X, tip, PAPER_Z + 0.5 + lift], 0.3));
  return out;
}

export function tideAnchors(td: Tide, m: Mech = 'yoke'): Anchor[] {
  const front: Vec3 = [0, 0.1, 1], pins = m === 'pins';
  return [
    { text: td.kind === 'tide' ? 'slotted cranks, one a constituent' : 'slotted cranks, one a harmonic', p: [crankX(2), hubY(m) - 5, pins ? -2.6 : 3.4], side: 'b', n: front },
    { text: 'hand crank and main shaft', p: [crankX(0) - 9, mainY(m), GEAR_Z], side: 'l', n: front, minor: true },
    { text: pins ? 'pulley on its crank pin' : 'slider and movable pulley', p: [crankX(6), C0 - 2, 2], side: 'b', n: front, minor: true },
    { text: 'fixed pulleys', p: [crankX(1) + PITCH / 2, YF - 4, 0], side: 'b', n: front, minor: true }, // below the row: above it the text runs off a phone's canvas
    { text: 'cord, fixed here', p: [crankX(0) - A_ARC, YF + 4, 0], side: 'r', n: front, minor: true },
    { text: 'ink bottle and pen', p: [PEN_X, Y0 + 2, 0], side: 'l', n: front },
    { text: td.kind === 'tide' ? 'paper, a mark a day' : 'moving paper', p: [PEN_X + 40, PAPER_Y0 - 1, PAPER_Z], side: 'b', n: front, minor: true },
  ];
}
