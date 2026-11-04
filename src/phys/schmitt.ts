// A Schmitt trigger's two thresholds from the current balance at its internal node, DOM-free (phys/inverter.ts's
// square-law device, widgets/mosphys.ts). The circuit is lib/sync.ts SCHMITT: an input inverter A drives node m, an
// output inverter B turns m into the output, and a keeper (a weak inverter from the output back onto m) holds m where
// it is. While the keeper holds m, A has to out-pull it before B sees a change: that costs input voltage, and the
// price differs by direction. Thresholds are the inputs where A, fighting a keeper frozen in the old state, brings m
// to B's own switching threshold. The simulator below this is switch level (0 / 1 / X): it shows who wins the
// fight by strength, this model says at which input voltage.

import { current, VDD, VT } from '../widgets/mosphys';
import { metrics, strength, MOBILITY_RATIO } from './inverter';

/** Keeper strength in units of the input inverter's own devices (1 = as wide as A's). The sandbox part's keeper is this weak. */
export const KEEPER = 0.15;
/** Which way the keeper holds m: 'hi' (output 0: its PMOS pulls m up) or 'lo' (output 1: its NMOS pulls m down). */
export type KeeperState = 'hi' | 'lo';

const kA = strength(MOBILITY_RATIO); // the input inverter's PMOS against its NMOS: a matched pair, 1

/**
 * The voltage on m for an input at `vin`, with the keeper holding the old state. Bisection on the current balance,
 * which is monotone in m.
 */
export function mNode(vin: number, kappa: number, state: KeeperState): number {
  const f = (m: number): number => {
    const down = current(vin - VT, m).id + (state === 'lo' ? kappa * current(VDD - VT, m).id : 0);
    const up = kA * current(VDD - vin - VT, VDD - m).id + (state === 'hi' ? kappa * current(VDD - VT, VDD - m).id : 0);
    return down - up;
  };
  let lo = 0, hi = VDD;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** B's switching threshold (a matched inverter): m must cross it for the output to move. */
export const VM = metrics(1).vm;

export interface SchmittThresholds {
  /** Input that raises the output (null: the keeper wins at any input up to VDD, the output never rises). */
  up: number | null;
  /** Input that lowers it (null: never). */
  down: number | null;
  /** up − down (null if either is). */
  width: number | null;
}

/** The input where m (frozen in `state`) equals B's threshold; m falls as vin rises. Null if m never gets there. */
function crossing(kappa: number, state: KeeperState): number | null {
  if (state === 'hi' ? mNode(VDD, kappa, 'hi') > VM : mNode(0, kappa, 'lo') < VM) return null;
  let lo = 0, hi = VDD;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (mNode(mid, kappa, state) > VM) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function thresholds(kappa = KEEPER): SchmittThresholds {
  const up = crossing(kappa, 'hi'), down = crossing(kappa, 'lo');
  return { up, down, width: up !== null && down !== null ? up - down : null };
}

/** The largest keeper strength (bisection) at which both thresholds still exist. */
export function keeperLimit(): number {
  let lo = 0, hi = 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const t = thresholds(mid);
    if (t.up !== null && t.down !== null) lo = mid; else hi = mid;
  }
  return lo;
}

// ---- a noisy slow edge ---------------------------------------------------------------------------------------------

/** A seeded generator in [0, 1): mulberry32. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal from two uniforms (Box–Muller). */
export function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

/** A slow ramp 0 → VDD over n samples with Gaussian noise of standard deviation `sigma` volts on every sample. */
export function noisyEdge(seed: number, sigma: number, n = 400): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * VDD + sigma * gauss(r));
}

/** A receiver with thresholds up / down (equal: a plain comparator): the output bit per sample, starting at `start`. */
export function receive(trace: readonly number[], up: number, down: number, start = 0): number[] {
  let q = start;
  return trace.map((v) => {
    if (v > up) q = 1; else if (v < down) q = 0;
    return q;
  });
}

export const transitions = (bits: readonly number[]): number => bits.reduce((n, b, i) => n + (i && b !== bits[i - 1] ? 1 : 0), 0);
