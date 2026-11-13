// The optics the stack model traces with, from the chapter's module (phys/imagesensor.ts) where it has them. DOM-free.
//
// - Absorption depth 1/α: imagesensor.ts absorptionDepth (Green 2008, table 1).
// - Silicon's refractive index n(λ): the same paper's table 1 (M. A. Green, Sol. Energy Mater. Sol. Cells 92 (2008)
//   1305–1310), every 50 nm, linear between points.
// - The colour filters: illustrative passbands, not a measured product's curves (they are not published for the
//   IMX183). Each is a smooth band centred where the chapter's IMX183 colour QE peaks (imagesensor.ts IMX183.qeRgb: blue
//   470, green 525, red 640 nm) with a 0.9 peak transmission; the red filter stays open into the near infrared and the
//   blue and green ones leak a little there, as pigment filters do: why a camera adds an infrared-cut filter.

import { IMX183, absorptionDepth, type Cfa } from '../phys/imagesensor';
import type { StackOptics } from './sensorstack3dgeom';

/** n of intrinsic silicon at 300 K (Green 2008, table 1). */
export const N_SI: readonly (readonly [number, number])[] = [
  [400, 5.57], [450, 4.67], [500, 4.29], [550, 4.08], [600, 3.94], [650, 3.85], [700, 3.78], [750, 3.73],
  [800, 3.68], [850, 3.65], [900, 3.62], [950, 3.60], [1000, 3.57], [1050, 3.56], [1100, 3.54],
];
export function nSi(nm: number): number {
  const t = N_SI;
  if (nm <= t[0][0]) return t[0][1];
  if (nm >= t[t.length - 1][0]) return t[t.length - 1][1];
  let i = 0;
  while (t[i + 1][0] < nm) i++;
  const [x0, a] = t[i], [x1, b] = t[i + 1];
  return a + ((nm - x0) / (x1 - x0)) * (b - a);
}

const PEAK = 0.9, WIDTH = 40;
const CENTRE: Record<Cfa, number> = { B: IMX183.qeRgb.b[1], G: IMX183.qeRgb.g[1], R: IMX183.qeRgb.r[1] };
/** Illustrative filter transmission (see the header). */
export function filterT(c: Cfa, nm: number): number {
  const band = PEAK * Math.exp(-(((nm - CENTRE[c]) / WIDTH) ** 2));
  if (c === 'R') return nm >= CENTRE.R ? PEAK : band;
  // Blue and green pigments open again past about 800 nm.
  const ir = PEAK * Math.min(1, Math.max(0, (nm - 780) / 120));
  return Math.max(band, ir);
}

export const STACK_OPTICS: StackOptics = { depthUm: absorptionDepth, nSi, filterT };
