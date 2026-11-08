// The pressure-operated (diaphragm) valve as parts (DOM-free, tested). The mechanics are a spring-opposed diaphragm
// actuator: net pressure on the diaphragm times its area against a preloaded spring, F = A·ΔP − F0 = k·x, so
//   - the cracking pressure (the bench-set lower value) is F0 / A: below it the stem sits on its stop and nothing opens;
//   - the lift is (A·ΔP − F0) / k, linear in the pressure until the travel stop (the bench-set span is the pressure
//     that takes the stem through its whole travel, set by the spring rate: k·travel / A).
// Sources: Emerson (Fisher) 657 / 667 diaphragm actuators product bulletin and 667NS bulletin: bench set = lower value from
// the spring's compression, span from the spring rate, stem travel in proportion to the pressure between them.
// The numbers are the site's own: the threshold and swing of water.ts (the faucet and column figures).

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, wire, type Anchor, type Part } from '../gl/parts';
import { VDD, VT } from './mosphys';
import { COLUMN_VT } from './water';

export type Kind = 'n' | 'p';
export interface ValveSpec {
  /** Diaphragm area (scene units²; only ratios matter), the cracking pressure as a fraction of the supply, the stem travel. */
  area: number; gc: number; travel: number;
}
export const TRAVEL = 8;
/** A valve whose cracking pressure is vt / vdd of the supply. */
export const specOf = (vt: number, vdd: number): ValveSpec => ({ area: 1, gc: vt / vdd, travel: TRAVEL });
/** The one valve of "Three regions" (mosphys.ts) and the pair of the column figure (water.ts). */
export const ONE: ValveSpec = specOf(VT, VDD);
export const PAIR: ValveSpec = { area: 1, gc: COLUMN_VT, travel: TRAVEL };

/** Spring preload (a force) and rate (force per unit lift). */
export const preload = (v: ValveSpec): number => v.area * v.gc;
export const rate = (v: ValveSpec): number => (v.area * (1 - v.gc)) / v.travel;
/** The pressure that just starts to lift the plunger. */
export const cracking = (v: ValveSpec): number => preload(v) / v.area;
/** The extra pressure that takes it through the whole travel (the bench-set span). */
export const span = (v: ValveSpec): number => (rate(v) * v.travel) / v.area;
/** The pressure across the diaphragm, below minus above, as a fraction of the supply. The NMOS valve: the gate line below, a
 *  vent (ground) above. The PMOS valve: the supply below, the gate line above, so pressure on the gate line closes it. */
export const netPressure = (kind: Kind, g: number): number => (kind === 'n' ? g : 1 - g);
/** Lift of the plunger from its seat: zero at or below the cracking pressure, linear, then the travel stop. */
export const lift = (v: ValveSpec, dP: number): number => Math.min(v.travel, Math.max(0, (v.area * dP - preload(v)) / rate(v)));
export const opening = (v: ValveSpec, kind: Kind, g: number): number => lift(v, netPressure(kind, g)) / v.travel;
/** The spring's force at a lift. */
export const springForce = (v: ValveSpec, x: number): number => preload(v) + rate(v) * x;
/** Gate-line volume held by the diaphragm: the volume the diaphragm has swept, A·x (the gate is dead-ended: it moves only
 *  while the diaphragm does). */
export const swept = (v: ValveSpec, x: number): number => v.area * x;

// ---------------------------------------------------------------- geometry

export const SEAT_Y = 8, DISC_T = 2.5, FLOOR = 2, WALL_TOP = 18, LEVEL_H = 14;
export const DIA_Y = 28, CAP_Y = 56, FREE_LEN = 30, COILS = 8;
/** The diaphragm's height at a lift. */
export const diaphragmY = (x: number): number => DIA_Y + x;
/** The disc's underside above the seat: the gap the water goes through. */
export const gapAt = (x: number): number => x;
/** Spring length at a lift, and the turns drawn. */
export const springLen = (x: number): number => CAP_Y - diaphragmY(x) - 1;

export interface ValvePalette {
  body: RGB; metal: RGB; seat: RGB; disc: RGB; spring: RGB; diaphragm: RGB; water: RGBA; gate: RGBA; glass: RGBA; jet: RGB;
}

export interface OneValve {
  kind: Kind; cx: number;
  /** Lift as a fraction of the travel (animated), the gate pressure (0..1 of the supply), the levels left and right of the seat. */
  open: number; g: number; left: number; right: number; flow: number;
}
export interface ValvePose {
  valves: OneValve[];
  /** The gate line: signed flow (+ filling the diaphragm) and where its pellet is along the line. */
  gateQ: number; phase: number; g: number;
  /** The shared chambers' edges: x of the body's ends. */
  x0: number; x1: number;
}

const shade = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], a];
const line = (p: Part, e: RGB): Part => ({ ...p, emissive: e });

/** One valve in cutaway: seat and disc, the diaphragm chamber, the spring, and its half-shell pipes. */
function valveParts(v: OneValve, P: ValvePalette, spec: ValveSpec): Part[] {
  const out: Part[] = [], { cx, kind } = v, x = v.open * spec.travel, dy = diaphragmY(x);
  // Seat (the partition) and plunger.
  out.push(box(P.seat, cx - 4, cx + 4, FLOOR, SEAT_Y, -8, 8));
  out.push(cyl(P.disc, cx, 0, SEAT_Y + gapAt(x), SEAT_Y + gapAt(x) + DISC_T, 5.5, 0.3));
  out.push(cyl(P.metal, cx, 0, SEAT_Y + gapAt(x) + DISC_T, dy, 0.9, 0.4));
  // The bonnet: two side walls, back wall, a glass front. The chamber roof leaves the stem its way through.
  for (const sx of [-1, 1]) out.push(box(P.body, cx + (sx < 0 ? -10 : 8), cx + (sx < 0 ? -8 : 10), WALL_TOP, CAP_Y + 2, -10, 8));
  out.push(box(P.body, cx - 10, cx + 10, WALL_TOP, CAP_Y + 2, -10, -8), box(P.body, cx - 10, cx + 10, CAP_Y, CAP_Y + 2, -10, 10));
  out.push(box(P.body, cx - 10, cx - 1.2, WALL_TOP, WALL_TOP + 2, -10, 8), box(P.body, cx + 1.2, cx + 10, WALL_TOP, WALL_TOP + 2, -10, 8));
  out.push(box(P.glass, cx - 8, cx + 8, WALL_TOP + 2, CAP_Y, 8, 10));
  // The diaphragm and the stem's top plate.
  out.push(cyl(P.diaphragm, cx, 0, dy, dy + 1, 8, 0.2));
  // The spring above it, compressed to its length at this lift.
  const len = springLen(x), top = CAP_Y, n = COILS, amp = 4.5;
  const pts: Vec3[] = [[cx, dy + 1, 0]];
  for (let i = 0; i < n; i++) pts.push([cx + (i % 2 ? -amp : amp), dy + 1 + (len * (i + 0.5)) / n, 0]);
  pts.push([cx, top, 0]);
  out.push(...wire(P.spring, pts, 0.55, 0.5));
  // Chambers' fluid: the lower one (gate for the NMOS, supply for the PMOS), the upper one for the PMOS (the gate line).
  const gl = shade(P.gate, 0.25 + 0.5 * v.g), sup = shade(P.water, 0.7);
  out.push(box(kind === 'n' ? gl : sup, cx - 8, cx + 8, WALL_TOP + 2, dy, -8, 8));
  if (kind === 'p') out.push(box(gl, cx - 8, cx + 8, dy + 1, CAP_Y, -8, 8));
  // The gate line's half-shell pipe into the chamber and, for the PMOS, the supply riser into the lower one.
  if (kind === 'n') {
    out.push(box(P.metal, cx + 10, cx + 16, 22, 28, -4, 0), box(gl, cx + 10, cx + 16, 23, 27, -3, 3));
  } else {
    out.push(box(P.metal, cx - 16, cx - 10, 46, 52, -4, 0), box(gl, cx - 16, cx - 10, 47, 51, -3, 3));
    out.push(box(P.metal, cx - 16, cx - 10, 22, 28, -4, 0), box(sup, cx - 16, cx - 10, 23, 27, -3, 3));
    out.push(box(P.metal, cx - 16, cx - 13, WALL_TOP, 28, -4, 0), box(sup, cx - 15.4, cx - 13.6, WALL_TOP, 27, -3, 3));
  }
  // Water through the gap: a band whose height is the gap, glowing with the flow.
  if (x > 0.05) out.push(line(box(shade(P.water, 0.9), cx - 6, cx + 6, SEAT_Y, SEAT_Y + gapAt(x), -5, 5), [0, 0, 0]));
  // Vent (NMOS): the top chamber is open to ground.
  if (kind === 'n') out.push(box(P.metal, cx + 6, cx + 10, CAP_Y - 5, CAP_Y - 1, 8, 10));
  return out;
}

/** The whole figure: the body between the chambers, valves, the levels, the gate line. */
export function valveFigure(pose: ValvePose, P: ValvePalette, spec: ValveSpec): Part[] {
  const out: Part[] = [], { x0, x1 } = pose, vs = [...pose.valves].sort((a, b) => a.cx - b.cx);
  // Floor, back wall, glass front, end walls with the ports.
  out.push(box(P.body, x0, x1, 0, FLOOR, -10, 10), box(P.body, x0, x1, FLOOR, WALL_TOP, -10, -8), box(P.glass, x0, x1, FLOOR, WALL_TOP, 8, 10));
  for (const e of [x0, x1 - 2]) out.push(box(P.body, e, e + 2, FLOOR, 5, -10, 10), box(P.body, e, e + 2, 12, WALL_TOP, -10, 10));
  out.push(box(P.metal, x0 - 8, x0, 5, 12, -4, 0), box(P.water, x0 - 8, x0, 6, 11, -3, 3), box(P.metal, x1, x1 + 8, 5, 12, -4, 0));
  // Roof pieces between the bonnets.
  const edges = [x0 + 2, ...vs.flatMap((v) => [v.cx - 10, v.cx + 10]), x1 - 2];
  for (let i = 0; i < edges.length; i += 2) if (edges[i + 1] - edges[i] > 0.1) out.push(box(P.body, edges[i], edges[i + 1], WALL_TOP, WALL_TOP + 2, -10, 10));
  // Water in each chamber to its level: left of the first valve, between, right of the last.
  const lv = (a: number, b: number, level: number) => {
    if (level > 0.01 && b - a > 0.1) out.push(box(P.water, a, b, FLOOR, FLOOR + LEVEL_H * level, -8, 8));
  };
  lv(x0 + 2, vs[0].cx - 4, vs[0].left);
  for (let i = 0; i + 1 < vs.length; i++) lv(vs[i].cx + 4, vs[i + 1].cx - 4, vs[i].right);
  lv(vs[vs.length - 1].cx + 4, x1 - 2, vs[vs.length - 1].right);
  for (const v of vs) out.push(...valveParts(v, P, spec));
  // The gate line: a pipe along the top into each valve; one pellet runs along it while the diaphragms move.
  const gl = shade(P.gate, 0.25 + 0.5 * pose.g), ys = 66, xs = gateLine(vs);
  out.push(box(P.metal, xs[0], xs[xs.length - 1], ys - 3, ys + 3, -4, 0), box(gl, xs[0], xs[xs.length - 1], ys - 2, ys + 2, -3, 3));
  for (const v of vs) {
    const dx = v.kind === 'n' ? v.cx + 13 : v.cx - 13, y1 = v.kind === 'n' ? 25 : 49;
    out.push(box(P.metal, dx - 1.5, dx + 1.5, y1 - 3, ys + 3, -4, 0), box(gl, dx - 0.9, dx + 0.9, y1 - 2.5, ys + 2, -3, 3));
  }
  if (Math.abs(pose.gateQ) > 1e-3) {
    const s = (pose.phase % 1 + 1) % 1, px = xs[0] + (xs[xs.length - 1] - xs[0]) * (pose.gateQ > 0 ? s : 1 - s);
    out.push(line(cyl(P.jet, px, 0, ys - 2.2, ys + 2.2, 1.5 + 2 * Math.min(1, Math.abs(pose.gateQ)), 0.3), P.jet.map((c) => c * 0.6) as RGB));
  }
  return out;
}
const gateLine = (vs: OneValve[]): number[] =>
  [Math.min(...vs.map((v) => v.cx - 14.5)) - 4, Math.max(...vs.map((v) => v.cx + 14.5))];

export function valveAnchors(pose: ValvePose): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0], vs = [...pose.valves].sort((a, b) => a.cx - b.cx);
  const a = vs[vs.length - 1], dy = diaphragmY(a.open * TRAVEL);
  const out: Anchor[] = [
    { text: 'gate line (dead end)', p: [vs[0].cx - 14, 66, 3], side: 't', n: up },
    { text: 'spring', p: [a.cx + 4, 44, 0], side: 'r', n: front },
    { text: 'diaphragm', p: [a.cx + 8, dy, 0], side: 'r', n: front },
    { text: 'plunger', p: [a.cx + 5.5, SEAT_Y + a.open * TRAVEL + 1, 0], side: 'r', n: front },
  ];
  if (pose.valves.length === 1) out.push({ text: 'seat', p: [a.cx, SEAT_Y - 2, 8], side: 'b', n: front });
  if (pose.valves.length > 1) out.push({ text: 'PMOS valve', p: [vs[0].cx, 4, 10], side: 'b', n: front }, { text: 'NMOS valve', p: [a.cx, 4, 10], side: 'b', n: front, minor: false });
  return out;
}
