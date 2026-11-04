// Metastability as a model, DOM-free. A cross-coupled pair (the latch inside every flip-flop) sampled at the instant
// its input is balanced starts with a difference ΔV between its two nodes, and the loop's gain amplifies it
// exponentially: V(t) = ΔV · e^(t/τ) until a node reaches a rail. The gate-level simulator cannot time a real race
// (it resolves a perfectly balanced pair by relaxation, gatesim.ts relax(), in no time at all), so every figure here is
// this model's. The constants are illustrative, tied to the book's delay per NAND (sim/timing.ts PS_PER_NAND), and
// named so that a reader can replace them with a library cell's.
//
//   MTBF = e^(t_r / τ) / (T0 · f_clk · f_data)
//
// t_r is the time the first stage has to resolve before the second samples it, τ the loop's time constant, T0 the
// width of the window around the clock edge in which a data change leaves the pair unresolved, f_clk the sampling clock
// and f_data the rate of data changes: T0 · f_clk · f_data is how often a change lands in the window (events per
// second), e^(−t_r/τ) the chance that such an event is still undecided t_r later.

import { CLK_TO_Q, PS_PER_NAND, SETUP } from '../sim/timing';

/** τ in NAND delays: a cross-coupled pair regenerates faster than a NAND propagates (loop gain over one gate's C/gm). Illustrative. */
export const TAU_NAND = 0.4;
/** T0 in NAND delays: the window around the edge (setup + hold aperture) that a data change can leave undecided. Illustrative. */
export const T0_NAND = 1;
/** τ and T0 in picoseconds at PS_PER_NAND. */
export const TAU_PS = TAU_NAND * PS_PER_NAND;
export const T0_PS = T0_NAND * PS_PER_NAND;
/** A node is decided once it is this far from the balance point: half of a 1.8 V swing. */
export const V_DECIDED = 0.9;

export interface Pair {
  /** Time constant (ps). */
  tau: number;
  /** Window (ps). */
  t0: number;
}
export const PAIR: Pair = { tau: TAU_PS, t0: T0_PS };

/** |ΔV| after t picoseconds, in the linear regime, clipped at the decided level: sign kept. */
export function voltage(dv0: number, t: number, tau = TAU_PS): number {
  const v = dv0 * Math.exp(t / tau);
  return Math.sign(v) * Math.min(Math.abs(v), V_DECIDED);
}

/** Time (ps) for an initial difference dv0 to reach V_DECIDED: τ · ln(V / |ΔV|), 0 if it starts decided. */
export function resolveTime(dv0: number, tau = TAU_PS): number {
  const a = Math.abs(dv0);
  if (a >= V_DECIDED) return 0;
  return a === 0 ? Infinity : tau * Math.log(V_DECIDED / a);
}

/** The chance that an event that left the pair balanced is still undecided t ps later. */
export const pUndecided = (t: number, tau = TAU_PS): number => Math.exp(-Math.max(0, t) / tau);

/**
 * Time (ps) the first flip-flop has to resolve before something samples it. With one flop that something is the logic
 * after it and the flop behind that (a period less clock-to-q, setup and the logic: `logicPs`). With n ≥ 2 flops in a
 * chain each of the n − 1 hops between them is a full period less clock-to-q and setup: (n − 1) · T − hop.
 */
export function resolutionTime(stages: number, periodPs: number, logicPs = 0): number {
  const hop = (CLK_TO_Q + SETUP) * PS_PER_NAND;
  return Math.max(0, stages <= 1 ? periodPs - hop - logicPs : (stages - 1) * periodPs - hop);
}

export interface MtbfInput {
  /** Synchronizer flip-flops in series (1 = no synchronizer: the first flop feeds logic). */
  stages: number;
  /** Receiving clock (Hz). */
  fclk: number;
  /** Asynchronous data change rate (Hz). */
  fdata: number;
  /** Logic after the flop in NAND delays (used with one flop only). */
  logic?: number;
  pair?: Pair;
}

/** Events per second that land in the window: T0 · f_clk · f_data. */
export const windowRate = (fclk: number, fdata: number, t0 = T0_PS): number => t0 * 1e-12 * fclk * fdata;

/** Mean time between failures in seconds (Infinity when it overflows a double). */
export function mtbf(i: MtbfInput): number {
  const pair = i.pair ?? PAIR;
  const T = 1e12 / i.fclk;
  const tr = resolutionTime(i.stages, T, (i.logic ?? 0) * PS_PER_NAND);
  return Math.exp(tr / pair.tau) / windowRate(i.fclk, i.fdata, pair.t0);
}

/** log10 of the MTBF in seconds (finite where mtbf overflows). */
export function log10Mtbf(i: MtbfInput): number {
  const pair = i.pair ?? PAIR;
  const T = 1e12 / i.fclk;
  const tr = resolutionTime(i.stages, T, (i.logic ?? 0) * PS_PER_NAND);
  return tr / pair.tau / Math.LN10 - Math.log10(windowRate(i.fclk, i.fdata, pair.t0));
}

const UNITS: [number, string][] = [[1, 's'], [60, 'min'], [3600, 'h'], [86400, 'days'], [86400 * 365.25, 'years']];

/** A duration in seconds in readable units: µs … years, then powers of ten of years (the age of the universe, 1.4e10 years, is the yardstick). */
export function fmtDuration(sec: number): string {
  if (!isFinite(sec)) return 'effectively never';
  const num = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  if (sec < 1e-3) return `${num(sec * 1e6)} µs`;
  if (sec < 1) return `${num(sec * 1e3)} ms`;
  let u = UNITS[0];
  for (const x of UNITS) if (sec >= x[0]) u = x;
  const v = sec / u[0];
  if (u[1] === 'years' && v >= 1e6) return `${v.toExponential(1).replace('e+', ' × 10^')} years`;
  return `${num(v)} ${u[1]}`;
}

/** The same from log10(seconds) where the plain value overflows. */
export function fmtLog10(l: number): string {
  if (l < 300) return fmtDuration(10 ** l);
  const years = l - Math.log10(86400 * 365.25);
  return `10^${years.toFixed(0)} years`;
}

export const AGE_OF_UNIVERSE_YEARS = 1.38e10;
