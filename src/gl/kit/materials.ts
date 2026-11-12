// Materials for the studio renderer: a small physically based set (base colour, metalness, roughness, transmission,
// emission, clear coat), each preset tuned by eye against reference photographs of the real stuff. A colour may be a
// CSS token resolved per theme by the stage (so a model's palette follows light and dark like the rest of the site).

import type { RGB } from '../instances';

export type Colour = RGB | `--${string}`;

export interface Material {
  /** Albedo (sRGB) or, for a metal, its reflectance colour. */
  base: Colour;
  /** 0 dielectric … 1 metal. */
  metal: number;
  /** 0 mirror … 1 chalk. */
  rough: number;
  /** 0 opaque … 1 clear glass (drawn in the glass pass: fresnel, reflections, what is behind it bent a little). */
  transmit?: number;
  /** Glass's colour at a thickness: how much a ray through it keeps (1 clear); also a mica's silver. */
  tint?: Colour;
  /** Light given off (sRGB) and how strongly (≥ 0; 1 is a part lit as bright as white paper). */
  emit?: Colour; glow?: number;
  /** A clear lacquer over the base (bakelite's shine, enamel): its strength 0..1. */
  coat?: number;
  /** A name for the hover card ("nickel, carbonized"). */
  label?: string;
}

const make = (m: Material): Material => m;

/** The presets. Roughness and colours were set side by side with photographs (sources in docs/3D.md once adopted). */
export const M = {
  make,
  tint: (m: Material, base: Colour, label?: string): Material => ({ ...m, base, label: label ?? m.label }),
  glow: (m: Material, emit: Colour, glow: number): Material => ({ ...m, emit, glow }),

  steel: make({ base: [0.56, 0.57, 0.58], metal: 1, rough: 0.35, label: 'steel' }),
  nickel: make({ base: [0.66, 0.61, 0.53], metal: 1, rough: 0.28, label: 'nickel' }),
  /** A tube plate: nickel or steel blackened to radiate heat, a dull grey with a little sheen. */
  nickelCarbonized: make({ base: [0.2, 0.2, 0.21], metal: 0.4, rough: 0.6, label: 'carbonized nickel' }),
  copper: make({ base: [0.95, 0.64, 0.54], metal: 1, rough: 0.3, label: 'copper' }),
  brass: make({ base: [0.91, 0.78, 0.42], metal: 1, rough: 0.32, label: 'brass' }),
  gold: make({ base: [1.0, 0.77, 0.34], metal: 1, rough: 0.22, label: 'gold' }),
  aluminium: make({ base: [0.91, 0.92, 0.92], metal: 1, rough: 0.4, label: 'aluminium' }),
  tungsten: make({ base: [0.5, 0.49, 0.47], metal: 1, rough: 0.45, label: 'tungsten' }),
  solder: make({ base: [0.75, 0.75, 0.74], metal: 1, rough: 0.5, label: 'solder' }),
  /** The getter's barium mirror: a near-black metal film on the inside of the glass. */
  getterFlash: make({ base: [0.35, 0.33, 0.3], metal: 1, rough: 0.12, label: 'barium getter film' }),

  glass: make({ base: [0.9, 0.93, 0.92], metal: 0, rough: 0.04, transmit: 0.95, tint: [0.93, 0.97, 0.95], label: 'soda-lime glass' }),
  glassAmber: make({ base: [0.9, 0.7, 0.4], metal: 0, rough: 0.05, transmit: 0.85, tint: [0.95, 0.75, 0.45], label: 'amber glass' }),
  quartz: make({ base: [0.95, 0.96, 0.97], metal: 0, rough: 0.03, transmit: 0.97, tint: [0.98, 0.99, 1.0], label: 'quartz' }),
  mica: make({ base: [0.72, 0.68, 0.6], metal: 0, rough: 0.25, transmit: 0.55, tint: [0.85, 0.8, 0.7], label: 'mica' }),

  /** Basing cement: the plaster that glues a bulb into its base. */
  cement: make({ base: [0.72, 0.68, 0.6], metal: 0, rough: 0.85, label: 'basing cement' }),
  ceramic: make({ base: [0.9, 0.88, 0.83], metal: 0, rough: 0.55, label: 'alumina ceramic' }),
  porcelain: make({ base: [0.93, 0.93, 0.92], metal: 0, rough: 0.15, coat: 0.6, label: 'glazed porcelain' }),
  bakelite: make({ base: [0.15, 0.085, 0.05], metal: 0, rough: 0.45, coat: 0.5, label: 'bakelite (phenolic)' }),
  phenolicPaper: make({ base: [0.55, 0.38, 0.2], metal: 0, rough: 0.6, label: 'phenolic paper' }),
  enamel: make({ base: [0.6, 0.25, 0.1], metal: 0, rough: 0.3, coat: 0.7, label: 'enamelled wire' }),
  rubber: make({ base: [0.08, 0.08, 0.08], metal: 0, rough: 0.85, label: 'rubber' }),
  plasticMatte: make({ base: [0.3, 0.3, 0.32], metal: 0, rough: 0.7, label: 'plastic' }),
  plasticGloss: make({ base: [0.3, 0.3, 0.32], metal: 0, rough: 0.2, coat: 0.4, label: 'gloss plastic' }),
  epoxy: make({ base: [0.09, 0.09, 0.1], metal: 0, rough: 0.6, label: 'epoxy mould compound' }),
  fr4: make({ base: [0.2, 0.42, 0.18], metal: 0, rough: 0.45, coat: 0.3, label: 'FR-4 with solder mask' }),

  silicon: make({ base: [0.42, 0.44, 0.5], metal: 0.4, rough: 0.2, label: 'silicon' }),
  oxide: make({ base: [0.55, 0.62, 0.78], metal: 0, rough: 0.15, transmit: 0.4, tint: [0.8, 0.85, 1.0], label: 'silicon dioxide' }),
  polysilicon: make({ base: [0.55, 0.4, 0.38], metal: 0.2, rough: 0.4, label: 'polysilicon' }),
  /** Barium-strontium oxide on a cathode sleeve: chalk white, dead matte. */
  cathodeOxide: make({ base: [0.86, 0.84, 0.8], metal: 0, rough: 0.9, label: 'barium-strontium oxide coating' }),

  paint: (base: Colour, rough = 0.5): Material => make({ base, metal: 0, rough, label: 'paint' }),
} as const;

/** A glowing body's colour at temperature T (K): dull red from ~700 K, orange by 1100 K, a near-white past 2000 K
 *  (a blackbody, eye-weighted and normalized; enough for a cathode, a filament, a heater). */
export function heatColour(T: number): RGB {
  const t = Math.max(0, Math.min(1, (T - 700) / 1600));
  return [1, 0.18 + 0.72 * t ** 0.8, 0.02 + 0.75 * t ** 1.6];
}
/** How bright a body at T glows, relative to one at 1300 K (Stefan–Boltzmann in the visible: very steep). */
export const heatGlow = (T: number) => (T < 650 ? 0 : Math.min(6, ((T - 650) / 650) ** 4 * 1.6));
