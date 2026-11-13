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

/** The deepest zoom: the view is never narrower than this many grid units (so at most hostWidth / MIN_VIEW_UNITS px a unit). */
export const MIN_VIEW_UNITS = 8;
/** Pixels kept clear between the drawing and an overlay panel. */
export const COVER_GAP = 12;

/** Below this many pixels left beside it, a foldable right-docked stage panel starts folded (Stage.foldable). */
export const FOLD_BESIDE_PX = 300;

/** Does a foldable panel `panelW` px wide (12 px from the edge, 12 px clear of the drawing) start folded on a
 *  canvas `canvasW` px wide? */
export function startFolded(canvasW: number, panelW: number): boolean {
  return canvasW - (panelW + 24) < FOLD_BESIDE_PX;
}

/** A scene's foldable panels stay open while the circuit keeps at least this share of the size it would get with
 *  them all folded (chooseFolds): a CPU panel beside a wide datapath stays open, an I/O panel that would squeeze
 *  the circuit into a corner of a laptop's stage starts folded. */
export const KEEP_SCALE = 0.6;
/** The same below the top level: a part the learner opened is what they came to read, so the panels may cost it a fifth of
 *  its size, not two (chapter ooo's reorder buffer kept 65 % beside the CPU and Out of order panels: its names unreadable). */
export const KEEP_SCALE_OPENED = 0.8;

/**
 * Which of `n` foldable panels start folded, as a bit mask (bit i: panel i folded). `scaleOf(mask)` is the circuit's
 * scale with those folded (px per unit; null: a choice not allowed, e.g. a right panel leaving the circuit less
 * than FOLD_BESIDE_PX), `fixed[i]` the learner's own choice for panel i (true folded, false open, null free). Of the
 * allowed choices whose scale is at least KEEP_SCALE of the best one, the one keeping the most panels open; on a tie
 * the larger circuit. With none allowed, every free panel folds. `ref`: the scale the share is measured against when not the
 * best allowed one (the best with every panel folded, where an author's data-keep, not the learner, holds a panel open: the
 * others then fold until the circuit has its share, multicycle/0 drew at 0.49); when no allowed choice reaches it, the largest.
 */
export function chooseFolds(n: number, scaleOf: (mask: number) => number | null, fixed: (boolean | null)[] = [], keep = KEEP_SCALE, ref?: number | null): number {
  const bits = (m: number) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
  let open = 0, shut = 0;
  fixed.forEach((f, i) => { if (f === true) shut |= 1 << i; else if (f === false) open |= 1 << i; });
  const masks: [number, number][] = [];
  for (let m = 0; m < 1 << n; m++) {
    if ((m & shut) !== shut || (m & open) !== 0) continue;
    const s = scaleOf(m);
    if (s !== null) masks.push([m, s]);
  }
  if (!masks.length) return ((1 << n) - 1) & ~open;
  const top = Math.max(...masks.map(([, s]) => s)), best = Math.max(top, ref ?? 0);
  if (top < keep * best - 1e-9) return masks.find(([, s]) => s === top)![0];
  let pick = masks[0];
  for (const c of masks) {
    if (c[1] < keep * best - 1e-9) continue;
    if (pick[1] < keep * best - 1e-9 || bits(c[0]) < bits(pick[0]) || (bits(c[0]) === bits(pick[0]) && c[1] > pick[1] * (1 + 1e-9))) pick = c;
  }
  return pick[0];
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
/** The share of the best scale a roomier free rectangle may give up (freeArea). */
const NEAR_BEST = 0.95;

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
  const found: { r: Rect; s: number }[] = [];
  let bestS = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    if (xs[j] - xs[i] < MIN_FIT_PX) continue;
    for (let k = 0; k < ys.length; k++) for (let l = k + 1; l < ys.length; l++) {
      const r = { x: xs[i], y: ys[k], w: xs[j] - xs[i], h: ys[l] - ys[k] };
      if (r.h < MIN_FIT_H || boxes.some((b) => overlaps(r, b))) continue;
      const s = Math.min(r.w / bw, r.h / bh);
      found.push({ r, s });
      if (s > bestS) bestS = s;
    }
  }
  // Within NEAR_BEST of the largest scale the roomier rectangle wins: a tall drawing's best fit is often a narrow strip
  // squeezed past a one-line hint at the bottom, a few percent larger but far off-centre beside a wide empty canvas.
  let best: Rect | null = null, bestA = 0;
  for (const { r, s } of found) if (s >= bestS * NEAR_BEST && r.w * r.h > bestA * (1 + 1e-9)) { best = r; bestA = r.w * r.h; }
  return best;
}

/**
 * Does `bbox` (widened to `minW` as fitBox does) keep a place of its own on a `width` × `height` px host beside
 * these covers? False when the fit would fall back to the whole host and the covers would hide part of it: the
 * stage's how-to line gives way then (a short canvas: a small phone, a scene's panels).
 */
export function roomBeside(bbox: ViewBox, width: number, height: number, cover: Rect[], minW = 34): boolean {
  if (!(width > 0 && height > 0)) return true;
  return freeArea(width, height, cover, Math.max(bbox.w, fitMinW(minW, width)), bbox.h) !== null;
}

/** Under this host width (px) a small circuit is widened to NARROW_MIN_W units, not minW: a two-gate circuit padded to 34
 *  units on a 390 px phone was drawn at a third less than the width allows. */
export const NARROW_HOST_PX = 520, NARROW_MIN_W = 22;
export const fitMinW = (minW: number, width: number): number => (width > 0 && width < NARROW_HOST_PX ? Math.min(minW, NARROW_MIN_W) : minW);

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
  const mw = fitMinW(minW, width);
  if (w < mw) { x -= (mw - w) / 2; w = mw; }
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
 * The least pan (never a zoom) that brings `targets` into `vb` with `margin` grid units to spare: `vb` unchanged
 * when they are all in view already. A union taller or wider than the view keeps its top / left edge in view.
 * The test player opening under the sandbox's canvas uses it to keep the failing pins on screen.
 */
export function panToShow(vb: ViewBox, targets: Rect[], margin = 2): ViewBox {
  if (!targets.length) return vb;
  const x0 = Math.min(...targets.map((r) => r.x)) - margin, y0 = Math.min(...targets.map((r) => r.y)) - margin;
  const x1 = Math.max(...targets.map((r) => r.x + r.w)) + margin, y1 = Math.max(...targets.map((r) => r.y + r.h)) + margin;
  const along = (v: number, len: number, lo: number, hi: number): number =>
    hi - lo > len || lo < v ? lo : hi > v + len ? hi - len : v;
  const x = along(vb.x, vb.w, x0, x1), y = along(vb.y, vb.h, y0, y1);
  return x === vb.x && y === vb.y ? vb : { ...vb, x, y };
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

/** "Zoom to readable" (the stage bar): offered while the fitted overview is drawn under READABLE_BELOW px per grid unit (a pipeline
 *  or a bus top fitted to its width: gates a few px wide), and it shows the drawing at READABLE_PX instead. */
export const READABLE_BELOW = 2.5, READABLE_PX = 3;
export const offerReadable = (pxPerUnit: number): boolean => pxPerUnit > 0 && pxPerUnit < READABLE_BELOW;
/** Does the stage bar show the button now? Only for the schematic (not the boards, a leaf's model view or a widget) at an unreadable scale. */
export const showReadable = (s: { px: number; boards: boolean; leaf: boolean; widget: boolean }): boolean => !s.boards && !s.leaf && !s.widget && offerReadable(s.px);
/** The view at `px` per unit: the drawing's left edge (its inputs) at the host's left, centred vertically on it, for panning right. */
export function readableBox(bbox: ViewBox, width: number, height: number, px = READABLE_PX): ViewBox {
  const w = width / px, h = height / px;
  return { x: bbox.x - 2, y: bbox.y + bbox.h / 2 - h / 2, w, h };
}

export class Camera {
  vb: ViewBox = { x: 0, y: 0, w: 10, h: 10 };
  /** Showing what the last fit() chose: the learner has not zoomed or panned since. */
  fitted = false;
  /** Host size (px) the view box was last set for (see resized()). */
  private size: { w: number; h: number } | null = null;
  /** Host width (px) at the last fit / resize, so the scale is known without reading the layout on every pan or zoom. */
  private hostPx = 0;

  /** `host` gives the visible size (the svg itself unless it sits in a larger container). */
  constructor(readonly svg: SVGSVGElement, private host: Element = svg) {}

  /** Told after every apply (the sandbox minimap follows the view). */
  readonly listeners = new Set<() => void>();

  apply(): void {
    const { x, y, w, h } = this.vb;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.listeners.forEach((f) => f());
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
    this.hostPx = r.width;
    this.size = r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null;
    this.apply();
  }

  /** Show `vb` as the fitted view (a caller's own fit: the boards'). */
  show(vb: ViewBox): void {
    const r = this.host.getBoundingClientRect();
    this.vb = vb;
    this.fitted = true;
    this.hostPx = r.width;
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
    this.hostPx = r.width;
    this.apply();
    return true;
  }

  /** Show `vb` as a view of the learner's own: not fitted, so a resize keeps its scale (resized()); Fit undoes it. */
  setView(vb: ViewBox, host?: { w: number; h: number }): void {
    // a host just sized (the zoom lens's body): the scale reads from it at once, without a layout read
    if (host && host.w > 0 && host.h > 0) {
      this.size = { ...host };
      this.hostPx = host.w;
    }
    this.vb = vb;
    this.fitted = false;
    this.apply();
  }

  /** Scale the view by `factor` (< 1 zooms in) around a world point (default: the centre). */
  zoom(factor: number, cx?: number, cy?: number): void {
    const v = this.vb;
    const px = cx ?? v.x + v.w / 2, py = cy ?? v.y + v.h / 2;
    const nw = Math.min(Math.max(v.w * factor, MIN_VIEW_UNITS), 4000);
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

  /** Screen pixels per grid unit, from the host width at the last fit / resize (no layout read; 0 before one). */
  pxPerUnit(): number {
    return this.hostPx > 0 && this.vb.w > 0 ? this.hostPx / this.vb.w : 0;
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
  /** A pinch step (after the camera moved) and its end, with the fingers' midpoint (client px): the zoom lens's focus. */
  onPinchMove?(mid: [number, number], k: number): void;
  onPinchEnd?(mid: [number, number]): void;
}

/**
 * Wheel zooms around the cursor; a drag on the background pans; a press without drag is a tap;
 * two fingers pinch-zoom and pan, wherever they land.
 */
/** Below this (grid units, |dx| + |dy|) a press is still a click: hands shake. The lens's wire tap uses it too. */
export const TAP_SLOP = 0.2;

export function installPanZoom(svg: SVGSVGElement, cam: Camera, hooks: PanZoomHooks): void {
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null = null;
  installPinch(svg, {
    start: () => { drag = null; hooks.onPinch?.(); },
    move: (k, mid, prev) => { cam.pinch(k, mid, prev); hooks.onPinchMove?.(mid, k); },
    end: (mid) => hooks.onPinchEnd?.(mid),
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
      if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP) drag.moved = true;
      cam.vb.x = drag.vx - dx;
      cam.vb.y = drag.vy - dy;
      if (drag.moved) cam.fitted = false;
      cam.apply();
      return;
    }
    hooks.onHover?.(e);
  });
  const end = (e: PointerEvent) => {
    // a cancelled press (the browser's, or the zoom lens taking the finger into a pinch) is not a tap
    if (drag && !drag.moved && e.type !== 'pointercancel') hooks.onTap(drag.target, e);
    drag = null;
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', () => hooks.onLeave?.());
}
