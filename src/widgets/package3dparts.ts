// A chip package opened up, as parts (DOM-free, tested): board, lead frame, die paddle, die on its attach, aluminium pads,
// ball-and-stitch bond wires and an optional mould. The wires and the numbers are the same list: a signal wire is lit
// exactly when its output switches, and the active rail's wires (ground for a falling edge, VDD for a rising one) carry
// the sum of those currents, so the drawing cannot show more current than the model has. The wire's inductance is
// computed from the length that is drawn (Grover's straight-wire formula), so the longer the wire the larger the L.
//
// Scale, stated: the die is 21 units, so at UNITS_PER_MM a die of ~7.35 mm; the wire is drawn 0.26 units (~0.1 mm) in
// radius against a real 12.5 µm (25 µm Au), about 8 times thick, and pads sit 1.8 units (~0.63 mm) apart (real: 50-100 µm).

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, wire, type Anchor, type Part } from '../gl/parts';
import { groundBounce, VIH, VIL, VIO } from '../phys/line';
import { padSwing } from './line';

export const SIGNALS = 16, GROUNDS = 4, PER_SIDE = 12;
/** Segments per wire: ball, kink, apex, descent, stitch. */
export const SEG = 4;
export type Edge = 'fall' | 'rise';
export interface PkState {
  n: number; g: number; lnh: number; rise: number;
  /** drawn wire length (mm); absent: the default */
  len?: number; edge?: Edge; mould?: boolean;
}
export interface PkPalette { board: RGB; lead: RGB; paddle: RGB; die: RGB; pad: RGB; gold: RGB; ground: RGB; vdd: RGB; lit: RGB; bad: RGB; attach: RGB; mould: RGB }
export interface Bond { side: 1 | -1; z: number; ground: boolean; rail: 'sig' | 'gnd' | 'vdd'; lit: boolean; pts: Vec3[] }

/** Drawn units per millimetre of wire, and the wire's real radius in mm (25 µm gold). */
export const UNITS_PER_MM = 8 / 2.8;
export const WIRE_R_MM = 0.0125;
export const LEN_MIN = 1.5, LEN_MAX = 5, LEN_DEFAULT = 2.8;
/** A straight round wire (Grover, "Inductance Calculations", Rosa's form): L = 0.2·l·[ln(2l/r) − 0.75] nH, l and r in mm. */
export const bondL = (lMm: number, rMm = WIRE_R_MM): number => 0.2 * lMm * (Math.log((2 * lMm) / rMm) - 0.75);

const DIE_TOP = 2.3, PAD_TOP = 2.7, LEAD_TOP = 0.9;
/** The pad slots signals use: 8 free per side, so any n lights a symmetric set. */
const FREE = [0, 1, 2, 3, 8, 9, 10, 11];
const slotZ = (i: number) => (i - (PER_SIDE - 1) / 2) * 1.8;
/** Rail slots in the order they are bonded: the middle of each side, where a real ground ring sits. */
const GROUND_SLOTS: [1 | -1, number][] = [[-1, 4], [1, 4], [-1, 5], [1, 5]];
const VDD_SLOTS: [1 | -1, number][] = [[-1, 6], [1, 6], [-1, 7], [1, 7]];
const railSlots = (st: PkState, rail: 'gnd' | 'vdd') => (rail === 'gnd' ? GROUND_SLOTS : VDD_SLOTS).slice(0, st.g);

/** Bounce (V) with `g` rail bond wires in parallel: L / g, which ignores their mutual inductance (a real set keeps more).
 *  On a rising edge the same formula gives the supply droop (the charge comes through as many VDD wires). */
export const bounceOf = (st: PkState): number => groundBounce(st.n, padSwing(), st.rise, st.lnh / st.g);

/** What line.ts's panel says of a bounce: the same thresholds, beyond VDD being where the linear formula stops being valid.
 *  A droop is judged the same way: VDD − VIH = VIL here (VIL = 0.35, VIH = 0.65 of VDD). */
export type Verdict = 'ok' | 'undefined' | 'high' | 'invalid';
export const verdictOf = (v: number): Verdict => (v >= VIO ? 'invalid' : v >= VIH ? 'high' : v >= VIL ? 'undefined' : 'ok');

const polyLen = (p: Vec3[]): number => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);
/** Ball up through a kink to the apex, down gradually onto the lead's stitch (the real loop's shape, not a sine). */
function loop(side: 1 | -1, z: number, chord: number): Vec3[] {
  const rise = 0.8 + 0.09 * chord, y0 = PAD_TOP + 0.25, x = (t: number) => side * (9 + chord * t);
  return [[x(0), y0, z], [x(0.06), y0 + rise * 0.8, z], [x(0.4), y0 + rise, z], [x(0.75), y0 + rise * 0.55, z], [x(1), LEAD_TOP + 0.2, z]];
}
/** The wire's chord in drawn units, solved so that the polyline's length is `lenMm` (the chord plus the loop's excess). */
export function chordFor(lenMm: number): number {
  const want = lenMm * UNITS_PER_MM;
  let c = want;
  for (let i = 0; i < 8; i++) c += want - polyLen(loop(1, 0, c));
  return c;
}
/** The drawn wire's length in mm: what the inductance is computed from. */
export const drawnLenMm = (st: PkState): number => polyLen(loop(1, 0, chordFor(st.len ?? LEN_DEFAULT))) / UNITS_PER_MM;

export function bonds(st: PkState): Bond[] {
  const out: Bond[] = [], c = chordFor(st.len ?? LEN_DEFAULT), rise = st.edge === 'rise';
  FREE.forEach((i, j) => ([-1, 1] as const).forEach((side, s) => {
    const k = 2 * j + s;
    out.push({ side, z: slotZ(i), ground: false, rail: 'sig', lit: k < st.n, pts: loop(side, slotZ(i), c) });
  }));
  for (const rail of ['gnd', 'vdd'] as const) for (const [side, i] of railSlots(st, rail))
    out.push({ side, z: slotZ(i), ground: rail === 'gnd', rail, lit: st.n > 0 && (rail === 'vdd') === rise, pts: loop(side, slotZ(i), c) });
  return out;
}

const glow = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const alpha = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], a];

export function pkParts(st: PkState, P: PkPalette): Part[] {
  const out: Part[] = [], v = bounceOf(st), hot = Math.min(1, v / VIL), c = chordFor(st.len ?? LEN_DEFAULT), xin = 9 + c, rise = st.edge === 'rise';
  out.push(box(P.board, -42, 42, -2.4, -1, -26, 26));
  // Die on a thin film of attach epoxy (20-30 µm, drawn thicker) on the paddle.
  out.push(box(P.paddle, -13, 13, 0, 0.6, -12, 12), box(P.attach, -10.8, 10.8, 0.6, 0.8, -10.8, 10.8, 0.1), box(P.die, -10.5, 10.5, 0.8, DIE_TOP, -10.5, 10.5, 0.3));
  // All 24 leads exist; a rail lead is only wired where the slider has bonded it.
  const wired = new Map<string, 'gnd' | 'vdd'>();
  for (const rail of ['gnd', 'vdd'] as const) for (const [s, i] of railSlots(st, rail)) wired.set(`${s},${i}`, rail);
  for (const side of [-1, 1] as const) for (let i = 0; i < PER_SIDE; i++) {
    const z = slotZ(i), zo = z * 2.2, rail = wired.get(`${side},${i}`), xo = 37, m = (t: number) => side * (xin + (xo - xin) * t);
    out.push(...wire(P.lead, [[side * xin, 0.5, z], [m(0.3), 0.5, z], [m(0.65), 0.5, zo], [side * xo, 0.5, zo]], 0.4, 0.5));
    out.push(box(P.lead, side * xo - 1, side * xo + 1, -1, LEAD_TOP, zo - 0.9, zo + 0.9, 0.5));
    // A bonded rail pad takes its rail's colour; the active one warms towards red as the bounce nears VIL.
    const active = rail !== undefined && (rail === 'vdd') === rise;
    out.push({ ...box(rail === 'gnd' ? P.ground : rail === 'vdd' ? P.vdd : P.pad, side * 9 - 0.8, side * 9 + 0.8, DIE_TOP, PAD_TOP, z - 0.8, z + 0.8, 0.6), emissive: active ? glow(P.bad, hot * 0.9) : undefined });
  }
  for (const b of bonds(st)) {
    const col = b.rail === 'gnd' ? P.ground : b.rail === 'vdd' ? P.vdd : P.gold, rail = b.rail !== 'sig';
    for (const p of wire(col, b.pts, rail ? 0.34 : 0.26, 0.7)) out.push(b.lit ? { ...p, emissive: glow(rail ? P.bad : P.lit, rail ? 0.35 + 0.65 * hot : 0.8) } : p);
    // Ball bond on the pad, a flattened stitch where the wire is pressed onto the lead finger.
    out.push(cyl(col, b.pts[0][0], b.z, PAD_TOP, PAD_TOP + 0.5, 0.6, 0.7));
    out.push(box(col, b.side * xin - 0.9, b.side * xin + 0.9, LEAD_TOP, LEAD_TOP + 0.2, b.z - 0.5, b.z + 0.5, 0.6));
  }
  if (st.mould) out.push(box(alpha(P.mould, 0.22), -(xin + 3.5), xin + 3.5, -1, 6, -14.5, 14.5));
  return out;
}

export function pkAnchors(st: PkState): Anchor[] {
  const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.3, 1], c = chordFor(st.len ?? LEN_DEFAULT), z9 = slotZ(PER_SIDE - 1);
  const rail = st.edge === 'rise' ? 'VDD' : 'ground';
  const g = st.edge === 'rise' ? VDD_SLOTS[0] : GROUND_SLOTS[0];
  return [
    { text: 'die', p: [0, DIE_TOP, 6], side: 'b', n: up },
    { text: 'signal bond wire', p: [9 + c * 0.4, 5.2, z9], side: 'r', n: front },
    { text: 'lead frame', p: [30, 0.5, z9 * 2.2], side: 'b', n: front },
    { text: 'board', p: [0, -1, 26], side: 'b', n: front },
    { text: st.g > 1 ? `${st.g} ${rail} bond wires in parallel` : `${rail} bond wire`, p: [g[0] * (9 + c * 0.4), 5.2, slotZ(g[1])], side: 't', n: front },
    { text: 'Al pad, ball bond', p: [-9, PAD_TOP, slotZ(0)], side: 'l', n: front, minor: true },
    { text: 'die attach', p: [-10.8, 0.7, 4], side: 'l', n: front, minor: true },
  ];
}
