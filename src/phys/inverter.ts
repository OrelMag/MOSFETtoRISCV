// The CMOS inverter's voltage transfer characteristic from the chapter-1 square-law device (widgets/mosphys.ts), DOM-free.
// The switch-level simulator knows 0 / 1 / X; this is the lumped analogue model behind those levels, in the spirit of
// phys/triode.ts: at each Vin the output is the Vout where the NMOS pulls down exactly what the PMOS pulls up.

import { current, VDD } from '../widgets/mosphys';

/** Electron to hole mobility ratio: a PMOS must be this much wider than the NMOS to match it. */
export const MOBILITY_RATIO = 2.5;

/** Drive of the PMOS against the NMOS for a width ratio Wp/Wn (1 = a matched pair). */
export const strength = (wpOverWn: number) => wpOverWn / MOBILITY_RATIO;

const idN = (vin: number, vout: number) => current(vin - 0.45, vout).id;
const idP = (vin: number, vout: number, k: number) => k * current(VDD - vin - 0.45, VDD - vout).id;

export interface VtcPoint {
  vin: number;
  vout: number;
  /** Region of each device at this point. */
  n: 'cut' | 'lin' | 'sat';
  p: 'cut' | 'lin' | 'sat';
}

/** The output voltage at `vin` for a PMOS of relative strength k: bisection on the current balance (monotone in Vout). */
export function vout(vin: number, k = 1): number {
  let lo = 0, hi = VDD;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (idN(vin, mid) - idP(vin, mid, k) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function point(vin: number, k = 1): VtcPoint {
  const v = vout(vin, k);
  return { vin, vout: v, n: current(vin - 0.45, v).kind, p: current(VDD - vin - 0.45, VDD - v).kind };
}

export function curve(k = 1, n = 360): VtcPoint[] {
  return Array.from({ length: n + 1 }, (_, i) => point((i / n) * VDD, k));
}

export interface VtcMetrics {
  /** Switching threshold: Vin = Vout. */
  vm: number;
  /** Inputs where the slope is −1, and the output levels there. */
  vil: number;
  vih: number;
  voh: number;
  vol: number;
  nmL: number;
  nmH: number;
  /** Largest |dVout/dVin|. */
  gain: number;
}

export function metrics(k = 1): VtcMetrics {
  let lo = 0, hi = VDD;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vout(mid, k) > mid) lo = mid; else hi = mid;
  }
  const vm = (lo + hi) / 2, d = 1e-4;
  const slope = (v: number) => (vout(Math.min(VDD, v + d), k) - vout(Math.max(0, v - d), k)) / (Math.min(VDD, v + d) - Math.max(0, v - d));
  let gain = 0;
  for (let i = 0; i <= 720; i++) gain = Math.max(gain, Math.abs(slope((i / 720) * VDD)));
  // slope(v) is flat (0) near the rails and steepest at VM: walk out from VM until it reaches −1 on each side
  const edge = (dir: 1 | -1) => {
    let a = vm, b = dir > 0 ? VDD : 0;
    for (let i = 0; i < 50; i++) {
      const mid = (a + b) / 2;
      if (slope(mid) < -1) a = mid; else b = mid;
    }
    return (a + b) / 2;
  };
  const vil = edge(-1), vih = edge(1), voh = vout(vil, k), vol = vout(vih, k);
  return { vm, vil, vih, voh, vol, nmL: vil - vol, nmH: voh - vih, gain };
}
