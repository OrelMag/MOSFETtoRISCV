// A real package opened up, on the studio renderer (DOM-free, tested): a 74HC595 in its SOIC-16 (Nexperia's SO16,
// SOT109-1 = JEDEC MS-012), true to scale in millimetres, y up, the board's top at y = 0. Outside: the moulded body, the
// sixteen gull-wing leads on 1.27 mm, the land pattern and its solder. Inside, cut open: the die on its attach on a
// downset paddle, the lead frame's fingers, and a 25 µm gold wire from each pad to its finger, drawn at its real
// thickness. Which pin is which is the 74HC595's: eight outputs latched together on one edge (STCP), ground on pin 8 and
// VCC on pin 16, the corners, whose wires are the longest in the package.
//
// The physics is phys/line.ts's groundBounce on a pad's current (line.ts padSwing), as on chapter wire's noise panel:
// L · n · di/dt through the rail's wires. Each wire's inductance is Grover's straight-wire formula on the length drawn
// here, so the drawing is the number; several wires on one rail lead are taken in parallel (1 / Σ 1/Lᵢ), which ignores
// their mutual inductance (a real set keeps more) and the lead's own share.
//
// Sourced: the outline (SOT109-1 table). Not sourced, and said so on every such part: the die's size, the paddle, the
// fingers' fan-out and the loop heights (no maker publishes a 74HC595's frame); the default ground wire is fitted to
// 2.8 mm, the length the chapter quotes.

import { extrude, lathe, roundedBox, sphere, sweep, tube, type Geo } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import { onPlane, strokeGeo } from '../gl/kit/text';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Vec3 } from '../gl/math';
import { groundBounce, VIH, VIL, VIO } from '../phys/line';
import { padSwing } from './line';

// ---------------------------------------------------------------- the outline (mm), SOT109-1

/** Nexperia / NXP SOT109-1 (SO16, JEDEC MS-012), min and max from its table; the drawing uses the middle. */
export const SOT109 = {
  D: [9.8, 10.0], E: [3.8, 4.0], HE: [5.8, 6.2], e: 1.27, A: 1.75, A1: [0.10, 0.25], A2: [1.25, 1.45],
  bp: [0.36, 0.49], c: [0.19, 0.25], Lp: [0.4, 1.0], theta: [0, 8],
} as const;
const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
export const PITCH = SOT109.e, BODY_D = mid(SOT109.D), BODY_E = mid(SOT109.E), SPAN = mid(SOT109.HE);
export const STANDOFF = mid(SOT109.A1), BODY_H = mid(SOT109.A2), LEAD_W = mid(SOT109.bp), LEAD_T = mid(SOT109.c), FOOT = mid(SOT109.Lp);
export const BODY_TOP = STANDOFF + BODY_H;

const SRC = {
  outline: 'Nexperia / NXP SOT109-1 (SO16, JEDEC MS-012) outline table',
  pins: 'Nexperia 74HC595 data sheet, pin description (SO16)',
  inside: 'illustrative: no maker publishes a 74HC595\'s die or lead frame; sizes typical of an SOIC',
  wire: '25 µm gold, the chapter\'s wire; Grover\'s formula on the length drawn',
};

// ---------------------------------------------------------------- inside (mm), illustrative

/** The lead frame's plane (bottom), the die and its paddle. The paddle is set down so the die's top sits just above the fingers. */
const FRAME_Y = STANDOFF + 0.5, FRAME_TOP = FRAME_Y + LEAD_T;
export const DIE_X = 1.0, DIE_Z = 0.75, DIE_T = 0.25, ATTACH_T = 0.02;
export const DIE_TOP = FRAME_TOP + 0.05, PADDLE_TOP = DIE_TOP - DIE_T - ATTACH_T;
const PADDLE_X = 1.2, PADDLE_Z = 0.95;
/** Aluminium pads on the die, the wire, its ball and loop. */
const PAD = 0.09, PAD_T = 0.01;
export const WIRE_R = 0.0125;
const BALL_R = 0.03, FINGER_W = 0.3;
/** Where the mould is cut open: just under the paddle's top, so the paddle shows as a rim and the fingers lie on the floor. */
const CUT_Y = PADDLE_TOP - 0.015;
/** The length the chapter quotes for a ground wire (3 nH): the corner fingers' tips are placed so pin 8's wire has it. */
export const LEN_RAIL = 2.8;

// ---------------------------------------------------------------- the pins: the 74HC595's

export type Kind = 'out' | 'gnd' | 'vcc' | 'in' | 'ser';
export const PIN_NAMES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND', 'Q7S', 'MR', 'SHCP', 'STCP', 'OE', 'DS', 'Q0', 'VCC'] as const;
export const kindOf = (k: number): Kind => {
  const n = PIN_NAMES[k - 1];
  return n === 'GND' ? 'gnd' : n === 'VCC' ? 'vcc' : n === 'Q7S' ? 'ser' : /^Q\d$/.test(n) ? 'out' : 'in';
};
/** The parallel outputs in the order the slider lights them: Q0 … Q7. */
export const OUTPUT_PINS = [15, 1, 2, 3, 4, 5, 6, 7];
export const GND_PIN = 8, VCC_PIN = 16;
export const OUTPUTS = OUTPUT_PINS.length, MAX_BONDS = 3;

/** Pin k's side (+1: pins 1-8, nearest the viewer; −1: 9-16) and its place along the body (0 … 7, by x). */
export const sideOf = (k: number): 1 | -1 => (k <= 8 ? 1 : -1);
const slotOf = (k: number) => (k <= 8 ? k - 1 : 16 - k);
export const pinX = (k: number): number => (slotOf(k) - 3.5) * PITCH;
const corner = (k: number) => slotOf(k) === 0 || slotOf(k) === 7;

// ---------------------------------------------------------------- the state and the physics

export type Edge = 'fall' | 'rise';
export interface PkState {
  /** outputs switching together (1 … 8) */
  n: number;
  /** bond wires on the active rail's lead (1 … 3): pin 8 or pin 16 carries that many */
  g: number;
  /** edge time, ns */
  rise: number;
  edge?: Edge;
}

/** A straight round wire (Grover, "Inductance Calculations", Rosa's form): L = 0.2·l·[ln(2l/r) − 0.75] nH, l and r in mm. */
export const bondL = (lMm: number, rMm = WIRE_R): number => 0.2 * lMm * (Math.log((2 * lMm) / rMm) - 0.75);

const polyLen = (p: readonly Vec3[]): number => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);

/** Pad j on the die for pin k (j > 0: the extra wires of a rail). The corners' pads sit on the die's end. */
function padAt(k: number, j: number): Vec3 {
  const s = sideOf(k), x = pinX(k);
  if (corner(k)) return [Math.sign(x) * (DIE_X - 0.08), DIE_TOP + PAD_T, s * (0.55 - 0.16 * j)];
  return [x * 0.19, DIE_TOP + PAD_T, s * (DIE_Z - 0.08)];
}

/** The loop: a ball, a straight rise (the kink), the apex a third of the way, then down onto the finger: a Catmull-Rom
 *  through those points, sampled, so the tube drawn is exactly this polyline and its length is the length used. */
function loopPath(a: Vec3, b: Vec3, steps: number): Vec3[] {
  const chord = Math.hypot(b[0] - a[0], b[2] - a[2]), rise = 0.12 + 0.04 * chord;
  const lerp = (t: number, y: number): Vec3 => [a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t];
  const ctl: Vec3[] = [[a[0], a[1] + 0.01, a[2]], [a[0], a[1] + rise * 0.7, a[2]], lerp(0.3, a[1] + rise), lerp(0.7, (a[1] + rise + b[1]) / 2 + 0.03), b];
  const ext = [ctl[0], ...ctl, ctl[ctl.length - 1]], out: Vec3[] = [];
  for (let s = 1; s < ext.length - 2; s++) {
    const [p0, p1, p2, p3] = [ext[s - 1], ext[s], ext[s + 1], ext[s + 2]];
    for (let i = 0; i < steps; i++) {
      const t = i / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)) as Vec3);
    }
  }
  out.push(b);
  return out;
}

/** A finger's centreline in x, z: in from the body's edge, then to its tip beside the paddle. */
function fingerLine(k: number, tipX: number): [number, number][] {
  const s = sideOf(k), x = pinX(k);
  const tip: [number, number] = corner(k) ? [Math.sign(x) * tipX, s * 1.0] : [x * 0.5, s * 1.18];
  return [[x, s * (BODY_E / 2)], [x, s * 1.6], tip];
}

/** Where wire j of pin k lands: on its finger's top, the extras stepped back along it. */
function stitchAt(k: number, j: number, tipX: number): Vec3 {
  const f = fingerLine(k, tipX), [tx, tz] = f[2], [px, pz] = f[1], l = Math.hypot(px - tx, pz - tz);
  const back = corner(k) ? 0.08 + 0.22 * (MAX_BONDS - 1 - j) : 0.08 + 0.13 * j; // the extras nearer the tip, beside their pads: no crossing
  return [tx + ((px - tx) * back) / l, FRAME_TOP, tz + ((pz - tz) * back) / l];
}

/** The corner fingers' tip, solved so that pin 8's wire is LEN_RAIL long (the default ground wire). */
export const CORNER_TIP = ((): number => {
  let lo = 1.6, hi = 4.2;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2, len = polyLen(loopPath(padAt(GND_PIN, 0), stitchAt(GND_PIN, 0, m), 12));
    if (len < LEN_RAIL) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
})();

export interface Bond { pin: number; j: number; kind: Kind; pts: Vec3[]; len: number; nH: number; lit: boolean }

/** Every wire at a state: one per pin, plus the rail leads' extra wires. */
export function bonds(st: PkState, steps = 12): Bond[] {
  const out: Bond[] = [], lit = new Set(OUTPUT_PINS.slice(0, st.n)), active = st.edge === 'rise' ? VCC_PIN : GND_PIN;
  for (let k = 1; k <= 16; k++) {
    const kind = kindOf(k), count = k === GND_PIN || k === VCC_PIN ? st.g : 1;
    for (let j = 0; j < count; j++) {
      const pts = loopPath(padAt(k, j), stitchAt(k, j, CORNER_TIP), steps), len = polyLen(pts);
      out.push({ pin: k, j, kind, pts, len, nH: bondL(len), lit: kind === 'out' ? lit.has(k) : k === active && st.n > 0 });
    }
  }
  return out;
}

/** The active rail's inductance: its wires in parallel, no mutual inductance. */
export function railL(st: PkState): number {
  const pin = st.edge === 'rise' ? VCC_PIN : GND_PIN;
  return 1 / bonds(st).filter((b) => b.pin === pin).reduce((s, b) => s + 1 / b.nH, 0);
}

/** Bounce (V): L · n · di/dt through the active rail's wires; on a rising edge the same formula gives the supply's droop. */
export const bounceOf = (st: PkState): number => groundBounce(st.n, padSwing(), st.rise, railL(st));

/** What line.ts's panel says of a bounce (VIL = 0.35, VIH = 0.65 of VDD; VDD − VIH = VIL, so a droop reads the same). */
export type Verdict = 'ok' | 'undefined' | 'high' | 'invalid';
export const verdictOf = (v: number): Verdict => (v >= VIO ? 'invalid' : v >= VIH ? 'high' : v >= VIL ? 'undefined' : 'ok');

// ---------------------------------------------------------------- geometry, built once per detail

type Detail = 'full' | 'flat';
interface Geos {
  board: Geo; land: Geo; solder: Geo; mouldLo: Geo; mouldHi: Geo; mark: Geo; dot: Geo;
  lead: [Geo, Geo]; finger: (k: number) => Geo; paddle: Geo; tie: [Geo, Geo];
  die: Geo; attach: Geo; passivation: Geo; pad: Geo; ball: Geo; stitch: Geo; wire: (b: Bond) => Geo;
}
const memo = new Map<Detail, Geos>();

/** A band of width w round an open polyline in x, z, mitred (a flat finger). */
function band(line: [number, number][], w: number): [number, number][] {
  const L: [number, number][] = [], R: [number, number][] = [];
  line.forEach((p, k) => {
    const a = line[Math.max(0, k - 1)], c = line[Math.min(line.length - 1, k + 1)];
    const d0 = k > 0 ? norm([p[0] - a[0], p[1] - a[1]]) : null, d1 = k < line.length - 1 ? norm([c[0] - p[0], c[1] - p[1]]) : null;
    const d = norm([(d0?.[0] ?? 0) + (d1?.[0] ?? 0), (d0?.[1] ?? 0) + (d1?.[1] ?? 0)]), n: [number, number] = [-d[1], d[0]];
    const m = d0 && d1 ? 1 / Math.max(0.4, -d0[1] * n[0] + d0[0] * n[1]) : 1;
    L.push([p[0] + (n[0] * w * m) / 2, p[1] + (n[1] * w * m) / 2]); R.push([p[0] - (n[0] * w * m) / 2, p[1] - (n[1] * w * m) / 2]);
  });
  return [...L, ...R.reverse()];
}
const norm = (v: [number, number]): [number, number] => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/** The gull wing outside the body: out of the moulding at the frame's height, down at a bend, flat on its foot. */
function leadPath(s: 1 | -1): Vec3[] {
  const yc = FRAME_Y + LEAD_T / 2, yf = 0.03 + LEAD_T / 2, z0 = BODY_E / 2, zEnd = SPAN / 2, zFoot = zEnd - FOOT;
  return [[0, yc, s * z0], [0, yc, s * (z0 + 0.25)], [0, yf, s * (zFoot - 0.02)], [0, yf, s * zEnd]];
}

function geos(d: Detail): Geos {
  const hit = memo.get(d);
  if (hit) return hit;
  const full = d === 'full', box = (w: number, h: number, dd: number, r: number) => roundedBox(w, h, dd, r, full ? 3 : 1);
  const rect: [number, number][] = [[-LEAD_T / 2, -LEAD_W / 2], [LEAD_T / 2, -LEAD_W / 2], [LEAD_T / 2, LEAD_W / 2], [-LEAD_T / 2, LEAD_W / 2]];
  const tieRect: [number, number][] = [[-LEAD_T / 2, -0.15], [LEAD_T / 2, -0.15], [LEAD_T / 2, 0.15], [-LEAD_T / 2, 0.15]];
  const tie = (sx: number): Geo => sweep([[sx * (PADDLE_X - 0.1), PADDLE_TOP - LEAD_T / 2, 0], [sx * 1.6, PADDLE_TOP - LEAD_T / 2, 0], [sx * 2.0, FRAME_Y + LEAD_T / 2, 0], [sx * (BODY_D / 2 - 0.05), FRAME_Y + LEAD_T / 2, 0]], tieRect, { bend: full ? 0.12 : 0 });
  const fingers = new Map<number, Geo>(), wires = new Map<string, Geo>();
  const g: Geos = {
    board: box(BODY_D + 2.4, 0.8, SPAN + 2.6, 0.05),
    // IPC-style land for SO16 on 1.27 mm: 0.6 × 1.55 mm (typical; the drawing's own land pattern is the maker's)
    land: box(0.6, 0.035, 1.55, 0.01), solder: box(0.52, 0.05, 1.2, 0.02),
    // the moulding in two halves, below and above the lead frame (how it is moulded: the frame clamped between them)
    mouldLo: box(BODY_D, FRAME_Y - STANDOFF, BODY_E, 0.04), mouldHi: box(BODY_D, BODY_TOP - FRAME_Y, BODY_E, 0.08),
    mark: strokeGeo('74HC595D', onPlane([0, BODY_TOP, 0], [1, 0, 0], [0, 0, -1], [0, 1, 0]), 0, 0.1, 0.62, 0.07, 0.002, { flat: true }),
    dot: lathe([[0, 0], [0.32, 0], [0.32, 0.004], [0, 0.004]], { seg: full ? 32 : 10 }),
    lead: [sweep(leadPath(1), rect, { bend: full ? 0.18 : 0 }), sweep(leadPath(-1), rect, { bend: full ? 0.18 : 0 })],
    finger: (k) => { let v = fingers.get(k); if (!v) { v = extrude(band(fingerLine(k, CORNER_TIP), FINGER_W), LEAD_T); fingers.set(k, v); } return v; },
    paddle: box(2 * PADDLE_X, LEAD_T, 2 * PADDLE_Z, 0.03), tie: [tie(-1), tie(1)],
    die: box(2 * DIE_X, DIE_T, 2 * DIE_Z, 0.01), attach: box(2 * DIE_X + 0.06, ATTACH_T, 2 * DIE_Z + 0.06, 0.01),
    passivation: box(2 * DIE_X - 0.36, 0.004, 2 * DIE_Z - 0.36, 0.002), pad: box(PAD, PAD_T, PAD, 0.003),
    ball: sphere(BALL_R, full ? 14 : 6, full ? 8 : 4), stitch: box(0.075, 0.012, 0.05, 0.004),
    wire: (b) => {
      const key = `${b.pin}.${b.j}`;
      let v = wires.get(key);
      if (!v) { v = tube(b.pts, WIRE_R, { sides: full ? 6 : 3 }); wires.set(key, v); }
      return v;
    },
  };
  memo.set(d, g);
  return g;
}

// ---------------------------------------------------------------- the model at a state

const f2 = (v: number) => v.toFixed(2);
export const pinLabel = (k: number) => `pin ${k}: ${PIN_NAMES[k - 1]}`;
const ROLE: Record<Kind, string> = { out: 'output, latched by STCP', gnd: 'ground', vcc: 'supply (VCC)', in: 'input', ser: 'serial output (for the next chip)' };

export interface PkLook { detail: Detail }

export function packageModel(st: PkState, look: PkLook = { detail: 'full' }): Model3 {
  const G = geos(look.detail), items: Item[] = [], v = bounceOf(st), hot = Math.min(1, v / VIL);
  const frameMetal = M.tint(M.copper, [0.86, 0.74, 0.62], 'copper alloy, silver-plated where bonded');
  const lit = M.glow(M.gold, '--pk-lit', 0.9), railLit = M.glow(M.gold, '--pk-bad', 0.35 + 0.65 * hot);
  const none = { cut: 'none' as const };

  // The board: FR-4 under solder mask, sixteen copper lands with solder.
  items.push({ geo: G.board, mat: M.fr4, at: [0, -0.4, 0], name: 'circuit board', group: 'board', explode: [0, -1.6, 0], ...none, info: { note: 'FR-4 under solder mask; the copper lands carry the solder joints' } });
  for (let k = 1; k <= 16; k++) {
    const x = pinX(k), z = sideOf(k) * (SPAN / 2 - FOOT / 2);
    items.push({ geo: G.land, mat: M.copper, at: [x, 0.0175, z], name: 'land', group: 'board', explode: [0, -1.6, 0], ...none, info: { dim: '0.6 × 1.55 mm', source: 'typical SO16 land on 1.27 mm (IPC-7351 style), not the maker\'s' } });
    items.push({ geo: G.solder, mat: M.solder, at: [x, 0.045, z], name: 'solder joint', group: 'board', explode: [0, -1.6, 0], ...none, info: { note: 'tin alloy wetting the foot to its land' } });
  }
  // The moulding: two halves of filled epoxy, the type printed by laser on top, the pin-1 mark.
  const mouldInfo = { dim: `${f2(BODY_D)} × ${f2(BODY_E)} × ${f2(BODY_H)} mm (D × E × A2)`, source: SRC.outline, note: 'epoxy filled with silica, moulded round the frame and the wires' };
  items.push({ geo: G.mouldLo, mat: M.epoxy, at: [0, (STANDOFF + FRAME_Y) / 2, 0], name: 'mould compound', group: 'mould', explode: [0, -0.9, 0], info: mouldInfo });
  items.push({ geo: G.mouldHi, mat: M.epoxy, at: [0, (FRAME_Y + BODY_TOP) / 2, 0], name: 'mould compound', group: 'mould', explode: [0, 2.4, 0], info: mouldInfo });
  items.push({ geo: G.mark, mat: M.make({ base: [0.62, 0.62, 0.6], metal: 0, rough: 0.9, label: 'laser marking' }), name: 'type number', group: 'mould', explode: [0, 2.4, 0], shadow: false, info: { note: 'the part number, marked by laser; the D says SO16' } });
  items.push({ geo: G.dot, mat: M.make({ base: [0.05, 0.05, 0.055], metal: 0, rough: 0.95, label: 'a dimple in the moulding' }), at: [-BODY_D / 2 + 0.7, BODY_TOP + 0.001, BODY_E / 2 - 0.65], name: 'pin 1 mark', group: 'mould', explode: [0, 2.4, 0], shadow: false, info: { note: 'pin 1 is beside it; the rest count anticlockwise seen from above' } });

  // The lead frame: sixteen leads (each a finger inside and a gull wing outside), the paddle on its tie bars.
  for (let k = 1; k <= 16; k++) {
    const s = sideOf(k), x = pinX(k), name = pinLabel(k), kind = kindOf(k);
    const info = { dim: `${f2(LEAD_W)} × ${f2(LEAD_T)} mm lead, ${f2(PITCH)} mm pitch`, source: `${SRC.outline}; ${SRC.pins}`, note: ROLE[kind] };
    items.push({ geo: G.lead[s > 0 ? 0 : 1], mat: frameMetal, at: [x, 0, 0], name, group: 'leads', ...none, info });
    items.push({ geo: G.finger(k), mat: frameMetal, at: [0, FRAME_Y, 0], name, group: 'frame', ...none, info: { ...info, source: `${SRC.inside} (the finger's path)` } });
  }
  items.push({ geo: G.paddle, mat: frameMetal, at: [0, PADDLE_TOP - LEAD_T / 2, 0], name: 'die paddle', group: 'frame', ...none, info: { dim: `${2 * PADDLE_X} × ${2 * PADDLE_Z} mm, set down ${f2(FRAME_TOP - PADDLE_TOP)} mm`, source: SRC.inside, note: 'part of the lead frame, held by two tie bars until the moulding holds it' } });
  for (const t of G.tie) items.push({ geo: t, mat: frameMetal, name: 'die paddle', group: 'frame', ...none });

  // The die on its attach: pads round the edge, a passivated circuit area.
  items.push({ geo: G.attach, mat: M.silverEpoxy, at: [0, PADDLE_TOP + ATTACH_T / 2, 0], name: 'die attach', group: 'die', ...none, info: { dim: '20 µm film', source: SRC.inside, note: 'silver-filled epoxy: glues the die down and carries its heat into the paddle' } });
  items.push({ geo: G.die, mat: M.silicon, at: [0, DIE_TOP - DIE_T / 2, 0], name: 'die', group: 'die', ...none, info: { dim: `${2 * DIE_X} × ${2 * DIE_Z} × ${DIE_T} mm`, source: SRC.inside, note: 'the silicon: shift register, latch and eight output drivers' } });
  items.push({ geo: G.passivation, mat: M.make({ base: [0.3, 0.36, 0.48], metal: 0.3, rough: 0.18, coat: 0.5, label: 'passivation over the circuit (illustrative colour)' }), at: [0, DIE_TOP + 0.002, 0], name: 'die', group: 'die', ...none });
  // The wires: true thickness, each lit when its output switches; the active rail's wires carry the sum and warm towards red.
  for (const b of bonds(st, look.detail === 'full' ? 12 : 5)) {
    const name = `bond wire, ${pinLabel(b.pin)}`, mat = !b.lit ? M.gold : b.kind === 'out' ? lit : railLit;
    const info = { dim: `${f2(b.len)} mm of 25 µm gold: ${f2(b.nH)} nH`, source: SRC.wire, note: b.j > 0 ? 'an extra wire on the same lead (a what-if: the 74HC595 has one)' : ROLE[b.kind] };
    items.push({ geo: G.pad, mat: M.aluminium, at: [b.pts[0][0], DIE_TOP + PAD_T / 2, b.pts[0][2]], name: 'bond pad', group: 'die', ...none, info: { dim: `${PAD * 1000} µm square`, source: SRC.inside, note: 'aluminium, opened through the passivation' } });
    items.push({ geo: G.wire(b), mat, name, group: 'wires', ...none, shadow: look.detail === 'full', info });
    items.push({ geo: G.ball, mat, at: [b.pts[0][0], DIE_TOP + PAD_T + BALL_R * 0.3, b.pts[0][2]], scale: [1, 0.55, 1], name, group: 'wires', ...none, info });
    const e = b.pts[b.pts.length - 1];
    items.push({ geo: G.stitch, mat, at: [e[0], FRAME_TOP + 0.006, e[2]], name, group: 'wires', ...none, info });
  }
  return { items, cuts: CUT, anchors: anchors(st), beats: beats(st), floor: -0.8 };
}

/** One cut, level: the upper half of the moulding off, the lower half sliced just under the paddle's top. */
const CUT: Model3['cuts'] = { planes: [{ n: [0, 1, 0], d: CUT_Y }], open: [BODY_TOP + 1] };

// ---------------------------------------------------------------- labels and tour

const apex = (b: Bond): Vec3 => b.pts.reduce((m, p) => (p[1] > m[1] ? p : m), b.pts[0]);

function anchors(st: PkState): StudioAnchor[] {
  const bs = bonds(st), gnd = bs.find((b) => b.pin === GND_PIN)!, vcc = bs.find((b) => b.pin === VCC_PIN)!, q0 = bs.find((b) => b.pin === 15)!;
  return [
    { text: 'die', p: [-0.2, DIE_TOP, 0.2], side: 'l', n: [0, 1, 0.3], on: 'die' },
    { text: 'ground wire (pin 8)', p: apex(gnd), side: 'r', n: [0.2, 1, 0.4] },
    { text: 'VCC wire (pin 16)', p: apex(vcc), side: 'l', n: [-0.2, 1, -0.4] },
    { text: 'output wire (Q0)', p: apex(q0), side: 'l', n: [0, 1, -0.4] },
    { text: 'lead frame', p: [pinX(3), FRAME_TOP, 1.4], side: 'b', n: [0, 1, 0.5] },
    { text: 'mould compound', p: [BODY_D / 2 - 0.4, CUT_Y, BODY_E / 2], side: 'r', n: [0.3, 0.5, 1], on: 'mould' },
    { text: 'gull-wing lead', p: [pinX(6), 0.4, SPAN / 2 - FOOT - 0.1], side: 'b', n: [0, 0.3, 1] },
    { text: 'circuit board', p: [BODY_D / 2 + 1, 0, SPAN / 2 + 1], side: 'r', n: [0, 1, 1], minor: true },
  ];
}

export const PK_HOME = { target: [0, 0.8, 0] as Vec3, yaw: -0.38, pitch: 0.86, dist: 9 };
export const PK_HOME_FRAME = ['wires', 'die'];

function beats(st: PkState): Beat[] {
  const bs = bonds(st), gnd = bs.find((b) => b.pin === GND_PIN && b.j === 0)!, lens = bs.map((b) => b.len), v = bounceOf(st);
  const rail = st.edge === 'rise' ? 'VCC' : 'ground', wires = st.g > 1 ? `${st.g} wires` : 'one wire';
  return [
    { title: 'Life size', text: `A 74HC595 in its SOIC-16: a body ${f2(BODY_D)} × ${f2(BODY_E)} mm and ${f2(BODY_H)} mm thick, sixteen leads ${PITCH} mm apart, ${f2(SPAN)} mm across their feet. Eight of the pins are outputs that change together on one clock edge; ground is pin 8 and the supply pin 16.`,
      view: { target: [0, 0.6, 0], yaw: -0.5, pitch: 0.55, dist: 18 }, frame: ['mould', 'leads'], cut: 0, explode: 0, labels: false },
    { title: 'Opened', text: `The upper half of the moulding off. The die (${2 * DIE_X} × ${2 * DIE_Z} mm here) sits on a paddle of the lead frame, and a gold wire runs from each of its pads to the finger of a lead: from ${f2(Math.min(...lens))} mm for a middle pin to ${f2(Math.max(...lens))} mm for a corner.`,
      view: { target: [0, 0.8, 0], yaw: -0.4, pitch: 0.9, dist: 14 }, frame: ['die', 'wires', 'frame'], cut: 1, explode: 0 },
    { title: 'The ground wire', text: `Pin 8 is a corner, the furthest from the die: its wire is ${f2(gnd.len)} mm, ${f2(gnd.nH)} nH by Grover's formula. Every output that falls sends its current back to the board through it, so its inductance is the one that matters.`,
      view: { target: [2, 0.9, 0.6], yaw: -0.2, pitch: 0.7, dist: 7 }, frame: [`bond wire, ${pinLabel(GND_PIN)}`, 'die'], show: [`bond wire, ${pinLabel(GND_PIN)}`, pinLabel(GND_PIN), 'die'], cut: 1, explode: 0 },
    { title: 'Eight outputs at once', text: `${st.n} outputs ${st.edge === 'rise' ? 'rise' : 'fall'} in ${st.rise.toFixed(1)} ns, ${(padSwing() * 1000).toFixed(1)} mA each, all through ${wires} on the ${rail} lead: L · n · di/dt lifts the chip's ${rail} by ${f2(v)} V (V_IL is ${f2(VIL)} V).`,
      view: { target: [0, 0.8, 0], yaw: -0.3, pitch: 1.05, dist: 12 }, frame: ['wires', 'die'], show: ['wires', 'die'], cut: 1, explode: 0 },
    { title: 'Ball and stitch', text: 'At its true size: 25 µm of gold, about a third of a 70 µm hair. The bonder melts a ball on the wire\'s end and presses it onto the aluminium pad, rises, loops over and flattens the wire onto the finger: the stitch.',
      view: { target: [pinX(15) * 0.19, DIE_TOP + 0.08, -(DIE_Z - 0.08)], yaw: -0.5, pitch: 0.5, dist: 1.4 }, cut: 1, explode: 0, labels: false },
    { title: 'The lead', text: `The lead is the frame's own copper strip, ${f2(LEAD_T)} mm thick and ${f2(LEAD_W)} mm wide: it leaves the moulding at the frame's height, bends down and lies ${f2(FOOT)} mm flat on its land in the solder, the body ${f2(STANDOFF)} mm clear of the board.`,
      view: { target: [pinX(GND_PIN), 0.45, 2.3], yaw: Math.PI / 2 - 0.15, pitch: 0.12, dist: 5 }, frame: [pinLabel(GND_PIN)], cut: 1, explode: 0, labels: false },
    { title: 'How it is built', text: 'Pulled apart: the moulding is two halves pressed round the lead frame, which is clamped between them; the die and its wires are inside, the leads cut and bent after moulding, the board below.',
      view: { target: [0, 0.6, 0], yaw: -0.5, pitch: 0.4, dist: 24 }, frame: [], cut: 0, explode: 1 },
  ];
}
