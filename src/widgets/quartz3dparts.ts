// The 32 768 Hz watch crystal and the oscillator around it, as parts (DOM-free, tested).
//
// The crystal is a TUNING FORK cut from a quartz wafer, vibrating in a flexural mode: the two tines bend in antiphase, like
// the fork of a musician. (A thickness-shear blank between two electrodes is an AT-cut crystal, MHz, f ∝ 1/thickness: see
// atThicknessMm; it is not what is in a watch.) Sources: Epson FC-135 (3.2 × 1.5 × 0.8 mm SMD package); tine width < 0.18 mm,
// wafer 0.05–0.15 mm and a total length of 1.2–2.2 mm in the tuning-fork patents US 7 944 131 / 8 572 824; turnover 25 °C and
// parabolic coefficient −0.034 ppm/°C² in CTS / Qantek / Taitien 32.768 kHz fork datasheets; Q 3×10⁴–9×10⁴ (Taitien, Qantek,
// ECS; 50 000 is the minimum in Epson's ECX-306X listing, 60 000 typical in Raltron's, 30 000–60 000 in Taitien's); the Pierce numbers from IQD/Statek Technical Note 31 (fs = 32.7644 kHz, C1 = 2.3 fF, C0 = 1.5 pF, CL = 9.0 pF).
//
// Two scales: the crystal view is 1 unit = 0.1 mm (the package is 32 × 15 × 8 units), the board view 1 unit = 1 mm.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, wire, type Anchor, type Part } from '../gl/parts';

// ---------------------------------------------------------------- the numbers

export const F_WATCH = 32768;
export const STAGES = 15;
/** The ÷2 chain: 2^15 = 32 768, so fifteen toggles make exactly 1 Hz. */
export const DIVIDE = 2 ** STAGES;
/** Output of stage i (0-based) from a clock of f Hz: f / 2^(i+1), as lib/seqparts.ts clockDivider. */
export const stageFreq = (i: number, f = F_WATCH): number => f / 2 ** (i + 1);
/** Stage bits after n input cycles (counting up; the library's ripple chain counts down, the same frequencies): bit i has period 2^(i+1). */
export const stageBits = (n: number): number[] => Array.from({ length: STAGES }, (_, i) => Math.floor(n / 2 ** i) % 2);

// Flexural mode of a cantilever (Euler–Bernoulli): f = (βL)² / 2π · w / L² · √(E / 12ρ), βL = 1.8751 for the first mode.
export const BETA_L = 1.875104;
/** Quartz along the bending direction: Young's modulus (≈ 78 GPa, an estimate: quartz is anisotropic) and density. */
export const E_QUARTZ = 78e9, RHO_QUARTZ = 2649;
export const beamFreq = (w: number, L: number, E = E_QUARTZ, rho = RHO_QUARTZ): number => (BETA_L ** 2 / (2 * Math.PI)) * (w / (L * L)) * Math.sqrt(E / (12 * rho));
/** The free tine length (m) that puts a tine of width w (m) at f. */
export const tineLength = (f: number, w: number, E = E_QUARTZ, rho = RHO_QUARTZ): number => Math.sqrt((BETA_L ** 2 / (2 * Math.PI)) * w * Math.sqrt(E / (12 * rho)) / f);
/** The first mode's shape, tip = 1 (ξ = x / L from the root). */
export const modeShape = (xi: number): number => {
  const b = BETA_L * xi, sg = (Math.cosh(BETA_L) + Math.cos(BETA_L)) / (Math.sinh(BETA_L) + Math.sin(BETA_L));
  const y = (u: number) => Math.cosh(u) - Math.cos(u) - sg * (Math.sinh(u) - Math.sin(u));
  return y(b) / y(BETA_L);
};

/** Fork dimensions (mm): tine width in the bending direction, wafer thickness, gap, base length. */
export const TINE_W = 0.1, WAFER_T = 0.1, TINE_GAP = 0.15, BASE_L = 0.5;
export const TINE_L = tineLength(F_WATCH, TINE_W * 1e-3) * 1e3;

export const TURNOVER_C = 25, TEMP_K = -0.034;
/** Frequency offset (ppm) at T °C: parabolic, −0.034 ppm/°C² about the 25 °C turnover. */
export const tempPpm = (T: number): number => TEMP_K * (T - TURNOVER_C) ** 2;
/** Frequency at T °C for a part whose initial tolerance is tol ppm at the turnover (a fork is ±20 ppm: Epson FC-135). */
export const freqAt = (T: number, f = F_WATCH, tol = 0): number => f * (1 + (tempPpm(T) + tol) * 1e-6);
export const TOL_PPM = 20;
/** A clock running ppm off gains / loses this many seconds a day. */
export const secPerDay = (ppm: number): number => ppm * 1e-6 * 86400;

/** Q = 50 000: the minimum in Epson's ECX-306X listing (Raltron lists 60 000 typical, Taitien 30 000–60 000). */
export const Q_FORK = 50000;
/** Amplitude ring-down time constant, 2Q / ω = Q / (π f). */
export const ringTau = (Q = Q_FORK, f = F_WATCH): number => Q / (Math.PI * f);

/** Statek TN31's example: motional C1, shunt C0, series resonance fs. */
export const FS = 32764.4, C_MOT = 2.3e-15, C_SHUNT = 1.5e-12;
/** The load a Pierce circuit presents: the two caps in series plus the stray across the crystal. */
export const loadCap = (c1: number, c2: number, cs: number): number => (c1 * c2) / (c1 + c2) + cs;
/** Oscillation frequency with load CL: fs · (1 + C1 / (2 (C0 + CL))). */
export const loaded = (CL: number, fs = FS, c1 = C_MOT, c0 = C_SHUNT): number => fs * (1 + c1 / (2 * (c0 + CL)));
export const PIERCE = { c: 15e-12, cs: 1.5e-12, rf: 10e6 };

// ---- two crystals: the lesson of "Two clocks are a different problem"
export interface Drift { dppm: number; dHz: number; slipS: number }
/** Two oscillators at nominal f, each with a tolerance (ppm) and a temperature: the frequency difference and the time for B to gain (or lose)
 *  one full cycle on A. Infinity when they agree. */
export function driftOf(f: number, tolA: number, tA: number, tolB: number, tB: number): Drift {
  const dHz = freqAt(tA, f, tolA) - freqAt(tB, f, tolB);
  return { dppm: (dHz / f) * 1e6, dHz, slipS: dHz === 0 ? Infinity : 1 / Math.abs(dHz) };
}
export const fmtTime = (s: number): string =>
  !isFinite(s) ? 'never' : s < 1e-3 ? `${(s * 1e6).toPrecision(3)} µs` : s < 1 ? `${(s * 1e3).toPrecision(3)} ms` : s < 120 ? `${s.toPrecision(3)} s` : s < 7200 ? `${(s / 60).toPrecision(3)} min` : s < 172800 ? `${(s / 3600).toPrecision(3)} h` : `${(s / 86400).toPrecision(3)} days`;
/** The fraction of A's period, either side of its edge, drawn as the setup + hold window (illustrative: the chapter's window depends on the
 *  receiver's clock; at 1 GHz it is about 6 %). */
export const WINDOW_FRAC = 0.04;
/** One fixed screen time scale for the ring: the step's case (±20 ppm, 40 ppm apart) turns once in SLIP_S screen seconds, so the ring's speed
 *  is proportional to Δf (20 ppm apart: half as fast, equal: still). */
export const SLIP_S = 8, REF_PPM = 40;
/** B's phase gained on A, in cycles per screen second (negative when A is faster: B falls behind). */
export const screenSlip = (f: number, dHz: number): number => -dHz / (f * REF_PPM * 1e-6) / SLIP_S;
/** Real seconds that pass in one screen second. */
export const realPerScreen = (f: number): number => 1 / (f * REF_PPM * 1e-6 * SLIP_S);
export const inWindow = (slip: number): boolean => { const x = ((slip % 1) + 1) % 1; return x <= WINDOW_FRAC || x >= 1 - WINDOW_FRAC; };

// ---- how far a real tine moves (an estimate, from the drive level)
export const DRIVE_W = 0.1e-6, ESR = 50e3, M_TIP = 0.2427;
/** Tip amplitude (m) at drive power P: dissipation P = ω E / Q, E = ½ m_eff ω² x² for two tines, m_eff = 0.2427 of a tine's mass (a cantilever's
 *  first mode, referred to the tip). Rises as √(P·Q). */
export function tipAmplitude(P = DRIVE_W, Q = Q_FORK, f = F_WATCH, wMm = TINE_W, tMm = WAFER_T, LMm = TINE_L): number {
  const w = 2 * Math.PI * f, m = 2 * M_TIP * RHO_QUARTZ * wMm * tMm * LMm * 1e-9, E = (P * Q) / w;
  return Math.sqrt((2 * E) / (m * w * w));
}
/** The motional current at that power through the crystal's ESR (A). */
export const driveCurrent = (P = DRIVE_W, R = ESR): number => Math.sqrt(P / R);

/** AT-cut thickness-shear: f ≈ 1.67 MHz·mm / thickness (CTS; Corning's data book gives 1.66, a US patent about 1.67). The AT-cut view draws one. */
export const AT_N = 1.67e6;
export const atThicknessMm = (f: number): number => AT_N / f;
/** The AT-cut view's crystal: 16 MHz, fundamental. Fundamental AT blanks run from about 0.8 to 40 MHz (Corning); a 200 MHz clock comes from
 *  an overtone crystal or, usually, a PLL multiplying a crystal's frequency, so it inherits the crystal's ppm. */
export const AT_F = 16e6;
/** Blank and electrode diameters (mm): an HC-49-style round blank, ILLUSTRATIVE (no datasheet gives them); SMD parts use small rectangles. */
export const AT_BLANK_MM = 8, AT_ELEC_MM = 5;
/** The AT-cut's temperature curve is a cubic with its inflection near 25 °C, within about ±15 ppm over −40 … 85 °C (Jauch). Drawn here
 *  with turning points 45 °C either side of 25 °C at ±15 ppm: an ILLUSTRATIVE curve, the real one set by the cut angle to arc-seconds. */
export const AT_X0 = 45, AT_SPAN = 15;
export const atPpm = (T: number): number => { const x = T - 25; return (AT_SPAN / (2 * AT_X0 ** 3)) * (x ** 3 - 3 * AT_X0 ** 2 * x); };
/** Drawn thickness (units of 0.1 mm) and layers: the 0.104 mm blank is drawn 6 times thicker, its faces swinging 0.4 mm, so the shear shows. */
export const AT_T_DRAWN = 6, AT_LAYERS = 6, AT_SHEAR = 4;
/** Thickness-shear fundamental: the displacement along x across the thickness is sin(π·s), s from −½ (bottom face) to ½ (top face): the two
 *  faces slide opposite ways, the middle plane stays. */
export const shearAt = (s: number): number => Math.sin(Math.PI * s);

// ---------------------------------------------------------------- the crystal, 1 unit = 0.1 mm

export interface QuartzPalette {
  quartz: RGBA; gold: RGB; ceramic: RGB; pad: RGB; glue: RGB; lid: RGBA; plus: RGB; minus: RGB;
  pcb: RGB; copper: RGB; body: RGB; chip: RGB; led: RGB; ledOff: RGB; metal: RGB;
}
const lit = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

export interface ForkPose { disp: number; lid: boolean; seg?: number }
/** Move parts sideways (x, z): several crystals in one scene. */
export const shifted = (parts: Part[], dx: number, dz: number): Part[] => parts.map((p) => ({ ...p, pos: [p.pos[0] + dx, p.pos[1], p.pos[2] + dz] }));
/** Groove on both main faces of a tine: width and depth as fractions of the tine width and the wafer thickness. Patent US 7 944 131: width
 *  ratio 0.35–1, depth under 0.79 of the thickness; the values here are drawn choices inside those ranges. */
export const GROOVE_W = 0.5, GROOVE_D = 0.3;
/** Tip swing drawn: 1.2 units = 0.12 mm, far larger than a real tine's (tipAmplitude: a few micrometres at 0.1 µW, an estimate). */
export const TIP_DRAWN = 1.2;
const U = 10;
export const fork = {
  w: TINE_W * U, t: WAFER_T * U, gap: TINE_GAP * U, base: BASE_L * U, L: TINE_L * U,
  x0: -11, y0: 2.4,
};
const SEG = 14;

export function crystalParts(p: ForkPose, P: QuartzPalette): Part[] {
  const out: Part[] = [], f = fork, y1 = f.y0 + f.t;
  // The 3.2 × 1.5 × 0.8 mm ceramic package: a floor and four walls, gold pads under the glue.
  out.push(box(P.ceramic, -16, 16, 0, 2, -7.5, 7.5));
  out.push(box(P.ceramic, -16, 16, 2, 8, -7.5, -6), box(P.ceramic, -16, 16, 2, 8, 6, 7.5), box(P.ceramic, -16, -14.5, 2, 8, -6, 6), box(P.ceramic, 14.5, 16, 2, 8, -6, 6));
  out.push(box(P.pad, -14.5, -9.5, 2, 2.3, -4.6, -0.4), box(P.pad, -14.5, -9.5, 2, 2.3, 0.4, 4.6));
  // The sealed package's two end pads on the underside (the board's solder pads), joined to the inner pads through the ceramic.
  out.push(box(P.pad, -16, -11.5, -0.25, 0, -4.5, 4.5), box(P.pad, 11.5, 16, -0.25, 0, -4.5, 4.5));
  // The fork: a base clamped on the pads with conductive glue, two tines.
  const bx0 = f.x0 - f.base, zc = f.gap / 2 + f.w / 2, zo = f.gap / 2 + f.w;
  out.push(box(P.glue, bx0 + 0.5, bx0 + 1.8, 2.3, f.y0, -3.8, -1.2), box(P.glue, bx0 + 0.5, bx0 + 1.8, 2.3, f.y0, 1.2, 3.8));
  out.push({ ...box(P.quartz, bx0, f.x0, f.y0, y1, -zo, zo), spec: 0.5 });
  // The two electrode traces over the base, one to each pad.
  out.push(box(P.gold, bx0 + 0.3, f.x0, y1, y1 + 0.06, -2.9, -1.1), box(P.gold, bx0 + 0.3, f.x0, y1, y1 + 0.06, 1.1, 2.9));
  const v = Math.sign(p.disp) || 0, mag = Math.min(1, Math.abs(p.disp));
  for (const sgn of [1, -1]) { // tine 1 moves with +disp, tine 2 against it: antiphase
    const zc0 = sgn * zc;
    const nseg = p.seg ?? SEG, gw = f.w * GROOVE_W, gd = f.t * GROOVE_D;
    for (let k = 0; k < nseg; k++) {
      const xi0 = k / nseg, xi1 = (k + 1) / nseg, d = sgn * p.disp * TIP_DRAWN * modeShape((xi0 + xi1) / 2);
      const xa = f.x0 + xi0 * f.L, xb = f.x0 + xi1 * f.L + 0.02, za = zc0 - f.w / 2 + d, zb = zc0 + f.w / 2 + d;
      // A grooved tine: two shoulders at full thickness and a thinner floor between them (grooves on both faces).
      const zm = (za + zb) / 2;
      out.push({ ...box(P.quartz, xa, xb, f.y0, y1, za, zm - gw / 2), spec: 0.5 }, { ...box(P.quartz, xa, xb, f.y0, y1, zm + gw / 2, zb), spec: 0.5 });
      out.push({ ...box(P.quartz, xa, xb, f.y0 + gd, y1 - gd, zm - gw / 2, zm + gw / 2), spec: 0.5 });
      if (xi0 >= 0.12 && xi1 <= 0.88) {
        // Gold films: one on the floor of the groove (opposite polarity to the two side films), the voltage tinting them.
        const top = sgn * v >= 0 ? P.plus : P.minus, side = sgn * v >= 0 ? P.minus : P.plus;
        out.push({ ...box(P.gold, xa, xb, y1 - gd, y1 - gd + 0.06, zm - gw * 0.4, zm + gw * 0.4), spec: 0.5, emissive: lit(top, 0.35 * mag) });
        for (const e of [-1, 1]) out.push({ ...box(P.gold, xa, xb, f.y0, y1, zc0 + e * f.w / 2 + d - 0.03, zc0 + e * f.w / 2 + d + 0.03), spec: 0.5, emissive: lit(side, 0.35 * mag) });
      }
    }
  }
  if (p.lid) out.push(box(P.lid, -16, 16, 8, 8.6, -7.5, 7.5, 0.4));
  return out;
}

export function crystalAnchors(p: ForkPose): Anchor[] {
  const f = fork, tipZ = f.gap / 2 + f.w + p.disp * TIP_DRAWN, up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.3, 1];
  return [
    { text: 'tine, bending', p: [f.x0 + f.L * 0.85, f.y0 + f.t, tipZ], side: 'r', n: up },
    { text: 'gold electrode in the groove', p: [f.x0 + f.L * 0.4, f.y0 + f.t - f.t * GROOVE_D + 0.06, -(f.gap / 2 + f.w / 2)], side: 'b', n: up },
    { text: 'underside pads', p: [13.5, -0.25, 0], side: 'r', n: [0, -1, 0], minor: true },
    { text: 'quartz base', p: [f.x0 - f.base * 0.5, f.y0 + f.t, -2.0], side: 't', n: up },
    { text: 'glue and gold pad', p: [-13, 2.3, 3.4], side: 'r', n: up },
    { text: 'ceramic package 3.2 × 1.5 mm', p: [-3, 7, 7.5], side: 't', n: front },
  ];
}

// ---------------------------------------------------------------- the oscillator board, 1 unit = 1 mm

export interface BoardPose { bits: number[]; vib: number; big?: boolean }
/** Block i of the ÷2 chain sits at x = chainX(i): stage 0 on the right, the 1 Hz stage at the left end. */
export const chainX = (i: number): number => 19.6 - i * 2.8;
const CHAIN_Z = 6;

export function boardParts(p: BoardPose, P: QuartzPalette): Part[] {
  const out: Part[] = [], tr = P.copper, y = 0.12;
  out.push(box(P.pcb, -24, 24, -1.2, 0, -17, 11));
  const net = (...pts: [number, number][]) => out.push(...wire(tr, pts.map(([x, z]) => [x, y, z] as Vec3), 0.18));
  // The crystal package (3.2 × 1.5 mm) between nodes IN and OUT; its lid shows a dot of vibration.
  out.push(box(P.ceramic, -1.6, 1.6, 0, 0.8, -7.75, -6.25), { ...box(P.lid, -1.5, 1.5, 0.8, 0.9, -7.6, -6.4, 0.4), emissive: lit(P.plus, 0.3 * Math.min(1, Math.abs(p.vib))) });
  out.push(box(P.pad, -1.9, -1.3, 0, 0.2, -7.6, -6.4), box(P.pad, 1.3, 1.9, 0, 0.2, -7.6, -6.4));
  net([-6, -7], [-1.6, -7]); net([1.6, -7], [6, -7]);
  // The inverter (an unbuffered CMOS inverter, here in the MCU), input = IN, output = OUT.
  out.push(box(P.chip, -3, 3, 0, 1.1, -14, -11));
  net([-3, -12.5], [-6, -12.5], [-6, -7]); net([3, -12.5], [3.6, -12.5]); net([5.4, -12.5], [6, -12.5], [6, -7]);
  // Drive resistor Rd between the inverter output and the crystal: with C2 it limits the drive level (0.1 µW typical) and rolls off the harmonics.
  out.push(box(P.body, 3.8, 5.2, 0, 1, -13, -12), box(P.metal, 3.5, 3.9, 0, 1.05, -13.1, -11.9), box(P.metal, 5.1, 5.5, 0, 1.05, -13.1, -11.9));
  // Feedback resistor Rf, 10 MΩ, across it: biases the inverter in its linear region.
  out.push(cyl(P.body, 0, -3, 0.1, 1.2, 0.55), box(P.metal, -2.6, -2.1, 0, 1.2, -3.5, -2.5), box(P.metal, 2.1, 2.6, 0, 1.2, -3.5, -2.5));
  net([-6, -7], [-6, -3], [-2.6, -3]); net([6, -7], [6, -3], [2.6, -3]);
  // Load capacitors C1, C2 (15 pF each) from the two nodes to ground.
  for (const sx of [-1, 1]) {
    out.push(box(P.body, sx * 10 - 0.8, sx * 10 + 0.8, 0, 1, -5.5, -4.5), box(P.metal, sx * 10 - 0.9, sx * 10 + 0.9, 0, 1.05, -5.6, -5.3), box(P.metal, sx * 10 - 0.9, sx * 10 + 0.9, 0, 1.05, -4.7, -4.4));
    net([sx * 6, -7], [sx * 6, -5], [sx * 10 - 0.9, -5]); net([sx * 10 + 0.9, -5], [sx * 13, -5], [sx * 13, -1]);
    out.push(box(P.copper, sx * 13 - 0.7, sx * 13 + 0.7, 0, 0.2, -1.4, -0.6));
  }
  // The divider: fifteen toggle stages in a row, each clocked by the one before; lit while its output is 1.
  net([6, -12.5], [21, -12.5], [21, CHAIN_Z]);
  for (let i = 0; i < STAGES; i++) {
    const x = chainX(i), on = p.bits[i] === 1, last = i === STAGES - 1;
    out.push(box(P.chip, x - 1.1, x + 1.1, 0, 1, CHAIN_Z - 1.3, CHAIN_Z + 1.3));
    out.push({ ...cyl(on ? P.led : P.ledOff, x, CHAIN_Z, 1, last ? 2.2 : p.big ? 2.2 : 1.6, last ? 1 : p.big ? 0.85 : 0.55, 0.3), emissive: on ? lit(P.led, last ? 0.9 : 0.6) : undefined });
    if (i > 0) net([x + 2.8 - 1.1, CHAIN_Z], [x + 1.1, CHAIN_Z]);
  }
  return out;
}

export function boardAnchors(): Anchor[] {
  const up: Vec3 = [0, 1, 0];
  return [
    { text: 'quartz fork 32 768 Hz', p: [0, 0.9, -7], side: 't', n: up },
    { text: 'inverter', p: [0, 1.1, -12.5], side: 't', n: up, minor: true },
    { text: 'Rd, limits drive level', p: [5.5, 0.5, -12.5], side: 'r', n: up, minor: true },
    { text: 'Rf 10 MΩ', p: [0, 1.2, -3], side: 'b', n: up },
    { text: 'C1 15 pF', p: [-10, 1, -5], side: 'l', n: up, minor: true },
    { text: 'C2 15 pF', p: [10, 1, -5], side: 'r', n: up, minor: true },
    { text: '÷2: 16 384 Hz', p: [chainX(0), 1, CHAIN_Z + 1.3], side: 'b', n: up },
    { text: 'stage 8: 128 Hz', p: [chainX(7), 1, CHAIN_Z + 1.3], side: 'b', n: up, minor: true },
    { text: '1 Hz output', p: [chainX(STAGES - 1), 2, CHAIN_Z + 1.3], side: 'b', n: up },
  ];
}


// ---------------------------------------------------------------- two crystals and the phase ring, 1 unit = 0.1 mm

export interface DriftPose { disp: number; dispB: number; slip: number }
export const DRIFT_R = 12, DRIFT_C: [number, number] = [0, 11], DRIFT_AX = -19, DRIFT_BX = 19, DRIFT_Z = -13;
const onRing = (r: number, turn: number): [number, number] => [DRIFT_C[0] + r * Math.sin(2 * Math.PI * turn), DRIFT_C[1] - r * Math.cos(2 * Math.PI * turn)];

/** A and B side by side and one ring: A's dot stands at the top (its edge), B's walks round by the phase B has gained on A. The window
 *  either side of the top is where B's edge would land inside A's setup + hold. */
export function driftParts(p: DriftPose, P: QuartzPalette): Part[] {
  const out: Part[] = [], hit = inWindow(p.slip);
  out.push(...shifted(crystalParts({ disp: p.disp, lid: false, seg: 6 }, P), DRIFT_AX, DRIFT_Z), ...shifted(crystalParts({ disp: p.dispB, lid: false, seg: 6 }, P), DRIFT_BX, DRIFT_Z));
  out.push(cyl(P.pcb, DRIFT_C[0], DRIFT_C[1], 0, 0.4, DRIFT_R + 1.4));
  for (let k = 0; k < 12; k++) { const [x, z] = onRing(DRIFT_R + 0.4, k / 12); out.push(cyl(P.copper, x, z, 0.4, 0.7, 0.28)); }
  const lim = (t: number): Part => { const a = onRing(DRIFT_R - 3.2, t), b = onRing(DRIFT_R + 1, t); return rod(P.minus, [a[0], 0.6, a[1]], [b[0], 0.6, b[1]], 0.2); };
  out.push(lim(-WINDOW_FRAC), lim(WINDOW_FRAC));
  const [ax, az] = onRing(DRIFT_R - 1.6, 0), [bx, bz] = onRing(DRIFT_R - 1.6, p.slip);
  out.push({ ...cyl(P.plus, ax, az, 0.4, 1.8, 1.3), emissive: lit(P.plus, 0.5) });
  out.push({ ...cyl(P.minus, bx, bz, 0.4, 2.4, 1.0), emissive: lit(P.minus, hit ? 1 : 0.4) });
  out.push(rod(P.minus, [DRIFT_C[0], 0.6, DRIFT_C[1]], [bx, 0.6, bz], 0.12));
  return out;
}

export function driftAnchors(slip: number, narrow = false): Anchor[] {
  const up: Vec3 = [0, 1, 0], [ax, az] = onRing(DRIFT_R - 1.6, 0), [bx, bz] = onRing(DRIFT_R - 1.6, slip), [wx, wz] = onRing(DRIFT_R + 1, WINDOW_FRAC);
  return [
    { text: 'crystal A: the receiver', p: [DRIFT_AX, 8, DRIFT_Z + 7.5], side: 'l', n: [0, 0.3, 1], minor: narrow },
    { text: 'crystal B: the sender', p: [DRIFT_BX, 8, DRIFT_Z + 7.5], side: 'r', n: [0, 0.3, 1], minor: narrow },
    { text: "A's edge", p: [ax, 1.8, az], side: 'l', n: up },
    { text: "B's edge", p: [bx, 2.4, bz], side: 'b', n: up },
    { text: 'setup + hold window (drawn wide)', p: [wx, 0.8, wz], side: 'r', n: up, minor: true },
  ];
}

// ---------------------------------------------------------------- the AT-cut blank, 1 unit = 0.1 mm

export interface AtPose { disp: number }
/** The AT-cut blank lying flat: layers sliding in thickness shear, a gold electrode on each face, two spring clips on leads into the base. */
export function atParts(p: AtPose, P: QuartzPalette): Part[] {
  const out: Part[] = [], R = (AT_BLANK_MM * 10) / 2, RE = (AT_ELEC_MM * 10) / 2, h = AT_T_DRAWN / AT_LAYERS, top = AT_T_DRAWN;
  const dx = (s: number) => p.disp * AT_SHEAR * shearAt(s);
  for (let i = 0; i < AT_LAYERS; i++) out.push({ ...cyl(P.quartz, dx((i + 0.5) / AT_LAYERS - 0.5), 0, i * h, (i + 1) * h, R), spec: 0.5 });
  // the electrodes ride on their faces: the top one slides +x while the bottom one slides −x
  out.push(cyl(P.gold, dx(0.5), 0, top, top + 0.15, RE, 0.6), cyl(P.gold, dx(-0.5), 0, -0.15, 0, RE, 0.6));
  // a tab from each electrode to the rim, where a clip holds the blank: the top one to +x, the bottom one to −x
  out.push(box(P.gold, RE - 1 + dx(0.5), R + dx(0.5), top, top + 0.15, -2, 2), box(P.gold, -R + dx(-0.5), -RE + 1 + dx(-0.5), -0.15, 0, -2, 2));
  for (const s of [1, -1]) {
    out.push(box(P.metal, s * R - 1.5, s * R + 1.5, -2, top + 2, -2.5, 2.5, 0.6));
    out.push(rod(P.metal, [s * (R + 1), -2, 0], [s * (R + 1), -30, 0], 0.6, 0.6));
  }
  out.push(box(P.ceramic, -R - 8, R + 8, -33, -30, -8, 8));
  return out;
}
export function atAnchors(): Anchor[] {
  const R = (AT_BLANK_MM * 10) / 2, RE = (AT_ELEC_MM * 10) / 2, up: Vec3 = [0, 1, 0], top = AT_T_DRAWN;
  return [
    { text: 'quartz blank, AT-cut', p: [-R * 0.62, top, R * 0.55], side: 'l', n: up },
    { text: 'gold electrode, both faces', p: [RE * 0.3, top + 0.15, -RE * 0.75], side: 't', n: up },
    { text: 'faces shear opposite ways', p: [R * 0.5, top / 2, R * 0.866], side: 'b', n: [0.5, 0, 0.866], minor: true },
    { text: 'spring clip on a lead', p: [-R, top + 2, 0], side: 'l', n: [-1, 0, 0], minor: true },
  ];
}
