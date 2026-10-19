// The camera over an SVG drawing in grid units: the viewBox, fit / zoom / pan, and the
// pointer handling that tells a pan (drag) from a click (tap). Shared by the schematic and
// the sandbox editor so both navigate identically.

import type { Vec } from '../sim/geometry';
import { installPinch } from './pinch';
import { overlaps, type Rect } from './route';

export interface ViewBox { x: number; y: number; w: number; h: number }

/** Here a rectangle in screen pixels from the host's top-left corner (an overlay panel, a free area). */
export type { Rect };

/** Below this many pixels wide (MIN_FIT_H high) beside the overlays there is no point fitting the drawing there:
 *  it is fitted to the whole host and the overlays cover it (a phone; the learner folds the panel). */
export const MIN_FIT_PX = 120;
export const MIN_FIT_H = 80;

/** Pixels kept clear between the drawing and an overlay panel. */
export const COVER_GAP = 12;

/** Below this many pixels left beside it, a foldable right-docked stage panel starts folded (Stage.foldable). */
export const FOLD_BESIDE_PX = 300;

/** Does a foldable panel `panelW` px wide (12 px from the edge, 12 px clear of the drawing) start folded on a
 *  canvas `canvasW` px wide? */
export function startFolded(canvasW: number, panelW: number): boolean {
  return canvasW - (panelW + 24) < FOLD_BESIDE_PX;
}

/**
 * Where a drawing of `bw` × `bh` (any unit) shows largest on a `width` × `height` px host part of which floating
 * panels `cover` (each kept `gap` px clear): of the rectangles that touch no cover, the one giving the largest
 * scale, the larger on a tie. Beside a full-height panel that is the strip left of it; beside a short one it may
 * be the full width under it (a wide circuit), and a bottom-left panel takes its corner away. The whole host when
 * no free rectangle is MIN_FIT_PX wide and MIN_FIT_H high.
 */
export function freeRect(width: number, height: number, cover: Rect[], bw: number, bh: number, gap = COVER_GAP): Rect {
  return freeArea(width, height, cover, bw, bh, gap) ?? { x: 0, y: 0, w: width, h: height };
}

/** freeRect's choice, or null when no rectangle clear of the covers is MIN_FIT_PX wide and MIN_FIT_H high (the
 *  drawing would be fitted to the whole host, under the covers). */
export function freeArea(width: number, height: number, cover: Rect[], bw: number, bh: number, gap = COVER_GAP): Rect | null {
  const host: Rect = { x: 0, y: 0, w: width, h: height };
  const boxes = cover.map((c) => {
    const x0 = Math.max(0, c.x - gap), y0 = Math.max(0, c.y - gap);
    const x1 = Math.min(width, c.x + c.w + gap), y1 = Math.min(height, c.y + c.h + gap);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }).filter((b) => b.w > 0 && b.h > 0);
  if (!boxes.length || !(bw > 0 && bh > 0)) return host;
  // Every maximal free rectangle has its edges on the host's or a cover's edges: try them all (a few covers).
  const edges = (a: number[]) => [...new Set(a)].sort((p, q) => p - q);
  const xs = edges([0, width, ...boxes.flatMap((b) => [b.x, b.x + b.w])]);
  const ys = edges([0, height, ...boxes.flatMap((b) => [b.y, b.y + b.h])]);
  let best: Rect | null = null, bestS = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    if (xs[j] - xs[i] < MIN_FIT_PX) continue;
    for (let k = 0; k < ys.length; k++) for (let l = k + 1; l < ys.length; l++) {
      const r = { x: xs[i], y: ys[k], w: xs[j] - xs[i], h: ys[l] - ys[k] };
      if (r.h < MIN_FIT_H || boxes.some((b) => overlaps(r, b))) continue;
      const s = Math.min(r.w / bw, r.h / bh);
      if (!best || s > bestS * (1 + 1e-9) || (s >= bestS * (1 - 1e-9) && r.w * r.h > best.w * best.h)) { best = r; bestS = s; }
    }
  }
  return best;
}

/**
 * Does `bbox` (widened to `minW` as fitBox does) keep a place of its own on a `width` × `height` px host beside
 * these covers? False when the fit would fall back to the whole host and the covers would hide part of it: the
 * stage's how-to line gives way then (a short canvas: a small phone, a scene's panels).
 */
export function roomBeside(bbox: ViewBox, width: number, height: number, cover: Rect[], minW = 34): boolean {
  if (!(width > 0 && height > 0)) return true;
  return freeArea(width, height, cover, Math.max(bbox.w, minW), bbox.h) !== null;
}

/** A right overlay `insetRight` px wide (gap included) as a cover of a `width` × `height` host. */
const insetCover = (width: number, height: number, insetRight: number): Rect[] =>
  insetRight > 0 ? [{ x: width - insetRight, y: 0, w: insetRight, h: height }] : [];

/**
 * The view box showing `bbox` whole in a host of `width` × `height` px, as large as it fits and centred in the
 * free part of the host (freeRect): `cover` lists the overlay panels' rectangles, or is a right inset in px (gap
 * included). At least `minW` grid units wide. The box has the host's aspect ratio, so the svg scales it uniformly.
 */
export function fitBox(bbox: ViewBox, width: number, height: number, cover: Rect[] | number = 0, minW = 34): ViewBox {
  let { x, y, w, h } = bbox;
  if (w < minW) { x -= (minW - w) / 2; w = minW; }
  if (!(width > 0 && height > 0)) {
    // Not laid out yet: any box of a sensible aspect (the stage refits once it has a size).
    const aspect = 16 / 10;
    if (w / h > aspect) { const nh = w / aspect; y -= (nh - h) / 2; h = nh; } else { const nw = h * aspect; x -= (nw - w) / 2; w = nw; }
    return { x, y, w, h };
  }
  const a = typeof cover === 'number' ? freeRect(width, height, insetCover(width, height, cover), w, h, 0) : freeRect(width, height, cover, w, h);
  const s = Math.min(a.w / w, a.h / h); // px per grid unit
  return { x: x + w / 2 - (a.x + a.w / 2) / s, y: y + h / 2 - (a.y + a.h / 2) / s, w: width / s, h: height / s };
}

/** Does `bbox`, shown through `vb` on a `width` × `height` px host, reach under a cover (less its gap)? A fitted
 *  view refits then; a panel that only shrank or grew into empty space leaves the drawing where it is. */
export function underCover(vb: ViewBox, bbox: ViewBox, width: number, height: number, cover: Rect[]): boolean {
  if (!(width > 0 && height > 0 && vb.w > 0)) return false;
  const s = width / vb.w;
  const r = { x: (bbox.x - vb.x) * s, y: (bbox.y - vb.y) * s, w: bbox.w * s, h: bbox.h * s };
  return cover.some((c) => overlaps(r, c));
}

/**
 * On a touch screen the sandbox shows a small circuit at no fewer than this many px per grid unit: a NAND
 * (4 units) 64 px wide, a pin's knob 26 px, inputs 2 units apart 32 px apart, so a finger can hit them.
 */
export const TOUCH_PX = 16;

/**
 * A fitted view box (`vb`, the host's aspect, `width` px wide) made touch-usable: when it shows fewer than
 * `minPx` px per grid unit but at least `slack` of that (a small circuit, a little larger than the screen),
 * it is zoomed in to `minPx` around `c` (the drawing's centre stays where the fit put it), and the rest of
 * the circuit is a pan away. A large circuit (a CPU) keeps its fit: there Fit means "show me all of it".
 */
export function touchZoom(vb: ViewBox, width: number, c: Vec, minPx = TOUCH_PX, slack = 0.6): ViewBox {
  if (!(width > 0 && vb.w > 0)) return vb;
  const s = width / vb.w;
  if (s >= minPx || s < minPx * slack) return vb;
  const k = s / minPx;
  return { x: c[0] - (c[0] - vb.x) * k, y: c[1] - (c[1] - vb.y) * k, w: vb.w * k, h: vb.h * k };
}

export class Camera {
  vb: ViewBox = { x: 0, y: 0, w: 10, h: 10 };
  /** Showing what the last fit() chose: the learner has not zoomed or panned since. */
  fitted = false;
  /** Host size (px) the view box was last set for (see resized()). */
  private size: { w: number; h: number } | null = null;

  /** `host` gives the visible size (the svg itself unless it sits in a larger container). */
  constructor(readonly svg: SVGSVGElement, private host: Element = svg) {}

  apply(): void {
    const { x, y, w, h } = this.vb;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  /**
   * Show `bbox` whole, centred in the part of the host its overlays leave free (`cover`: their
   * rectangles, or a right inset in px; see fitBox), never narrower than `minW` grid units (so a
   * tiny circuit doesn't look cartoonish).
   */
  fit(bbox: ViewBox, cover: Rect[] | number = 0, minW = 34): void {
    const r = this.host.getBoundingClientRect();
    this.vb = fitBox(bbox, r.width, r.height, cover, minW);
    this.fitted = true;
    this.size = r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null;
    this.apply();
  }

  /**
   * The host changed size. A view the learner has zoomed or panned keeps its scale and its
   * top-left corner (the edge that moved shows more or less); returns false when the view is
   * still the fitted one, so the caller fits it again.
   */
  resized(): boolean {
    const r = this.host.getBoundingClientRect();
    if (this.fitted || !this.size || r.width <= 0 || r.height <= 0) return false;
    this.vb = { ...this.vb, w: this.vb.w * r.width / this.size.w, h: this.vb.h * r.height / this.size.h };
    this.size = { w: r.width, h: r.height };
    this.apply();
    return true;
  }

  /** Scale the view by `factor` (< 1 zooms in) around a world point (default: the centre). */
  zoom(factor: number, cx?: number, cy?: number): void {
    const v = this.vb;
    const px = cx ?? v.x + v.w / 2, py = cy ?? v.y + v.h / 2;
    const nw = Math.min(Math.max(v.w * factor, 8), 4000);
    const k = nw / v.w;
    this.vb = { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w: v.w * k, h: v.h * k };
    this.fitted = false;
    this.apply();
  }

  /**
   * A pinch step (client coordinates): what was under the fingers' old midpoint ends up under
   * the new one, scaled by `k` (> 1 zooms in).
   */
  pinch(k: number, mid: [number, number], prev: [number, number]): void {
    const [wx, wy] = this.toWorld(prev[0], prev[1]);
    this.zoom(1 / k, wx, wy);
    const s = this.scale();
    this.vb.x -= (mid[0] - prev[0]) * s;
    this.vb.y -= (mid[1] - prev[1]) * s;
    this.apply();
  }

  /** Pan (without zooming) so that a point is centred, unless it is already well inside the view. */
  centerOn(p: Vec): void {
    const v = this.vb;
    const mx = v.w * 0.15, my = v.h * 0.15;
    if (p[0] > v.x + mx && p[0] < v.x + v.w - mx && p[1] > v.y + my && p[1] < v.y + v.h - my) return;
    this.vb = { ...v, x: p[0] - v.w / 2, y: p[1] - v.h / 2 };
    this.fitted = false;
    this.apply();
  }

  /** Client (screen) coordinates → world (grid) coordinates. */
  toWorld(clientX: number, clientY: number): Vec {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }

  /** World units per screen pixel (the larger axis: the svg letterboxes the other). */
  scale(): number {
    const r = this.svg.getBoundingClientRect();
    return Math.max(this.vb.w / r.width, this.vb.h / r.height);
  }
}

export interface PanZoomHooks {
  /** May a press here start a pan? (False leaves the press to the element's own handlers.) */
  canStart(e: PointerEvent): boolean;
  /** A press released without moving: a click on `target`. */
  onTap(target: Element, e: PointerEvent): void;
  /** Pointer moving while not panning. */
  onHover?(e: PointerEvent): void;
  onLeave?(): void;
  /** A two-finger pinch began: abandon what its first finger started. */
  onPinch?(): void;
}

/**
 * Wheel zooms around the cursor; a drag on the background pans; a press without drag is a tap;
 * two fingers pinch-zoom and pan, wherever they land.
 */
export function installPanZoom(svg: SVGSVGElement, cam: Camera, hooks: PanZoomHooks): void {
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null = null;
  installPinch(svg, {
    start: () => { drag = null; hooks.onPinch?.(); },
    move: (k, mid, prev) => cam.pinch(k, mid, prev),
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [wx, wy] = cam.toWorld(e.clientX, e.clientY);
    cam.zoom(Math.exp(e.deltaY * 0.0015), wx, wy);
  }, { passive: false });
  svg.addEventListener('pointerdown', (e) => {
    if (!hooks.canStart(e)) return;
    drag = { x: e.clientX, y: e.clientY, vx: cam.vb.x, vy: cam.vb.y, moved: false, target: e.target as Element };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag) {
      const k = cam.scale();
      const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
      // Below this (grid units) a press is still a click: hands shake.
      if (Math.abs(dx) + Math.abs(dy) > 0.2) drag.moved = true;
      cam.vb.x = drag.vx - dx;
      cam.vb.y = drag.vy - dy;
      if (drag.moved) cam.fitted = false;
      cam.apply();
      return;
    }
    hooks.onHover?.(e);
  });
  const end = (e: PointerEvent) => {
    if (drag && !drag.moved) hooks.onTap(drag.target, e);
    drag = null;
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', () => hooks.onLeave?.());
}
