// Open blocks as you zoom: the geometry (docs/transparent/DESIGN.md, Revision 3; view/lens.ts draws it). DOM-free, so
// tests/lens-hone.test.ts scripts zoom traces without a page.
//
// The inside is drawn within the box's own outline, letterboxed and centred, and grows on screen only with the view's zoom.
// One rule opens it: the inside's smallest named block, scaled into the box, reaches the legibility floor at the current
// zoom. That makes a box's opening zoom a property of the box alone (its size, its inside): no stage, no neighbours, no
// covers, nothing remembered.
import { orientGeom } from '../sim/geometry';
import { isConstantDef } from '../sim/constant';
import { netlistOf, type ComponentDef } from '../sim/types';
import { nameEligible } from './legible';
import { pinGeoms } from './route';
import { pinGlyphBounds } from './symbols';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

/** The legibility floor (px): a named block's longer side on screen (legible.ts planNames' minBlockPx, where its name is drawn). */
export const FLOOR_PX = 10;
/** Closes below this share of the floor: a wobble across the floor never flickers it. */
export const CLOSE_SHARE = 0.75;
/** Room kept inside the outline around the drawn inside (grid units of the outer level): the box's ports and their stubs. */
export const INSET = 0.6;
/** The crossfade between the symbol and the inside, both ways (ms); none with reduced motion. */
export const FADE_MS = 160;

/** A box on the outer level (grid units) and its inside's extent (inner grid units). */
export interface Fit {
  /** Outer grid units per inner unit: the inside scaled into the box. */
  k: number;
  /** Where the inside's extent sits in the box, outer grid units (letterboxed, centred). */
  x: number; y: number; w: number; h: number;
}

/** The inside scaled into the box's outline, keeping its aspect, centred: the empty bands are the letterbox. */
export function fitInside(box: Rect, extent: Rect): Fit {
  const bw = Math.max(0, box.w - 2 * INSET), bh = Math.max(0, box.h - 2 * INSET);
  const k = extent.w > 0 && extent.h > 0 ? Math.min(bw / extent.w, bh / extent.h) : 0;
  const w = extent.w * k, h = extent.h * k;
  return { k, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** A box opens only once it is this big on its shorter side (px): smaller, its own name and ports are what reads. */
export const BOX_MIN_PX = 64;

/**
 * The view's px per outer unit at which a box opens, the one rule: the box is at least BOX_MIN_PX on its shorter side, and
 * its inside's smallest named block (inner units, longer side), scaled into the box by fit.k, reaches FLOOR_PX. A constant
 * of the box (its size, its inside): it changes only if either is redrawn, never with the stage, the panels or the
 * neighbours.
 */
export function openAtPx(box: Size, k: number, smallestNamed: number): number {
  if (!(k > 0 && smallestNamed > 0)) return Infinity;
  return Math.max(FLOOR_PX / (k * smallestNamed), BOX_MIN_PX / Math.min(box.w, box.h));
}

/**
 * Open or closed at this zoom (`px`: the view's px per outer unit). Outside the band [CLOSE_SHARE·open, open) the answer
 * depends on the geometry alone; inside it, on `prev` alone. Nothing else is state.
 */
export function decide(prev: boolean, px: number, openAt: number): boolean {
  if (px >= openAt) return true;
  if (px < openAt * CLOSE_SHARE) return false;
  return prev;
}

/**
 * Where the hand-off to a drill happens: the drawn inside (the fit, on screen) covers the canvas in width or in height.
 * `fitPx`: the fit's rectangle in canvas px.
 */
export function handsOff(fitPx: Rect, canvas: Size): boolean {
  return fitPx.w >= canvas.w || fitPx.h >= canvas.h;
}

/**
 * The drilled level's view box that shows its drawing exactly where the inside was (no jump): inner point p appears at
 * fitPx.x + (p.x − extent.x)·s, with s = fitPx.w / extent.w screen px per inner unit.
 */
export function handOffView(fitPx: Rect, extent: Rect, canvas: Size): { x: number; y: number; w: number; h: number } {
  const s = fitPx.w / extent.w;
  return { x: extent.x - fitPx.x / s, y: extent.y - fitPx.y / s, w: canvas.w / s, h: canvas.h / s };
}

const smallestMemo = new WeakMap<ComponentDef, number>();
/**
 * The inside's smallest named block (inner grid units, its longer side): the blocks legible.ts would name (a box whose label
 * is worth a name). An inside of gate glyphs only names none: then its smallest part, so the gates read. 0: nothing to draw.
 * From the netlist, not the drawing (it never changes with the zoom), memoized per definition.
 */
export function smallestNamed(def: ComponentDef): number {
  const hit = smallestMemo.get(def);
  if (hit !== undefined) return hit;
  const nl = netlistOf(def);
  let named = Infinity, any = Infinity;
  for (const inst of nl?.instances ?? []) {
    const d = inst.def;
    if (d.prim === 'alias' || isConstantDef(d)) continue;
    const g = orientGeom(d, inst.flip, inst.rot);
    const long = Math.max(g.w, g.h);
    any = Math.min(any, long);
    if (d.symbol.kind === 'box' && nameEligible(d.symbol.label ?? d.name, g.w, g.h)) named = Math.min(named, long);
  }
  const v = Number.isFinite(named) ? named : Number.isFinite(any) ? any : 0;
  smallestMemo.set(def, v);
  return v;
}

const extentMemo = new WeakMap<ComponentDef, Rect>();
/** The inside's extent (inner grid units) as SchematicView draws it, from its netlist alone: every part, the level's pins
 *  with their knobs and names (symbols.ts pinGlyphBounds), and the view's margin (3 units, one more on top). The rule
 *  scales this into the box and the inside is fitted on it, so the scale the rule reads is the drawing's. A wire's tag
 *  past it is clipped by the box. */
export function insideExtent(def: ComponentDef): Rect | null {
  const hit = extentMemo.get(def);
  if (hit) return hit;
  const nl = netlistOf(def);
  if (!nl?.instances.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const i of nl.instances) {
    const g = orientGeom(i.def, i.flip, i.rot), [x, y] = i.at ?? [0, 0];
    grow(x, y);
    grow(x + g.w, y + g.h);
  }
  for (const p of pinGeoms(def, nl).values()) {
    const b = pinGlyphBounds(p);
    grow(b.x, b.y);
    grow(b.x + b.w, b.y + b.h);
  }
  // SchematicView's bbox margin
  const m = 3;
  const r = { x: x0 - m, y: y0 - m - 1, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m + 1 };
  extentMemo.set(def, r);
  return r;
}
