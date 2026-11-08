// The 32 768 Hz watch crystal and the oscillator around it, as parts (DOM-free, tested).
//
// The crystal is a TUNING FORK cut from a quartz wafer, vibrating in a flexural mode: the two tines bend in antiphase, like
// the fork of a musician. (A thickness-shear blank between two electrodes is an AT-cut crystal, MHz, f ∝ 1/thickness: see
// atThicknessMm; it is not what is in a watch.) Sources: Epson FC-135 (3.2 × 1.5 × 0.8 mm SMD package); tine width < 0.18 mm,
// wafer 0.05–0.15 mm and a total length of 1.2–2.2 mm in the tuning-fork patents US 7 944 131 / 8 572 824; turnover 25 °C and
// parabolic coefficient −0.034 ppm/°C² in CTS / Qantek / Taitien 32.768 kHz fork datasheets; Q 3×10⁴–9×10⁴ (Taitien, Qantek,
// ECS); the Pierce numbers from IQD/Statek Technical Note 31 (fs = 32.7644 kHz, C1 = 2.3 fF, C0 = 1.5 pF, CL = 9.0 pF).
//
// Two scales: the crystal view is 1 unit = 0.1 mm (the package is 32 × 15 × 8 units), the board view 1 unit = 1 mm.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, wire, type Anchor, type Part } from '../gl/parts';

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
export const freqAt = (T: number, f = F_WATCH): number => f * (1 + tempPpm(T) * 1e-6);
/** A clock running ppm off gains / loses this many seconds a day. */
export const secPerDay = (ppm: number): number => ppm * 1e-6 * 86400;

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

/** AT-cut thickness-shear: f ≈ 1.67 MHz·mm / thickness (CTS). The other kind of crystal; not drawn. */
export const atThicknessMm = (f: number): number => 1.67e6 / f;

// ---------------------------------------------------------------- the crystal, 1 unit = 0.1 mm

export interface QuartzPalette {
  quartz: RGBA; gold: RGB; ceramic: RGB; pad: RGB; glue: RGB; lid: RGBA; plus: RGB; minus: RGB;
  pcb: RGB; copper: RGB; body: RGB; chip: RGB; led: RGB; ledOff: RGB; metal: RGB;
}
const lit = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

export interface ForkPose { disp: number; lid: boolean }
/** Tip swing drawn: 1.2 units = 0.12 mm, far larger than a real tine's (below a micrometre, an estimate). */
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
  // The fork: a base clamped on the pads with conductive glue, two tines.
  const bx0 = f.x0 - f.base, zc = f.gap / 2 + f.w / 2, zo = f.gap / 2 + f.w;
  out.push(box(P.glue, bx0 + 0.5, bx0 + 1.8, 2.3, f.y0, -3.8, -1.2), box(P.glue, bx0 + 0.5, bx0 + 1.8, 2.3, f.y0, 1.2, 3.8));
  out.push({ ...box(P.quartz, bx0, f.x0, f.y0, y1, -zo, zo), spec: 0.5 });
  // The two electrode traces over the base, one to each pad.
  out.push(box(P.gold, bx0 + 0.3, f.x0, y1, y1 + 0.06, -2.9, -1.1), box(P.gold, bx0 + 0.3, f.x0, y1, y1 + 0.06, 1.1, 2.9));
  const v = Math.sign(p.disp) || 0, mag = Math.min(1, Math.abs(p.disp));
  for (const sgn of [1, -1]) { // tine 1 moves with +disp, tine 2 against it: antiphase
    const zc0 = sgn * zc;
    for (let k = 0; k < SEG; k++) {
      const xi0 = k / SEG, xi1 = (k + 1) / SEG, d = sgn * p.disp * TIP_DRAWN * modeShape((xi0 + xi1) / 2);
      const xa = f.x0 + xi0 * f.L, xb = f.x0 + xi1 * f.L + 0.02, za = zc0 - f.w / 2 + d, zb = zc0 + f.w / 2 + d;
      out.push({ ...box(P.quartz, xa, xb, f.y0, y1, za, zb), spec: 0.5 });
      if (xi0 >= 0.12 && xi1 <= 0.88) {
        // Gold films: one along the top of the tine (opposite polarity to the two side films), the voltage tinting them.
        const top = sgn * v >= 0 ? P.plus : P.minus, side = sgn * v >= 0 ? P.minus : P.plus;
        out.push({ ...box(P.gold, xa, xb, y1, y1 + 0.06, zc0 - 0.2 + d, zc0 + 0.2 + d), spec: 0.5, emissive: lit(top, 0.35 * mag) });
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
    { text: 'gold electrode', p: [f.x0 + f.L * 0.4, f.y0 + f.t + 0.06, -(f.gap / 2 + f.w / 2)], side: 'b', n: up },
    { text: 'quartz base', p: [f.x0 - f.base * 0.5, f.y0 + f.t, -2.0], side: 't', n: up },
    { text: 'glue and gold pad', p: [-13, 2.3, 3.4], side: 'r', n: up },
    { text: 'ceramic package 3.2 × 1.5 mm', p: [-3, 7, 7.5], side: 't', n: front },
  ];
}

// ---------------------------------------------------------------- the oscillator board, 1 unit = 1 mm

export interface BoardPose { bits: number[]; vib: number }
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
  net([-3, -12.5], [-6, -12.5], [-6, -7]); net([3, -12.5], [6, -12.5], [6, -7]);
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
    out.push({ ...cyl(on ? P.led : P.ledOff, x, CHAIN_Z, 1, last ? 2 : 1.6, last ? 0.9 : 0.55, 0.3), emissive: on ? lit(P.led, last ? 0.9 : 0.6) : undefined });
    if (i > 0) net([x + 2.8 - 1.1, CHAIN_Z], [x + 1.1, CHAIN_Z]);
  }
  return out;
}

export function boardAnchors(): Anchor[] {
  const up: Vec3 = [0, 1, 0];
  return [
    { text: 'quartz fork 32 768 Hz', p: [0, 0.9, -7], side: 't', n: up },
    { text: 'inverter', p: [0, 1.1, -12.5], side: 't', n: up, minor: true },
    { text: 'Rf 10 MΩ', p: [0, 1.2, -3], side: 'b', n: up },
    { text: 'C1 15 pF', p: [-10, 1, -5], side: 'l', n: up, minor: true },
    { text: 'C2 15 pF', p: [10, 1, -5], side: 'r', n: up, minor: true },
    { text: '÷2: 16 384 Hz', p: [chainX(0), 1, CHAIN_Z + 1.3], side: 'b', n: up },
    { text: 'stage 8: 128 Hz', p: [chainX(7), 1, CHAIN_Z + 1.3], side: 'b', n: up, minor: true },
    { text: '1 Hz output', p: [chainX(STAGES - 1), 2, CHAIN_Z + 1.3], side: 'b', n: up },
  ];
}

