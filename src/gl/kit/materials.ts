// Materials for the studio renderer: a small physically based set (base colour, metalness, roughness, transmission,
// emission, clear coat), each preset tuned by eye against reference photographs of the real stuff. A colour may be a
// CSS token resolved per theme by the stage (so a model's palette follows light and dark like the rest of the site).

import type { RGB } from '../instances';

export type Colour = RGB | `--${string}`;

/** A data surface: pixels the model writes each tick (a CRT's phosphor, a sensor's picture, a Williams tube's dots, a
 *  card's holes). The one texture the renderer takes: data, never imagery. Bump rev after writing pixels. */
export interface DataTex {
  w: number; h: number;
  /** RGBA, w × h × 4. */
  pixels: Uint8Array;
  rev: number;
  /** emit: the pixels glow (a screen); albedo: they colour the surface; mask: alpha < 128 is a hole (discarded). */
  mode: 'emit' | 'albedo' | 'mask';
  /** Sharp pixels (default) or smoothed. */
  smooth?: boolean;
}

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
  /** Additive light that writes no depth: a ray of light, a beam of UV, a current's path, a lamp's glow. */
  beam?: boolean;
  /** A data surface on the geometry's texture coordinates (Geo.uvs). */
  data?: DataTex;
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
  /** Light as a material: additive, soft, no depth write (glow k). */
  beam: (colour: Colour, k = 1, label = 'light'): Material => make({ base: [0, 0, 0], metal: 0, rough: 1, emit: colour, glow: k, beam: true, label }),

  silver: make({ base: [0.97, 0.96, 0.91], metal: 1, rough: 0.18, label: 'silver' }),
  nickelSilver: make({ base: [0.78, 0.76, 0.7], metal: 1, rough: 0.3, label: 'nickel silver' }),
  permalloy: make({ base: [0.62, 0.6, 0.57], metal: 1, rough: 0.35, label: 'permalloy' }),
  mercury: make({ base: [0.78, 0.78, 0.78], metal: 1, rough: 0.04, label: 'mercury' }),
  oak: make({ base: [0.56, 0.4, 0.24], metal: 0, rough: 0.6, coat: 0.3, label: 'oak (untextured)' }),
  card: make({ base: [0.9, 0.85, 0.72], metal: 0, rough: 0.85, label: 'card stock' }),
  silicide: make({ base: [0.5, 0.48, 0.5], metal: 0.8, rough: 0.4, label: 'silicide' }),
  silverEpoxy: make({ base: [0.7, 0.7, 0.68], metal: 0.5, rough: 0.55, label: 'silver-filled epoxy' }),
  /** Silicon dioxide on silicon, coloured by thin-film interference at its thickness (nm): the colours of a wafer. */
  oxideFilm: (nm: number): Material => make({ base: oxideColour(nm), metal: 0, rough: 0.12, coat: 0.6, label: `silicon dioxide, ${nm} nm` }),
} as const;

/** A black body's colour at temperature T (K), normalized to its brightest channel (Tanner Helland's fit to the
 *  CIE blackbody locus, extended below 1000 K towards deep red): a cathode at 1023 K is orange-red, a lamp at 2700 K warm
 *  white. */
export function heatColour(T: number): RGB {
  const t = Math.max(6, T / 100);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const c = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(b)];
}
/** How bright (emission, linear) a body at T glows: nothing a reader sees below ~700 K, a dull glow at 900 K, bright by
 *  1200 K (the visible part of the black-body spectrum rises steeply). */
export const heatGlow = (T: number) => (T < 700 ? 0 : Math.min(6, ((T - 700) / 400) ** 3 * 1.1));

/** The interference colour of a SiO₂ film of d nm on silicon (n 1.46; three wavelengths, idealized reflectance). */
export function oxideColour(d: number): RGB {
  const at = (lambda: number) => 0.5 - 0.42 * Math.cos((4 * Math.PI * 1.46 * d) / lambda);
  return [at(640), at(540), at(450)];
}

/** Colour ramps for a scalar 0..1 painted per vertex (Geo.colors): cold blue to hot yellow, and blue–white–red. */
export const heatRamp = (x: number): RGB => { const t = Math.max(0, Math.min(1, x)); return [Math.min(1, 0.2 + 1.6 * t), Math.max(0, Math.min(1, 1.8 * t - 0.5)), Math.max(0, 0.6 - 1.2 * t + Math.max(0, 2 * t - 1.6))]; };
export const divergingRamp = (x: number): RGB => { const t = Math.max(-1, Math.min(1, x)); return t < 0 ? [1 + t * 0.8, 1 + t * 0.6, 1] : [1, 1 - t * 0.7, 1 - t * 0.8]; };
