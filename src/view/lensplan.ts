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
import { NAME_PX } from './legible';

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

/** The lens's free stage: camera.ts freeArea for the inside's aspect (as Fit picks its room), the canvas when none, less EDGE_PX. */
export function freeStage(canvas: Size, covers: Rect[], extent: Size, gap = COVER_GAP): Rect {
  const r = freeArea(canvas.w, canvas.h, covers, extent.w, extent.h, gap) ?? { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const x0 = Math.max(r.x, EDGE_PX), y0 = Math.max(r.y, EDGE_PX);
  const x1 = Math.min(r.x + r.w, canvas.w - EDGE_PX), y1 = Math.min(r.y + r.h, canvas.h - EDGE_PX);
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
 * The lens as it opens: the inside fitted to the cap (LENS_W × LENS_H of the free stage). Null when it would not be
 * legible there (its smallest block under MIN_BLOCK_PX) or the free stage is too small to hold it.
 */
export function openPlan(box: Rect, extent: Size, smallestBlock: number, free: Rect): LensPlan | null {
  if (!(extent.w > 0 && extent.h > 0) || free.w <= 2 * RIM_PX || free.h <= TAG_PX + RIM_PX) return null;
  const capW = free.w * LENS_W - 2 * RIM_PX, capH = free.h * LENS_H - TAG_PX - RIM_PX;
  const scale = Math.min(capW / extent.w, capH / extent.h);
  if (!(scale > 0) || smallestBlock * scale < MIN_BLOCK_PX) return null;
  return placed(box, extent, scale, free);
}

/**
 * The lens after the zoom moved on: its scale follows the box's on-screen size since it opened (`opened`: the plan and
 * the box's height then). `handoff`: it would no longer fit the free stage, so the view becomes that level.
 */
export function growPlan(opened: { plan: LensPlan; boxH: number }, box: Rect, extent: Size, free: Rect): { plan: LensPlan; handoff: boolean } {
  const scale = opened.plan.scale * (box.h / opened.boxH);
  const w = extent.w * scale + 2 * RIM_PX, h = extent.h * scale + TAG_PX + RIM_PX;
  return { plan: placed(box, extent, scale, free), handoff: w > free.w || h > free.h };
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
