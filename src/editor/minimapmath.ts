// The sandbox minimap's coordinates (DOM-free): the whole chip fitted into a small box, the visible area as a frame
// in it, and the map position ↔ world position conversions that clicking and dragging the frame use.

export interface Box { x: number; y: number; w: number; h: number }

export interface MapLayout {
  /** Map pixels per grid unit. */
  k: number;
  /** Map position of the world origin. */
  ox: number;
  oy: number;
}

/** The content box centred in a `w` × `h` map with `pad` px around it; null for an empty box. */
export function mapLayout(content: Box, w: number, h: number, pad = 8): MapLayout | null {
  if (content.w <= 0 || content.h <= 0) return null;
  const k = Math.min((w - 2 * pad) / content.w, (h - 2 * pad) / content.h);
  return { k, ox: (w - content.w * k) / 2 - content.x * k, oy: (h - content.h * k) / 2 - content.y * k };
}

export const toMap = (l: MapLayout, p: readonly [number, number]): [number, number] => [p[0] * l.k + l.ox, p[1] * l.k + l.oy];
export const toWorld = (l: MapLayout, p: readonly [number, number]): [number, number] => [(p[0] - l.ox) / l.k, (p[1] - l.oy) / l.k];

export function mapRect(l: MapLayout, b: Box): Box {
  return { x: b.x * l.k + l.ox, y: b.y * l.k + l.oy, w: b.w * l.k, h: b.h * l.k };
}

/** The margin contentBox keeps around a pin (3 units) and above a part (1): empty canvas, so the chip counts as in view without it. */
export const CONTENT_PAD = 3;

/** `b` cut to the 0 … w × 0 … h box (empty past it: w and h 0 at the near edge). */
export function clampBox(b: Box, w: number, h: number): Box {
  const x0 = Math.min(Math.max(b.x, 0), w), y0 = Math.min(Math.max(b.y, 0), h);
  const x1 = Math.min(Math.max(b.x + b.w, 0), w), y1 = Math.min(Math.max(b.y + b.h, 0), h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Is the whole content inside the view (the minimap has nothing to add)? A little slack for rounding. */
export function contentFits(content: Box, view: Box, slack = 0.5): boolean {
  return content.x >= view.x - slack && content.y >= view.y - slack
    && content.x + content.w <= view.x + view.w + slack && content.y + content.h <= view.y + view.h + slack;
}

/** The view box centred on the world point `c`, same size. */
export function centredOn(view: Box, c: readonly [number, number]): Box {
  return { x: c[0] - view.w / 2, y: c[1] - view.h / 2, w: view.w, h: view.h };
}

/**
 * The view moved so that the world point `c` is its centre, but kept overlapping the content: a drag past the map's
 * edge cannot lose the chip (the view's centre stays inside the content box grown by half the view).
 */
export function panCentre(view: Box, c: readonly [number, number], content: Box): Box {
  const cx = Math.min(Math.max(c[0], content.x), content.x + content.w);
  const cy = Math.min(Math.max(c[1], content.y), content.y + content.h);
  return centredOn(view, [cx, cy]);
}
