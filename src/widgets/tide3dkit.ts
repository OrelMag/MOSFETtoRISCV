// Kelvin's tide predictor on the studio renderer, in true geometry (DOM-free; 1 unit = 10 mm, y up, the machine along x, its
// front towards +z). What it does is tide3dparts.ts's: the cranks' angles, the pulleys' offsets, the cord's constant length and
// the pen found from it. This file draws a pose of that: the parts that move go through `tidePose` (stage.move), the cord is
// one tube refreshed in place (its point count never changes), and the paper is a data texture carrying the pen's line and,
// faintly, each engaged crank's own cosine in that crank's colour: the sum on the paper, its terms beside it.
//
// Sources (in the view's note): the Science Museum Group's record of the 1872 machine (1876-1129: 1820 × 1000 × 770 mm, ten
// components; the materials list names catgut line and brass); P. L. Woodworth (2016) for the ten constituents and the crank-pin
// mechanism; IEEE Spectrum on Légé's machine for the worm gearing. Drawn, not measured: the layout, the crank discs and their
// slots, the pulleys, the worms and wheels (no tooth counts were found: the wheels are drawn alike and the ratio is in the table),
// the flywheel's size and the cord's thickness.

import { helix, lathe, merge, plane, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type DataTex, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Quat, Vec3 } from '../gl/math';
import {
  A_ARC, BASE_T, BASE_X0, BASE_X1, C0, DEPTH, GEAR_Z, HUB_Y, N_CRANKS, PAPER_L, PAPER_Y0, PAPER_Y1, PAPER_Z, PEN_DROP, PEN_X, PITCH, RAIL_Y,
  R_FIX, R_MOV, Y0, YF, angleOf, cordPath, crankX, handAngle, hubY, mainY, offsetsAt, paperSpeed, penTip, sidewaysAt, throwOf, traceOf, type Mech, type Tide,
} from './tide3dparts';

// ---------------------------------------------------------------- matrices

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** lathe()'s axis (y) onto z, through point p: pulleys, discs, wheels and shafts on the front-to-back axis. */
const onZ = (p: Vec3): Mat4 => new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, p[0], p[1], p[2], 1]);
/** lathe()'s axis (y) onto x, through point p: the main shaft and its flywheel. */
const onX = (p: Vec3): Mat4 => new Float32Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, p[0], p[1], p[2], 1]);
/** Turned by a about z through c (a crank, a pulley's wheel). */
export const turnZ = (c: Vec3, a: number): Mat4 => {
  const co = Math.cos(a), si = Math.sin(a), m = new Float32Array(16);
  m[0] = co; m[1] = si; m[4] = -si; m[5] = co; m[10] = 1; m[15] = 1;
  m[12] = c[0] - (co * c[0] - si * c[1]); m[13] = c[1] - (si * c[0] + co * c[1]); m[14] = 0;
  return m;
};
/** Turned by a about the x axis through (y, z) = (c[1], c[2]): +y towards +z. */
const turnX = (c: Vec3, a: number): Mat4 => {
  const co = Math.cos(a), si = Math.sin(a), m = new Float32Array(16);
  m[0] = 1; m[5] = co; m[6] = si; m[9] = -si; m[10] = co; m[15] = 1;
  m[13] = c[1] - (co * c[1] - si * c[2]); m[14] = c[2] - (si * c[1] + co * c[2]);
  return m;
};
/** Turned by a about a vertical axis through (x, z) = (c[0], c[2]). */
const turnY = (c: Vec3, a: number): Mat4 => {
  const co = Math.cos(a), si = Math.sin(a), m = new Float32Array(16);
  m[0] = co; m[2] = -si; m[5] = 1; m[8] = si; m[10] = co; m[15] = 1;
  m[12] = c[0] - (co * c[0] + si * c[2]); m[14] = c[2] - (-si * c[0] + co * c[2]);
  return m;
};
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo => transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** A disc (or shaft) of radius r from z0 to z1 at (x, y). */
const discZ = (x: number, y: number, z0: number, z1: number, r: number, seg: number): Geo => transform(lathe([[0, z0], [r, z0], [r, z1], [0, z1]], { seg, crease: 40 }), onZ([x, y, 0]));

// ---------------------------------------------------------------- layout

/** The crank disc's radius (the slot and its scale run along it) and its thickness, the pin's radius. */
export const DISC_R = 5.2, DISC_T = 0.8, PIN_R = 0.45;
/** The crank disc's z: behind the pulley on crank pins, in front of the yoke on the later machines. */
export const discZOf = (m: Mech): number => (m === 'pins' ? -2.6 : 3.4);
/** The worm on the main shaft (radius, length) under each crank's wheel, which meshes it: wheel radius = centre distance − worm. */
export const WORM_R = 1.1, WORM_L = 3.2;
export const WHEEL_R = (hy: number, my: number): number => hy - my - WORM_R;
/** The flywheel on the main shaft beside the hand crank (drawn: Wikipedia names a flywheel, no size found). */
export const FLY_R = 9, FLY_X = (): number => crankX(0) - 7;
/** The ink bottle and the glass pen hanging on the cord's end. */
export const BOTTLE_R = 1.1;
/** Ten colours, one a crank: its disc's marker and its cosine on the paper. */
export const CRANK_RGB: [number, number, number][] = Array.from({ length: N_CRANKS }, (_, i) => {
  const h = (i * 0.618034) % 1, s = 0.62, l = 0.5, q = l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
});

// ---------------------------------------------------------------- geometry (memoized: none of it depends on the pose)

/** A pulley: a hub and two flanges with the cord's seat between them at radius r. */
const pulleyGeo = (r: number, seg: number): Geo => lathe([[0.35, -1.1], [r + 0.55, -1.1], [r + 0.55, -0.75], [r, -0.42], [r, 0.42], [r + 0.55, 0.75], [r + 0.55, 1.1], [0.35, 1.1], [0.35, -1.1]], { seg, crease: 40 });

interface Statics {
  base: Geo; frame: Geo; table: Geo; paper: Geo; rollers: Geo[]; rollerMarks: Geo[];
  fixed: Geo; forks: Geo; mov: Geo[]; axles: Geo[]; clamp: Geo;
  shaft: Geo; worms: Geo[]; bearings: Geo; fly: Geo; hand: Geo;
  bottle: Geo; ink: Geo; pen: Geo;
}
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat', m: Mech): Statics {
  const key = `${detail}:${m}`, hit = memo.get(key);
  if (hit) return hit;
  const seg = detail === 'flat' ? 14 : 40, sides = detail === 'flat' ? 5 : 8, MY = mainY(m);
  const base = bx(BASE_X0, BASE_X1, 0, BASE_T, -DEPTH / 2, DEPTH / 2, 0.6);
  const postX = [crankX(0) - PITCH / 2 - 3, PEN_X + 3];
  const frame = merge([
    ...postX.flatMap((x) => [-4.5, 4.5].map((z) => bx(x - 1.2, x + 1.2, BASE_T, 100, z - 1.2, z + 1.2, 0.3))),
    bx(postX[0] - 1.2, postX[1] + 1.2, RAIL_Y, 100, -3, 3, 0.4),
  ], 'frame');
  const table = merge([...[-30, 30].map((z) => bx(BASE_X1 - 2, BASE_X1, BASE_T, PAPER_Y0 - 2, z - 1.5, z + 1.5)), ...(detail === 'flat' ? [] : [bx(PEN_X - 1, PEN_X + PAPER_L, PAPER_Y0 - 3, PAPER_Y1 + 3, PAPER_Z - 1.2, PAPER_Z, 0.3)])], 'paper table');
  // the flat fallback has no textures and sorts whole triangles by their centres: there the paper is a board in small tiles
  // (a big triangle would sort behind its neighbours) with no panel behind it
  const paper = detail === 'flat'
    ? merge(Array.from({ length: 36 }, (_, k) => { const i = k % 12, j = Math.floor(k / 12), w = (PAPER_L + 1) / 12, hh = (PAPER_Y1 - PAPER_Y0) / 3; return bx(PEN_X - 1 + i * w, PEN_X - 1 + (i + 1) * w, PAPER_Y0 + j * hh, PAPER_Y0 + (j + 1) * hh, PAPER_Z - 0.3, PAPER_Z); }), 'paper')
    : plane(PAPER_L + 1, PAPER_Y1 - PAPER_Y0);
  const rr = 1.6, rz = PAPER_Z + 0.2 - rr;
  const roll = (x: number) => transform(lathe([[0, PAPER_Y0 - 2], [rr, PAPER_Y0 - 2], [rr, PAPER_Y1 + 2], [0, PAPER_Y1 + 2]], { seg, crease: 40 }), tr([x, 0, rz]));
  const rollX = [PEN_X - 1 - rr, PEN_X + PAPER_L + rr];
  const rollers = rollX.map(roll), rollerMarks = rollX.map((x) => bx(x - 0.15, x + 0.15, PAPER_Y1 + 2, PAPER_Y1 + 2.15, rz, rz + rr));
  // the fixed pulleys between the cranks, each on a fork hanging from the rail
  const fixed = merge(Array.from({ length: N_CRANKS }, (_, i) => transform(pulleyGeo(R_FIX, seg), onZ([crankX(i) + PITCH / 2, YF, 0]))), 'fixed pulleys');
  const forks = merge(Array.from({ length: N_CRANKS }, (_, i) => { const xf = crankX(i) + PITCH / 2; return [-1.6, 1.6].map((z) => bx(xf - 0.35, xf + 0.35, YF, RAIL_Y, z - 0.3, z + 0.3)); }).flat()
    .concat(Array.from({ length: N_CRANKS }, (_, i) => discZ(crankX(i) + PITCH / 2, YF, -1.9, 1.9, 0.32, 12))), 'forks');
  // the movable pulleys, each built at its rest place (moved by the pose), and on the yoke machine its yoke and uprights
  const mov = Array.from({ length: N_CRANKS }, (_, i) => transform(pulleyGeo(R_MOV, seg), onZ([crankX(i), C0, 0])));
  const axles = Array.from({ length: N_CRANKS }, (_, i) => {
    const x = crankX(i);
    if (m === 'pins') return discZ(x, C0, discZOf(m), 1.5, PIN_R, 12);
    return merge([bx(x - 4.6, x + 4.6, HUB_Y - 0.6, HUB_Y + 0.6, -2.4, 2.4, 0.2), ...[-2, 2].map((z) => bx(x - 0.35, x + 0.35, HUB_Y, C0, z - 0.3, z + 0.3)), discZ(x, C0, -2.1, 2.1, 0.35, 12)], 'yoke');
  });
  const clampX = crankX(0) - A_ARC;
  const clamp = merge([bx(clampX - 0.9, clampX + 0.9, YF, YF + 1.4, -0.9, 0.9, 0.2), tube([[clampX, YF + 1.4, 0], [clampX, RAIL_Y, 0]], 0.3, { sides })], 'clamp');
  // the main shaft along x behind the cranks, a worm under each crank's wheel, its bearings, the flywheel and the hand crank
  const sx0 = FLY_X() - 3, sx1 = crankX(N_CRANKS - 1) + 6;
  const shaft = transform(lathe([[0, sx0], [0.5, sx0], [0.5, sx1], [0, sx1]], { seg: 16, crease: 40 }), onX([0, MY, GEAR_Z]));
  const worms = Array.from({ length: N_CRANKS }, (_, i) => {
    const x = crankX(i), path = helix({ r: WORM_R - 0.25, pitch: 0.55, from: x - WORM_L / 2, to: x + WORM_L / 2, perTurn: 14 }).map(([a, y, c]): Vec3 => [y, MY + a, GEAR_Z + c]);
    return merge([tube(path, 0.25, { sides: 5 }), transform(lathe([[0, x - WORM_L / 2], [WORM_R - 0.35, x - WORM_L / 2], [WORM_R - 0.35, x + WORM_L / 2], [0, x + WORM_L / 2]], { seg: 16 }), onX([0, MY, GEAR_Z]))], 'worm');
  });
  const bearings = merge([sx0 + 0.8, sx1 - 0.8].map((x) => bx(x - 1, x + 1, BASE_T, MY + 1.4, GEAR_Z - 1.4, GEAR_Z + 1.4, 0.2)), 'bearings');
  const fx = FLY_X(), fly = transform(lathe([[0.6, fx - 0.6], [FLY_R, fx - 0.6], [FLY_R, fx + 0.6], [FLY_R - 1, fx + 0.6], [FLY_R - 1, fx + 0.25], [1.2, fx + 0.25], [1.2, fx + 0.6], [0.6, fx + 0.6]], { seg: detail === 'flat' ? 20 : 56, crease: 40 }), onX([0, MY, GEAR_Z]));
  const hx = sx0 - 0.5, hand = merge([tube([[hx, MY, GEAR_Z], [hx, MY + 5, GEAR_Z]], 0.45, { sides }), tube([[hx, MY + 5, GEAR_Z], [hx - 3, MY + 5, GEAR_Z]], 0.8, { sides })], 'hand crank');
  // the pen's weight: an ink bottle and a glass pen, at rest (the pose moves them with the tip)
  const bottle = transform(lathe([[0, Y0 + 0.6], [BOTTLE_R, Y0 + 0.6], [BOTTLE_R, Y0 + PEN_DROP - 0.6], [0.45, Y0 + PEN_DROP], [0, Y0 + PEN_DROP]], { seg: 24, crease: 50 }), tr([PEN_X, 0, 0]));
  const ink = transform(lathe([[0, Y0 + 0.7], [BOTTLE_R - 0.15, Y0 + 0.7], [BOTTLE_R - 0.15, Y0 + 1.7], [0, Y0 + 1.7]], { seg: 20 }), tr([PEN_X, 0, 0]));
  const pen = tube([[PEN_X, Y0 + 1.2, 0], [PEN_X, Y0, PAPER_Z + 0.5]], 0.3, { sides });
  const s: Statics = { base, frame, table, paper, rollers, rollerMarks, fixed, forks, mov, axles, clamp, shaft, worms, bearings, fly, hand, bottle, ink, pen };
  memo.set(key, s);
  return s;
}

/** A crank as built at angle 0 (the pin straight below the hub): its disc, the slot, the silver scale with a tick a 10 mm, the
 *  pin at its throw, the shaft back to its wheel and the wheel (the worm's), marked so its turning shows. */
const crankMemo = new Map<string, { disc: Geo; slot: Geo; scale: Geo; pin: Geo; wheel: Geo; marker: Geo }>();
export function crankGeo(i: number, r: number, m: Mech, detail: 'full' | 'flat') {
  const key = `${i}:${r.toFixed(4)}:${m}:${detail}`, hit = crankMemo.get(key);
  if (hit) return hit;
  const x = crankX(i), HY = hubY(m), MY = mainY(m), zc = discZOf(m), seg = detail === 'flat' ? 16 : 36, f = 1, pd = m === 'pins' ? 1 : -1;
  const disc = merge([discZ(x, HY, zc - DISC_T / 2, zc + DISC_T / 2, DISC_R, seg), discZ(x, HY, GEAR_Z - 1, zc, 0.7, 12)], 'crank disc');
  const zs = zc + f * (DISC_T / 2 + 0.05);
  const slot = bx(x - 0.45, x + 0.45, HY - DISC_R + 0.6, HY - 0.5, Math.min(zs, zs + f * 0.1), Math.max(zs, zs + f * 0.1));
  const scale = merge([bx(x + 0.6, x + 1.0, HY - DISC_R + 0.6, HY - 0.5, Math.min(zs, zs + f * 0.12), Math.max(zs, zs + f * 0.12)),
    ...[1, 2, 3, 4].map((k) => bx(x + 0.5, x + 1.3, HY - k - 0.06, HY - k + 0.06, Math.min(zs, zs + f * 0.2), Math.max(zs, zs + f * 0.2)))], 'scale');
  const pin = discZ(x, HY - r, Math.min(zc, zc + pd * 1.6), Math.max(zc, zc + pd * 1.6), PIN_R, 14);
  const wr = WHEEL_R(HY, MY);
  const wheel = discZ(x, HY, GEAR_Z - 0.6, GEAR_Z + 0.6, wr, seg);
  const marker = merge([bx(x - 0.2, x + 0.2, HY - wr + 0.3, HY - 0.6, GEAR_Z + 0.6, GEAR_Z + 0.75), discZ(x, HY - DISC_R + 0.35, zs, zs + f * 0.15, 0.32, 10)], 'marker');
  const g = { disc, slot, scale, pin, wheel, marker };
  crankMemo.set(key, g);
  return g;
}

/** The cord: one tube, refreshed in place each pose (cordPath's point count is the same for every pose). */
const cords = new Map<string, Geo>();
export const cordGeo = (detail: 'full' | 'flat', path: Vec3[]): Geo => tube(path, CORD_DRAWN, { sides: detail === 'flat' ? 4 : 8 });
/** The cord as drawn: about twice the radius it is routed at (R_CORD), so it reads at home; the note says so. */
export const CORD_DRAWN = 0.5;
export function cordOf(detail: 'full' | 'flat'): Geo | undefined { return cords.get(detail); }
export function setCord(detail: 'full' | 'flat', g: Geo): void { cords.set(detail, g); }

// ---------------------------------------------------------------- the paper

/** Texture pixels across the paper and down it. */
export const PAPER_W = 512, PAPER_H = 256;
const PX_X = PAPER_W / (PAPER_L + 1), PX_Y = PAPER_H / (PAPER_Y1 - PAPER_Y0);
/** A paper point (model units) as a texel: u from the pen end, v from the top. */
export const texel = (x: number, y: number): [number, number] => [(x - (PEN_X - 1)) * PX_X, (PAPER_Y1 - y) * PX_Y];
export const newPaper = (): DataTex => ({ w: PAPER_W, h: PAPER_H, pixels: new Uint8Array(PAPER_W * PAPER_H * 4), rev: 0, mode: 'albedo', smooth: true });

function line(tex: DataTex, a: [number, number], b: [number, number], rgb: [number, number, number], w: number, alpha: number): void {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 1.5)), r = w / 2;
  for (let k = 0; k <= n; k++) {
    const cx = a[0] + ((b[0] - a[0]) * k) / n, cy = a[1] + ((b[1] - a[1]) * k) / n;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= tex.w || y >= tex.h) continue;
      const cov = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x - cx, y - cy))) * alpha;
      if (cov <= 0) continue;
      const o = (y * tex.w + x) * 4;
      for (let c = 0; c < 3; c++) tex.pixels[o + c] = Math.round(tex.pixels[o + c] * (1 - cov) + rgb[c] * 255 * cov);
    }
  }
}
const PAPER_RGB: [number, number, number] = [0.96, 0.93, 0.85], INK: [number, number, number] = [0.1, 0.14, 0.32], RULE: [number, number, number] = [0.72, 0.68, 0.6];

/** The paper now: the mean line, a mark each `mark` of time carried with the paper, each engaged crank's own term (2 d_i about
 *  the rest height: what its pulley adds to the pen) faint in its colour, and the pen's line, which is their sum. */
export function paintPaper(tex: DataTex, td: Tide, on: readonly boolean[], t: number, m: Mech): void {
  const p = tex.pixels;
  for (let k = 0; k < p.length; k += 4) { p[k] = PAPER_RGB[0] * 255; p[k + 1] = PAPER_RGB[1] * 255; p[k + 2] = PAPER_RGB[2] * 255; p[k + 3] = 255; }
  const v = paperSpeed(td);
  line(tex, texel(PEN_X - 1, Y0), texel(PEN_X + PAPER_L, Y0), RULE, 1, 0.8);
  for (let j = Math.ceil((t - PAPER_L / v) / td.mark); j <= Math.floor(t / td.mark); j++) {
    const at = j * td.mark, x = PEN_X + (t - at) * v;
    if (at < 0 || x < PEN_X || x > PEN_X + PAPER_L) continue;
    line(tex, texel(x, PAPER_Y0), texel(x, PAPER_Y0 + 2.2), INK, 1.4, 0.9);
  }
  const tr0 = traceOf(td, on, t, m);
  // each crank's term over the same times (2 d_i: a pulley that moves d takes up 2d of cord)
  for (let i = 0; i < N_CRANKS; i++) {
    if (!on[i]) continue;
    const h = td.harms[i], r = throwOf(h);
    let prev: [number, number] | null = null;
    for (let j = 0; j <= td.traceN; j++) {
      const tj = t - (td.span * j) / td.traceN;
      if (tj < 0) break;
      const q = texel(PEN_X + (t - tj) * v, Y0 + 2 * r * Math.cos(angleOf(h, td.n, tj)));
      if (prev) line(tex, prev, q, CRANK_RGB[i], 1.6, 0.42);
      prev = q;
    }
  }
  for (let j = 1; j < tr0.length; j++) line(tex, texel(tr0[j - 1].x, tr0[j - 1].y), texel(tr0[j].x, tr0[j].y), INK, 2.4, 1);
  tex.rev++;
}

// ---------------------------------------------------------------- materials

const SMG = 'Science Museum Group, object 1876-1129 (Thomson’s 1872 machine by A. Légé & Co.)';
const WOOD = 'Woodworth, An inventory of tide prediction machines (NOC Report 56, 2016), p. 15';
export const MATS = {
  wood: M.make({ base: [0.2, 0.13, 0.09], metal: 0, rough: 0.7, coat: 0.2, label: 'wood base (dark; drawn)' }),
  mahogany: M.make({ base: [0.3, 0.13, 0.08], metal: 0, rough: 0.4, coat: 0.6, label: 'mahogany, polished' }),
  iron: M.make({ base: [0.33, 0.35, 0.36], metal: 0.55, rough: 0.5, label: 'cast iron, painted' }),
  // brass partly diffuse: a fully metallic one only mirrors the dark board at home
  brass: M.make({ base: [0.86, 0.66, 0.32], metal: 0.7, rough: 0.26, label: 'brass' }), steel: M.make({ base: [0.78, 0.8, 0.84], metal: 0.7, rough: 0.28, label: 'steel' }), silver: M.make({ base: [0.95, 0.95, 0.97], metal: 0.4, rough: 0.2, label: 'silver-plated scale' }),
  off: M.make({ base: [0.42, 0.42, 0.44], metal: 0.6, rough: 0.5, label: 'disengaged' }),
  cord: M.make({ base: [0.98, 0.94, 0.82], metal: 0, rough: 0.55, emit: [0.98, 0.94, 0.82], glow: 0.18, label: 'catgut line, drawn light and many times thicker than it was' }),
  paper: (tex: DataTex): Material => M.make({ base: [1, 1, 1], metal: 0, rough: 0.9, data: tex, label: 'paper' }),
  bottle: M.make({ ...M.glass, transmit: 0.8, label: 'glass ink bottle' }),
  ink: M.make({ base: [0.08, 0.1, 0.25], metal: 0, rough: 0.2, label: 'ink' }),
  pen: M.make({ ...M.glass, transmit: 0.7, label: 'glass pen' }),
  marker: (i: number): Material => M.make({ base: CRANK_RGB[i], metal: 0, rough: 0.4, emit: CRANK_RGB[i], glow: 0.25, label: 'this crank’s colour (drawn): its term on the paper' }),
};

// ---------------------------------------------------------------- the model

export interface TideState { td: Tide; on: readonly boolean[]; t: number; mech: Mech; paper: DataTex }
/** A quarter turn about x: plane() (x, z, facing +y) upright, facing the front (+z), its v running down. */
const UPRIGHT: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

export function tideModel(s: TideState, detail: 'full' | 'flat' = 'full'): Model3 {
  const { td, on, mech } = s, S = statics(detail, mech), items: Item[] = [];
  items.push({ geo: S.base, mat: MATS.wood, name: 'base', group: 'base', info: { dim: '1820 × 770 mm (the machine overall: 1820 × 1000 × 770 mm)', source: SMG } });
  items.push({ geo: S.frame, mat: MATS.mahogany, name: 'frame and top rail', group: 'frame', info: { note: 'carries the fixed pulleys and the cord’s clamp (layout drawn)' } });
  items.push({ geo: S.table, mat: MATS.mahogany, name: 'paper table', group: 'paper' });
  if (detail === 'flat') items.push({ geo: S.paper, mat: M.make({ base: [0.95, 0.92, 0.84], metal: 0, rough: 0.9, label: 'paper' }), name: 'paper band', group: 'paper' });
  // and the pen's line as a tube on it (the flat view is rebuilt every frame, so it is made fresh)
  if (detail === 'flat') { const tr0 = traceOf(td, on, s.t, mech); if (tr0.length > 1) items.push({ geo: tube(tr0.map((p): Vec3 => [p.x, p.y, PAPER_Z + 0.25]), 0.35, { sides: 3 }), mat: MATS.ink, name: 'paper band', group: 'paper' }); }
  else items.push({ geo: S.paper, mat: MATS.paper(s.paper), at: [PEN_X - 1 + (PAPER_L + 1) / 2, (PAPER_Y0 + PAPER_Y1) / 2, PAPER_Z + 0.21], rot: UPRIGHT, name: 'paper band', group: 'paper', shadow: false,
    info: { note: td.kind === 'tide' ? 'a mark a day; the pen’s line is the predicted tide, each faint line one constituent’s share' : 'the pen’s line is the sum; each faint line is one crank’s term, in its colour' } });
  S.rollers.forEach((g, k) => items.push({ geo: g, mat: MATS.steel, name: k ? 'take-up drum' : 'supply roller', group: k ? 'drum' : 'supply' }, { geo: S.rollerMarks[k], mat: MATS.ink, name: k ? 'take-up drum' : 'supply roller', group: k ? 'drum' : 'supply' }));
  items.push({ geo: S.fixed, mat: MATS.brass, name: 'fixed pulley', group: 'fixed', info: { dim: `${(2 * R_FIX * 10).toFixed(0)} mm across (drawn, not measured)` } });
  items.push({ geo: S.forks, mat: MATS.iron, name: 'fork', group: 'fixed' });
  items.push({ geo: S.clamp, mat: MATS.brass, name: 'cord clamp', group: 'fixed', info: { note: 'the cord’s fixed end' } });
  for (let i = 0; i < N_CRANKS; i++) {
    const h = td.harms[i], g = crankGeo(i, on[i] ? throwOf(h) : 0, mech, detail), metal = on[i] ? MATS.brass : MATS.off, name = td.kind === 'tide' ? `crank ${td.names[i]}` : `crank k = ${td.names[i]}`;
    const note = `${td.kind === 'tide' ? `${td.names[i]}, ${h.k.toFixed(4)} °/h` : `harmonic ${td.names[i]}`}: throw ${(10 * throwOf(h)).toFixed(0)} mm${on[i] ? '' : ' (disengaged)'}`;
    items.push({ geo: g.disc, mat: metal, name, group: `crank${i}`, info: { note, source: 'the slot and its scale: drawn after the SMG record’s “silver-plated scales”' } });
    items.push({ geo: g.slot, mat: MATS.iron, name, group: `crank${i}` }, { geo: g.scale, mat: MATS.silver, name, group: `crank${i}` });
    items.push({ geo: g.pin, mat: MATS.steel, name, group: `crank${i}` }, { geo: g.wheel, mat: metal, name: 'worm wheel', group: `crank${i}`, info: { note: 'driven by the worm on the main shaft; its ratio (in the table) is in the teeth, which are not drawn: no tooth counts were found', source: 'IEEE Spectrum on Légé’s machine (worm gearing)' } });
    items.push({ geo: g.marker, mat: MATS.marker(i), name, group: `crank${i}`, shadow: false });
    items.push({ geo: S.mov[i], mat: on[i] ? MATS.brass : MATS.off, name: mech === 'pins' ? 'pulley on its crank pin' : 'movable pulley', group: `pulley${i}`, info: { dim: `${(2 * R_MOV * 10).toFixed(0)} mm across (drawn)`, source: mech === 'pins' ? WOOD : undefined, note: mech === 'pins' ? 'it goes round with the pin: up and down, and a little sideways (the 1872 machine)' : 'on a slotted yoke: straight up and down (every later machine)' } });
    items.push({ geo: S.axles[i], mat: mech === 'pins' ? MATS.steel : MATS.iron, name: mech === 'pins' ? 'crank pin' : 'slotted yoke', group: mech === 'pins' ? `crank${i}` : `pulley${i}` });
    items.push({ geo: S.worms[i], mat: MATS.steel, name: 'worm', group: 'shaft' });
  }
  items.push({ geo: S.shaft, mat: MATS.steel, name: 'main shaft', group: 'shaft', info: { note: 'one turn of the hand crank: one period of the wave, or a mean solar day on the tide' } });
  items.push({ geo: S.bearings, mat: MATS.iron, name: 'bearing', group: 'frame' });
  items.push({ geo: S.fly, mat: MATS.iron, name: 'flywheel', group: 'shaft', info: { source: 'Wikipedia, “Tide-predicting machine” (a flywheel); its size is drawn' } });
  items.push({ geo: S.hand, mat: MATS.wood, name: 'hand crank', group: 'shaft' });
  const cg = cordOf(detail) ?? (setCord(detail, cordGeo(detail, cordPath(offsetsAt(td, on, s.t), td.dc, sidewaysAt(td, on, s.t, mech)))), cordOf(detail)!);
  items.push({ geo: cg, mat: MATS.cord, name: 'cord', group: 'cord', shadow: false, info: { source: `${SMG}: catgut line`, note: 'fixed at one end, under every movable pulley and over every fixed one, the pen at its other end: a pulley that moves d takes up 2d' } });
  items.push({ geo: S.bottle, mat: MATS.bottle, name: 'ink bottle and pen', group: 'pen', order: 2 }, { geo: S.ink, mat: MATS.ink, name: 'ink bottle and pen', group: 'pen' }, { geo: S.pen, mat: MATS.pen, name: 'ink bottle and pen', group: 'pen', order: 3, info: { note: 'the cord’s weight: the pen rises and falls with what the pulleys take up' } });

  const front: Vec3 = [0, 0.15, 1], HY = hubY(mech);
  const anchors: StudioAnchor[] = [
    { text: 'cranks', p: [crankX(3), HY - DISC_R, discZOf(mech)], side: 'b', n: front, on: 'crank3' },
    { text: mech === 'pins' ? 'pulley on a pin' : 'pulley on a yoke', p: [crankX(6), C0 + R_MOV, 1], side: 'l', n: front, on: 'pulley6' },
    { text: 'cord', p: [crankX(8) + PITCH / 4, (C0 + YF) / 2, 0], side: 'l', n: front, on: 'cord' },
    { text: 'pen', p: [PEN_X, Y0 + 2, 0], side: 'r', n: front, on: 'pen' },
    { text: 'paper', p: [PEN_X + 40, PAPER_Y1, PAPER_Z], side: 't', n: front, on: 'paper' },
    { text: 'hand crank', p: [FLY_X(), mainY(mech) + FLY_R, GEAR_Z], side: 'l', n: front, on: 'shaft' },
  ];
  const all = { yaw: 0.16, pitch: 0.24, target: [31, 46, 0] as Vec3, dist: 242 };
  const beats: Beat[] = [
    { title: 'One hand crank, ten cranks', text: 'The hand crank turns the main shaft; a worm on it turns each crank at its own rate. Each crank carries a pulley; one cord runs under all of them and over a fixed pulley between each pair, and a pen hangs at its end on a band of paper.', view: all, frame: ['frame', 'shaft', 'fixed', 'pen'] },
    { title: 'A crank sets one term', text: 'The pin’s distance from the hub is the term’s amplitude (the slot and its silver scale set it), its angle at the start the phase, and the worm’s ratio the speed. The coloured mark is this crank’s colour on the paper.', view: { yaw: 0.25, pitch: 0.12, target: [crankX(1), HY, 0], dist: 70 }, frame: ['crank1', 'pulley1'] },
    { title: 'The cord adds', text: 'A pulley that moves down by d pulls 2d of cord into its loop, and the pen rises by 2d; the cord adds every pulley’s motion. So the pen’s height is the sum of the cranks’ terms, found by the cord’s length alone.', view: { yaw: 0.05, pitch: 0.1, target: [crankX(6), (C0 + YF) / 2, 0], dist: 120 }, frame: ['cord', 'pen', 'pulley7', 'pulley8', 'pulley9'] },
    { title: 'The sum on the paper', text: 'The faint lines are each crank’s own term, in its colour; the pen’s ink is their sum. Switch cranks off and the sum loses those terms.', view: { yaw: 0.02, pitch: 0.04, target: [PEN_X + PAPER_L / 2, (PAPER_Y0 + PAPER_Y1) / 2, 0], dist: 90 }, frame: ['paper band'] },
    { title: '1872: pulleys on crank pins', text: 'On this machine each pulley turned on its crank’s pin, so it moved sideways too: the cord’s legs tilt and the sum is out by a little. Every later machine moved its pulleys straight up and down on a slotted yoke (Woodworth 2016, after Cartwright 1999). The Mechanism switch shows both.', view: { yaw: 0.3, pitch: 0.15, target: [crankX(4), C0, 0], dist: 90 }, frame: ['crank4', 'pulley4', 'crank5', 'pulley5'] },
  ];
  return { items, anchors, beats, floor: 0, look: { exposure: 1.3, keyDir: [-0.35, 0.8, 0.55] } };
}

/** Every moving part's motion at time t, and the cord refreshed in place. */
export function tidePose(s: TideState): Map<string, Mat4> {
  const { td, on, t, mech } = s, moves = new Map<string, Mat4>(), d = offsetsAt(td, on, t), e = sidewaysAt(td, on, t, mech), HY = hubY(mech), MY = mainY(mech);
  for (let i = 0; i < N_CRANKS; i++) {
    const x = crankX(i);
    moves.set(`crank${i}`, turnZ([x, HY, 0], on[i] ? angleOf(td.harms[i], td.n, t) : 0));
    moves.set(`pulley${i}`, tr([e[i], -d[i], 0]));
  }
  moves.set('shaft', turnX([0, MY, GEAR_Z], handAngle(td, t)));
  moves.set('pen', tr([0, penTip(d, td.dc, e) - Y0, 0]));
  const v = paperSpeed(td), rr = 1.6, rz = PAPER_Z + 0.2 - rr;
  moves.set('supply', turnY([PEN_X - 1 - rr, 0, rz], (-t * v) / rr));
  moves.set('drum', turnY([PEN_X + PAPER_L + rr, 0, rz], (-t * v) / rr));
  return moves;
}
/** The cord's tube for this pose, copied into the drawn one (same counts). */
export function cordAt(s: TideState, detail: 'full' | 'flat'): Geo {
  return cordGeo(detail, cordPath(offsetsAt(s.td, s.on, s.t), s.td.dc, sidewaysAt(s.td, s.on, s.t, s.mech)));
}

export const TIDE_HOME = { yaw: 0.14, pitch: 0.13, target: [31, 46, 0] as Vec3, dist: 242 };
