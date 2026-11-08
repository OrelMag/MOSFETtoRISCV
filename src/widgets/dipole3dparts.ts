// A half-wave dipole as parts (DOM-free, tested). Length, frequency and pattern are the radio chapter's own: the frequency is
// widgets/radio.ts ANTENNA_GHZ, the wavelength phys/radio.ts wavelengthM, the pattern dipoleField. 1 unit = 1 cm; the dipole
// lies along y, the near-field loops are drawn in the x-y plane, the current curve in the y-z plane.
//
// Drawn, not solved: the current is the standing wave I(z) = cos(kz) cos(ωt) of a thin dipole (zero at the tips, maximal at the
// feed); the E-field loops are a cartoon of the near field (one forms at each charge peak, detaches after half a period and
// then travels at c, λ per period); the doughnut is the exact far-field shape cos(π/2·cosθ)/sinθ, drawn at a nearby radius for
// convenience: the real far field starts many wavelengths out.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';
import { C_M_S, dipoleField, wavelengthM } from '../phys/radio';
import { ANTENNA_GHZ } from './radio';

export const FREQ_HZ = ANTENNA_GHZ * 1e9;
/** λ in cm (1 unit = 1 cm), the dipole's drawn length λ/2 and half length λ/4. */
export const LAMBDA = wavelengthM(ANTENNA_GHZ) * 100;
export const HALF_LEN = LAMBDA / 4;
export const K = (2 * Math.PI) / LAMBDA;
/** The radius the pattern is drawn at (peak of the lobe), and how far the loops travel before they fade (in periods). */
export const PATTERN_R = 0.85 * LAMBDA;
export const LOOP_LIFE = 1.0;
/** The conductor: a real 2.4 GHz dipole is a ~2 mm copper wire or rod (REAL_DIAMETER, cm); it is drawn 3x thicker so the current colouring shows. */
export const REAL_DIAMETER = 0.2, DRAWN_SCALE = 3;
const ROD_R = (REAL_DIAMETER * DRAWN_SCALE) / 2;
/** The feed gap (cm) bridged by an insulator block; the arms start at its edges. The amplitude (cm) of the current curve is arbitrary. */
export const GAP = 0.3, CURVE_A = 2.4;
/** A wire cut for resonance is shorter than the electrical half wave by the end effect, about 0.95 (ARRL Antenna Book; Balanis ch. 4); the drawing keeps the electrical length, which the chapter and cos(kz) use. */
export const END_EFFECT = 0.95;
/** The drawing runs slower than the real thing: DRAW_RATE periods a second against FREQ_HZ. */
export const DRAW_RATE = 0.2;
export const SLOWDOWN = FREQ_HZ / DRAW_RATE;

// ---------------------------------------------------------------- the model the drawing follows

/** The standing-wave current at height z (cm from the feed) at phase `phase` (radians of the cycle): zero past the tips. */
export const currentAt = (z: number, phase: number): number => (Math.abs(z) > HALF_LEN + 1e-9 ? 0 : Math.cos(K * z) * Math.cos(phase));
/** Amplitude envelope: 1 at the feed, 0 at the tips. */
export const envelope = (z: number): number => (Math.abs(z) >= HALF_LEN - 1e-9 ? 0 : Math.cos(K * z));
/** The far-field amplitude against the angle from the axis (the chapter's dipoleField). */
export const patternAt = (theta: number): number => Math.abs(dipoleField(theta));

/** The time a loop is born at (periods): at each charge peak, i.e. where the current crosses zero, alternating in sense. */
export const loopBirth = (n: number): number => 0.25 + n / 2;
export interface Loop { n: number; sign: 1 | -1; age: number; xIn: number; xOut: number; alpha: number }
/** Where the loop's outer front is `age` periods after birth: the wave moves c·T = λ per period. */
export const frontAt = (age: number): number => (C_M_S / FREQ_HZ) * 100 * age;
/** The loops on show at time t (periods), outer front first formed at the antenna, detached once half a wavelength wide. */
export function loopsAt(t: number): Loop[] {
  const out: Loop[] = [];
  for (let n = Math.ceil(2 * (t - 0.25 - LOOP_LIFE)); n <= Math.floor(2 * (t - 0.25)); n++) {
    const age = t - loopBirth(n);
    if (age < 0 || age > LOOP_LIFE) continue;
    const xOut = frontAt(age), xIn = Math.max(0, xOut - LAMBDA / 2);
    const alpha = Math.min(1, age / 0.08) * Math.min(1, (LOOP_LIFE - age) / 0.25);
    out.push({ n, sign: n % 2 === 0 ? 1 : -1, age, xIn, xOut, alpha });
  }
  return out;
}
/** A loop's outline in the x-y plane on the +x side (`side` -1 mirrors it): an ellipse from xIn to xOut. */
export function loopOutline(l: Loop, side: 1 | -1, steps = 28): Vec3[] {
  const a = (l.xOut - l.xIn) / 2, xc = (l.xOut + l.xIn) / 2, b = 0.5 * a + 0.5;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const s = (2 * Math.PI * i) / steps;
    return [side * (xc + a * Math.cos(s)), b * Math.sin(s), 0] as Vec3;
  });
}

/** Points of the pattern surface in the meridian plane at azimuth `az` (about the y axis, from +z): radius R·|f(θ)|. */
export function patternRing(az: number, R = PATTERN_R, n = 36): Vec3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const th = (Math.PI * i) / n, r = R * patternAt(th);
    return [r * Math.sin(th) * Math.sin(az), r * Math.cos(th), r * Math.sin(th) * Math.cos(az)] as Vec3;
  });
}
/** The parallel at polar angle θ from azimuth a0 to a1. */
export function patternParallel(th: number, a0: number, a1: number, R = PATTERN_R, n = 40): Vec3[] {
  const r = R * patternAt(th);
  return Array.from({ length: n + 1 }, (_, i) => {
    const az = a0 + ((a1 - a0) * i) / n;
    return [r * Math.sin(th) * Math.sin(az), r * Math.cos(th), r * Math.sin(th) * Math.cos(az)] as Vec3;
  });
}

// ---------------------------------------------------------------- the driving state

/** Time in periods. Step advances a phase (1/8 of a period). */
export const STEP_PHASE = 1 / 8;
export class DipoleRun {
  t = 0;
  get phase(): number { return 2 * Math.PI * this.t; }
  get degrees(): number { return Math.round((((this.t % 1) + 1) % 1) * 360); }
  advance(dt: number): void { this.t += dt; }
  step(): void { this.t = Math.round(this.t / STEP_PHASE) * STEP_PHASE + STEP_PHASE; }
  /** The feed current now, 1 = peak. */
  get feed(): number { return currentAt(0, this.phase); }
}

// ---------------------------------------------------------------- the drawing

export interface DipolePalette { rod: RGB; ins: RGB; pos: RGB; neg: RGB; e1: RGB; e2: RGB; pat: RGB; src: RGB; ghost: RGBA }
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const alpha = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], a];
const SEG = 16;
/** The pattern's cut-away: the wedge toward the viewer (azimuth within CUT of +z) is left out. */
export const CUT = (75 * Math.PI) / 180;
const MERIDIANS = [75, 105, 135, 165, 195, 225, 255, 285].map((d) => (d * Math.PI) / 180);

const poly = (pts: Vec3[], c: RGB | RGBA, r: number, spec = 0): Part[] => pts.slice(1).map((p, i) => rod(c, pts[i], p, r, spec));

export function dipoleParts(run: DipoleRun, showPattern: boolean, P: DipolePalette): Part[] {
  const out: Part[] = [], ph = run.phase;
  // The rods: each short piece coloured by its instantaneous current (red one way, blue the other, grey at zero).
  for (const side of [1, -1]) for (let i = 0; i < SEG; i++) {
    const g = GAP / 2, z0 = side * (g + ((HALF_LEN - g) * i) / SEG), z1 = side * (g + ((HALF_LEN - g) * (i + 1)) / SEG), v = currentAt((z0 + z1) / 2, ph);
    out.push(rod(mix(P.rod, v >= 0 ? P.pos : P.neg, Math.min(1, Math.abs(v) * 1.1)), [0, z0, 0], [0, z1, 0], ROD_R));
  }
  // The centre insulator (PTFE) holding the two arms, and a balanced pair of leads to the source (no balun drawn).
  out.push(box(P.ins, -0.45, 0.45, -GAP / 2 - 0.5, GAP / 2 + 0.5, -0.45, 0.45));
  for (const sg of [1, -1]) out.push(rod(P.rod, [0, sg * GAP / 2, 0], [-3.5, sg * GAP / 2, 0], 0.05));
  out.push(box(P.src, -5.5, -3.5, -GAP / 2 - 0.5, GAP / 2 + 0.5, -0.6, 0.6));
  // The current: the envelope cos(kz) as thin ghosts on both sides, and the instantaneous curve cos(kz)·cos(ωt).
  const zs = Array.from({ length: 25 }, (_, i) => -HALF_LEN + (2 * HALF_LEN * i) / 24);
  for (const sg of [1, -1]) out.push(...poly(zs.map((z) => [0, z, sg * CURVE_A * envelope(z)] as Vec3), P.ghost, 0.05));
  const v0 = Math.cos(ph);
  const now = poly(zs.map((z) => [0, z, CURVE_A * currentAt(z, ph)] as Vec3), mix(P.rod, v0 >= 0 ? P.pos : P.neg, Math.min(1, 0.35 + Math.abs(v0))), 0.1);
  out.push(...now);
  // The near field: loops in the x-y plane, both sides.
  for (const l of loopsAt(run.t)) for (const side of [1, -1] as const) {
    out.push(...poly(loopOutline(l, side), alpha(l.sign > 0 ? P.e1 : P.e2, 0.85 * l.alpha), 0.12));
  }
  // The far-field pattern, cut open toward the viewer.
  if (showPattern) {
    for (const az of MERIDIANS) out.push(...poly(patternRing(az), alpha(P.pat, 0.5), 0.08));
    for (const th of [0.28, 0.6, 0.95, Math.PI / 2, Math.PI - 0.95, Math.PI - 0.6, Math.PI - 0.28]) out.push(...poly(patternParallel(th, CUT, 2 * Math.PI - CUT), alpha(P.pat, 0.4), 0.07));
    for (const az of [CUT, -CUT]) out.push(...poly(patternRing(az), alpha(P.pat, 0.95), 0.16));
  }
  return out;
}

export function dipoleAnchors(run: DipoleRun, showPattern: boolean): Anchor[] {
  const front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0];
  const a: Anchor[] = [
    { text: 'tip: I = 0', p: [0, HALF_LEN + 0.4, 0], side: 't', n: up },
    { text: 'tip: I = 0', p: [0, -HALF_LEN - 0.4, 0], side: 'b', n: [0, -1, 0], minor: true },
    { text: 'feed gap: largest swing', p: [0.45, 0, 0.45], side: 'r', n: front },
    { text: 'source (leads, no balun)', p: [-5.5, 0, 0], side: 'l', n: front, minor: true },
    { text: 'I(z) ∝ cos kz', p: [0, HALF_LEN * 0.8, CURVE_A * 0.45], side: 'r', n: front, minor: true },
  ];
  const l = loopsAt(run.t).filter((q) => q.alpha > 0.6).sort((p, q) => q.xOut - p.xOut)[0];
  if (l) a.push({ text: 'E loops, out at c', p: [(l.xIn + l.xOut) / 2, 0.5 * ((l.xOut - l.xIn) / 2) + 0.5, 0], side: 't', n: front });
  if (showPattern) {
    a.push({ text: 'null on the axis', p: [0, HALF_LEN + 4.2, 0], side: 't', n: up, minor: true });
    a.push({ text: 'maximum broadside', p: [PATTERN_R * Math.sin(CUT), 0, PATTERN_R * Math.cos(CUT)], side: 'b', n: front, minor: true });
  }
  return a;
}
