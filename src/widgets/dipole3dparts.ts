// A centre-fed dipole as parts (DOM-free, tested). Length, frequency and pattern are the radio chapter's own: the frequency is
// widgets/radio.ts ANTENNA_GHZ, the wavelength phys/radio.ts wavelengthM, the pattern phys/radio.ts dipoleField at the half wave.
// 1 unit = 1 cm; the dipole lies along y, the near-field loops are drawn in the x-y plane, the current curve in the y-z plane and
// the voltage curve in the x-y plane.
//
// Drawn, not solved: the current is the sinusoidal standing wave I(z) = sin(k(L/2 - |z|)) cos(wt) of a thin centre-fed dipole of
// electrical length L (Balanis, Antenna Theory, ch. 4; at L = lambda/2 it is cos(kz): zero at the electrical tips, maximal at the
// feed) and the voltage is its quadrature twin, sign(z) cos(k(L/2 - |z|)) sin(wt), largest at the tips. The E-field loops are a
// cartoon of the near field (one forms at each charge peak, detaches after half a period and then travels at c, lambda per period);
// the H circles round the arms follow the local current. The doughnut is the exact far-field shape
// [cos(kL/2 cos t) - cos(kL/2)] / sin t of that current: the FIELD E(t), and its square, the POWER (what the gain and the half-power
// width describe). It is drawn at a nearby radius for convenience; the far field of a half-wave dipole starts about a wavelength
// out (Fraunhofer distance 2 L^2 / lambda = lambda / 2).

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';
import { C_M_S, directivityOf, wavelengthM } from '../phys/radio';
import { ANTENNA_GHZ } from './radio';

export const FREQ_HZ = ANTENNA_GHZ * 1e9;
/** lambda in cm (1 unit = 1 cm), the electrical half-wave length lambda/2 and half length lambda/4. */
export const LAMBDA = wavelengthM(ANTENNA_GHZ) * 100;
export const HALF_LEN = LAMBDA / 4;
export const K = (2 * Math.PI) / LAMBDA;
/** The radius the pattern is drawn at (peak of the lobe), and how far the loops travel before they fade (in periods). */
export const PATTERN_R = 0.85 * LAMBDA;
export const LOOP_LIFE = 1.0;
/** The conductor: a real 2.4 GHz dipole is a ~2 mm copper wire or rod (REAL_DIAMETER, cm); it is drawn 3x thicker so the current colouring shows. */
export const REAL_DIAMETER = 0.2, DRAWN_SCALE = 3;
const ROD_R = (REAL_DIAMETER * DRAWN_SCALE) / 2;
/** The feed gap (cm) bridged by an insulator block; the arms start at its edges. The amplitude (cm) of the current and voltage curves is arbitrary. */
export const GAP = 0.3, CURVE_A = 2.4;
/** A wire cut for resonance is shorter than the electrical half wave by the end effect, about 0.95 (ARRL Antenna Book; Balanis ch. 4). The rods are drawn at the CUT length; the standing wave is mapped onto the cut wire so that its node is at the drawn tip. */
export const END_EFFECT = 0.95;
/** Total end-effect shortening (cm): (1 - 0.95) lambda/2, taken as the same ~0.16 cm per end at every slider length (set by the wire's thickness, not its length). */
export const DEFICIT = (1 - END_EFFECT) * LAMBDA / 2;
/** The electrical length range of the slider, in wavelengths, and the half wave. */
export const L_MIN = 0.25, L_MAX = 1.5, L_HALF = 0.5;
/** Cut (physical) length and half length in cm of a dipole of electrical length `lwl` wavelengths. */
export const cutLength = (lwl: number): number => lwl * LAMBDA - DEFICIT;
export const cutHalf = (lwl: number): number => cutLength(lwl) / 2;
/** The feed power (W) the amplitudes are quoted for, the textbook radiation resistance of the thin half wave (ohm), and the coax's impedance. */
export const FEED_W = 1, R_HALF = 73.1, Z0_COAX = 50;
/** The drawing runs slower than the real thing: DRAW_RATE periods a second against FREQ_HZ. */
export const DRAW_RATE = 0.2;
export const SLOWDOWN = FREQ_HZ / DRAW_RATE;

// ---------------------------------------------------------------- the model the drawing follows

/** Where on the electrical wave a point of the cut wire sits: the wire's physical tip is the wave's node (the end effect makes the electrical length longer than the wire), so z is stretched by L/2 over the cut half length. Null past the tip. */
const along = (z: number, lwl: number): { u: number; h: number } | null => {
  const hc = cutHalf(lwl), h = (lwl * LAMBDA) / 2;
  return Math.abs(z) > hc + 1e-9 ? null : { u: (Math.abs(z) * h) / hc, h };
};
/** The standing-wave current at height z (cm from the feed) at phase `phase`, for electrical length `lwl` wavelengths (1 = the wave's peak): zero at and past the physical tips. */
export const currentAt = (z: number, phase: number, lwl = L_HALF): number => {
  const p = along(z, lwl);
  return p ? Math.sin(K * (p.h - p.u)) * Math.cos(phase) : 0;
};
/** Amplitude envelope sin(k(L/2 - u)): 1 at the feed of the half wave, 0 at the physical tips. */
export const envelope = (z: number, lwl = L_HALF): number => {
  const p = along(z, lwl);
  return p ? Math.sin(K * (p.h - p.u)) : 0;
};
/** The voltage along the arms, in quadrature with the current and odd about the feed: sign(z) cos(k(L/2 - u)) sin(wt). Largest at the tips of a half wave, zero at its feed. */
export const voltageAt = (z: number, phase: number, lwl = L_HALF): number => {
  const p = along(z, lwl);
  return p ? Math.sign(z) * Math.cos(K * (p.h - p.u)) * Math.sin(phase) : 0;
};

/** The far-field amplitude of the sinusoidal-current dipole, unnormalized: [cos(pi L cos t) - cos(pi L)] / sin t (L in wavelengths). */
const rawField = (theta: number, lwl: number): number => {
  const s = Math.sin(theta);
  return Math.abs(s) < 1e-9 ? 0 : (Math.cos(Math.PI * lwl * Math.cos(theta)) - Math.cos(Math.PI * lwl)) / s;
};
const peaks = new Map<number, number>();
const peakOf = (lwl: number): number => {
  let p = peaks.get(lwl);
  if (p === undefined) { p = 0; for (let i = 1; i < 1800; i++) p = Math.max(p, Math.abs(rawField((Math.PI * i) / 1800, lwl))); peaks.set(lwl, p); }
  return p;
};
/** The far-field AMPLITUDE E(theta) against the angle from the axis, 1 at its largest lobe (the chapter's dipoleField at the half wave). */
export const patternAt = (theta: number, lwl = L_HALF): number => Math.abs(rawField(theta, lwl)) / peakOf(lwl);
/** The POWER pattern, the field squared (1 at its largest lobe): what the gain and the half-power width describe. */
export const powerAt = (theta: number, lwl = L_HALF): number => patternAt(theta, lwl) ** 2;
export type PatternMode = 'power' | 'field';
/** The surface's radius factor in the chosen mode. */
export const surfaceAt = (theta: number, lwl = L_HALF, mode: PatternMode = 'field'): number => (mode === 'power' ? powerAt(theta, lwl) : patternAt(theta, lwl));
/** Directivity (a ratio) of the length-L dipole by integrating its power pattern over the sphere (1.64 at the half wave). */
export const directivity = (lwl: number): number => directivityOf((t) => powerAt(t, lwl));
export const gainDbi = (lwl: number): number => 10 * Math.log10(directivity(lwl));
/** The angle of the largest lobe and the half-power (-3 dB) edges around it, radians from the axis: 78 degrees wide at the half wave. */
export function halfPower(lwl: number): { peak: number; lo: number; hi: number; width: number } {
  let peak = Math.PI / 2, best = -1;
  for (let i = 1; i < 1800; i++) { const t = (Math.PI * i) / 1800, p = powerAt(t, lwl); if (p > best + 1e-12) { best = p; peak = t; } }
  const edge = (end: number): number => {
    if (powerAt(end, lwl) >= 0.5) return end;
    let a = peak, b = end;
    for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (powerAt(m, lwl) >= 0.5) a = m; else b = m; }
    return (a + b) / 2;
  };
  const lo = edge(0), hi = edge(Math.PI);
  return { peak, lo, hi, width: hi - lo };
}
/** Radiation resistance referred to the current maximum, Rr = 60 integral (cos(pi L cos t) - cos pi L)^2 / sin t dt (ohm; 73.1 at the half wave). */
export function radiationResistance(lwl: number, n = 4000): number {
  let sum = 0;
  for (let i = 0; i < n; i++) { const t = ((i + 0.5) / n) * Math.PI, f = Math.cos(Math.PI * lwl * Math.cos(t)) - Math.cos(Math.PI * lwl); sum += (f * f) / Math.sin(t); }
  return 60 * sum * (Math.PI / n);
}
/** The resistance at the feed, Rr / sin^2(pi L): the feed sits at a current of sin(pi L) of the wave's peak (infinite at L = 1 lambda, a current null). */
export const feedResistance = (lwl: number): number => {
  const s2 = Math.sin(Math.PI * lwl) ** 2;
  return s2 < 1e-9 ? Infinity : radiationResistance(lwl) / s2;
};
/** Matching to a 50 ohm line (resistance only, reactance trimmed to zero): reflection coefficient, SWR, return loss (dB). */
export const mismatch = (r: number, z0 = Z0_COAX): { gamma: number; swr: number; returnLoss: number } => {
  const g = Math.abs((r - z0) / (r + z0));
  return { gamma: g, swr: g >= 1 ? Infinity : (1 + g) / (1 - g), returnLoss: g <= 0 ? Infinity : -20 * Math.log10(g) };
};
/** Peak feed current and voltage for `w` watts into resistance `r`: I = sqrt(2P/R), V = I R. */
export const feedDrive = (r: number, w = FEED_W): { amps: number; volts: number } => { const i = Math.sqrt((2 * w) / r); return { amps: i, volts: i * r }; };

/** The time a loop is born at (periods): at each charge peak, i.e. where the current crosses zero, alternating in sense. */
export const loopBirth = (n: number): number => 0.25 + n / 2;
export interface Loop { n: number; sign: 1 | -1; age: number; xIn: number; xOut: number; alpha: number }
/** Where the loop's outer front is `age` periods after birth: the wave moves c T = lambda per period. */
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

type Surface = (theta: number) => number;
/** Points of the pattern surface in the meridian plane at azimuth `az` (about the y axis, from +z): radius R f(theta). */
export function patternRing(az: number, R = PATTERN_R, n = 36, f: Surface = (t) => patternAt(t)): Vec3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const th = (Math.PI * i) / n, r = R * f(th);
    return [r * Math.sin(th) * Math.sin(az), r * Math.cos(th), r * Math.sin(th) * Math.cos(az)] as Vec3;
  });
}
/** The parallel at polar angle theta from azimuth a0 to a1. */
export function patternParallel(th: number, a0: number, a1: number, R = PATTERN_R, n = 40, f: Surface = (t) => patternAt(t)): Vec3[] {
  const r = R * f(th);
  return Array.from({ length: n + 1 }, (_, i) => {
    const az = a0 + ((a1 - a0) * i) / n;
    return [r * Math.sin(th) * Math.sin(az), r * Math.cos(th), r * Math.sin(th) * Math.cos(az)] as Vec3;
  });
}
/** A circle of the magnetic field round the arm at height y (x-z plane), radius r. */
export function hRing(y: number, r: number, steps = 18): Vec3[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const s = (2 * Math.PI * i) / steps;
    return [r * Math.cos(s), y, r * Math.sin(s)] as Vec3;
  });
}

// ---------------------------------------------------------------- the driving state

/** Time in periods. Step advances a phase (1/8 of a period). `lwl`: the electrical length in wavelengths. */
export const STEP_PHASE = 1 / 8;
export class DipoleRun {
  t = 0;
  lwl = L_HALF;
  get phase(): number { return 2 * Math.PI * this.t; }
  get degrees(): number { return Math.round((((this.t % 1) + 1) % 1) * 360); }
  advance(dt: number): void { this.t += dt; }
  step(): void { this.t = Math.round(this.t / STEP_PHASE) * STEP_PHASE + STEP_PHASE; }
  /** The feed current now, 1 = the wave's peak (sin(pi L) of it at the feed). */
  get feed(): number { return currentAt(0, this.phase, this.lwl); }
  /** The current at the cut tips now: zero, the wire ends there. */
  get tip(): number { return currentAt(cutHalf(this.lwl), this.phase, this.lwl); }
}

// ---------------------------------------------------------------- the drawing

export interface DipolePalette { rod: RGB; ins: RGB; pos: RGB; neg: RGB; e1: RGB; e2: RGB; pat: RGB; src: RGB; ghost: RGBA; volt: RGB; hfield: RGB }
/** How the dipole is fed: balanced leads (as drawn since the start), a bare coax (current on the braid), a coax with a quarter-wave sleeve. */
export type Feed = 'balanced' | 'coax' | 'balun';
export interface DipoleView { mode: PatternMode; feed: Feed }
const DEFAULT_VIEW: DipoleView = { mode: 'field', feed: 'balanced' };
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const alpha = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], a];
const SEG = 12;
/** The pattern's cut-away: the wedge toward the viewer (azimuth within CUT of +z) is left out. */
export const CUT = (75 * Math.PI) / 180;
const MERIDIANS = [75, 105, 135, 165, 195, 225, 255, 285].map((d) => (d * Math.PI) / 180);
/** Coax (semi-rigid .086 in, 2.2 mm over the dielectric), the sleeve (quarter wave in air, shorted at its far end). */
export const COAX_R = 0.11, SLEEVE_R = 0.5, SLEEVE_LEN = LAMBDA / 4, COAX_X0 = -0.7, COAX_LEN = 8;
const H_R = 1.5;

const poly = (pts: Vec3[], c: RGB | RGBA, r: number, spec = 0): Part[] => pts.slice(1).map((p, i) => rod(c, pts[i], p, r, spec));

export function dipoleParts(run: DipoleRun, showPattern: boolean, P: DipolePalette, view: DipoleView = DEFAULT_VIEW): Part[] {
  const out: Part[] = [], ph = run.phase, L = run.lwl, hc = cutHalf(L);
  // The rods: each short piece coloured by its instantaneous current (red one way, blue the other, grey at zero).
  for (const side of [1, -1]) for (let i = 0; i < SEG; i++) {
    const g = GAP / 2, z0 = side * (g + ((hc - g) * i) / SEG), z1 = side * (g + ((hc - g) * (i + 1)) / SEG), v = currentAt((z0 + z1) / 2, ph, L);
    out.push(rod(mix(P.rod, v >= 0 ? P.pos : P.neg, Math.min(1, Math.abs(v) * 1.1)), [0, z0, 0], [0, z1, 0], ROD_R));
  }
  // The charge at the tips: the voltage is largest there, in quadrature with the current (sin wt against cos wt).
  for (const side of [1, -1]) {
    const v = voltageAt(side * hc, ph, L), c = mix(P.rod, v >= 0 ? P.pos : P.neg, Math.min(1, Math.abs(v) * 1.2));
    const y0 = side > 0 ? hc : -hc - 0.8;
    out.push(box(c, -0.4, 0.4, y0, y0 + 0.8, -0.4, 0.4));
  }
  // The centre insulator (PTFE) holding the two arms.
  out.push(box(P.ins, -0.45, 0.45, -GAP / 2 - 0.5, GAP / 2 + 0.5, -0.45, 0.45));
  feedParts(out, run, P, view);
  // The current: the envelope as thin ghosts on both sides, and the instantaneous curve sin(k(L/2 - |z|)) cos(wt).
  const N = 16, zs = Array.from({ length: N + 1 }, (_, i) => -hc + (2 * hc * i) / N);
  for (const sg of [1, -1]) out.push(...poly(zs.map((z) => [0, z, sg * CURVE_A * envelope(z, L)] as Vec3), P.ghost, 0.05));
  const v0 = Math.cos(ph);
  out.push(...poly(zs.map((z) => [0, z, CURVE_A * currentAt(z, ph, L)] as Vec3), mix(P.rod, v0 >= 0 ? P.pos : P.neg, Math.min(1, 0.35 + Math.abs(v0))), 0.1));
  // The voltage: sign(z) cos(k(L/2 - |z|)) sin(wt), drawn sideways (x): zero at the feed of the half wave, largest at the tips.
  out.push(...poly(zs.map((z) => [CURVE_A * voltageAt(z, ph, L), z, 0] as Vec3), alpha(P.volt, 0.55 + 0.45 * Math.abs(Math.sin(ph))), 0.1));
  // The magnetic field: circles round the arms, strength those of the local current (sense by the right-hand rule).
  for (const f of [0.18, 0.5, 0.82]) for (const side of [1, -1]) {
    const y = side * f * hc, i = currentAt(y, ph, L);
    if (Math.abs(i) > 0.08) out.push(...poly(hRing(y, H_R), alpha(P.hfield, Math.min(0.9, 0.15 + 0.8 * Math.abs(i))), 0.05));
  }
  // The near field: loops in the x-y plane, both sides.
  for (const l of loopsAt(run.t)) for (const side of [1, -1] as const) {
    out.push(...poly(loopOutline(l, side), alpha(l.sign > 0 ? P.e1 : P.e2, 0.85 * l.alpha), 0.12));
  }
  // The far-field pattern, cut open toward the viewer: the field E(theta) or its square, the power.
  if (showPattern) {
    const f: Surface = (t) => surfaceAt(t, L, view.mode);
    for (const az of MERIDIANS) out.push(...poly(patternRing(az, PATTERN_R, 36, f), alpha(P.pat, 0.5), 0.08));
    for (const th of [0.28, 0.6, 0.95, Math.PI / 2, Math.PI - 0.95, Math.PI - 0.6, Math.PI - 0.28]) out.push(...poly(patternParallel(th, CUT, 2 * Math.PI - CUT, PATTERN_R, 40, f), alpha(P.pat, 0.4), 0.07));
    for (const az of [CUT, -CUT]) out.push(...poly(patternRing(az, PATTERN_R, 36, f), alpha(P.pat, 0.95), 0.16));
    // The half-power (-3 dB) cone round the largest lobe: the power is 1/2 (the field 0.707) on these two parallels.
    const hp = halfPower(L);
    for (const th of [hp.lo, hp.hi]) if (th > 0.02 && th < Math.PI - 0.02) out.push(...poly(patternParallel(th, CUT, 2 * Math.PI - CUT, PATTERN_R, 40, f), alpha(P.e1, 0.95), 0.14));
  }
  return out;
}

/** The leads / coax at the feed, on the -x side. */
function feedParts(out: Part[], run: DipoleRun, P: DipolePalette, view: DipoleView): void {
  if (view.feed === 'balanced') {
    for (const sg of [1, -1]) out.push(rod(P.rod, [0, sg * GAP / 2, 0], [-3.5, sg * GAP / 2, 0], 0.05));
    out.push(box(P.src, -5.5, -3.5, -GAP / 2 - 0.5, GAP / 2 + 0.5, -0.6, 0.6));
    return;
  }
  // Coax straight onto the arms: the shield to the lower arm, the centre conductor to the upper one.
  const x1 = COAX_X0 - COAX_LEN;
  out.push(rod(mix(P.src, P.ins, 0.55), [COAX_X0, 0, 0], [x1, 0, 0], COAX_R));
  out.push(rod(P.rod, [COAX_X0, 0, 0], [-0.1, -GAP / 2, 0], 0.05), rod(P.rod, [COAX_X0, 0, 0], [-0.1, GAP / 2, 0], 0.05));
  out.push(box(P.src, x1 - 2, x1, -0.7, 0.7, -0.6, 0.6));
  if (view.feed === 'balun') {
    // Sleeve: open toward the feed, shorted to the braid a quarter wave away, so the braid's outside sees a high impedance.
    const xe = COAX_X0 - SLEEVE_LEN;
    out.push(rod(alpha(P.rod, 0.4), [COAX_X0 - 0.1, 0, 0], [xe, 0, 0], SLEEVE_R));
    out.push(box(P.rod, xe - 0.1, xe + 0.1, -SLEEVE_R, SLEEVE_R, -SLEEVE_R, SLEEVE_R));
  } else {
    // No sleeve: the antenna's current also flows on the outside of the braid, in step with the lower arm's.
    const v = currentAt(-GAP, run.phase, run.lwl), c = mix(P.rod, v >= 0 ? P.pos : P.neg, Math.min(1, 0.3 + Math.abs(v)));
    for (const x of [-1.5, -3.5, -5.5]) out.push(rod(c, [x, 0.35, 0], [x - 1.2, 0.35, 0], 0.08));
  }
}

export function dipoleAnchors(run: DipoleRun, showPattern: boolean, view: DipoleView = DEFAULT_VIEW): Anchor[] {
  const front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0], hc = cutHalf(run.lwl);
  const half = Math.abs(run.lwl - L_HALF) < 1e-9;
  const a: Anchor[] = [
    { text: half ? 'tip: I = 0, V max' : 'tip', p: [0, hc + 0.9, 0], side: 't', n: up },
    { text: half ? 'feed: I max, 73 Ω' : 'feed', p: [0.45, 0, 0.45], side: 'r', n: front },
    view.feed === 'balanced'
      ? { text: 'source (leads)', p: [-5.5, 0, 0], side: 'l', n: front, minor: true }
      : { text: view.feed === 'balun' ? 'coax + λ/4 sleeve' : 'coax, no balun', p: [COAX_X0 - COAX_LEN - 2, 0, 0], side: 'l', n: front, minor: true },
    { text: 'I(z)', p: [0, hc * 0.8, CURVE_A * 0.45], side: 'r', n: front, minor: true },
    { text: 'V(z)', p: [CURVE_A * 0.8, hc * 0.8, 0], side: 'r', n: front, minor: true },
  ];
  // Named only on a loop that has left the rod (its inner edge a quarter wave out), so the label never crowds the rod's own.
  const l = loopsAt(run.t).filter((q) => q.alpha > 0.4 && q.xIn > LAMBDA / 4).sort((p, q) => q.xOut - p.xOut)[0];
  if (l) a.push({ text: 'E loops, out at c', p: [(l.xIn + l.xOut) / 2, 0.5 * ((l.xOut - l.xIn) / 2) + 0.5, 0], side: 't', n: front });
  if (showPattern) {
    const hp = halfPower(run.lwl), r = surfaceAt(hp.peak, run.lwl, view.mode) * PATTERN_R;
    a.push({ text: 'null on the axis', p: [0, hc + 4.2, 0], side: 't', n: up, minor: true });
    a.push({ text: `maximum, ${gainDbi(run.lwl).toFixed(2)} dBi`, p: [r * Math.sin(hp.peak) * Math.sin(CUT), r * Math.cos(hp.peak), r * Math.sin(hp.peak) * Math.cos(CUT)], side: 'b', n: front, minor: true });
  }
  return a;
}
