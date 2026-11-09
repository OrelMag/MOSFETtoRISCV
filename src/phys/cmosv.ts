// The transistor from 0 V to past its threshold (the Power chapter, DOM-free): chapter 2's square law with the
// subthreshold tail it leaves out. One expression covers both (the EKV interpolation, source-referenced):
//
//   I = Is · [F((Vg − Vt − n·Vs) / 2nφt) − F((Vg − Vt − n·Vd) / 2nφt)],   F(x) = ln²(1 + eˣ)
//
// Far above threshold F(x) → x², so a saturated device carries Is / (2nφt)² · (Vgs − Vt)²: chapter 2's (K / 2) · Vov²
// with K = 2 Is / (2nφt)² (widgets/mosphys.ts, without its channel-length modulation). Below threshold F(x) → e^{2x}:
// the current falls by a decade every n · φt · ln 10 of gate voltage (the subthreshold swing S) and never reaches zero.
// That remainder at Vgs = 0 is the off current, the leakage.
//
// Nothing here is chosen to make a curve look right. Two processes are taken from a cited roadmap (their on and off
// currents per µm of width); the threshold of each is solved from that ratio; the width of our NAND's transistors from
// the book's own constants: a NAND drives its usual load (sim/netcap.ts: one input, its own drain, one wire branch)
// in PS_PER_NAND = 25 ps at VDD = 0.9 V (sim/timing.ts, sim/power.ts). Leakage and gate delay at any other voltage then
// follow. Not modelled: DIBL (the drain lowering the threshold), so stacked off transistors leak half as much as one,
// where a real stack leaks several times less; temperature (φt at 300 K); PMOS and NMOS alike per µm.

import { FF_DRIVER, FF_INPUT, FF_WIRE } from '../sim/netcap';
import { PS_PER_NAND } from '../sim/timing';

/** The supply the book's timing and power are calibrated at (sim/power.ts VDD). */
export const V_NOM = 0.9;
/** kT/q at 300 K, in volts. */
export const PHI_T = (1.380649e-23 * 300) / 1.602176634e-19;
/**
 * The subthreshold slope factor n: S = n · φt · ln 10 = 83 mV per decade. Bulk MOSFETs sit at 70–100 mV per decade
 * (Taur & Ning, Fundamentals of Modern VLSI Devices); 60 mV (n = 1) is the room-temperature limit.
 */
export const N_SLOPE = 1.4;
/** mV of gate voltage per decade of subthreshold current. */
export const SWING_MV = N_SLOPE * PHI_T * Math.LN10 * 1000;
/** The load a NAND drives in the book's calibration: its own drain, one NAND input and one wire branch (fF). */
export const C_NAND = FF_DRIVER + FF_INPUT + FF_WIRE;

export interface Process {
  id: 'hp' | 'lp';
  name: string;
  /** Saturation current per µm of width at V_NOM (A / µm). */
  ion: number;
  /** Off current per µm (Vgs = 0, Vds = V_NOM; A / µm). */
  ioff: number;
  /** Where the two numbers come from. */
  source: string;
}

/** ITRS 2013, Process Integration, Devices and Structures (PIDS): the logic transistor requirements. */
export const PROCESSES: Record<Process['id'], Process> = {
  hp: {
    id: 'hp', name: 'High performance', ion: 1355e-6, ioff: 100e-9,
    source: 'ITRS 2013 (PIDS), high-performance logic: off current held at 100 nA/µm; on current 1 355 µA/µm (the 2013–14 requirement, at 0.85 V; taken here at 0.9 V)',
  },
  lp: {
    id: 'lp', name: 'Low leakage', ion: 0.35 * 1355e-6, ioff: 10e-12,
    source: 'ITRS 2013 (PIDS), low-standby-power logic: off current 10 pA/µm, four decades under high performance\'s; on current at least 35 % of high performance\'s',
  },
};

const F = (x: number) => (x > 40 ? x * x : Math.log1p(Math.exp(x)) ** 2);

export interface Device {
  /** Threshold voltage (V), solved from ion / ioff. */
  vt: number;
  /** Specific current per µm (A / µm). */
  is: number;
  /** Width of the book's NAND transistors (µm), from the 25 ps calibration. */
  w: number;
}

const devices = new Map<Process['id'], Device>();

/** The device a process implies (memoized). */
export function deviceOf(p: Process): Device {
  let d = devices.get(p.id);
  if (d) return d;
  // F(−Vt) / F(V − Vt) = ioff / ion fixes Vt (Vd = V_NOM, so the drain term is negligible both times)
  let lo = 0, hi = V_NOM;
  for (let k = 0; k < 100; k++) {
    const vt = (lo + hi) / 2;
    if (F(-vt / (2 * N_SLOPE * PHI_T)) / F((V_NOM - vt) / (2 * N_SLOPE * PHI_T)) > p.ioff / p.ion) lo = vt; else hi = vt;
  }
  const vt = (lo + hi) / 2;
  const u = 2 * N_SLOPE * PHI_T;
  const is = p.ion / (F((V_NOM - vt) / u) - F((V_NOM - vt - N_SLOPE * V_NOM) / u));
  // t = C · V / I: the time to move C · V of charge at the on current, PS_PER_NAND at V_NOM
  const w = (C_NAND * 1e-15 * V_NOM) / (p.ion * PS_PER_NAND * 1e-12);
  devices.set(p.id, (d = { vt, is, w }));
  return d;
}

/** Drain current (A) of one of the book's transistors, terminals in volts (source-referenced: n · Vs, n · Vd). */
export function current(p: Process, vg: number, vs: number, vd: number): number {
  const { vt, is, w } = deviceOf(p), u = 2 * N_SLOPE * PHI_T;
  return is * w * (F((vg - vt - N_SLOPE * vs) / u) - F((vg - vt - N_SLOPE * vd) / u));
}

/** What the leakage model leaves out, for the text beside its numbers. */
export const nandLeakNote = 'Two off transistors in series leak half as much as one here; real ones leak several times less (the drain lowers the upper one\'s threshold less, DIBL, and the body effect raises it, both left out of this model), so a NAND with both inputs at 0 leaks least of all';

/** On current at supply v: gate and drain at v. */
export const onCurrent = (p: Process, v: number) => current(p, v, 0, v);
/** Off current at supply v: gate at the source, v across it. */
export const offCurrent = (p: Process, v: number) => current(p, 0, 0, v);

/**
 * The current through k off transistors in series with v across the chain: the nodes between them settle where every
 * device carries the same current (solved by bisection, from the bottom up). k = 1 is offCurrent.
 */
export function seriesOff(p: Process, v: number, k: number): number {
  if (k <= 1) return offCurrent(p, v);
  // the top device's source x: its current against the chain below at x
  let lo = 0, hi = v;
  for (let it = 0; it < 60; it++) {
    const x = (lo + hi) / 2;
    if (current(p, 0, x, v) > seriesOff(p, x, k - 1)) lo = x; else hi = x;
  }
  return seriesOff(p, (lo + hi) / 2, k - 1);
}

/** A NAND's delay (s) at supply v: PS_PER_NAND at V_NOM by construction. */
export const gateDelay = (p: Process, v: number) => (C_NAND * 1e-15 * v) / onCurrent(p, v);

/** How much slower every gate is at v than at V_NOM. */
export const delayScale = (p: Process, v: number) => gateDelay(p, v) / gateDelay(p, V_NOM);

/** Chapter 2's saturated current (µA) from this law with its K and VT: (K / 2) · Vov² far above threshold. */
export function squareLawLimit(k: number, vt: number, vgs: number): number {
  const u = 2 * N_SLOPE * PHI_T, is = (k / 2) * u * u;
  return is * (F((vgs - vt) / u) - F((vgs - vt - N_SLOPE * 10) / u));
}
