// The electric field inside one 6SN7 section, for the close-up's cut face (DOM-free, tested). A planar triode: the
// cathode a plane at 0 V, the grid a row of wires of radius r at pitch a, a distance d1 out, the plate a plane at d2.
// The textbook solution (Spangenberg, Vacuum Tubes, ch. 7): a uniform field plus the row of line charges and its image
// in the cathode,
//   φ(u, y) = E0·u + λ·[L(u − d1, y) − L(u + d1, y)],  L(w, y) = ln(cosh(2πw/a) − cos(2πy/a)),
// exact on the cathode (φ = 0 at u = 0), on the wire and, while (d2 − d1) ≫ a/2π, on the plate. Two conditions (the wire
// at vg, the plate at vp) fix E0 and λ. Laplace only: no space charge (the cloud would push the potential next to the
// cathode lower still), so this is the field the electrodes alone set up.
//
// The mean field on the cathode is linear in vg and vp; its ratio of the two is the amplification factor. The drawn
// spacings are illustrative, and the wire radius is the one free number: it is chosen so the geometry gives the µ of
// phys/triode.ts, so the field turns over at the cathode exactly where the lumped model cuts off (vg = −vp / µ).

import { MU } from './triode';

export interface TriodeGeometry {
  /** Cathode surface to grid wires, cathode surface to plate, wire pitch (mm). */
  d1: number; d2: number; a: number;
}

const TAU = 2 * Math.PI;
/** ln(cosh(x) − cos(y)) without overflow at large |x|. */
function lnRow(x: number, y: number): number {
  const ax = Math.abs(x);
  if (ax > 20) return ax - Math.LN2;
  return Math.log(Math.max(1e-300, Math.cosh(x) - Math.cos(y)));
}
const L = (g: TriodeGeometry, w: number, y: number) => lnRow((TAU * w) / g.a, (TAU * y) / g.a);

/** The coefficients of the two conditions at wire radius r: the wire's (E0·d1' + λ·α = vg) and the plate's (E0·d2 − λ·c = vp). */
function terms(g: TriodeGeometry, r: number) {
  const d1r = g.d1 + r, alpha = L(g, r, 0) - L(g, 2 * g.d1 + r, 0), c = (2 * TAU * g.d1) / g.a;
  return { d1r, alpha, c };
}

/** The amplification factor of the geometry with wires of radius r: (∂E_k/∂vg) / (∂E_k/∂vp), E_k the cathode's mean field. */
export function muOf(g: TriodeGeometry, r: number): number {
  const { d1r, alpha, c } = terms(g, r);
  return (c * (g.d2 - g.d1)) / g.d1 / (-alpha - (c * d1r) / g.d1);
}

/** The wire radius (mm) that gives the geometry an amplification factor mu (bisection: µ falls as the wire thins). */
export function wireRadiusFor(g: TriodeGeometry, mu = MU): number {
  let lo = 1e-6, hi = g.a * 0.45;
  for (let k = 0; k < 80; k++) {
    const m = Math.sqrt(lo * hi);
    if (muOf(g, m) > mu) hi = m;
    else lo = m;
  }
  return Math.sqrt(lo * hi);
}

export interface TriodeField {
  g: TriodeGeometry; r: number; vg: number; vp: number;
  /** The uniform part and the line charge's strength. */
  E0: number; lambda: number;
  /** The mean field on the cathode (V/mm): positive draws electrons off it. */
  cathodeField: number;
  /** The potential (V) at u (mm out from the cathode) and y (mm along the section, a wire at y = 0). */
  at(u: number, y: number): number;
}

/** The field with the grid at vg and the plate at vp, wires of radius r (default: the one that gives MU). */
export function triodeField(g: TriodeGeometry, vg: number, vp: number, r = wireRadiusFor(g)): TriodeField {
  const { d1r, alpha, c } = terms(g, r);
  const det = g.d2 * alpha + c * d1r;
  const E0 = (vp * alpha + c * vg) / det, lambda = (g.d2 * vg - d1r * vp) / det;
  return {
    g, r, vg, vp, E0, lambda,
    cathodeField: E0 - (lambda * 2 * TAU) / g.a,
    at: (u, y) => E0 * u + lambda * (L(g, u - g.d1, y) - L(g, u + g.d1, y)),
  };
}

/** Equipotentials drawn: a geometric run of levels, V0·(R^n − 1) (0.3, 0.78, 1.6, 2.8 … 224 V), so the fraction of a volt
 *  between cathode and grid gets lines as the hundreds at the plate do. The level coordinate of a potential (the lines are
 *  its integers; 0 is the cathode's own potential). */
export const CONTOUR_V0 = 0.5, CONTOUR_R = 1.6;
export const levelOf = (v: number): number => (Math.sign(v) * Math.log1p(Math.abs(v) / CONTOUR_V0)) / Math.log(CONTOUR_R);
