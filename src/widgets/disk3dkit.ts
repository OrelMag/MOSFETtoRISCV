// A 3.5" 7200 rpm hard disk on the studio renderer, in true geometry (DOM-free; 1 unit = 1 mm, y up, the spindle on the
// y axis, the actuator's pivot at x = PIVOT_D). What the drive does is disk3dparts.ts's timing model; this file only draws
// a pose of it: the platters turned by the drive's clock (t / TURN_MS turns), the head stack swung so the head sits at the
// model's radius (headAt). Nothing here moves on its own.
//
// Sourced (disk3dparts.ts's header and the plan's sources): the drive's 101.6 × 147 mm footprint and 26.1 mm height (HGST
// data sheet DSDS721008EN-01, Deskstar 7K1000.B); 95 mm platters on a 25 mm hole; ramp load / unload (the same sheet); a
// pico slider's 1.25 × 1.0 mm (UC Berkeley CML head-disk-interface reports). The parts the HDDScan teardown names (clamp,
// spacer, E-block on a bearing, arms, suspensions with sliders, the flat voice coil between two magnets on steel yokes, the
// flex cable to a bracket, the board underneath with the controller, DRAM, motor driver and flash) are drawn where that
// teardown shows them, at sizes that are this model's own: no source gives their dimensions.
// Exaggerated, as the note says: the 12 drawn tracks, the slider (twice a pico's size), its flying height (0.25 mm), the
// platters' spacing.

import { extrude, filletPath, lathe, merge, roundedBox, sweep, transform, refresh, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, Moves, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import {
  ARM_L, BAND_IN, BAND_OUT, HOLE_R, PICO_MM, PIVOT_D, PLATTER_R, PLATTER_T, PLATTER_Y, RAMP_R, SECTORS, SLIDER_DRAWN, SURFACE_TOP, TRACKS, TRACK_PITCH_MM,
  headAt, trackRadius,
} from './disk3dparts';

// ---------------------------------------------------------------- dimensions (mm)

/** The data sheet's footprint (101.6 × 147 mm) and height (26.1 mm), cover and board included. */
export const DRIVE_W = 101.6, DRIVE_L = 147, DRIVE_H = 26.1;
/** The casting spans x from BASE_X0 (the spindle's end) to BASE_X0 + DRIVE_L (the actuator's and the connector's end). */
export const BASE_X0 = -52;
/** The casting's floor (top at y = 0), the board below it, its tallest package, the cover above the wall (assumed 1 mm). */
export const FLOOR_T = 3, BOARD_T = 1.6, PACKAGE_T = 1.2, COVER_T = 1;
export const BOTTOM_Y = -FLOOR_T - BOARD_T - PACKAGE_T;
/** The wall's top: the data sheet's height less what lies below the floor and the cover. */
export const WALL_TOP = BOTTOM_Y + DRIVE_H - COVER_T;
/** The arms: one above the top platter, one between, one below the bottom one (each carries the heads facing a surface). */
export const BLADE_Y = [PLATTER_Y[0] - PLATTER_T / 2 - 1.6, (PLATTER_Y[0] + PLATTER_Y[1]) / 2, PLATTER_Y[1] + PLATTER_T / 2 + 1.6] as const;
export const BLADE_T = 0.6, GAP = 0.25;
/** The arm's own length from the pivot; the suspension carries the head the rest of ARM_L. */
export const BLADE_L = ARM_L - 16;
/** The coil's centre from the pivot, on the side away from the heads. */
export const COIL_AT = 24;
/** The ramp's inner and outer radius about the spindle (it reaches just over the platters' edge). */
export const RAMP_IN = PLATTER_R - 1.5, RAMP_BODY = 52, RAMP_OUT = 58;

// ---------------------------------------------------------------- motion

/** Rotation by `a` about the vertical through (cx, cz), taking +x toward +z (the parts' angle convention: a point at angle w
 *  round the spindle is (r cos w, y, r sin w)). Column-major. */
export function turnY(cx: number, cz: number, a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a), m = new Float32Array(16);
  m[0] = c; m[2] = s; m[5] = 1; m[8] = -s; m[10] = c; m[15] = 1;
  m[12] = cx - (c * cx - s * cz); m[14] = cz - (s * cx + c * cz);
  return m;
}
/** The arm drawn at rest points from the pivot along −x (α = 0); headAt's α turns it to (−cos α, sin α): a turn of −α. */
export const armTurn = (r: number): number => -headAt(r).alpha;

export interface DiskPose { /** platter angle, turns */ phi: number; /** head's distance from the spindle, mm */ r: number }

/** The moves for a pose: the platter stack turned by the drive's clock, the head stack swung to the model's radius. The flex
 *  cable bends with the arm: refreshed in place (same vertex count). */
export function diskMoves(p: DiskPose, detail: 'full' | 'flat' = 'full'): Moves {
  const S = statics(detail);
  refresh(S.flex, flexGeo(p.r, detail));
  return new Map([
    ['platters', turnY(0, 0, 2 * Math.PI * p.phi)],
    ['hsa', turnY(PIVOT_D, 0, armTurn(p.r))],
  ]);
}

/** Where a point of the head stack drawn at rest is at radius r (tests, anchors). */
export function onArm(p: Vec3, r: number): Vec3 {
  const m = turnY(PIVOT_D, 0, armTurn(r));
  return [m[0] * p[0] + m[8] * p[2] + m[12], p[1], m[2] * p[0] + m[10] * p[2] + m[14]];
}
/** The active head's slider centre at rest (on the top surface, under the top arm). */
export const HEAD_REST: Vec3 = [PIVOT_D - ARM_L, SURFACE_TOP + GAP + SLIDER_DRAWN[1] / 2, 0];

// ---------------------------------------------------------------- materials

const mat = (o: Material): Material => M.make(o);
export const MATS = {
  casting: mat({ base: [0.62, 0.63, 0.64], metal: 0.85, rough: 0.55, label: 'cast aluminium' }),
  platter: mat({ base: [0.93, 0.93, 0.94], metal: 1, rough: 0.05, coat: 0.3, label: 'nickel-plated aluminium, mirror-polished, under a magnetic film' }),
  hub: mat({ ...M.steel, rough: 0.25, label: 'stainless steel' }),
  clamp: mat({ ...M.steel, rough: 0.3, label: 'stainless steel' }),
  marks: mat({ base: [0.2, 0.22, 0.26], metal: 0.3, rough: 0.5, label: 'drawn: track and wedge boundaries (not on a real platter)' }),
  arm: mat({ ...M.aluminium, rough: 0.35, label: 'aluminium' }),
  suspension: mat({ ...M.steel, rough: 0.3, label: 'stainless steel' }),
  slider: mat({ base: [0.16, 0.16, 0.18], metal: 0.3, rough: 0.3, label: 'alumina–titanium carbide' }),
  coil: mat({ ...M.enamel, base: [0.78, 0.42, 0.18], label: 'enamelled copper winding' }),
  magnet: mat({ ...M.nickel, rough: 0.3, label: 'neodymium magnet, nickel-plated' }),
  yoke: mat({ base: [0.38, 0.39, 0.4], metal: 1, rough: 0.45, label: 'steel yoke' }),
  bearing: mat({ ...M.steel, rough: 0.25, label: 'steel bearing cartridge' }),
  ramp: mat({ base: [0.86, 0.85, 0.8], metal: 0, rough: 0.45, label: 'plastic' }),
  flex: mat({ base: [0.85, 0.47, 0.12], metal: 0, rough: 0.35, coat: 0.5, label: 'polyimide flexible circuit' }),
  board: mat({ base: [0.16, 0.45, 0.26], metal: 0, rough: 0.45, coat: 0.4, label: 'printed circuit board' }),
  pkg: mat({ ...M.epoxy, label: 'epoxy package' }),
  connector: mat({ ...M.plasticMatte, base: [0.1, 0.1, 0.11], label: 'plastic' }),
  target: mat({ base: '--dk-target', metal: 0, rough: 0.4, emit: '--dk-target', glow: 0.7, label: 'the requested wedge (drawn)' }),
  live: mat({ base: '--m3-charge', metal: 0, rough: 0.4, emit: '--m3-charge', glow: 1.3, bloom: 1.5, label: 'being read (drawn)' }),
};

// ---------------------------------------------------------------- geometry helpers

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
const lift = (g: Geo, y: number): Geo => transform(g, tr([0, y, 0]));
/** A rounded rectangle's outline in x, z (corners of radius r, n steps each). */
function roundRect(x0: number, x1: number, z0: number, z1: number, r: number, n = 6): [number, number][] {
  const out: [number, number][] = [], c: [number, number, number][] = [[x1 - r, z1 - r, 0], [x0 + r, z1 - r, 0.5], [x0 + r, z0 + r, 1], [x1 - r, z0 + r, 1.5]];
  for (const [cx, cz, a0] of c) for (let i = 0; i <= n; i++) { const a = (a0 + (0.5 * i) / n) * Math.PI; out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]); }
  return out;
}
/** An annular sector's outline about (cx, cz): radii r0 … r1, angles a0 … a1 (the parts' convention). */
function sector(cx: number, cz: number, r0: number, r1: number, a0: number, a1: number, n = 16): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + r1 * Math.cos(a), cz + r1 * Math.sin(a)]); }
  for (let i = n; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + r0 * Math.cos(a), cz + r0 * Math.sin(a)]); }
  return out;
}
/** A flat ring on the platter, face up: radii r0 … r1 at height y, angles a0 … a1. */
const annulus = (r0: number, r1: number, y: number, seg: number, a0 = 0, a1 = 2 * Math.PI): Geo => lathe([[r1, y], [r0, y]], { seg, from: a0, to: a1 });

// ---------------------------------------------------------------- the flex cable

/** The flex's centreline: off the E-block's side at the arm's angle for radius r, a loop, then down to the bracket on the
 *  casting. Always FLEX_N points, so the cable refreshes in place as the arm swings. */
const FLEX_N = 28, FLEX_END: Vec3 = [PIVOT_D + 22, BLADE_Y[1], 33];
export function flexPath(r: number): Vec3[] {
  const s = onArm([PIVOT_D + 4, BLADE_Y[1], 6.5], r), out0 = onArm([PIVOT_D + 4, BLADE_Y[1], 22], r);
  const c1: Vec3 = [out0[0], BLADE_Y[1], out0[2]], c2: Vec3 = [FLEX_END[0] - 18, BLADE_Y[1], FLEX_END[2]];
  const pts: Vec3[] = [];
  for (let i = 0; i < FLEX_N; i++) { // a cubic from the E-block's side to the bracket, leaving square to each
    const u = i / (FLEX_N - 1), a = (1 - u) ** 3, b = 3 * u * (1 - u) ** 2, c = 3 * u * u * (1 - u), d = u ** 3;
    pts.push([a * s[0] + b * c1[0] + c * c2[0] + d * FLEX_END[0], BLADE_Y[1], a * s[2] + b * c1[2] + c * c2[2] + d * FLEX_END[2]]);
  }
  return pts;
}
/** The flex's section: a strip 8 mm tall and 0.15 mm thick, standing on edge (the path lies in a horizontal plane). */
const FLEX_SECTION: [number, number][] = [[-4, -0.15], [4, -0.15], [4, 0.15], [-4, 0.15]];
const flexGeo = (r: number, detail: 'full' | 'flat'): Geo => sweep(detail === 'flat' ? flexPath(r).filter((_, i) => i % 2 === 0 || i === FLEX_N - 1) : flexPath(r), FLEX_SECTION);

// ---------------------------------------------------------------- the parts, built once per detail

interface Statics {
  casting: Geo; shroud: Geo; platters: Geo[]; hub: Geo; clamp: Geo; spacer: Geo; marks: Geo;
  eblock: Geo; bearing: Geo; blades: Geo[]; suspensions: Geo[]; sliders: Geo[]; coil: Geo; fork: Geo; preamp: Geo;
  magnetLow: Geo; yokeLow: Geo; magnetTop: Geo; yokeTop: Geo; ramp: Geo; flex: Geo; bracket: Geo;
  board: Geo; chips: { name: string; geo: Geo; note: string }[]; connector: Geo;
}
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat'): Statics {
  const hit = memo.get(detail);
  if (hit) return hit;
  const seg = detail === 'flat' ? 32 : 120, X1 = BASE_X0 + DRIVE_L, HW = DRIVE_W / 2;
  // the casting: floor, and a wall round the edge up to WALL_TOP
  const floor = lift(extrude(roundRect(BASE_X0, X1, -HW, HW, 6), FLOOR_T), -FLOOR_T);
  const ring = filletPath([[BASE_X0 + 1.5, 0, -HW + 1.5], [X1 - 1.5, 0, -HW + 1.5], [X1 - 1.5, 0, HW - 1.5], [BASE_X0 + 1.5, 0, HW - 1.5], [BASE_X0 + 1.5, 0, -HW + 1.5]], 4.5, 4);
  const wall = sweep(ring.map(([x, , z]) => [x, (WALL_TOP) / 2, z] as Vec3), [[-WALL_TOP / 2, -1.5], [WALL_TOP / 2, -1.5], [WALL_TOP / 2, 1.5], [-WALL_TOP / 2, 1.5]], { closed: true });
  const casting = merge([floor, wall], 'casting');
  // the shroud: the casting's curved wall hugging the platters, open toward the actuator
  const shroud = lathe([[PLATTER_R + 3, 0], [PLATTER_R + 3, WALL_TOP], [PLATTER_R + 1.5, WALL_TOP], [PLATTER_R + 1.5, 0]], { seg: detail === 'flat' ? 20 : 64, from: 0.55 * Math.PI, to: 1.75 * Math.PI, crease: 50 });
  // platters: a disc of PLATTER_T on the 25 mm hole, edges eased
  const e = 0.2, half = PLATTER_T / 2;
  // the faces split into rings: short triangles, which the flat view's painter sorts cleanly
  const ringsR = [20, 26, 32, 38, 43];
  const disc = lathe([[HOLE_R, -half + e], [HOLE_R + e, -half], ...ringsR.map((r) => [r, -half] as [number, number]), [PLATTER_R - e, -half], [PLATTER_R, -half + e], [PLATTER_R, half - e], [PLATTER_R - e, half],
    ...ringsR.slice().reverse().map((r) => [r, half] as [number, number]), [HOLE_R + e, half], [HOLE_R, half - e], [HOLE_R, -half + e]], { seg, crease: 30 });
  const platters = PLATTER_Y.map((y) => lift(disc, y));
  const hub = lathe([[0, 0.6], [HOLE_R - 0.05, 0.6], [HOLE_R - 0.05, PLATTER_Y[1] - half], [HOLE_R - 1, PLATTER_Y[1] + half + 0.4], [0, PLATTER_Y[1] + half + 0.4]], { seg: detail === 'flat' ? 24 : 64, crease: 40 });
  const spacer = lathe([[HOLE_R, PLATTER_Y[0] + half], [HOLE_R + 3, PLATTER_Y[0] + half], [HOLE_R + 3, PLATTER_Y[1] - half], [HOLE_R, PLATTER_Y[1] - half], [HOLE_R, PLATTER_Y[0] + half]], { seg: detail === 'flat' ? 24 : 64, crease: 40 });
  // the clamp: a dished spring disc pressing the top platter, a centre boss
  const t0 = SURFACE_TOP + 0.05; // the clamp's rim just above the platter's face (no z-fighting)
  const clamp = lathe([[0, t0 + 2.8], [5, t0 + 2.8], [5.4, t0 + 2.3], [9, t0 + 1.9], [16.5, t0 + 0.35], [17, t0], [15.5, t0], [8.6, t0 + 1.4], [0, t0 + 1.4]], { seg: detail === 'flat' ? 24 : 72, crease: 35 });
  // the drawn tracks and wedges on the top platter (at platter angle 0; they turn with it)
  const yM = t0 + 0.01, lines: Geo[] = [];
  for (let k = 0; k <= TRACKS; k++) { const r = BAND_OUT + TRACK_PITCH_MM / 2 - k * TRACK_PITCH_MM; lines.push(annulus(r - 0.14, r + 0.14, yM, detail === 'flat' ? 48 : 160)); }
  for (let s = 0; s < SECTORS; s++) {
    const w = -2 * Math.PI * s / SECTORS, wd = s === 0 ? 0.6 : 0.28, r0 = BAND_IN - TRACK_PITCH_MM / 2, r1 = BAND_OUT + TRACK_PITCH_MM / 2;
    lines.push(annulus(r0, r1, yM, 1, w - wd / ((r0 + r1) / 2) / 2, w + wd / ((r0 + r1) / 2) / 2));
  }
  const marks = merge(lines, 'marks');
  // the head stack, drawn at rest (pointing along −x from the pivot)
  const P = PIVOT_D, bearing = transform(lathe([[0, 2], [5.2, 2], [5.2, BLADE_Y[2] + 2.2], [3.4, BLADE_Y[2] + 2.6], [0, BLADE_Y[2] + 2.6]], { seg: detail === 'flat' ? 20 : 48, crease: 40 }), tr([P, 0, 0]));
  const eblock = transform(extrude(roundRect(P - 7, P + 8, -7.5, 7.5, 3.5), BLADE_Y[2] - BLADE_Y[0] + 1.4), tr([0, BLADE_Y[0] - 0.7, 0]));
  const bladeOutline: [number, number][] = [[P - 4, -5.5], [P - BLADE_L + 2, -2.4], [P - BLADE_L, -1.6], [P - BLADE_L, 1.6], [P - BLADE_L + 2, 2.4], [P - 4, 5.5]];
  const blades = BLADE_Y.map((y) => lift(extrude(bladeOutline, BLADE_T), y - BLADE_T / 2));
  // four heads: on the top arm facing down onto the top platter, two on the middle arm, one under the bottom arm
  const heads = [
    { by: BLADE_Y[2], sy: SURFACE_TOP + GAP + SLIDER_DRAWN[1] / 2 },
    { by: BLADE_Y[1], sy: PLATTER_Y[1] - half - GAP - SLIDER_DRAWN[1] / 2 },
    { by: BLADE_Y[1], sy: PLATTER_Y[0] + half + GAP + SLIDER_DRAWN[1] / 2 },
    { by: BLADE_Y[0], sy: PLATTER_Y[0] - half - GAP - SLIDER_DRAWN[1] / 2 },
  ];
  const hx = P - ARM_L, sus: Geo[] = [], sliders: Geo[] = [];
  for (const h of heads) {
    // the suspension: a flat steel beam from the arm's tip down to the slider, then a lift tab past it (it rides the ramp)
    const path: Vec3[] = [[P - BLADE_L + 1, h.by, 0], [hx + 3, h.sy, 0], [hx - 3.5, h.sy, 0]];
    sus.push(sweep(path, [[-0.07, -1.1], [0.07, -1.1], [0.07, 1.1], [-0.07, 1.1]]));
    sliders.push(bx(hx - SLIDER_DRAWN[0] / 2, hx + SLIDER_DRAWN[0] / 2, h.sy - SLIDER_DRAWN[1] / 2, h.sy + SLIDER_DRAWN[1] / 2, -SLIDER_DRAWN[2] / 2, SLIDER_DRAWN[2] / 2, 0.08));
  }
  // the voice coil: a flat trapezoidal winding on the tail, held by a fork from the E-block
  const cx = P + COIL_AT, coilPath = filletPath([[cx - 8, 10.5, -5.5], [cx + 8, 10.5, -10], [cx + 8, 10.5, 10], [cx - 8, 10.5, 5.5], [cx - 8, 10.5, -5.5]], 3, 4);
  const coil = sweep(coilPath, [[-1.2, -2.2], [1.2, -2.2], [1.2, 2.2], [-1.2, 2.2]], { closed: true });
  const fork = merge([
    transform(extrude([[P + 6, -6.5], [cx - 9.5, -8], [cx - 9.5, -4.5], [P + 6, -3]], 2.4), tr([0, 9.3, 0])),
    transform(extrude([[P + 6, 3], [cx - 9.5, 4.5], [cx - 9.5, 8], [P + 6, 6.5]], 2.4), tr([0, 9.3, 0])),
  ], 'fork');
  const preamp = bx(P - 14, P - 9, BLADE_Y[2] + BLADE_T / 2, BLADE_Y[2] + BLADE_T / 2 + 0.8, -1.8, 1.8, 0.15);
  // the magnets and yokes: arcs about the pivot covering the coil's swing (park to the innermost track)
  const aIn = -headAt(BAND_IN).alpha, aOut = -headAt(RAMP_R).alpha, m0 = aOut - 0.32, m1 = aIn + 0.32;
  const arc = (r0: number, r1: number) => sector(P, 0, r0, r1, m0, m1, detail === 'flat' ? 8 : 24);
  const magnetLow = transform(extrude(arc(COIL_AT - 9.5, COIL_AT + 9.5), 2.8), tr([0, 5.6, 0]));
  const yokeLow = transform(extrude(arc(COIL_AT - 10.5, COIL_AT + 10.5), 1.4), tr([0, 4.2, 0]));
  const magnetTop = transform(extrude(arc(COIL_AT - 9.5, COIL_AT + 9.5), 2.8), tr([0, 12.6, 0]));
  const yokeTop = transform(extrude(arc(COIL_AT - 10.5, COIL_AT + 10.5), 1.4), tr([0, 15.4, 0]));
  // the ramp: a block past the platters' edge where the heads park, a tongue for each lift tab reaching over the edge
  const ap = Math.atan2(headAt(RAMP_R).z, headAt(RAMP_R).x), da = 0.07;
  const rampBody = transform(extrude(sector(0, 0, RAMP_BODY, RAMP_OUT, ap - da, ap + da, 4), BLADE_Y[2] - BLADE_Y[0] + 4), tr([0, BLADE_Y[0] - 2, 0]));
  const tongues = [SURFACE_TOP + 1.2, PLATTER_Y[1] - half - 1.6, PLATTER_Y[0] + half + 1.6, PLATTER_Y[0] - half - 1.2].map((y) =>
    transform(extrude(sector(0, 0, RAMP_IN, RAMP_BODY, ap - da * 0.6, ap + da * 0.6, 3), 0.6), tr([0, y - 0.3, 0])));
  const ramp = merge([rampBody, ...tongues], 'ramp');
  // the flex cable (refreshed as the arm swings) and its bracket on the casting
  const flex = flexGeo(RAMP_R, detail);
  const bracket = bx(FLEX_END[0] - 1, FLEX_END[0] + 9, 0, BLADE_Y[1] + 6, FLEX_END[2] - 5, FLEX_END[2] + 5, 0.6);
  // the board under the casting, and its packages (sizes and places illustrative)
  const by0 = -FLOOR_T - BOARD_T, by1 = by0 - PACKAGE_T;
  const board = transform(extrude(roundRect(BASE_X0 + 8, X1 - 3, -HW + 4, HW - 4, 3), BOARD_T), tr([0, by0, 0]));
  const pkg = (x: number, z: number, w: number, d: number) => bx(x - w / 2, x + w / 2, by1, by0, z - d / 2, z + d / 2, 0.3);
  const chips = [
    { name: 'controller', geo: pkg(40, -14, 16, 16), note: 'the drive’s own processor: the interface, the read channel’s data, the servo and the cache' },
    { name: 'DRAM cache', geo: pkg(16, 20, 11, 18), note: 'a buffer between the interface and the platters, as an SSD has' },
    { name: 'motor driver', geo: pkg(-14, -10, 10, 10), note: 'drives the spindle motor and the voice coil' },
    { name: 'flash (firmware)', geo: pkg(62, 18, 6, 5), note: 'the controller’s program' },
  ];
  const connector = bx(X1 - 9, X1 + 0.5, by1, by0 + 1, -24, 18, 0.4);
  const s: Statics = {
    casting, shroud, platters, hub, clamp, spacer, marks, eblock, bearing, blades, suspensions: sus, sliders, coil, fork, preamp,
    magnetLow, yokeLow, magnetTop, yokeTop, ramp, flex, bracket, board, chips, connector,
  };
  memo.set(detail, s);
  return s;
}

// ---------------------------------------------------------------- the model

export interface DiskLook {
  /** The requested wedge, or none. */
  sel: { track: number; sector: number } | null;
  /** The head is reading it now (lit), or a request is under way (marked). */
  phase: 'idle' | 'seek' | 'wait' | 'transfer' | 'done';
  /** The head's radius when the model was built: the head stack's beats look where the arm is (frames fit parts at rest). */
  r?: number;
}
/** A beat's view: the direction only (its frame fits the target and distance). */
const v = (yaw: number, pitch: number) => ({ yaw, pitch, target: [24, 8, 0] as Vec3, dist: 220 });
const SHEET = 'HGST data sheet DSDS721008EN-01 (Deskstar 7K1000.B)';
const TEARDOWN = 'HDDScan teardown, labelled photos (where it is; size is this model’s)';
const CML = 'UC Berkeley CML head-disk-interface reports';

/** The requested wedge on its track, at platter angle 0 (it turns with the platters). */
function wedgeGeo(track: number, sectorN: number, detail: 'full' | 'flat'): Geo {
  const r = trackRadius(track), a1 = (-2 * Math.PI * sectorN) / SECTORS, a0 = a1 - (2 * Math.PI) / SECTORS;
  return annulus(r - TRACK_PITCH_MM * 0.42, r + TRACK_PITCH_MM * 0.42, SURFACE_TOP + 0.02, detail === 'flat' ? 6 : 24, a0, a1);
}

export function diskModel(s: DiskLook, detail: 'full' | 'flat' = 'full'): Model3 {
  const S = statics(detail), items: Item[] = [];
  const lit = s.phase === 'transfer', busy = s.phase !== 'idle' && s.phase !== 'done', r = s.r ?? RAMP_R;
  items.push({ geo: S.casting, mat: MATS.casting, name: 'base casting', group: 'base', cut: 'none',
    info: { dim: `${DRIVE_L} × ${DRIVE_W} mm; the drive is ${DRIVE_H} mm high with its cover and board`, source: SHEET, note: 'the cover is left off' } });
  items.push({ geo: S.shroud, mat: MATS.casting, name: 'base casting', group: 'base', info: { note: 'the casting’s wall round the platters, open toward the arm' } });
  S.platters.forEach((g, i) => items.push({ geo: g, mat: MATS.platter, name: 'platter', group: 'platters', explode: [0, i === 1 ? 26 : 12, 0],
    info: { dim: `${PLATTER_R * 2} mm across on a ${HOLE_R * 2} mm hole; ${PLATTER_T} mm thick (illustrative)`, note: i === 1 ? 'the top platter: its upper surface carries the drawn tracks' : 'the lower platter: a head on each side' } }));
  items.push({ geo: S.spacer, mat: MATS.hub, name: 'spacer ring', group: 'platters', explode: [0, 19, 0], info: { note: 'holds the platters apart; the arm between them reads both facing surfaces' } });
  items.push({ geo: S.hub, mat: MATS.hub, name: 'spindle hub', group: 'platters', shadow: false, info: { note: 'the spindle motor’s rotor carries the platters at 7200 rpm' } });
  items.push({ geo: S.clamp, mat: MATS.clamp, name: 'clamp', group: 'platters', explode: [0, 34, 0], shadow: false, info: { source: TEARDOWN, note: 'a spring disc pressing the stack down on the hub' } });
  items.push({ geo: S.marks, mat: MATS.marks, name: 'tracks and wedges (drawn)', group: 'platters', explode: [0, 26, 0], shadow: false, cut: 'none',
    info: { note: `12 rings stand for 118 700 tracks, 16 wedges for places round a track; nothing is printed on a real platter` } });
  if (s.sel) items.push({ geo: wedgeGeo(s.sel.track, s.sel.sector, detail), mat: lit ? MATS.live : MATS.target, name: 'requested wedge', group: 'platters', explode: [0, 26, 0], shadow: false, cut: 'none',
    info: { note: lit ? 'passing under the head: being read' : 'the wedge asked for; it turns with the platter' } });

  const armInfo = { source: TEARDOWN, note: 'milled aluminium, turning on a bearing: all four heads move together' };
  items.push({ geo: S.bearing, mat: MATS.bearing, name: 'pivot bearing', group: 'hsa', info: { note: 'the arm turns on a ball-bearing cartridge' } });
  items.push({ geo: S.eblock, mat: MATS.arm, name: 'E-block', group: 'hsa', explode: [0, 4, 0], info: armInfo });
  S.blades.forEach((g, i) => items.push({ geo: g, mat: MATS.arm, name: 'arm', group: 'hsa', explode: [0, [-6, 4, 14][i], 0], info: armInfo }));
  S.suspensions.forEach((g, i) => items.push({ geo: g, mat: MATS.suspension, name: 'suspension', group: 'hsa', explode: [0, [14, 6, 2, -6][i], 0],
    info: { source: TEARDOWN, note: 'a sprung steel beam pressing the slider toward the surface; the air dragged along by the platter lifts it' } }));
  S.sliders.forEach((g, i) => items.push({ geo: g, mat: i === 0 && busy ? (lit ? MATS.live : MATS.target) : MATS.slider, name: i === 0 ? 'head (slider)' : 'slider', group: 'hsa', explode: [0, [14, 6, 2, -6][i], 0],
    info: { dim: `drawn ${SLIDER_DRAWN[0]} × ${SLIDER_DRAWN[2]} mm, twice a pico slider’s ${PICO_MM[0]} × ${PICO_MM[1]} mm`, source: CML, note: i === 0 ? 'the active head: it flies a few nanometres above the top surface (drawn 0.25 mm)' : 'one head per surface; only one reads at a time' } }));
  items.push({ geo: S.preamp, mat: MATS.pkg, name: 'preamplifier', group: 'hsa', explode: [0, 14, 0], info: { note: 'amplifies the heads’ tiny signals right on the arm' } });
  items.push({ geo: S.fork, mat: MATS.arm, name: 'E-block', group: 'hsa', explode: [0, 4, 0], info: armInfo });
  items.push({ geo: S.coil, mat: MATS.coil, name: 'voice coil', group: 'hsa', explode: [0, 4, 0],
    info: { source: TEARDOWN, note: 'current through it in the magnets’ field pushes the tail sideways: the arm swings. Its current profile sets the seek' } });

  items.push({ geo: S.magnetLow, mat: MATS.magnet, name: 'magnet', group: 'vcm', info: { source: TEARDOWN, note: 'neodymium, one below and one above the coil' } });
  items.push({ geo: S.yokeLow, mat: MATS.yoke, name: 'yoke', group: 'vcm', info: { note: 'steel plates closing the magnets’ field across the coil' } });
  items.push({ geo: S.magnetTop, mat: MATS.magnet, name: 'magnet', group: 'vcmtop', explode: [0, 22, 0], info: { source: TEARDOWN, note: 'neodymium, one below and one above the coil' } });
  items.push({ geo: S.yokeTop, mat: MATS.yoke, name: 'yoke', group: 'vcmtop', explode: [0, 22, 0], info: { note: 'steel plates closing the magnets’ field across the coil' } });
  items.push({ geo: S.ramp, mat: MATS.ramp, name: 'ramp', group: 'ramp', info: { source: SHEET, note: 'the heads park here, off the platters, whenever the drive is idle or off: load / unload, no landing zone' } });
  items.push({ geo: S.flex, mat: MATS.flex, name: 'flex cable', group: 'flex', shadow: true, info: { source: TEARDOWN, note: 'carries the heads’ signals and the coil’s current; it bends with the arm' } });
  items.push({ geo: S.bracket, mat: MATS.connector, name: 'flex bracket', group: 'flex', info: { note: 'where the flex passes through the casting to the board' } });

  items.push({ geo: S.board, mat: MATS.board, name: 'circuit board', group: 'pcb', info: { source: TEARDOWN, note: 'under the casting: a drive is a small computer too' } });
  for (const c of S.chips) items.push({ geo: c.geo, mat: MATS.pkg, name: c.name, group: 'pcb', info: { source: TEARDOWN, note: c.note } });
  items.push({ geo: S.connector, mat: MATS.connector, name: 'SATA and power connectors', group: 'pcb' });

  const up: Vec3 = [0, 1, 0], ap = Math.atan2(headAt(RAMP_R).z, headAt(RAMP_R).x);
  const anchors: StudioAnchor[] = [
    { text: 'platters, 95 mm', p: [-PLATTER_R * 0.72, PLATTER_Y[1] + PLATTER_T / 2, PLATTER_R * 0.68], side: 'l', n: up, on: 'platters' },
    { text: 'head', p: HEAD_REST, side: 'b', n: up, on: 'hsa' },
    { text: 'arm', p: [PIVOT_D - BLADE_L * 0.6, BLADE_Y[2] + BLADE_T / 2, 0], side: 't', n: up, on: 'hsa' },
    { text: 'pivot', p: [PIVOT_D, BLADE_Y[2] + 2.6, 0], side: 't', n: up, on: 'hsa', minor: true },
    { text: 'voice coil', p: [PIVOT_D + COIL_AT + 8, 12.7, 0], side: 'r', n: up, on: 'hsa' },
    { text: 'magnet', p: [PIVOT_D + (COIL_AT + 10) * Math.cos(-headAt(RAMP_R).alpha - 0.3), 16.8, (COIL_AT + 10) * Math.sin(-headAt(RAMP_R).alpha - 0.3)], side: 'r', n: up, on: 'vcmtop', minor: true },
    { text: 'ramp', p: [RAMP_OUT * Math.cos(ap), BLADE_Y[2] + 2, RAMP_OUT * Math.sin(ap)], side: 'r', n: up, on: 'ramp', minor: true },
    { text: 'flex cable', p: [FLEX_END[0] - 6, BLADE_Y[1] + 4, FLEX_END[2]], side: 'r', n: up, on: 'flex', minor: true },
    { text: 'clamp', p: [0, SURFACE_TOP + 2.8, 0], side: 'l', n: up, on: 'platters', minor: true },
    { text: 'controller', p: [40, BOTTOM_Y, -14], side: 'l', n: [0, -1, 0], on: 'pcb', under: true },
    { text: 'DRAM cache', p: [16, BOTTOM_Y, 20], side: 'r', n: [0, -1, 0], on: 'pcb', under: true, minor: true },
  ];
  const beats: Beat[] = [
    { title: 'Two mirrors on one spindle', text: 'Two 95 mm platters, nickel-plated aluminium polished to a mirror under a magnetic film a few tens of nanometres thick, clamped to a hub that turns at 7200 rpm: once every 8.33 ms, all the time the drive is on. The rings and wedges on the top one are drawn: 12 rings stand for 118 700 tracks.', view: v(0.35, 0.75), frame: ['platters'], show: ['platters'] },
    { title: 'Four heads, one comb', text: 'One head per surface, all on one stack of arms that turns on a bearing: the E-block. Only one head reads at a time, but they move together, so a seek moves all four.', view: { yaw: 0.85, pitch: 0.55, target: onArm([PIVOT_D - 18, BLADE_Y[1], 0], r), dist: 125 }, show: ['hsa'] },
    { title: 'Flying, not touching', text: `The slider at the arm's tip is a ${PICO_MM[0]} × ${PICO_MM[1]} mm ceramic block (a pico slider; drawn twice that). The platter drags air under it and it flies a few nanometres up: about 3.5 to 5 nm by design for these sliders (Berkeley's reports), drawn here as 0.25 mm. Dust would crash it, which is why the drive is sealed.`, view: { yaw: 1.3, pitch: 0.38, target: sliderAt(r), dist: 26 }, show: ['hsa', 'platters'], hide: ['base', 'ramp', 'flex', 'vcmtop', 'pcb'] },
    { title: 'The voice coil swings it', text: 'The arm\'s tail carries a flat coil between two magnets on steel yokes (the top pair lifted off here). Current one way swings the heads in, the other way out. The seek is the time to accelerate, coast and settle onto the track: in this model a + b·√distance.', view: v(0.25, 0.95), frame: ['vcm', 'voice coil'], show: ['vcm', 'hsa'], hide: ['vcmtop', 'pcb'] },
    { title: 'Parked on the ramp', text: 'Idle or off, the arm swings past the platters\' edge and each suspension\'s lift tab climbs a plastic ramp: the heads never rest on the surface (load / unload, the data sheet\'s design). A read from here starts with a load, timed in this model as a seek from the outer track.', view: v(0.9, 0.85), frame: ['ramp'], show: ['ramp', 'hsa'], hide: ['base', 'pcb'] },
    { title: 'Apart', text: 'Lifted apart: the platters and their clamp off the hub; the E-block with its three arms, four suspensions and sliders, the preamplifier riding the top arm, the coil on the tail. Every part moves as one; the flex cable carries the signals off it.', view: v(0.8, 0.4), frame: ['hsa', 'platters'], explode: 1 },
    { title: 'Turn it over', text: 'Under the casting, a circuit board: a controller, a DRAM cache, a motor driver and a flash chip with the firmware. A disk is also a small computer: the same parts as an SSD\'s, only its storage moves.', view: v(0.6, -0.75), frame: ['pcb'], show: ['pcb'], hide: [] },
  ];
  return { items, anchors, beats, floor: BOTTOM_Y - 0.1, look: { exposure: 1 } };
}

export const DISK_HOME = { yaw: 0.5, pitch: 0.82, target: [24, 8, 0] as Vec3, dist: 220 };
/** Home: the platters and the head stack fill the canvas; the casting runs off it. */
export const DISK_HOME_FRAME = ['platters', 'head (slider)'];
/** Hidden outside its beat: the board under the casting. */
export const DISK_HIDDEN = ['pcb'];
/** The slider's centre, for tests: at rest, and on a pose. */
export const sliderAt = (r: number): Vec3 => onArm(HEAD_REST, r);
