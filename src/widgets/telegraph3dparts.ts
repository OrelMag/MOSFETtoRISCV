// The telegraph key, circuit closer and main-line sounder as parts (DOM-free, tested). The sounder's armature follows
// phys/relay.ts (SOUNDER: the relay's magnet and spring, a 120 Ω coil, no telephone quench) at the voltage the line leaves
// across the coil; whether it moves at all is phys/telegraph.ts's own test (loop current against PULL_I), so the failure
// point on screen is exactly reachKm. Gaps are drawn x EXAG; the line's drawn length is not to scale. Units: U = 3 mm
// (telegraph3dkit.ts draws it in millimetres).

import type { Vec3 } from '../gl/math';
import { RELAY, SAMPLE_EVERY, DT, T_OFF, T_ON, relaySim, type RelayRun } from '../phys/relay';
import { loopCurrent, PULL_I, SOUNDER, SOUNDER_R, type Metal } from '../phys/telegraph';

export const EXAG = 5;
/** Real seconds the model's seconds are stretched to, so a 7 ms pull-in can be seen. */
export const SLOW = 25;
/** A marginal coil is still creeping when the model's 14.5 ms window ends; the armature then eases home over this long (s). */
export const TAIL = 0.02;
/** Key lever: rest tilt (rad), length to the knob, and where the contact stud sits under it (a Bunnell-type lever is longer than the sounder's pole spacing). */
export const LEVER_REST = 0.16, LEVER_L = 36, CONTACT_U = 24;
/** The circuit closer's lever: length, and its angle open and closed (rad, from its post to the stud that shorts the key). */
export const CLOSER_L = 13.2, CLOSER_OPEN = 0.65, CLOSER_SHUT = -0.18;
/** The model run is kept 45 ms: a sounder in the model releases within 15 ms of the loop opening, the most overdriven. */
export const WINDOW = { tOff: T_OFF, tEnd: 45e-3 };
const PIV: Vec3 = [-40, 6, 10], PIVOT_S: Vec3 = [72, 13, 4], ARM_L = 35, LP = 16;

export interface Line { V: number; km: number; metal: Metal }
/** kd: key lever down 0..1; x: armature travel; flowing: current in the loop; cd: circuit closer shut 0..1 (default open). */
export interface TgPose { kd: number; x: number; flowing: boolean; i: number; cd?: number }

/** Loop current with the key closed (A) and the voltage that leaves across the coil. */
export const lineCurrent = (l: Line): number => loopCurrent(l.V, l.km, l.metal);
export const coilVolts = (l: Line): number => lineCurrent(l) * SOUNDER_R;
/** The coil pulls in: the same threshold as margin >= 1 and km <= reachKm. */
export const pulls = (l: Line): boolean => lineCurrent(l) >= PULL_I;

let cached: { v: number; run: RelayRun } | null = null;
/** relaySim at the coil voltage, kept while the voltage does not change. */
export function runFor(l: Line): RelayRun {
  const v = coilVolts(l);
  if (!cached || cached.v !== v) cached = { v, run: relaySim(v, SOUNDER, WINDOW) };
  return cached.run;
}

const sample = (run: RelayRun, t: number): number => {
  const f = Math.max(0, Math.min(run.s.length - 1, t / (SAMPLE_EVERY * DT))), i = Math.floor(f), j = Math.min(run.s.length - 1, i + 1);
  return run.s[i].x + (run.s[j].x - run.s[i].x) * (f - i);
};
/** Armature travel (m) `t` model seconds after the key closes. Not pulled: it does not move at all. */
export function pressX(l: Line, t: number): number {
  if (!pulls(l)) return 0;
  const run = runFor(l), end = T_OFF - T_ON - SAMPLE_EVERY * DT;
  const xw = sample(run, Math.min(t, end) + T_ON);
  if (xw >= 0.99 * RELAY.travel) return t >= end ? RELAY.travel : xw;
  if (t < end) return xw;
  const u = Math.min(1, (t - end) / TAIL);
  return xw + (RELAY.travel - xw) * u * u * (3 - 2 * u);
}
/** Travel `t` model seconds after the key opens, from travel x0 (the model's release, then no further than x0). */
export function releaseX(l: Line, x0: number, t: number): number {
  if (x0 <= 0) return 0;
  const run = runFor(l), t0 = T_OFF + 1e-9;
  let k = 0;
  while (k < 400 && sample(run, t0 + k * SAMPLE_EVERY * DT) > x0) k++;
  return Math.min(x0, sample(run, t0 + k * SAMPLE_EVERY * DT + t));
}

/** Armature angle (rad, opening up) for travel u (m): the pole gap drawn x EXAG over the lever to the poles. */
export const armTheta = (u: number): number => Math.atan(((RELAY.gOpen - u + RELAY.gRes) * 1e3 * EXAG) / LP);

export const KEY_TIP = (kd: number, u = LEVER_L): Vec3 => {
  const a = LEVER_REST * (1 - kd);
  return [PIV[0] + u * Math.cos(a), PIV[1] + u * Math.sin(a), PIV[2]];
};
export const CLOSER_PIV: Vec3 = [-34, 7, 17];
/** The closer lever's far end: 0 open (raised), 1 shut on its stud. */
export const CLOSER_TIP = (cd: number): Vec3 => {
  const a = CLOSER_OPEN + (CLOSER_SHUT - CLOSER_OPEN) * cd;
  return [CLOSER_PIV[0] + CLOSER_L * Math.cos(a), CLOSER_PIV[1] + CLOSER_L * Math.sin(a), CLOSER_PIV[2]];
};
export const ARM_TIP = (u: number): Vec3 => {
  const th = armTheta(u);
  return [PIVOT_S[0] - ARM_L * Math.cos(th), PIVOT_S[1] + ARM_L * Math.sin(th), PIVOT_S[2]];
};
export const POLE_TOP = 26, ANVIL_X = PIVOT_S[0] - ARM_L, POLES = [-4, 14, 32];
/** The retractor spring hangs from a bracket over the armature at this distance from its pivot (drawn); its tension screw sits above. */
export const SPRING_S = 33, BRACKET_Y = 31;
