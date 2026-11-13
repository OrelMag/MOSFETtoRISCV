// The 32 768 Hz watch crystal and the oscillator around it: the numbers and the poses (DOM-free, tested; drawn by quartz3dkit.ts).
//
// The crystal is a TUNING FORK cut from a quartz wafer, vibrating in a flexural mode: the two tines bend in antiphase, like
// the fork of a musician. (A thickness-shear blank between two electrodes is an AT-cut crystal, MHz, f ∝ 1/thickness: see
// atThicknessMm; it is not what is in a watch.) Sources: Epson FC-135 (3.2 × 1.5 × 0.8 mm SMD package); tine width < 0.18 mm,
// wafer 0.05–0.15 mm and a total length of 1.2–2.2 mm in the tuning-fork patents US 7 944 131 / 8 572 824; turnover 25 °C and
// parabolic coefficient −0.034 ppm/°C² in CTS / Qantek / Taitien 32.768 kHz fork datasheets; Q 3×10⁴–9×10⁴ (Taitien, Qantek,
// ECS; 50 000 is the minimum in Epson's ECX-306X listing, 60 000 typical in Raltron's, 30 000–60 000 in Taitien's); the Pierce numbers from IQD/Statek Technical Note 31 (fs = 32.7644 kHz, C1 = 2.3 fF, C0 = 1.5 pF, CL = 9.0 pF).
//
// Two scales: the crystal view is 1 unit = 0.1 mm (the package is 32 × 15 × 8 units), the board view 1 unit = 1 mm.

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

export interface ForkPose { disp: number; lid: boolean; seg?: number }
/** Groove on both main faces of a tine: width and depth as fractions of the tine width and the wafer thickness. Patent US 7 944 131: width
 *  ratio 0.35–1, depth under 0.79 of the thickness; the values here are drawn choices inside those ranges. */
export const GROOVE_W = 0.5, GROOVE_D = 0.3;
/** Tip swing drawn: 1.2 units = 0.12 mm, far larger than a real tine's (tipAmplitude: a few micrometres at 0.1 µW, an estimate). */
export const TIP_DRAWN = 1.2;
const U = 10;
export const fork = {
  w: TINE_W * U, t: WAFER_T * U, gap: TINE_GAP * U, base: BASE_L * U, L: TINE_L * U,
  x0: -9, y0: 2.4,
};
export const SEG = 14;

// ---------------------------------------------------------------- the oscillator board, 1 unit = 1 mm

export interface BoardPose { bits: number[]; vib: number; big?: boolean }
/** Block i of the ÷2 chain sits at x = chainX(i): stage 0 on the right, the 1 Hz stage at the left end. */
export const chainX = (i: number): number => 19.6 - i * 2.8;
export const CHAIN_Z = 6;

// ---------------------------------------------------------------- two crystals and the phase ring, 1 unit = 0.1 mm

export interface DriftPose { disp: number; dispB: number; slip: number }
export const DRIFT_R = 12, DRIFT_C: [number, number] = [0, 11], DRIFT_AX = -19, DRIFT_BX = 19, DRIFT_Z = -13;
export const onRing = (r: number, turn: number): [number, number] => [DRIFT_C[0] + r * Math.sin(2 * Math.PI * turn), DRIFT_C[1] - r * Math.cos(2 * Math.PI * turn)];

/** A and B side by side and one ring: A's dot stands at the top (its edge), B's walks round by the phase B has gained on A. The window
 *  either side of the top is where B's edge would land inside A's setup + hold. */

// ---------------------------------------------------------------- the AT-cut blank, 1 unit = 0.1 mm

export interface AtPose { disp: number }
/** The AT-cut blank lying flat: layers sliding in thickness shear, a gold electrode on each face, two spring clips on leads into the base. */
