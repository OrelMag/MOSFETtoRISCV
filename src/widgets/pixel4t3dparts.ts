// The CMOS 4T pixel as parts (DOM-free, tested): one 2.4 µm pixel of a back-illuminated sensor (the IMX183 class), drawn
// the way BSI cross-sections are: light from above through the microlens and colour filter into thinned silicon, the
// pinned photodiode under it, and on the front side below the silicon the transfer gate, floating diffusion, the reset,
// source-follower and row-select transistors and their metal to the column line. Every number is phys/imagesensor.ts's:
// absorption depth (Green 2008), the collecting depth, full well, conversion gain and the CDS sequence (cdsSequence).
// The names follow lib/sensor.ts PIXEL_4T's instances: reset, xfer, sf, rs, pd, fd.
// World units: 10 per µm. x across the pixel (photodiode → transfer gate → floating diffusion), z the other way across it
// (the readout transistors sit in a strip at the back), y up toward the light; y = 0 is the front surface of the silicon.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { absorptionDepth, cdsSequence, IMX183, rng, STACK_BSI, type CdsPhase } from '../phys/imagesensor';

export const U = 10;
/** The pixel's pitch and the thinned silicon's thickness (µm): the collecting depth of imagesensor.ts STACK_BSI. */
export const PITCH = IMX183.pitch, SI_T = STACK_BSI.collect, FULL_WELL = IMX183.fullWell;

/** The front-side layout (µm, x / z boxes on the front surface): ours, to scale in a 2.4 µm cell. A real 2.4 µm pixel
 *  shares its reset, follower and select transistors among two or four photodiodes; this one has its own. */
export const L = {
  pd: { x: [0.15, 1.5], z: [0.15, 1.45], y: [0.12, 1.7] },
  pin: { y: 0.12 },
  tg: { x: [1.5, 1.82], z: [0.3, 1.3] },
  fd: { x: [1.82, 2.25], z: [0.45, 1.15], y: 0.22 },
  rst: { x: [1.82, 2.25], z: [1.15, 1.42] },
  vddRst: { x: [1.82, 2.25], z: [1.42, 1.7] },
  sfD: { x: [0.12, 0.35] }, sf: { x: [0.35, 0.8] }, mid: { x: [0.8, 1.0] }, rs: { x: [1.0, 1.4] }, col: { x: [1.4, 1.62] },
  strip: { z: [1.8, 2.3] },
} as const;
/** Gate poly and metal below the front surface (µm; y < 0). Poly ~0.18 µm, metal 1 and 2 ~0.12 µm each. */
export const POLY: [number, number] = [-0.18, 0], M1: [number, number] = [-0.55, -0.43], M2: [number, number] = [-0.95, -0.83];
/** Above the back surface: colour filter and microlens (µm). */
export const CF: [number, number] = [SI_T, SI_T + 0.6], LENS: [number, number] = [SI_T + 0.6, SI_T + 1.35];

export type Filter = 'b' | 'g' | 'r';
/** Each filter's light: the wavelength at which the IMX183's QE peaks for that colour (imagesensor.ts qeRgb). */
export const FILTER_NM: Record<Filter, number> = { b: IMX183.qeRgb.b[1], g: IMX183.qeRgb.g[1], r: IMX183.qeRgb.r[1] };

/** A photon on its way: where it enters (µm), where silicon absorbs it (depth below the back surface, µm; > SI_T: it
 *  passes through and is lost), and how far through its flight it is (0..1 falling, 1..2 its electron drifting). */
export interface Photon { x: number; z: number; depth: number; t: number }
export const absorbed = (p: Photon): boolean => p.depth <= SI_T;

/** `n` photons at a wavelength, entering through the lens anywhere over the photodiode's half of the pixel, each
 *  absorbed at an exponentially distributed depth with mean absorptionDepth(nm). Seeded, so a test sees the same ones. */
export function photonsAt(nm: number, n: number, seed: number): Photon[] {
  const r = rng(seed), mean = absorptionDepth(nm);
  return Array.from({ length: n }, () => ({ x: 0.25 + r() * 1.9, z: 0.25 + r() * 1.9, depth: -mean * Math.log(1 - r()), t: 0 }));
}

/** The pixel's charge and where its readout is: electrons in the photodiode and on the floating diffusion, and which
 *  phase of the CDS sequence (−1: integrating, 0..3 RST, SHR, TX, SHS) has run. `read` is the charge being read. */
export interface PixState { pd: number; fd: number; phase: number; read: number }
export const IDLE: PixState = { pd: 0, fd: 0, phase: -1, read: 0 };

/** The CDS sequence for the charge in the photodiode now (imagesensor.ts cdsSequence). */
export const sequenceOf = (s: PixState) => cdsSequence(s.phase < 0 ? s.pd : s.read);

/** One phase on: RST empties the floating diffusion, TX moves the photodiode's charge onto it. */
export function nextPhase(s: PixState): PixState {
  const p = s.phase + 1;
  if (p === 0) return { pd: s.pd, fd: 0, phase: 0, read: s.pd };
  if (p === 2) return { ...s, pd: 0, fd: Math.min(s.read, FULL_WELL), phase: 2 };
  if (p > 3) return { ...s, phase: -1 };
  return { ...s, phase: p };
}
export const phaseOf = (s: PixState): CdsPhase | null => (s.phase < 0 ? null : sequenceOf(s).phases[s.phase]);

// ---------------------------------------------------------------- the drawing

export interface PixPalette {
  si: RGBA; p: RGB; n: RGB; nplus: RGB; poly: RGB; metal: RGB; oxide: RGBA; lens: RGBA; filter: Record<Filter, RGBA>;
  charge: RGB; hot: RGB; light: Record<Filter, RGB>;
}
export interface PixPose { s: PixState; filter: Filter; photons: readonly Photon[]; cut: boolean }

const glow = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const bx = (c: RGB | RGBA, x: readonly number[], y: readonly number[], z: readonly number[], spec = 0): Part => box(c, x[0] * U, x[1] * U, y[0] * U, y[1] * U, z[0] * U, z[1] * U, spec);
const P3 = (x: number, y: number, z: number): Vec3 => [x * U, y * U, z * U];

/** A charge drawn as dots: one per DOT electrons (full well ≈ 60 dots). */
export const DOT = Math.round(FULL_WELL / 60);
export const dots = (e: number): number => Math.round(Math.max(0, e) / DOT);

/** Where electron dot k of n sits in a box (x, y, z ranges in µm): a 4 × 4 grid per layer, layers upward. */
function dotAt(k: number, x: readonly number[], y: readonly number[], z: readonly number[]): Vec3 {
  const c = k % 4, r = Math.floor(k / 4) % 4, l = Math.floor(k / 16), ny = 4;
  return P3(x[0] + ((c + 0.5) / 4) * (x[1] - x[0]), y[0] + ((l % ny) + 0.5) / ny * (y[1] - y[0]), z[0] + ((r + 0.5) / 4) * (z[1] - z[0]));
}
const electron = (P: PixPalette, p: Vec3): Part => ({ ...box(P.charge, -0.35, 0.35, -0.35, 0.35, -0.35, 0.35, 0.6), pos: p, emissive: glow(P.charge, 1) });

export function pixParts(pose: PixPose, P: PixPalette): Part[] {
  const out: Part[] = [], s = pose.s, ph = phaseOf(s), W = PITCH;
  const on = { rst: !!ph?.rst, tx: !!ph?.tx, sel: !!ph?.sel };
  // Silicon: p epi over the whole pixel (clear, so the diode and the charge show), cut through the photodiode's middle
  // when `cut` (the front half removed, so the cross-section faces the camera).
  const z0 = pose.cut ? 0.8 : 0;
  out.push(bx(P.si, [0, W], [0, SI_T], [z0, W]));
  // The pinned photodiode: n well, the thin p+ pinning layer at the front surface under it.
  out.push(bx([...P.n, 0.55] as RGBA, L.pd.x, L.pd.y, [Math.max(z0, L.pd.z[0]), L.pd.z[1]]));
  out.push(bx(P.p, L.pd.x, [0, L.pin.y], [Math.max(z0, L.pd.z[0]), L.pd.z[1]]));
  // n+ diffusions on the front surface: floating diffusion, reset drain, and the follower / select chain in the back strip.
  const nplus = (x: readonly number[], z: readonly number[], hot = false) => out.push({ ...bx(P.nplus, x, [0, L.fd.y], z), emissive: hot ? glow(P.hot, 0.3) : undefined });
  nplus(L.fd.x, [Math.max(z0, L.fd.z[0]), L.fd.z[1]]);
  nplus(L.vddRst.x, L.vddRst.z);
  for (const d of [L.sfD, L.mid, L.col]) nplus(d.x, L.strip.z, d === L.col && on.sel);
  // Gates (poly, below the front surface), lit while on: TX, RST, SF (its gate is FD's voltage), RS.
  const gate = (x: readonly number[], z: readonly number[], hot: boolean) => out.push({ ...bx(P.poly, x, POLY, z, 0.25), emissive: hot ? glow(P.hot, 0.5) : undefined });
  gate(L.tg.x, [Math.max(z0, L.tg.z[0]), L.tg.z[1]], on.tx);
  gate(L.rst.x, L.rst.z, on.rst);
  gate(L.sf.x, L.strip.z, false);
  gate(L.rs.x, L.strip.z, on.sel);
  // Contacts and metal 1: FD to the follower's gate (the one wire that makes it a source follower), supply to the reset
  // drain and the follower's drain; metal 2: the supply and the column line run the length of the column (along z).
  const cz = (L.fd.z[0] + L.fd.z[1]) / 2, fdX = (L.fd.x[0] + L.fd.x[1]) / 2, sfX = (L.sf.x[0] + L.sf.x[1]) / 2, sz = (L.strip.z[0] + L.strip.z[1]) / 2;
  const m = (P.metal), r = 0.035 * U;
  if (!pose.cut || cz >= z0) out.push(rod(m, P3(fdX, 0, cz), P3(fdX, M1[1], cz), r, 0.5));
  out.push(bx(m, [1.68, fdX + 0.05], M1, [cz - 0.05, cz + 0.05], 0.5));
  out.push(bx(m, [1.63, 1.73], M1, [cz - 0.05, 1.62], 0.5));
  out.push(bx(m, [sfX - 0.05, 1.73], M1, [1.52, 1.62], 0.5));
  out.push(bx(m, [sfX - 0.05, sfX + 0.05], M1, [1.52, sz], 0.5));
  out.push(rod(m, P3(sfX, POLY[0], sz), P3(sfX, M1[1], sz), r, 0.5));
  const vddX = 2.15, colX = (L.col.x[0] + L.col.x[1]) / 2;
  out.push({ ...bx(m, [colX - 0.08, colX + 0.08], M2, [0, W], 0.5), emissive: on.sel && ph?.sample ? glow(P.hot, 0.6) : undefined });
  out.push(bx(m, [vddX - 0.08, vddX + 0.08], M2, [0, W], 0.5));
  out.push(rod(m, P3(colX, 0, sz), P3(colX, M2[1], sz), r, 0.5));
  out.push(rod(m, P3(vddX, 0, (L.vddRst.z[0] + L.vddRst.z[1]) / 2), P3(vddX, M2[1], (L.vddRst.z[0] + L.vddRst.z[1]) / 2), r, 0.5));
  const sfDx = (L.sfD.x[0] + L.sfD.x[1]) / 2;
  out.push(rod(m, P3(sfDx, 0, sz), P3(sfDx, M1[0], sz), r, 0.5));
  out.push(bx(m, [sfDx - 0.05, vddX + 0.05], M1, [sz + 0.17, sz + 0.27], 0.5));
  out.push(rod(m, P3(vddX, M1[0], sz + 0.22), P3(vddX, M2[1], sz + 0.22), r, 0.5));
  // Above the silicon: the colour filter and the microlens (a dome of stacked discs), then the light.
  out.push(bx(P.filter[pose.filter], [0, W], CF, [z0, W]));
  const lc = W / 2, steps = 5;
  for (let i = 0; i < steps; i++) {
    const f = i / steps, rr = (W / 2) * Math.sqrt(1 - f * f) * 0.98, y0 = LENS[0] + (LENS[1] - LENS[0]) * f, y1 = LENS[0] + (LENS[1] - LENS[0]) * (f + 1 / steps);
    out.push(cyl(P.lens, lc * U, lc * U, y0 * U, y1 * U, rr * U));
  }
  // Charge: dots in the photodiode, on the floating diffusion; photons falling and their electrons drifting in.
  const pdBox = { x: [L.pd.x[0] + 0.1, L.pd.x[1] - 0.1], y: [L.pd.y[0] + 0.1, L.pd.y[1] - 0.2], z: [Math.max(z0, L.pd.z[0]) + 0.08, L.pd.z[1] - 0.1] };
  const inPd = dots(s.pd);
  for (let k = 0; k < inPd; k++) out.push(electron(P, dotAt(k, pdBox.x, pdBox.y, pdBox.z)));
  const fdBox = { x: [L.fd.x[0] + 0.05, L.fd.x[1] - 0.05], y: [0.02, L.fd.y + 0.5], z: [Math.max(z0, L.fd.z[0]) + 0.05, L.fd.z[1] - 0.05] };
  for (let k = 0; k < dots(s.fd); k++) out.push(electron(P, dotAt(k, fdBox.x, fdBox.y, fdBox.z)));
  const light = P.light[pose.filter];
  for (const f of pose.photons) {
    const yHit = SI_T - Math.min(f.depth, SI_T + 0.3), top = LENS[1] + 1.2;
    if (f.t < 1) {
      // The photon: a short streak falling from above the lens to where it is absorbed.
      const y = top + (yHit - top) * f.t;
      out.push({ ...rod(light, P3(f.x, y + 0.3, f.z), P3(f.x, y, f.z), 0.03 * U), emissive: glow(light, 1) });
    } else if (absorbed(f) && f.t < 2) {
      // Its electron drifts down into the photodiode's well.
      const u = f.t - 1, tgt = dotAt(inPd, pdBox.x, pdBox.y, pdBox.z);
      out.push(electron(P, [f.x * U + (tgt[0] - f.x * U) * u, yHit * U + (tgt[1] - yHit * U) * u, f.z * U + (tgt[2] - f.z * U) * u]));
    }
  }
  return out;
}

export function pixAnchors(pose: PixPose): Anchor[] {
  const front: Vec3 = [0, 0, -1], up: Vec3 = [0, 1, 0], down: Vec3 = [0, -1, 0], z = pose.cut ? 0.8 : 0;
  const mid = (a: readonly number[]) => (a[0] + a[1]) / 2;
  return [
    { text: 'microlens', p: P3(PITCH / 2, LENS[1], PITCH / 2), side: 't', n: up },
    { text: 'colour filter', p: P3(PITCH, mid(CF), z + 0.3), side: 'r', n: front },
    { text: 'silicon, lit from the back', p: P3(PITCH, SI_T * 0.75, z), side: 'r', n: front },
    { text: 'pd: pinned photodiode (n under p+)', p: P3(L.pd.x[0], mid(L.pd.y), z), side: 'l', n: front },
    { text: 'xfer: transfer gate', p: P3(mid(L.tg.x), POLY[0], Math.max(z, L.tg.z[0])), side: 'b', n: down },
    { text: 'fd: floating diffusion', p: P3(L.fd.x[1], L.fd.y / 2, Math.max(z, L.fd.z[0])), side: 'r', n: front },
    { text: 'reset', p: P3(L.rst.x[1], POLY[0] / 2, mid(L.rst.z)), side: 't', n: [1, 0, 0], minor: true },
    { text: 'sf, rs: source follower, row select', p: P3(mid(L.sf.x), POLY[0], L.strip.z[1]), side: 'l', n: down },
    { text: 'column line (metal 2)', p: P3(mid(L.col.x), M2[0], 0), side: 'b', n: down },
  ];
}

/** An exposure: this many photons reach the lens, drawn as DRAWN of them, each standing for the rest. */
export const PHOTONS_PER_FLASH = 3000, DRAWN = 30;
/** Electrons a drawn photon adds: its share of the flash, through the optics (STACK_BSI.transmit), if silicon absorbs
 *  it between the dead layer and the collecting depth. Summed over many, this is imagesensor.ts qe(nm) per photon. */
export const electronsOf = (p: Photon): number =>
  p.depth >= STACK_BSI.dead && p.depth <= SI_T ? (PHOTONS_PER_FLASH / DRAWN) * STACK_BSI.transmit : 0;
