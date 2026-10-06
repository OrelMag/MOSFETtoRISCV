// Device physics behind the MOSFET cross-section: the square-law model and what it implies along
// the channel (inversion charge, carrier speed, pinch-off). Pure functions, so the animation is
// computed from the same model as the current readout and can be tested without a DOM.
// x runs from the source (0) to the drain (1) in units of the channel length L.

export const VDD = 1.8;
export const VT = 0.45;
export const K = 220; // µA/V² (k'·W/L), a plausible small device
export const LAMBDA = 0.05; // channel-length modulation, 1/V

export function current(vov: number, vds: number): { id: number; region: string } {
  if (vov <= 0) return { id: 0, region: 'cut-off: no channel, no current' };
  if (vds < vov) return { id: K * (vov * vds - (vds * vds) / 2), region: 'linear: the channel acts like a resistor' };
  return { id: (K / 2) * vov * vov * (1 + LAMBDA * vds), region: 'saturation: the channel pinches off near the drain' };
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
