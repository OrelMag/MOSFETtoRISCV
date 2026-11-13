// One column of Difference Engine No. 2 on the studio renderer (DOM-free, tested): thirty-one figure wheels, each a toothed brass
// wheel with four decades of numerals; on the warning axis a three-limbed carry lever per wheel; on the carry axis the helix of
// thirty carry arms; and, as a layer, the whole engine's outline with a person beside it. Every part is named as Swade's
// Technical Description names it (A/171, Fig. 3.16) and moves from the DOM-free model of babbage3dparts.ts: a wheel turns 9° a
// unit, a lever stands unwarned, warned (its lozenge in the arms' path) or carried, the axis turns the arms past the levers.
//
// Sourced (D. Swade, "Charles Babbage's Difference Engine No. 2, Technical Description", Science Museum, March 2020; read):
//  - "Each figure wheel (n 2 2, A/171) has four decades of numerals 0 - 9 i.e. 40 teeth with each decade occupying one quadrant
//    of a full circle"; a tooth (one unit) is 9°; the largest turn of a wheel is 81°, nine units.
//  - The warning axis stands at 12 o'clock to the figure-wheel axis, the reset-stop pillar at 2 o'clock; "the carry lever is
//    the most complex single part in the Engine. Each has three limbs which project radially from a central boss": the warning
//    claw (underneath) that the wheel's nib catches passing 9 to 0, the horns that engage the teeth of the wheel above, and the
//    lozenge that a carry arm's lozenge wipes past when the lever is warned, nudging the lever on and the wheel above one tooth.
//  - The carry arms' vertical separation is the figure wheels' pitch; their angular pitch and the two rotations are the
//    model's (babbage3dparts.ts PITCH_DEG, GAP_DEG, TURN_MAX).
//  - The whole engine (Computer History Museum, "The Modern Sequel"): about 7 ft tall, 11 ft long, 18 in deep at its narrowest,
//    eight columns of 31 figure wheels, 8 000 parts, about five tons.
// Not sourced, and said so in the note and the cards: the wheels' diameter and pitch, the axes' positions and every other
// size of the column (the Technical Description gives none for them), the other seven columns' places in the outline.
// The motion is a drawing of the mechanism's states, not a kinematic model: the arm order is derived, not quoted.

import type { RGB } from '../gl/instances';
import { lathe, merge, roundedBox, transform, extrude, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { quatAxisAngle, type Mat4, type Vec3 } from '../gl/math';
import { ARMS, DIGITS, EVENTS, GAP_DEG, PITCH_DEG, TURN_MAX, armPhase, type Carry, type Column } from './babbage3dparts';
import { GLYPHS } from './strokefont';

const D2R = Math.PI / 180;

/** The Technical Description's figures for the figure wheel. */
export const TEETH = 40, DEG_PER_UNIT = 360 / TEETH, MAX_TURN = 9 * DEG_PER_UNIT;
/** The whole engine (CHM): 7 ft × 11 ft × 18 in, mm. */
export const ENGINE_MM = { h: 7 * 304.8, l: 11 * 304.8, d: 18 * 25.4 } as const;
export const PERSON_MM = 1750;
export const SRC = {
  wheel: 'Swade, DE2 Technical Description (2020), §3.1 and §4: 40 teeth, four decades of numerals, 9° a unit (A/171)',
  lever: 'Swade, DE2 Technical Description (2020), §3.2 and Fig. 3.16 (A/171): the carry lever, three limbs from a central boss',
  axis: 'Swade, DE2 Technical Description (2020), §3.2: the helical array of carry arms 1C1_1 to 1C1_30, two rotations a carry',
  engine: 'Computer History Museum, "The Modern Sequel": 7 ft tall, 11 ft long, 18 in deep, eight columns, about five tons',
  illus: 'illustrative: no size is given for this part in the sources read',
};

/** Sizes (mm), illustrative: a column of 31 wheels about 0.9 m tall inside the engine's 7 ft. */
export const WHEEL = { tip: 60, root: 55, face: 52, teethH: 5, barrelH: 16, pitch: 30, hub: 14 } as const;
export const wheelBase = (i: number): number => i * WHEEL.pitch;
const TOP = wheelBase(DIGITS - 1) + WHEEL.pitch;
/** The warning axis at 12 o'clock (−z) to the figure-wheel axis; the carry axis behind it, to the left. */
export const W_AXIS: [number, number] = [0, -95];
const CW_DIST = 110, CW_DIR = -40 * D2R;
export const C_AXIS: [number, number] = [W_AXIS[0] + CW_DIST * Math.sin(CW_DIR), W_AXIS[1] - CW_DIST * Math.cos(CW_DIR)];
/** The lever's limbs: lozenge (towards the carry axis), claw and horns (towards the wheels), detent. The arm reaches 3 mm past the warned lozenge. */
export const LEVER = { lozenge: 60, claw: 40, detent: 26, t: 4 } as const;
export const ARM_LEN = CW_DIST - LEVER.lozenge + 3;
/** The lever's turn from warned (its lozenge on the line to the carry axis): unwarned on one side, carried on the other. */
export const SWING = 20;
export const leverY = (i: number): number => wheelBase(i) + WHEEL.teethH + WHEEL.barrelH + 2;

export type BabLayer = 'engine';
export interface BabbageLook {
  detail: 'full' | 'flat';
  col: Column;
  /** The carry phase under way (the axis's angle, the arms fired so far), or null before an Add. */
  carry: Carry | null;
  /** Wheels about to receive a carry, foreseen (the anticipating carriage). */
  foresee: boolean[] | null;
  lookAhead: boolean;
  layers: ReadonlySet<BabLayer>;
  rgb: { brass: RGB; warn: RGB; nine: RGB; live: RGB; ink: RGB };
}

// ---------------------------------------------------------------- the motion, from the model

/** Degrees before its poll over which an arm meets an armed lever and turns the wheel above (a drawing's window). */
export const CONTACT = 16;
export interface Motion { turn: number[]; lever: number[] }
/** Each wheel's angle (digit × 9° plus the part of a tooth an arm is pushing it on) and each lever's swing (+ unwarned, 0 warned, − carried). */
export function motion(col: Column, carry: Carry | null): Motion {
  const turn = col.w.map((d) => d * DEG_PER_UNIT);
  const fired = new Set(carry?.fired ?? []);
  const lever = col.warn.map((w, i) => (w ? 0 : fired.has(i) ? -SWING : SWING));
  if (carry) {
    for (let k = carry.cursor; k < EVENTS.length && EVENTS[k].t < carry.theta + CONTACT; k++) {
      const { arm, t } = EVENTS[k];
      if (!col.warn[arm]) continue;
      const f = Math.min(1, Math.max(0, 1 - (t - carry.theta) / CONTACT));
      turn[arm + 1] += f * DEG_PER_UNIT;
      lever[arm] = -SWING * f;
    }
  }
  return { turn, lever };
}
/** The angle about +y (counter-clockwise seen from above) that turns +x onto the plan direction (x, z). */
const yawOf = (x: number, z: number): number => Math.atan2(-z, x);
export const LOZENGE_YAW = yawOf(C_AXIS[0] - W_AXIS[0], C_AXIS[1] - W_AXIS[1]);
export const ARM_YAW = yawOf(W_AXIS[0] - C_AXIS[0], W_AXIS[1] - C_AXIS[1]);
/** A lever's lozenge (plan x, z) at a swing, and a carry arm's tip at its phase: they meet when the lever is warned and the phase is 0. */
export const lozengeAt = (swing: number): [number, number] => {
  const a = LOZENGE_YAW + swing * D2R;
  return [W_AXIS[0] + LEVER.lozenge * Math.cos(a), W_AXIS[1] - LEVER.lozenge * Math.sin(a)];
};
export const armTipAt = (phaseDeg: number): [number, number] => {
  const a = ARM_YAW + phaseDeg * D2R;
  return [C_AXIS[0] + ARM_LEN * Math.cos(a), C_AXIS[1] - ARM_LEN * Math.sin(a)];
};

// ---------------------------------------------------------------- geometry (made once)

const memo = new Map<string, Geo>();
const once = (k: string, f: () => Geo): Geo => { let g = memo.get(k); if (!g) { g = f(); memo.set(k, g); } return g; };
const cyl = (r: number, y0: number, y1: number, seg = 32) => lathe([[0, y0], [r, y0], [r, y1], [0, y1]], { seg });
/** A matrix from columns: local x, y, z axes and the origin. */
const frameMat = (x: Vec3, y: Vec3, z: Vec3, o: Vec3): Mat4 => new Float32Array([...x, 0, ...y, 0, ...z, 0, ...o, 1]);

/** The toothed wheel: 40 teeth (a trapezoid each) round the root circle. */
function teethOutline(): [number, number][] {
  const out: [number, number][] = [], { tip, root } = WHEEL;
  for (let k = 0; k < TEETH; k++) {
    const a = k * DEG_PER_UNIT * D2R, w = DEG_PER_UNIT * D2R;
    for (const [f, r] of [[0, root], [0.22, tip], [0.5, tip], [0.72, root]] as const) out.push([r * Math.cos(a + f * w), r * Math.sin(a + f * w)]);
  }
  return out;
}
/** The wheel's body: the toothed rim, the numeral barrel above it, the hub. y from 0 (its underside). */
const wheelBody = (detail: 'full' | 'flat') => once(`body|${detail}`, () => merge([
  ...(detail === 'full' ? [extrude(teethOutline(), WHEEL.teethH)] : [cyl(WHEEL.tip - 2, 0, WHEEL.teethH, 24)]),
  lathe([[WHEEL.hub, WHEEL.teethH], [WHEEL.face, WHEEL.teethH], [WHEEL.face, WHEEL.teethH + WHEEL.barrelH], [WHEEL.hub, WHEEL.teethH + WHEEL.barrelH]], { seg: detail === 'full' ? 64 : 24 }),
], 'figure wheel'));

/** A numeral's strokes as thin boxes on the barrel's face at angle phi (0 = front, +z). */
function numeral(d: number, phi: number): Geo[] {
  const s = 1.45, stroke = 0.95, depth = 0.7, r = WHEEL.face + depth / 2 - 0.15, yc = WHEEL.teethH + WHEEL.barrelH / 2;
  const u: Vec3 = [Math.sin(phi), 0, Math.cos(phi)], right: Vec3 = [Math.cos(phi), 0, -Math.sin(phi)];
  const out: Geo[] = [];
  for (const line of GLYPHS[String(d)]) for (let k = 0; k + 3 < line.length; k += 2) {
    const x0 = (line[k] - 2) * s, y0 = (line[k + 1] - 3) * s, x1 = (line[k + 2] - 2) * s, y1 = (line[k + 3] - 3) * s, len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const dx = (x1 - x0) / len, dy = (y1 - y0) / len, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const ax: Vec3 = [right[0] * dx, dy, right[2] * dx], ay: Vec3 = [-right[0] * dy, dx, -right[2] * dy];
    const o: Vec3 = [u[0] * r + right[0] * mx, yc + my, u[2] * r + right[2] * mx];
    out.push(transform(roundedBox(len + stroke, stroke, depth, 0, 1), frameMat(ax, ay, u, o)));
  }
  return out;
}
/** Four decades of numerals round the barrel, digit k at phi = −9° k: a wheel turned d × 9° shows d at the front. */
const numeralRing = () => once('numerals', () => merge(Array.from({ length: TEETH }, (_, k) => numeral(k % 10, -k * DEG_PER_UNIT * D2R)).flat(), 'numerals'));
/** The flat drawing's numeral: the one at the front only. */
const numeralFront = (d: number) => once(`numeral${d}`, () => merge(numeral(d, 0), 'numeral'));

/** The carry lever, flat in plan at y = 0..t, its boss on the origin and its lozenge limb along +x. */
const leverGeo = () => once('lever', () => {
  const { lozenge, claw, detent, t } = LEVER, rect = (x0: number, x1: number, w: number): [number, number][] => [[x0, -w / 2], [x1, -w / 2], [x1, w / 2], [x0, w / 2]];
  const rot = (pts: [number, number][], a: number): [number, number][] => pts.map(([x, z]) => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)]);
  // The claw limb points at the wheel axis: from the lozenge direction, that is −LOZENGE_YAW + the direction to the wheels (+z).
  const toWheel = yawOf(-W_AXIS[0], -W_AXIS[1]) - LOZENGE_YAW, toDetent = toWheel + 115 * D2R;
  const plan = (pts: [number, number][]) => pts.map(([x, z]) => [x, -z] as [number, number]); // plan angle → x, z with yaw counter-clockwise
  return merge([
    cyl(9, 0, t + 2, 24),
    extrude(plan(rect(6, lozenge - 5, 7)), t),
    extrude(plan([[lozenge - 9, 0], [lozenge - 4, -5], [lozenge + 2, 0], [lozenge - 4, 5]]), t),
    extrude(plan(rot(rect(6, claw, 7), toWheel)), t),
    // the horns at the claw limb's end, standing up into the plane of the wheel above's teeth
    transform(extrude(plan(rot([[claw - 6, -5], [claw + 2, -5], [claw + 2, 5], [claw - 6, 5]], toWheel)), 3), new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, t, 0, 1])),
    // the warning claw underneath
    transform(extrude(plan(rot([[claw - 14, -3], [claw - 6, -3], [claw - 6, 3], [claw - 14, 3]], toWheel)), 3), new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -3, 0, 1])),
    extrude(plan(rot(rect(6, detent, 6), toDetent)), t),
  ], 'carry lever');
});
/** A carry arm, flat at y = 0..t, its root on the carry axis and its lozenge along +x. */
const armGeo = () => once('arm', () => merge([
  cyl(8, 0, LEVER.t + 2, 20),
  extrude([[4, -3], [ARM_LEN - 6, -3], [ARM_LEN - 6, 3], [4, 3]], LEVER.t),
  extrude([[ARM_LEN - 10, 0], [ARM_LEN - 4, -5], [ARM_LEN + 2, 0], [ARM_LEN - 4, 5]], LEVER.t),
], 'carry arm'));

/** A standing person, 1.75 m, as a flat outline in x, y (the extrude's z is the depth). */
function personOutline(): [number, number][] {
  const H = PERSON_MM, k = H / 175, p: [number, number][] = [];
  // head: a circle
  const hc: [number, number] = [0, 164 * k], hr = 11 * k;
  const body: [number, number][] = [[-4, 150], [-21, 146], [-24, 100], [-19, 98], [-17, 138], [-15, 100], [-14, 50], [-12, 0], [-3, 0], [-1, 88], [1, 88], [3, 0], [12, 0], [14, 50], [15, 100], [17, 138], [19, 98], [24, 100], [21, 146], [4, 150]];
  for (const [x, y] of body) p.push([x * k, y * k]);
  // the neck joins the head's arc from its right side round the top to its left
  const arc: [number, number][] = [];
  for (let a = -60; a <= 240; a += 20) arc.push([hc[0] + hr * Math.cos(a * D2R), hc[1] + hr * Math.sin(a * D2R)]);
  // the body from the left of the neck round to its right, then over the head back to the start
  return [...p, ...arc];
}

// ---------------------------------------------------------------- the model

/** What the whole-engine view fits: the outline and the person beside it. */
export const ENGINE_BOX: { min: Vec3; max: Vec3 } = { min: [-680, -300, -ENGINE_MM.d / 2], max: [-230 + ENGINE_MM.l + 20, -260 + ENGINE_MM.h + 40, ENGINE_MM.d / 2] };
export const FRAME_GROUPS = ['homebox', 'colbox', 'leverbox', 'axisbox', 'enginebox'] as const;
/** The digit drawn apart in the explode beat (its wheel, lever, arm and the spacer above). */
export const EX = 6;
/** Out of the column towards the home view's camera (behind and to the left of the wheels), by d mm: the digit's parts apart in a line. */
const OUT = (d: number): Vec3 => [-0.62 * d, 0, -0.78 * d];

export function babbageModel(look: BabbageLook): Model3 {
  const full = look.detail === 'full', items: Item[] = [], mo = motion(look.col, look.carry), C = look.rgb;
  const brass: Material = { ...M.brass, base: C.brass }, steel = M.steel, bright = M.make({ base: [0.74, 0.76, 0.8], metal: 0.85, rough: 0.3, label: 'steel' }), dark = M.make({ base: [0.16, 0.17, 0.19], metal: 0.7, rough: 0.45, label: 'steel spacer' });
  const castIron = M.make({ base: [0.24, 0.25, 0.27], metal: 0.35, rough: 0.7, label: 'cast iron' });
  const ink = M.make({ base: C.ink, metal: 0.2, rough: 0.6, label: 'engraved numerals' });
  const nineInk = M.make({ base: C.nine, metal: 0, rough: 0.5, emit: C.nine, glow: 0.2, label: 'engraved numerals (the wheel stands at 9)' });
  const warnMat = M.make({ base: C.warn, metal: 0.6, rough: 0.35, emit: C.warn, glow: 0.45, label: 'steel, the lever warned' });
  const live = M.make({ ...M.brass, base: C.brass, emit: C.live, glow: 0.35, label: 'gunmetal, about to receive a carry (foreseen)' });
  const yQ = (a: number) => quatAxisAngle([0, 1, 0], a);
  const exOf = (i: number, v: Vec3): { explode?: Vec3; group?: string } => (i === EX ? { explode: v, group: 'digit' } : {});

  // the frame: cast-iron plates under and over the column, the axes between them
  const plate = () => roundedBox(260, 18, 330, 6, full ? 3 : 1);
  items.push({ geo: once(`plate|${look.detail}`, plate), mat: castIron, at: [-25, -30, -60], name: 'frame plate', group: 'frame', info: { source: SRC.illus, note: 'the column stands between cast frame plates' } });
  items.push({ geo: once(`plate|${look.detail}`, plate), mat: castIron, at: [-25, TOP + 22, -60], name: 'frame plate', group: 'frame', info: { source: SRC.illus } });
  items.push({ geo: once('wax', () => cyl(WHEEL.hub - 2, -21, TOP + 13, 24)), mat: steel, name: 'figure-wheel axis', group: 'axes', info: { source: SRC.wheel, note: 'the wheels turn on it' } });
  items.push({ geo: once('wwax', () => cyl(7, -21, TOP + 13, 20)), mat: steel, at: [W_AXIS[0], 0, W_AXIS[1]], name: 'warning axis', group: 'axes', info: { source: SRC.lever, note: 'at 12 o’clock to the figure-wheel axis; the carry levers ride on it' } });
  items.push({ geo: once('cax', () => cyl(10, -21, TOP + 13, 24)), mat: steel, at: [C_AXIS[0], 0, C_AXIS[1]], name: 'carry axis', group: 'axes', info: { source: SRC.axis, note: 'turns twice for every carry phase, its thirty arms in a helix' } });
  const pillar: [number, number] = [85 * Math.sin(60 * D2R), -85 * Math.cos(60 * D2R)];
  items.push({ geo: once('pil', () => cyl(8, -21, TOP + 13, 16)), mat: castIron, at: [pillar[0], 0, pillar[1]], name: 'reset-stop pillar', group: 'frame', info: { source: SRC.lever, note: 'at 2 o’clock to the figure-wheel axis' } });

  const body = wheelBody(look.detail);
  for (let i = 0; i < DIGITS; i++) {
    const y = wheelBase(i), d = look.col.w[i], nine = d === 9, recv = look.foresee?.[i] ?? false, rot = yQ(mo.turn[i] * D2R);
    const ex = exOf(i, [0, 0, 0]);
    items.push({ geo: body, mat: recv ? live : brass, at: [0, y, 0], rot, name: i === 0 ? 'units wheel' : i === DIGITS - 1 ? 'top wheel (overflow)' : 'figure wheel', group: ex.group ?? 'wheels', explode: ex.explode,
      info: { dim: `${TEETH} teeth, ${DEG_PER_UNIT}° a unit; ${WHEEL.tip * 2} mm across (illustrative)`, source: SRC.wheel, note: `wheel ${i + 1} of ${DIGITS}, reading ${d}` } });
    items.push(full
      ? { geo: numeralRing(), mat: nine ? nineInk : ink, at: [0, y, 0], rot, name: 'numerals', group: ex.group ?? 'wheels', explode: ex.explode, cut: 'none', shadow: false, info: { source: SRC.wheel, note: 'four decades of 0 to 9: a decade a quadrant' } }
      : { geo: numeralFront(d), mat: nine ? nineInk : ink, at: [0, y, 0], name: 'numerals', group: ex.group ?? 'wheels', explode: ex.explode });
    // the spacer between this wheel and the next (dark: the column reads as wheels, not as one cylinder)
    if (i < DIGITS - 1) items.push({ geo: once('spacer', () => cyl(32, WHEEL.teethH + WHEEL.barrelH, WHEEL.pitch, 24)), mat: dark, at: [0, y, 0], name: 'spacer', group: 'wheels', info: { source: SRC.illus } });
    // the carry lever on the warning axis, between this wheel and the one above
    const armed = look.col.warn[i], lex = exOf(i, OUT(70));
    items.push({ geo: leverGeo(), mat: armed ? warnMat : bright, at: [W_AXIS[0], leverY(i), W_AXIS[1]], rot: yQ(LOZENGE_YAW + mo.lever[i] * D2R),
      name: i === DIGITS - 1 ? 'carry lever (the overflow flag)' : 'carry lever', group: lex.group ?? 'levers', explode: lex.explode,
      info: { source: SRC.lever, note: armed ? 'warned: its wheel passed 9 to 0; its lozenge stands in the carry arms’ path' : mo.lever[i] < 0 ? 'carried: an arm wiped past its lozenge and its horn turned the wheel above one tooth' : 'unwarned: its lozenge clear of the arms' } });
  }
  // the carry arms, keyed to the carry axis in a helix
  const theta = look.carry?.theta ?? 0;
  for (let a = 0; a < ARMS; a++) {
    const ph = armPhase(a, theta), on = Math.abs((((ph % 360) + 540) % 360) - 180) < 3.5 && look.carry !== null, ex = exOf(a, OUT(150));
    items.push({ geo: armGeo(), mat: on && look.col.warn[a] ? warnMat : bright, at: [C_AXIS[0], leverY(a), C_AXIS[1]], rot: yQ(ARM_YAW + ph * D2R), name: 'carry arm', group: ex.group ?? 'arms', explode: ex.explode,
      info: { dim: `arm ${a + 1} of ${ARMS}, at ${(((ph % 360) + 360) % 360).toFixed(0)}° from its lever`, source: SRC.axis, note: `${PITCH_DEG}° from the next arm round the helix, ${GAP_DEG}° between the 15th and 16th (the angles as the model takes them)` } });
  }
  // the anticipating carriage's look-ahead, its effect only: a bar the column's height, lit over the run that receives a carry
  if (look.lookAhead) {
    const x = WHEEL.tip + 22, lo = look.foresee ? look.foresee.indexOf(true) : -1, hi = look.foresee ? look.foresee.lastIndexOf(true) : -1;
    items.push({ geo: once('la', () => cyl(3, 0, TOP, 12)), mat: steel, at: [x, 0, 0], name: 'look-ahead (effect only)', group: 'look', info: { source: 'Babbage, Passages (1864), ch. VIII: every carry of a run in one unit; no linkage for this engine is drawn', note: 'the anticipating carriage was designed for the Analytical Engine, not fitted to this one' } });
    if (lo >= 0) items.push({ geo: cyl(5, 0, wheelBase(hi) - wheelBase(lo) + WHEEL.pitch, 12), mat: M.make({ base: C.live, metal: 0, rough: 0.4, emit: C.live, glow: 0.7, label: 'carries foreseen' }), at: [x, wheelBase(lo), 0], name: 'look-ahead (effect only)', group: 'look' });
  }
  // the whole engine: its outline, seven more columns, a person
  if (look.layers.has('engine')) {
    const ghost = M.make({ base: [0.6, 0.65, 0.75], metal: 0, rough: 0.5, transmit: 0.82, label: 'the engine’s outline' });
    const { h, l, d } = ENGINE_MM, x0 = -230, y0 = -260, z0 = -330;
    items.push({ geo: once('env', () => roundedBox(l, h, d, 20, 2)), mat: ghost, at: [x0 + l / 2, y0 + h / 2, z0 + d / 2], name: 'Difference Engine No. 2', group: 'engine', shadow: false, order: 2,
      info: { dim: `7 ft tall, 11 ft long, 18 in deep (${Math.round(h)} × ${Math.round(l)} × ${Math.round(d)} mm)`, source: SRC.engine, note: 'eight columns of 31 figure wheels in the calculating section, the printer and stereotyper beyond; about five tons' } });
    const colGhost = M.make({ base: C.brass, metal: 0.3, rough: 0.5, transmit: 0.7, label: 'another column of 31 figure wheels' });
    for (let k = 1; k < 8; k++) items.push({ geo: once('colg', () => cyl(WHEEL.tip, 0, TOP, 24)), mat: colGhost, at: [k * 200, 0, 0], name: 'another column', group: 'engine', shadow: false, order: 1, info: { source: SRC.engine, note: 'its place in the outline is illustrative' } });
    const person = once('person', () => transform(extrude(personOutline().map(([x, y]) => [x, -y]), 60), new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1])));
    items.push({ geo: person, mat: M.make({ base: [0.42, 0.45, 0.52], metal: 0, rough: 0.8, label: 'a person' }), at: [x0 - 420, y0, z0 + d / 2], name: 'a person, 1.75 m', group: 'engine', info: { dim: `${PERSON_MM} mm`, source: 'for scale' } });
  }
  // the frames the views fit to (never drawn: the stage hides them)
  {
    const ghostBox = M.make({ base: [0, 0, 0], metal: 0, rough: 1, label: 'frame' });
    const box = (g: string, w: number, h: number, d: number, at: Vec3) => items.push({ geo: roundedBox(w, h, d, 0, 1), mat: ghostBox, at, group: g, cut: 'none', shadow: false });
    // home: the lower wheels, where a run of 9s carries, with the levers and arms in front of them
    box('homebox', 250, 13 * WHEEL.pitch, 300, [-45, wheelBase(6.5), -70]);
    box('colbox', 260, TOP + 70, 330, [-25, TOP / 2, -60]);
    box('leverbox', 170, 5 * WHEEL.pitch, 190, [-35, wheelBase(5), -100]);
    box('axisbox', 160, TOP + 40, 200, [C_AXIS[0] + 20, TOP / 2, C_AXIS[1] + 30]);
    const eb = ENGINE_BOX;
    box('enginebox', eb.max[0] - eb.min[0], eb.max[1] - eb.min[1], eb.max[2] - eb.min[2], [(eb.min[0] + eb.max[0]) / 2, (eb.min[1] + eb.max[1]) / 2, (eb.min[2] + eb.max[2]) / 2]);
  }
  return { items, anchors: anchors(look), beats: beats(), floor: -40, look: { exposure: 1.05 } };
}

function anchors(look: BabbageLook): StudioAnchor[] {
  const front: Vec3 = [0, 0.2, 1], left: Vec3 = [-1, 0.2, 0.2], back: Vec3 = [-0.4, 0.3, -1];
  const armed = look.col.warn.findIndex((x, i) => x && i < ARMS), k = armed >= 0 ? armed : 9, [lx, lz] = lozengeAt(0);
  if (look.layers.has('engine')) return [
    { text: 'the engine, 7 × 11 ft', p: [-230 + ENGINE_MM.l * 0.6, -260 + ENGINE_MM.h, 0], side: 'r', n: [0, 1, 0.3] },
    { text: 'one column (drawn)', p: [WHEEL.tip, wheelBase(24), 0], side: 'r', n: front },
    { text: 'a person, 1.75 m', p: [-650, -260 + PERSON_MM * 0.95, 0], side: 'l', n: front },
  ];
  const a: StudioAnchor[] = [
    { text: 'figure wheel', p: [WHEEL.tip, wheelBase(20) + WHEEL.teethH, 0], side: 'r', n: front, on: 'figure wheel' },
    { text: 'units wheel', p: [WHEEL.tip, wheelBase(0) + WHEEL.teethH, 0], side: 'r', n: front, on: 'units wheel' },
    { text: 'top wheel (overflow)', p: [WHEEL.tip, wheelBase(DIGITS - 1) + WHEEL.teethH, 0], side: 'r', n: front, on: 'top wheel (overflow)' },
    { text: armed >= 0 ? 'carry lever (warned)' : 'carry lever', p: [(W_AXIS[0] + lx) / 2, leverY(k) + LEVER.t, (W_AXIS[1] + lz) / 2], side: 'l', n: back, on: 'levers' },
    { text: 'warning axis', p: [W_AXIS[0], wheelBase(26), W_AXIS[1]], side: 'r', n: back },
    { text: 'carry axis', p: [C_AXIS[0], wheelBase(24), C_AXIS[1]], side: 'l', n: left },
    { text: 'carry arm', p: [C_AXIS[0] + 20, leverY(14), C_AXIS[1]], side: 'l', n: left, on: 'arms' },
  ];
  if (look.lookAhead) a.push({ text: 'look-ahead (effect only)', p: [WHEEL.tip + 22, wheelBase(12), 0], side: 'r', n: front });
  return a;
}

export const HOME = { target: [0, 0, 0] as Vec3, yaw: -2.2, pitch: 0.28, dist: 1500 };
export const BEAT_LAYERS: readonly (readonly BabLayer[])[] = [[], [], [], [], [], ['engine']];

function beats(): Beat[] {
  return [
    { title: 'A column of figure wheels', text: `Thirty-one figure wheels, the units at the bottom. Each has ${TEETH} teeth and four decades of numerals 0 to 9, a decade a quadrant: one unit is ${DEG_PER_UNIT}° of turn, and the most a wheel turns in an addition is ${MAX_TURN}°.`, view: { ...HOME, yaw: -0.5, pitch: 0.2 }, frame: ['colbox'], explode: 0 },
    { title: 'The carry lever', text: 'Behind each wheel, on the warning axis, a carry lever: three limbs from one boss. The warning claw underneath is caught by the wheel’s nib when it passes 9 to 0; the horns reach the teeth of the wheel above; the lozenge faces the carry axis.', view: { ...HOME, yaw: -2.3, pitch: 0.42 }, frame: ['leverbox'], explode: 0 },
    { title: 'Warned', text: 'A wheel that passes 9 to 0 during the addition turns its lever on to the warned position and carries nothing yet: the lever’s lozenge now stands in the path of the carry arms. Press Add with a run of 9s to see it.', view: { ...HOME, yaw: -1.9, pitch: 0.9 }, frame: ['leverbox'], explode: 0 },
    { title: 'The helix of arms', text: `The carry axis turns, and its thirty arms, ${PITCH_DEG}° apart round a helix with ${GAP_DEG}° between the 15th and 16th, poll the levers one after another from below. An arm meeting a warned lever wipes past its lozenge and nudges it on; its horn turns the wheel above one tooth. If that wheel passes 9 to 0 its own lever is warned for an arm still to come: the carry ripples. Two turns of the axis, ${TURN_MAX}°, finish any carry.`, view: { ...HOME, yaw: -2.6, pitch: 0.3 }, frame: ['axisbox'], explode: 0 },
    { title: 'One digit, apart', text: 'One digit of the column pulled apart: its figure wheel and numerals, its carry lever, and the carry arm that services it. The Technical Description calls the lever the most complex single part in the Engine.', view: { target: [-80, 200, -150], yaw: -2.0, pitch: 0.95, dist: 620 }, show: ['digit'], explode: 1 },
    { title: 'The whole engine', text: 'The engine has eight such columns (seven orders of difference and the tabular value) and a printer, about 7 ft tall, 11 ft long and 18 in deep, some five tons: the outline from the Computer History Museum’s figures, the other columns placed for scale.', view: { ...HOME, yaw: -0.35, pitch: 0.18 }, frame: ['enginebox'], explode: 0, labels: true },
  ];
}
