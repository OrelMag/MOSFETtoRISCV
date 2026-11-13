// The Teletype Model 33's selector for the studio renderer (DOM-free, tested). What moves and when is comm/teletype33.ts's
// (ttyPose: the shaft, the clutch, the sleeve, the armature, each follower and push lever); this draws it. No dimension of
// the 33's selector was found (Bulletin 310B has them), so every size is illustrative, in millimetres of a plausible
// unit: a cast frame, the main shaft with the motor's gear, the clutch drum with its shoe lug and the trip pawl, the cam
// sleeve with eight notched cams staggered round it, eight followers on a common pivot rod, their push levers, the
// armature's extension bar over the followers' tails, the selector magnet's two coils, and the 20 mA line into them.

import { extrude, lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Mat4, Vec3 } from '../gl/math';
import { notchDeg, REV_UNITS, TTY33, type TtyPose } from '../comm/teletype33';

// ---------------------------------------------------------------- where things are (mm, illustrative)

export const SHAFT_Y = 40, SHAFT_R = 3;
export const CAM_X0 = 0, CAM_PITCH = 9, CAM_T = 3.5, CAM_R = 15, NOTCH_DEPTH = 4.5, NOTCH_DEG = 26;
export const camX = (i: number): number => CAM_X0 + i * CAM_PITCH;
/** The followers' pivot rod (z, y), the tip resting on the cam's top, the tail over which the armature's bar lies. */
export const PIVOT: [number, number] = [-26, 70], TIP: [number, number] = [0, SHAFT_Y + CAM_R], TAIL: [number, number] = [-40, 77];
export const BAR_Y0 = 79.5, BAR_LIFT = 5;
const CLUTCH: [number, number] = [-24, -12], CLUTCH_R = 11, GEAR_X = -44, MAGNET_X = 94;
/** How far a follower turns when it drops fully into its notch (radians). */
export const DROP_ANGLE = Math.atan2(NOTCH_DEPTH, TIP[0] - PIVOT[0]);

const mk = (m: Material): Material => M.make(m);
export const MATS = {
  frame: mk({ base: [0.42, 0.44, 0.46], metal: 0.3, rough: 0.55, coat: 0.3, label: 'cast frame, grey enamel' }),
  steel: mk({ ...M.steel, label: 'hardened steel' }),
  cam: mk({ base: [0.6, 0.62, 0.64], metal: 0.55, rough: 0.42, coat: 0.25, label: 'selector cam: oiled steel, one notch' }),
  lever: mk({ base: [0.62, 0.63, 0.65], metal: 0.9, rough: 0.35, label: 'selector lever (follower)' }),
  brass: mk({ ...M.brass, label: 'brass' }),
  push: mk({ ...M.brass, label: 'push lever: holds the level it read' }),
  pushSet: mk({ ...M.brass, emit: '--tt-mark', glow: 0.6, label: 'push lever, set: this level was marking' }),
  coil: mk({ ...M.enamel, label: 'selector magnet coil: enamelled copper' }),
  iron: mk({ base: [0.35, 0.36, 0.38], metal: 0.8, rough: 0.45, label: 'magnet iron: core and armature' }),
  wire: mk({ ...M.copper, label: 'the line: a 20 mA loop' }),
  wireLive: mk({ ...M.copper, emit: '--tt-mark', glow: 0.7, bloom: 1.4, label: 'the line, marking: current flows' }),
  clutchOn: mk({ ...M.steel, emit: '--tt-turn', glow: 0.25, label: 'clutch, engaged: the sleeve turns with the shaft' }),
};

// ---------------------------------------------------------------- shapes

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.4): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** A solid along x (lathe's axis turned onto x), radius r, at (y, z). */
const alongX = (y: number, z: number): Mat4 => { const m = new Float32Array(16); m.set([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, y, z, 1]); return m; };
const rodX = (x0: number, x1: number, r: number, y: number, z: number, seg = 24): Geo => transform(lathe([[0, x0], [r, x0], [r, x1], [0, x1]], { seg, crease: 60 }), alongX(y, z));
/** An outline in the yz plane (u = y, v = −z, about (y0, z0)) pushed along x from x0 by t: a cam, a lever, a gear. */
const plateX = (outline: [number, number][], x0: number, t: number, y0 = 0, z0 = 0): Geo => {
  const m = new Float32Array(16); m.set([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, x0, y0, z0, 1]);
  return transform(extrude(outline, t), m);
};
/** A point at angle φ (degrees, 90 = top) and radius r in the yz plane, as plateX's (u, v). */
const polar = (phi: number, r: number): [number, number] => { const a = (phi * Math.PI) / 180; return [r * Math.sin(a), -r * Math.cos(a)]; };

/** Cam i's outline turned by the sleeve: a disc with one notch, which is at the top when sleeve = notchDeg(i). */
export function camOutline(i: number, sleeve: number): [number, number][] {
  const c = 90 + notchDeg(i) - sleeve, out: [number, number][] = [], h = NOTCH_DEG / 2;
  for (let a = c + h; a < c + 360 - h - 1e-9; a += 6) out.push(polar(a, CAM_R));
  // the notch: down its far flank, a rounded floor, up the near one
  out.push(polar(c - h, CAM_R));
  for (let k = 0; k <= 6; k++) { const a = c - h + (k / 6) * NOTCH_DEG, d = Math.sin((k / 6) * Math.PI); out.push(polar(a, CAM_R - NOTCH_DEPTH * (0.55 + 0.45 * d))); }
  return out;
}
/** Where cam i's notch is now (degrees, 90 = under its follower). */
export const notchAt = (i: number, sleeve: number): number => (((90 + notchDeg(i) - sleeve) % 360) + 360) % 360;

/** A bar of width w along a polyline in the yz plane ((z, y) points), as plateX's outline. */
function barOutline(pts: [number, number][], w: number): [number, number][] {
  const L: [number, number][] = [], R: [number, number][] = [];
  pts.forEach((p, k) => {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy) || 1;
    const nz = -dy / l, ny = dz / l;
    L.push([p[1] + ny * w / 2, -(p[0] + nz * w / 2)]); R.push([p[1] - ny * w / 2, -(p[0] - nz * w / 2)]);
  });
  return [...L, ...R.reverse()];
}
/** A follower turned by angle a about the pivot (a > 0: the tip down into the notch, the tail up). */
export function leverPoints(a: number): [number, number][] {
  const c = Math.cos(a), s = Math.sin(a), turn = ([z, y]: [number, number]): [number, number] => {
    const dz = z - PIVOT[0], dy = y - PIVOT[1];
    return [PIVOT[0] + dz * c + dy * s, PIVOT[1] - dz * s + dy * c];
  };
  return [TAIL, PIVOT, TIP].map(turn);
}
function gearOutline(rot: number): [number, number][] {
  const out: [number, number][] = [], n = 30;
  for (let k = 0; k < n; k++) {
    const a = rot + (k * 360) / n;
    out.push(polar(a - 4, 14), polar(a - 2, 16.5), polar(a + 2, 16.5), polar(a + 4, 14));
  }
  return out;
}

interface Statics { frame: Geo; shaft: Geo; sleeve: Geo; drum: Geo; pivot: Geo; coils: Geo; cores: Geo; line: Geo; spring: Geo }
let memo: Statics | null = null;
function statics(): Statics {
  if (memo) return memo;
  const x0 = camX(0) - 10, x1 = camX(TTY33.data - 1) + 10;
  const frame = merge([
    bx(-70, 112, 0, 5, -72, 30, 0.8),
    bx(-34, -30, 5, 62, -14, 14, 0.6), bx(x1 + 4, x1 + 8, 5, 62, -14, 14, 0.6), // shaft bearings
    bx(x0 - 6, x0 - 2, 5, PIVOT[1] + 4, PIVOT[0] - 4, PIVOT[0] + 4, 0.5), bx(x1 + 4, x1 + 8, 5, PIVOT[1] + 4, PIVOT[0] - 4, PIVOT[0] + 4, 0.5), // pivot posts
    bx(MAGNET_X - 9, MAGNET_X + 9, 5, 9, -60, -28, 0.5), // magnet bracket
  ], 'frame');
  const shaft = rodX(-62, x1 + 12, SHAFT_R, SHAFT_Y, 0);
  const sleeve = transform(lathe([[SHAFT_R, CLUTCH[1]], [7, CLUTCH[1]], [7, x1 + 2], [SHAFT_R, x1 + 2]], { seg: 32, crease: 60 }), alongX(SHAFT_Y, 0));
  const drum = transform(lathe([[SHAFT_R, CLUTCH[0]], [CLUTCH_R, CLUTCH[0]], [CLUTCH_R, CLUTCH[1]], [SHAFT_R, CLUTCH[1]]], { seg: 40, crease: 60 }), alongX(SHAFT_Y, 0));
  const pivot = rodX(x0 - 6, x1 + 8, 1.6, PIVOT[1], PIVOT[0]);
  const coil = (z: number) => transform(lathe([[2.5, 0], [6, 0], [6, 22], [2.5, 22]], { seg: 28 }), tr([MAGNET_X, 46, z]));
  const core = (z: number) => transform(lathe([[0, 0], [2.5, 0], [2.5, 27], [0, 27]], { seg: 20 }), tr([MAGNET_X, 45, z]));
  const coils = merge([coil(-36), coil(-52)], 'coils'), cores = merge([core(-36), core(-52), bx(MAGNET_X - 6, MAGNET_X + 6, 9, 46, -58, -30, 0.4)], 'cores');
  const line = merge([
    tube([[MAGNET_X + 6, 50, -36], [MAGNET_X + 14, 50, -36], [MAGNET_X + 14, 6, -60], [MAGNET_X + 14, 6, -72]], 0.8, { sides: 8, bend: 4 }),
    tube([[MAGNET_X + 6, 50, -52], [MAGNET_X + 11, 50, -52], [MAGNET_X + 11, 6, -64], [MAGNET_X + 11, 6, -72]], 0.8, { sides: 8, bend: 4 }),
  ], 'line');
  // the clutch's spring wound on the drum's hub
  const coilPts: Vec3[] = Array.from({ length: 120 }, (_, k) => { const a = (k / 120) * 6 * 2 * Math.PI; return [CLUTCH[0] - 6 + (k / 120) * 5, SHAFT_Y + 5 * Math.sin(a), 5 * Math.cos(a)]; });
  const spring = tube(coilPts, 0.5, { sides: 6 });
  memo = { frame, shaft, sleeve, drum, pivot, coils, cores, line, spring };
  return memo;
}

// ---------------------------------------------------------------- the model

/** No dimension of the 33's selector was found: what the hover cards say instead of a size. */
const DRAWN = 'proportions drawn, not measured';

export const TT_HOME: OrbitView = { target: [24, 48, -14], yaw: 0.55, pitch: 0.38, dist: 230 };
/** The tour's moments: transmitter time (units since the start edge) and clock error. */
export const TOUR = [
  { t: -1.2, err: 0 }, { t: 0.15, err: 0 }, { t: 4.5, err: 0 }, { t: 10.6, err: 0 }, { t: 9.3, err: -0.058 },
] as const;

export function teletypeModel(p: TtyPose): Model3 {
  const S = statics(), items: Item[] = [];
  const add = (geo: Geo, mat: Material, name: string, group: string, extra: Partial<Item> = {}) => items.push({ geo, mat, name, group, ...extra });
  add(S.frame, MATS.frame, 'frame', 'frame', { cut: 'none', info: { dim: DRAWN } });
  add(merge([S.shaft, plateX(gearOutline(p.shaft), GEAR_X, 6, SHAFT_Y, 0)], 'drive'), MATS.steel, 'main shaft', 'drive', { info: { note: 'turned by the motor all the time the machine is on' } });
  add(merge([S.drum, S.spring], 'clutch'), p.clutch ? MATS.clutchOn : MATS.brass, 'clutch', 'drive', { info: { note: p.clutch ? 'engaged: the sleeve turns with the shaft for one revolution' : 'held by the trip pawl: the shaft turns, the sleeve does not' } });
  // the clutch's shoe lug turns with the sleeve; the trip pawl stands in its way until the start lever lifts it
  const lugA = 90 + p.sleeve * -1, [ly, lz] = [SHAFT_Y + (CLUTCH_R + 1.2) * Math.sin((lugA * Math.PI) / 180), (CLUTCH_R + 1.2) * Math.cos((lugA * Math.PI) / 180)];
  add(bx(CLUTCH[0] + 2, CLUTCH[1] - 2, ly - 1.5, ly + 1.5, lz - 1.5, lz + 1.5, 0.3), MATS.steel, 'clutch shoe lug', 'drive', { cut: 'none' });
  const pawlUp = p.clutch ? 5 : 0;
  add(bx(CLUTCH[0] + 1, CLUTCH[1] - 1, SHAFT_Y + CLUTCH_R + 2.8 + pawlUp, SHAFT_Y + CLUTCH_R + 7 + pawlUp, -5, -1, 0.3), MATS.steel, 'clutch trip pawl', 'magnet', { cut: 'none' });
  // the start lever: from the armature along the frame to the trip pawl
  const startY = 30 + (p.clutch ? 3 : 0);
  add(merge([bx(CLUTCH[0] + 2, MAGNET_X - 4, startY - 1, startY + 1, -22, -19, 0.3), bx(CLUTCH[0] + 2, CLUTCH[0] + 5, startY, SHAFT_Y + CLUTCH_R + 3 + pawlUp, -5, -2, 0.3)], 'start'), MATS.lever, 'start lever', 'magnet', { cut: 'none', info: { note: 'the start edge lets the armature fall; this lever lifts the trip pawl and the clutch engages' } });
  // the sleeve and its cams
  const cams = Array.from({ length: TTY33.data }, (_, i) => plateX(camOutline(i, p.sleeve), camX(i) - CAM_T / 2, CAM_T, SHAFT_Y, 0));
  add(S.sleeve, MATS.steel, 'cam sleeve', 'sleeve', { info: { note: `one revolution in ${REV_UNITS} units of its own clock, a little less than the ${TTY33.data + 3}-unit character` } });
  add(merge(cams, 'cams'), MATS.cam, 'selector cams', 'sleeve', { info: { dim: DRAWN, note: 'one notch each, offset round the sleeve: notch i meets its lever in the middle of data unit i' } });
  // followers, push levers, the pivot rod
  const levers: Geo[] = [], push: Geo[] = [], pushSet: Geo[] = [];
  for (let i = 0; i < TTY33.data; i++) {
    levers.push(plateX(barOutline(leverPoints(p.drop[i] * DROP_ANGLE), 2.4), camX(i) - 1.2, 2.4));
    const d = p.set[i] ? 6 : 0;
    (p.set[i] ? pushSet : push).push(bx(camX(i) - 1.3, camX(i) + 1.3, SHAFT_Y + CAM_R + 4 - d, SHAFT_Y + CAM_R + 24 - d, 4, 7.5, 0.3));
  }
  add(merge([...levers, S.pivot], 'levers'), MATS.lever, 'selector levers', 'levers', { cut: 'none', info: { note: 'each drops into its notch only if the armature is marking then: it copies the line in the middle of its unit' } });
  if (push.length) add(merge(push, 'push'), MATS.push, 'push levers', 'levers', { cut: 'none' });
  if (pushSet.length) add(merge(pushSet, 'pushSet'), MATS.pushSet, 'push levers (set)', 'levers', { cut: 'none' });
  // the magnet, its armature and the extension bar over the followers' tails
  const lift = p.armature * BAR_LIFT;
  add(S.coils, MATS.coil, 'selector magnet', 'magnet', { cut: 'none', info: { note: 'on the 20 mA line: current (marking) attracts the armature' } });
  add(S.cores, MATS.iron, 'magnet core', 'magnet', { cut: 'none' });
  add(merge([bx(MAGNET_X - 8, MAGNET_X + 8, 69 + lift * 0.4, 71.5 + lift * 0.4, -60, -28, 0.4), bx(camX(0) - 6, MAGNET_X - 6, BAR_Y0 + lift, BAR_Y0 + 2 + lift, TAIL[0] - 2.5, TAIL[0] + 2.5, 0.3), bx(MAGNET_X - 8, MAGNET_X - 5, 71 + lift * 0.4, BAR_Y0 + 2 + lift, -42, -38, 0.3)], 'armature'), MATS.iron, 'armature', 'magnet', { cut: 'none', info: { note: p.armature ? 'attracted (marking): its bar is clear of the lever tails' : 'released (spacing): its bar holds the lever tails down, so no lever can drop' } });
  add(S.line, p.level ? MATS.wireLive : MATS.wire, 'the line', 'magnet', { cut: 'none' });

  const anchors: StudioAnchor[] = [
    { text: 'selector magnet', p: [MAGNET_X, 60, -28], side: 'r', n: [0, 0, 1], on: 'magnet' },
    { text: 'armature', p: [MAGNET_X - 20, BAR_Y0 + 2 + lift, TAIL[0]], side: 'r', n: [0, 1, 0], on: 'magnet' },
    { text: 'clutch', p: [CLUTCH[0] + 6, SHAFT_Y - CLUTCH_R, 6], side: 'l', n: [0, 0, 1], on: 'drive' },
    { text: 'main shaft', p: [-56, SHAFT_Y, SHAFT_R], side: 'l', n: [0, 0, 1], on: 'drive' },
    { text: 'selector cams', p: [camX(2), SHAFT_Y - CAM_R, 4], side: 'l', n: [0, -0.3, 1], on: 'sleeve' },
    { text: 'selector levers', p: [camX(5), PIVOT[1], PIVOT[0]], side: 'r', n: [0, 1, 0], on: 'levers' },
    { text: 'push levers', p: [camX(7), SHAFT_Y + CAM_R + 22, 7.5], side: 'r', n: [0, 0.3, 1], on: 'levers' },
    { text: 'start lever', p: [40, startY, -19], side: 'l', n: [0, 0, 1], on: 'magnet' },
  ];
  const beats: Beat[] = [
    { title: 'At rest', text: 'The motor turns the main shaft all the time the machine is on. The line is marking (current flows), the magnet holds its armature, and the trip pawl holds the clutch: the cam sleeve stands still.', view: TT_HOME },
    { title: 'The start edge', text: 'The start unit cuts the current. The armature falls, its start lever lifts the trip pawl, the clutch takes hold and the sleeve starts its one revolution. This edge is the only synchronization the receiver ever gets.', view: { target: [-10, 46, -8], yaw: 0.85, pitch: 0.3, dist: 120 } },
    { title: 'A lever in the middle of each unit', text: 'The eight cams’ notches are staggered round the sleeve, so notch i meets its lever in the middle of data unit i. The lever drops in and sets its push lever only if the line is marking then: the armature’s bar holds the tails of the others down.', view: { target: [30, 58, -10], yaw: 0.25, pitch: 0.42, dist: 120 } },
    { title: 'Stopped, holding the character', text: `After ${REV_UNITS} units the sleeve is round and the pawl catches the clutch again, in the stop units. The push levers hold the eight levels until the next character: the printer reads them all at once.`, view: TT_HOME },
    { title: 'A slow receiver', text: 'Slow the motor 5.8 % (past the 5.6 % the chapter allows) and the samples slide later and later: the last lever now looks in the stop unit, where the line is always marking, and the character is read wrong. The chapter’s tolerance is this mechanism’s.', view: { target: [50, 58, -10], yaw: 0.3, pitch: 0.4, dist: 110 } },
  ];
  return { items, anchors, beats, floor: 0, look: { exposure: 1 }, cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [CAM_R + 2] } };
}
