// A 4 × 4 crop of a core memory plane on the studio renderer, in true geometry (DOM-free; 1 unit = 1 mil, y up, the plane
// in x–z). What the cores do is core3dparts.ts's rule (planOp): this file only draws a pose of it.
//
// The core: Whirlwind's second bank used 80 mil cores (MIT Report R-221, 1954, sec. 5.22: F-394, 80 mil outside); the 50 mil
// hole and 20 mil height are a later Lincoln Laboratory core's (none given in R-221). Pressed and sintered, so a ring of
// rectangular section with rounded edges, turned on a lathe here. The wires: 32-gauge magnet wire with quadruple Formex
// insulation (R-221 sec. 5.24), drawn at the bare copper's 7.95 mil (no source gives the insulated diameter), threaded
// through the holes: X and Y select wires, the inhibit ("digit-plane") winding beside X, and the sense winding along the
// diagonals (R-221 sec. 5.24: "the sense winding runs along the diagonals"). The pitch: R-221's frame is about 9.5 in for
// 32 × 32 cores, so at most 297 mil a core; less an assumed border, 250 mil. The 45° tilt that lets the X, Y and diagonal
// wires all pass a hole is this model's choice (R-221 gives none). The frame drawn is the crop's, not Whirlwind's 9.5 in.

import { lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { N, colOf, idx, rowOf, type Drive } from './core3dparts';

// ---------------------------------------------------------------- dimensions (mil)

export const OD = 80, ID = 50, HEIGHT = 20;
export const RO = OD / 2, RI = ID / 2;
/** R-221's ~9.5 in frame holds 32 cores a side: at most 297 mil each, less the frame's own border (assumed): 250 mil. */
export const PITCH = 250;
/** 32 AWG bare: 0.005 in × 92^((36 − 32) / 39) = 7.95 mil across. */
export const AWG = 32;
export const awgMil = (n: number): number => 5 * 92 ** ((36 - n) / 39);
export const WIRE_R = awgMil(AWG) / 2;
/** The ring's axis: horizontal, at 45° between x and z (the model's tilt). E1 across it in the plane, E2 up. */
export const AX: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
const E1: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2], E2: Vec3 = [0, 1, 0];
/** Where each wire passes a core, from its centre (mil): X along x and Y along z one above the other, the inhibit below X,
 *  the sense along the axis lowest; every pair of wires at least a wire's width apart where they cross. */
export const OFF = { x: [0, 10, 4] as Vec3, y: [4, 0.5, 0] as Vec3, inh: [0, -9, -4] as Vec3, senseDy: -19 };
/** How far a wire sags between two holes (mil): small, and less than any two wires' spare clearance. */
export const SAG = 1.5;
/** The crop's frame: inner half-size, width, thickness (phenolic, assumed). */
export const F_IN = 2 * PITCH, F_W = 140, F_T = 62;
/** The other planes of a stack, this far apart (assumed: R-221 gives the count, 17, not the spacing). */
export const STACK_N = 17, STACK_DY = 600;
/** A whole plane: 32 × 32 cores (R-221), at this pitch 8 in of cores, in a frame of about 9.5 in. The crop drawn in detail
 *  is the middle 4 × 4 of the top plane: its core (c, r) is the plane's (c + PLANE_AT, r + PLANE_AT). */
export const PLANE = 32, PLANE_AT = 14, PLANE_FRAME = 9500 / 2;
const planeX = (i: number): number => (i - (PLANE - 1) / 2) * PITCH;

export const colX = (c: number): number => (c - (N - 1) / 2) * PITCH;
export const rowZ = (r: number): number => (r - (N - 1) / 2) * PITCH;
export const centreOf = (k: number): Vec3 => [colX(colOf(k)), 0, rowZ(rowOf(k))];
/** A point on core k's ring frame: angle t round the axis, at radius r, `lift` along the axis. */
export function ringPoint(k: number, t: number, r: number, lift = 0): Vec3 {
  const c = centreOf(k), ct = Math.cos(t) * r, st = Math.sin(t) * r;
  return [c[0] + E1[0] * ct + E2[0] * st + AX[0] * lift, c[1] + E1[1] * ct + E2[1] * st + AX[1] * lift, c[2] + E1[2] * ct + E2[2] * st + AX[2] * lift];
}

// ---------------------------------------------------------------- wire paths

/** Up over the frame's inner edge and along its top to a lug: the points of a wire leaving the plane at `p` heading along
 *  `d` (unit, in x–z); `further` sets its lug further out (two lugs side by side). */
function toLug(p: Vec3, d: Vec3, further = 0): Vec3[] {
  const reach = (F_IN - Math.max(Math.abs(p[0]), Math.abs(p[2]))) / Math.max(Math.abs(d[0]), Math.abs(d[2]));
  const at = (s: number, y: number): Vec3 => [p[0] + d[0] * s, y, p[2] + d[2] * s], top = F_T / 2 + WIRE_R;
  return [at(reach - 40, p[1]), at(reach + 15, top), at(reach + 70 + further, top)];
}
/** A straight run through a row of holes with a slight sag between them (the wire is strung taut, not ruled). */
function sagRun(a: Vec3, b: Vec3, holes: number[], sag = SAG): Vec3[] {
  const out: Vec3[] = [], L = Math.hypot(b[0] - a[0], b[2] - a[2]), at = (s: number, dy: number): Vec3 => [a[0] + ((b[0] - a[0]) * s) / L, a[1] + dy, a[2] + ((b[2] - a[2]) * s) / L];
  const stops = [0, ...holes, L];
  for (let i = 0; i < stops.length - 1; i++) {
    out.push(at(stops[i], 0));
    out.push(at((stops[i] + stops[i + 1]) / 2, -sag));
  }
  out.push(at(L, 0));
  return out;
}

export interface Wire { kind: 'x' | 'y' | 'inh' | 'sense'; i: number; path: Vec3[]; /** the straight runs through the cores */ runs: [Vec3, Vec3][] }

/** Every wire's centreline, lug to lug. X wire r and the inhibit run along +x; Y wire c along +z; the sense snakes along
 *  the diagonals (alternate runs reversed, bridges outside the cores); the inhibit returns between rows outside the cores. */
export function wires(): Wire[] {
  const out: Wire[] = [], E = colX(N - 1) + PITCH / 2 - 80;
  const xs = Array.from({ length: N }, (_, c) => colX(c));
  for (let r = 0; r < N; r++) {
    const z = rowZ(r) + OFF.x[2], y = OFF.x[1], a: Vec3 = [-E, y, z], b: Vec3 = [E, y, z];
    out.push({ kind: 'x', i: r, path: [...toLug(a, [-1, 0, 0]).reverse(), ...sagRun(a, b, xs.map((x) => x + E)), ...toLug(b, [1, 0, 0])], runs: [[a, b]] });
  }
  for (let c = 0; c < N; c++) {
    const x = colX(c) + OFF.y[0], y = OFF.y[1], a: Vec3 = [x, y, -E], b: Vec3 = [x, y, E];
    out.push({ kind: 'y', i: c, path: [...toLug(a, [0, 0, -1]).reverse(), ...sagRun(a, b, xs.map((_, r) => rowZ(r) + E)), ...toLug(b, [0, 0, 1])], runs: [[a, b]] });
  }
  // the inhibit: every row the same way (+x), so it opposes the selects in all sixteen; the returns run back outside the cores
  const inh: Vec3[] = [], inhRuns: [Vec3, Vec3][] = [], yi = OFF.inh[1], back = E + 40;
  for (let r = 0; r < N; r++) {
    const z = rowZ(r) + OFF.inh[2], a: Vec3 = [-E, yi, z], b: Vec3 = [E, yi, z];
    inhRuns.push([a, b]);
    if (r === 0) inh.push(...toLug(a, [-1, 0, 0], 50).reverse());
    inh.push(...sagRun(a, b, xs.map((x) => x + E)));
    if (r + 1 < N) { // out past the last core, round under the frame's level, back to the next row's start
      const z1 = rowZ(r + 1) + OFF.inh[2];
      inh.push([back, yi - 30, z], [back, yi - 30, (z + z1) / 2], [-back, yi - 30, (z + z1) / 2], [-back, yi - 30, z1]);
    } else inh.push(...toLug(b, [1, 0, 0], 50));
  }
  out.push({ kind: 'inh', i: 0, path: inh, runs: inhRuns });
  // the sense: one run per diagonal r − c = d, along the axis through every hole on it, alternating, joined outside
  const D = Math.SQRT1_2, along = (r: number, c: number) => (colX(c) + rowZ(r)) * D, ys = OFF.senseDy, EXT = 70;
  const n = 2 * N - 1, ends = Array.from({ length: n }, (_, i) => {
    const d = i - (N - 1), c0 = Math.max(0, -d), c1 = Math.min(N - 1, N - 1 - d);
    return { c0, r0: c0 + d, lo: along(c0 + d, c0), hi: along(c1 + d, c1) };
  });
  const bridge = (i: number) => (i % 2 === 0 ? Math.max(ends[i].hi, ends[i + 1].hi) + EXT : Math.min(ends[i].lo, ends[i + 1].lo) - EXT);
  const at = (i: number, s: number): Vec3 => { const e = ends[i]; return [colX(e.c0) + D * (s - e.lo), ys, rowZ(e.r0) + D * (s - e.lo)]; };
  const runs: [Vec3, Vec3][] = [];
  for (let i = 0; i < n; i++) {
    const fwd = i % 2 === 0, e = ends[i];
    const s0 = i === 0 ? e.lo - EXT : bridge(i - 1), s1 = i === n - 1 ? (fwd ? e.hi + EXT : e.lo - EXT) : bridge(i);
    runs.push([at(i, s0), at(i, s1)]);
  }
  const sp: Vec3[] = [];
  const first = runs[0][0], last = runs[n - 1][1];
  sp.push(...toLug(first, [-D, 0, -D]).reverse());
  for (const [a, b] of runs) sp.push(a, b);
  sp.push(...toLug(last, n % 2 === 1 ? [D, 0, D] : [-D, 0, -D]));
  out.push({ kind: 'sense', i: 0, path: sp, runs });
  return out;
}

// ---------------------------------------------------------------- materials

const mat = (o: Material): Material => M.make(o);
const WIRE_LABEL = '32-gauge magnet wire, quadruple Formex (R-221 sec. 5.24); tinted here to tell the four apart, real Formex is one amber colour';
export const MATS = {
  ferrite: mat({ base: [0.15, 0.15, 0.16], metal: 0, rough: 0.55, coat: 0.18, label: 'ferrite (pressed and sintered)' }),
  ferriteHot: (live: Material['base']): Material => mat({ base: [0.2, 0.18, 0.17], metal: 0, rough: 0.5, coat: 0.18, emit: live, glow: 1.1, bloom: 1.5, label: 'ferrite, switching' }),
  frame: mat({ ...M.phenolicPaper, label: 'phenolic frame (the crop’s; Whirlwind’s was about 9.5 in square)' }),
  lug: mat({ ...M.solder, label: 'solder lug' }),
  wire: (tok: string): Material => mat({ base: tok as Material['base'], metal: 0.35, rough: 0.3, coat: 0.6, label: WIRE_LABEL }),
  wireLive: (tok: string, live: Material['base'], glow = 0.9): Material => mat({ base: tok as Material['base'], metal: 0.35, rough: 0.3, coat: 0.6, emit: live, glow, bloom: 1.3, label: `${WIRE_LABEL}: carrying current` }),
  arrow: (tok: string): Material => mat({ base: tok as Material['base'], metal: 0, rough: 0.4, emit: tok as Material['base'], glow: 0.45, label: 'the magnetisation (drawn): its direction is the bit' }),
  box: mat({ base: [0.22, 0.23, 0.25], metal: 0.3, rough: 0.5, label: 'driver' }),
};

// ---------------------------------------------------------------- geometry (memoized: none of it depends on the state)

const rot = (c: Vec3): Mat4 => { // lathe's y to the axis, x to E1, z to E1 × AX = −y
  const m = new Float32Array(16);
  m.set([...E1, 0, ...AX, 0, 0, -1, 0, 0, c[0], c[1], c[2], 1]);
  return m;
};
/** The ring's section: a rectangle with rounded edges, walked round as lathe() takes a shell (outer face up, inner down). */
function ringProfile(seg: number): Geo {
  const r0 = RI, r1 = RO, h = HEIGHT / 2, e = 3, pts: [number, number][] = [];
  const arc = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= 3; i++) { const a = a0 + (i / 3) * (Math.PI / 2); pts.push([cx + e * Math.cos(a), cy + e * Math.sin(a)]); } };
  arc(r0 + e, -h + e, Math.PI); arc(r1 - e, -h + e, -Math.PI / 2); arc(r1 - e, h - e, 0); arc(r0 + e, h - e, Math.PI / 2);
  pts.push(pts[0]);
  // the arcs above run anticlockwise in (r, y): bottom inner → bottom outer → top outer → top inner, outside on the right
  return lathe(pts, { seg, crease: 50 });
}
/** The magnetisation arrow on a core's outer face: an arc of 3/4 turn with a head, anticlockwise about the axis for a 1. */
function arrowGeo(k: number, dir: 1 | -1): Geo {
  const face = HEIGHT / 2 + 1.5, R = (RO + RI) / 2, span = 1.5 * Math.PI, head = Math.PI / 2, start = head - dir * span, pts: Vec3[] = [];
  for (let i = 0; i <= 18; i++) pts.push(ringPoint(k, start + (dir * span * i) / 18, R, face));
  const tip = ringPoint(k, head + dir * 0.32, R, face), base = pts[pts.length - 1];
  const cone = transform(lathe([[0, 0], [3.2, 0], [0, 1]], { seg: 10 }), coneTo(base, tip));
  return merge([tube(pts, 1.3, { sides: 6 }), cone], 'arrow');
}
function coneTo(a: Vec3, b: Vec3): Mat4 { // a unit cone (y 0..1) from a to b
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d), y: Vec3 = [d[0] / L, d[1] / L, d[2] / L];
  const t: Vec3 = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], x = norm([y[1] * t[2] - y[2] * t[1], y[2] * t[0] - y[0] * t[2], y[0] * t[1] - y[1] * t[0]]);
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], m = new Float32Array(16);
  m.set([...x, 0, y[0] * L, y[1] * L, y[2] * L, 0, ...z, 0, a[0], a[1], a[2], 1]);
  return m;
}
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo => transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));

interface Statics { rings: Geo[]; arrows: Record<1 | -1, Geo[]>; wires: { w: Wire; geo: Geo }[]; frame: Geo; lugs: Geo; drivers: { kind: 'x' | 'y'; i: number; geo: Geo }[]; amp: Geo; lamp: Geo; stackRing: Geo; stackFrame: Geo }
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat'): Statics {
  const hit = memo.get(detail);
  if (hit) return hit;
  const seg = detail === 'flat' ? 14 : 40, ring = ringProfile(seg);
  const rings = Array.from({ length: N * N }, (_, k) => transform(ring, rot(centreOf(k))));
  const arrows = { 1: rings.map((_, k) => arrowGeo(k, 1)), [-1]: rings.map((_, k) => arrowGeo(k, -1)) } as Record<1 | -1, Geo[]>;
  const W = wires().map((w) => ({ w, geo: tube(w.path, WIRE_R, { bend: 12, sides: detail === 'flat' ? 5 : 10 }) }));
  const o = F_IN + F_W, t = F_T / 2;
  const frame = merge([bx(-o, o, -t, t, -o, -F_IN, 4), bx(-o, o, -t, t, F_IN, o, 4), bx(-o, -F_IN, -t, t, -F_IN, F_IN, 4), bx(F_IN, o, -t, t, -F_IN, F_IN, 4)], 'frame');
  const lugAt = (p: Vec3) => transform(lathe([[0, 0], [9, 0], [9, 14], [5, 14], [5, 26], [0, 26]], { seg: 12 }), tr([p[0], t, p[2]]));
  const lugs = merge(W.flatMap(({ w }) => [w.path[0], w.path[w.path.length - 1]].map(lugAt)), 'lugs');
  const drivers = [
    ...Array.from({ length: N }, (_, r) => ({ kind: 'x' as const, i: r, geo: bx(-o - 130, -o - 20, -t, t + 40, rowZ(r) + OFF.x[2] - 45, rowZ(r) + OFF.x[2] + 45, 6) })),
    ...Array.from({ length: N }, (_, c) => ({ kind: 'y' as const, i: c, geo: bx(colX(c) + OFF.y[0] - 45, colX(c) + OFF.y[0] + 45, -t, t + 40, -o - 130, -o - 20, 6) })),
  ];
  const amp = bx(o + 30, o + 190, -t, t + 30, o - 160, o - 20, 8), lamp = bx(o + 80, o + 140, t + 30, t + 52, o - 120, o - 60, 6);
  // the stack's cores are seen from far: a plain rectangle turned in six steps (48 triangles), 17 392 of them
  const stackRing = transform(lathe([[RI, -HEIGHT / 2], [RO, -HEIGHT / 2], [RO, HEIGHT / 2], [RI, HEIGHT / 2], [RI, -HEIGHT / 2]], { seg: 6, crease: 50 }), rot([0, 0, 0]));
  const P = PLANE_FRAME, Pi = P - 500, ft = 40;
  const stackFrame = merge([bx(-P, P, -ft, ft, -P, -Pi), bx(-P, P, -ft, ft, Pi, P), bx(-P, -Pi, -ft, ft, -Pi, Pi), bx(Pi, P, -ft, ft, -Pi, Pi)], 'plane frame');
  const s: Statics = { rings, arrows, wires: W, frame, lugs, drivers, amp, lamp, stackRing, stackFrame };
  memo.set(detail, s);
  return s;
}

// ---------------------------------------------------------------- the model

export interface CoreState {
  bits: readonly number[];
  drive: Drive;
  /** Cores switching right now (lit). */
  flipping: readonly number[];
  addr: number;
  /** The strobed sense wire carries a pulse (the amplifier's lamp). */
  sense: boolean;
  threeWire?: boolean;
}
const TOK = { x: '--co-wx', y: '--co-wy', inh: '--co-wi', sense: '--co-ws' } as const;
const R221 = 'MIT Report R-221, Whirlwind I Operational Logic (1954)';

export function coreModel(s: CoreState, detail: 'full' | 'flat' = 'full'): Model3 {
  const S = statics(detail), items: Item[] = [], live = '--co-live';
  for (let k = 0; k < N * N; k++) {
    const hot = s.flipping.includes(k), here = k === s.addr;
    items.push({ geo: S.rings[k], mat: hot ? MATS.ferriteHot(live) : MATS.ferrite, name: 'ferrite core', group: here ? 'addressed' : 'cores',
      info: { dim: `${OD} mil outside, ${ID} mil hole, ${HEIGHT} mil high`, source: `${R221}, sec. 5.22 (80 mil, the F-394 of the second bank, switching at about 0.85 A single-turn); hole and height from a later Lincoln core`, note: here ? 'the addressed core: the only one where two half currents add up to a full one' : 'a half-selected core feels one half current at most: below the switching current, it holds' } });
    const bit = s.bits[k] ? 1 : -1;
    items.push({ geo: S.arrows[bit][k], mat: MATS.arrow(bit > 0 ? '--co-one' : '--co-zero'), name: 'stored bit', group: here ? 'addressed' : 'cores', shadow: false,
      info: { note: `${s.bits[k]}: the flux runs ${bit > 0 ? 'anticlockwise' : 'clockwise'} round the ring, seen down its axis` } });
  }
  for (const { w, geo } of S.wires) {
    if (w.kind === 'inh' && s.threeWire) continue;
    const on = w.kind === 'x' ? s.drive.x[w.i] !== 0 : w.kind === 'y' ? s.drive.y[w.i] !== 0 : w.kind === 'inh' ? s.drive.inh !== 0 : s.sense || (!!s.threeWire && s.drive.inh !== 0);
    const name = w.kind === 'x' ? 'X select wire' : w.kind === 'y' ? 'Y select wire' : w.kind === 'inh' ? 'inhibit wire' : s.threeWire ? 'sense + inhibit wire' : 'sense wire';
    const note = w.kind === 'sense' ? 'through every core, along the diagonals: a core’s half-selected neighbours induce small pulses that partly cancel (R-221 sec. 5.24)'
      : w.kind === 'inh' ? 'the “digit-plane winding”: half a current the other way, to keep a 0 from being written' : 'carries half the current that switches a core';
    // the sense wire glows in its own colour: the pulse running along it, not the whole snake, is the event
    const lit = w.kind === 'sense' ? MATS.wireLive(TOK.sense, TOK.sense, 0.45) : MATS.wireLive(TOK[w.kind], live);
    items.push({ geo, mat: on ? lit : MATS.wire(TOK[w.kind]), name, group: w.kind === 'x' ? 'xwires' : w.kind === 'y' ? 'ywires' : w.kind === 'inh' ? 'inhibit' : 'sense', shadow: true,
      info: { dim: `32 AWG: ${awgMil(AWG).toFixed(2)} mil bare copper`, source: `${R221}, sec. 5.24`, note } });
  }
  items.push({ geo: S.frame, mat: MATS.frame, name: 'frame', group: 'frame', info: { dim: `this 4 × 4 crop’s; a whole 32 × 32 plane was about 9.5 in square`, source: `${R221}, sec. 5.24` } });
  items.push({ geo: S.lugs, mat: MATS.lug, name: 'solder lug', group: 'frame', info: { note: 'each wire ends on a lug; in a stack, slotted lugs carry it on to the next plane (R-221 sec. 5.24)' } });
  for (const d of S.drivers) {
    const on = (d.kind === 'x' ? s.drive.x : s.drive.y)[d.i] !== 0;
    items.push({ geo: d.geo, mat: on ? { ...MATS.box, emit: live, glow: 0.7 } : MATS.box, name: d.kind === 'x' ? 'X driver' : 'Y driver', group: 'drivers', info: { note: 'stands for a 6080 tube driver picked by a diode matrix (R-221 sec. 5.21)' } });
  }
  items.push({ geo: S.amp, mat: MATS.box, name: 'sense amplifier', group: 'drivers', info: { note: 'stands for the 6BL7 amplifiers: about 100 mV from the wire to about 30 V, strobed for 0.1 µs (R-221)' } });
  items.push({ geo: S.lamp, mat: s.sense ? { ...MATS.box, base: '--co-lamp', emit: '--co-lamp', glow: 1.6, bloom: 1.6 } : { ...MATS.box, base: '--co-lamp-off' }, name: 'sense lamp', group: 'drivers' });

  const up: Vec3 = [0, 1, 0], a = s.addr, ar = rowOf(a), ac = colOf(a);
  const anchors: StudioAnchor[] = [
    { text: 'ferrite core', p: ringPoint(idx(Math.min(N - 1, ar + 1), ac), Math.PI / 2, RO), side: 'r', n: up, on: 'cores' },
    { text: 'X select wire', p: [colX(0) - PITCH / 2, OFF.x[1], rowZ(ar) + OFF.x[2]], side: 'l', n: up, on: 'xwires' },
    { text: 'Y select wire', p: [colX(ac) + OFF.y[0], OFF.y[1], rowZ(0) - PITCH / 2], side: 'l', n: up, on: 'ywires' },
    { text: s.threeWire ? 'sense + inhibit wire' : 'sense wire (diagonal)', p: [colX(N - 1) - PITCH / 2 * 0.5, OFF.senseDy, rowZ(N - 1) - PITCH / 2 * 0.5], side: 'r', n: up, on: 'sense' },
    ...(s.threeWire ? [] : [{ text: 'inhibit wire', p: [colX(N - 1) + PITCH / 2, OFF.inh[1], rowZ(0) + OFF.inh[2]] as Vec3, side: 'r' as const, n: up, on: 'inhibit' }]),
    { text: 'sense amplifier', p: [F_IN + F_W + 110, F_T / 2 + 52, F_IN + F_W - 90], side: 'r', n: up, on: 'drivers' },
    { text: 'frame and lugs', p: [-F_IN - F_W / 2, F_T / 2, F_IN + F_W / 2], side: 'l', n: up, on: 'frame', minor: true },
  ];
  const close = { yaw: 0.55, pitch: 0.42, target: centreOf(a), dist: 400 };
  const top = { yaw: 0.6, pitch: 0.95, target: [0, 0, 0] as Vec3, dist: 2600 };
  const beats: Beat[] = [
    { title: 'One core, threaded', text: `An 80 mil ring of ferrite with four wires through its ${ID} mil hole: X and Y one above the other, the inhibit beside X, the sense lowest, along the ring's axis. Each is 32-gauge wire, ${awgMil(AWG).toFixed(1)} mil of copper.`, view: close, frame: ['addressed'] },
    { title: 'Half on the row, half on the column', text: 'Read drives one X and one Y wire with half the switching current each. Every core on that row or column feels one half and holds; only where the two cross does a core feel a full current and switch. Press Read and watch the one core light.', view: top, frame: ['cores', 'addressed'], show: ['addressed', 'cores', 'xwires', 'ywires'] },
    { title: 'The sense wire runs on the diagonals', text: 'One wire through all sixteen, along the diagonals (R-221 sec. 5.24). When the addressed core switches it induces a pulse here; a 0 does not switch, so no pulse. Half-selected neighbours induce small pulses too, which partly cancel with the wire going both ways.', view: { ...top, yaw: 0.78 }, frame: ['cores', 'addressed'], show: ['sense', 'addressed', 'cores'] },
    { title: 'Inhibit: writing a 0', text: 'Writing drives the core toward 1. To leave a 0 the inhibit wire carries half a current the other way through every core, so the crossing core feels only half and holds.', view: top, frame: ['cores', 'addressed'], show: ['inhibit', 'addressed', 'cores'] },
    { title: 'Seventeen planes', text: `The crop you have been working is the middle of one plane of 32 × 32 cores, about 9.5 in square (R-221). A word is one core in each of ${STACK_N} planes stacked on the same X and Y wires: 16 bits and one more, the parity bit as the chapter says. ${(PLANE * PLANE * STACK_N).toLocaleString('en-US').replace(/,/g, ' ')} cores for 1024 words. The spacing between planes is assumed; the other planes' wires are not drawn.`, view: { yaw: 0.6, pitch: 0.58, target: [0, -((STACK_N - 1) * STACK_DY) / 2, 0], dist: 27000 }, hide: ['frame', 'drivers'], labels: false },
  ];
  return { items, anchors, beats, floor: -(F_T / 2) - 2, look: { exposure: 1.05 } };
}

export const CORE_HOME = { yaw: 0.6, pitch: 0.74, target: [0, 0, 0] as Vec3, dist: 2200 };
export const CORE_HOME_FRAME = ['cores', 'addressed'];
/** Home fits a sphere round the cores (their corners less a little): the plane fills the canvas, the frame runs off it. */
export const CORE_HOME_R = 1.5 * PITCH * 1.3 + RO;

/** Every plane's frame: the top one (round the crop) and the sixteen below. */
export const stackSites = (): Vec3[] => Array.from({ length: STACK_N }, (_, i) => [0, -i * STACK_DY, 0] as Vec3);
/** Every core of the stack but the sixteen of the crop, which are drawn in detail. */
export function stackCoreSites(): Vec3[] {
  const out: Vec3[] = [], crop = (i: number) => i >= PLANE_AT && i < PLANE_AT + N;
  for (const p of stackSites()) for (let r = 0; r < PLANE; r++) for (let c = 0; c < PLANE; c++) {
    if (p[1] === 0 && crop(r) && crop(c)) continue;
    out.push([planeX(c), p[1], planeX(r)]);
  }
  return out;
}
export const stackGeo = () => statics('full');
