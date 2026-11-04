// The telegraph key and sounder as parts (DOM-free, tested). The sounder's armature follows phys/relay.ts at the voltage
// the line leaves across the coil; whether it moves at all is phys/telegraph.ts's own test (loop current against PULL_I),
// so the failure point on screen is exactly reachKm. Gaps are drawn x EXAG; the line's drawn length is not to scale.

import type { RGB } from '../gl/instances';
import { quatAxisAngle, quatRotate, type Vec3 } from '../gl/math';
import { box, cyl, rod, wire, type Anchor, type Part } from '../gl/parts';
import { RELAY, SAMPLE_EVERY, DT, T_OFF, T_ON, relaySim, type RelayRun } from '../phys/relay';
import { loopCurrent, PULL_I, type Metal } from '../phys/telegraph';

export const EXAG = 5;
/** Real seconds the model's seconds are stretched to, so a 7 ms pull-in can be seen. */
export const SLOW = 25;
/** A marginal coil is still creeping when the model's 14.5 ms window ends; the armature then eases home over this long (s). */
export const TAIL = 0.02;
/** Hand lever: rest tilt (rad) and length. */
export const LEVER_REST = 0.16, LEVER_L = 26;
const PIV: Vec3 = [-40, 6, 10], PIVOT_S: Vec3 = [72, 13, 4], ARM_L = 35, LP = 16;

export interface Line { V: number; km: number; metal: Metal }
export interface TgPose { kd: number; x: number; flowing: boolean; i: number }
export interface TgPalette { board: RGB; metal: RGB; brass: RGB; wood: RGB; live: RGB; coil: RGB; glow: RGB; wire: RGB }

/** Loop current with the key closed (A) and the voltage that leaves across the coil. */
export const lineCurrent = (l: Line): number => loopCurrent(l.V, l.km, l.metal);
export const coilVolts = (l: Line): number => lineCurrent(l) * RELAY.Rc;
/** The coil pulls in: the same threshold as margin >= 1 and km <= reachKm. */
export const pulls = (l: Line): boolean => lineCurrent(l) >= PULL_I;

let cached: { v: number; run: RelayRun } | null = null;
/** relaySim at the coil voltage, kept while the voltage does not change. */
export function runFor(l: Line): RelayRun {
  const v = coilVolts(l);
  if (!cached || cached.v !== v) cached = { v, run: relaySim(v) };
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
  while (k < 120 && sample(run, t0 + k * SAMPLE_EVERY * DT) > x0) k++;
  return Math.min(x0, sample(run, t0 + k * SAMPLE_EVERY * DT + t));
}

/** Armature angle (rad, opening up) for travel u (m): the pole gap drawn x EXAG over the lever to the poles. */
export const armTheta = (u: number): number => Math.atan(((RELAY.gOpen - u + RELAY.gRes) * 1e3 * EXAG) / LP);

const lit = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const sag = (a: Vec3, b: Vec3, n = 6, d = 3): Vec3[] => Array.from({ length: n + 1 }, (_, i) => {
  const u = i / n;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - d * Math.sin(Math.PI * u), a[2] + (b[2] - a[2]) * u] as Vec3;
});

export const KEY_TIP = (kd: number): Vec3 => {
  const a = LEVER_REST * (1 - kd);
  return [PIV[0] + LEVER_L * Math.cos(a), PIV[1] + LEVER_L * Math.sin(a), PIV[2]];
};
export const ARM_TIP = (u: number): Vec3 => {
  const th = armTheta(u);
  return [PIVOT_S[0] - ARM_L * Math.cos(th), PIVOT_S[1] + ARM_L * Math.sin(th), PIVOT_S[2]];
};
export const POLE_TOP = 26, ANVIL_X = PIVOT_S[0] - ARM_L, POLES = [-4, 14, 32];

export function tgParts(p: TgPose, P: TgPalette): Part[] {
  const out: Part[] = [], w = p.flowing ? P.live : P.wire, wr = p.flowing ? lit(P.live, 0.35) : undefined;
  const wired = (pts: Vec3[], r = 0.5) => out.push(...wire(w, pts, r, 0.3).map((q) => ({ ...q, emissive: wr })));
  out.push(box(P.board, -76, 80, -4, 0, -32, 30));
  // Battery: two jars and their terminals; the earth stakes at either end stand for the return path.
  for (const x of [-66, -56]) out.push(cyl(P.glow, x, -6, 0, 9, 4.2, 0.2), cyl(P.brass, x, -6, 9, 10.5, 1.2, 0.6));
  out.push(cyl(P.metal, -72, 18, -8, 5, 1.1, 0.3), cyl(P.metal, 76, 24, -8, 3, 1.1, 0.3));
  // The key: base, pivot post, lever with a knob, and the contact post it closes on.
  out.push(box(P.wood, -46, -8, 0, 2, 5, 15), box(P.brass, -42, -38, 2, 6.5, 8, 12), cyl(P.brass, -18, 10, 2, 5, 1.6, 0.7), cyl(P.brass, -10, 10, 2, 4, 1.2, 0.6));
  const tip = KEY_TIP(p.kd);
  out.push(rod(P.brass, PIV, tip, 1, 0.6), cyl(P.wood, tip[0], tip[2], tip[1], tip[1] + 5, 3.4, 0.2));
  // The line: poles with a crossarm and an insulator each, the wire sagging between them (its length is not to scale).
  for (const x of POLES) out.push(cyl(P.wood, x, -20, 0, POLE_TOP - 2, 1.2), box(P.wood, x - 4, x + 4, POLE_TOP - 3.5, POLE_TOP - 2, -21.5, -18.5), cyl(P.glow, x, -20, POLE_TOP - 2, POLE_TOP, 0.9, 0.4));
  const tops = POLES.map((x): Vec3 => [x, POLE_TOP + 1, -20]);
  wired([[-56, 10.5, -6], [-56, 13, 10], [-40, 13, 10], [-40, 6.5, 10]]);
  wired([[-18, 5.5, 10], [-18, 5.5, 14], [-10, 5.5, 14], [-10, 4, 10]]);
  wired([[-10, 4, 10], [-10, 12, 0], tops[0]]);
  wired(sag(tops[0], tops[1]));
  wired(sag(tops[1], tops[2]));
  wired([tops[2], [52, 20, -10], [50, 14, -2]]);
  wired([[-66, 10.5, -6], [-72, 14, 6], [-72, 6, 18]]);
  wired([[62, 14, 0], [68, 8, 8], [76, 6, 24]]);
  // The sounder: yoke, two coils on cores, the pivot post, armature, the anvil under its tip and the stop over it.
  const coreTop = PIVOT_S[1], ex = Math.min(1, p.i / PULL_I);
  out.push(box(P.wood, 36, 76, 0, 2, -10, 14), box(P.metal, 44, 66, 2, 4, 1, 7));
  for (const x of [50, 62]) {
    const c = cyl(P.coil, x, 4, 4, 12, 4.2, 0.3);
    out.push(cyl(P.metal, x, 4, 4, coreTop, 1.8, 0.7), ex > 0 && p.flowing ? { ...c, emissive: lit(P.glow, 0.5 * ex) } : c);
  }
  out.push(box(P.brass, 70, 74, 2, coreTop, 0, 8, 0.5));
  const th = armTheta(p.x), rot = quatAxisAngle([0, 0, 1], -th), mid = quatRotate(rot, [-ARM_L / 2, 0.9, 0]);
  out.push({ ...box(P.metal, -ARM_L / 2, ARM_L / 2, -0.9, 0.9, -3.5, 3.5, 0.6), pos: [PIVOT_S[0] + mid[0], PIVOT_S[1] + mid[1], PIVOT_S[2] + mid[2]], rot });
  const thC = armTheta(RELAY.travel), thR = armTheta(0), seat = coreTop + ARM_L * Math.tan(thC), top = coreTop + ARM_L * Math.tan(thR) + 2;
  out.push(cyl(P.brass, ANVIL_X, 4, 2, seat, 1.8, 0.7), box(P.brass, ANVIL_X - 2, ANVIL_X + 2, top + 0.3, top + 2, -8, 2, 0.6), box(P.brass, ANVIL_X - 2, ANVIL_X + 2, 2, top + 0.3, -8, -6, 0.6));
  return out;
}

export function tgAnchors(p: TgPose): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0], k = KEY_TIP(p.kd), a = ARM_TIP(p.x);
  return [
    { text: 'key', p: [k[0], k[1] + 5, k[2]], side: 't', n: up },
    { text: 'contact', p: [-18, 5, 10], side: 'b', n: front },
    { text: 'battery', p: [-61, 9, -6], side: 't', n: up },
    { text: 'line (not to scale)', p: [14, POLE_TOP + 1, -20], side: 't', n: up },
    { text: 'coils', p: [56, 12, 4], side: 'b', n: front },
    { text: 'armature', p: [a[0] + 2, a[1] + 2, a[2]], side: 't', n: up },
    { text: 'anvil', p: [ANVIL_X, 4, 4], side: 'b', n: front },
    { text: 'earth return', p: [76, 0, 24], side: 'l', n: front },
  ];
}
