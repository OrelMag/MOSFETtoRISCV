// How much of the channel the gate holds: planar, fin and stacked nanosheets compared (DOM-free, tested). For chapter
// silicon's "The real thing" model (widgets/finfet3d*). Two numbers per device: the width of silicon the gate turns on
// (effective width) and the subthreshold swing it can reach at a short gate, from the natural length of a multi-gate device
// (Colinge, FinFETs and Other Multi-Gate Transistors, 2008: λ = √(ε_si / (n ε_ox) · t_si · t_ox), n the equivalent number
// of gates: 1 planar, ~3 a tri-gate fin, ~4 gate-all-around), and the swing S = φt ln10 / (1 − 2 e^(−L / 2λ)): the classic
// short-channel estimate. It is simplified on purpose: it gets the direction and the size of the effect, not a device.
//
// Dimensions: Intel 22 nm tri-gate, fin pitch 60 nm, height 34 nm, width 8 nm (Auth et al., VLSI 2012); IBM 2 nm, three
// nanosheets 5 nm thick and 40 nm wide, 5 nm apart, a 12 nm gate, 44 nm pitch, 75 nm stack (IBM Research, 2021, as
// reported by Tom's Hardware and AnandTech). The planar device and the oxide are illustrative.

import { PHI_T } from './cmosv';

export type GateKind = 'planar' | 'fin' | 'sheets';
/** Silicon over oxide permittivity (11.7 / 3.9). */
export const EPS_RATIO = 11.7 / 3.9;
/** Equivalent oxide thickness, nm (illustrative: about 1 nm in high-k gates of these generations). */
export const EOT_NM = 1;
/** Gate sides on the channel and the equivalent number of gates in λ. */
export const SIDES: Record<GateKind, number> = { planar: 1, fin: 3, sheets: 4 };

export interface Device {
  kind: GateKind;
  /** Gate length, nm. */
  L: number;
  /** Planar: channel width and depletion depth; fin: width and height; sheets: width, thickness, gap and count. */
  W: number; H: number; gap?: number; n?: number;
  /** The width of silicon one device takes across, nm (a fin's pitch, a stack's footprint). */
  pitch: number;
  source: string;
}

/** The three, as drawn. The planar device has the same footprint and gate as the stack; its depth is the depletion depth. */
export const DEVICES: Record<GateKind, Device> = {
  planar: { kind: 'planar', L: 12, W: 44, H: 10, pitch: 44, source: 'illustrative: the nanosheet’s footprint and gate, gated from the top only' },
  fin: { kind: 'fin', L: 12, W: 8, H: 34, pitch: 60, source: 'Intel 22 nm tri-gate: fin 8 nm wide, 34 nm tall, 60 nm pitch (Auth et al., VLSI 2012)' },
  sheets: { kind: 'sheets', L: 12, W: 40, H: 5, gap: 5, n: 3, pitch: 44, source: 'IBM 2 nm: three sheets 5 × 40 nm, 5 nm apart, 12 nm gate, 44 nm pitch (IBM Research, 2021)' },
};

/** The width of silicon the gate turns on: the planar top, a fin's two walls and top, every face of every sheet. */
export function weff(d: Device): number {
  if (d.kind === 'planar') return d.W;
  if (d.kind === 'fin') return 2 * d.H + d.W;
  return (d.n ?? 1) * 2 * (d.W + d.H);
}
/** Effective width per nanometre of footprint. */
export const weffDensity = (d: Device): number => weff(d) / d.pitch;

/** The silicon thickness the gate must reach through: a planar depletion depth, a fin's width, a sheet's thickness. */
const tSi = (d: Device): number => (d.kind === 'fin' ? d.W : d.H);
/** Natural length λ, nm: the distance over which the drain's field reaches under the gate. */
export function naturalLength(d: Device, eot = EOT_NM): number {
  return Math.sqrt((EPS_RATIO / SIDES[d.kind]) * tSi(d) * eot);
}
/** The ideal swing at 300 K, mV per decade (60 mV: n = 1). */
export const IDEAL_SWING = PHI_T * Math.LN10 * 1000;
/** Subthreshold swing at gate length L, mV per decade (Infinity once the gate loses the channel). */
export function swing(d: Device, L = d.L, eot = EOT_NM): number {
  const k = 1 - 2 * Math.exp(-L / (2 * naturalLength(d, eot)));
  return k > 0 ? IDEAL_SWING / k : Infinity;
}
/** Off current relative to another device, at the same threshold vt (V): a decade per swing below it. */
export const offRatio = (d: Device, ref: Device, vt = 0.3): number => 10 ** (-(vt * 1000) / swing(d)) / 10 ** (-(vt * 1000) / swing(ref));
