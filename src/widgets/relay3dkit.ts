// The telephone relay on the studio renderer, in true geometry: a bakelite base, the soft-iron yoke, a core and pole
// face, a bobbin wound with wire, the armature on its knife edge, the return spring, the spring pile with its fixed
// NC and NO springs and the common blade, twin dome contacts. Built once in the armature's frame at angle 0; the
// physics (phys/relay.ts) then moves it each frame through relayPose(): the armature group turns about the hinge, the
// return spring stretches, the blade bends (live deform: its geometry refreshed in place) and its contacts ride with
// it. DOM-free, so the poses are tested against the lever arithmetic in Node.

import { lathe, merge, refresh, roundedBox, sweep, transform, tube, helix, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { RELAY, type RelaySample } from '../phys/relay';
import {
  ARM_T, ARM_W, ARM_X0, ARM_X1, AT_CONTACT, BT, BUT, BUT_R, EXAG, HINGE, POLE_AX, POLE_R, POLE_X, SPRING_LX, STUD_LX, TWIN_Z,
  XC, XR, XT, XTAIL, YB, YNC, YNO, armAt, push, theta,
} from './relay3dgeom';

const SRC = { bpo: 'BPO 3000-type relay; Smith, Telephony and Telegraphy', model: 'phys/relay.ts (the lumped model)' };
/** The return spring hangs from the yoke's lug (y0) to the armature's tail. */
const SPRING_Y0 = 12;
/** The armature's frame at angle 0: the tail point the spring holds, and the lifting stud's length (constant: it rides
 *  the blade's tip, which the stud itself pushes). */
const SPRING_TOP0 = armAt(SPRING_LX, 0, 0);
const STUD_LEN = armAt(STUD_LX, 0, theta(0))[1] - (YB + BT / 2);
/** Points along the blade (fixed, so its geometry refreshes in place). */
const BLADE_N = 28;

export type RelayDetail = 'full' | 'flat';

/** The blade's centre line for armature travel x and blade travel y: flat from the tails to the pile, then a smooth
 *  cantilever through the contact (at its height yc) to the tip under the stud (yt). */
export function bladeLine(q: Pick<RelaySample, 'x' | 'y'>): Vec3[] {
  const yc = YB - push(q.y) * AT_CONTACT, yt = YB - push(q.x);
  const out: Vec3[] = [[XTAIL, YB, 0], [(XTAIL + XR) / 2, YB, 0], [XR, YB, 0]];
  // Hermite pieces XR → XC → XT: clamped (slope 0) at the pile, the chord's slope at the contact and the last piece's
  // slope at the tip; the stud's push past the contact (over-travel) shows as the bend there.
  const m0 = 0, m1 = (yt - YB) / (XT - XR), m2 = (yt - yc) / (XT - XC);
  const herm = (x0: number, y0: number, s0: number, x1: number, y1: number, s1: number, f: number) => {
    const h = x1 - x0, f2 = f * f, f3 = f2 * f;
    return (2 * f3 - 3 * f2 + 1) * y0 + (f3 - 2 * f2 + f) * h * s0 + (-2 * f3 + 3 * f2) * y1 + (f3 - f2) * h * s1;
  };
  const half = (BLADE_N - 3) / 2;
  for (let i = 1; i <= half; i++) { const f = i / half; out.push([XR + (XC - XR) * f, herm(XR, YB, m0, XC, yc, m1, f), 0]); }
  for (let i = 1; i < BLADE_N - 3 - half + 1; i++) { const f = i / (BLADE_N - 3 - half); out.push([XC + (XT - XC) * f, herm(XC, yc, m1, XT, yt, m2, f), 0]); }
  return out;
}

const bladeSection = (): [number, number][] => [[-BT / 2, -3], [BT / 2, -3], [BT / 2, 3], [-BT / 2, 3]];
const bladeGeo = (q: Pick<RelaySample, 'x' | 'y'>) => sweep(bladeLine(q), bladeSection());

/** Rotation by a about z through point c (column-major). */
const turnAbout = (c: Vec3, a: number): Mat4 => {
  const co = Math.cos(a), si = Math.sin(a), m = new Float32Array(16);
  m[0] = co; m[1] = si; m[4] = -si; m[5] = co; m[10] = 1; m[15] = 1;
  m[12] = c[0] - (co * c[0] - si * c[1]); m[13] = c[1] - (si * c[0] + co * c[1]);
  return m;
};

/** Every part's motion at sample q: the armature turned by its angle about the hinge, the spring stretched to the
 *  armature's tail, the blade's contacts at the blade's height. The blade itself is refreshed (`blade`). */
export function relayPose(q: Pick<RelaySample, 'x' | 'y'>): Map<string, Mat4> {
  const th = theta(q.x), moves = new Map<string, Mat4>();
  moves.set('armature', turnAbout(HINGE, -th));
  const [sx, sy] = armAt(SPRING_LX, 0, th), k = (sy - SPRING_Y0) / (SPRING_TOP0[1] - SPRING_Y0), sp = new Float32Array(16);
  sp[0] = 1; sp[5] = k; sp[10] = 1; sp[15] = 1; sp[12] = sx - SPRING_TOP0[0]; sp[13] = SPRING_Y0 * (1 - k);
  moves.set('return spring', sp);
  const bt = new Float32Array(16);
  bt[0] = bt[5] = bt[10] = bt[15] = 1; bt[13] = -push(q.y) * AT_CONTACT;
  moves.set('blade contacts', bt);
  return moves;
}

interface RelayGeos {
  base: Geo; yoke: Geo; lug: Geo; core: Geo; pole: Geo; bobbin: Geo; winding: Geo; tape: Geo; tags: Geo; leads: Geo;
  armature: Geo; residual: Geo; knife: Geo; clip: Geo; clipScrews: Geo; stud: Geo; spring: Geo;
  bracket: Geo; pile: Geo; clamp: Geo; pileScrews: Geo; grooves: Geo; solderTags: Geo; fixedNC: Geo; fixedNO: Geo;
  dome: Geo; blade: Geo;
}

const memo = new Map<RelayDetail, RelayGeos>();
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.4) =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), translate([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
const translate = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const cylY = (x: number, z: number, y0: number, y1: number, r: number, seg = 32) =>
  transform(lathe([[0, y0], [r, y0], [r, y1], [0, y1]], { seg, crease: 30 }), translate([x, 0, z]));
/** A bar from (x0, y0) to (x1, y1) in the plane z = 0, thickness t (in the plane), width w (along z). */
const bar = (x0: number, y0: number, x1: number, y1: number, t: number, w: number) =>
  sweep([[x0, y0, 0], [x1, y1, 0]], [[-t / 2, -w / 2], [t / 2, -w / 2], [t / 2, w / 2], [-t / 2, w / 2]]);

function geos(detail: RelayDetail): RelayGeos {
  const hit = memo.get(detail);
  if (hit) return hit;
  const flat = detail === 'flat', seg = flat ? 14 : 40;
  // the armature in its own frame at angle 0 (from the hinge along x), placed at the hinge
  const arm = (lx0: number, lx1: number, ly0: number, ly1: number, z0: number, z1: number, r = 0.3) => box(HINGE[0] + lx0, HINGE[0] + lx1, HINGE[1] + ly0, HINGE[1] + ly1, z0, z1, r);
  const hs = RELAY.gRes * 1e3 * EXAG + 0.05;
  const dome = lathe([[0, 0], [BUT_R, 0], [BUT_R, BUT * 0.45], [BUT_R * 0.75, BUT * 0.85], [BUT_R * 0.35, BUT], [0, BUT]], { seg: flat ? 10 : 24, crease: 50 });
  const g: RelayGeos = {
    base: box(-50, 37, -4, 0, -13, 13, 0.9),
    yoke: merge([box(-10, 28, 0, 3, -7, 7, 0.3), box(25, 28, 0, 25, -7, 7, 0.3)], 'yoke'),
    lug: box(28, 34, 10, 12, -3, 3, 0.2),
    core: cylY(POLE_X, 0, 3, 23.5, 4.5, seg),
    pole: cylY(POLE_X, 0, 23.5, 25, POLE_R, seg),
    bobbin: merge([cylY(POLE_X, 0, 3, 4.5, 10, seg), cylY(POLE_X, 0, 21.5, 23, 10, seg)], 'bobbin'),
    // the winding: a body of turns and, on top, its outer layer as wire (the turns the eye can count)
    winding: flat ? cylY(POLE_X, 0, 4.5, 21.5, 9, seg)
      : merge([cylY(POLE_X, 0, 4.5, 21.5, 8.8, seg), tube(helix({ r: 8.9, pitch: 0.34, from: 4.7, to: 21.3, perTurn: 28 }), 0.17, { sides: 4 })], 'winding'),
    tape: cylY(POLE_X, 0, 11, 14, 9.2, seg),
    tags: merge([-3.5, 3.5].map((x) => box(POLE_X + x - 1, POLE_X + x + 1, 3, 4.4, 9.5, 12.6, 0.1)), 'tags'),
    leads: merge([-3.5, 3.5].map((x) => tube([[POLE_X + x, 3.2, 12], [POLE_X + x, 0.4, 12], [POLE_X + x, 0.4, 12.6], [POLE_X + x, -3.6, 12.6]], 0.45, { sides: 6, bend: 0.4 })), 'leads'),
    armature: arm(ARM_X0, ARM_X1, 0, ARM_T, -ARM_W / 2, ARM_W / 2, 0.5),
    residual: cylY(HINGE[0] + POLE_AX, 0, HINGE[1] - hs, HINGE[1], 1.3, 18),
    knife: transform(roundedBox(2.2, 2.2, ARM_W, 0.1, 1), mul(translate([HINGE[0], HINGE[1] - 1.1, 0]), rotZ(Math.PI / 4))),
    clip: arm(-0.5, 6.5, ARM_T, ARM_T + 0.9, -(ARM_W - 2) / 2, (ARM_W - 2) / 2, 0.2),
    clipScrews: merge([-3.2, 3.2].map((z) => cylY(HINGE[0] + 4.5, z, HINGE[1] + ARM_T + 0.9, HINGE[1] + ARM_T + 1.9, 0.7, 16)), 'screws'),
    stud: cylY(HINGE[0] + STUD_LX, 0, HINGE[1] - STUD_LEN, HINGE[1], 0.9, 18),
    spring: merge([
      tube(helix({ r: 1.5, pitch: (SPRING_TOP0[1] - SPRING_Y0 - 1.6) / 9, from: SPRING_Y0 + 0.8, to: SPRING_TOP0[1] - 0.8, at: [SPRING_TOP0[0], 0], perTurn: flat ? 8 : 20 }), 0.3, { sides: flat ? 4 : 6 }),
      tube([[SPRING_TOP0[0], SPRING_Y0, 0], [SPRING_TOP0[0], SPRING_Y0 + 0.8, 0]], 0.3, { sides: 6 }),
      tube([[SPRING_TOP0[0], SPRING_TOP0[1] - 0.8, 0], [SPRING_TOP0[0], SPRING_TOP0[1], 0]], 0.3, { sides: 6 }),
    ], 'spring'),
    bracket: box(-42, XR, 0, 8, -6, 6, 0.3),
    pile: merge([box(-42, XR, 8, YNO - BT / 2, -5, 5, 0.15), box(-42, XR, YNO + BT / 2, YB - BT / 2, -5, 5, 0.15), box(-42, XR, YB + BT / 2, YNC - BT / 2, -5, 5, 0.15)], 'pile'),
    clamp: box(-42, XR, YNC + BT / 2, YNC + 3, -5, 5, 0.3),
    pileScrews: merge([-3.2, 3.2].flatMap((z) => [cylY(-38, z, 8, YNC + 3.6, 0.8, 16), cylY(-38, z, YNC + 3, YNC + 4.2, 1.5, 20)]), 'pile screws'),
    grooves: merge([YNO, YB, YNC].map((yy) => box(-41.4, XR - 0.8, yy - 0.45, yy + 0.45, 4.85, 5.2, 0)), 'grooves'),
    solderTags: merge([YNO, YB, YNC].map((yy) => box(XTAIL - 3.2, XTAIL + 0.2, yy - 0.3, yy + 0.3, -1.4, 1.4, 0.1)), 'solder tags'),
    fixedNC: bar(XTAIL, YNC, XC + 2.5, YNC, BT, 6),
    fixedNO: bar(XTAIL, YNO, XC + 2.5, YNO, BT, 6),
    dome,
    blade: bladeGeo({ x: 0, y: 0 }),
  };
  memo.set(detail, g);
  return g;
}

const mul = (a: Mat4, b: Mat4): Mat4 => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
};
const rotZ = (a: number): Mat4 => turnAbout([0, 0, 0], a);

/** Bend the blade to sample q (its geometry refreshed in place: the renderer re-uploads it). */
export function bendBlade(detail: RelayDetail, q: Pick<RelaySample, 'x' | 'y'>): void {
  const g = geos(detail);
  refresh(g.blade, bladeGeo(q));
}

export interface RelayLook {
  detail: RelayDetail;
  /** Coil current (A) and the contacts' states at the shown sample. */
  i: number; nc: boolean; no: boolean;
}

/** The relay at rest (armature frame at angle 0); relayPose() and bendBlade() put it where the model says. */
export function relayModel(look: RelayLook): Model3 {
  const G = geos(look.detail), items: Item[] = [];
  const iron = M.make({ base: [0.42, 0.43, 0.45], metal: 1, rough: 0.5, label: 'soft iron (nickel-plated)' });
  const armIron = M.make({ base: [0.6, 0.6, 0.62], metal: 1, rough: 0.32, label: 'soft iron armature, plated' });
  const g = Math.min(1, Math.abs(look.i) / 0.06);
  const wire = M.make({ base: [0.72, 0.38, 0.16], metal: 0.6, rough: 0.3, coat: 0.6, emit: '--rl-glow', glow: 0.35 * g, label: 'enamelled copper wire' });
  const contact = (closed: boolean): Material => (closed ? { ...M.silver, emit: '--rl-contact', glow: 0.9, label: 'silver contact (closed)' } : { ...M.silver, label: 'silver contact' });
  const tag = M.make({ base: [0.85, 0.85, 0.8], metal: 1, rough: 0.25, label: 'tinned brass' });
  const studMat = M.make({ base: [0.85, 0.8, 0.66], metal: 0, rough: 0.5, label: 'insulating stud (phenolic)' });
  const add = (geo: Geo, mat: Material, name: string, group: string, extra: Partial<Item> = {}) => items.push({ geo, mat, name, group, cut: 'none', ...extra });

  add(G.base, M.bakelite, 'base', 'frame', { info: { dim: '87 × 26 mm', note: 'moulded phenolic, carries the yoke and the spring pile' } });
  add(G.yoke, iron, 'yoke', 'frame', { info: { note: 'the return path for the flux: core → yoke → knife edge → armature → pole', source: SRC.bpo } });
  add(G.lug, iron, 'spring lug', 'frame');
  add(G.core, iron, 'core', 'coil', { cut: 'section', explode: [0, 0, 22], info: { dim: '9 mm across', note: 'soft iron: magnetised only while current flows' } });
  add(G.pole, iron, 'pole face', 'coil', { cut: 'section', explode: [0, 0, 22], info: { dim: `${(RELAY.A * 1e6).toFixed(0)} mm²`, source: SRC.model, note: 'the area the pull acts over' } });
  add(G.bobbin, M.bakelite, 'bobbin', 'coil', { cut: 'section', explode: [0, 0, 22] });
  add(G.winding, wire, 'coil', 'coil', { cut: 'section', explode: [0, 0, 22], info: { dim: `${RELAY.N} turns, ${RELAY.Rc} Ω`, source: SRC.model, note: 'faintly warm while it carries current (drawn)' } });
  add(G.tape, M.make({ base: [0.78, 0.66, 0.42], metal: 0, rough: 0.7, label: 'cotton tape' }), 'tape wrap', 'coil', { cut: 'section', explode: [0, 0, 22] });
  add(G.tags, tag, 'coil tags', 'coil', { explode: [0, 0, 22] });
  add(G.leads, M.copper, 'coil leads', 'coil', { explode: [0, 0, 22] });
  // the armature group: everything the hinge turns
  add(G.armature, armIron, 'armature', 'armature', { explode: [0, 16, 0], info: { dim: '52 × 12 × 2.5 mm', source: SRC.bpo, note: `turns about the knife edge; its gap at the pole drawn ×${EXAG}` } });
  add(G.residual, M.copper, 'residual stud', 'armature', { explode: [0, 16, 0], info: { dim: `${(RELAY.gRes * 1e3).toFixed(2)} mm (drawn ×${EXAG})`, source: SRC.bpo, note: 'non-magnetic: the armature never touches the iron, so it lets go sooner' } });
  add(G.clip, iron, 'hinge clip', 'armature', { explode: [0, 16, 0] });
  add(G.clipScrews, M.steel, 'clip screws', 'armature', { explode: [0, 16, 0] });
  add(G.stud, studMat, 'lifting stud', 'armature', { explode: [0, 16, 0], info: { note: 'pushes the common blade down as the armature closes' } });
  add(G.knife, iron, 'knife edge', 'frame', { info: { note: 'the armature rocks on this edge: no bearing to wear' } });
  add(G.spring, M.steel, 'return spring', 'return spring', { info: { source: SRC.model, note: `lumped: ${RELAY.k} N/m, ${RELAY.F0} N preload` } });
  // the spring pile
  add(G.bracket, iron, 'pile bracket', 'pile', { explode: [-12, 0, 0] });
  add(G.pile, M.bakelite, 'insulators', 'pile', { explode: [-12, 0, 0] });
  add(G.clamp, iron, 'clamp plate', 'pile', { explode: [-12, 0, 0] });
  add(G.pileScrews, M.steel, 'pile screws', 'pile', { explode: [-12, 0, 0] });
  add(G.grooves, M.make({ base: [0.07, 0.04, 0.03], metal: 0, rough: 0.6, label: 'bakelite' }), 'insulators', 'pile', { explode: [-12, 0, 0] });
  add(G.solderTags, tag, 'solder tags', 'pile', { explode: [-12, 0, 0] });
  add(G.fixedNC, M.nickelSilver, 'NC spring', 'pile', { explode: [-12, 0, 0], info: { note: 'normally closed: touches the blade at rest' } });
  add(G.fixedNO, M.nickelSilver, 'NO spring', 'pile', { explode: [-12, 0, 0], info: { note: 'normally open: the blade meets it when the coil pulls' } });
  add(G.blade, M.tint(M.nickelSilver, [0.84, 0.76, 0.62], 'nickel silver (common blade)'), 'common blade', 'blade', { explode: [-12, 0, 0], shadow: true, info: { source: SRC.model, note: 'a cantilever: the stud bends it past the contact (over-travel presses the contacts together)' } });
  // contacts: twin domes on each spring, facing the blade's
  const at = (x: number, y: number, z: number, flip = false) => transform(G.dome, flip ? mul(translate([x, y, z]), rotZ(Math.PI)) : translate([x, y, z]));
  const pair = (y: number, flip: boolean) => merge([-TWIN_Z, TWIN_Z].map((z) => at(XC, y, z, flip)), 'domes');
  add(pair(YNC - BT / 2, true), contact(look.nc), 'NC contact', 'pile', { explode: [-12, 0, 0] });
  add(pair(YNO + BT / 2, false), contact(look.no), 'NO contact', 'pile', { explode: [-12, 0, 0] });
  add(pair(YB + BT / 2, false), contact(look.nc), 'blade contacts', 'blade contacts', { explode: [-12, 0, 0] });
  add(pair(YB - BT / 2, true), contact(look.no), 'blade contacts', 'blade contacts', { explode: [-12, 0, 0] });

  const [ax, ay] = armAt(-24, ARM_T, 0);
  const anchors: StudioAnchor[] = [
    { text: 'coil', p: [POLE_X + 6.4, 9, 6.4], side: 'r', n: [0.7, 0, 0.7], on: 'coil' },
    { text: 'armature', p: [ax, ay, 0], side: 't', n: [0, 1, 0], on: 'armature' },
    { text: 'yoke', p: [16, 1.5, 7], side: 'b', n: [0, 0, 1] },
    { text: 'return spring', p: [SPRING_TOP0[0] + 1.5, 17, 0], side: 'r', n: [1, 0, 0.3], minor: true },
    { text: 'NC', p: [-29, YNC + BT / 2, 3], side: 't', n: [-0.5, 0, 1], on: 'pile' },
    { text: 'NO', p: [-29, YNO - BT / 2, 3], side: 'b', n: [-0.5, 0, 1], on: 'pile' },
    { text: 'common', p: [XC, YB, 3], side: 'r', n: [-0.5, 0, 1], on: 'blade contacts' },
  ];
  const front = { yaw: 0, pitch: 0.12, target: [-8, 13, 0] as Vec3, dist: 120 };
  const beats: Beat[] = [
    { title: 'The coil', text: `${RELAY.N} turns of enamelled wire round a soft-iron core. Current makes the core a magnet; the yoke carries its flux round to the knife edge.`, view: { yaw: -0.5, pitch: 0.3, target: [0, 13, 0], dist: 90 }, frame: ['coil', 'yoke'], show: ['coil', 'frame'], cut: 1 },
    { title: 'The gap', text: `The armature lies over the pole face with a gap (drawn ×${EXAG}). The pull grows as the gap closes, so once it starts to move it snaps over.`, view: front, frame: ['armature', 'pole face'], show: ['armature', 'coil'] },
    { title: 'Knife edge and residual stud', text: 'The armature rocks on a steel edge, nothing to wear. A brass stud keeps it off the iron when closed, so the core lets go promptly when the current stops.', view: { yaw: 0.35, pitch: 0.2, target: [22, 24, 0], dist: 55 }, frame: ['knife edge', 'residual stud', 'hinge clip'], show: ['armature', 'frame'] },
    { title: 'The contacts', text: 'The lifting stud pushes the common blade from its NC spring to the NO spring. Silver domes, two on each spring, so one dirty contact does not lose the circuit. Press Play: it bounces before it settles.', view: { yaw: -0.25, pitch: 0.15, target: [-28, 17, 0], dist: 60 }, frame: ['pile', 'blade', 'blade contacts', 'lifting stud'], show: ['pile', 'blade', 'blade contacts', 'armature'] },
  ];
  return {
    items, anchors, beats, floor: -4,
    cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [14] },
    look: { exposure: 1 },
  };
}

export const RELAY_HOME = { target: [-8, 13, 0] as Vec3, yaw: -0.42, pitch: 0.34, dist: 118 };
