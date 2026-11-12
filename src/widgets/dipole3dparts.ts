// A centre-fed dipole as parts (DOM-free, tested). Length, frequency and pattern are the radio chapter's own: the frequency is
// widgets/radio.ts ANTENNA_GHZ, the wavelength phys/radio.ts wavelengthM, the pattern phys/radio.ts dipoleField at the half wave.
// 1 unit = 1 cm; the dipole lies along y, the near-field loops are drawn in the x-y plane, the current curve in the y-z plane and
// the voltage curve in the x-y plane. The drawing itself is dipole3dkit.ts (the studio model).
//
// Drawn, not solved: the current is the sinusoidal standing wave I(z) = sin(k(L/2 - |z|)) cos(wt) of a thin centre-fed dipole of
// electrical length L (Balanis, Antenna Theory, ch. 4; at L = lambda/2 it is cos(kz): zero at the electrical tips, maximal at the
// feed) and the voltage is its quadrature twin, sign(z) cos(k(L/2 - |z|)) sin(wt), largest at the tips. The E-field loops are a
// cartoon of the near field (one forms at each charge peak, detaches after half a period and then travels at c, lambda per period);
// the H circles round the arms follow the local current. The doughnut is the exact far-field shape
// [cos(kL/2 cos t) - cos(kL/2)] / sin t of that current: the FIELD E(t), and its square, the POWER (what the gain and the half-power
// width describe). It is drawn at a nearby radius for convenience; the far field of a half-wave dipole starts about a wavelength
// out (Fraunhofer distance 2 L^2 / lambda = lambda / 2).

import type { Vec3 } from '../gl/math';
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

// ---------------------------------------------------------------- what the 3D draws (dipole3dkit.ts)

/** How the dipole is fed: balanced leads, a bare coax (current on the braid), a coax with a quarter-wave sleeve. */
export type Feed = 'balanced' | 'coax' | 'balun';
/** Coax (semi-rigid .086 in, 2.2 mm over the jacket), the sleeve (a quarter wave in air, shorted at its far end; its radius illustrative), where the coax leaves the feed and how far it runs (cm). */
export const COAX_R = 0.11, SLEEVE_R = 0.5, SLEEVE_LEN = LAMBDA / 4, COAX_X0 = -0.7, COAX_LEN = 8;
