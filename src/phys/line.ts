// The Communication track's analog model (DOM-free): what happens between a driver's drain and a receiver's gate, in the
// spirit of relay.ts and triode.ts. The gate simulator carries 0 / 1 / X; this file holds the voltages between the 1s and
// 0s: an on-chip RC wire, a lossless transmission line (the lattice solution, exact), crosstalk, ground bounce, a
// differential pair, and a single-pole channel with inter-symbol interference, noise, Q and BER. Everything is a closed
// form or an exact lattice / ladder sum, checked in tests/phys-line.test.ts; the constants are labelled below.
// Units: ohms, fF, ps, ns, mm, volts, unless a name says otherwise.

import { current, discharge, VDD, VT } from '../widgets/mosphys';

// ---------------------------------------------------------------------------------------------------------------------
// Levels and constants

/** The I/O supply (V): the chapter-1 device's VDD, i.e. thick-oxide pad devices on a 1.8 V rail. */
export const VIO = VDD;
/** LVCMOS18 input thresholds (JESD8-7): a 1 is above 0.65 VDDIO, a 0 below 0.35 VDDIO. */
export const VIH = 0.65 * VIO;
export const VIL = 0.35 * VIO;
/** The usual board impedance (Ω). */
export const Z0_BOARD = 50;
/** One-way delay of a microstrip on FR-4 (ps / mm), about 15 cm / ns: the signal travels at c / 2. */
export const PCB_PS_PER_MM = 6.67;
/** An electrically long line: one-way delay above a sixth of the rise time (the usual rule of thumb), so the line is not a node. */
export const LUMPED_RATIO = 6;

/** Wire resistance per mm of mid-level metal (Ω / mm): 28 nm-class, labelled illustrative (1 Ω / µm). */
export const WIRE_R_PER_MM = 1000;
/** Wire capacitance per mm (fF / mm): 0.2 fF / µm, in line with sim/netcap.ts's FF_WIRE = 0.3 fF for a short local branch (1.5 µm). */
export const WIRE_C_PER_MM = 200;
/** A unit inverter's input capacitance (fF): the gates of an NMOS and a PMOS, 2 × widgets/mosphys.ts's C_GATE (its loadOf). */
export const C_UNIT_IN = 2;
/** A unit inverter's own drain capacitance (fF): p = 1 τ, i.e. as much as one input (phys/sizing.ts's P_INV). */
export const C_UNIT_OWN = 2;
/** The 50 % delay of an RC step is ln 2 · RC; of a distributed RC line it is 0.38 · RC (Elmore's 0.5 corrected for the shape). */
export const K_LUMPED = Math.LN2;
export const K_DIST = 0.38;

// ---------------------------------------------------------------------------------------------------------------------
// A driver: the chapter-1 square-law device, the chapter-2 inverter

/**
 * Effective resistance (Ω) of an inverter's output stage of width `w` (unit transistors in parallel; the PMOS is sized to
 * match): the resistance that gives the same 50 % delay into a capacitor as the real, saturating discharge. Time scales
 * with C, so it does not depend on the load: t50 = ln 2 · R · C.
 */
export function rEff(w: number): number {
  const C = 100 * w, d = discharge(w, C, 20000, 5);
  return (1000 * d.t50) / (Math.LN2 * C);
}

/** Small-signal on-resistance (Ω) at Vds → 0 with the gate at VDD: 1 / (w · K · (VDD − VT)). */
export const rOn = (w: number): number => 1e6 / (w * (current(VDD - VT, 1e-6).id / 1e-6));

/** Saturated drive current (µA) of width `w` at Vgs = VDD, Vds = VDD. */
export const iSat = (w: number): number => w * current(VDD - VT, VDD).id;

/** A driver of resistance `r` charging `c` fF to 50 %: ln 2 · R · C (ps). */
export const rcDelay50 = (r: number, c: number): number => (K_LUMPED * r * c) / 1000;

/** An exponential charge of `c` fF through `r` Ω towards `v`, sampled every `every` ps up to `tMax` (the lumped picture). */
export function rcStep(r: number, c: number, v: number, tMax: number, every: number): { t: number[]; v: number[] } {
  const t: number[] = [], out: number[] = [], tau = (r * c) / 1000;
  for (let x = 0; x <= tMax + 1e-9; x += every) { t.push(x); out.push(v * (1 - Math.exp(-x / tau))); }
  return { t, v: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// The lossless line (lattice): exact for a step or a linear ramp into a line between a source resistance and a load

/** Reflection coefficient at a termination `r` seen from a line of impedance `z0` (r = Infinity: open, +1; 0: short, −1). */
export const gamma = (r: number, z0: number): number => (Number.isFinite(r) ? (r - z0) / (r + z0) : 1);

export interface LineSpec {
  /** Source swing (V): a step from 0 to v. */
  v: number;
  /** Source resistance (Ω). */
  rs: number;
  z0: number;
  /** One-way delay (ns). */
  delay: number;
  /** Load resistance to ground at the far end (Ω); Infinity: open (a CMOS input). */
  rl: number;
  /** Rise time of the source (ns), 0 to 100 %; 0 is a step. */
  rise: number;
}

export interface Lattice {
  spec: LineSpec;
  /** Wave launched at the near end: v · z0 / (z0 + rs). */
  launch: number;
  gammaS: number;
  gammaL: number;
  /** The DC value both ends settle to: v · rl / (rl + rs). */
  final: number;
  /** Voltage at the near end (x = 0) and the far end (x = 1) at time t (ns). */
  near(t: number): number;
  far(t: number): number;
  /** Voltage at position x (0 near … 1 far) and time t (ns). */
  at(x: number, t: number): number;
  /** The first wave reaching the far end: launch · (1 + Γ_L). */
  firstFar: number;
  /** Forward waves A_k (leaving the source at 2k·delay) and backward waves B_k (leaving the load at (2k+1)·delay). */
  forward: number[];
  backward: number[];
}

const EPS = 1e-6;

export function lattice(spec: LineSpec): Lattice {
  const { v, rs, z0, delay: td, rl, rise } = spec;
  const gS = gamma(rs, z0), gL = gamma(rl, z0), launch = (v * z0) / (z0 + rs);
  const ramp = (t: number) => (t <= 0 ? 0 : rise <= 0 || t >= rise ? 1 : t / rise);
  const A: number[] = [], B: number[] = [];
  let a = launch;
  for (let k = 0; k < 400 && Math.abs(a) > EPS; k++) { A.push(a); B.push(a * gL); a = a * gL * gS; }
  const at = (x: number, t: number) => {
    let s = 0;
    for (let k = 0; k < A.length; k++) s += A[k] * ramp(t - (2 * k + x) * td) + B[k] * ramp(t - (2 * k + 2 - x) * td);
    return s;
  };
  const final = Number.isFinite(rl) ? (v * rl) / (rl + rs) : v;
  return { spec, launch, gammaS: gS, gammaL: gL, final, near: (t) => at(0, t), far: (t) => at(1, t), at, firstFar: launch * (1 + gL), forward: A, backward: B };
}

export interface LineStats {
  peak: number;
  trough: number;
  /** Overshoot above the final value (V, ≥ 0) and undershoot below it after the first crossing of it. */
  overshoot: number;
  /** Last time (ns) the far end is outside ±tol of its final value; 0 if it never leaves. */
  settle: number;
  /** First time (ns) the far end is at or above `vih`; null if never. */
  firstHigh: number | null;
  /** How many times the far end falls back below `vih` after first reaching it. */
  fallBacks: number;
  /** The same for a falling reference: lowest dip below vil after the first rise (a glitch on the way up). */
  dipsBelowVil: number;
}

/** Sample the far end over [0, tMax] ns and report peak, settling, and threshold crossings. */
export function farStats(l: Lattice, tMax: number, vih = VIH, vil = VIL, tol = 0.05, n = 4000): LineStats {
  let peak = -Infinity, trough = Infinity, settle = 0, firstHigh: number | null = null, falls = 0, dips = 0, was = false;
  for (let i = 0; i <= n; i++) {
    const t = (i * tMax) / n, x = l.far(t);
    peak = Math.max(peak, x);
    trough = Math.min(trough, x);
    if (Math.abs(x - l.final) > tol * l.spec.v) settle = t;
    const hi = x >= vih;
    if (hi && firstHigh === null) firstHigh = t;
    if (was && !hi) falls++;
    if (firstHigh !== null && x < vil) dips++;
    was = hi;
  }
  return { peak, trough, overshoot: Math.max(0, peak - l.final), settle, firstHigh, fallBacks: falls, dipsBelowVil: dips };
}

/** Near and far voltage, sampled: for plotting. */
export function sampleLine(l: Lattice, tMax: number, n = 600): { t: number[]; near: number[]; far: number[] } {
  const t: number[] = [], near: number[] = [], far: number[] = [];
  for (let i = 0; i <= n; i++) { const x = (i * tMax) / n; t.push(x); near.push(l.near(x)); far.push(l.far(x)); }
  return { t, near, far };
}

/** One-way delay (ns) of `mm` of board trace. */
export const boardDelay = (mm: number): number => (mm * PCB_PS_PER_MM) / 1000;

/** The line's per-unit-length inductance (nH / m) and capacitance (pF / m) from its impedance and delay per mm (telegrapher's L' and C'). */
export function lcOf(z0: number, psPerMm = PCB_PS_PER_MM): { l: number; c: number } {
  const td = psPerMm * 1e-9; // s per m
  return { l: z0 * td * 1e9, c: (td / z0) * 1e12 };
}

/** Z0 = √(L' / C') and the delay per mm (ps) = √(L' C'), from L' in nH / m and C' in pF / m. */
export function z0Of(lPerM: number, cPerM: number): { z0: number; psPerMm: number } {
  return { z0: Math.sqrt((lPerM * 1e-9) / (cPerM * 1e-12)), psPerMm: Math.sqrt(lPerM * 1e-9 * cPerM * 1e-12) * 1e9 };
}

/** Longest trace (mm) that still counts as a node for an edge of `riseNs`: delay = rise / LUMPED_RATIO. */
export const criticalLength = (riseNs: number, psPerMm = PCB_PS_PER_MM): number => (riseNs * 1000) / (LUMPED_RATIO * psPerMm);

/** Is a trace of `delayNs` one-way delay a lumped node for this rise time? */
export const isLumped = (delayNs: number, riseNs: number): boolean => delayNs * LUMPED_RATIO <= riseNs;

/** Series termination: the resistor to add to a driver of resistance `rDriver` so the sum equals z0 (≥ 0). */
export const seriesResistor = (rDriver: number, z0: number): number => Math.max(0, z0 - rDriver);

/** The static power (W) a parallel termination of `rt` Ω to ground burns while the line is held high, through a driver of `rs`. */
export const parallelPower = (v: number, rs: number, rt: number): number => (v * v * rt) / ((rs + rt) * (rs + rt));

/** The smallest source resistance (Ω, step 1) at which the far end of an open line, once above `vih`, never falls back below it. */
export function minRsStaysHigh(v: number, z0: number, delay: number, rise: number, vih = VIH): number | null {
  for (let rs = 1; rs <= 200; rs++) {
    const l = lattice({ v, rs, z0, delay, rl: Infinity, rise });
    const st = farStats(l, 40 * delay + 4 * rise + 1, vih);
    if (st.firstHigh !== null && st.fallBacks === 0) return rs;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// An on-chip wire: driver, distributed RC, load; repeaters

export interface WireSpec {
  /** Driver resistance (Ω): rEff of its width. */
  rd: number;
  /** Wire length (mm). */
  len: number;
  /** Load capacitance at the far end (fF). */
  cl: number;
  r?: number;
  c?: number;
}

/** Total wire resistance (Ω) and capacitance (fF). */
export const wireR = (w: WireSpec): number => (w.r ?? WIRE_R_PER_MM) * w.len;
export const wireC = (w: WireSpec): number => (w.c ?? WIRE_C_PER_MM) * w.len;

/** The three terms of the 50 % delay (ps): ln 2 · Rd · (Cw + Cl), 0.38 · Rw · Cw, ln 2 · Rw · Cl. */
export function wireDelayTerms(w: WireSpec): { driver: number; wire: number; load: number; total: number } {
  const R = wireR(w), C = wireC(w);
  const driver = (K_LUMPED * w.rd * (C + w.cl)) / 1000, wire = (K_DIST * R * C) / 1000, load = (K_LUMPED * R * w.cl) / 1000;
  return { driver, wire, load, total: driver + wire + load };
}

/** The 50 % delay (ps) of the driver, the distributed wire and the load. Quadratic in length once the wire's own term dominates. */
export const wireDelay = (w: WireSpec): number => wireDelayTerms(w).total;

/** The Elmore delay (ps) of the same circuit: Rd (Cw + Cl) + Rw (Cw / 2 + Cl). It is the mean of the response, 1.44× the 50 % point for a lone RC. */
export function elmoreDelay(w: WireSpec): number {
  const R = wireR(w), C = wireC(w);
  return (w.rd * (C + w.cl) + R * (C / 2 + w.cl)) / 1000;
}

/** Length (mm) at which the wire's own delay equals the driver's: 0.38 Rw Cw = ln 2 Rd Cw → Rw = 1.82 Rd. */
export const wireDominates = (rd: number, r = WIRE_R_PER_MM): number => (K_LUMPED * rd) / (K_DIST * r);

/**
 * A numerical reference: the RC line as `n` sections (backward Euler, Thomas solver), a step at the driver, the far end
 * sampled every `every` ps to `tMax`. Returns the far-end voltage and its 50 % time (ps), for a step of 1.
 */
export function wireLadder(w: WireSpec, tMax: number, every = 1, n = 40): { t: number[]; far: number[]; near: number[]; t50: number } {
  const R = wireR(w) / n, C = wireC(w) / n;
  const nodes = n + 1; // node 0 is the driver's output
  const cap = (i: number) => (i === 0 ? C / 2 : i === n ? C / 2 + w.cl : C) / 1e15; // F
  const g = 1 / R, gd = 1 / w.rd; // S
  const dt = Math.min(every, ((w.rd + wireR(w)) * (wireC(w) + w.cl)) / 1e3 / 400) * 1e-12;
  let v = new Float64Array(nodes);
  const t: number[] = [], far: number[] = [], near: number[] = [];
  let t50 = Infinity, next = 0;
  const steps = Math.ceil((tMax * 1e-12) / dt);
  const sa = new Float64Array(nodes), sb = new Float64Array(nodes), sc = new Float64Array(nodes), sd = new Float64Array(nodes);
  for (let s = 0; s <= steps; s++) {
    const now = s * dt * 1e12;
    if (now >= next - 1e-9) { t.push(now); far.push(v[n]); near.push(v[0]); next += every; }
    if (t50 === Infinity && v[n] >= 0.5) t50 = now;
    // (C/dt + G) v' = C/dt v + source
    for (let i = 0; i < nodes; i++) {
      const left = i > 0 ? g : 0, right = i < n ? g : 0, drv = i === 0 ? gd : 0;
      sb[i] = cap(i) / dt + left + right + drv;
      sa[i] = i > 0 ? -g : 0;
      sc[i] = i < n ? -g : 0;
      sd[i] = (cap(i) / dt) * v[i] + drv * 1;
    }
    for (let i = 1; i < nodes; i++) { const m = sa[i] / sb[i - 1]; sb[i] -= m * sc[i - 1]; sd[i] -= m * sd[i - 1]; }
    const nv = new Float64Array(nodes);
    nv[n] = sd[n] / sb[n];
    for (let i = n - 1; i >= 0; i--) nv[i] = (sd[i] - sc[i] * nv[i + 1]) / sb[i];
    v = nv;
  }
  return { t, far, near, t50 };
}

export interface RepeaterPlan {
  /** Segments (= drivers, the first being the original). */
  k: number;
  /** Driver width (unit inverters). */
  h: number;
  /** 50 % delay (ps) of the whole wire. */
  delay: number;
  /** Total repeater width (unit inverters), the area cost. */
  area: number;
  /** Switched capacitance per transition (fF): wire + every repeater's input and own drain. */
  switched: number;
  /** Per stage electrical effort: the load a repeater drives over its own input. */
  stageEffort: number;
}

let rEffUnit = NaN;
/** The unit inverter's drive resistance (Ω), computed once. */
export const unitR = (): number => (Number.isNaN(rEffUnit) ? (rEffUnit = rEff(1)) : rEffUnit);

/** Delay (ps) of a wire of `len` mm cut into `k` segments by repeaters of width `h`, the load `cl` fF at the end. */
export function repeatedDelay(len: number, k: number, h: number, cl = 0, r = WIRE_R_PER_MM, c = WIRE_C_PER_MM): number {
  const seg: WireSpec = { rd: unitR() / h, len: len / k, cl: h * C_UNIT_IN, r, c };
  // each driver's own drain adds to the node it drives
  const own = (K_LUMPED * (unitR() / h) * h * C_UNIT_OWN) / 1000;
  const last = (K_LUMPED * (unitR() / h) * cl) / 1000 + (K_LUMPED * r * (len / k) * cl) / 1000;
  return k * (wireDelay(seg) + own) + last;
}

/** The continuous optimum (Bakoglu with this file's 0.69 / 0.38 coefficients): segments k, driver width h, total delay (ps) per mm. */
export function repeaterOptimum(r = WIRE_R_PER_MM, c = WIRE_C_PER_MM): { kPerMm: number; h: number; psPerMm: number; segMm: number } {
  const R = unitR(), rc = (r * c) / 1e15; // Ω · F per mm²
  const h = Math.sqrt((R * c * 1e-15) / (r * C_UNIT_IN * 1e-15));
  const kPerMm = Math.sqrt((K_DIST * rc) / (K_LUMPED * R * (C_UNIT_IN + C_UNIT_OWN) * 1e-15));
  const psPerMm = 1e12 * (2 * K_LUMPED * Math.sqrt(R * C_UNIT_IN * 1e-15 * rc) + 2 * Math.sqrt(K_LUMPED * K_DIST * R * (C_UNIT_IN + C_UNIT_OWN) * 1e-15 * rc));
  return { kPerMm, h, psPerMm, segMm: 1 / kPerMm };
}

/** The best integer number of segments (1 … kMax) for a wire of `len` mm, at the driver width that suits it. */
export function bestRepeaters(len: number, kMax = 256, r = WIRE_R_PER_MM, c = WIRE_C_PER_MM): RepeaterPlan {
  const h = repeaterOptimum(r, c).h;
  let best = 1, bd = Infinity;
  for (let k = 1; k <= kMax; k++) { const d = repeatedDelay(len, k, h, 0, r, c); if (d < bd) { bd = d; best = k; } }
  return plan(len, best, h, r, c);
}

export function plan(len: number, k: number, h: number, r = WIRE_R_PER_MM, c = WIRE_C_PER_MM): RepeaterPlan {
  const cw = c * len;
  return {
    k, h, delay: repeatedDelay(len, k, h, 0, r, c), area: k * h,
    switched: cw + k * h * (C_UNIT_IN + C_UNIT_OWN),
    stageEffort: (cw / k + h * C_UNIT_IN) / (h * C_UNIT_IN),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Crosstalk, ground bounce

/** Coupling coefficients of two adjacent microstrips spaced s apart at height h above the plane: a rule of thumb, not a field solution. */
export function coupling(sOverH: number): { kl: number; kc: number } {
  const kl = 0.5 / (1 + sOverH * sOverH);
  return { kl, kc: 0.4 * kl };
}

export interface XtalkSpec {
  /** Aggressor swing (V) and rise time (ns). */
  v: number;
  rise: number;
  /** One-way delay of the coupled run (ns). */
  delay: number;
  /** Mutual over self: kc = Cm / C, kl = Lm / L. */
  kc: number;
  kl: number;
}

export interface Xtalk {
  /** Backward (near-end) coefficient Kb = ¼ (kc + kl) and its saturated amplitude Kb · v (V). */
  kb: number;
  /** Near-end amplitude (V): Kb · v once the run is longer than half the edge (2 · delay ≥ rise), else scaled by 2 · delay / rise. */
  next: number;
  /** Near-end pulse width (ns): 2 · delay (+ the edge). */
  nextWidth: number;
  /** Forward coefficient Kf = ½ (kc − kl), amplitude (V) = Kf · (delay / rise) · v: zero in a homogeneous medium (stripline), negative on a microstrip. */
  kf: number;
  fext: number;
  /** Crosstalk at time t (ns) at the victim's near and far ends. */
  nearAt(t: number): number;
  farAt(t: number): number;
}

export function crosstalk(s: XtalkSpec): Xtalk {
  const kb = 0.25 * (s.kc + s.kl), kf = 0.5 * (s.kc - s.kl), ramp = (t: number) => (t <= 0 ? 0 : s.rise <= 0 || t >= s.rise ? 1 : t / s.rise);
  const next = kb * s.v * Math.min(1, (2 * s.delay) / Math.max(s.rise, 1e-9));
  const fext = kf * (s.delay / Math.max(s.rise, 1e-9)) * s.v;
  return {
    kb, next, nextWidth: 2 * s.delay + s.rise, kf, fext,
    nearAt: (t) => kb * s.v * (ramp(t) - ramp(t - 2 * s.delay)),
    // far end: the derivative of the aggressor's edge, delayed by the flight time (a pulse of width `rise`)
    farAt: (t) => (t >= s.delay && t <= s.delay + s.rise ? fext : 0),
  };
}

/** Ground bounce (V): n outputs switching a current `iEach` (A) in `rise` ns through a return inductance `lNh` (nH): L · n · di / dt. */
export const groundBounce = (n: number, iEach: number, rise: number, lNh: number): number => (lNh * 1e-9 * n * iEach) / (rise * 1e-9);

// ---------------------------------------------------------------------------------------------------------------------
// A differential pair

export interface DiffSpec {
  /** Peak signal on each leg (V): the pair carries ±amp around its common mode. */
  amp: number;
  /** Noise coupled equally onto both legs (V) and the fraction of it that is not equal (a mismatch of the two legs). */
  common: number;
  mismatch: number;
  /** Receiver common-mode rejection (dB) and its input offset (V). */
  cmrrDb: number;
  offset: number;
  /** Receiver common-mode input range (V) and the pair's common-mode level (V). */
  vcm: number;
  range: [number, number];
}

export interface DiffResult {
  /** Noise left at the single-ended receiver's input (V) = the common noise; the margin to its threshold at half the swing. */
  singleNoise: number;
  singleMargin: number;
  /** Noise left at the differential receiver (V): the mismatch plus the CMRR residue plus the offset. */
  diffNoise: number;
  diffMargin: number;
  /** Rejection achieved (dB): common noise over the noise left. */
  rejectionDb: number;
  /** Does vcm + noise stay in the receiver's range? Past it, the CMRR figure no longer holds. */
  inRange: boolean;
}

/** A single-ended receiver sees ±amp about its threshold; a differential one sees v+ − v− = ±2·amp. */
export function differential(d: DiffSpec): DiffResult {
  const cm = 10 ** (-d.cmrrDb / 20);
  const singleNoise = d.common, singleMargin = d.amp - singleNoise;
  const diffNoise = d.common * (d.mismatch + cm) + d.offset;
  // the legs swing ±amp in opposite directions: the receiver sees ±2·amp against a threshold at 0
  const diffMargin = 2 * d.amp - diffNoise;
  const rejectionDb = diffNoise > 0 ? 20 * Math.log10(d.common / diffNoise) : Infinity;
  const hi = d.vcm + d.common;
  return { singleNoise, singleMargin, diffNoise, diffMargin, rejectionDb, inRange: hi <= d.range[1] && d.vcm - d.common >= d.range[0] };
}

// ---------------------------------------------------------------------------------------------------------------------
// A channel: PRBS, a single-pole low-pass, inter-symbol interference, Gaussian noise, Q and BER

/** A seeded generator in [0, 1): a 32-bit LCG (Numerical Recipes constants). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** A standard normal sample from a uniform generator (Box–Muller). */
export function gaussian(u: () => number): number {
  return Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7 everywhere). */
export function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** The Gaussian tail Q(x) = ½ erfc(x / √2): the chance a unit normal exceeds x. */
export const qFunc = (x: number): number => 0.5 * erfc(x / Math.SQRT2);

/** Bit error rate for a decision with `half` volts of margin to the threshold and Gaussian noise of rms `sigma`: Q(half / sigma). */
export const berOf = (half: number, sigma: number): number => (sigma > 0 ? qFunc(half / sigma) : half > 0 ? 0 : 0.5);

/** Q (= margin / sigma) of an eye opened `opening` volts, i.e. a half-opening to each side of the threshold. */
export const qOf = (opening: number, sigma: number): number => (sigma > 0 ? opening / 2 / sigma : Infinity);

/** PRBS bits: a maximal-length LFSR of the given order (7, 9, 11, 15), `n` bits. Standard polynomials x^7+x^6+1, x^9+x^5+1, x^11+x^9+1, x^15+x^14+1. */
export function prbs(order: 7 | 9 | 11 | 15, n: number, seed = 1): Uint8Array {
  const taps = { 7: 6, 9: 5, 11: 9, 15: 14 }[order];
  let s = seed || 1;
  const mask = (1 << order) - 1, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = ((s >> (order - 1)) ^ (s >> (taps - 1))) & 1;
    s = ((s << 1) | b) & mask;
    out[i] = b;
  }
  return out;
}

export interface ChannelSpec {
  /** Bit rate (Gb/s) and the channel's single pole (GHz, the −3 dB bandwidth). */
  rate: number;
  bandwidth: number;
  /** Transmit de-emphasis: the level after a transition keeps (1 − de) of its first bit's swing; 0 = none. */
  de?: number;
  /** Samples per bit in the waveform. */
  spu?: number;
}

export interface EyeResult {
  /** The bit period (ps) and samples per unit interval. */
  ui: number;
  spu: number;
  /** Noiseless waveform, spu samples per bit, amplitude ±1. */
  wave: Float64Array;
  /** The sampling phase (0 … spu−1) with the widest vertical opening, and that opening (in units of the ±1 swing; ≤ 0 closed). */
  phase: number;
  opening: number;
  /** The threshold at that phase (the middle of the opening) and the lowest 1 / highest 0 there. */
  threshold: number;
  lowOne: number;
  highZero: number;
  /** Fraction of a UI (at the threshold of the best phase) over which the opening stays positive. */
  width: number;
  /** Peak-to-peak ISI at the best phase relative to the swing: 1 − opening / 2 for an ideal ±1 signal. */
  isi: number;
}

/**
 * Bits through a single-pole low-pass at `rate`, the eye read from the noiseless waveform: per sampling phase the lowest 1
 * and the highest 0, the opening between them. The single pole's time constant is 1 / (2π · bandwidth). `skip` bits are
 * dropped from the front so the start-up does not count.
 */
export function eye(bits: ArrayLike<number>, ch: ChannelSpec, skip = 20): EyeResult {
  const spu = ch.spu ?? 40, ui = 1000 / ch.rate, tau = 1000 / (2 * Math.PI * ch.bandwidth), de = ch.de ?? 0;
  const k = 1 - Math.exp(-(ui / spu) / tau);
  const wave = new Float64Array(bits.length * spu);
  let y = -1;
  for (let i = 0; i < bits.length; i++) {
    const d = bits[i] ? 1 : -1, p = i ? (bits[i - 1] ? 1 : -1) : -1;
    // de-emphasis: a bit equal to the previous one is sent at (1 − de) of the swing, a transition at full swing
    const target = d === p ? d * (1 - de) : d;
    for (let j = 0; j < spu; j++) { y += (target - y) * k; wave[i * spu + j] = y; }
  }
  const lowOnes = new Float64Array(spu).fill(Infinity), highZeros = new Float64Array(spu).fill(-Infinity);
  for (let i = skip; i < bits.length; i++) for (let p = 0; p < spu; p++) {
    const x = wave[i * spu + p];
    if (bits[i]) lowOnes[p] = Math.min(lowOnes[p], x); else highZeros[p] = Math.max(highZeros[p], x);
  }
  let best = -Infinity, phase = 0;
  for (let p = 0; p < spu; p++) { const o = lowOnes[p] - highZeros[p]; if (o > best) { best = o; phase = p; } }
  const threshold = (lowOnes[phase] + highZeros[phase]) / 2;
  let width = 0;
  for (let p = 0; p < spu; p++) if (lowOnes[p] > threshold && highZeros[p] < threshold) width++;
  return { ui, spu, wave, phase, opening: best, threshold, lowOne: lowOnes[phase], highZero: highZeros[phase], width: width / spu, isi: 1 - best / 2 };
}

/**
 * A full link figure: the eye of `bits` through `ch`, the noise (`sigma` in the ±1 swing's units) and the BER that follows
 * from the opening. Seeded: the same arguments always give the same numbers.
 */
export function link(bits: ArrayLike<number>, ch: ChannelSpec, sigma: number): { eye: EyeResult; q: number; ber: number } {
  const e = eye(bits, ch);
  const open = Math.max(e.opening, 0);
  return { eye: e, q: qOf(open, sigma), ber: e.opening <= 0 ? 0.5 : berOf(open / 2, sigma) };
}

/** The single-pole channel's smallest bandwidth (GHz) that keeps an eye at least `min` (of the ±1 swing) open at `rate` Gb/s on PRBS-9. */
export function minBandwidth(rate: number, min = 1, de = 0): number {
  const bits = prbs(9, 1022);
  let lo = 0.01, hi = 4 * rate;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (eye(bits, { rate, bandwidth: mid, de }).opening >= min) hi = mid; else lo = mid;
  }
  return hi;
}
