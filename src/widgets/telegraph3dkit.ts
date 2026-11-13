// The telegraph key, circuit closer, line and main-line sounder on the studio renderer, in true geometry (DOM-free; millimetres,
// y up, the board along x). The layout is telegraph3dparts.ts's, whose units are U = 3 mm: its key lever of 36 is 108 mm, inside
// Pope's "about four to five inches" (Modern Practice of the Electric Telegraph, ch. IV), and its sounder board of 40 × 24 is
// 120 × 72 mm against the Western Electric 15B's 140 × 113 × 77 mm (radiomuseum). The motion is the parts file's: the key and
// closer levers turn on their pivots (stage.move), the armature turns on its post by armTheta (the gap drawn ×5), the retractor
// spring stretches with it, and the coils and wires light while current flows. Whether the armature moves at all is
// phys/telegraph.ts's test (pulls), so the failure on screen is reachKm exactly.
//
// Drawn, not measured: every size but the key lever's order, the jars (a gravity cell was about 150 × 200 mm: drawn small), the
// line's length (not to scale), the coils' winding and the gap. Pope: platinum contact points, a vulcanite knob, a spring under
// the lever; Electronics Notes: a sounder strikes its anvil when energised and a second stop on release (two clicks).

import { helix, lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { PULL_I, SOUNDER_R } from '../phys/telegraph';
import { ANVIL_X, BRACKET_Y, CLOSER_L, CLOSER_OPEN, CLOSER_PIV, CLOSER_SHUT, KEY_TIP, LEVER_L, LEVER_REST, POLES, POLE_TOP, SPRING_S, armTheta, type TgPose } from './telegraph3dparts';
import { RELAY } from '../phys/relay';

type Detail = 'full' | 'flat';
/** Millimetres per unit of telegraph3dparts.ts's layout. */
export const U = 3;
const S = (p: readonly number[]): Vec3 => [p[0] * U, p[1] * U, p[2] * U];
const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** Turned by a about z through c. */
export const turnZ = (c: Vec3, a: number): Mat4 => {
  const co = Math.cos(a), si = Math.sin(a), m = new Float32Array(16);
  m[0] = co; m[1] = si; m[4] = -si; m[5] = co; m[10] = 1; m[15] = 1;
  m[12] = c[0] - (co * c[0] - si * c[1]); m[13] = c[1] - (si * c[0] + co * c[1]);
  return m;
};
/** A box between two corners, in layout units (drawn in mm), with rounded edges. */
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.3): Geo =>
  transform(roundedBox((x1 - x0) * U, (y1 - y0) * U, (z1 - z0) * U, r * U, 2), tr(S([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2])));
/** An upright turned part from a profile of [r, y] in layout units, at (x, z). */
const turned = (x: number, z: number, prof: [number, number][], seg: number): Geo => transform(lathe(prof.map(([r, y]): [number, number] => [r * U, y * U]), { seg, crease: 40 }), tr([x * U, 0, z * U]));
const cylU = (x: number, z: number, y0: number, y1: number, r: number, seg: number): Geo => turned(x, z, [[0, y0], [r, y0], [r, y1], [0, y1]], seg);
const rodU = (pts: readonly (readonly number[])[], r: number, sides = 8): Geo => tube(pts.map(S), r * U, { sides });

// ---------------------------------------------------------------- layout (telegraph3dparts.ts's, in its units)

const PIV: Vec3 = [-40, 6, 10], PIVOT_S: Vec3 = [72, 13, 4], ARM_L = 35, CONTACT_X = -16, CLOSER_STUD = -21;

// ---------------------------------------------------------------- geometry

interface Statics {
  board: Geo; jars: Geo; liquid: Geo; zinc: Geo; stakes: Geo;
  keyBase: Geo; keyPosts: Geo; contacts: Geo; keySpring: Geo; gapScrew: Geo; lever: Geo; knob: Geo;
  closerPost: Geo; closerLever: Geo; closerKnob: Geo;
  poles: Geo; arms: Geo; insulators: Geo;
  lineWires: Geo; closerWires: Geo;
  sBase: Geo; yoke: Geo; coils: Geo; cores: Geo; sPost: Geo; armature: Geo; bracket: Geo; stops: Geo;
}
const memo = new Map<Detail, Statics>();
function statics(d: Detail): Statics {
  const hit = memo.get(d);
  if (hit) return hit;
  const seg = d === 'flat' ? 14 : 40, sides = d === 'flat' ? 5 : 8;
  const sag = (a: Vec3, b: Vec3, n = 10, dd = 3): Vec3[] => Array.from({ length: n + 1 }, (_, i) => { const u = i / n; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - dd * Math.sin(Math.PI * u), a[2] + (b[2] - a[2]) * u]; });
  const tops = POLES.map((x): Vec3 => [x, POLE_TOP + 1, -20]);
  const wire = (pts: Vec3[]) => rodU(pts, 0.45, sides);
  const s: Statics = {
    board: bx(-76, 80, -4, 0, -32, 30, 0.6),
    // two gravity cells, drawn small: glass jars, the bluestone solution, a zinc crowfoot hung from the rim
    jars: merge([-66, -56].map((x) => turned(x, -6, [[0, 0], [4.2, 0], [4.2, 9], [3.9, 9], [3.9, 0.4], [0, 0.4]], seg)), 'jars'),
    liquid: merge([-66, -56].map((x) => cylU(x, -6, 0.4, 6.5, 3.85, seg)), 'liquid'),
    zinc: merge([-66, -56].flatMap((x) => [cylU(x, -6, 5.5, 9.4, 2.4, seg), cylU(x, -6, 9.4, 10.5, 1.2, 16)]), 'zinc'),
    stakes: merge([cylU(-72, 18, -8, 5, 1.1, 12), cylU(76, 24, -8, 3, 1.1, 12)], 'stakes'),
    keyBase: bx(-46, -2, 0, 2, 5, 21, 0.4),
    keyPosts: merge([bx(-42, -38, 2, 6.5, 8, 12, 0.2), rodU([[PIV[0], PIV[1], 7.2], [PIV[0], PIV[1], 12.8]], 0.9, sides)], 'key posts'),
    // the contact post with its platinum point, and the line terminal
    contacts: merge([cylU(CONTACT_X, 10, 2, 5, 1.6, seg), cylU(CONTACT_X, 10, 5, 5.5, 0.7, 16), cylU(-10, 10, 2, 4, 1.2, seg)], 'contacts'),
    keySpring: tube(helix({ r: 0.7 * U, pitch: 0.35 * U, from: 2 * U, to: 4.6 * U, perTurn: d === 'flat' ? 8 : 18, at: [(PIV[0] + 8 * Math.cos(LEVER_REST)) * U, 10 * U] }), 0.12 * U, { sides: 5 }),
    gapScrew: merge([rodU([[-40, 6.5, 12], [-40, 12.2, 12], [-26, 12.2, 12], [-26, 12.2, 10]], 0.8, sides), cylU(-26, 10, 9.7, 14, 0.8, 16), cylU(-26, 10, 14, 15.2, 1.7, seg)], 'gap screw'),
    // the key lever at rest (tilt LEVER_REST), its knob at the tip
    lever: rodU([PIV, KEY_TIP(0)], 1, sides),
    knob: (() => { const t = KEY_TIP(0); return turned(t[0], t[2], [[0, t[1]], [2.6, t[1]], [3.4, t[1] + 1.5], [3.4, t[1] + 3.6], [2.6, t[1] + 5], [0, t[1] + 5]], seg); })(),
    closerPost: merge([bx(-36, -32, 2, 8, 15, 19, 0.2), cylU(CLOSER_STUD, 17, 2, 3.8, 1.4, seg)], 'closer post'),
    closerLever: (() => { const t: Vec3 = [CLOSER_PIV[0] + CLOSER_L * Math.cos(CLOSER_OPEN), CLOSER_PIV[1] + CLOSER_L * Math.sin(CLOSER_OPEN), CLOSER_PIV[2]]; return rodU([CLOSER_PIV, t], 0.8, sides); })(),
    closerKnob: (() => { const t: Vec3 = [CLOSER_PIV[0] + CLOSER_L * Math.cos(CLOSER_OPEN), CLOSER_PIV[1] + CLOSER_L * Math.sin(CLOSER_OPEN), CLOSER_PIV[2]]; return cylU(t[0], t[2], t[1], t[1] + 3, 1.7, seg); })(),
    poles: merge(POLES.map((x) => cylU(x, -20, 0, POLE_TOP - 2, 1.2, seg)), 'poles'),
    arms: merge(POLES.map((x) => bx(x - 4, x + 4, POLE_TOP - 3.5, POLE_TOP - 2, -21.5, -18.5, 0.2)), 'crossarms'),
    insulators: merge(POLES.map((x) => turned(x, -20, [[0, POLE_TOP - 2], [0.9, POLE_TOP - 2], [1.2, POLE_TOP - 1], [0.7, POLE_TOP + 0.6], [0, POLE_TOP + 0.6]], seg)), 'insulators'),
    lineWires: merge([
      wire([[-56, 10.5, -6], [-56, 13, 10], [-40, 13, 10], [-40, 6.5, 10]]),
      wire([[CONTACT_X, 5.5, 10], [CONTACT_X, 5.5, 14], [-10, 5.5, 14], [-10, 4, 10]]),
      wire([[-10, 4, 10], [-10, 12, 0], tops[0]]),
      wire(sag(tops[0], tops[1])), wire(sag(tops[1], tops[2])),
      wire([tops[2], [52, 20, -10], [50, 14, -2]]),
      wire([[-66, 10.5, -6], [-72, 14, 6], [-72, 6, 18]]),
      wire([[62, 14, 0], [68, 8, 8], [76, 6, 24]]),
    ], 'line'),
    closerWires: merge([wire([[-40, 6.5, 10], [-38, 8, 17], [-34, 8, 17]]), wire([[CLOSER_STUD, 3.8, 17], [CLOSER_STUD, 3.8, 13], [CONTACT_X, 5.5, 10]])], 'closer wires'),
    sBase: bx(36, 76, 0, 2, -10, 14, 0.4),
    yoke: bx(44, 66, 2, 4, 1, 7, 0.2),
    // two coils on iron cores: a spool with flanges, the winding between them
    coils: merge([48, 62].map((x) => turned(x, 4, [[1.8, 4], [6.6, 4], [6.6, 4.8], [6, 4.8], [6, 11.2], [6.6, 11.2], [6.6, 12], [1.8, 12], [1.8, 4]], seg)), 'coils'),
    cores: merge([48, 62].map((x) => cylU(x, 4, 4, PIVOT_S[1], 1.8, seg)), 'cores'),
    sPost: bx(70, 74, 2, PIVOT_S[1], 0, 8, 0.2),
    // the armature at angle 0 (flat), from its pivot towards the anvil; the pose turns it by armTheta about the pivot
    armature: bx(PIVOT_S[0] - ARM_L, PIVOT_S[0], PIVOT_S[1], PIVOT_S[1] + 1.8, PIVOT_S[2] - 3.5, PIVOT_S[2] + 3.5, 0.3),
    bracket: (() => { const sx = PIVOT_S[0] - SPRING_S; return merge([rodU([[72, 13, 9.2], [72, BRACKET_Y, 9.2], [sx, BRACKET_Y, 9.2], [sx, BRACKET_Y, 6.5]], 0.9, sides), cylU(sx, 6.5, BRACKET_Y - 1, BRACKET_Y + 4, 0.8, 16), cylU(sx, 6.5, BRACKET_Y + 4, BRACKET_Y + 5.2, 1.8, seg)], 'bracket'); })(),
    // the anvil under the armature's tip, and the upper stop over it on its bracket (the second click)
    stops: (() => {
      const seat = PIVOT_S[1] + ARM_L * Math.tan(armTheta(RELAY.travel)), top = PIVOT_S[1] + ARM_L * Math.tan(armTheta(0)) + 2;
      return merge([cylU(ANVIL_X, 4, 2, seat, 1.8, seg), bx(ANVIL_X - 2, ANVIL_X + 2, top + 0.3, top + 2, -8, 2, 0.2), bx(ANVIL_X - 2, ANVIL_X + 2, 2, top + 0.3, -8, -6, 0.2), cylU(ANVIL_X, -3, top + 2, top + 7, 0.8, 16), cylU(ANVIL_X, -3, top + 7, top + 8.2, 1.7, seg)], 'stops');
    })(),
  };
  memo.set(d, s);
  return s;
}

/** The retractor spring from y = 0 up to its length (mm), at the origin: rebuilt, never scaled (a scaled helix fattens its wire
 *  into a bar); the same point count at any length, so the drawn one is bent in place (refresh). */
export const retractorGeo = (len: number, d: Detail): Geo => {
  const per = d === 'flat' ? 8 : 18, n = 11 * per, r = 0.9 * U;
  return tube(Array.from({ length: n + 1 }, (_, i): Vec3 => { const a = (2 * Math.PI * i) / per; return [r * Math.cos(a), (len * i) / n, r * Math.sin(a)]; }), 0.12 * U, { sides: 5 });
};
const retractors = new Map<Detail, Geo>();
export const retractorOf = (d: Detail, len: number): Geo => { let g = retractors.get(d); if (!g) { g = retractorGeo(len, d); retractors.set(d, g); } return g; };
export const drawnRetractor = (d: Detail): Geo | undefined => retractors.get(d);
/** The retractor's length (mm) at armature travel x (m): from the armature up to its bracket. */
export const retractorLen = (x: number): number => (BRACKET_Y - 1 - (PIVOT_S[1] + SPRING_S * Math.sin(armTheta(x)) + 0.9)) * U;

// ---------------------------------------------------------------- materials

const POPE = 'Pope, Modern Practice of the Electric Telegraph, ch. IV';
const live = new Map<number, Material>();
const quant = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 6) / 6;
export const MATS = {
  board: M.make({ base: [0.24, 0.15, 0.09], metal: 0, rough: 0.55, coat: 0.4, label: 'board, varnished (drawn)' }),
  wood: M.make({ base: [0.42, 0.27, 0.15], metal: 0, rough: 0.5, coat: 0.4, label: 'wood base' }),
  brass: M.make({ base: [0.88, 0.7, 0.36], metal: 0.75, rough: 0.28, label: 'brass' }),
  steel: M.make({ base: [0.7, 0.72, 0.75], metal: 0.8, rough: 0.3, label: 'steel' }),
  iron: M.make({ base: [0.38, 0.39, 0.41], metal: 0.6, rough: 0.45, label: 'soft iron' }),
  vulcanite: M.make({ base: [0.06, 0.05, 0.05], metal: 0, rough: 0.3, coat: 0.6, label: `vulcanite (${POPE})` }),
  coil: M.make({ base: [0.12, 0.26, 0.2], metal: 0, rough: 0.6, label: 'silk-covered winding (colour drawn)' }),
  glass: M.make({ ...M.glass, transmit: 0.9, rough: 0.03, label: 'glass jar' }),
  bluestone: M.make({ base: [0.05, 0.42, 1.0], metal: 0, rough: 0.12, coat: 0.8, transmit: 0.3, tint: [0.2, 0.55, 1.0], label: 'copper sulphate solution (gravity cell)' }),
  zinc: M.make({ base: [0.62, 0.63, 0.66], metal: 0.7, rough: 0.5, label: 'zinc crowfoot' }),
  pole: M.make({ base: [0.36, 0.25, 0.15], metal: 0, rough: 0.8, label: 'wooden pole' }),
  insulator: M.make({ ...M.glass, transmit: 0.55, tint: [0.6, 0.85, 0.75], label: 'glass insulator' }),
  wire: M.make({ base: [0.55, 0.52, 0.5], metal: 0.7, rough: 0.45, label: 'line wire' }),
  /** A wire or coil carrying the loop current: lit by how far it is above the pull-in current. */
  live: (k: number, base: [number, number, number] = [0.55, 0.52, 0.5], gain = 1): Material => {
    const q = quant(k), key = q + base[1] * 10 + gain * 100;
    let m = live.get(key);
    if (!m) { m = M.make({ base, metal: 0.4, rough: 0.5, emit: [1, 0.72, 0.3], glow: gain * (0.12 + 0.28 * q), bloom: gain * (0.6 + 0.9 * q), label: 'carrying the loop current' }); live.set(key, m); }
    return m;
  },
};

// ---------------------------------------------------------------- the model

export function tgModel(p: TgPose, detail: Detail = 'full'): Model3 {
  const s = statics(detail), ex = p.flowing ? Math.min(1, p.i / PULL_I) : 0, wireMat = p.flowing ? MATS.live(ex) : MATS.wire;
  const closerMat = p.flowing && (p.cd ?? 0) > 0.98 ? wireMat : MATS.wire, coilMat = p.flowing && ex > 0 ? MATS.live(ex, [0.12, 0.26, 0.2], 0.6) : MATS.coil;
  const items: Item[] = [
    { geo: s.board, mat: MATS.board, name: 'board', group: 'board', info: { note: 'the key, the line and the sounder on one board: in an office they stood apart' } },
    { geo: s.jars, mat: MATS.glass, name: 'battery', group: 'battery', order: 2, info: { note: 'two gravity cells of 1.1 V standing for the whole battery; drawn small (a cell was about 150 × 200 mm)' } },
    { geo: s.liquid, mat: MATS.bluestone, name: 'battery', group: 'battery', order: 1 },
    { geo: s.zinc, mat: MATS.zinc, name: 'battery', group: 'battery' },
    { geo: s.stakes, mat: MATS.iron, name: 'earth return', group: 'line', info: { note: 'the earth carries the return current: one wire is enough' } },
    { geo: s.keyBase, mat: MATS.wood, name: 'key', group: 'keybase' },
    { geo: s.keyPosts, mat: MATS.brass, name: 'key', group: 'keybase' },
    { geo: s.contacts, mat: MATS.brass, name: 'contact', group: 'keybase', info: { source: POPE, note: 'platinum points: the spark at the break would fuse other metals' } },
    { geo: s.keySpring, mat: MATS.steel, name: 'key spring', group: 'keybase', shadow: false },
    { geo: s.gapScrew, mat: MATS.brass, name: 'gap screw', group: 'keybase', info: { source: POPE, note: 'sets how far the lever travels' } },
    { geo: s.lever, mat: MATS.brass, name: 'key', group: 'key', info: { dim: `${LEVER_L * U} mm lever`, source: `${POPE}: “about four to five inches long”` } },
    { geo: s.knob, mat: MATS.vulcanite, name: 'key', group: 'key' },
    { geo: s.closerPost, mat: MATS.brass, name: 'circuit closer', group: 'keybase' },
    { geo: s.closerLever, mat: MATS.brass, name: 'circuit closer', group: 'closer', info: { note: 'shut, it shorts the key: the loop carries current at idle (closed circuit)' } },
    { geo: s.closerKnob, mat: MATS.vulcanite, name: 'circuit closer', group: 'closer' },
    { geo: s.poles, mat: MATS.pole, name: 'line (not to scale)', group: 'line' },
    { geo: s.arms, mat: MATS.pole, name: 'line (not to scale)', group: 'line' },
    { geo: s.insulators, mat: MATS.insulator, name: 'line (not to scale)', group: 'line', order: 2 },
    { geo: s.lineWires, mat: wireMat, name: 'line (not to scale)', group: 'wires', shadow: false, info: { note: 'lit while the loop carries current, brighter the further above the pull-in current' } },
    { geo: s.closerWires, mat: closerMat, name: 'circuit closer', group: 'wires', shadow: false },
    { geo: s.sBase, mat: MATS.wood, name: 'sounder', group: 'sounder' },
    { geo: s.yoke, mat: MATS.iron, name: 'yoke', group: 'sounder', info: { note: 'closes the magnetic circuit under the two coils' } },
    { geo: s.coils, mat: coilMat, name: 'coils', group: 'sounder', info: { note: `${SOUNDER_R} Ω main-line coils, worked by the line current itself` } },
    { geo: s.cores, mat: MATS.iron, name: 'coils', group: 'sounder' },
    { geo: s.sPost, mat: MATS.brass, name: 'sounder', group: 'sounder' },
    { geo: s.armature, mat: MATS.iron, name: 'armature', group: 'armature', info: { note: 'pulled onto the anvil above the pull-in current (one click), lifted onto the upper stop by the spring (the other); its gap is drawn five times its size' } },
    { geo: s.bracket, mat: MATS.brass, name: 'retractor spring', group: 'sounder' },
    { geo: retractorOf(detail, retractorLen(p.x)), mat: MATS.steel, name: 'retractor spring', group: 'retractor', shadow: false, info: { note: 'its tension screw sets the current the coils must beat' } },
    { geo: s.stops, mat: MATS.brass, name: 'anvil and stop', group: 'sounder', info: { source: 'Electronics Notes, the Morse telegraph sounder', note: 'two stops, two clicks: down onto the anvil, back onto the upper stop' } },
  ];
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0];
  const anchors: StudioAnchor[] = [
    { text: 'key', p: S([KEY_TIP(0)[0], KEY_TIP(0)[1] + 5, KEY_TIP(0)[2]]), side: 't', n: up, on: 'key' },
    { text: 'circuit closer', p: S([CLOSER_PIV[0] + 6, CLOSER_PIV[1] + 3, CLOSER_PIV[2]]), side: 'b', n: front, on: 'closer' },
    { text: 'battery', p: S([-61, 10, -6]), side: 't', n: up, on: 'battery' },
    { text: 'line', p: S([14, POLE_TOP + 1, -20]), side: 't', n: up, on: 'line' },
    { text: 'coils', p: S([55, 12, 4]), side: 'b', n: front, on: 'sounder' },
    { text: 'armature', p: S([ANVIL_X + 4, 18, 4]), side: 't', n: up, on: 'armature' },
    { text: 'anvil', p: S([ANVIL_X, 5, 4]), side: 'b', n: front, on: 'sounder' },
  ];
  const beats: Beat[] = [
    { title: 'One loop', text: 'Battery, key, line, the sounder’s coils and the earth make one loop. At idle the circuit closer shorts the key, so current flows and the armature lies on its anvil: a closed-circuit line.', view: TG_HOME },
    { title: 'The key and the closer', text: 'The closer’s lever shorts the key while it lies on its stud. Open it to send: now each press of the key closes the loop, and each release opens it. The contacts are platinum, so the spark at the break does not weld them (Pope).', view: { yaw: 0.6, pitch: 0.7, target: S([-26, 6, 12]), dist: 230 }, frame: ['key', 'closer', 'keybase'] },
    { title: 'Two coils, an armature, two clicks', text: 'Above the pull-in current the coils pull the iron armature down onto the anvil: one click. When the loop opens, the retractor spring lifts it onto the upper stop: a second, softer click. Operators read the gap between the two.', view: { yaw: 0.9, pitch: 0.35, target: S([56, 14, 4]), dist: 260 }, frame: ['sounder', 'armature'] },
    { title: 'The wire eats the current', text: 'The line’s resistance grows with its length; past the reach the current stays under the pull-in, and the armature does not move at all. The line here is drawn short: its length is the slider’s.', view: { yaw: 0.4, pitch: 0.4, target: S([14, 16, -20]), dist: 360 }, frame: ['line', 'wires'] },
  ];
  return { items, anchors, beats, floor: -8 * U, look: { exposure: 1.2, keyDir: [-0.4, 0.8, 0.5] } };
}

/** The moving parts at the pose: key and closer levers on their pivots, the armature on its post, the retractor spring's length. */
export function tgPose(p: TgPose): Map<string, Mat4> {
  const th = armTheta(p.x), cd = p.cd ?? 0, sx = PIVOT_S[0] - SPRING_S, aSy = PIVOT_S[1] + SPRING_S * Math.sin(th) + 0.9;
  const spring = tr(S([sx, aSy, 6.5]));
  return new Map<string, Mat4>([
    ['key', turnZ(S(PIV), -LEVER_REST * p.kd)],
    ['closer', turnZ(S(CLOSER_PIV), (CLOSER_SHUT - CLOSER_OPEN) * cd)],
    ['armature', turnZ(S(PIVOT_S), -th)],
    ['retractor', spring],
  ]);
}

export const TG_HOME = { yaw: 0.7, pitch: 0.62, target: [6, 20, 6] as Vec3, dist: 640 };
