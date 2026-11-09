// A telegraph line as a resistor (Phase 21, chapter telegraph). DOM-free. A key, a battery, a wire and a main-line sounder
// coil are one series loop: the current is V / (R_line + R_coil), and the coil pulls in only above its pull-in current.
// The sounder is the relay model of phys/relay.ts rewound to a main-line sounder's resistance (SOUNDER_R, 120 Ω:
// Western Union's 15B in the Railroad Telegraphers Handbook; GPO and Canadian main-line sounders were 20 Ω, Science
// Museum Group 1971-60/1, Ingenium 1968.0652.001): the same turns, so the same ampere-turns and the same pull-in
// CURRENT as the relay (the force balance sees N·I), a coil of heavier wire, and no quench resistor (a real sounder
// has none; the model's release path stands for the spark and condenser at the key). Pull-in current is the model's
// estimate, not a datasheet value. Line resistance is a labelled round figure: resistivity over a 4 mm wire. Leakage
// over wet insulators and inductance, which cost real lines far more at the tail, are left out and said so.
// Long lines worked a finer-wound relay that closed a LOCAL battery through a 4 Ω local sounder (the next step).

import { RELAY, RELAY_STEP_MS, relayStatic, type RelayParams } from './relay';

/** A main-line sounder's coil (Ω): the Western Union 15B of the railroad handbook. */
export const SOUNDER_R = 120;
/** Discharge path across the coil when the loop opens (Ω): the key's spark and condenser, an estimate (not 4000 Ω of a telephone quench). */
export const SOUNDER_RELEASE = 1000;
/** The sounder as relay.ts parameters: the relay's magnet and spring, a main-line coil, its own release path. */
export const SOUNDER: RelayParams = { ...RELAY, Rc: SOUNDER_R, Rq: SOUNDER_RELEASE };

export type Metal = 'iron' | 'copper';

/** Resistivity (Ω·m): drawn iron wire ~1.0e-7 (pure iron 9.7e-8, telegraph iron was impure), annealed copper 1.68e-8. */
export const RESISTIVITY: Record<Metal, number> = { iron: 1.0e-7, copper: 1.68e-8 };
/** Wire diameter (m): a round 4 mm, about the gauge of overhead telegraph wire. */
export const WIRE_D = 4e-3;
/** Cells of a Daniell-type battery in series, volts per cell. */
export const CELL_V = 1.1;

/** Resistance of the wire per km (Ω/km). */
export const ohmsPerKm = (m: Metal, d = WIRE_D): number => (RESISTIVITY[m] * 1000) / (Math.PI * (d / 2) ** 2);

/** The coil's pull-in current (A): the relay's pull-in voltage over ITS coil. The force balance depends on N·I, so a coil of
 *  other resistance but the same turns pulls in at the same current (tests/model-telegraph.test.ts checks it on SOUNDER). */
export const PULL_I = (relayStatic().pull ?? 0) / RELAY.Rc;
/** The voltage across the sounder's own coil at pull-in (V). */
export const PULL_V = PULL_I * SOUNDER_R;

/** Series loop current (A) for battery V (volts), line length (km) and metal. The return is the earth: one wire. */
export function loopCurrent(V: number, km: number, m: Metal, rCoil = SOUNDER_R): number {
  return V / (ohmsPerKm(m) * km + rCoil);
}

/** Longest line (km) one coil still pulls in on, from one battery. 0 if the battery cannot pull the coil in at all. */
export function reachKm(V: number, m: Metal, iPull = PULL_I, rCoil = SOUNDER_R): number {
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

/** The campaign's repeater level (l_repeater): a section one 24 V battery drives to a coil with margin (km). Twice that is out of reach. */
export const REPEATER_SECTION_KM = 40;
