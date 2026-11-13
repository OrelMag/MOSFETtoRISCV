// The pressure-operated (diaphragm) valve as parts (DOM-free, tested). The mechanics are a spring-opposed diaphragm
// actuator: net pressure on the diaphragm times its area against a preloaded spring, F = A·ΔP − F0 = k·x, so
//   - the cracking pressure (the bench-set lower value) is F0 / A: below it the stem sits on its stop and nothing opens;
//   - the lift is (A·ΔP − F0) / k, linear in the pressure until the travel stop (the bench-set span is the pressure
//     that takes the stem through its whole travel, set by the spring rate: k·travel / A).
// Sources: Emerson (Fisher) 657 / 667 diaphragm actuators product bulletin and 667NS bulletin: bench set = lower value from
// the spring's compression, span from the spring rate, stem travel in proportion to the pressure between them.
// The numbers are the site's own: the threshold and swing of water.ts (the faucet and column figures).

import type { Vec3 } from '../gl/math';
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
export const DIA_Y = 28, CAP_Y = 56, FREE_LEN = 30, COILS = 3.5, PTS_PER_COIL = 8;
/** The diaphragm's height at a lift. */
export const diaphragmY = (x: number): number => DIA_Y + x;
/** The disc's underside above the seat: the gap the water goes through. */
export const gapAt = (x: number): number => x;
/** The spring as a helix of COILS turns (radius 4.5) from the plate at y0 up to the cap at y1, ends on the axis. */
export function springPoints(cx: number, y0: number, y1: number): Vec3[] {
  const n = Math.round(COILS * PTS_PER_COIL), amp = 4.5, pts: Vec3[] = [[cx, y0, 0]];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / PTS_PER_COIL;
    pts.push([cx + amp * Math.cos(a), y0 + ((y1 - y0) * (i + 0.5)) / (n + 1), amp * Math.sin(a)]);
  }
  pts.push([cx, y1, 0]);
  return pts;
}
/** Spring length at a lift, and the turns drawn. */
export const springLen = (x: number): number => CAP_Y - diaphragmY(x) - 1;

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
