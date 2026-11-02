// The numbers behind the water analogies (DOM-free, so tests/water.test.ts pins them to the site's own models): the loop of
// chapter 0 (basics.ts LOOP / loopAmps), a MOSFET as a faucet (mosphys.ts current()), and CMOS as two faucets on one column
// (switchsim.ts VDD_VOLTS / VT_VOLTS). The 3D scenes (waterscenes.ts) only draw what these return.

import { VDD_VOLTS, VT_VOLTS, WEAK_H, weakTag } from '../sim/switchsim';
import { LOOP, loopAmps } from './basics';
import { current, VDD, VT, type Region } from './mosphys';

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// ------------------------------------------------------------------ chapter 0: the loop

export interface LoopState {
  closed: boolean; cut: boolean; lamps: number;
  /** Try other values (the Water view's sliders): the cell's volts and one lamp's ohms; absent: the widget's LOOP. */
  volts?: number; ohms?: number;
}
export interface LoopWater {
  amps: number;
  /** Volts across one lamp, and the power in it (V × I). */
  vLamp: number; power: number;
  /** Tank level as a fraction of the drawn tank: the cell's voltage over TANK_VOLTS. */
  tank: number;
  /** Drops' speed along the pipe (scene units a second) and a wheel's turn (rad / s): current, and power. */
  dropSpeed: number; wheelRate: number;
  /** Narrow pipe's bore relative to one lamp's: the loop's resistance grows with the lamps in a row. */
  bore: number;
}
export const TANK_VOLTS = 3;
const DROP_PER_AMP = 22, WHEEL_PER_WATT = 30;

/** Slider ranges for 'try other values': the cell's volts and a lamp's ohms (the defaults, LOOP, sit inside both). */
export const LOOP_RANGE = { volts: [0.5, 3] as const, ohms: [5, 45] as const };

export function loopWater(st: LoopState): LoopWater {
  const volts = st.volts ?? LOOP.volts, ohms = st.ohms ?? LOOP.ohms;
  const amps = st.closed && !st.cut ? loopAmps(st.lamps, volts, ohms) : 0;
  const vLamp = amps * ohms, power = amps * vLamp;
  // The narrow pipe's bore follows the loop's resistance (lamps in a row add): 1 at one default lamp, 1/√2 at two.
  return { amps, vLamp, power, tank: volts / TANK_VOLTS, dropSpeed: amps * DROP_PER_AMP, wheelRate: power * WHEEL_PER_WATT, bore: Math.min(1.6, 1 / Math.sqrt((st.lamps * ohms) / LOOP.ohms)) };
}

// ------------------------------------------------------------------ chapter 1: the faucet

export interface FetWater {
  /** µA, the region, and its words. */
  id: number; kind: Region; region: string;
  /** Handle opening 0..1: the overdrive over its largest (VDD − VT). */
  opening: number;
  /** Drain tank level 0..1: V_DS over VDD. */
  level: number;
  /** Flow relative to the most this device passes (Vgs = Vds = VDD): drops' speed. */
  flow: number;
  /** Is the outlet choked (saturation): a lower basin adds nothing? */
  choked: boolean;
  /** The outlet's bore against the pipe's (the pinch drawn in the faucet scene): the overdrive over its largest, so its
   *  area, and the flow it limits in saturation, go as the overdrive squared like mosphys.ts current(). 0 when cut off. */
  bore: number;
}
/** The pipe's radius in the faucet scene, and the narrowest the outlet is drawn (a shut faucet still shows a pinhole). */
export const FET_PIPE_R = 0.17, FET_PINCH_MIN_R = 0.02;
/** The outlet's drawn radius: the pipe's at the widest (V_GS = VDD), the pinhole's when cut off. */
export const pinchRadius = (bore: number): number => FET_PINCH_MIN_R + (FET_PIPE_R - FET_PINCH_MIN_R) * bore;
const ID_MAX = current(VDD - VT, VDD).id;

export function fetWater(vg: number, vd: number): FetWater {
  const ov = vg - VT, c = current(ov, vd);
  return { id: c.id, kind: c.kind, region: c.region, opening: clamp01(ov / (VDD - VT)), level: clamp01(vd / VDD), flow: c.id / ID_MAX, choked: c.kind === 'sat', bore: clamp01(ov / (VDD - VT)) };
}

// ------------------------------------------------------------------ chapter 2: two faucets on one column

/** Volts the scene's unit level stands for, and the threshold as a fraction of it. */
export const COLUMN_VOLTS = VDD_VOLTS;
export const COLUMN_VT = VT_VOLTS / VDD_VOLTS;

export interface ColumnIn {
  /** The one handle, 0..1 of VDD. */
  vin: number;
  /** Both faucets forced fully open (a short). */
  short: boolean;
  /** An NMOS on top in place of the PMOS: it holds the column up by its own gate-to-source drop. */
  weak: boolean;
}

/** A faucet opens in proportion to its handle's drive past the threshold (0..1 of the rest of the swing). */
export const faucetOpen = (drive: number): number => clamp01((drive - COLUMN_VT) / (1 - COLUMN_VT));

/** How far the top (p) and bottom (n) faucets are open with the column at `out`. The PMOS is held by the tank above it,
 *  so it does not care how full the column is; the NMOS on top has its source on the column, so it closes itself as
 *  that rises (weak). */
export function openings(c: ColumnIn, out: number): { p: number; n: number } {
  const n = c.short ? 1 : faucetOpen(c.vin);
  const gate = c.short ? 1 : 1 - c.vin; // the top faucet's handle: low opens the PMOS, the NMOS on top is driven by the same level
  const p = c.weak ? faucetOpen(gate - out) : c.short ? 1 : faucetOpen(1 - c.vin);
  return { p, n };
}

export interface ColumnStep { out: number; iTop: number; iBot: number; p: number; n: number }
const COLUMN_RATE = 5; // column fills per second at full flow

/** One step of the column: it fills through the top faucet from a full tank (1) and empties through the bottom into the drain. */
export function columnStep(out: number, c: ColumnIn, dt: number): ColumnStep {
  const { p, n } = openings(c, out);
  const iTop = p * (1 - out), iBot = n * out;
  return { out: clamp01(out + (iTop - iBot) * dt * COLUMN_RATE), iTop, iBot, p, n };
}

/** The level the column settles at (to < 1e-6 of a step) from `out`. */
export function columnSettle(out: number, c: ColumnIn): number {
  for (let i = 0; i < 4000; i++) {
    const s = columnStep(out, c, 0.05);
    if (Math.abs(s.out - out) < 1e-9) return s.out;
    out = s.out;
  }
  return out;
}

/** Water that goes straight through, tank to drain, as a fraction of what one open faucet passes. */
export const wasted = (s: ColumnStep): number => Math.min(s.iTop, s.iBot);

/** The highest level a column filled through an NMOS can reach: VDD − VT, in volts. */
export const weakCapVolts = (): number => VDD_VOLTS - VT_VOLTS;

// ------------------------------------------------------------------ paths the drops follow

export type P3 = [number, number, number];

export const polyLength = (pts: readonly P3[]): number => {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]);
  return l;
};

/** The point `s` along the polyline (wrapping past the end: a closed loop's drops go round). */
export function pointAlong(pts: readonly P3[], s: number): P3 {
  const L = polyLength(pts);
  s = ((s % L) + L) % L;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (s <= l) { const t = l ? s / l : 0; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    s -= l;
  }
  return [...pts[pts.length - 1]] as P3;
}

/** What the faucet is doing, in words (under the 3D view of "Three regions"). */
export function fetWords(f: FetWater): string {
  if (f.kind === 'cut') return `Cut-off: the handle is below the ${VT} V threshold, so the faucet is shut however high the drain tank stands.`;
  if (f.kind === 'lin') return 'Linear: the opening is wider than the drop is tall, so flow grows with the drain tank\u2019s level.';
  return 'Saturation, choked: the opening limits the flow now, so a lower basin would add nothing (bar the slight slope \u03bb gives).';
}

/** The column's state in words and a tone (the pill under the figure). */
export function columnWords(s: ColumnStep, c: ColumnIn): { text: string; tone: 'ok' | 'warn' | 'bad' | 'mid' } {
  if (c.short) return { text: 'short: the tank pours straight into the drain', tone: 'bad' };
  if (s.p > 0.02 && s.n > 0.02) return { text: 'both partly open: a moment of wasted flow', tone: 'warn' };
  if (c.weak && s.out > 1 - COLUMN_VT - 0.03 && s.out < 0.995) return { text: `weak 1: ${weakTag(WEAK_H)}`, tone: 'warn' };
  if (s.out > 0.95) return { text: '1: driven to V_DD', tone: 'ok' };
  if (s.out < 0.05) return { text: '0: driven to ground', tone: 'ok' };
  return { text: 'changing', tone: 'mid' };
}
