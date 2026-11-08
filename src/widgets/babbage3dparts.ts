// Babbage's Difference Engine No. 2: one column of 31 figure wheels, its warning levers and its carry axis (DOM-free, tested).
// Sources (read, not recalled):
//  - D. Swade, "Charles Babbage's Difference Engine No. 2, Technical Description" (Science Museum, March 2020), §3.2
//    "Warning and Carriage of Tens" and the carry axes (A/171, A/163-165): eight 31-digit numbers, a column of thirty-one figure
//    wheels; during giving-off a wheel passing 9 to 0 arms a warning latch and does NOT carry; in the carry phase "the warning
//    mechanisms are serviced in turn and the carries propagate upwards"; thirty carry arms (1C1_1 .. 1C1_30) in a helix keyed to
//    the carry axis poll each figure wheel "starting from below" ("successive carry"); angular pitch 22 degrees, 45 degrees between
//    the 15th and 16th arms; the carry axes complete two rotations per carry action, the second servicing a warning set during
//    the first by the fifteenth figure wheel; the carry lever warns, locks the wheels and advances the wheel above.
//  - Swade, "The Construction of Charles Babbage's Difference Engine No. 2", IEEE Annals of the History of Computing 27(3), 2005:
//    Babbage "did not use the anticipating carriage technique in Difference Engine No. 2" (it was devised for the Analytical
//    Engine; the technical description is A.G. Bromley, Annals of the History of Computing 4(3), 1982, p. 202 ff, not read here).
//  - C. Babbage, Passages from the Life of a Philosopher (1864), ch. VIII: "teaching the Engine to foresee and then to act upon
//    that foresight"; "the whole of any unlimited number of carriages in one unit of time"; nine units of time for the addition
//    and one unit for the carriage, however many digits.
// The order the arms are reached in below (two sections of 15 arms swept together, the upper one 7 degrees ahead) is derived from
// those angles, not quoted: the document gives the pitch, the gap and the second rotation, and this ordering reproduces all three.

import type { RGB } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { koggeStone, rca } from '../lib';
import { logicDepth } from '../sim/stats';

export const DIGITS = 31, ARMS = DIGITS - 1, SPLIT = 15, PITCH_DEG = 22, GAP_DEG = 45;
/** A carry arm's angle on the carry axis (degrees): 22 degrees apart, 45 between the 15th and the 16th, which wraps the upper 15 to start 7 degrees early. */
export const armAngle = (a: number): number => a < SPLIT ? PITCH_DEG * a : PITCH_DEG * (SPLIT - 1) + GAP_DEG + PITCH_DEG * (a - SPLIT) - 360;
/** Shifts the earliest arm to time 0. */
export const OFFSET = -armAngle(SPLIT);
export const TURN_MAX = 720;
export const armTime = (a: number, rot: 0 | 1): number => 360 * rot + armAngle(a) + OFFSET;

export interface Event { arm: number; t: number }
/** Every poll of the carry phase in order of time: both rotations of the carry axis. */
export const EVENTS: Event[] = ([0, 1] as const).flatMap((rot) => Array.from({ length: ARMS }, (_, a) => ({ arm: a, t: armTime(a, rot) }))).sort((x, y) => x.t - y.t);

/** Wheel 0 is the units wheel (the machine polls from below). warn[i]: wheel i's latch is armed; chain[i]: carries before it in its domino. */
export interface Column { w: number[]; warn: boolean[]; chain: number[] }
export const zero = (): Column => ({ w: Array(DIGITS).fill(0), warn: Array(DIGITS).fill(false), chain: Array(DIGITS).fill(0) });
const copy = (c: Column): Column => ({ w: c.w.slice(), warn: c.warn.slice(), chain: c.chain.slice() });
export const MOD = 10n ** BigInt(DIGITS);
export function fromValue(v: bigint): Column {
  const c = zero();
  for (let i = 0, x = ((v % MOD) + MOD) % MOD; i < DIGITS; i++, x /= 10n) c.w[i] = Number(x % 10n);
  return c;
}
/** The number the wheels read, plus the overflow the top wheel's latch has flagged (the machine's 32nd digit, not a wheel). */
export const valueOf = (c: Column): bigint => c.w.reduce((s, d, i) => s + BigInt(d) * 10n ** BigInt(i), 0n) + (c.warn[DIGITS - 1] ? MOD : 0n);
/** Latches armed on wheels that have an arm (the top wheel's is the overflow flag). */
export const pending = (c: Column): number => c.warn.slice(0, ARMS).filter(Boolean).length;
const digitsOf = (v: bigint): number[] => fromValue(v).w;

/** Giving-off: every wheel advances by the digit it is given; passing 9 to 0 arms its latch, and nothing carries yet. */
export function giveOff(c: Column, addend: bigint): Column {
  const o = copy(c), d = digitsOf(addend);
  for (let i = 0; i < DIGITS; i++) { const s = o.w[i] + d[i]; o.w[i] = s % 10; o.warn[i] = s > 9; o.chain[i] = 0; }
  return o;
}

/** A carry arm meets lever a: if armed it advances wheel a + 1, whose own latch arms when that wheel passes 9 to 0. */
export function fire(c: Column, a: number): boolean {
  if (!c.warn[a]) return false;
  c.warn[a] = false;
  const j = a + 1;
  c.w[j] = (c.w[j] + 1) % 10;
  if (c.w[j] === 0) { c.warn[j] = true; c.chain[j] = c.chain[a] + 1; }
  return true;
}

/** The carry phase under way: the carry axis at angle theta (0..720), the polls up to it done. */
export interface Carry { col: Column; cursor: number; theta: number; fired: number[]; longest: number; lastT: number }
export const begin = (c: Column): Carry => ({ col: copy(c), cursor: 0, theta: 0, fired: [], longest: 0, lastT: 0 });

/** Turn the carry axis on to theta, polling every arm it passes in the order the helix reaches them. */
export function advanceTo(s: Carry, theta: number): Carry {
  const o: Carry = { ...s, col: copy(s.col), fired: s.fired.slice() };
  while (o.cursor < EVENTS.length && EVENTS[o.cursor].t <= theta) {
    const { arm, t } = EVENTS[o.cursor++];
    const run = o.col.chain[arm] + 1;
    if (fire(o.col, arm)) { o.fired.push(arm); o.longest = Math.max(o.longest, run); o.lastT = t; }
  }
  o.theta = Math.max(theta, o.theta);
  return o;
}
/** The time of the next poll that finds a latch armed, or null when none is left. */
export function nextFiring(s: Carry): number | null {
  for (let k = s.cursor; k < EVENTS.length; k++) if (s.col.warn[EVENTS[k].arm]) return EVENTS[k].t;
  return null;
}
export const finished = (s: Carry): boolean => pending(s.col) === 0;
/** The whole carry phase: both rotations. */
export const sweep = (c: Column): Carry => advanceTo(begin(c), TURN_MAX);

/** The anticipating carriage's effect as Babbage states it: every carry of a run settled in one unit. A wheel receives a carry
 *  if the wheel below it was armed, or stands at 9 and itself receives one: carry-in c(i+1) = warn(i) or (w(i) = 9 and c(i)). */
export function anticipate(c: Column): { col: Column; carryIn: boolean[] } {
  const carryIn: boolean[] = Array(DIGITS + 1).fill(false), o = copy(c);
  for (let i = 0; i < DIGITS; i++) carryIn[i + 1] = c.warn[i] || (c.w[i] === 9 && carryIn[i]);
  for (let i = 0; i < DIGITS; i++) { o.w[i] = (c.w[i] + (carryIn[i] ? 1 : 0)) % 10; o.warn[i] = false; }
  o.warn[DIGITS - 1] = carryIn[DIGITS];
  return { col: o, carryIn: carryIn.slice(0, DIGITS) };
}

/** The column's digits (most significant first) in groups of three counted from the units, so a short group leads: 31 digits are 1 + 10 x 3. */
export function digitGroups(ds: readonly (number | string)[]): string[][] {
  const out: string[][] = [], first = ds.length % 3 || 3;
  for (let i = 0; i < ds.length; i += i === 0 ? first : 3) out.push(ds.slice(i, i + (i === 0 ? first : 3)).map(String));
  return out;
}

/** NAND delays of the site's adders (the library's own, the fast-adder chapter's numbers). */
export const PER_COLUMN = (logicDepth(rca(9)) ?? 0) - (logicDepth(rca(8)) ?? 0);
export const GATE_WIDTHS = [8, 16, 32, 64];
export const gateRows = (): { n: number; ripple: number; ks: number }[] => GATE_WIDTHS.map((n) => ({ n, ripple: logicDepth(rca(n)) ?? 0, ks: logicDepth(koggeStone(n)) ?? 0 }));

// ---------------------------------------------------------------- the drawing

export interface Pose { col: Column; theta: number; /** wheels about to receive a carry, foreseen (anticipating carriage) */ foresee: boolean[] | null }
export interface BabbagePalette { frame: RGB; metal: RGB; wheel: RGB; tick: RGB; lever: RGB; warn: RGB; arm: RGB; live: RGB }

export const PITCH = 3, R = 5.5, TH = 1.8, AXIS_X = -(R + 12), ARM_LEN = 7;
export const wheelY = (i: number): number => i * PITCH;
/** A tick's place on the wheel: digit d at 36 degrees a step from the front. */
export const tickAt = (d: number): [number, number] => { const a = (d * 36 * Math.PI) / 180, r = R - 1.3; return [r * Math.sin(a), r * Math.cos(a)]; };
/** An arm's angle from the contact direction (towards the levers) when the axis stands at theta. */
export const armPhase = (a: number, theta: number): number => armAngle(a) + OFFSET - theta;
export const armTip = (a: number, theta: number): Vec3 => {
  const p = (armPhase(a, theta) * Math.PI) / 180;
  return [AXIS_X + ARM_LEN * Math.cos(p), wheelY(a) + TH / 2, ARM_LEN * Math.sin(p)];
};
export const lit = (c: RGB, k = 0.5): RGB => [c[0] * k, c[1] * k, c[2] * k];

export function babbageParts(p: Pose, P: BabbagePalette): Part[] {
  const out: Part[] = [], top = wheelY(DIGITS - 1) + TH;
  out.push(box(P.frame, AXIS_X - 5, R + 4, -3, -1, -9, 9), box(P.frame, -R - 1.5, R + 1.5, -1, top + 1, -9, -7.4));
  out.push(cyl(P.metal, 0, 0, -1, top + 2, 0.8), cyl(P.metal, AXIS_X, 0, -1, top + 2, 1.1));
  for (let i = 0; i < DIGITS; i++) {
    const y = wheelY(i), armed = p.col.warn[i], recv = p.foresee?.[i] ?? false, [tx, tz] = tickAt(p.col.w[i]);
    out.push({ ...cyl(P.wheel, 0, 0, y, y + TH, R, 0.3), emissive: recv ? lit(P.live, 0.35) : undefined });
    out.push({ ...box(P.tick, tx - 0.8, tx + 0.8, y + TH, y + TH + 0.7, tz - 0.8, tz + 0.8), emissive: recv ? lit(P.live, 0.5) : undefined });
    // The warning lever: out of the arms' path until the wheel passes 9 to 0, then latched into it (a simple block, not the three-limbed lever).
    const pv: Vec3 = [-R - 0.8, y + TH / 2, 0], tip: Vec3 = armed ? [-R - 5, y + TH / 2, 0] : [-R - 2.4, y + TH / 2, 1.2];
    out.push({ ...rod(armed ? P.warn : P.lever, pv, tip, 0.55, 0.2), emissive: armed ? lit(P.warn, 0.7) : undefined });
  }
  for (let a = 0; a < ARMS; a++) {
    const tip = armTip(a, p.theta), ph = ((armPhase(a, p.theta) % 360) + 540) % 360 - 180, on = Math.abs(ph) < 3.5;
    out.push({ ...rod(on ? P.warn : P.arm, [AXIS_X, tip[1], 0], tip, 0.4, 0.1), emissive: on ? lit(P.warn, 0.6) : undefined });
  }
  return out;
}

export function babbageAnchors(p: Pose): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], left: Vec3 = [-1, 0.2, 0.3], up: Vec3 = [0, 1, 0], top = wheelY(DIGITS - 1);
  const armed = p.col.warn.findIndex((x, i) => x && i < ARMS), k = armed >= 0 ? armed : 2;
  return [
    { text: 'figure wheel', p: [R, wheelY(6) + TH, 0], side: 'r', n: front },
    { text: 'units wheel', p: [R, wheelY(0) + TH / 2, 0], side: 'r', n: front, minor: true },
    { text: `warning lever${armed >= 0 ? ' (armed)' : ''}`, p: [-R - 4, wheelY(k) + TH / 2, 0], side: 'l', n: left },
    { text: 'carry axis', p: [AXIS_X, wheelY(18), 0], side: 'l', n: left },
    { text: 'wheel 31 (overflow)', p: [R, top + TH, 0], side: 'r', n: up },
  ];
}
