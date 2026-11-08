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
import { absorptionDepth, cdsSequence, CG_4T, IMX183, rng, STACK_BSI, VDD_PIX, type CdsPhase } from '../phys/imagesensor';

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
/** Isolation, representative values (drawn inside this pixel's edge; a neighbour has its own half): deep trench isolation
 *  from the back side, full depth, a wall 0.08 µm thick here (0.16 µm shared); shallow trench isolation at the front,
 *  0.28 µm deep (the 0.25–0.3 µm class of Fossum & Hondongwa 2014), between the photodiode and the transistor strip. */
export const DTI_W = 0.08, STI_D = 0.28, STI = { z: [1.7, 1.8] } as const;
/** The lit side's films, back surface upward (µm). Representative, not IMX183's (Sony does not publish them): a thin HfO₂
 *  passivation film, Ta₂O₅ and SiO₂, the last two a quarter wave at 550 nm (λ / 4n: n ≈ 2.1 gives 65 nm, n = 1.46 gives
 *  94 nm); then the p+ accumulation layer inside the silicon, drawn 0.05 µm, five times the 0.01 µm dead layer of STACK_BSI
 *  (the fitted value), so that it can be seen. */
export const AR_FILMS: readonly { name: string; t: number }[] = [{ name: 'HfO₂', t: 0.03 }, { name: 'Ta₂O₅', t: 0.065 }, { name: 'SiO₂', t: 0.095 }];
export const AR_T = AR_FILMS.reduce((a, f) => a + f.t, 0), P_BACK = 0.05;
/** The metal grid between filters (0.25 µm tall as in sensorstack, 0.08 µm of it inside this pixel), on the films. */
export const GRID_H = 0.25, GRID_W = 0.08;
/** Front side below the metal: interlayer oxide to this depth (µm), then the bonded carrier / logic wafer, of which 1.2 µm
 *  is drawn (a real one is hundreds of µm thick). */
export const ILD_T = 1.1, WAFER_T = 1.2;
/** Above the back surface and its films: colour filter and microlens (µm). */
export const BACK = SI_T + AR_T;
export const CF: [number, number] = [BACK, BACK + 0.6], LENS: [number, number] = [BACK + 0.6, BACK + 1.35];
/** The funnel of built-in potential that carries back-side electrons to the diode (graded doping): layers, back to front. */
export const FUNNEL = 6;

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
  sti: RGBA; dti: RGBA; ar: readonly [RGBA, RGBA, RGBA]; pback: RGBA; grid: RGB; ild: RGBA; wafer: RGB;
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
  const nplus = (x: readonly number[], z: readonly number[], hot = 0) => out.push({ ...bx(P.nplus, x, [0, L.fd.y], z), emissive: hot > 0 ? glow(P.hot, hot) : undefined });
  // FD's tint follows its voltage: the drop below the supply, as a share of the full well's drop (the plot's FD trace in 3D).
  const fdDrop = ph ? Math.min(1, Math.max(0, (VDD_PIX - ph.fd) / (FULL_WELL * CG_4T * 1e-6))) : 0;
  nplus(L.fd.x, [Math.max(z0, L.fd.z[0]), L.fd.z[1]], 0.9 * fdDrop);
  nplus(L.vddRst.x, L.vddRst.z);
  for (const d of [L.sfD, L.mid, L.col]) nplus(d.x, L.strip.z, d === L.col && on.sel ? 0.3 : 0);
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
  // The wire from FD to the follower's gate is the story of a read (FD drives SF): lit while the row is selected.
  const lit = (o: Part): Part => (on.sel ? { ...o, emissive: glow(P.hot, 0.45) } : o);
  if (!pose.cut || cz >= z0) out.push(lit(rod(m, P3(fdX, 0, cz), P3(fdX, M1[1], cz), r, 0.5)));
  out.push(lit(bx(m, [1.68, fdX + 0.05], M1, [cz - 0.05, cz + 0.05], 0.5)));
  out.push(lit(bx(m, [1.63, 1.73], M1, [cz - 0.05, 1.62], 0.5)));
  out.push(lit(bx(m, [sfX - 0.05, 1.73], M1, [1.52, 1.62], 0.5)));
  out.push(lit(bx(m, [sfX - 0.05, sfX + 0.05], M1, [1.52, sz], 0.5)));
  out.push(lit(rod(m, P3(sfX, POLY[0], sz), P3(sfX, M1[1], sz), r, 0.5)));
  const vddX = 2.15, colX = (L.col.x[0] + L.col.x[1]) / 2;
  out.push({ ...bx(m, [colX - 0.08, colX + 0.08], M2, [0, W], 0.5), emissive: on.sel && ph?.sample ? glow(P.hot, 0.6) : undefined });
  out.push(bx(m, [vddX - 0.08, vddX + 0.08], M2, [0, W], 0.5));
  out.push(rod(m, P3(colX, 0, sz), P3(colX, M2[1], sz), r, 0.5));
  out.push(rod(m, P3(vddX, 0, (L.vddRst.z[0] + L.vddRst.z[1]) / 2), P3(vddX, M2[1], (L.vddRst.z[0] + L.vddRst.z[1]) / 2), r, 0.5));
  const sfDx = (L.sfD.x[0] + L.sfD.x[1]) / 2;
  out.push(rod(m, P3(sfDx, 0, sz), P3(sfDx, M1[0], sz), r, 0.5));
  out.push(bx(m, [sfDx - 0.05, vddX + 0.05], M1, [sz + 0.17, sz + 0.27], 0.5));
  out.push(rod(m, P3(vddX, M1[0], sz + 0.22), P3(vddX, M2[1], sz + 0.22), r, 0.5));
  // Isolation: deep trenches from the back at the pixel's sides, a shallow one between the diode and the transistors.
  const zs = Math.max(z0, STI.z[0]);
  out.push(bx(P.sti, [DTI_W, W - DTI_W], [0, STI_D], [zs, STI.z[1]]));
  out.push(bx(P.dti, [0, DTI_W], [0, SI_T], [z0, W]), bx(P.dti, [W - DTI_W, W], [0, SI_T], [z0, W]), bx(P.dti, [DTI_W, W - DTI_W], [0, SI_T], [W - DTI_W, W]));
  if (!pose.cut) out.push(bx(P.dti, [DTI_W, W - DTI_W], [0, SI_T], [0, DTI_W]));
  // The potential funnel: translucent n layers, faint at the lit surface and stronger toward the diode, narrowing onto it.
  const gTop = SI_T - P_BACK, gBot = L.pd.y[1] + 0.02, inset = 0.1;
  for (let k = 0; k < FUNNEL; k++) {
    const t = (k + 0.5) / FUNNEL, a = gTop + (gBot - gTop) * (k / FUNNEL), b = gTop + (gBot - gTop) * ((k + 1) / FUNNEL);
    const at = (full: number, pd: number) => full + (pd - full) * t;
    out.push(bx([...P.n, 0.03 + 0.1 * t] as RGBA, [at(inset, L.pd.x[0]), at(W - inset, L.pd.x[1])], [b, a], [Math.max(z0, at(inset, L.pd.z[0])), at(W - inset, L.pd.z[1])]));
  }
  // The lit surface: p+ accumulation layer in the silicon, then the films, and the metal grid that frames the filter.
  out.push(bx(P.pback, [DTI_W, W - DTI_W], [SI_T - P_BACK, SI_T], [z0, W - DTI_W]));
  let yf = SI_T;
  AR_FILMS.forEach((f, i) => { out.push(bx(P.ar[i], [0, W], [yf, yf + f.t], [z0, W])); yf += f.t; });
  const g = [BACK, BACK + GRID_H];
  out.push(bx(P.grid, [0, GRID_W], g, [z0, W], 0.5), bx(P.grid, [W - GRID_W, W], g, [z0, W], 0.5), bx(P.grid, [GRID_W, W - GRID_W], g, [W - GRID_W, W], 0.5));
  if (!pose.cut) out.push(bx(P.grid, [GRID_W, W - GRID_W], g, [0, GRID_W], 0.5));
  // Below the metal: interlayer oxide, and the carrier wafer the stack is bonded to.
  out.push(bx(P.ild, [0, W], [-ILD_T, 0], [z0, W]));
  out.push(bx(P.wafer, [0, W], [-ILD_T - WAFER_T, -ILD_T], [z0, W], 0.2));
  // Above the silicon: the colour filter and the microlens (a dome of stacked discs, a spherical cap), then the light.
  out.push(bx(P.filter[pose.filter], [0, W], CF, [z0, W]));
  const lc = W / 2, steps = 8, lh = LENS[1] - LENS[0], rc = (lc * lc + lh * lh) / (2 * lh);
  for (let i = 0; i < steps; i++) {
    const y0 = lh * (i / steps), y1 = lh * ((i + 1) / steps), ym = (y0 + y1) / 2, rr = Math.sqrt(rc * rc - (ym - (lh - rc)) ** 2);
    out.push(cyl(P.lens, lc * U, lc * U, (LENS[0] + y0) * U, (LENS[0] + y1) * U, Math.min(lc, rr) * U));
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

// The transistors' labels are minor: where they crowd pd and fd (labelfit lays main labels down first), they give way.
export function pixAnchors(pose: PixPose): Anchor[] {
  const front: Vec3 = [0, 0, -1], up: Vec3 = [0, 1, 0], down: Vec3 = [0, -1, 0], z = pose.cut ? 0.8 : 0;
  const mid = (a: readonly number[]) => (a[0] + a[1]) / 2;
  return [
    { text: 'microlens', p: P3(PITCH * 0.9, (LENS[0] + LENS[1]) / 2, PITCH / 2), side: 'r', n: up },
    { text: 'colour filter', p: P3(PITCH, mid(CF), z + 0.3), side: 'r', n: front },
    { text: 'silicon, lit from the back', p: P3(PITCH, SI_T * 0.75, z), side: 'r', n: front },
    { text: 'pd: pinned photodiode (n under p+)', p: P3(L.pd.x[0], mid(L.pd.y), z), side: 'l', n: front },
    { text: 'xfer', p: P3(mid(L.tg.x), POLY[0], Math.max(z, L.tg.z[0])), side: 'b', n: down, minor: true },
    { text: 'fd: floating diffusion', p: P3(L.fd.x[1], L.fd.y / 2, Math.max(z, L.fd.z[0])), side: 'r', n: front },
    { text: 'reset', p: P3(L.rst.x[1], POLY[0] / 2, mid(L.rst.z)), side: 't', n: [1, 0, 0], minor: true },
    { text: 'sf', p: P3(mid(L.sf.x), POLY[0], L.strip.z[1]), side: 'l', n: down, minor: true },
    { text: 'rs', p: P3(mid(L.rs.x), POLY[0], L.strip.z[1]), side: 'r', n: down, minor: true },
    { text: 'DTI', p: P3(PITCH, SI_T * 0.4, z), side: 'r', n: front, minor: true },
    { text: 'STI', p: P3(PITCH * 0.5, STI_D / 2, STI.z[1]), side: 'r', n: [0, 0, 1], minor: true },
    { text: 'AR films, p+', p: P3(PITCH, SI_T + AR_T / 2, z), side: 'r', n: front, minor: true },
    { text: 'carrier wafer', p: P3(PITCH, -ILD_T - WAFER_T / 2, z), side: 'r', n: front, minor: true },
    { text: 'column line (metal 2)', p: P3(mid(L.col.x), M2[0], 0), side: 'b', n: down },
  ];
}

/** An exposure: this many photons reach the lens, drawn as DRAWN of them, each standing for the rest. */
export const PHOTONS_PER_FLASH = 3000, DRAWN = 30;
/** Electrons a drawn photon adds: its share of the flash, through the optics (STACK_BSI.transmit), if silicon absorbs
 *  it between the dead layer and the collecting depth. Summed over many, this is imagesensor.ts qe(nm) per photon. */
export const electronsOf = (p: Photon): number =>
  p.depth >= STACK_BSI.dead && p.depth <= SI_T ? (PHOTONS_PER_FLASH / DRAWN) * STACK_BSI.transmit : 0;
