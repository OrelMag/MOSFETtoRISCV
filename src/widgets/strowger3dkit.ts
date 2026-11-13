// The Strowger selector in true geometry, in millimetres, for the studio renderer (DOM-free, tested): an Automatic
// Electric-style two-motion group selector, the kind with a release magnet. What moves is phys/strowger.ts's motionAt:
// the shaft's height in levels and the wipers' angle in lines, each armature's travel, the holding pawls in or lifted.
//
// The envelope is the Science Museum's pre-2000 group selector (object 1926-480: 422 × 170 × 200 mm, 6.78 kg). The
// mechanism follows the descriptions (the vertical and rotary ratchets on the shaft, a pawl on each magnet's armature, a
// frame-pivoted holding pawl for each motion, the release magnet lifting both, a spring that turns the shaft home before
// it drops; three wipers on one carrier over a bank three contacts deep): Wikipedia "Strowger switch", the
// Communications Museum's "Strowger Part 3", dfrtelecoms' stepping.htm, calling315.com. Every size inside the envelope
// is the model's: no drawing with dimensions was found. The bank's arc and its level pitch are illustrative.
//
// Coordinates: y up from the bottom bracket, the shaft's axis on x = z = 0, the bank behind it (−z), the vertical magnet
// in front (+z), the rotary magnet on the right (+x), the release magnet and the holding pawls on the left.

import { extrude, helix, lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { packInstances, type Instance, type RGB } from '../gl/instances';
import { quatAxisAngle, quatRotate, type Mat4, type Quat, type Vec3 } from '../gl/math';
import { UNIT_BOX } from '../gl/kit/fromparts';
import { LEVELS, LINES, OVERFLOW, type Motion, type State } from '../phys/strowger';

// ---------------------------------------------------------------- sizes (mm)

/** The selector's envelope: Science Museum 1926-480. */
export const ENVELOPE = { h: 422, w: 170, d: 200 };
/** The bank's level pitch and the wipers' height at rest, below level 1 [ill.]. */
export const LEVEL_PITCH = 6, WIPER_Y0 = 244;
/** Each level is three contacts deep, one per wiper: tip, ring and sleeve (the test wire), this far apart. */
export const WIPER_DY = [-1.8, 0, 1.8] as const;
export const WIPER_NAMES = ['tip', 'ring', 'sleeve'] as const;
/** Where the wipers touch the bank, and the contacts' radial extent [ill.]. */
export const R_TIP = 69, R_C0 = 65, R_C1 = 79, R_INS0 = 61, R_INS1 = 83;
/** The lines' angles, degrees from straight back: 15° apart, the rest position one step before line 1 (off the bank,
 *  so the wipers climb clear of it), the 11th step one after line 10. */
export const LINE_STEP = 15, FIRST = -67.5;
export const lineAngle = (line: number): number => FIRST + LINE_STEP * (line - 1);
/** The bank's insulating sheets span this arc: the rest angle lies outside it. */
export const BANK_ARC: [number, number] = [-78, 90];
export const SHAFT_R = 4.5, SHAFT_Y: [number, number] = [25, 400];
/** The rotary ratchet: long vertical teeth, one per line step, round the whole shaft. */
export const ROT_TEETH = 360 / LINE_STEP, ROT_R: [number, number] = [8.6, 11], ROT_Y: [number, number] = [30, 106];
/** The vertical ratchet: ten bevelled rings near the top, each with a flat underside for the pawl. */
export const VERT_Y0 = 115, VERT_R: [number, number] = [5, 9.5];
/** The vertical pawl's tip at rest (the holding pawl's too): under the face of the tooth it lifts next. */
export const PAWL_Y = VERT_Y0 + LEVEL_PITCH * (LEVELS - 1);
/** The rotary pawl and the rotary holding pawl, on the rotary ratchet: inside its length at every level. */
export const ROT_PAWL_Y = 95, ROT_HOLD_Y = 100;

const rad = (d: number) => (d * Math.PI) / 180;
const at = (deg: number, r: number, y: number): Vec3 => [r * Math.sin(rad(deg)), y, -r * Math.cos(rad(deg))];
/** The wipers' height (the ring wiper's) at a level: fractional while climbing. */
export const levelY = (level: number): number => WIPER_Y0 + LEVEL_PITCH * level;
/** A contact's centre: line 1–10 of level 1–10, wiper k (0 tip, 1 ring, 2 sleeve). */
export const contactAt = (level: number, line: number, k = 1): Vec3 => at(lineAngle(line), (R_C0 + R_C1) / 2, levelY(level) + WIPER_DY[k]);
/** Where wiper k's tip is for a shaft at (level, line). */
export const wiperTip = (level: number, line: number, k = 1): Vec3 => at(lineAngle(line), R_TIP, levelY(level) + WIPER_DY[k]);
/** The underside of vertical tooth j (0 lowest) for a shaft at a level: the face the pawl lifts. */
export const toothFace = (j: number, level: number): number => VERT_Y0 + LEVEL_PITCH * j + LEVEL_PITCH * level;
/** The shaft's turn for a line, as a quaternion about y (the carrier's blades point straight back at angle 0). */
export const shaftRot = (line: number): Quat => quatAxisAngle([0, 1, 0], -rad(lineAngle(line)));

/** The vertical armature pivots about x at this point; its pawl reaches back to the ratchet. A full pull turns it this
 *  far, which lifts the pawl's tip one level. */
export const V_PIVOT: Vec3 = [0, PAWL_Y, 40], V_PAWL_TIP_Z = VERT_R[1] + 0.5;
export const V_ALPHA = Math.asin(LEVEL_PITCH / (V_PIVOT[2] - V_PAWL_TIP_Z));
/** The rotary armature pivots about y; a full pull moves its pawl's tip one tooth along the ratchet. */
export const R_PIVOT: Vec3 = [40, ROT_PAWL_Y, 30], R_PAWL_TIP: Vec3 = [ROT_R[1] + 0.3, ROT_PAWL_Y, 0];
export const R_BETA = (rad(LINE_STEP) * ROT_R[1]) / Math.hypot(R_PIVOT[0] - R_PAWL_TIP[0], R_PIVOT[2] - R_PAWL_TIP[2]);
/** The holding pawls swing this far off their ratchets while the release magnet pulls. */
export const HOLD_SWING = rad(14);

// ---------------------------------------------------------------- materials

const mk = (o: Material): Material => M.make(o);
export const MATS = {
  frame: mk({ base: [0.16, 0.165, 0.17], metal: 0.35, rough: 0.55, coat: 0.15, label: 'die-cast frame, black enamel' }),
  steel: mk({ ...M.steel, label: 'steel' }),
  ratchet: mk({ base: [0.6, 0.6, 0.6], metal: 1, rough: 0.28, label: 'hardened steel' }),
  iron: mk({ base: [0.42, 0.43, 0.45], metal: 1, rough: 0.45, label: 'soft iron (armature, core)' }),
  bronze: mk({ base: [0.86, 0.6, 0.38], metal: 1, rough: 0.28, label: 'phosphor bronze (spring wipers)' }),
  contact: mk({ base: [1, 1, 1], metal: 0.6, rough: 0.32, label: 'nickel silver (bank contact)' }),
  insulator: mk({ ...M.phenolicPaper, label: 'phenolic paper (insulating sheet)' }),
  stop: mk({ ...M.bakelite, label: 'bakelite stop: the 11th step, no contact' }),
  coil: mk({ base: [0.36, 0.2, 0.1], metal: 0, rough: 0.55, coat: 0.3, label: 'coil, cotton-covered and lacquered' }),
  coilOn: (glow: Material['base']): Material => mk({ base: [0.42, 0.24, 0.12], metal: 0, rough: 0.5, coat: 0.3, emit: glow, glow: 0.28, bloom: 1.2, label: 'coil, carrying current' }),
  spring: mk({ base: [0.5, 0.5, 0.52], metal: 1, rough: 0.35, label: 'spring steel' }),
};
const NICKEL: RGB = [0.78, 0.76, 0.7];

// ---------------------------------------------------------------- geometry helpers

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const qm = (q: Quat, p: Vec3 = [0, 0, 0]): Mat4 => {
  const x = quatRotate(q, [1, 0, 0]), y = quatRotate(q, [0, 1, 0]), z = quatRotate(q, [0, 0, 1]), m = new Float32Array(16);
  m.set([...x, 0, ...y, 0, ...z, 0, p[0], p[1], p[2], 1]);
  return m;
};
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** A cylinder along y from y0 to y1, radius r, at (x, z). */
const cy = (x: number, z: number, y0: number, y1: number, r: number, seg = 24): Geo => transform(lathe([[0, y0], [r, y0], [r, y1], [0, y1]], { seg, crease: 60 }), tr([x, 0, z]));
/** A cylinder along an axis: y mapped onto it. */
const cyAlong = (a: Vec3, b: Vec3, r: number, seg = 16): Geo => {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d), y: Vec3 = [d[0] / L, d[1] / L, d[2] / L];
  const t: Vec3 = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x0: Vec3 = [y[1] * t[2] - y[2] * t[1], y[2] * t[0] - y[0] * t[2], y[0] * t[1] - y[1] * t[0]], lx = Math.hypot(...x0), x: Vec3 = [x0[0] / lx, x0[1] / lx, x0[2] / lx];
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], m = new Float32Array(16);
  m.set([...x, 0, ...y, 0, ...z, 0, a[0], a[1], a[2], 1]);
  return transform(lathe([[0, 0], [r, 0], [r, L], [0, L]], { seg, crease: 60 }), m);
};
/** A plate in the y, z plane (an outline of [z, y] points), t thick across x, centred on x = 0. */
const plateYZ = (outline: readonly (readonly [number, number])[], t: number): Geo => {
  const m = new Float32Array(16);
  // extrude's (u, h, v) = (z, x, y): a cyclic swap of the axes, so the winding and the normals survive
  m.set([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, -t / 2, 0, 0, 1]);
  return transform(extrude(outline, t), m);
};
/** A horizontal plate: an outline in x, z, t thick, its underside at y. */
const plateXZ = (outline: readonly (readonly [number, number])[], t: number, y: number): Geo => transform(extrude(outline, t), tr([0, y, 0]));
/** An annular sector in x, z: radii r0..r1 over the angles (degrees from straight back). */
function sector(r0: number, r1: number, a0: number, a1: number, n = 24): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const p = at(a0 + ((a1 - a0) * i) / n, r1, 0); out.push([p[0], p[2]]); }
  for (let i = n; i >= 0; i--) { const p = at(a0 + ((a1 - a0) * i) / n, r0, 0); out.push([p[0], p[2]]); }
  return out;
}
/** A magnet's coil: a bobbin with its flanges, along y, and the core's pole face standing proud of it. */
function coilGeo(x: number, z: number, y0: number, y1: number, r: number): { coil: Geo; core: Geo } {
  const f = 1.5;
  const coil = merge([cy(x, z, y0 + f, y1 - f, r, 28), cy(x, z, y0, y0 + f, r + 1.5, 28), cy(x, z, y1 - f, y1, r + 1.5, 28)], 'coil');
  return { coil, core: cy(x, z, y0 - 2, y1 + 2, r * 0.42, 20) };
}
/** The same along z (the rotary magnet's coils lie horizontally). */
function coilZ(x: number, y: number, z0: number, z1: number, r: number): { coil: Geo; core: Geo } {
  const m = qm(quatAxisAngle([1, 0, 0], Math.PI / 2), [x, y, 0]); // y → z
  const c = coilGeo(0, 0, -z1, -z0, r);
  return { coil: transform(c.coil, m), core: transform(c.core, m) };
}

// ---------------------------------------------------------------- the parts, memoized (none depends on the state)

interface Statics {
  frame: Geo; brackets: Geo; insulators: Geo; stops: Geo; bankPosts: Geo;
  shaft: Geo; rotRatchet: Geo; vertRatchet: Geo; carrier: Geo; wipers: Geo[];
  vArm: Geo; vCoils: Geo; vCores: Geo; vYoke: Geo;
  rArm: Geo; rCoils: Geo; rCores: Geo; rYoke: Geo;
  relArm: Geo; relCoil: Geo; relCore: Geo; relYoke: Geo;
  vHold: Geo; rHold: Geo; spring: Geo;
}
let memo: { detail: string; s: Statics } | null = null;
function statics(detail: 'full' | 'flat'): Statics {
  if (memo?.detail === detail) return memo.s;
  const E = ENVELOPE, back = -116, plate = back + 8;
  // the frame: a back plate, top and bottom brackets with the shaft's bearings
  const frame = bx(-E.w / 2, E.w / 2, 0, E.h, back, plate, 2);
  const bracket = (y0: number, y1: number) => merge([bx(-25, 25, y0, y1, plate, 12, 1.5), cy(0, 0, y0 - 4, y1 + 4, 10, 28)], 'bracket');
  const brackets = merge([bracket(8, 20), bracket(380, 392),
    // arms carrying the magnets back to the plate
    bx(-32, -27, 110, 115, plate, 54), bx(27, 32, 110, 115, plate, 54), bx(57, 63, 68, 74, plate, -18), bx(-66, -58, 112, 117, plate, 30)], 'brackets');
  // the bank: an insulating sheet between levels, the 11th-step stops, the clamping posts at its ends
  const sheet = sector(R_INS0, R_INS1, BANK_ARC[0], BANK_ARC[1], 28);
  const insulators = merge(Array.from({ length: LEVELS + 1 }, (_, l) => plateXZ(sheet, 0.8, levelY(l + 0.5) - 0.4)), 'insulators');
  const stops = merge(Array.from({ length: LEVELS }, (_, l) => { const p = at(lineAngle(OVERFLOW), R_TIP + 6, levelY(l + 1)); return bx(p[0] - 2, p[0] + 2, p[1] - 2.2, p[1] + 2.2, p[2] - 2, p[2] + 2); }), 'stops');
  const post = (deg: number) => { const p = at(deg, (R_INS0 + R_INS1) / 2, 0); return merge([cy(p[0], p[2], levelY(0.5) - 6, levelY(LEVELS + 0.5) + 6, 3.5, 16), bx(p[0] - 3, p[0] + 3, levelY(5), levelY(5) + 6, plate, p[2])], 'post'); };
  const bankPosts = merge([post(BANK_ARC[0] - 4), post(BANK_ARC[1] + 4)], 'bank posts');

  // the shaft (in its own frame: y as at rest, turned to line 0's angle by shaftRot)
  const shaft = cy(0, 0, SHAFT_Y[0], SHAFT_Y[1], SHAFT_R, 24);
  const star: [number, number][] = [];
  for (let i = 0; i < ROT_TEETH; i++) {
    const a = (i / ROT_TEETH) * 2 * Math.PI, b = ((i + 0.62) / ROT_TEETH) * 2 * Math.PI, c = ((i + 1) / ROT_TEETH) * 2 * Math.PI;
    star.push([ROT_R[0] * Math.cos(a), ROT_R[0] * Math.sin(a)], [ROT_R[1] * Math.cos(b), ROT_R[1] * Math.sin(b)], [ROT_R[0] * Math.cos(c - 0.001), ROT_R[0] * Math.sin(c - 0.001)]);
  }
  const rotRatchet = transform(extrude(star, ROT_Y[1] - ROT_Y[0]), tr([0, ROT_Y[0], 0]));
  const prof: [number, number][] = [[VERT_R[0], VERT_Y0 - 1]];
  for (let j = 0; j < LEVELS; j++) { const y = VERT_Y0 + LEVEL_PITCH * j; prof.push([VERT_R[0], y], [VERT_R[1], y], [VERT_R[1], y + 0.8], [VERT_R[0], y + LEVEL_PITCH - 0.4]); }
  const vertRatchet = lathe(prof, { seg: detail === 'flat' ? 16 : 40, crease: 40 });
  const carrier = merge([cy(0, 0, WIPER_Y0 - 8, WIPER_Y0 + 8, 10, 28), bx(-5, 5, WIPER_Y0 - 3.5, WIPER_Y0 + 3.5, -16, -8)], 'carrier');
  // three spring wipers, each a tapered blade from the carrier to the bank, a fork of two leaves at the tip
  const blade: [number, number][] = [[-3, -12], [3, -12], [1.4, -R_TIP - 1], [-1.4, -R_TIP - 1]];
  const wipers = WIPER_DY.map((dy) => merge([plateXZ(blade, 0.45, WIPER_Y0 + dy - 0.45 - 0.2), plateXZ(blade, 0.45, WIPER_Y0 + dy + 0.2)], 'wiper'));

  // the vertical magnet, in front: two coils under the armature's front, the armature on its pivot (built in the pivot's
  // frame), its pawl reaching back under the ratchet's tooth
  const [px, py, pz] = V_PIVOT, cT = py - 8;
  const vc = [-11, 11].map((x) => coilGeo(x, 66, cT - 44, cT - 2, 8.5));
  const vCoils = merge(vc.map((c) => c.coil), 'coils'), vCores = merge(vc.map((c) => c.core), 'cores');
  const vYoke = merge([bx(-24, 24, cT - 48, cT - 44, 50, 78), bx(-24, 24, cT - 48, py + 2, 48, 52), bx(-24, -20, py - 6, py + 4, 34, 50), bx(20, 24, py - 6, py + 4, 34, 50)], 'yoke');
  void px;
  const vArm = merge([
    bx(-20, 20, -1.5, 1.5, 6, 44, 0.8), // the armature plate over both cores
    cyAlong([-22, 0, 0], [22, 0, 0], 2.2), // its pivot pin
    plateYZ([[-pz + V_PAWL_TIP_Z, -0.5], [-pz + V_PAWL_TIP_Z + 4, -2.5], [6, -1.5], [6, 1.5], [-pz + V_PAWL_TIP_Z + 6, 2.5], [-pz + V_PAWL_TIP_Z, 1]], 3), // the pawl
  ], 'vertical armature');

  // the rotary magnet, on the right: two coils lying along z behind its armature, which turns about a vertical pin
  const [rx, ry, rz] = R_PIVOT;
  const rc = [ry - 11, ry + 11].map((y) => coilZ(62, y, -18, 22, 8.5));
  const rCoils = merge(rc.map((c) => c.coil), 'coils'), rCores = merge(rc.map((c) => c.core), 'cores');
  const rYoke = merge([bx(52, 72, ry - 24, ry + 24, -22, -18), bx(72, 76, ry - 24, ry + 24, -22, rz + 4), bx(rx - 4, 76, ry - 24, ry - 20, rz - 4, rz + 4)], 'yoke');
  const tip: Vec3 = [R_PAWL_TIP[0] - rx, 0, R_PAWL_TIP[2] - rz];
  const rArm = merge([
    bx(4, 34, -20, 20, -4.5, -1.5, 0.8), // the armature plate in front of the cores' faces
    cy(0, 0, -22, 22, 2.2, 14),
    tube([[0, 0, -3], [tip[0] * 0.5, 0, tip[2] * 0.6 - 2], [tip[0], 0, tip[2]]], 1.6, { sides: 8 }), // the pawl
  ], 'rotary armature');

  // the holding pawls, on the left, each turning about its own vertical pin; and the release magnet that lifts them
  const holdArm = (y: number, r: number): Geo => {
    const tipP: Vec3 = [-r - 0.3 + 34, 0, -14]; // from its pivot at (−34, y, 14) to the ratchet's left side
    return merge([cy(0, 0, -6, 6, 2.2, 14), tube([[0, 0, 0], [tipP[0] * 0.6, 0, tipP[2] * 0.5], tipP], 1.5, { sides: 8 })], `hold ${y}`);
  };
  const vHold = holdArm(PAWL_Y, VERT_R[1]), rHold = holdArm(ROT_HOLD_Y, ROT_R[1]);
  const rel = coilGeo(-62, 30, 120, 160, 8.5);
  const relYoke = merge([bx(-74, -50, 116, 120, 18, 42), bx(-74, -70, 116, 166, 18, 42)], 'yoke');
  const relArm = merge([bx(0, 26, -1.5, 1.5, -10, 10, 0.8), cyAlong([0, 0, -12], [0, 0, 12], 2)], 'release armature'); // pivots about z at the yoke's top

  const spring = tube(helix({ r: 9, from: 340, to: 374, pitch: 3.4 }), 1.1, { sides: 6 });
  const s: Statics = { frame, brackets, insulators, stops, bankPosts, shaft, rotRatchet, vertRatchet, carrier, wipers, vArm, vCoils, vCores, vYoke, rArm, rCoils, rCores, rYoke, relArm, relCoil: rel.coil, relCore: rel.core, relYoke, vHold, rHold, spring };
  memo = { detail, s };
  return s;
}

// ---------------------------------------------------------------- the bank's contacts, as instances

export interface SwPalette { busy: RGB; live: RGB }
/** Every contact: 10 levels × 10 lines × 3 (tip, ring, sleeve). A sleeve is the test wire: earthed when the line is
 *  busy (coloured so), the one the call holds glowing. */
export function contactInstances(s: State, busy: readonly (readonly boolean[])[], P: SwPalette): Instance[] {
  const out: Instance[] = [];
  for (let l = 1; l <= LEVELS; l++) for (let j = 1; j <= LINES; j++) for (let k = 0; k < 3; k++) {
    const held = s.mode === 'connected' && s.level === l && s.line === j, bad = busy[l - 1]?.[j - 1], sleeve = k === 2;
    const color: RGB = held ? P.live : sleeve && bad ? P.busy : NICKEL;
    out.push({ pos: contactAt(l, j, k), scale: [3, 0.6, R_C1 - R_C0], rot: shaftRot(j), color, emissive: held ? [P.live[0] * 0.6, P.live[1] * 0.6, P.live[2] * 0.6] : sleeve && bad ? [P.busy[0] * 0.12, P.busy[1] * 0.12, P.busy[2] * 0.12] : undefined });
  }
  return out;
}
export const contactData = (s: State, busy: readonly (readonly boolean[])[], P: SwPalette): Float32Array => packInstances(contactInstances(s, busy, P));
export const CONTACT_GEO = UNIT_BOX;

// ---------------------------------------------------------------- the model

const SM = 'Science Museum Group, object 1926-480 (pre-2000 type group selector, 422 × 170 × 200 mm)';
const ILL = 'the model’s size: no dimensioned drawing was found';
export const SW_HOME = { yaw: 0.4, pitch: 0.2, target: [0, 210, -10] as Vec3, dist: 660 };

export function swModel(m: Motion, detail: 'full' | 'flat' = 'full', glow: Material['base'] = '--sw-lit'): Model3 {
  const S = statics(detail), items: Item[] = [];
  const shaftAt: Vec3 = [0, LEVEL_PITCH * m.level, 0], rot = shaftRot(m.line);
  const add = (geo: Geo, mat: Material, name: string, group: string, info?: Item['info'], extra: Partial<Item> = {}) => items.push({ geo, mat, name, group, info, ...extra });
  add(S.frame, MATS.frame, 'frame', 'frame', { dim: `${ENVELOPE.h} mm tall, ${ENVELOPE.w} wide, ${ENVELOPE.d} deep overall`, source: SM, note: 'a die-cast back plate with brackets for the shaft’s bearings' });
  add(S.brackets, MATS.frame, 'frame', 'frame');
  const bankX: Vec3 = [0, 0, -70];
  add(S.insulators, MATS.insulator, 'bank', 'bank', { dim: `10 levels ${LEVEL_PITCH} mm apart [ill.]`, source: ILL, note: 'insulating sheets between the levels; each level holds ten lines three contacts deep' }, { explode: bankX });
  add(S.stops, MATS.stop, '11th step', 'bank', { note: 'past the last contact: a fully busy level leaves the wipers here, and that gives the busy tone' }, { explode: bankX });
  add(S.bankPosts, MATS.steel, 'bank', 'bank', undefined, { explode: bankX });

  const up: Vec3 = [0, 140, 0], shaftInfo = { note: 'its height is the digit dialled, its angle the line found: the position is the state' };
  for (const [geo, mat, name] of [[S.shaft, MATS.steel, 'shaft'], [S.rotRatchet, MATS.ratchet, 'rotary ratchet'], [S.vertRatchet, MATS.ratchet, 'vertical ratchet'], [S.carrier, MATS.steel, 'wiper carrier']] as const)
    add(geo, mat, name, 'shaft', name === 'shaft' ? shaftInfo : name === 'rotary ratchet' ? { note: `${ROT_TEETH} long teeth, one per ${LINE_STEP}° step: the rotary pawl turns it, the holding pawl keeps it` } : name === 'vertical ratchet' ? { note: 'ten rings with flat undersides: each pulse the pawl lifts one ring a level' } : undefined, { at: shaftAt, rot, explode: up });
  S.wipers.forEach((g, k) => add(g, MATS.bronze, `${WIPER_NAMES[k]} wiper`, 'wipers', { note: k === 2 ? 'the sleeve wiper tests the line: an earthed sleeve is busy, so the hunt moves on' : 'speech wire: connects the caller onward once the hunt stops' }, { at: shaftAt, rot, explode: up }));

  const vOn = m.vOn ? MATS.coilOn(glow) : MATS.coil, rOn = m.rOn ? MATS.coilOn(glow) : MATS.coil, relOn = m.relOn ? MATS.coilOn(glow) : MATS.coil;
  const vx: Vec3 = [0, 0, 110], rxp: Vec3 = [110, 0, 0], lx: Vec3 = [-110, 0, 0];
  add(S.vCoils, vOn, 'vertical magnet', 'vertical', { note: 'pulls while the dial’s loop is open: one pull for each pulse' }, { explode: vx });
  add(S.vCores, MATS.iron, 'vertical magnet', 'vertical', undefined, { explode: vx });
  add(S.vYoke, MATS.iron, 'vertical magnet', 'vertical', undefined, { explode: vx });
  add(S.vArm, MATS.iron, 'vertical armature', 'vertical', { note: `turns ${(V_ALPHA * 180 / Math.PI).toFixed(1)}° on its pin: its pawl lifts the shaft one tooth, ${LEVEL_PITCH} mm` }, { at: V_PIVOT, rot: quatAxisAngle([1, 0, 0], V_ALPHA * m.vArm), explode: vx });
  add(S.rCoils, rOn, 'rotary magnet', 'rotary', { note: 'steps the wipers one contact; its own interrupter springs break its circuit at the end of each stroke, so it steps again by itself: the hunt' }, { explode: rxp });
  add(S.rCores, MATS.iron, 'rotary magnet', 'rotary', undefined, { explode: rxp });
  add(S.rYoke, MATS.iron, 'rotary magnet', 'rotary', undefined, { explode: rxp });
  add(S.rArm, MATS.iron, 'rotary armature', 'rotary', { note: 'its pawl pushes the rotary ratchet one tooth a stroke' }, { at: R_PIVOT, rot: quatAxisAngle([0, 1, 0], R_BETA * m.rArm), explode: rxp });
  add(S.relCoil, relOn, 'release magnet', 'release', { note: 'on hang-up it lifts both holding pawls: the spring turns the shaft home, then it drops' }, { explode: lx });
  add(S.relCore, MATS.iron, 'release magnet', 'release', undefined, { explode: lx });
  add(S.relYoke, MATS.iron, 'release magnet', 'release', undefined, { explode: lx });
  add(S.relArm, MATS.iron, 'release armature', 'release', undefined, { at: [-74, 167, 30], rot: quatAxisAngle([0, 0, 1], -rad(7) * m.relArm), explode: lx });
  const swing = m.held ? 0 : HOLD_SWING;
  add(S.vHold, MATS.ratchet, 'holding pawl', 'release', { note: 'falls under the ratchet’s tooth as the shaft rises: it holds the level between pulses' }, { at: [-34, PAWL_Y, 14], rot: quatAxisAngle([0, 1, 0], -swing), explode: lx });
  add(S.rHold, MATS.ratchet, 'holding pawl', 'release', { note: 'the rotary detent: holds the wipers on a contact between steps' }, { at: [-34, ROT_HOLD_Y, 14], rot: quatAxisAngle([0, 1, 0], -swing), explode: lx });
  add(S.spring, MATS.spring, 'return spring', 'frame', { note: 'wound as the wipers turn out; it turns them home on release, and only at home can the shaft drop' });

  const front: Vec3 = [0, 0.2, 1], upN: Vec3 = [0, 1, 0];
  const anchors: StudioAnchor[] = [
    { text: 'bank', p: at(10, R_INS1, levelY(LEVELS) + 3), side: 'r', n: upN, on: 'bank' },
    { text: 'wipers', p: wiperTip(m.level, m.line), side: 'r', n: upN, on: 'wipers' },
    { text: 'shaft', p: [0, 205 + LEVEL_PITCH * m.level, SHAFT_R], side: 'l', n: front, on: 'shaft' },
    { text: 'vertical magnet', p: [-20, PAWL_Y - 30, 66], side: 'l', n: front, on: 'vertical' },
    { text: 'rotary magnet', p: [76, ROT_PAWL_Y, 0], side: 'r', n: front, on: 'rotary' },
    { text: 'release magnet', p: [-70, 140, 30], side: 'l', n: front, on: 'release' },
    { text: 'return spring', p: [9, 360, 0], side: 'r', n: front, on: 'frame', minor: true },
  ];
  const beats: Beat[] = [
    { title: 'Position is the state', text: 'The relay selector of the last step decodes a count. This machine stores none: the shaft’s height is the digit, the wipers’ angle the line. Dial and watch it climb, then turn.', view: SW_HOME },
    { title: 'One pulse, one tooth', text: `While the loop is open the vertical magnet pulls its armature ${(V_ALPHA * 180 / Math.PI).toFixed(0)}° on its pin; the pawl on its far end lifts the shaft by one ring of the vertical ratchet, ${LEVEL_PITCH} mm, and the holding pawl falls under it. Three pulses, three teeth (shown slower).`, view: { yaw: 1.45, pitch: 0.1, target: [0, PAWL_Y - 6, 30], dist: 210 }, show: ['vertical', 'shaft', 'release'], labels: false },
    { title: 'The hunt', text: 'Once the pulses stop, the rotary magnet steps the wipers along the level by itself: each stroke opens its own interrupter springs, the armature falls back and pulls again. The sleeve wiper tests each line; an earthed (busy) sleeve and it steps on, a free one and it stops.', view: { yaw: 0.25, pitch: 0.62, target: [0, levelY(4), -40], dist: 300 }, show: ['wipers', 'bank', 'shaft', 'rotary'] },
    { title: 'Three wipers, three contacts', text: `Tip, ring and sleeve: three spring wipers on one carrier, ${WIPER_DY[2] - WIPER_DY[1]} mm apart, over a bank three contacts deep [ill.]. Tip and ring carry the call on; the sleeve only tests and holds.`, view: { yaw: 0.45, pitch: 0.3, target: wiperTip(4, 5), dist: 110 }, show: ['wipers', 'bank'] },
    { title: 'Hang up', text: 'The release magnet lifts both holding pawls. The spring turns the wipers back to the home angle, off the bank, and only there can the shaft drop: it falls back to rest.', view: { yaw: -0.5, pitch: 0.22, target: [-20, 200, 0], dist: 640 }, show: ['release', 'shaft', 'wipers', 'frame'] },
  ];
  return { items, anchors, beats, floor: 0, look: { exposure: 1.1 } };
}

/** The bank's contacts and the 11th-step stops for the tests: where each sits. */
export const STOP_AT = (level: number): Vec3 => at(lineAngle(OVERFLOW), R_TIP + 6, levelY(level));
