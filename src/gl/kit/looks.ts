// A model's look on the studio renderer, as data (phase 0 of the 3D pass): how bright it is drawn, where its key light
// stands, and what today's three part finishes (matte, satin, metal: chosen by a part's `spec`) become as materials.
// Each model's file names its look (a family preset, maybe with its own adjustments), so moving a model to the studio
// changes no geometry. No imports: a model's chunk carries a few numbers, never the renderer.

export interface PartLook {
  /** Exposure before the tone curve (1 = neutral). Palettes tuned under the old half-Lambert light want a little less. */
  exposure?: number;
  /** Towards the key light (world, need not be unit). */
  keyDir?: [number, number, number];
  /** spec at and above which a part is satin, and metal (the old renderer's "polished metal" was about 0.4). */
  satinFrom?: number; metalFrom?: number;
  matte?: { rough?: number };
  satin?: { rough?: number; coat?: number };
  metal?: { metal?: number; rough?: number };
}

/** The families: what the models in each are made of, and how a photograph of them is lit. */
export const LOOKS = {
  /** Brass, steel, wood and bakelite under a high key light from the left: machines and instruments. */
  machine: { exposure: 0.95, keyDir: [-0.45, 0.85, 0.35], matte: { rough: 0.62 }, satin: { rough: 0.34, coat: 0.3 }, metal: { metal: 0.9, rough: 0.27 } },
  /** Layers of silicon, oxide and metal read by their colours: a steep key, gentle gloss, metal kept from going dark. */
  silicon: { exposure: 0.9, keyDir: [-0.3, 0.92, 0.25], matte: { rough: 0.55 }, satin: { rough: 0.3, coat: 0.35 }, metal: { metal: 0.75, rough: 0.33 } },
  /** Glass envelopes, screens and polished cans on a bench: a lower, raking key for the highlights. */
  lab: { exposure: 0.95, keyDir: [-0.55, 0.7, 0.45], matte: { rough: 0.6 }, satin: { rough: 0.28, coat: 0.4 }, metal: { metal: 0.85, rough: 0.24 } },
  /** Diagrams in solid colours (analogies, fields, cables): matte, softly lit, colours as drawn. */
  field: { exposure: 0.85, keyDir: [-0.35, 0.85, 0.4], matte: { rough: 0.8 }, satin: { rough: 0.5, coat: 0.15 }, metal: { metal: 0.5, rough: 0.4 } },
} as const satisfies Record<string, PartLook>;

/** A family's look with a model's own adjustments. */
export const lookOf = (family: keyof typeof LOOKS, own: PartLook = {}): PartLook => ({ ...LOOKS[family], ...own });
