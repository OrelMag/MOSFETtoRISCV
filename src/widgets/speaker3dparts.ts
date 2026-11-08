// A moving-coil loudspeaker and microphone as parts (DOM-free, tested). The drive is the chapter's own: the voice of
// "Speech" (public/dsp/voice-8k.wav, 8 000 samples a second), a window of it as the DAC's codes.
//
// Speaker: the DAC holds each code for one sample period (a zero-order hold, ZOH), the coil current follows the held
// code, and the force B·l·i moves the cone to it: with no smoothing the cone position at time t is exactly the held
// sample. Smoothing shows what the reconstruction filter and the cone's mass do: a one-pole lag, so the cone chases each
// step. Microphone: the same machine reversed. Sound moves the cone (the voice's samples, joined), the coil moving in
// the gap makes e = −B·l·v, and the ADC takes a sample of that voltage each period.
// The mechanics are drawn, not simulated: the lag is a first-order filter, not a cone's resonance.
//
// The driver is a Dayton Audio RS180-8 (7" Reference woofer), from Dayton's product page
// (https://daytonaudio.com/product/101/rs180-8-7-reference-woofer-8-ohm): Sd 124.7 cm², voice coil 38 mm (aluminium former),
// Xmax 6 mm, Bl 7.82 T·m, Mms 17.9 g, Fs 35.7 Hz, Cms 1.12 mm/N, black anodised aluminium cone, rubber surround,
// cast-aluminium 6-hole frame, ferrite magnet, 180.5 mm overall, 81 mm deep. The page does not list the coil's winding
// height, the gap height, the magnet's size or the spider: the winding (18 mm) and gap (6 mm) are chosen so that
// Xmax = (winding − gap) / 2 = 6 mm, and the rest are proportions drawn to look like a 7" driver.
//
// The speaker faces +y; the front half (z > 0) is cut away so the section shows. Units are millimetres.

import type { RGB, RGBA } from '../gl/instances';
import { quatAxisAngle, quatMul, type Quat, type Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';

export type Mode = 'speaker' | 'mic';

// ---------------------------------------------------------------- the drive: the chapter's samples, held

/** The samples a second of the chapter's voice. */
export const VOICE_RATE = 8000;
/** Samples in the window shown (it loops). */
export const WINDOW = 64;
/** The first-order lag of the smoothing toggle, in sample periods (an illustration, not the cone's 35.7 Hz resonance). */
export const TAU = 1.4;

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Where the loudest aligned block of `n` samples starts: a voiced stretch, so the window holds a pitch period or more. */
export function loudestWindow(x: readonly number[], n = WINDOW): number {
  let best = 0, bestE = -1;
  for (let at = 0; at + n <= x.length; at += n) {
    let e = 0;
    for (let i = 0; i < n; i++) e += x[at + i] ** 2;
    if (e > bestE) { bestE = e; best = at; }
  }
  return best;
}

export interface Drive {
  mode: Mode;
  smooth: boolean;
  /** The DAC's codes (speaker) or the sound's samples (mic): the window of the voice. */
  codes: readonly number[];
  n: number;
  peak: number;
  /** Mic: the ADC's codes, one per period, on the unit scale of the largest step. */
  adc: readonly number[];
  /** Speaker with smoothing: the cone's position at the start of each period (periodic steady state). */
  edge: readonly number[];
  rate: number;
}

export function makeDrive(codes: readonly number[], mode: Mode, smooth: boolean, rate = VOICE_RATE): Drive {
  const n = codes.length, peak = Math.max(1, ...codes.map(Math.abs));
  const steps = codes.map((c, i) => (codes[(i + 1) % n] - c) / peak), top = Math.max(1e-9, ...steps.map(Math.abs));
  const adc = steps.map((v) => v / top);
  // The lag, from the loop's steady state: a few passes settle it.
  const a = Math.exp(-1 / TAU), edge = new Array<number>(n).fill(0);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < n; i++) {
      const hold = codes[i] / peak;
      edge[(i + 1) % n] = hold + (edge[i] - hold) * a;
    }
  }
  return { mode, smooth, codes, n, peak, adc, edge, rate };
}

/** The ZOH: the code the DAC holds at time t (in sample periods). */
export const heldCode = (d: Drive, t: number): number => d.codes[mod(Math.floor(t), d.n)];

export interface Pose {
  /** The sample period t is in. */
  k: number;
  /** The cone's displacement on −1 … 1 of Xmax (towards the front +). */
  cone: number;
  /** The coil's terminals on −1 … 1: the held current (speaker) or the EMF the ADC holds (mic). */
  drive: number;
  /** The raw code behind `drive`: as the DAC gets it (speaker), or the ADC's on a ±1000 scale (mic). */
  code: number;
}

export function poseAt(d: Drive, t: number): Pose {
  const k = mod(Math.floor(t), d.n), f = mod(t, d.n) - k;
  if (d.mode === 'speaker') {
    const hold = d.codes[k] / d.peak;
    const cone = d.smooth ? hold + (d.edge[k] - hold) * Math.exp(-f / TAU) : hold;
    return { k, cone, drive: hold, code: d.codes[k] };
  }
  const a = d.codes[k] / d.peak, b = d.codes[(k + 1) % d.n] / d.peak;
  return { k, cone: a + (b - a) * f, drive: d.adc[k], code: Math.round(d.adc[k] * 1000) };
}

/** The cone position at the start of each period, for the trace. */
export const coneEdges = (d: Drive): number[] => Array.from({ length: d.n }, (_, k) => poseAt(d, k).cone);

// ---------------------------------------------------------------- the driver (RS180-8)

/** Datasheet: linear excursion (mm), force factor (T·m), suspension compliance (mm/N). */
export const XMAX_MM = 6, BL = 7.82, CMS_MM_N = 1.12;
/** The excursion is drawn this many times larger than it is, so a 6 mm stroke shows (the coil still stays in its gap). */
export const DRAW_K = 1.5;
/** The coil current that holds the cone at Xmax by the suspension alone: x = Bl·i·Cms (no mass, no damping). */
export const I_FULL = XMAX_MM / 1000 / (BL * (CMS_MM_N / 1000));
/** The cone's real displacement in millimetres: the window's peak sample is Xmax. */
export const coneMm = (cone: number): number => cone * XMAX_MM;
/** The coil current the held code asks for, in amperes (speaker; static). */
export const currentA = (drive: number): number => drive * I_FULL;
/** The EMF in volts, e = Bl · v: the cone's velocity across period k, as the samples (scaled to Xmax) give it (mic). */
export function emfVolts(d: Drive, k: number): number {
  const a = d.codes[k] / d.peak, b = d.codes[(k + 1) % d.n] / d.peak;
  return BL * (((b - a) * XMAX_MM) / 1000) * d.rate;
}

// ---------------------------------------------------------------- geometry

/** Height of the dust cap's lower face at rest. */
export const DUST_Y = 36;
/** Height of the dust cap's lower face at displacement `cone` (−1 … 1), as drawn. */
export const dustY = (cone: number): number => DUST_Y + cone * XMAX_MM * DRAW_K;
const SEG = 12;
const phiOf = (k: number) => Math.PI + ((k + 0.5) * Math.PI) / SEG;

export interface SpeakerPalette {
  steel: RGB; magnet: RGB; basket: RGB; cone: RGBA; dust: RGB; former: RGB; wire: RGB; rubber: RGB; spider: RGB;
  stair: RGB; stairDim: RGBA; trace: RGB; cursor: RGB; live: RGB; zero: RGB;
}

/** A flat slab from (r0, y0) to (r1, y1) over one wedge of angle `phi` ± dphi/2, `thick` across the slope. */
export function slab(c: RGB | RGBA, phi: number, dphi: number, r0: number, y0: number, r1: number, y1: number, thick: number): Part {
  const rm = (r0 + r1) / 2, len = Math.hypot(r1 - r0, y1 - y0) || 0.01, alpha = Math.atan2(y1 - y0, r1 - r0);
  const wide = 2 * Math.max(r0, r1, 0.5) * Math.sin(dphi / 2) * 1.02;
  const rot: Quat = quatMul(quatAxisAngle([0, 1, 0], -phi), quatAxisAngle([0, 0, 1], alpha));
  return { kind: 'box', pos: [rm * Math.cos(phi), (y0 + y1) / 2, rm * Math.sin(phi)], scale: [len, thick, wide], rot, color: c };
}

/** A ring in the cut (back half): radius rIn … rOut, height y0 … y1. */
const ring = (c: RGB | RGBA, rIn: number, rOut: number, y0: number, y1: number): Part[] =>
  Array.from({ length: SEG }, (_, k) => slab(c, phiOf(k), Math.PI / SEG, rIn, (y0 + y1) / 2, rOut, (y0 + y1) / 2, y1 - y0));

/** A conical sheet (cone, spider, surround) as one slab per wedge. */
const sheet = (c: RGB | RGBA, r0: number, y0: number, r1: number, y1: number, thick: number): Part[] =>
  Array.from({ length: SEG }, (_, k) => slab(c, phiOf(k), Math.PI / SEG, r0, y0, r1, y1, thick));

/** The plot behind the speaker (its own scale: `amp` stands for full scale). */
export const PLOT = { x0: -96, x1: 96, z: -108, yc: 52, amp: 26 };
const stepX = (d: Drive, k: number): number => PLOT.x0 + ((PLOT.x1 - PLOT.x0) * k) / d.n;
const level = (v: number): number => PLOT.yc + v * PLOT.amp;
/** The staircase the plot draws: the held DAC codes (speaker) or the ADC's held samples (mic), each on −1 … 1. */
export const staircase = (d: Drive): number[] => (d.mode === 'speaker' ? d.codes.map((c) => c / d.peak) : [...d.adc]);

/** Where the voltage bar at the coil's terminals stands. */
export const BAR = { x: 122, y0: 40, z: -6, half: 26 };

/** Fixed geometry, mm. Winding 16 … 34 (18 mm) in a gap 22 … 28 (6 mm): Xmax = (18 − 6) / 2 = 6 mm. */
export const GEOM = {
  poleR: 17.8, plateIn: 20.6, magnetIn: 36, outerR: 60, backTop: 6, magnetTop: 22, plateTop: 28,
  formerIn: 18.9, formerOut: 19.5, windOut: 20.1, windLow: 16, windHigh: 34, formerTop: 36,
  coneNeck: 22, coneRim: 63, coneRimY: 72, spiderOuter: 66, spiderY: 42,
};

export function speakerParts(d: Drive, t: number, P: SpeakerPalette): Part[] {
  const ps = poseAt(d, t), dy = ps.cone * XMAX_MM * DRAW_K, out: Part[] = [], G = GEOM;
  // Fixed: back plate, ferrite ring, top plate, pole piece, the six-spoke cast frame.
  out.push(...ring(P.steel, 0, G.outerR, 0, G.backTop));
  out.push(...ring(P.magnet, G.magnetIn, G.outerR, G.backTop, G.magnetTop));
  out.push(...ring(P.steel, G.plateIn, G.outerR, G.magnetTop, G.plateTop));
  out.push(...ring(P.steel, 0, G.poleR, G.backTop, G.plateTop));
  for (const deg of [180, 240, 300, 360]) out.push(slab(P.basket, (deg * Math.PI) / 180, 0.11, G.outerR, G.plateTop, 80, 70, 4));
  out.push(...ring(P.basket, 72, 90, 70, 74));
  // Moving: the former, 6 turns of wire, the dust cap, the cone, the spider, the surround.
  out.push(...ring(P.former, G.formerIn, G.formerOut, G.windLow + dy, G.formerTop + dy));
  for (let i = 0; i < 6; i++) { const y = G.windLow + 0.3 + i * 3; out.push(...ring(P.wire, G.formerOut, G.windOut, y + dy, y + 2.4 + dy)); }
  out.push(...ring(P.dust, 0, G.coneNeck, G.formerTop + dy, G.formerTop + 1.2 + dy));
  out.push(...sheet(P.cone, G.coneNeck, G.formerTop + dy, G.coneRim, G.coneRimY + dy, 0.8));
  out.push(...sheet(P.spider, G.formerOut, 33 + dy, G.spiderOuter, G.spiderY, 0.9));
  out.push(...sheet(P.rubber, G.coneRim, G.coneRimY + dy, 67, 77 + dy / 2, 1.4), ...sheet(P.rubber, 67, 77 + dy / 2, 72, 72, 1.4));
  // The coil's terminals: a bar standing for the voltage (the amplifier's drive, or the EMF the ADC samples).
  out.push(box(P.zero, BAR.x - 4, BAR.x + 4, BAR.y0 - 0.5, BAR.y0 + 0.5, BAR.z - 4, BAR.z + 4));
  const v = ps.drive * BAR.half, y0 = BAR.y0 + Math.min(0, v), y1 = BAR.y0 + Math.max(0, v);
  if (y1 - y0 > 0.05) out.push(box(P.live, BAR.x - 3, BAR.x + 3, y0, y1, BAR.z - 3, BAR.z + 3));
  out.push(rod(P.wire, [G.windOut - 0.4, 20 + dy, 0], [BAR.x - 4, BAR.y0, BAR.z], 0.7));
  // The plot: the staircase, the future dimmed, the cursor, the cone's own trace.
  const n = d.n, st = staircase(d), w = (PLOT.x1 - PLOT.x0) / n;
  out.push(box(P.zero, PLOT.x0 - 2, PLOT.x1 + 2, PLOT.yc - 0.25, PLOT.yc + 0.25, PLOT.z - 0.4, PLOT.z + 0.4));
  for (let k = 0; k < n; k++) {
    const done = k <= ps.k, c = done ? P.stair : P.stairDim, x = stepX(d, k), y = level(st[k]);
    out.push(box(c, x, x + w, y - 0.6, y + 0.6, PLOT.z - 0.8, PLOT.z + 0.8));
    if (k > 0) {
      const y2 = level(st[k - 1]), lo = Math.min(y, y2), hi = Math.max(y, y2);
      if (hi - lo > 0.05) out.push(box(c, x - 0.5, x + 0.5, lo - 0.6, hi + 0.6, PLOT.z - 0.8, PLOT.z + 0.8));
    }
  }
  const edges = coneEdges(d), tr: Vec3[] = [], cx = PLOT.x0 + ((PLOT.x1 - PLOT.x0) * mod(t, d.n)) / d.n;
  for (let k = 0; k <= ps.k; k++) tr.push([stepX(d, k), level(edges[k]), PLOT.z + 2.4]);
  tr.push([cx, level(ps.cone), PLOT.z + 2.4]);
  for (let i = 1; i < tr.length; i++) out.push(rod(P.trace, tr[i - 1], tr[i], 0.8));
  out.push(box(P.cursor, cx - 0.4, cx + 0.4, PLOT.yc - PLOT.amp - 3, PLOT.yc + PLOT.amp + 3, PLOT.z - 0.6, PLOT.z + 0.6));
  return out;
}

export function speakerAnchors(d: Drive, t: number): Anchor[] {
  const dy = poseAt(d, t).cone * XMAX_MM * DRAW_K;
  const at = (r: number, phi: number, y: number): Vec3 => [r * Math.cos(phi), y, r * Math.sin(phi)];
  const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0, 1];
  return [
    { text: 'Cone', p: at(44, Math.PI * 1.3, 52 + dy), side: 'l', n: up },
    { text: 'Surround', p: at(67, Math.PI * 1.12, 77 + dy / 2), side: 'l', n: up },
    { text: 'Spider', p: at(40, Math.PI * 1.7, 38 + dy * 0.4), side: 'r', n: up },
    { text: 'Voice coil', p: [-19.8, 25 + dy, 0], side: 'l', n: front },
    { text: 'Pole piece', p: [-9, 12, 0], side: 'b', n: front },
    { text: 'Ferrite magnet', p: [-48, 14, 0], side: 'l', n: front },
    { text: 'Top plate', p: [-40, 25, 0], side: 'l', n: front },
    { text: 'Frame', p: at(72, Math.PI * 1.5, 52), side: 'r', n: front },
    { text: d.mode === 'speaker' ? 'Coil current' : 'EMF', p: [BAR.x, BAR.y0 + BAR.half + 2, BAR.z], side: 't', n: up },
    { text: d.mode === 'speaker' ? 'Held DAC codes' : 'ADC samples', p: [PLOT.x0 + 6, PLOT.yc + PLOT.amp + 4, PLOT.z], side: 't', n: front },
    { text: 'Cone position', p: [PLOT.x1 - 14, PLOT.yc - PLOT.amp - 3, PLOT.z + 2.4], side: 'b', n: front },
  ];
}
