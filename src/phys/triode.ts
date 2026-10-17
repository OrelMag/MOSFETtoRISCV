// One section of a 6SN7 twin triode (the tube ENIAC used most) as a lumped model, the one behind the triode
// close-up and prologue P2's numbers (Phase 14b). DOM-free, so the close-up, the chapter and the tests read the same
// numbers.
//
// Plate current follows the space-charge (Child–Langmuir) law I = K·(Vg + Vp/µ)^1.5, K fitted to the datasheet point
// (Vp 250 V, Vg −8 V, 9 mA; µ 20). Emission is limited by the cathode's temperature (Richardson:
// A*·T²·e^(−W/kT) over the coated area), and the heater warms the cathode with a 6 s time constant, so nothing flows
// for about 5 s after switch-on and then the full current appears within half a second. The tube works into a
// 22 kΩ plate resistor on 250 V; a 1 MΩ divider to −150 V shifts its plate down to the next grid's levels.

/** The tube: amplification factor, perveance (fitted below), heater power per section (6.3 V × 0.3 A). */
export const MU = 20;
export const K = 9e-3 / Math.pow(-8 + 250 / MU, 1.5);
export const HEATER_W = 6.3 * 0.3;
/** Cathode: work function of the oxide coating (eV), operating temperature (K), heater time constant (s),
 *  coated area (m²), Richardson constant reduced for the coating (A / m² K²). */
const KB = 8.617e-5, WF = 1.2, T_HOT = 1050, TAU_H = 6, A_EFF = 0.85e-4, A_STAR = 1e4;

/** The circuit: supply B+ (V), plate resistor (Ω), bias rail (V), the divider from a plate to the next grid (Ω). */
export const B_PLUS = 250;
export const R_PLATE = 22e3;
export const V_BIAS = -150;
export const R_DIV_TOP = 625e3, R_DIV_BOTTOM = 375e3;

/** Cathode temperature t seconds after the heater is switched on (K). */
export const cathodeTemp = (t: number) => 300 + (T_HOT - 300) * (1 - Math.exp(-Math.max(0, t) / TAU_H));
/** The most current a cathode at Tc can emit (A). */
export const emission = (Tc: number) => A_STAR * Tc * Tc * Math.exp(-WF / (KB * Tc)) * A_EFF;

/** Plate current (A) at grid vg and plate vp, at most `sat` (the emission limit). */
export function plateCurrent(vg: number, vp: number, sat = Infinity): number {
  const u = vg + vp / MU;
  return Math.min(sat, u > 0 ? K * Math.pow(u, 1.5) : 0);
}

/** The grid voltage below which a plate at vp draws no current. */
export const cutoff = (vp: number) => -vp / MU;

/** A resistor from the plate to a rail: a divider of the next stage, loading the plate. */
export interface PlateLoad { r: number; to: number }

/**
 * The plate voltage with the grid at vg: where the plate resistor's current equals the tube's plus the loads'.
 * Bisection (the current through the resistor falls with vp, the tube's and the loads' rise).
 */
export function plateVoltage(vg: number, sat = Infinity, loads: readonly PlateLoad[] = []): number {
  let lo = V_BIAS, hi = B_PLUS;
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    const out = plateCurrent(vg, m, sat) + loads.reduce((a, l) => a + (m - l.to) / l.r, 0);
    if ((B_PLUS - m) / R_PLATE > out) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** The divider's middle with the plate at vp (the next grid, drawing no current while negative). */
export const dividerOut = (vp: number, top = R_DIV_TOP, bottom = R_DIV_BOTTOM, bias = V_BIAS) => (vp * bottom + bias * top) / (top + bottom);

/** The divider as a load on the plate it reads. */
export const DIVIDER_LOAD: PlateLoad = { r: R_DIV_TOP + R_DIV_BOTTOM, to: V_BIAS };

/** The plate's two levels: grid at 0 V (conducting, a 0) and cut off (a 1). */
export const V_LOW = plateVoltage(0);
export const V_HIGH = plateVoltage(-20);
/** Cutoff at the full supply, and the divider ratio that brings a 250 V plate to a 0 V grid. */
export const V_CUTOFF = cutoff(B_PLUS);
export const DIVIDER_RATIO = B_PLUS / -V_BIAS;

export interface GateLevels {
  /** Plate cut off and conducting (V), each driving `fanout` dividers. */
  high: number; low: number;
  /** The next grid for each (V). */
  gridHigh: number; gridLow: number;
  /** How far below cutoff a low plate puts the next grid (V); how far above cutoff a high one does. */
  marginLow: number; marginHigh: number;
}

/**
 * A chain of inverters, each plate driving `fanout` dividers: the high plate (cut off, loaded) gives the next grid
 * gridHigh; that grid sets the next tube's low plate; its divider gives gridLow, which must be below cutoff.
 */
export function gateLevels(fanout = 1, top = R_DIV_TOP, bottom = R_DIV_BOTTOM, bias = V_BIAS): GateLevels {
  const loads = Array.from({ length: fanout }, () => ({ r: top + bottom, to: bias }));
  const high = plateVoltage(-50, Infinity, loads);
  // a grid above 0 V draws current and is clamped there (the divider's top resistor drops the rest)
  const gridHigh = Math.min(0, dividerOut(high, top, bottom, bias));
  const low = plateVoltage(gridHigh, Infinity, loads);
  const gridLow = Math.min(0, dividerOut(low, top, bottom, bias));
  return { high, low, gridHigh, gridLow, marginLow: cutoff(B_PLUS) - gridLow, marginHigh: gridHigh - cutoff(high) };
}

/** Power of one section (W): the heater always; plate and plate resistor while it conducts (grid 0 V). */
export function sectionPower(): { heater: number; plate: number; resistor: number; average: number } {
  const i = plateCurrent(0, V_LOW);
  const plate = V_LOW * i, resistor = (B_PLUS - V_LOW) * i;
  return { heater: HEATER_W, plate, resistor, average: HEATER_W + (plate + resistor) / 2 };
}

/** A divider's average power (W), half the time on a high plate and half on a low one. */
export function dividerPower(top = R_DIV_TOP, bottom = R_DIV_BOTTOM, bias = V_BIAS): number {
  const r = top + bottom, p = (v: number) => ((v - bias) ** 2) / r;
  const l = gateLevels(1, top, bottom, bias);
  return (p(l.high) + p(l.low)) / 2;
}

/** A 6AL5 diode section's heater (W): 6.3 V × 0.3 A for the tube's two sections. */
export const DIODE_HEATER_W = (6.3 * 0.3) / 2;

/** The NAND brick (a triode section, two diode sections, one divider into the grid): average power (W). */
export function nandBrickPower(): { heaters: number; plate: number; divider: number; total: number } {
  const sp = sectionPower(), heaters = HEATER_W + 2 * DIODE_HEATER_W, plate = sp.average - sp.heater, divider = dividerPower();
  return { heaters, plate, divider, total: heaters + plate + divider };
}

/** The plate node's capacitance (F, illustrative): the next grid with its Miller multiplication, wiring, speed-up
 *  capacitors across the divider. With the plate resistor it sets a tube gate's time. */
export const C_NODE = 45e-12;
/** A tube gate's delay (µs): the plate resistor charging the next stage, R·C. An estimate, not a measurement. */
export const TUBE_STEP_US = (R_PLATE * C_NODE) * 1e6;

export interface WarmSample { t: number; Tc: number; ip: number; vp: number }

/** Plate current over the first `tEnd` seconds after switch-on, with the grid at vg (every dt seconds). */
export function warmup(vg: number, tEnd = 20, dt = 0.05): WarmSample[] {
  const out: WarmSample[] = [];
  for (let k = 0; k * dt <= tEnd + 1e-9; k++) {
    const t = k * dt, Tc = cathodeTemp(t), sat = emission(Tc), vp = plateVoltage(vg, sat);
    out.push({ t, Tc, ip: plateCurrent(vg, vp, sat), vp });
  }
  return out;
}

/** The tube's state t seconds after switch-on, grid at vg. */
export function triodeAt(vg: number, t: number): { Tc: number; sat: number; vp: number; ip: number } {
  const Tc = cathodeTemp(t), sat = emission(Tc), vp = plateVoltage(vg, sat);
  return { Tc, sat, vp, ip: plateCurrent(vg, vp, sat) };
}

/** ENIAC (1945), for scale: tubes, crystal diodes, relays, resistors, power (W), mass (kg), additions per second. */
export const ENIAC = { tubes: 17468, diodes: 7200, relays: 1500, resistors: 70000, power: 150e3, mass: 27e3, adds: 5000 };
