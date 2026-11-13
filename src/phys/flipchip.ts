// A lidded flip-chip package's two numbers (DOM-free, tested): the inductance of a solder bump against a bond wire, and the
// thermal resistance of the stack the heat crosses from the die to the lid. Chapter wire's "From the pad to the pin" sets a
// 2.8 mm bond wire's 3 nH against its ground bounce; a flip chip has no wire: each pad sits on a bump a few tens of
// micrometres tall, and pads cover the die's whole face, so the grounds are counted in hundreds.
//
// The bump is a short round conductor (length close to its radius), where Grover's long-wire form L = 0.2·l·[ln(2l/r) − 0.75]
// fails; the partial self-inductance of a finite straight round conductor (Grover, "Inductance Calculations", ch. 6; the
// form below reduces to the long-wire one as l/r grows) holds at any l/r:
//   L = 0.2·l·[ln(l/r + √(1 + (l/r)²)) − √(1 + (r/l)²) + r/l + 1/4]   nH, l and r in mm (μ0/2π = 0.2 nH/mm).
// The substrate's vias and planes between a bump and its ball add their own inductance, typically more than the bump's and
// still far below a bond wire's; the model leaves them out and says so.
//
// The stack is one dimensional: R = t / (k·A) per layer over the die's area, in series (no spreading in the lid, no path
// down through the balls). k: silicon 148, copper 390 W/m·K (handbook values); a polymer thermal interface ~4 W/m·K (an
// illustrative middle of the 1–10 a polymer TIM spans; indium solder TIM ~80).

/** Partial self-inductance of a straight round conductor of length l and radius r (mm), in nH. */
export function roundL(lMm: number, rMm: number): number {
  const a = lMm / rMm;
  return 0.2 * lMm * (Math.log(a + Math.sqrt(1 + a * a)) - Math.sqrt(1 + 1 / (a * a)) + 1 / a + 0.25);
}

/** Grover's long-wire form, the one chapter wire quotes for the bond wire (l ≫ r). */
export const wireL = (lMm: number, rMm: number): number => 0.2 * lMm * (Math.log((2 * lMm) / rMm) - 0.75);

/** The bump drawn: a solder column 70 µm tall, 45 µm in radius (illustrative: C4 bumps are 60–100 µm across), at 150 µm pitch. */
export const BUMP = { h: 0.07, r: 0.045, pitch: 0.15 };
/** The bond wire chapter wire quotes: 2.8 mm of 25 µm gold. */
export const BOND = { l: 2.8, r: 0.0125 };

export const bumpNh = (): number => roundL(BUMP.h, BUMP.r);
export const bondNh = (): number => wireL(BOND.l, BOND.r);

/** n identical paths in parallel (no mutual inductance: an optimistic bound, as chapter wire's package3d also says). */
export const parallelNh = (lNh: number, n: number): number => lNh / Math.max(1, n);

export interface Layer { name: string; tMm: number; k: number }
/** The heat's path up from the transistors, over the die's area. Die and lid from the drawing (derived), the TIM illustrative. */
export const STACK: Layer[] = [
  { name: 'silicon die', tMm: 0.727, k: 148 },
  { name: 'thermal interface (TIM1, polymer)', tMm: 0.05, k: 4 },
  { name: 'copper lid', tMm: 0.75, k: 390 },
];
/** R = t / (k·A) in K/W for a layer over an area of aMm2. */
export const layerR = (l: Layer, aMm2: number): number => (l.tMm * 1e-3) / (l.k * aMm2 * 1e-6);
/** The series sum. */
export const stackR = (layers: Layer[], aMm2: number): number => layers.reduce((s, l) => s + layerR(l, aMm2), 0);
