// A telegraph line as a resistor (Phase 21, chapter 39). DOM-free. A key, a battery, a wire and a relay or sounder
// coil are one series loop: the current is V / (R_line + R_coil), and the coil pulls in only above its pull-in current.
// The coil is the telephone relay of phys/relay.ts (400 Ω, pull-in voltage from its force balance); a real telegraph
// relay was wound differently, so the reach is a model's, not a museum's. Line resistance is a labelled round
// figure: resistivity over a 4 mm wire. Leakage over wet insulators and inductance, which cost real lines far more at
// the tail, are left out and said so.

import { RELAY, RELAY_STEP_MS, relayStatic } from './relay';

export type Metal = 'iron' | 'copper';

/** Resistivity (Ω·m): drawn iron wire ~1.0e-7 (pure iron 9.7e-8, telegraph iron was impure), annealed copper 1.68e-8. */
export const RESISTIVITY: Record<Metal, number> = { iron: 1.0e-7, copper: 1.68e-8 };
/** Wire diameter (m): a round 4 mm, about the gauge of overhead telegraph wire. */
export const WIRE_D = 4e-3;
/** Cells of a Daniell-type battery in series, volts per cell. */
export const CELL_V = 1.1;

/** Resistance of the wire per km (Ω/km). */
export const ohmsPerKm = (m: Metal, d = WIRE_D): number => (RESISTIVITY[m] * 1000) / (Math.PI * (d / 2) ** 2);

/** The coil's pull-in current (A): pull-in voltage over coil resistance (relay.ts). */
export const PULL_V = relayStatic().pull ?? 0;
export const PULL_I = PULL_V / RELAY.Rc;

/** Series loop current (A) for battery V (volts), line length (km) and metal. The return is the earth: one wire. */
export function loopCurrent(V: number, km: number, m: Metal, rCoil = RELAY.Rc): number {
  return V / (ohmsPerKm(m) * km + rCoil);
}

/** Longest line (km) one coil still pulls in on, from one battery. 0 if the battery cannot pull the coil in at all. */
export function reachKm(V: number, m: Metal, iPull = PULL_I, rCoil = RELAY.Rc): number {
  return Math.max(0, (V / iPull - rCoil) / ohmsPerKm(m));
}

/** Reach with n repeaters: n + 1 sections, each from a battery of its own, so the lengths add. */
export const reachWithRepeaters = (V: number, m: Metal, n: number): number => (n + 1) * reachKm(V, m);

/** Delay a chain of n repeaters adds (ms): a relay step each (the signal itself crosses the wire at a large fraction of c). */
export const repeaterDelayMs = (n: number): number => n * RELAY_STEP_MS;

/** Energy the battery gives up to send one bit of `ms` milliseconds on a loop with current i (J). */
export const bitEnergy = (V: number, i: number, ms: number): number => V * i * ms * 1e-3;

/** Margin: the line current over the pull-in current (above 1, the relay works). */
export const margin = (V: number, km: number, m: Metal): number => loopCurrent(V, km, m) / PULL_I;
