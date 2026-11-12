// Open blocks as you zoom: the geometry (docs/transparent/DESIGN.md, Revision 3; view/lens.ts draws it). DOM-free, so
// tests/lens-hone.test.ts scripts zoom traces without a page.
//
// The inside is drawn within the box's own outline, letterboxed and centred, and grows on screen only with the view's zoom.
// One rule opens it: the inside's smallest named block, scaled into the box, reaches the legibility floor at the current
// zoom. That makes a box's opening zoom a property of the box alone (its size, its inside): no stage, no neighbours, no
// covers, nothing remembered.
import { MIN_VIEW_UNITS } from './camera';
import { orientGeom, symbolGeom } from '../sim/geometry';
import { boxText, portTextRect } from './boxtext';
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
export function fitInside(box: Rect, extent: Rect, band: Band = NO_BAND): Fit {
  // each side keeps INSET, or more where the box's own port names sit (bandOf)
  const l = Math.max(INSET, band.l), rt = Math.max(INSET, band.r), t = Math.max(INSET, band.t), b = Math.max(INSET, band.b);
  const bw = Math.max(0, box.w - l - rt), bh = Math.max(0, box.h - t - b);
  const k = extent.w > 0 && extent.h > 0 ? Math.min(bw / extent.w, bh / extent.h) : 0;
  const w = extent.w * k, h = extent.h * k;
  return { k, x: box.x + l + (bw - w) / 2, y: box.y + t + (bh - h) / 2, w, h };
}

/** Room kept inside a box's edges (outer grid units, per side) for what stays drawn on it while its inside shows. */
export interface Band { l: number; r: number; t: number; b: number }
export const NO_BAND: Band = { l: 0, r: 0, t: 0, b: 0 };
/** A band side never takes more than this share of the box's width or height (a small box with long names still opens). */
const BAND_MAX = 0.3;
const bandMemo = new Map<string, Band>();
/**
 * The band a box's port names need (boxtext.ts lays them out just inside its edges, and they stay drawn while its inside
 * shows: which pin is which): per side, from the edge to past the farthest name, a clock's marker included, plus a small gap.
 * So the inside's stubs and drawing never run through them. A box turned a quarter keeps INSET only (its names are laid out
 * on the turned box). Memoized per definition and flip.
 */
export function bandOf(def: ComponentDef, flip = false, rot = 0): Band {
  if (def.symbol.kind !== 'box' || rot % 4) return NO_BAND;
  const key = `${def.id}|${flip ? 1 : 0}`;
  const hit = bandMemo.get(key);
  if (hit) return hit;
  const { w, h } = symbolGeom(def), gap = 0.3;
  const band = { l: 0, r: 0, t: 0, b: 0 };
  for (const p of boxText(def, flip).ports) {
    const q = portTextRect(p), clock = p.clock ? 0.8 : 0;
    if (p.side === 'left' || p.side === 'right') {
      if (q.x + q.w / 2 < w / 2) band.l = Math.max(band.l, q.x + q.w + gap, clock);
      else band.r = Math.max(band.r, w - q.x + gap, clock);
    } else if (q.y + q.h / 2 < h / 2) band.t = Math.max(band.t, q.y + q.h + gap, clock);
    else band.b = Math.max(band.b, h - q.y + gap, clock);
  }
  const out = { l: Math.min(band.l, BAND_MAX * w), r: Math.min(band.r, BAND_MAX * w), t: Math.min(band.t, BAND_MAX * h), b: Math.min(band.b, BAND_MAX * h) };
  bandMemo.set(key, out);
  return out;
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

/** A box opens at the latest once its shorter side is this share of the canvas's shorter side (the author's target). */
export const CAP_SHARE = 0.4;

/**
 * The zoom a box opens at on this canvas: its own (openAtPx), but no later than when its shorter side is CAP_SHARE of the
 * canvas's, and never past the view's deepest zoom (canvas.w / MIN_VIEW_UNITS px a unit), so no box is a dead end. The one
 * place the canvas enters the rule: a big inside (the issue queue, a register file) then opens before every inner name is
 * drawn, and those names appear as the zoom goes on. The canvas the view draws in, never its free area: a panel docking
 * must not open or close a box.
 */
export function capOpenAt(openAt: number, box: Size, canvas: Size): number {
  const short = Math.min(box.w, box.h), cs = Math.min(canvas.w, canvas.h);
  if (!(short > 0 && cs > 0)) return openAt;
  return Math.min(openAt, (CAP_SHARE * cs) / short, (0.999 * canvas.w) / MIN_VIEW_UNITS);
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

/** A run: at least this many identical named blocks (one definition, one orientation) read as one block, an array. */
export const RUN_MIN = 4;
/** A run's cells must each be at least this big on screen (px, the longer side) for the array to read as cells. */
export const CELL_PX = 4;

const smallestMemo = new WeakMap<ComponentDef, number>();
/**
 * The inside's smallest named block (inner grid units, its longer side): the blocks legible.ts would name (a box whose label
 * is worth a name). An inside of gate glyphs only names none: then its smallest part, so the gates read. 0: nothing to draw.
 * A run of RUN_MIN or more identical named blocks (a register's 32 flip-flops, a register file's 31 registers) counts as one
 * block, the run's extent (legible.ts names its first and last), as long as each cell is at least CELL_PX: so its share is
 * min(the run's longer side, the cell's · FLOOR_PX / CELL_PX). From the netlist, not the drawing (it never changes with the
 * zoom), memoized per definition.
 */
export function smallestNamed(def: ComponentDef): number {
  const hit = smallestMemo.get(def);
  if (hit !== undefined) return hit;
  const nl = netlistOf(def);
  // per definition and orientation: its parts' extent, size and count, and whether legible.ts would name it
  const groups = new Map<string, { long: number; named: boolean; x0: number; y0: number; x1: number; y1: number; n: number }>();
  for (const inst of nl?.instances ?? []) {
    const d = inst.def;
    if (d.prim === 'alias' || isConstantDef(d)) continue;
    const g = orientGeom(d, inst.flip, inst.rot);
    const key = `${d.id}|${inst.flip ? 1 : 0}|${inst.rot ?? 0}`, [x, y] = inst.at ?? [0, 0];
    const r = groups.get(key);
    if (r) Object.assign(r, { x0: Math.min(r.x0, x), y0: Math.min(r.y0, y), x1: Math.max(r.x1, x + g.w), y1: Math.max(r.y1, y + g.h), n: r.n + 1 });
    else groups.set(key, { long: Math.max(g.w, g.h), named: d.symbol.kind === 'box' && nameEligible(d.symbol.label ?? d.name, g.w, g.h), x0: x, y0: y, x1: x + g.w, y1: y + g.h, n: 1 });
  }
  // a run reads as one block: its extent, while each cell keeps CELL_PX
  const share = (r: { long: number; x0: number; y0: number; x1: number; y1: number; n: number }) =>
    r.n >= RUN_MIN ? Math.min(Math.max(r.x1 - r.x0, r.y1 - r.y0), (r.long * FLOOR_PX) / CELL_PX) : r.long;
  const all = [...groups.values()], named = all.filter((r) => r.named);
  const v = Math.min(...(named.length ? named : all).map(share));
  const out = Number.isFinite(v) ? v : 0;
  smallestMemo.set(def, out);
  return out;
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

/** A run inside a box (RUN_MIN or more identical parts): its first and last part, by position along the run. */
export interface Run { first: string; last: string; n: number; firstRect: Rect; lastRect: Rect; cellLong: number }
const runsMemo = new WeakMap<ComponentDef, Run[]>();
/** The runs of a definition's inside (inner grid units): while their cells are too small for their own names, the lens names
 *  the first and last (view/lens.ts), as R3.2's run rule reads them. From the netlist, memoized per definition. */
export function runsOf(def: ComponentDef): Run[] {
  const hit = runsMemo.get(def);
  if (hit) return hit;
  const groups = new Map<string, { name: string; r: Rect }[]>();
  for (const inst of netlistOf(def)?.instances ?? []) {
    const d = inst.def;
    if (d.prim === 'alias' || isConstantDef(d)) continue;
    const g = orientGeom(d, inst.flip, inst.rot), [x, y] = inst.at ?? [0, 0];
    const key = `${d.id}|${inst.flip ? 1 : 0}|${inst.rot ?? 0}`;
    groups.set(key, [...(groups.get(key) ?? []), { name: inst.name, r: { x, y, w: g.w, h: g.h } }]);
  }
  const out: Run[] = [];
  for (const parts of groups.values()) {
    if (parts.length < RUN_MIN) continue;
    const xs = parts.map((p) => p.r.x), ys = parts.map((p) => p.r.y);
    const vertical = Math.max(...ys) - Math.min(...ys) >= Math.max(...xs) - Math.min(...xs);
    const sorted = [...parts].sort((a, b) => (vertical ? a.r.y - b.r.y || a.r.x - b.r.x : a.r.x - b.r.x || a.r.y - b.r.y));
    const a = sorted[0], z = sorted[sorted.length - 1];
    out.push({ first: a.name, last: z.name, n: parts.length, firstRect: a.r, lastRect: z.r, cellLong: Math.max(a.r.w, a.r.h) });
  }
  runsMemo.set(def, out);
  return out;
}
