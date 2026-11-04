// A chip built mask by mask, as parts (DOM-free, tested): the standard cell of chapter 28's layout step, cut into the
// layers fabWidget adds, in its order. Every rectangle comes from the cell data (silicon.ts CELLS); nothing is drawn
// by hand. Layout x runs across the cell, layout y down it, layout z up; the stage's y is up, so (x, y, z) → (x, z, y).

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, type Anchor, type Part } from '../gl/parts';
import { disjoint } from './cell3d';
import { levels, type Cell, type Layer } from './silicon';

/** The layers a process step can add, in the order they are added. */
export type Stage = Layer;

/** The layer each fab step (silicon.ts FAB, same indices) lands. Null: the cell data has no shape for it. Substrate,
 *  isolation (STI) and the blanket gate stack are not shapes of the cell; lithography only patterns the poly that the
 *  etch step then leaves, so the poly lands at the etch. The channels (a diffusion shape under a gate) are the silicon
 *  under the poly: they are left by that same etch and belong to the poly stage. */
export const LANDS: (Stage | null)[] = [null, 'nwell', null, null, null, 'poly', 'ndiff', 'pdiff', 'contact', 'metal'];
/** The mask in use at each step (null: none of the cell's). Lithography (4) and the etch (5) use the poly mask. */
export const MASK_AT: (Stage | null)[] = [null, 'nwell', null, null, 'poly', 'poly', 'ndiff', 'pdiff', 'contact', 'metal'];
export const STAGE_NAME: Record<Stage, string> = { nwell: 'n-well', poly: 'polysilicon', ndiff: 'n+ diffusion', pdiff: 'p+ diffusion', contact: 'contacts', metal: 'metal 1' };

/** A solid in layout coordinates; `chan` marks a channel (silicon under a gate). */
export interface Solid { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; chan?: boolean }

/** The stage a shape belongs to: exactly one. */
export const stageOf = (s: Cell['shapes'][number]): Stage => (s.gate ? 'poly' : (s.layer as Stage));

/** A layer's rectangles [x, y, w, h] as disjoint pieces, overlapping shapes of one net merged (as layoutWidget's 3D). */
export function layerRects(cell: Cell, st: Stage): [number, number, number, number][] {
  const groups = new Map<string, [number, number, number, number][]>();
  for (const s of cell.shapes) {
    if (s.gate || stageOf(s) !== st) continue;
    const k = st === 'contact' ? `${groups.size}` : s.node ?? '';
    groups.set(k, [...(groups.get(k) ?? []), s.r]);
  }
  return [...groups.values()].flatMap((rs) => (st === 'contact' ? rs : disjoint(rs)));
}

/** Every solid of one stage at the given spread, heights as the layout step's 3D (silicon.ts levels). */
export function stageSolids(cell: Cell, st: Stage, spread: number): Solid[] {
  const z = levels(spread), at = (r: number[], z0: number, z1: number, chan?: boolean): Solid => ({ x0: r[0], x1: r[0] + r[2], y0: r[1], y1: r[1] + r[3], z0, z1, chan });
  const [z0, z1] = st === 'poly' ? [z.poly0, z.poly1] : st === 'metal' ? [z.metal0, z.metal1] : st === 'contact' ? [z.diff, z.metal0] : st === 'nwell' ? [z.sub * 0.55, 0] : [0, z.diff];
  const out = layerRects(cell, st).map((r) => at(r, z0, z1));
  if (st === 'poly') for (const s of cell.shapes) if (s.gate) out.push(at(s.r, 0, z.diff, true));
  return out;
}

export interface MasksState { step: number; spread: number }
export interface MasksPalette { psub: RGB; plate: RGBA; chan: RGB; layer: Record<Stage, RGB> }

const MASK_GAP = 5, PLATE = 0.5, PATTERN = 0.4, MARGIN = 4;

/** Layout (x, y, z) to the stage's coordinates, the cell centred on the origin. */
const place = (c: Cell, x: number, y: number, z: number): Vec3 => [x - c.w / 2, z, y - 22];
const solid = (c: Cell, col: RGB | RGBA, s: Solid): Part => {
  const [x0, y0, z0] = place(c, s.x0, s.y0, s.z0), [x1, y1, z1] = place(c, s.x1, s.y1, s.z1);
  return box(col, x0, x1, Math.min(y0, y1), Math.max(y0, y1), Math.min(z0, z1), Math.max(z0, z1));
};

/** The stage numbers (0 …) up to `step` that have landed. */
export const landed = (step: number): Stage[] => LANDS.slice(0, step + 1).filter((l): l is Stage => l !== null);

/** The mask of a stage as a flat pattern: the layer's own rectangles, on a glass plate above the die. */
export function maskSolids(cell: Cell, st: Stage, spread: number): { plate: Solid; pattern: Solid[] } {
  const z = levels(spread), pz = z.metal1 + MASK_GAP;
  return {
    plate: { x0: -MARGIN, x1: cell.w + MARGIN, y0: -MARGIN, y1: 44 + MARGIN, z0: pz, z1: pz + PLATE },
    pattern: layerRects(cell, st).map((r) => ({ x0: r[0], x1: r[0] + r[2], y0: r[1], y1: r[1] + r[3], z0: pz - PATTERN, z1: pz })),
  };
}

export function masksParts(cell: Cell, st: MasksState, P: MasksPalette): Part[] {
  const z = levels(st.spread), out: Part[] = [], got = landed(st.step), nw = got.includes('nwell');
  // The wafer under everything. The n-well is a pocket in it: the p-type is there until the well is implanted.
  out.push(solid(cell, P.psub, { x0: 0, x1: cell.w, y0: 22, y1: 44, z0: z.sub, z1: 0 }));
  out.push(solid(cell, P.psub, { x0: 0, x1: cell.w, y0: 0, y1: 22, z0: z.sub, z1: z.sub * 0.55 }));
  if (!nw) out.push(solid(cell, P.psub, { x0: 0, x1: cell.w, y0: 0, y1: 22, z0: z.sub * 0.55, z1: 0 }));
  for (const l of got) for (const s of stageSolids(cell, l, st.spread)) out.push(solid(cell, s.chan ? P.chan : P.layer[l], s));
  const m = MASK_AT[st.step];
  if (m) {
    const { plate, pattern } = maskSolids(cell, m, st.spread);
    out.push(...pattern.map((s) => solid(cell, P.layer[m], s)), solid(cell, P.plate, plate));
  }
  return out;
}

/** Labels: the wafer, the layer that just landed (the legend chips name the rest) and the mask. */
export function masksAnchors(cell: Cell, st: MasksState): Anchor[] {
  const z = levels(st.spread), out: Anchor[] = [], front: Vec3 = [0, 0.3, 1];
  out.push({ text: 'p-type wafer', p: place(cell, 0, 44, z.sub / 2), side: 'l', n: front });
  const now = LANDS[st.step];
  if (now) {
    const s = stageSolids(cell, now, st.spread)[0];
    out.push({ text: STAGE_NAME[now], p: place(cell, s.x1, (s.y0 + s.y1) / 2, s.z1), side: 'r', n: [0, 1, 0] });
  }
  const m = MASK_AT[st.step];
  if (m) out.push({ text: `${STAGE_NAME[m]} mask`, p: place(cell, cell.w / 2, 44 + MARGIN, z.metal1 + MASK_GAP), side: 'l', n: [0, 1, 0] });
  return out;
}
