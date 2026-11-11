// The zoom lens's geometry (docs/transparent/DESIGN.md; view/lens.ts draws it). DOM-free: every number is screen pixels
// in the stage's canvas, so tests/lensplan.test.ts can check it over every level a stage can show.
//
// A library box opens a lens when a zoom gesture settles with the box at least LENS_OPEN_PX on its shorter side (8 ×
// legible.ts NAME_PX) and the lens can show the box's inside with every block at least MIN_BLOCK_PX (legible.ts draws
// a block's name at its fixed size from there). The lens sits in the free stage (the canvas less its covers: docked
// panels, the Why? card, notes, the LEVEL tag), centred on its box and pushed inside, at most LENS_W × LENS_H of it.
// It grows with the zoom; once it would not fit the free stage the view becomes that level (a drill). It closes when
// the box falls under LENS_CLOSE_PX or leaves the free stage.
import { COVER_GAP, freeArea } from './camera';
import { orientGeom } from '../sim/geometry';
import { isConstantDef } from '../sim/constant';
import { netlistOf, type ComponentDef } from '../sim/types';
import { NAME_PX, nameEligible } from './legible';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

export const LENS_OPEN_PX = 8 * NAME_PX;
export const LENS_CLOSE_PX = 72;
export const LENS_W = 0.6, LENS_H = 0.85;
/** Every block's longer side must be drawn at least this big (px): legible.ts planNames' minBlockPx, where its name is drawn. */
export const MIN_BLOCK_PX = 10;
/** Padding (px) inside the lens on each side of the drawing; the rim connectors run outside it. */
export const RIM_PX = 14;
/** Room inside the lens for its tag line (px). */
export const TAG_PX = 22;

const short = (r: Rect) => Math.min(r.w, r.h);

/** Is the box big enough on screen to open? */
export const opensAt = (box: Rect): boolean => short(box) >= LENS_OPEN_PX;

/** Kept clear of the canvas's own edges (px), as the mockup's lens. */
export const EDGE_PX = 8;

/** A touch screen (DESIGN.md item 6): 16 px gutters, and the cap is the whole free width (at 390 px a lens is nearly a drill). */
export const PHONE_EDGE_PX = 16, PHONE_LENS_W = 1;

/** The lens's free stage: camera.ts freeArea for the inside's aspect (as Fit picks its room), the canvas when none, less `edge`. */
export function freeStage(canvas: Size, covers: Rect[], extent: Size, gap = COVER_GAP, edge = EDGE_PX): Rect {
  const r = freeArea(canvas.w, canvas.h, covers, extent.w, extent.h, gap) ?? { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const x0 = Math.max(r.x, edge), y0 = Math.max(r.y, edge);
  const x1 = Math.min(r.x + r.w, canvas.w - edge), y1 = Math.min(r.y + r.h, canvas.h - edge);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export interface LensPlan {
  /** The lens's rectangle (px, canvas). */
  rect: Rect;
  /** Its drawing area inside the rim and under the tag line. */
  inner: Rect;
  /** Screen px per grid unit of the inside. */
  scale: number;
}

/** The lens for an inside of `extent` grid units at `scale`, centred on `box`, pushed inside `free`. */
function placed(box: Rect, extent: Size, scale: number, free: Rect): LensPlan {
  const w = extent.w * scale + 2 * RIM_PX, h = extent.h * scale + TAG_PX + RIM_PX;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const x = Math.min(Math.max(free.x, cx - w / 2), free.x + free.w - w);
  const y = Math.min(Math.max(free.y, cy - h / 2), free.y + free.h - h);
  return { rect: { x, y, w, h }, inner: { x: x + RIM_PX, y: y + TAG_PX, w: w - 2 * RIM_PX, h: h - TAG_PX - RIM_PX }, scale };
}

/**
 * The lens as it opens: the inside fitted to the cap (`capW` × LENS_H of the free stage; PHONE_LENS_W on a touch
 * screen). Null when it would not be legible there (its smallest block under MIN_BLOCK_PX) or the free stage is too small.
 */
export function openPlan(box: Rect, extent: Size, smallestBlock: number, free: Rect, capFrac = LENS_W): LensPlan | null {
  if (!(extent.w > 0 && extent.h > 0) || free.w <= 2 * RIM_PX || free.h <= TAG_PX + RIM_PX) return null;
  const capW = free.w * capFrac - 2 * RIM_PX, capH = free.h * LENS_H - TAG_PX - RIM_PX;
  const scale = Math.min(capW / extent.w, capH / extent.h);
  if (!(scale > 0) || smallestBlock * scale < MIN_BLOCK_PX) return null;
  return placed(box, extent, scale, free);
}

/**
 * The lens after the zoom moved on: its scale follows the box's on-screen size since it opened (`opened`: the plan and
 * the box's height then). `handoff`: the zoom grew it past the free stage, so the view becomes that level. Only a zoom
 * hands off: when the free stage shrinks under an unzoomed lens (a panel docks, the phone's bar rewraps for the peek
 * crumb) it shrinks to fit. A phone's lens opens at the whole free width, so without this any reflow would drill.
 */
export function growPlan(opened: { plan: LensPlan; boxH: number }, box: Rect, extent: Size, free: Rect): { plan: LensPlan; handoff: boolean } {
  let scale = opened.plan.scale * (box.h / opened.boxH);
  const over = (s: number) => extent.w * s + 2 * RIM_PX > free.w + 0.5 || extent.h * s + TAG_PX + RIM_PX > free.h + 0.5;
  if (over(scale) && box.h > opened.boxH * 1.001) return { plan: placed(box, extent, scale, free), handoff: true };
  if (over(scale)) scale = Math.max(0, Math.min((free.w - 2 * RIM_PX) / extent.w, (free.h - TAG_PX - RIM_PX) / extent.h));
  return { plan: placed(box, extent, scale, free), handoff: false };
}

/** Should an open lens close? Its box under LENS_CLOSE_PX, or more than half of it outside the free stage. */
export function closesAt(box: Rect, free: Rect): boolean {
  if (short(box) < LENS_CLOSE_PX) return true;
  const ix = Math.max(0, Math.min(box.x + box.w, free.x + free.w) - Math.max(box.x, free.x));
  const iy = Math.max(0, Math.min(box.y + box.h, free.y + free.h) - Math.max(box.y, free.y));
  return ix * iy < (box.w * box.h) / 2;
}

/**
 * The rim connectors (DESIGN.md item 3, drawn as the approved mockup): each one starts where its outer wire really
 * crosses the lens's edge (the wire may bend under the lens, so not at the box port's height), steps out into the rim
 * channel, runs along it to the inner pin's height and goes in to the pin itself (a dot there, the port named just
 * outside the rim). Inputs on the left rim, outputs on the right, as the inside draws them. Vertical runs take lanes
 * stepping out from the rim (RIM_LANE apart), the longest run furthest out, so none runs along another. A port whose
 * outer wire leaves no mark on the rim (a pointer, a wire wholly under the lens) gets a stub from the rim to its pin.
 */
export const RIM_OUT = 9, RIM_LANE = 3;
/** Port names on one rim at least this far apart (px): pins closer than a line of text push their names apart. */
export const RIM_LABEL_PX = 12;
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export interface RimPort { name: string; side: 'left' | 'right'; outer: { x: number; y: number; edge: Edge } | null; pin: [number, number] }
export interface RimJog { name: string; side: 'left' | 'right'; d: string; pin: [number, number]; label: [number, number] }
export function rimJogs(lens: Rect, ports: RimPort[]): RimJog[] {
  const out: RimJog[] = [];
  const r = lens, bottom = r.y + r.h;
  for (const side of ['left', 'right'] as const) {
    const byPin = ports.filter((p) => p.side === side).sort((a, b) => a.pin[1] - b.pin[1]);
    // the names in pin order, each at least RIM_LABEL_PX below the one before, moved up as a run when it leaves the lens
    const ys = byPin.map((p) => p.pin[1] - 5);
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + RIM_LABEL_PX);
    const over = ys.length ? ys[ys.length - 1] - (bottom - 4) : 0;
    if (over > 0) for (let i = 0; i < ys.length; i++) ys[i] -= over;
    const labelY = new Map(byPin.map((p, i) => [p.name, ys[i]]));
    const run = (p: RimPort) => (p.outer ? Math.abs(p.outer.y - p.pin[1]) + (p.outer.edge === side ? 0 : r.w + r.h) : 0);
    const these = [...byPin].sort((a, b) => run(a) - run(b));
    these.forEach((p, i) => {
      const off = RIM_OUT + i * RIM_LANE;
      const lane = side === 'left' ? r.x - off : r.x + r.w + off;
      const [px, py] = p.pin;
      let d: string;
      const o = p.outer;
      if (!o) d = `M${lane} ${py}H${px}`;
      else if (o.edge === side) d = `M${o.x} ${o.y}H${lane}V${py}H${px}`;
      else if (o.edge === 'top' || o.edge === 'bottom') {
        const yo = o.edge === 'top' ? r.y - off : bottom + off;
        d = `M${o.x} ${o.y}V${yo}H${lane}V${py}H${px}`;
      } else {
        // it leaves by the other side: out, round the top, down this side
        const xo = o.edge === 'left' ? r.x - off : r.x + r.w + off, yo = r.y - off;
        d = `M${o.x} ${o.y}H${xo}V${yo}H${lane}V${py}H${px}`;
      }
      out.push({ name: p.name, side, d, pin: [px, py], label: [side === 'left' ? r.x - 12 : r.x + r.w + 12, labelY.get(p.name)!] });
    });
  }
  return out;
}

// ==== Revision 3: inside the box (docs/transparent/DESIGN.md "Revision 3") =================================================
// The inside is drawn within the box's own outline, letterboxed and centred, and grows on screen only with the view's zoom.
// One rule opens it: the inside's smallest named block, scaled into the box, reaches the legibility floor at the current
// zoom. That makes a box's opening zoom a property of the box alone (its size, its inside): no stage, no neighbours, no
// covers, nothing remembered. DOM-free, so tests/lens-hone.test.ts scripts zoom traces without a page.

/** The legibility floor (px): a named block's longer side on screen (legible.ts planNames' minBlockPx). */
export const FLOOR_PX = MIN_BLOCK_PX;
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
