// The CMOS 4T pixel's numbers and state (DOM-free, tested; drawn by pixel4t3dkit.ts): one 2.4 µm pixel of a back-illuminated sensor (the IMX183 class),
// the way BSI cross-sections are: light from above through the microlens and colour filter into thinned silicon, the
// pinned photodiode under it, and on the front side below the silicon the transfer gate, floating diffusion, the reset,
// source-follower and row-select transistors and their metal to the column line. Every number is phys/imagesensor.ts's:
// absorption depth (Green 2008), the collecting depth, full well, conversion gain and the CDS sequence (cdsSequence).
// The names follow lib/sensor.ts PIXEL_4T's instances: reset, xfer, sf, rs, pd, fd.
// Units: µm. x across the pixel (photodiode → transfer gate → floating diffusion), z the other way across it
// (the readout transistors sit in a strip at the back), y up toward the light; y = 0 is the front surface of the silicon.


import type { Vec3 } from '../gl/math';

import { absorptionDepth, cdsSequence, IMX183, rng, STACK_BSI, type CdsPhase } from '../phys/imagesensor';


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

// ---------------------------------------------------------------- charge as dots

/** A charge drawn as dots: one per DOT electrons (full well ≈ 60 dots). */
export const DOT = Math.round(FULL_WELL / 60);
export const dots = (e: number): number => Math.round(Math.max(0, e) / DOT);

/** Where electron dot k sits in a box (x, y, z ranges in µm): a 4 × 4 grid per layer, four layers upward. */
export function dotAt(k: number, x: readonly number[], y: readonly number[], z: readonly number[]): Vec3 {
  const c = k % 4, r = Math.floor(k / 4) % 4, l = Math.floor(k / 16), ny = 4;
  return [x[0] + ((c + 0.5) / 4) * (x[1] - x[0]), y[0] + (((l % ny) + 0.5) / ny) * (y[1] - y[0]), z[0] + ((r + 0.5) / 4) * (z[1] - z[0])];
}
/** The boxes the dots fill (µm): the photodiode's well, and the floating diffusion with the charge standing on it. */
export const PD_BOX = { x: [L.pd.x[0] + 0.1, L.pd.x[1] - 0.1], y: [L.pd.y[0] + 0.1, L.pd.y[1] - 0.2], z: [L.pd.z[0] + 0.08, L.pd.z[1] - 0.1] } as const;
export const FD_BOX = { x: [L.fd.x[0] + 0.05, L.fd.x[1] - 0.05], y: [0.02, L.fd.y + 0.5], z: [L.fd.z[0] + 0.05, L.fd.z[1] - 0.05] } as const;

/** An exposure: this many photons reach the lens, drawn as DRAWN of them, each standing for the rest. */
export const PHOTONS_PER_FLASH = 3000, DRAWN = 30;
/** Electrons a drawn photon adds: its share of the flash, through the optics (STACK_BSI.transmit), if silicon absorbs
 *  it between the dead layer and the collecting depth. Summed over many, this is imagesensor.ts qe(nm) per photon. */
export const electronsOf = (p: Photon): number =>
  p.depth >= STACK_BSI.dead && p.depth <= SI_T ? (PHOTONS_PER_FLASH / DRAWN) * STACK_BSI.transmit : 0;
