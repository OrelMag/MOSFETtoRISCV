// Device physics behind the MOSFET cross-section: the square-law model and what it implies along
// the channel (inversion charge, carrier speed, pinch-off). Pure functions, so the animation is
// computed from the same model as the current readout and can be tested without a DOM.
// x runs from the source (0) to the drain (1) in units of the channel length L.

export const VDD = 1.8;
export const VT = 0.45;
export const K = 220; // µA/V² (k'·W/L), a plausible small device
export const LAMBDA = 0.05; // channel-length modulation, 1/V

export type Region = 'cut' | 'lin' | 'sat';

export function current(vov: number, vds: number): { id: number; region: string; kind: Region } {
  if (vov <= 0) return { id: 0, kind: 'cut', region: 'cut-off: no channel, no current' };
  // (1 + λ·Vds) in both regions, as SPICE's level-1 model does: applied to saturation alone, the
  // current would jump by λ·Vds where the two regions meet.
  const clm = 1 + LAMBDA * vds;
  if (vds < vov) return { id: K * (vov * vds - (vds * vds) / 2) * clm, kind: 'lin', region: 'linear: the channel acts like a resistor' };
  return { id: (K / 2) * vov * vov * clm, kind: 'sat', region: 'saturation: the channel pinches off near the drain' };
}

/** Illustrative capacitances for "what one switch costs": the gate of a unit-width transistor, and the
 *  wire to the loads. In fF; µA / fF = 1 V/ns, and fF · V² = fJ. */
export const C_GATE = 1;
export const C_WIRE = 1;

/** The load on an output driving `fanout` CMOS inputs (an NMOS and a PMOS gate each) plus its wire. */
export const loadOf = (fanout: number): number => fanout * 2 * C_GATE + C_WIRE;

/** An NMOS of width `w` (unit transistors in parallel) discharging `cLoad` fF from VDD, its gate at VDD
 *  from t = 0: dV/dt = −w·I(Vov, V) / C. Samples every `every` ps up to `tMax`; t50 is the time to VDD / 2. */
export function discharge(w: number, cLoad: number, tMax = 120, every = 1): { t: number[]; v: number[]; t50: number } {
  const dt = 0.01, vov = VDD - VT, t = [0], v = [VDD];
  let vo = VDD, t50 = Infinity;
  for (let i = 1; i * dt <= tMax + 1e-9; i++) {
    const next = Math.max(0, vo - ((w * current(vov, vo).id) / cLoad) * 1e-3 * dt);
    if (t50 === Infinity && next <= VDD / 2) t50 = (i - 1 + (vo - VDD / 2) / (vo - next)) * dt;
    vo = next;
    if (Math.abs((i * dt) / every - Math.round((i * dt) / every)) < 1e-6) { t.push(i * dt); v.push(vo); }
  }
  return { t, v, t50 };
}

/** Where the inversion layer ends. In saturation the pinch-off point moves toward the source as
 *  Vds rises; the shorter channel is exactly what the (1 + λ·Vds) factor in `current` models. */
export function pinchPoint(vov: number, vds: number): number {
  return vov > 0 && vds >= vov ? 1 / (1 + LAMBDA * vds) : 1;
}

/** Inversion charge per unit area at x, as a voltage (Q / Cox = Vov − V(x)). Gradual-channel
 *  approximation: Q·dV/dx is the same everywhere (the current is), which integrates to
 *  Q(x)² = Vov² − x·(2·Vov·Vds − Vds²). At the source Q = Vov; at the drain Vov − Vds, or 0 once
 *  Vds ≥ Vov (pinched off). */
export function channelCharge(vov: number, vds: number, x: number): number {
  if (vov <= 0) return 0;
  // Past the pinch-off point u stays at 1, where the saturated charge is 0.
  const u = Math.min(1, Math.max(0, x) / pinchPoint(vov, vds));
  const v = Math.min(vds, vov);
  return Math.sqrt(Math.max(0, vov * vov - u * (2 * vov * v - v * v)));
}

/** Minimum charge used for speeds: near pinch-off the channel is thin and carriers are fast, but
 *  not infinitely (in reality velocity saturates). */
export const Q_MIN = 0.06;

/** Carrier drift speed in channel lengths per second of animation, ∝ the field dV/dx = I / (K·Q).
 *  The same current through a thinner channel means faster carriers. */
export function carrierVelocity(id: number, q: number, scale = 2): number {
  return id <= 0 ? 0 : (scale * id) / (K * Math.max(q, Q_MIN));
}

/** Depth of the depletion layer under the gate as a fraction of its maximum. It grows as √V up
 *  to threshold, then stops: further gate charge is balanced by the inversion layer instead. */
export function depletionDepth(vgs: number): number {
  return Math.sqrt(Math.min(Math.max(vgs, 0), VT) / VT);
}

export const ease = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** A value moving from `from` to `to` over `ms`, starting at `t0` (performance.now() time). */
export function tween(from: number, to: number, t0: number, ms: number): (now: number) => { v: number; done: boolean } {
  return (now) => {
    const t = ms > 0 ? (now - t0) / ms : 1;
    return t >= 1 ? { v: to, done: true } : { v: from + (to - from) * ease(t), done: false };
  };
}
