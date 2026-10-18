// A telephone relay as a lumped model, the one behind the relay close-up (Phase 14a). DOM-free, so the
// close-up, the simulator's relay step and the tests all read the same numbers.
//
// Electrical: the coil's flux linkage λ obeys dλ/dt = V − Rc·i, and i follows from λ through a saturating
// magnetic circuit whose reluctance falls as the gap closes (so L rises: the current dips while the armature
// moves). Mechanical: the pull φ² / (2 µ0 A) acts on the armature (mass on a preloaded spring, damped, end stops);
// the contact blade is a second mass coupled to it by a spring, striking the fixed contact through a compliant,
// damped contact whose damping gives the restitution e. At switch-off the coil discharges through a quench
// resistor, so its terminal voltage spikes to −Rq·i. Pull-in time, bounce and hysteresis come out of the model.

const MU0 = 4e-7 * Math.PI;

export interface RelayParams {
  /** Coil resistance (Ω), turns, pole area (m²). */
  Rc: number; N: number; A: number;
  /** Gaps (m): open air gap, residual gap (non-magnetic shim), iron path as equivalent air gap. */
  gOpen: number; gRes: number; gIron: number;
  /** Flux at which the iron saturates (Wb). */
  phiSat: number;
  /** Armature: mass (kg), return spring (N/m), preload (N), damping (N·s/m), travel to the stop (m). */
  m: number; k: number; F0: number; c: number; travel: number;
  /** Contact blade: mass (kg), coupling spring to the armature (N/m), damping (N·s/m). */
  mb: number; kb: number; cb: number;
  /** Blade position where it meets the NO contact (m), and the contact's coefficient of restitution. */
  yc: number; e: number;
  /** Quench resistor across the coil (Ω). */
  Rq: number;
}

export const RELAY: RelayParams = {
  Rc: 400, N: 3000, A: 1e-4, gOpen: 0.8e-3, gRes: 0.05e-3, gIron: 0.05e-3, phiSat: 1.4e-4,
  m: 3e-3, k: 1333, F0: 1.0, c: 0.4, travel: 0.75e-3, mb: 0.4e-3, kb: 900, cb: 0.02, yc: 0.45e-3, e: 0.55, Rq: 4000,
};

/** The nominal supply (V). */
export const RELAY_SUPPLY = 24;
/** Timeline (s): integration step, switch-on, switch-off, end; a sample is kept every SAMPLE_EVERY steps (0.1 ms). */
export const DT = 1e-6;
export const T_ON = 0.5e-3;
export const T_OFF = 15e-3;
export const T_END = 25e-3;
export const SAMPLE_EVERY = 100;
/** Contact stiffness (N/m): stiff enough to be brief, soft enough for a 1 µs step. */
export const KC = 3e5;

/** The coil's power at the nominal supply (W): 24² / 400. */
export const RELAY_COIL_POWER = (RELAY_SUPPLY * RELAY_SUPPLY) / RELAY.Rc;
/** One relay step for the simulator (ms): the settled time at 24 V (bounce included), rounded to 0.1 ms.
 *  A constant, not computed at import (25 000 steps); tests/phys-relay.test.ts keeps it equal to the model's. */
export const RELAY_STEP_MS = 8.2;

/** Zuse's Z3 (1941), for scale: relays (of them memory), power (W), mass (kg), clock (Hz). */
export const Z3 = { relays: 2600, memory: 1408, power: 4e3, mass: 1e3, hz: 5 };
/** A relay rack (m): 2 m high, 0.8 m wide, 0.5 m deep, 800 relays on its shelves (illustrative). */
export const RELAY_RACK = { w: 0.8, d: 0.5, h: 2.0, relays: 800 };

export interface RelaySample {
  /** Time (s), coil current (A), armature travel (m, 0 = open), blade position (m), NO contact closed,
   *  coil terminal voltage (V). */
  t: number; i: number; x: number; y: number; closed: boolean; vTerm: number;
}

export interface RelayEvent { t: number; closed: boolean }

export interface RelayRun {
  V: number;
  /** Every 0.1 ms from 0 to T_END (251 samples). */
  s: RelaySample[];
  /** Every change of the NO contact, at its exact step. */
  ev: RelayEvent[];
}

/** Reluctance of the magnetic circuit with the armature moved by x. */
const reluct = (p: RelayParams, x: number) => (p.gOpen - x + p.gRes + p.gIron) / (MU0 * p.A);
/** Current for flux linkage λ: the inverse of φ = φsat·tanh(N·i / (ℜ·φsat)). */
const iOf = (p: RelayParams, lam: number, rm: number) => {
  const q = Math.max(-0.999999, Math.min(0.999999, lam / (p.N * p.phiSat)));
  return ((rm * p.phiSat) / p.N) * Math.atanh(q);
};
const phiOf = (p: RelayParams, ni: number, rm: number) => p.phiSat * Math.tanh(ni / (rm * p.phiSat));

/** Supply V from T_ON to T_OFF, then the coil discharges through the quench resistor. Semi-implicit Euler, 1 µs. */
export function relaySim(V: number, p: RelayParams = RELAY): RelayRun {
  let lam = 0, x = 0, v = 0, y = 0, vy = 0, was = false;
  const s: RelaySample[] = [], ev: RelayEvent[] = [];
  // Contact damping for restitution e of the mass mb on KC (a damped half-oscillation loses (1 − e) of its speed).
  const le = Math.log(p.e);
  const cc = (-2 * le * Math.sqrt(KC * p.mb)) / Math.sqrt(Math.PI ** 2 + le * le);
  const steps = Math.round(T_END / DT);
  for (let n = 0; n <= steps; n++) {
    const t = n * DT, on = t >= T_ON && t < T_OFF, rm = reluct(p, x), i = iOf(p, lam, rm);
    const vTerm = on ? V : -p.Rq * i;
    lam += (on ? V - p.Rc * i : -(p.Rc + p.Rq) * i) * DT;
    const phi = lam / p.N, F = (phi * phi) / (2 * MU0 * p.A);
    v += ((F - (p.F0 + p.k * x) - p.c * v) / p.m) * DT;
    x += v * DT;
    if (x < 0) { x = 0; if (v < 0) v = 0; }
    if (x > p.travel) { x = p.travel; if (v > 0) v = -0.2 * v; }
    vy += ((p.kb * (x - y) - p.cb * vy) / p.mb) * DT;
    y += vy * DT;
    const pen = y - p.yc, closed = pen > 0;
    if (closed) vy += ((-(KC * pen) - cc * vy) / p.mb) * DT;
    if (closed !== was) { ev.push({ t, closed }); was = closed; }
    if (n % SAMPLE_EVERY === 0) s.push({ t, i, x, y, closed, vTerm });
  }
  return { V, s, ev };
}

/** The magnet's settled pull (N) on the armature at supply V (current V / Rc) with the armature moved by x. */
export function relayPull(V: number, x: number, p: RelayParams = RELAY): number {
  const q = phiOf(p, (p.N * V) / p.Rc, reluct(p, x));
  return (q * q) / (2 * MU0 * p.A);
}

/** Static thresholds, 10 mV apart: the lowest supply whose pull at full gap beats the preload (pull-in), and the
 *  highest whose pull at the closed gap no longer holds the stretched spring (drop-out). */
export function relayStatic(p: RelayParams = RELAY): { pull: number | null; drop: number | null } {
  const f = (V: number, x: number) => relayPull(V, x, p);
  let pull: number | null = null, drop: number | null = null;
  for (let V = 0; V <= 40; V += 0.01) if (f(V, 0) > p.F0) { pull = V; break; }
  for (let V = 40; V >= 0; V -= 0.01) if (f(V, p.travel) < p.F0 + p.k * p.travel) { drop = V; break; }
  return { pull, drop };
}

export interface RelaySummary {
  /** Times in seconds after switch-on (first touch, settled) or switch-off (release); null: never. */
  firstTouch: number | null;
  /** Openings of the NO contact while the coil is on. */
  bounces: number;
  settled: number | null;
  release: number | null;
  /** Most negative coil terminal voltage (V), the turn-off spike. */
  spike: number;
  /** Coil power while on (W). */
  power: number;
}

export function relaySummary(run: RelayRun, p: RelayParams = RELAY): RelaySummary {
  const { ev } = run, onEv = ev.filter((e) => e.t < T_OFF);
  const first = ev.find((e) => e.closed), last = onEv.filter((e) => e.closed).at(-1);
  const rel = ev.find((e) => e.t > T_OFF && !e.closed);
  let spike = 0;
  for (const q of run.s) spike = Math.min(spike, q.vTerm);
  return {
    firstTouch: first ? first.t - T_ON : null,
    bounces: first ? onEv.filter((e) => !e.closed).length : 0,
    settled: last ? last.t - T_ON : null,
    release: rel ? rel.t - T_OFF : null,
    spike,
    power: (run.V * run.V) / p.Rc,
  };
}
