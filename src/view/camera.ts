// The camera over an SVG drawing in grid units: the viewBox, fit / zoom / pan, and the
// pointer handling that tells a pan (drag) from a click (tap). Shared by the schematic and
// the sandbox editor so both navigate identically.

import type { Vec } from '../sim/geometry';

export interface ViewBox { x: number; y: number; w: number; h: number }

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
   * Show `bbox` whole, centred in the part of the host not covered by `insetRight` screen
   * pixels on the right, never narrower than `minW` grid units (so a tiny circuit doesn't look
   * cartoonish).
   */
  fit(bbox: ViewBox, insetRight = 0, minW = 34): void {
    const r = this.host.getBoundingClientRect();
    const usable = Math.max(200, r.width - insetRight);
    const aspect = usable > 0 && r.height > 0 ? usable / r.height : 16 / 10;
    let { x, y, w, h } = bbox;
    if (w < minW) { x -= (minW - w) / 2; w = minW; }
    if (w / h > aspect) {
      const nh = w / aspect; y -= (nh - h) / 2; h = nh;
    } else {
      const nw = h * aspect; x -= (nw - w) / 2; w = nw;
    }
    // Extend the view to the right so the drawing sits in the uncovered part.
    if (insetRight > 0 && r.width > 0) w = w * (r.width / usable);
    this.vb = { x, y, w, h };
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
}

/** Wheel zooms around the cursor; a drag on the background pans; a press without drag is a tap. */
export function installPanZoom(svg: SVGSVGElement, cam: Camera, hooks: PanZoomHooks): void {
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null = null;
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
