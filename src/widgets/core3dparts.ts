// A 4 x 4 plane of ferrite cores as parts (DOM-free, tested). Coincident-current selection (Forrester, US 2,736,880): a core
// sees the sum of the currents of the wires through it and flips only when that sum reaches the switching current Ic. One
// X and one Y wire at half the full drive put 2 x half = 0.6 A on the crossing core and 0.3 A on every other core of that
// row or column: below Ic, so those stay. A four-wire plane: X and Y select, a sense wire and an inhibit wire through every
// core (the inhibit parallel to the X wires, the sense parallel to the Y wires, as in the IBM 1401's planes).
//
// Read = drive the addressed core toward 0; a 1 flips and the sense wire pulses, a 0 does not move. The read destroys a 1, so
// the cycle ends with a write phase that puts back what was read; to put back (or write) a 0 the inhibit wire carries half
// the drive the other way, cancelling one half so the crossing core sees 0.3 A and holds.

import type { RGB } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';

export const N = 4;
/** The currents, amperes. Half-select drive and the switching (coercive) current are figures of the model; the 0.4-0.8 A
 *  band of 1950s drive currents is from the literature (see the note in the view), the rectangular loop is the idealisation. */
export const HALF = 0.3, FULL = 2 * HALF, IC = 0.45;

/** Drive pattern: +1 toward writing a 1, -1 toward 0, 0 off, per X wire (row), Y wire (column) and the inhibit wire. */
export interface Drive { x: number[]; y: number[]; inh: number }
export const idle = (): Drive => ({ x: Array(N).fill(0), y: Array(N).fill(0), inh: 0 });
export const idx = (r: number, c: number): number => r * N + c;
export const rowOf = (k: number): number => Math.floor(k / N);
export const colOf = (k: number): number => k % N;

/** Net current through core k, amperes (toward 1 is positive). */
export const netOf = (d: Drive, k: number): number => HALF * (d.x[rowOf(k)] + d.y[colOf(k)] + d.inh);

/** The idealised square loop: a core goes to 1 at +Ic or more, to 0 at -Ic or less, and otherwise stays where it was. */
export function respond(bit: number, net: number): number {
  return net >= IC - 1e-12 ? 1 : net <= -IC + 1e-12 ? 0 : bit;
}

export function applyDrive(bits: readonly number[], d: Drive): { after: number[]; flipped: number[]; net: number[] } {
  const net = bits.map((_, k) => netOf(d, k)), after = bits.map((b, k) => respond(b, net[k]));
  return { after, net, flipped: bits.flatMap((b, k) => (after[k] !== b ? [k] : [])) };
}

export type Op = 'read' | 'write0' | 'write1';
export interface Phase {
  name: 'read' | 'clear' | 'restore' | 'write';
  title: string;
  drive: Drive;
  net: number[];
  before: number[];
  after: number[];
  /** Cores that changed state in this phase. */
  flipped: number[];
  /** The sense wire is looked at (read phase only); in the others it also sees the flip but nobody listens. */
  strobed: boolean;
  /** A pulse on the sense wire: the addressed core flipped. Only a 1 turning to 0 (or back) induces it. */
  pulse: boolean;
  /** The bit the sense amplifier reports (read phase only; else null). */
  senseBit: number | null;
}

/** The two phases of a cycle at `addr`. Read: drive to 0, then rewrite what came out. Write v: clear, then write v. */
export function planOp(bits: readonly number[], addr: number, op: Op): Phase[] {
  const r = rowOf(addr), c = colOf(addr), phases: Phase[] = [];
  const first = idle(); first.x[r] = -1; first.y[c] = -1;
  const a = applyDrive(bits, first);
  const reading = op === 'read';
  phases.push({
    name: reading ? 'read' : 'clear', title: reading ? 'Read: drive the core toward 0' : 'Clear: drive the core toward 0 first',
    drive: first, net: a.net, before: [...bits], after: a.after, flipped: a.flipped, strobed: reading, pulse: a.flipped.length > 0,
    senseBit: reading ? (bits[addr] ? 1 : 0) : null,
  });
  const v = reading ? bits[addr] : op === 'write1' ? 1 : 0;
  const second = idle(); second.x[r] = 1; second.y[c] = 1; second.inh = v ? 0 : -1;
  const b = applyDrive(a.after, second);
  phases.push({
    name: reading ? 'restore' : 'write', title: reading ? `Restore: write back the ${v} that was read` : `Write ${v}`,
    drive: second, net: b.net, before: [...a.after], after: b.after, flipped: b.flipped, strobed: false, pulse: b.flipped.length > 0, senseBit: null,
  });
  return phases;
}

/** Cores on the addressed row or column, not the crossing: those that see exactly half. */
export const halfSelected = (addr: number): number[] =>
  Array.from({ length: N * N }, (_, k) => k).filter((k) => k !== addr && (rowOf(k) === rowOf(addr) || colOf(k) === colOf(addr)));

// ---------------------------------------------------------------- dimensions

/** 1 unit = 5 mil (0.127 mm). A Lincoln Laboratory / Whirlwind-era core: 80 mil outside, 50 mil inside, 20 mil high.
 *  The pitch and the wire gauge are assumptions (a plane's cores were tilted and close together). */
export const UNIT_MIL = 5;
export const OD = 80 / UNIT_MIL, ID = 50 / UNIT_MIL, HEIGHT = 20 / UNIT_MIL;
export const PITCH_MIL = 120, PITCH = PITCH_MIL / UNIT_MIL;
export const WIRE_R = 0.5; // a ~5 mil (about 36 AWG) enamelled wire
/** The tube of the ring is drawn round, of the mean of its width (15 mil) and height (20 mil). */
export const TUBE_R = 1.75;
const RING_SIDES = 14;
const A: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2]; // the ring's axis: tilted 45 degrees so both the X and the Y wire pass through the hole
const E1: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2], E2: Vec3 = [0, 1, 0];
export const RING_R = (OD + ID) / 4;

export const colX = (c: number): number => (c - (N - 1) / 2) * PITCH;
export const rowZ = (r: number): number => (r - (N - 1) / 2) * PITCH;
/** The cores hang at this height above the board, held by their wires. */
export const CY = 9.5;
export const centreOf = (k: number): Vec3 => [colX(colOf(k)), CY, rowZ(rowOf(k))];

/** Wire offsets from a core's centre (units), distinct so four wires fit the hole: x y sense inhibit. */
const OFF = { x: [0, 1.1, 0.8] as Vec3, y: [0.8, 1.1, 0] as Vec3, ys: [-0.8, -1.1, 0] as Vec3, xi: [0, -1.1, -0.8] as Vec3 };
const EDGE = 52, BRIDGE = 58, DRIVER = 66, INH_X = 74;

export interface CorePose {
  bits: readonly number[];
  drive: Drive;
  /** How far the current's marker has travelled along its wire, 0..1. */
  u: number;
  /** Cores flipping right now (drawn bright). */
  flipping: readonly number[];
  addr: number | null;
  /** The sense amplifier's lamp. */
  sense: boolean;
}
export interface CorePalette {
  ferrite: RGB; frame: RGB; metal: RGB; wx: RGB; wy: RGB; ws: RGB; wi: RGB; live: RGB; one: RGB; zero: RGB; lamp: RGB; lampOff: RGB; sel: RGB;
}
const lit = (c: RGB, k = 0.55): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** A point on a core's ring (or its face circle) at angle t, `lift` along the axis. */
export function ringPoint(k: number, t: number, radius: number, lift = 0): Vec3 {
  const c = centreOf(k), ct = Math.cos(t) * radius, st = Math.sin(t) * radius;
  return [c[0] + E1[0] * ct + E2[0] * st + A[0] * lift, c[1] + E1[1] * ct + E2[1] * st + A[1] * lift, c[2] + E1[2] * ct + E2[2] * st + A[2] * lift];
}
/** The magnetisation arrow's head angle: a 1 circulates counterclockwise seen from +axis, a 0 clockwise. */
export const HEAD_T = Math.PI / 2;

/** Where each wire runs (the polylines); the inhibit and sense wires snake through every core. */
export function wirePaths(): { x: Vec3[][]; y: Vec3[][]; sense: Vec3[]; inhibit: Vec3[] } {
  const x: Vec3[][] = [], y: Vec3[][] = [];
  for (let r = 0; r < N; r++) x.push([[-DRIVER + 4, (CY + OFF.x[1]), rowZ(r) + OFF.x[2]], [DRIVER - 4, (CY + OFF.x[1]), rowZ(r) + OFF.x[2]]]);
  for (let c = 0; c < N; c++) y.push([[colX(c) + OFF.y[0], (CY + OFF.y[1]), -DRIVER + 4], [colX(c) + OFF.y[0], (CY + OFF.y[1]), DRIVER - 4]]);
  const sense: Vec3[] = [], inhibit: Vec3[] = [];
  for (let c = 0; c < N; c++) {
    const down = c % 2 === 0, xs = colX(c) + OFF.ys[0], z0 = down ? -BRIDGE : BRIDGE, z1 = -z0;
    sense.push([xs, (CY + OFF.ys[1]), z0], [xs, (CY + OFF.ys[1]), z1]);
  }
  // The inhibit wire runs the same way (+x) through every core, so its current opposes the select currents in all sixteen; its
  // returns between rows pass under the board, outside the cores.
  for (let r = 0; r < N; r++) {
    const zi = rowZ(r) + OFF.xi[2], yi = CY + OFF.xi[1];
    inhibit.push([-INH_X, yi, zi], [INH_X, yi, zi]);
    if (r + 1 < N) inhibit.push([INH_X, -9, zi], [-INH_X, -9, rowZ(r + 1) + OFF.xi[2]]);
  }
  return { x, y, sense, inhibit };
}
/** The straight runs through the cores, as (start, end): the sense wire's alternate by column, the inhibit's all point +x. */
export function runsOf(): { sense: [Vec3, Vec3][]; inhibit: [Vec3, Vec3][] } {
  const W = wirePaths();
  return { sense: Array.from({ length: N }, (_, c) => [W.sense[2 * c], W.sense[2 * c + 1]] as [Vec3, Vec3]), inhibit: Array.from({ length: N }, (_, r) => [W.inhibit[4 * r], W.inhibit[4 * r + 1]] as [Vec3, Vec3]) };
}

export const SENSE_AMP: Vec3 = [colX(N - 1) + 12, 0, BRIDGE + 6];

export function coreParts(p: CorePose, P: CorePalette): Part[] {
  const out: Part[] = [], W = wirePaths();
  // The frame: an epoxy-glass board with a rail round the plane, the terminal blocks on two sides.
  out.push(box(P.frame, -DRIVER - 6, DRIVER + 6, -6, -4, -DRIVER - 6, DRIVER + 6));
  for (const s of [-1, 1]) out.push(box(P.frame, s * EDGE - 1.5, s * EDGE + 1.5, -4, CY + 3, -EDGE - 3, EDGE + 3), box(P.frame, -EDGE - 3, EDGE + 3, -4, CY + 3, s * EDGE - 1.5, s * EDGE + 1.5));
  // Drivers (X on the left, Y at the back, lit when their wire carries current).
  const wireLive = (a: number) => a !== 0;
  for (let r = 0; r < N; r++) {
    const on = wireLive(p.drive.x[r]);
    out.push({ ...box(on ? P.live : P.metal, -DRIVER - 2, -DRIVER + 4, CY - 4, CY + 4, rowZ(r), rowZ(r) + 3), emissive: on ? lit(P.live) : undefined });
  }
  for (let c = 0; c < N; c++) {
    const on = wireLive(p.drive.y[c]);
    out.push({ ...box(on ? P.live : P.metal, colX(c) - 3, colX(c) + 3, CY - 4, CY + 4, -DRIVER - 2, -DRIVER + 4), emissive: on ? lit(P.live) : undefined });
  }
  // Wires. A wire carrying current is drawn in the live colour and thicker; the marker runs along it in the current's direction.
  const run = (pts: Vec3[], base: RGB, on: boolean, r = WIRE_R) => {
    for (let i = 1; i < pts.length; i++) {
      const part = rod(on ? P.live : base, pts[i - 1], pts[i], on ? r * 1.5 : r, 0.2);
      if (on) part.emissive = lit(P.live, 0.5);
      out.push(part);
    }
  };
  const marker = (a: Vec3, b: Vec3, dir: number) => {
    const t = dir > 0 ? p.u : 1 - p.u, q: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + 1.2, a[2] + (b[2] - a[2]) * t];
    out.push({ ...cyl(P.lamp, q[0], q[2], q[1] - 1, q[1] + 1, 1.4, 0.5), emissive: lit(P.lamp, 0.8) });
  };
  W.x.forEach((w, r) => { run(w, P.wx, p.drive.x[r] !== 0); if (p.drive.x[r]) marker(w[0], w[1], p.drive.x[r]); });
  W.y.forEach((w, c) => { run(w, P.wy, p.drive.y[c] !== 0); if (p.drive.y[c]) marker(w[0], w[1], p.drive.y[c]); });
  // The snaking wires, through every core with their bridges outside the board.
  run(W.sense, P.ws, p.sense);
  run(W.inhibit, P.wi, p.drive.inh !== 0);
  // The cores: a dark ferrite ring, tilted; around it the magnetisation as a circulating arrow (gap at the tail, a bead at the head).
  for (let k = 0; k < N * N; k++) {
    const flipping = p.flipping.includes(k), ring = flipping ? mix(P.ferrite, P.live, 0.45) : P.ferrite;
    for (let i = 0; i < RING_SIDES; i++) {
      const a0 = (i / RING_SIDES) * 2 * Math.PI, a1 = ((i + 1) / RING_SIDES) * 2 * Math.PI;
      const seg = rod(ring, ringPoint(k, a0, RING_R), ringPoint(k, a1, RING_R), TUBE_R, 0.35);
      if (flipping) seg.emissive = lit(P.live, 0.35);
      out.push(seg);
    }
    const bit = p.bits[k] ? 1 : 0, col = bit ? P.one : P.zero, face = TUBE_R + 0.5, dir = bit ? 1 : -1, SEG = 10, span = 1.5 * Math.PI;
    const start = HEAD_T - dir * span; // the tail; the head at HEAD_T
    for (let i = 0; i < SEG; i++) {
      const a0 = start + dir * (span * i) / SEG, a1 = start + dir * (span * (i + 1)) / SEG;
      const s = rod(col, ringPoint(k, a0, RING_R, face), ringPoint(k, a1, RING_R, face), 0.4);
      s.emissive = lit(col, 0.35);
      out.push(s);
    }
    const head = ringPoint(k, HEAD_T, RING_R, face);
    out.push({ ...cyl(col, head[0], head[2], head[1] - 0.9, head[1] + 0.9, 1.1), emissive: lit(col, 0.45) });
    if (p.addr === k) out.push({ ...cyl(P.sel, centreOf(k)[0], centreOf(k)[2], -4, -3.5, 10), emissive: lit(P.sel, 0.5) });
  }
  // Sense amplifier: a lamp that lights when the strobed sense wire carries a pulse.
  out.push(box(P.metal, SENSE_AMP[0] - 5, SENSE_AMP[0] + 5, -2, 3, SENSE_AMP[2] - 3, SENSE_AMP[2] + 3),
    { ...box(p.sense ? P.live : P.lampOff, SENSE_AMP[0] - 2, SENSE_AMP[0] + 2, 3, 5, SENSE_AMP[2] - 1.5, SENSE_AMP[2] + 1.5), emissive: p.sense ? lit(P.live, 0.8) : undefined });
  return out;
}

export function coreAnchors(): Anchor[] {
  const up: Vec3 = [0, 1, 0];
  return [
    { text: 'X select wire', p: [-DRIVER + 1, CY + 4, rowZ(0) + 1.5], side: 'l', n: up },
    { text: 'Y select wire', p: [colX(0), CY + 4, -DRIVER + 1], side: 't', n: up },
    { text: 'ferrite core', p: ringPoint(idx(1, 2), Math.PI * 0.85, RING_R + TUBE_R), side: 'r', n: up },
    { text: 'sense wire', p: [colX(0) + OFF.ys[0], (CY + OFF.ys[1]), BRIDGE], side: 'b', n: up },
    { text: 'inhibit wire', p: [DRIVER - 6, (CY + OFF.xi[1]), rowZ(1)], side: 'l', n: up },
    { text: 'sense amplifier', p: [SENSE_AMP[0], 5, SENSE_AMP[2]], side: 'r', n: up },
  ];
}
