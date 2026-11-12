// The half-wave dipole as a studio model (DOM-free): the same antenna and the same closed forms as before
// (dipole3dparts.ts: the standing-wave current, the far-field pattern, the loops), in true geometry and in millimetres.
// Two copper arms lathed with rounded tips, coloured along their length by the current they carry; the charge at the tips
// glowing with the voltage; the pattern as one smooth surface of revolution, radius R f(theta), with the isotropic sphere
// of the same radiated power inside it, so the lobe poking out broadside IS the gain; the half-power rings on it; the
// effective aperture A = G lambda^2 / 4 pi as a disk; the feed as balanced leads, a semi-rigid coax cut open to its three
// layers, or that coax inside a quarter-wave sleeve. A cut down the middle shows the pattern's section: the polar plot.

import { extrude, lathe, roundedBox, sphere, torus, tube, type Geo, refresh as refreshGeo, paint as paintGeo } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { RGB, Instance } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { apertureM2, wavelengthM } from '../phys/radio';
import {
  COAX_LEN, COAX_X0, CURVE_A, DRAWN_SCALE, GAP, LAMBDA, L_HALF, PATTERN_R, REAL_DIAMETER, SLEEVE_LEN, SLEEVE_R, cutHalf, cutLength, currentAt, directivity, envelope,
  gainDbi, halfPower, loopOutline, loopsAt, surfaceAt, voltageAt, type DipoleRun, type Feed, type PatternMode,
} from './dipole3dparts';
import { ANTENNA_GHZ } from './radio';

/** The parts file is in cm; the studio in mm. */
const MM = 10;
const T = (x: number, d = 1) => x.toFixed(d);

// ---------------------------------------------------------------- sourced dimensions (mm)

/** Semi-rigid .086 in coax (UT-085C-TP data sheet): copper jacket 0.0865 in, PTFE 0.066 in, centre conductor 0.0201 in. */
export const COAX = { jacket: 0.0865 * 25.4, ptfe: 0.066 * 25.4, centre: 0.0201 * 25.4 } as const;
/** The arm: a 2 mm copper rod, drawn DRAWN_SCALE thicker so the current's colour reads. */
export const ROD_R = (REAL_DIAMETER * MM * DRAWN_SCALE) / 2;
/** A frequency to compare against: the aperture at 28 GHz (the step's own second number). */
export const GHZ_HI = 28;
/** An illustrative phone outline for scale (71 × 147 × 8 mm, said so in its card). */
export const PHONE = { w: 71, h: 147, d: 8 } as const;

export const SRC = {
  chapter: 'computed by phys/radio.ts and dipole3dparts.ts, the radio chapter\'s numbers',
  balanis: 'Balanis, Antenna Theory, ch. 4: the sinusoidal current of a thin centre-fed dipole and its far field',
  endEffect: 'cut 0.95 of the electrical half wave (ARRL Antenna Book; Wikipedia "Dipole antenna": 0.94 to 0.98 by thickness)',
  coax: 'UT-085C-TP semi-rigid coax data sheet: 0.0865 in jacket, 0.066 in PTFE, 0.0201 in centre conductor',
  sleeve: 'a quarter-wave sleeve (bazooka) balun: shorted at its far end, so the braid\'s outside sees a high impedance (antenna-theory.com)',
  illus: 'illustrative: no maker\'s drawing',
};

/** The effective aperture (mm²) of this dipole at a frequency: A = G λ² / 4π, G its directivity. */
export const apertureMm2 = (lwl: number, ghz: number): number => (directivity(lwl) * (wavelengthM(ghz) * 1000) ** 2) / (4 * Math.PI);
/** The radius (relative to the pattern's peak) of the sphere that radiates the same total power: the mean of the drawn surface's quantity. */
export const isoRadius = (lwl: number, mode: PatternMode): number => (mode === 'power' ? 1 / directivity(lwl) : 1 / Math.sqrt(directivity(lwl)));

// ---------------------------------------------------------------- geometry, built once per length / mode / detail

type Detail = 'full' | 'flat';
const quatZ = (a: number): [number, number, number, number] => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const quatX = (a: number): [number, number, number, number] => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
/** Lathe about y turned onto -x: a coax layer from the feed outward. */
const ALONG_MINUS_X = quatZ(Math.PI / 2);
const FACE_Z = quatX(Math.PI / 2);

const memo = new Map<string, Geo>();
const once = (key: string, make: () => Geo): Geo => { let g = memo.get(key); if (!g) { g = make(); memo.set(key, g); } return g; };

/** The pattern's profile walked from theta = pi (below) to 0 (above): radius R f sin(theta), height R f cos(theta). */
export function patternProfile(lwl: number, mode: PatternMode, n: number): [number, number][] {
  const R = PATTERN_R * MM, out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const th = Math.PI * (1 - i / n), r = R * surfaceAt(th, lwl, mode);
    out.push([i === 0 || i === n ? 0 : Math.max(0, r * Math.sin(th)), r * Math.cos(th)]);
  }
  return out;
}

/** One arm, feed edge to rounded tip, along +y (the lower one is turned over). */
const armGeo = (lwl: number, d: Detail) => once(`arm|${lwl}|${d}`, () => {
  const y0 = (GAP / 2) * MM, y1 = cutHalf(lwl) * MM, n = d === 'full' ? 40 : 10, prof: [number, number][] = [[0, y0], [ROD_R, y0]];
  for (let i = 1; i < n; i++) prof.push([ROD_R, y0 + ((y1 - ROD_R - y0) * i) / n]);
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push([i === 6 ? 0 : ROD_R * Math.cos(a), y1 - ROD_R + ROD_R * Math.sin(a)]); }
  return lathe(prof, { seg: d === 'full' ? 24 : 8 });
});
/** The current curve I(z) (y-z plane) or the voltage curve V(z) (x-y plane): rebuilt in place as the wave moves. */
const CURVE_N = 33;
const curvePath = (lwl: number, f: (z: number) => number, axis: 0 | 2): Vec3[] => {
  const hc = cutHalf(lwl);
  return Array.from({ length: CURVE_N }, (_, i) => { const z = -hc + (2 * hc * i) / (CURVE_N - 1), p: Vec3 = [0, z * MM, 0]; p[axis] = CURVE_A * MM * f(z); return p; });
};
const curveGeo = (key: string, path: Vec3[], r: number) => {
  const g = memo.get(key), next = tube(path, r, { sides: 6 });
  if (!g) { memo.set(key, next); return next; }
  return refreshGeo(g, next);
};

// ---------------------------------------------------------------- the model at a state

export interface DipoleLook {
  detail: Detail;
  mode: PatternMode;
  feed: Feed;
  /** Show the pattern (the doughnut, the isotropic sphere, the half-power rings). */
  pattern: boolean;
  /** Put the 28 GHz dipole, its aperture and a phone beside the 2.4 GHz one. */
  hi: boolean;
  /** Theme colours the arms are painted with (resolved by the view: the kit stays DOM-free). */
  rgb: { cu: RGB; pos: RGB; neg: RGB };
}

const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
/** The colour of the arm at height z (cm) now: copper at no current, red one way, blue the other. */
export const currentColour = (z: number, run: DipoleRun, c: DipoleLook['rgb']): RGB => {
  const v = currentAt(z, run.phase, run.lwl);
  return mix(c.cu, v >= 0 ? c.pos : c.neg, Math.min(1, Math.abs(v) * 1.1));
};

export function dipoleModel(run: DipoleRun, look: DipoleLook): Model3 {
  const L = run.lwl, d = look.detail, full = d === 'full', items: Item[] = [], hc = cutHalf(L) * MM, R = PATTERN_R * MM;
  const lam = LAMBDA * MM, D = directivity(L), half = Math.abs(L - L_HALF) < 1e-9;

  // The arms: copper, painted along their length by the current there (the paint is the current, not a finish).
  const armMat = M.make({ base: [1, 1, 1], metal: 0.55, rough: 0.3, label: 'copper rod, coloured by its current (red up, blue down)' });
  const armInfo = { dim: `${T(cutLength(L) * MM / 2)} mm each, ${REAL_DIAMETER * MM} mm rod (drawn ${DRAWN_SCALE}× thicker)`, source: SRC.endEffect, note: `${T(L, 2)} λ electrical; the current is zero at the tip, where the wire ends` };
  // each arm its own geometry (the same shape), so each carries its own current's colours; the lower one turned over
  const up = armGeo(L, d), lo = once(`armLo|${L}|${d}`, () => ({ ...up, positions: up.positions.slice(), normals: up.normals.slice(), colors: undefined, rev: 0 }));
  for (const [g, side] of [[up, 1], [lo, -1]] as const) {
    paintGeo(g, (p) => currentColour((side * p[1]) / MM, run, look.rgb));
    items.push({ geo: g, mat: armMat, rot: side > 0 ? undefined : quatZ(Math.PI), name: 'arm', group: 'arms', cut: 'none', info: armInfo });
  }
  // The charge at the tips: the voltage there, in quadrature with the current; a glow, not a part.
  for (const side of [1, -1]) {
    const v = voltageAt(side * cutHalf(L), run.phase, L), k = Math.min(1, Math.abs(v) * 1.2);
    if (k > 0.03) items.push({ geo: once('tipGlow', () => sphere(ROD_R * 1.5, 16, 10)), mat: M.beam(v >= 0 ? '--dp-pos' : '--dp-neg', 0.9 * k, 'charge at the tip'), at: [0, side * (hc - ROD_R), 0], group: 'charge', cut: 'none', shadow: false });
  }
  // The feed: a PTFE block across the gap.
  items.push({ geo: once('ins', () => roundedBox(9, GAP * MM + 10, 9, 1.5, full ? 3 : 1)), mat: M.make({ base: '--dp-ins', metal: 0, rough: 0.55, label: 'PTFE' }), name: 'feed gap', group: 'feed', cut: 'none',
    info: { dim: `${GAP * MM} mm gap`, source: SRC.illus, note: half ? 'the current is largest here: 73 Ω of radiation resistance (a cut half wave, its reactance trimmed out)' : 'the feed: where the line meets the arms' } });
  feedItems(items, run, look);

  // The current and voltage along the arms, as curves beside them (the height arbitrary: a graph, not a part).
  const ghost = M.make({ base: '--dp-ghost', metal: 0, rough: 0.6, transmit: 0.5, label: 'the current\'s envelope' });
  for (const sg of [1, -1]) items.push({ geo: once(`env|${L}|${sg}`, () => tube(curvePath(L, (z) => sg * envelope(z, L), 2), 0.35, { sides: 5 })), mat: ghost, cut: 'none', shadow: false, group: 'curves' });
  const i0 = Math.cos(run.phase);
  items.push({ geo: curveGeo(`I|${L}`, curvePath(L, (z) => currentAt(z, run.phase, L), 2), 0.8), mat: M.make({ base: i0 >= 0 ? '--dp-pos' : '--dp-neg', metal: 0, rough: 0.4, emit: i0 >= 0 ? '--dp-pos' : '--dp-neg', glow: 0.25, label: 'the current I(z) now (a graph)' }), name: 'current I(z)', group: 'curves', cut: 'none', shadow: false,
    info: { note: 'sin(k(L/2 − |z|)) cos ωt: a standing wave, largest at the feed of a half wave, zero at the tips', source: SRC.balanis } });
  items.push({ geo: curveGeo(`V|${L}`, curvePath(L, (z) => voltageAt(z, run.phase, L), 0), 0.8), mat: M.make({ base: '--dp-volt', metal: 0, rough: 0.4, emit: '--dp-volt', glow: 0.2 + 0.3 * Math.abs(Math.sin(run.phase)), label: 'the voltage V(z) now (a graph)' }), name: 'voltage V(z)', group: 'curves', cut: 'none', shadow: false,
    info: { note: 'its quadrature twin: zero at the feed of a half wave, largest at the tips', source: SRC.balanis } });
  // The magnetic field: rings round the arms, lit by the local current.
  for (const f of [0.18, 0.5, 0.82]) for (const side of [1, -1]) {
    const y = side * f * cutHalf(L), i = Math.abs(currentAt(y, run.phase, L));
    if (i > 0.08) items.push({ geo: once('hring', () => torus(15, 0.45, full ? 48 : 16, 6)), mat: M.beam('--dp-h', 0.25 + 0.9 * i, 'magnetic field (a ring of B round the current)'), at: [0, y * MM, 0], group: 'hfield', cut: 'none', shadow: false });
  }
  // The length, measured beside the upper arm's side: a dimension line, tip to tip.
  const dimX = 13;
  items.push({ geo: once(`dim|${L}`, () => tube([[dimX, -hc, 0], [dimX, hc, 0]], 0.25, { sides: 5 })), mat: M.paint('--dp-ghost', 0.6), name: 'cut length', group: 'dim', cut: 'none', shadow: false,
    info: { dim: `${T(cutLength(L) * MM)} mm cut; λ/2 = ${T(lam / 2)} mm electrical at ${T(ANTENNA_GHZ)} GHz`, source: SRC.endEffect } });
  for (const s of [1, -1]) items.push({ geo: once('tick', () => tube([[dimX - 3, 0, 0], [dimX + 3, 0, 0]], 0.25, { sides: 5 })), mat: M.paint('--dp-ghost', 0.6), at: [0, s * hc, 0], name: 'cut length', group: 'dim', cut: 'none', shadow: false });

  // The pattern: the field E(theta) or the power, a smooth solid of revolution (its section, under the cut, is the polar plot).
  if (look.pattern) {
    const n = full ? 120 : 36;
    items.push({ geo: once(`pat|${L}|${look.mode}|${d}`, () => lathe(patternProfile(L, look.mode, n), { seg: full ? 72 : 20, crease: 80 })),
      mat: M.make({ base: '--dp-pat', metal: 0, rough: 0.35, transmit: 0.78, coat: 0.3, label: `far-field pattern: the ${look.mode === 'power' ? 'power (the field squared)' : 'field amplitude'} each way` }),
      name: 'radiation pattern', group: 'pattern', order: 1, shadow: false,
      info: { dim: `${T(gainDbi(L), 2)} dBi at its peak; drawn at ${T(R)} mm (0.85 λ) for convenience`, source: SRC.balanis, note: 'the exact far-field shape of the sinusoidal current: most broadside, nothing along the axis' } });
    // The isotropic antenna radiating the same total power: a sphere at the mean of the surface's quantity.
    const ri = R * isoRadius(L, look.mode);
    items.push({ geo: once(`iso|${d}`, () => sphere(1, full ? 48 : 16, full ? 24 : 8)), scale: [ri, ri, ri], mat: M.make({ base: '--dp-iso', metal: 0, rough: 0.1, transmit: 0.82, label: 'an isotropic antenna of the same total power (imaginary)' }),
      name: 'isotropic, same power', group: 'pattern', order: 0, cut: 'open', shadow: false,
      info: { note: `the same power spread evenly: the pattern pokes out of it broadside (${T(gainDbi(L), 2)} dBi = ×${T(D, 2)}) and falls inside it towards the axis`, source: SRC.chapter } });
    // Their outlines in the x-y plane (the cut's plane): the polar plot and the isotropic circle, crisp whatever the transparency.
    const prof = patternProfile(L, look.mode, n), outline: Vec3[] = [...prof.map(([r, y]) => [r, y, 0] as Vec3), ...prof.slice(1, -1).reverse().map(([r, y]) => [-r, y, 0] as Vec3)];
    items.push({ geo: once(`patOut|${L}|${look.mode}|${d}`, () => tube(outline, 0.55, { sides: 6, closed: true })), mat: M.make({ base: '--dp-pat', metal: 0, rough: 0.4, emit: '--dp-pat', glow: 0.3, label: 'the pattern’s section: its polar plot' }), name: 'radiation pattern', group: 'pattern', cut: 'none', shadow: false });
    items.push({ geo: once(`isoOut|${T(ri, 3)}|${d}`, () => tube(Array.from({ length: 96 }, (_, i) => { const a = (i / 96) * 2 * Math.PI; return [ri * Math.cos(a), ri * Math.sin(a), 0] as Vec3; }), 0.45, { sides: 6, closed: true })), mat: M.make({ base: '--dp-iso', metal: 0, rough: 0.4, emit: '--dp-iso', glow: 0.2, label: 'the isotropic sphere’s section' }), name: 'isotropic, same power', group: 'pattern', cut: 'none', shadow: false });
    // The half-power edges of the largest lobe: rings on the surface where the power is half its peak.
    const hp = halfPower(L);
    for (const th of [hp.lo, hp.hi]) if (th > 0.02 && th < Math.PI - 0.02) {
      const r = R * surfaceAt(th, L, look.mode);
      items.push({ geo: once(`hp|${T(r * Math.sin(th), 3)}|${d}`, () => torus(r * Math.sin(th), 0.6, full ? 96 : 24, 6)), at: [0, r * Math.cos(th), 0], mat: M.make({ base: '--dp-hp', metal: 0, rough: 0.4, emit: '--dp-hp', glow: 0.35, label: 'half-power (−3 dB) edge' }),
        name: 'half-power ring', group: 'pattern', shadow: false, info: { dim: `${Math.round((hp.width * 180) / Math.PI)}° between the rings`, source: SRC.chapter } });
    }
  }
  // The effective aperture at the chapter's frequency: the area of passing wave this dipole collects, facing the wave.
  const ap = apertureMm2(L, ANTENNA_GHZ), rap = Math.sqrt(ap / Math.PI);
  items.push({ geo: once(`ap|${T(rap, 3)}|${d}`, () => extrude(Array.from({ length: full ? 72 : 24 }, (_, i) => { const a = (i / (full ? 72 : 24)) * 2 * Math.PI; return [rap * Math.cos(a), rap * Math.sin(a)] as [number, number]; }), 0.4)),
    rot: FACE_Z, at: [0, 0, -0.2], mat: M.make({ base: '--dp-ap', metal: 0, rough: 0.5, transmit: 0.7, label: 'effective aperture (an area, not a part)' }),
    name: 'aperture', group: 'aperture', order: 2, cut: 'none', shadow: false,
    info: { dim: `A = Gλ²/4π = ${T(ap / 100)} cm² (${T(D, 2)} × ${T(apertureM2(0, ANTENNA_GHZ) * 1e4)} cm² of a 0 dBi antenna)`, source: SRC.chapter, note: 'the area of a passing wave whose power this antenna delivers to a matched load' } });
  if (look.hi) hiItems(items, L, d);
  return { items, cuts: CUTS, anchors: anchors(run, look), beats: beats(run, look), floor: -Math.max(R, hc) - 8, look: { exposure: 1.05 } };
}

/** The 28 GHz dipole beside it: the same shape at a twelfth of the size, its aperture, and a phone for scale. */
function hiItems(items: Item[], L: number, d: Detail): void {
  const s = wavelengthM(GHZ_HI) / wavelengthM(ANTENNA_GHZ), x = PATTERN_R * MM + 60, hcs = cutHalf(L) * MM * s;
  const cu = M.copper, ap = apertureMm2(L, GHZ_HI), r = Math.sqrt(ap / Math.PI);
  for (const side of [1, -1]) items.push({ geo: once(`hiArm|${T(hcs, 3)}`, () => tube([[0, 0.15, 0], [0, hcs, 0]], 0.1, { sides: 8 })), mat: cu, at: [x, 0, 6], rot: side > 0 ? undefined : quatZ(Math.PI), name: `${GHZ_HI} GHz dipole`, group: 'hi', cut: 'none',
    info: { dim: `${T(2 * hcs)} mm cut (λ/2 = ${T(wavelengthM(GHZ_HI) * 500)} mm)`, source: SRC.chapter, note: 'the same antenna, the same gain, at 28 GHz' } });
  items.push({ geo: once(`hiAp|${T(r, 3)}`, () => extrude(Array.from({ length: 40 }, (_, i) => { const a = (i / 40) * 2 * Math.PI; return [r * Math.cos(a), r * Math.sin(a)] as [number, number]; }), 0.2)),
    rot: FACE_Z, at: [x, 0, 6], mat: M.make({ base: '--dp-ap', metal: 0, rough: 0.5, transmit: 0.7, label: 'effective aperture (an area, not a part)' }), name: `${GHZ_HI} GHz aperture`, group: 'hi', order: 2, cut: 'none', shadow: false,
    info: { dim: `${T(ap / 100, 2)} cm²: ${T(apertureMm2(L, ANTENNA_GHZ) / ap, 0)} times less`, source: SRC.chapter, note: 'the same gain collects (λ ratio)² less of a passing wave: higher bands need more antennas, or more gain' } });
  items.push({ geo: once('phone', () => roundedBox(PHONE.w, PHONE.h, PHONE.d, 7, d === 'full' ? 4 : 1)), at: [x, 0, -2], mat: M.plasticGloss, name: 'a phone, for scale', group: 'hi', cut: 'none',
    info: { dim: `${PHONE.w} × ${PHONE.h} × ${PHONE.d} mm`, source: SRC.illus } });
}

/** The leads or the coax at the feed, along -x. */
function feedItems(items: Item[], run: DipoleRun, look: DipoleLook): void {
  const g = (GAP / 2) * MM, full = look.detail === 'full', x0 = COAX_X0 * MM, len = COAX_LEN * MM;
  if (look.feed === 'balanced') {
    for (const s of [1, -1]) items.push({ geo: once(`lead|${s}`, () => tube([[-4.5, s * g, 0], [-35, s * g, 0]], 0.5, { sides: 6 })), mat: M.copper, name: 'balanced leads', group: 'feed', cut: 'none',
      info: { note: 'two equal and opposite currents: nothing is left over to flow on the outside of a line', source: SRC.illus } });
    items.push({ geo: once('src', () => roundedBox(20, 16, 12, 2, full ? 3 : 1)), at: [-45, 0, 0], mat: M.paint('--dp-src', 0.5), name: 'source', group: 'feed', cut: 'none', info: { source: SRC.illus, note: `${T(ANTENNA_GHZ)} GHz, balanced` } });
    return;
  }
  // The coax: copper jacket, PTFE, centre conductor; each a lathe turned onto -x. Cut open, the three show their rings.
  const shell = (ro: number, ri: number, l: number): [number, number][] => [[ri, 0], [ro, 0], [ro, l], [ri, l], [ri, 0]];
  const layer = (key: string, prof: [number, number][]) => once(key, () => lathe(prof, { seg: full ? 32 : 10, crease: 60 }));
  const coaxInfo = { source: SRC.coax };
  items.push({ geo: layer('jacket', shell(COAX.jacket / 2, COAX.ptfe / 2, len)), at: [x0, 0, 0], rot: ALONG_MINUS_X, mat: M.copper, name: 'coax jacket (copper)', group: 'coax', explode: [-26, 0, 0], info: { ...coaxInfo, dim: `${T(COAX.jacket, 2)} mm outside` } });
  items.push({ geo: layer('ptfe', shell(COAX.ptfe / 2, COAX.centre / 2, len)), at: [x0, 0, 0], rot: ALONG_MINUS_X, mat: M.make({ base: '--dp-ins', metal: 0, rough: 0.5, label: 'PTFE dielectric' }), name: 'PTFE dielectric', group: 'coax', explode: [-13, 0, 0], info: { ...coaxInfo, dim: `${T(COAX.ptfe, 2)} mm` } });
  items.push({ geo: layer('centre', [[0, -4], [COAX.centre / 2, -4], [COAX.centre / 2, len], [0, len]]), at: [x0, 0, 0], rot: ALONG_MINUS_X, mat: M.silver, name: 'centre conductor', group: 'coax', info: { ...coaxInfo, dim: `${T(COAX.centre, 2)} mm`, note: 'goes on to the upper arm' } });
  // where each goes: the centre conductor up to the upper arm, a strap from the jacket to the lower one
  items.push({ geo: once('toUp', () => tube([[x0 + 4, 0, 0], [-2.5, g + 1, 0]], COAX.centre / 2, { sides: 6 })), mat: M.silver, name: 'centre conductor', group: 'coax', cut: 'none' });
  items.push({ geo: once('toLo', () => tube([[x0, -COAX.jacket / 2, 0], [-2.5, -g - 1, 0]], 0.6, { sides: 6 })), mat: M.copper, name: 'shield strap', group: 'coax', cut: 'none', info: { note: 'the jacket is joined to the lower arm', source: SRC.illus } });
  items.push({ geo: once('conn', () => roundedBox(12, 9, 9, 1.5, full ? 3 : 1)), at: [x0 - len - 6, 0, 0], mat: M.paint('--dp-src', 0.5), name: 'source', group: 'feed', cut: 'none', info: { source: SRC.illus, note: `${T(ANTENNA_GHZ)} GHz, on a 50 Ω coax` } });
  if (look.feed === 'balun') {
    // The sleeve: open toward the feed, shorted to the jacket a quarter wave down it.
    const ro = SLEEVE_R * MM, l = SLEEVE_LEN * MM, t = 0.4;
    items.push({ geo: layer(`sleeve|${T(l, 2)}`, [[ro - t, 0], [ro, 0], [ro, l], [COAX.jacket / 2, l], [COAX.jacket / 2, l - t], [ro - t, l - t], [ro - t, 0]]), at: [x0 - 1, 0, 0], rot: ALONG_MINUS_X,
      mat: M.brass, name: 'λ/4 sleeve balun', group: 'sleeve', explode: [-40, 0, 0],
      info: { dim: `${T(l)} mm (λ/4), ${T(2 * ro)} mm across (illustrative)`, source: SRC.sleeve, note: 'stops the antenna\'s current from running back down the outside of the coax' } });
  } else {
    // No sleeve: the lower arm's current also runs down the outside of the jacket, lighting it.
    const v = Math.abs(currentAt(-GAP, run.phase, run.lwl));
    for (const x of [-15, -35, -55]) if (v > 0.05) items.push({ geo: once('braidRing', () => torus(COAX.jacket / 2 + 0.6, 0.35, 24, 6)), at: [x0 + x + 8, 0, 0], rot: ALONG_MINUS_X, mat: M.beam(currentAt(-GAP, run.phase, run.lwl) >= 0 ? '--dp-pos' : '--dp-neg', 0.3 + v, 'current on the outside of the braid'), cut: 'none', shadow: false });
  }
}

/** A cut down the middle (z > 0 removed): the pattern's section is its polar plot, the coax's its three layers. */
const CUTS: Model3['cuts'] = { planes: [{ n: [0, 0, 1], d: 0.02 }], open: [400] };

// ---------------------------------------------------------------- the near field's loops (instances: they move every frame)

export const LOOP_PTS = 56;
/** The E-field loops now, as points (mm) along each outline, both sides: glowing beads in their sense's colour. */
export function loopBeads(run: DipoleRun, c: { e1: RGB; e2: RGB }): Instance[] {
  const out: Instance[] = [];
  for (const l of loopsAt(run.t)) for (const side of [1, -1] as const) {
    const col = l.sign > 0 ? c.e1 : c.e2, k = 0.6 * l.alpha;
    for (const p of loopOutline(l, side, LOOP_PTS).slice(1)) out.push({ pos: [p[0] * MM, p[1] * MM, p[2] * MM], color: [col[0], col[1], col[2]], emissive: [col[0] * k, col[1] * k, col[2] * k] });
  }
  return out;
}

// ---------------------------------------------------------------- labels and tour

function anchors(run: DipoleRun, look: DipoleLook): StudioAnchor[] {
  const L = run.lwl, hc = cutHalf(L) * MM, R = PATTERN_R * MM, front: Vec3 = [0, 0, 1];
  const a: StudioAnchor[] = [
    { text: 'tip: I = 0, V max', p: [0, hc, ROD_R], side: 'r', n: front, on: 'arms' },
    { text: 'copper arm', p: [-ROD_R, hc * 0.55, 0], side: 'l', n: [-1, 0, 0.3], on: 'arms' },
    { text: 'feed', p: [4.5, 0, 4.5], side: 'r', n: front, on: 'feed' },
    { text: 'cut length', p: [13, -hc * 0.6, 0], side: 'r', n: front, on: 'dim' },
    look.feed === 'balanced' ? { text: 'feed line', p: [-30, (GAP / 2) * MM, 0], side: 'l', n: front, on: 'feed' }
      : look.feed === 'balun' ? { text: 'feed line', p: [COAX_X0 * MM - 20, SLEEVE_R * MM, 0], side: 'l', n: [0, 1, 0.4], on: 'sleeve' }
      : { text: 'feed line', p: [COAX_X0 * MM - 40, COAX.jacket / 2, 0], side: 'l', n: [0, 1, 0.4], on: 'coax' },
    { text: 'aperture', p: [-Math.sqrt(apertureMm2(L, ANTENNA_GHZ) / Math.PI) * 0.7, -Math.sqrt(apertureMm2(L, ANTENNA_GHZ) / Math.PI) * 0.7, 0], side: 'l', n: front, on: 'aperture' },
  ];
  if (look.pattern) {
    const hp = halfPower(L), r = surfaceAt(hp.peak, L, look.mode) * R, ri = R * isoRadius(L, look.mode);
    a.push({ text: 'radiation pattern', p: [r * Math.sin(hp.peak) * 0.7, r * Math.cos(hp.peak), r * Math.sin(hp.peak) * 0.7], side: 'r', n: [0.7, 0, 0.7], on: 'pattern' });
    a.push({ text: 'isotropic, same power', p: [-ri * 0.5, ri * 0.85, ri * 0.15], side: 'l', n: [-0.5, 0.8, 0.3], on: 'pattern' });
    a.push({ text: 'null on the axis', p: [0, hc + 18, 0], side: 'l', n: [0, 1, 0], minor: true });
  }
  const l = loopsAt(run.t).filter((q) => q.alpha > 0.4 && q.xIn > LAMBDA / 4).sort((p, q) => q.xOut - p.xOut)[0];
  if (l) a.push({ text: 'E loops, out at c', p: [((l.xIn + l.xOut) / 2) * MM, (0.5 * ((l.xOut - l.xIn) / 2) + 0.5) * MM, 0], side: 'r', n: front, minor: true });
  return a;
}

/** Set by hand, not fitted: the fit takes the bounding box's corners, which for a round pattern is far too wide. */
export const HOME = { target: [0, -4, 0] as Vec3, yaw: 0.55, pitch: 0.32, dist: 300 };

function beats(run: DipoleRun, look: DipoleLook): Beat[] {
  const L = run.lwl, half = Math.abs(L - L_HALF) < 1e-9, hp = halfPower(L), lam = LAMBDA * MM;
  const ap = apertureMm2(L, ANTENNA_GHZ), apHi = apertureMm2(L, GHZ_HI);
  return [
    { title: 'Half a wavelength', text: `At ${T(ANTENNA_GHZ)} GHz a wave is ${T(lam / 10)} cm long, so a half-wave dipole is ${T(lam / 20)} cm electrical. The wire is cut ${half ? 'to 0.95 of that' : 'a little shorter than its electrical length'}: ${T(cutLength(L) * MM / 10)} cm, because the field fringes past a thick wire's ends.`, view: { ...HOME, yaw: 0.35, pitch: 0.15 }, frame: ['arms', 'feed', 'dim'], cut: 0, explode: 0 },
    { title: 'Current and voltage', text: 'The current is a standing wave: largest at the feed, zero at the tips where the wire ends, reversing every half period (red up, blue down). The voltage is its quadrature twin, largest at the tips. Run it: the charge piles up at one end, then the other.', view: { ...HOME, yaw: 0.9, pitch: 0.2 }, frame: ['arms', 'curves'], show: ['arms', 'curves', 'feed'], cut: 0, explode: 0 },
    { title: 'Fields leave', text: 'Each time the current passes through zero, the charge at the tips is at its peak and a loop of electric field forms. It detaches and travels out at c, a wavelength every period: that is the radio wave. The magnetic rings round the arms follow the current.', view: { target: [20, 0, 0], yaw: 0, pitch: 0.05, dist: 300 }, cut: 0, explode: 0 },
    { title: 'Gain is aiming', text: `Cut through, the pattern is its own polar plot. The grey sphere is an imaginary isotropic antenna radiating the same total power. Broadside the dipole pokes out of it by ${T(gainDbi(L), 2)} dB (×${T(directivity(L), 2)}); towards its own axis it falls to nothing. Same power, aimed: ${Math.round((hp.width * 180) / Math.PI)}° between the half-power rings.`, view: { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 270 }, show: ['pattern', 'arms'], cut: 1, explode: 0 },
    { title: 'Aperture', text: `What the antenna collects is an area of the passing wave: A = Gλ²/4π, ${T(ap / 100)} cm² for this dipole at ${T(ANTENNA_GHZ)} GHz. At ${GHZ_HI} GHz the same dipole is ${T(wavelengthM(GHZ_HI) * 500)} mm and collects ${T(apHi / 100, 2)} cm². ${look.hi ? 'It is beside it, with a phone for scale.' : 'Press "28 GHz beside it" to see it, with a phone for scale.'}`, view: look.hi ? { target: [90, 0, 0], yaw: 0.15, pitch: 0.1, dist: 330 } : { target: [0, 0, 0], yaw: 0.2, pitch: 0.1, dist: 150 }, show: ['aperture', 'arms', 'hi'], cut: 0, explode: 0 },
    look.feed === 'balanced'
      ? { title: 'The feed', text: 'Two leads carry equal and opposite currents into the gap. A real 2.4 GHz antenna is usually fed by a coax: press the Feed button for the coax, cut open, and the sleeve that stops current running back down its outside.', view: { target: [-20, 0, 0], yaw: 0.6, pitch: 0.35, dist: 120 }, frame: ['feed', 'arms'], hide: ['pattern', 'aperture', 'hfield'], cut: 0, explode: 0 }
      : { title: 'The feed', text: `Cut open, the semi-rigid coax is three layers: a ${T(COAX.centre, 2)} mm centre conductor to the upper arm, ${T(COAX.ptfe, 2)} mm of PTFE, and a ${T(COAX.jacket, 2)} mm copper jacket joined to the lower arm. ${look.feed === 'balun' ? 'The brass sleeve, a quarter wave long and shorted at its far end, looks like an open circuit to current on the jacket\'s outside: it stays on the antenna.' : 'With no sleeve, part of the lower arm\'s current runs back along the outside of the jacket (the glowing rings) and the line radiates too.'}`, view: { target: [-30, 0, 0], yaw: 0.5, pitch: 0.3, dist: 140 }, frame: ['coax', 'sleeve', 'feed'], show: ['coax', 'sleeve', 'feed', 'arms'], hide: ['pattern', 'aperture', 'curves', 'hfield', 'charge'], cut: 1, explode: 0.6 },
  ];
}
