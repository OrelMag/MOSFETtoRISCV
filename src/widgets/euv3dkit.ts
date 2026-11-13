// EUV lithography on the studio renderer, two scenes (DOM-free), in millimetres. Every number is phys/euv.ts's.
//
// The light source: the plasma at the first focus F1 (the origin) of an ellipsoidal collector whose second focus F2 is the
// intermediate focus (IF) on +x. The collector is that ellipsoid exactly, from a central hole (the laser comes in through it,
// along +x) out to the rim at the half-angle that subtends the published > 5 sr; every drawn ray goes F1 → the mirror →
// F2. Its size and the F1–F2 distance are not published: schematic. The droplet zone is to scale (30 µm droplets 1.5 mm
// apart, the 400 µm target the pre-pulse makes), so its beats zoom in; time is slowed (SLOW).
//
// The scanner: the optical path from IF to the wafer, schematic in its positions and mirror sizes (not a design), true in
// what it counts and the angles it shows: 3 illuminator mirrors (derived), the mask, 6 projection mirrors; each mirror turned
// so the ray reflects (its normal bisects the ray in and the ray out); the chief ray meeting the mask at 6°; the cones at the
// mask (asin(NA / M)) and at the wafer (asin NA); the mask's field and the wafer's to scale with each other.

import { lathe, merge, roundedBox, sphere, transform, tube, type Geo } from '../gl/kit/geo';
import { groupDigits } from '../sim/numfmt';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, GlowLight, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Quat, Vec3 } from '../gl/math';
import { COLLECT_SR, CRA_DEG, DROP, MASK, R_MIRROR, TARGET_UM, halfAngleDeg, maskField, maskHalfDeg, periodUs, spacingMm, waferHalfDeg, type Optics } from '../phys/euv';

const D2R = Math.PI / 180;
const mat = (o: Material): Material => M.make(o);
export const MATS = {
  ml: mat({ base: '--euv-ml', metal: 0.85, rough: 0.12, label: 'Mo/Si multilayer mirror (about 40 pairs of molybdenum and silicon, 7 nm a pair)' }),
  back: mat({ ...M.steel, rough: 0.5, label: 'mirror substrate' }),
  vessel: mat({ ...M.steel, base: '--euv-vessel', metal: 0.3, transmit: 0.88, tint: '--euv-vessel', rough: 0.4, label: 'source vessel (hydrogen at low pressure inside)' }),
  steel: mat({ ...M.steel, label: 'steel' }),
  tin: mat({ ...M.solder, base: '--euv-tin', metal: 0.5, rough: 0.3, label: 'liquid tin' }),
  euv: (k: number) => M.beam('--euv-light', k, '13.5 nm light (invisible; drawn violet)'),
  laser: M.beam('--euv-laser', 0.45, 'CO₂ laser main pulse, 10.6 µm (infrared; drawn red)'),
  pre: M.beam('--euv-pre', 1.4, 'pre-pulse'),
  plasma: mat({ base: '--euv-plasma', metal: 0, rough: 1, emit: '--euv-plasma', glow: 1.4, bloom: 1.1, label: 'tin plasma (about 30 eV)' }),
  mask: mat({ base: '--euv-mask', metal: 0.2, rough: 0.3, label: 'mask blank (low-expansion glass)' }),
  absorber: mat({ base: '--euv-abs', metal: 0.3, rough: 0.5, label: 'the mask’s multilayer and absorber pattern' }),
  wafer: mat({ ...M.silicon, base: '--m3-si', rough: 0.15, label: 'silicon wafer, 300 mm' }),
  field: mat({ base: '--euv-light', metal: 0, rough: 1, emit: '--euv-light', glow: 1.2, label: 'the exposure field' }),
  cone: (bad: boolean) => M.beam(bad ? '--euv-bad' : '--euv-light', 0.35, bad ? 'cones overlapping: the light in and out of the mask share angles' : 'the cone of light'),
};

const tr = (p: Vec3, s: Vec3 = [1, 1, 1]): Mat4 => { const m = new Float32Array(16); m[0] = s[0]; m[5] = s[1]; m[10] = s[2]; m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** A lathe (profile [r, along]) laid along +x from x0 (the lathe's axis y → x). */
const alongX = (g: Geo, x0: number): Geo => { const m = new Float32Array(16); m[1] = -1; m[4] = 1; m[10] = 1; m[15] = 1; m[12] = x0; return transform(g, m); };
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scl(a, 1 / len(a));
/** The rotation taking +y to n. */
export function yTo(n: Vec3): Quat {
  const u = unit(n), d = u[1];
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) return [1, 0, 0, 0];
  const ax = unit([u[2], 0, -u[0]]), h = Math.acos(d) / 2, s = Math.sin(h);
  return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(h)];
}
/** A cone of half-angle `deg` from its apex at the origin along +y, out to length L (placed and turned by its item). */
function cone(deg: number, L: number): Geo {
  const R = Math.tan(deg * D2R) * L;
  return lathe([[0, 0], [R, L], [0, L]], { seg: 40 });
}

// ================================================================ the light source

/** The collector: the ellipse with foci F1 = 0 and F2 = (2c, 0); its near vertex 200 mm behind the plasma (schematic). */
export const ELL = (() => { const c = 700, a = 900, e = c / a; return { a, c, e, p: a * (1 - e * e), b: Math.sqrt(a * a - c * c) }; })();
export const IF_X = 2 * ELL.c;
/** The rim's half-angle round the axis behind the plasma, for the published solid angle; the laser's hole. */
export const RIM_DEG = halfAngleDeg(COLLECT_SR), HOLE_DEG = 6;
/** A point of the collector at angle ψ (degrees) from the −x axis, seen from F1, in the plane z = 0 (y ≥ 0). */
export function collectorAt(psiDeg: number): Vec3 {
  const ps = psiDeg * D2R, r = ELL.p / (1 + ELL.e * Math.cos(ps));
  return [-r * Math.cos(ps), r * Math.sin(ps), 0];
}
/** Distances from a point to the two foci: on the ellipse they sum to 2a (the test holds every drawn ray to it). */
export const focalSum = (q: Vec3): number => len(q) + len(sub(q, [IF_X, 0, 0]));

/** One period of the source, slowed SLOW times; the pre-pulse → main-pulse delay (illustrative). */
export const SLOW = 200_000, DELAY_US = 3;
export interface SrcState { /** Time within the period, 0 … 1 (the pre-pulse at 0). */ tau: number; fKhz: number; vMs: number }
export const srcDefault = (): SrcState => ({ tau: 0.2, fKhz: DROP.fKhz, vMs: DROP.vMs });
/** When the main pulse fires, as a fraction of the period. */
export const mainAt = (s: SrcState): number => DELAY_US / periodUs(s.fKhz);
/** Where the pre-pulse meets the droplet: v · delay above the focus, so the target has fallen to the focus at the main pulse. */
export const preY = (s: SrcState): number => (s.vMs * DELAY_US) / 1000;
/** The flash after the main pulse, as a fraction of the period (drawn long: a real plasma lasts tens of nanoseconds). */
export const FLASH = 0.25;

/** The droplets now (centre, radius in mm), the struck one the target it is becoming. */
export function dropletsAt(s: SrcState, span = 320): { p: Vec3; r: Vec3 }[] {
  const sp = spacingMm(s.vMs, s.fKhz), y0 = preY(s), r = DROP.dUm / 2000, out: { p: Vec3; r: Vec3 }[] = [], m = mainAt(s);
  for (let k = 1; y0 + (k - s.tau) * sp < span; k++) out.push({ p: [0, y0 + (k - s.tau) * sp, 0], r: [r, r, r] });
  // the struck droplet: flattened by the pre-pulse, growing to the target as it falls to the focus; gone at the main pulse
  if (s.tau < m) {
    const g = s.tau / m, d = (DROP.dUm + (TARGET_UM - DROP.dUm) * g) / 2000;
    out.push({ p: [0, y0 - s.tau * sp, 0], r: [d * 0.35 + r * (1 - g) * 0.65, d, d] });
  }
  return out;
}

interface SrcStatics { coll: Geo; collBack: Geo; vessel: Geo; gen: Geo; catcher: Geo; ifPlate: Geo; laser: Geo; drop: Geo }
let srcMemo: SrcStatics | null = null;
function srcStatics(): SrcStatics {
  if (srcMemo) return srcMemo;
  const prof: [number, number][] = [], back: [number, number][] = [];
  for (let k = 0; k <= 48; k++) {
    const ps = HOLE_DEG + ((RIM_DEG - HOLE_DEG) * k) / 48, q = collectorAt(ps);
    prof.push([q[1], q[0]]);
    back.push([q[1] * 1.04 + 4, q[0] - 22]);
  }
  // the mirror's face a thin shell on the ellipsoid; its substrate behind
  const face = [...prof, ...[...prof].reverse().map(([r, x]) => [r * 1.004 + 0.5, x - 3] as [number, number])];
  const sub2 = [...prof.map(([r, x]) => [r * 1.004 + 0.5, x - 3] as [number, number]), ...[...back].reverse()];
  const ves: [number, number][] = [[420, -260], [420, 300], [150, IF_X - 120], [70, IF_X - 30]];
  const vesShell = [...ves, ...[...ves].reverse().map(([r, x]) => [r + 6, x] as [number, number])];
  srcMemo = {
    coll: alongX(lathe(face, { seg: 96 }), 0),
    collBack: alongX(lathe(sub2, { seg: 96 }), 0),
    vessel: alongX(lathe(vesShell, { seg: 64 }), 0),
    gen: merge([transform(lathe([[0, 0], [8, 0], [8, 8], [22, 14], [22, 110], [0, 110]], { seg: 24 }), tr([0, 330, 0]))], 'generator'),
    catcher: transform(lathe([[0, 0], [30, 0], [30, 50], [24, 50], [24, 6], [0, 6]], { seg: 24 }), tr([0, -380, 0])),
    ifPlate: alongX(lathe([[3, -3], [90, -3], [90, 3], [3, 3], [3, -3]], { seg: 48 }), IF_X),
    // the main pulse converging from behind the collector through its hole to the focus (a 400 µm waist)
    laser: alongX(lathe([[18, 0], [0.2, 620], [0, 620], [0, 0]], { seg: 32 }), -620),
    drop: sphere(1, 10, 6),
  };
  return srcMemo;
}

/** The rays drawn: from F1 to the collector at these angles, both sides, and on to F2. */
export const RAY_PSI = [16, 32, 48, 64, 76];

export function sourceModel(s: SrcState, detail: 'full' | 'flat' = 'full'): Model3 {
  const S = srcStatics(), items: Item[] = [], m = mainAt(s), since = s.tau - m;
  const on = since >= 0 && since < FLASH, fade = on ? 1 - since / FLASH : 0, flat = detail === 'flat';
  items.push({ geo: S.coll, mat: MATS.ml, name: 'collector', group: 'collector', info: { note: `an ellipsoid: the plasma at one focus, the intermediate focus at the other; it subtends ${COLLECT_SR} sr (to ${RIM_DEG.toFixed(0)}° from its axis). Size schematic`, source: 'Fomenkov et al. 2017; Laser Focus World 2017' } });
  items.push({ geo: S.collBack, mat: MATS.back, name: 'collector', group: 'collector' });
  items.push({ geo: S.vessel, mat: MATS.vessel, name: 'vessel', group: 'vessel', cut: 'open', shadow: false, order: 5, info: { note: 'hydrogen inside slows the tin ions and etches tin off the mirror; it absorbs 20–30 % of the light on the way' } });
  items.push({ geo: S.gen, mat: MATS.steel, name: 'droplet generator', group: 'tin', info: { note: `${DROP.dUm} µm droplets at ${s.fKhz} kHz and ${s.vMs} m/s: one every ${spacingMm(s.vMs, s.fKhz).toFixed(2)} mm` } });
  items.push({ geo: S.catcher, mat: MATS.steel, name: 'droplet catcher', group: 'tin' });
  items.push({ geo: S.ifPlate, mat: MATS.steel, name: 'intermediate focus', group: 'if', info: { note: 'a small aperture at the collector’s second focus: the light leaves the source here for the scanner' } });
  const ds = dropletsAt(s);
  if (!flat && ds.length) items.push({ geo: merge(ds.map((d) => transform(S.drop, tr(d.p, d.r))), 'droplets'), mat: MATS.tin, name: 'tin droplet', group: 'droplets', cut: 'none', shadow: false,
    info: { dim: `${DROP.dUm} µm`, note: 'liquid tin; the one at the focus has been flattened by the pre-pulse into a thin target' } });
  if (s.tau < 0.04) items.push({ geo: tube([[-600, preY(s) + 0.4, 0], [0, preY(s), 0]], 0.08, { sides: 8 }), mat: MATS.pre, name: 'pre-pulse', group: 'laser', cut: 'none', shadow: false });
  if (on) {
    items.push({ geo: S.laser, mat: MATS.laser, name: 'main pulse', group: 'laser', cut: 'none', shadow: false, info: { note: 'more than 20 kW on average, through the hole in the collector' } });
    items.push({ geo: transform(sphere(1, 16, 10), tr([0, 0, 0], [0.25, 0.25, 0.25])), mat: MATS.plasma, name: 'plasma', group: 'plasma', cut: 'none', shadow: false, info: { note: 'the target heated to a plasma that radiates at 13.5 nm; its 5 % or so (in band, into the half space) is the conversion efficiency' } });
    const rays: Geo[] = [];
    for (const ps of RAY_PSI) for (const sg of [1, -1]) {
      const q = collectorAt(ps), p: Vec3 = [q[0], sg * q[1], 0];
      // from 8 mm out: at the droplet's scale the rays leave the frame instead of filling it
      rays.push(tube([scl(unit(p), 8), p, [IF_X, 0, 0], add([IF_X, 0, 0], scl(unit(sub([IF_X, 0, 0], p)), 260))], 1.6, { sides: 6 }));
    }
    items.push({ geo: merge(rays, 'rays'), mat: MATS.euv(1.4 * fade + 0.1), name: '13.5 nm light', group: 'light', cut: 'none', shadow: false, info: { note: 'from the plasma to the collector and back through the intermediate focus: each ray drawn obeys the ellipse’s focal property' } });
  }
  const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.2, 1];
  const anchors: StudioAnchor[] = [
    { text: 'collector', p: collectorAt(40), side: 'l', n: front, on: 'collector' },
    { text: 'droplet generator', p: [0, 440, 0], side: 'r', n: up, on: 'tin' },
    { text: 'intermediate focus', p: [IF_X + 3, 90, 0], side: 'r', n: front, on: 'if' },
    { text: 'laser in', p: [-600, 18, 0], side: 'l', n: front, on: 'collector', minor: true },
  ];
  const lights: GlowLight[] = on && !flat ? [{ p: [0, 0, 0], colour: [0.75, 0.55, 1], power: 6 * fade, range: 400 }] : [];
  const v = (yaw: number, pitch: number, target: Vec3, dist: number) => ({ yaw, pitch, target, dist });
  const beats: Beat[] = [
    { title: 'A mirror round a spark', text: `A laser comes in through a hole in the middle of a curved mirror and strikes tin falling across the mirror’s focus, ${groupDigits(s.fKhz * 1000)} times a second. The tin flashes into a plasma; the mirror catches its 13.5 nm light over ${COLLECT_SR} sr and brings it to a second focus, the small hole the scanner looks through. Cut in half; the vessel’s size is schematic.`, view: v(0.35, 0.18, [IF_X / 2 - 200, 0, 0], 2600), frame: ['collector', 'if'] },
    { title: 'Droplets, to scale', text: `At the focus, to scale: ${DROP.dUm} µm drops of liquid tin, ${spacingMm(s.vMs, s.fKhz).toFixed(1)} mm apart at ${s.vMs} m/s. Time here runs ${groupDigits(SLOW)} times slower: one droplet every ${periodUs(s.fKhz)} µs.`, view: v(0.6, 0.2, [0, 1.4, 0], 4.5), labels: false },
    { title: 'The pre-pulse', text: `A first, weaker pulse hits each droplet just above the focus and flattens it into a thin target about ${TARGET_UM} µm across, closer to the size of the main beam’s spot, with more surface for it to heat. The delay drawn is illustrative.`, view: v(0.9, 0.15, [0, 0.12, 0], 2.2), labels: false },
    { title: 'The main pulse, up close', text: `At the target's own scale: the main pulse's focus, about 400 µm across, the size of the ${TARGET_UM} µm target the pre-pulse made; the target becomes a plasma a few tenths of a millimetre across, at the collector's focus.`, view: v(0.12, 0.1, [0, 0, 0], 2.4), labels: false },
    { title: 'The main pulse', text: 'The CO₂ laser’s main pulse turns the target into a plasma at the collector’s focus. About 5 % of the laser’s energy comes out as light in the 2 % band round 13.5 nm into the half space the mirror faces; the mirror brings what it catches to the intermediate focus.', view: v(0.35, 0.18, [IF_X / 2 - 200, 0, 0], 2600), frame: ['collector', 'if'] },
    { title: 'Twenty kilowatts for two hundred watts', text: 'Each factor costs: conversion, the share of the half space the mirror covers, the mirror’s reflectivity, the hydrogen’s absorption. The readout multiplies them; the published figure is more than 20 kW of laser for 200 W at the intermediate focus.', view: v(-0.35, 0.3, [-60, 0, 0], 1500), frame: ['collector'], hide: [] },
  ];
  return {
    items, anchors, beats, lights, flatOrder: 'items',
    // the half towards the camera removed (the camera's home is on +z)
    cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [500] },
    look: { exposure: 0.95 },
  };
}
export const SRC_HOME = { yaw: 0.35, pitch: 0.18, target: [IF_X / 2 - 200, 0, 0] as Vec3, dist: 2600 };
export const SRC_FRAME = ['collector', 'if'];

// ================================================================ the scanner

/** The chief ray's path, schematic positions (mm, the plane z = 0). The mask's neighbours sit at 6° either side of its normal. */
export const MASK_AT: Vec3 = [0, 1500, 0], WAFER_AT: Vec3 = [0, -100, 0];
const fromMask = (deg: number, L: number): Vec3 => add(MASK_AT, [Math.sin(deg * D2R) * L, -Math.cos(deg * D2R) * L, 0]);
export interface Stop { name: string; p: Vec3; r: number; kind: 'if' | 'ffm' | 'pfm' | 'fold' | 'mask' | 'pob' | 'wafer' }
export const PATH: Stop[] = [
  { name: 'intermediate focus', p: [-1450, 250, 0], r: 0, kind: 'if' },
  { name: 'field facet mirror', p: [-820, 820, 0], r: 150, kind: 'ffm' },
  { name: 'pupil facet mirror', p: [-1300, 1260, 0], r: 150, kind: 'pfm' },
  { name: 'field mirror', p: fromMask(-CRA_DEG, 520), r: 110, kind: 'fold' },
  { name: 'mask', p: MASK_AT, r: 0, kind: 'mask' },
  { name: 'projection mirror 1', p: fromMask(CRA_DEG, 700), r: 90, kind: 'pob' },
  { name: 'projection mirror 2', p: [330, 1250, 0], r: 110, kind: 'pob' },
  { name: 'projection mirror 3', p: [-300, 1300, 0], r: 120, kind: 'pob' },
  { name: 'projection mirror 4', p: [450, 700, 0], r: 120, kind: 'pob' },
  // low beside the wafer, outside its cone: the last mirror then reflects back down at near-normal incidence
  { name: 'projection mirror 5', p: [320, 60, 0], r: 90, kind: 'pob' },
  { name: 'projection mirror 6', p: [0, 380, 0], r: 0, kind: 'pob' },
  { name: 'wafer', p: WAFER_AT, r: 150, kind: 'wafer' },
];
/** A mirror's normal: the bisector of the way back to where the light came from and the way on. */
export function normalAt(i: number): Vec3 {
  const p = PATH[i].p;
  return unit(add(unit(sub(PATH[i - 1].p, p)), unit(sub(PATH[i + 1].p, p))));
}
/** The power left on the segment after stop i (i reflections so far: the IF counts none). */
export const leftAfter = (i: number, r = R_MIRROR): number => r ** Math.max(0, i);
/** The beam's brightness for a power fraction: power^0.4, so the last segments still show (the readout gives the numbers). */
export const glowOf = (f: number): number => 1.1 * f ** 0.4;
/** The beam's drawn radius (mm) for a power fraction: its area follows the power. */
export const beamR = (f: number): number => 1 + 6 * Math.sqrt(f);

export interface ScanState { optics: Optics; r: number }

export function scannerModel(s: ScanState, detail: 'full' | 'flat' = 'full'): Model3 {
  const items: Item[] = [], o = s.optics, mh = maskHalfDeg(o.na, o.mScan), wh = waferHalfDeg(o.na), bad = mh >= CRA_DEG, flat = detail === 'flat';
  // mirrors: discs turned to their normals; the last one sized to the wafer's cone; the facet mirrors as tiles
  for (let i = 1; i < PATH.length - 1; i++) {
    const st = PATH[i];
    if (st.kind === 'mask') continue;
    const n = normalAt(i), rot = yTo(n);
    const r = st.kind === 'pob' && st.r === 0 ? Math.tan(wh * D2R) * len(sub(st.p, WAFER_AT)) + 15 : st.r;
    let geo: Geo;
    if (st.kind === 'ffm' || st.kind === 'pfm') {
      const tiles: Geo[] = [];
      for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) {
        if (a * a + b * b > 10) continue;
        const w = st.kind === 'ffm' ? 36 : 30, d = st.kind === 'ffm' ? 9 : 30;
        tiles.push(transform(roundedBox(w, 8, d, 1.5, 1), tr([a * (w + 3) * (st.kind === 'ffm' ? 1 : 1.1), 0, b * (d + 3) * (st.kind === 'ffm' ? 4 : 1.1)])));
      }
      geo = merge(tiles, st.name);
    } else geo = lathe([[0, -14], [r, -14], [r, 0], [0, 0]], { seg: 48 });
    items.push({ geo, mat: MATS.ml, at: st.p, rot, name: st.name, group: st.kind === 'pob' ? 'pob' : 'ill', shadow: false,
      info: { note: st.kind === 'ffm' ? 'many small mirrors, each imaging the source onto one facet of the next mirror: together they make the field even. Facet count drawn, not real' : st.kind === 'pfm' ? 'a facet per field facet: which ones are lit sets the angles the mask is lit from (the illumination setting)' : st.kind === 'fold' ? 'shapes the light into the slit-shaped field the mask is scanned through' : `${R_MIRROR * 100} % at best: every mirror is a multilayer, nothing transmits 13.5 nm`, source: 'positions and sizes schematic' } });
  }
  // the mask, face down, its field lit
  const [mfS, mfL] = maskField(o);
  items.push({ geo: transform(roundedBox(MASK.side, MASK.t, MASK.side, 1, 1), tr(add(MASK_AT, [0, MASK.t / 2 + 0.5, 0]))), mat: MATS.mask, name: 'mask', group: 'mask',
    info: { dim: `${MASK.side} × ${MASK.side} × ${MASK.t} mm`, source: 'SEMI P37 blank', note: 'a mirror too: a multilayer under an absorber pattern, lit off-axis and scanned' } });
  items.push({ geo: transform(roundedBox(mfL, 0.6, mfS, 0, 0), tr(add(MASK_AT, [0, 0.2, 0]))), mat: MATS.absorber, name: 'mask field', group: 'mask', info: { dim: `${mfL} × ${mfS} mm`, note: `the wafer’s field × ${o.mScan} along the scan and × ${o.mSlit} across it` } });
  // the wafer and its field
  items.push({ geo: transform(lathe([[0, -0.775], [150, -0.775], [150, 0], [0, 0]], { seg: 96 }), tr(WAFER_AT)), mat: MATS.wafer, name: 'wafer', group: 'wafer', info: { dim: '300 mm', note: 'it moves under the slit, field after field' } });
  items.push({ geo: transform(roundedBox(o.field[1], 0.4, o.field[0], 0, 0), tr(add(WAFER_AT, [0, 0.2, 0]))), mat: MATS.field, name: 'exposure field', group: 'wafer', info: { dim: `${o.field[0]} × ${o.field[1]} mm`, source: 'ASML' } });
  // the chief ray, each segment as bright as the power left on it
  for (let i = 0; i < PATH.length - 1; i++) {
    const f = leftAfter(i, s.r);
    items.push({ geo: tube([PATH[i].p, PATH[i + 1].p], beamR(f), { sides: 10 }), mat: MATS.euv(glowOf(f)), name: 'light', group: 'light', cut: 'none', shadow: false,
      info: { note: `${(f * 100).toFixed(f < 0.1 ? 1 : 0)} % of the light at the intermediate focus is left here (${i} reflection${i === 1 ? '' : 's'})` } });
  }
  // the cones: in and out of the mask about the chief ray at ±6°, and onto the wafer
  if (!flat) {
    const L = 260;
    for (const sg of [-1, 1]) {
      const ax = unit(sub(fromMask(sg * CRA_DEG, 1), MASK_AT));
      items.push({ geo: cone(mh, L), at: MASK_AT, rot: yTo(ax), mat: MATS.cone(bad), name: sg < 0 ? 'cone onto the mask' : 'cone off the mask', group: 'cones', cut: 'none', shadow: false,
        info: { note: `half-angle asin(NA / ${o.mScan}) = ${mh.toFixed(1)}° about a chief ray ${CRA_DEG}° from the normal: ${bad ? 'the two cones overlap' : 'apart'}` } });
    }
    const Lw = len(sub(PATH[PATH.length - 2].p, WAFER_AT));
    items.push({ geo: cone(wh, Lw), at: WAFER_AT, mat: MATS.cone(false), name: 'cone onto the wafer', group: 'cones', cut: 'none', shadow: false, info: { note: `NA ${o.na}: half-angle ${wh.toFixed(1)}°` } });
  }
  const front: Vec3 = [0, 0.1, 1];
  const anchors: StudioAnchor[] = [
    { text: 'intermediate focus', p: PATH[0].p, side: 'l', n: front },
    { text: 'illuminator', p: PATH[1].p, side: 'l', n: front, on: 'ill' },
    { text: 'mask', p: add(MASK_AT, [0, MASK.t, 0]), side: 'r', n: front, on: 'mask' },
    { text: 'projection optics', p: PATH[7].p, side: 'r', n: front, on: 'pob' },
    { text: 'wafer', p: add(WAFER_AT, [150, 0, 0]), side: 'r', n: front, on: 'wafer' },
  ];
  const v = (yaw: number, pitch: number, target: Vec3, dist: number) => ({ yaw, pitch, target, dist });
  const beats: Beat[] = [
    { title: 'All mirrors', text: 'From the intermediate focus to the wafer the light meets ten mirrors, the mask among them: nothing transmits 13.5 nm, not even air, so the whole path is in vacuum and every optic is a multilayer mirror. Positions schematic.', view: v(0.12, 0.08, [-500, 700, 0], 3600), frame: ['ill', 'mask', 'pob', 'wafer'] },
    { title: 'Thinned at every bounce', text: `Each mirror reflects about ${Math.round(R_MIRROR * 100)} % at best. After ten, ${(R_MIRROR ** 10 * 100).toFixed(1)} % is left: the beam is drawn by the power left on it. That is why the source must make hundreds of watts.`, view: v(0.12, 0.08, [-500, 700, 0], 3600), frame: ['ill', 'mask', 'pob', 'wafer'], show: ['light', 'ill', 'pob', 'mask', 'wafer'] },
    { title: 'A mirror for a mask', text: `The mask is a mirror under its pattern, so it is lit off its normal, ${CRA_DEG}°, and the light leaves at ${CRA_DEG}° the other side. The cones in and out (half-angle asin(NA / ${o.mScan}) = ${mh.toFixed(1)}°) must not overlap. Try NA 0.55 with 4×.`, view: v(0.05, -0.05, MASK_AT, 900), show: ['cones', 'mask', 'light'] },
    { title: 'Four times smaller', text: `Six mirrors image the mask onto the wafer reduced: the ${mfL} × ${mfS} mm field on the mask becomes ${o.field[1]} × ${o.field[0]} mm on the wafer, scanned across it.`, view: v(0.3, 0.2, [0, 800, 0], 2400), frame: ['pob', 'mask', 'wafer'] },
    { title: 'The cone onto the wafer', text: `At the wafer the light converges in a cone of NA ${o.na} (half-angle ${wh.toFixed(1)}°). The finest half-pitch is k₁ · λ / NA: a wider cone prints finer, and needs a bigger last mirror.`, view: v(0.4, 0.25, [0, 120, 0], 1100), show: ['cones', 'wafer', 'pob', 'light'] },
  ];
  return { items, anchors, beats, flatOrder: 'items', look: { exposure: 0.95 } };
}
export const SCAN_HOME = { yaw: 0.12, pitch: 0.08, target: [-500, 700, 0] as Vec3, dist: 3600 };
export const SCAN_FRAME = ['ill', 'mask', 'pob', 'wafer'];
