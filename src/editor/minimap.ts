// The sandbox minimap: the whole chip in a box at the canvas's bottom-right (parts as filled rectangles in their
// category's or chip's hue, wires faint), the visible area as a frame. Drag the frame to pan, click the map to jump
// there, M hides it. It hides itself while the whole chip is in view. Coordinates: minimapmath.ts (tested in Node).
// It repaints on a document / layout change (paintHooks, compared by identity) and on a camera move (Camera.listeners),
// both coalesced into one frame: never on a simulation frame alone.

import { CATEGORY_HUE } from '../view/symbols';
import { matches, shortcutAllowed } from '../ui/keys';
import { h, s } from '../ui/dom';
import { settings } from '../ui/settings';
import { type Editor, registerEditorPlugin } from './editor';
import { type Box, clampBox, CONTENT_PAD, contentFits, mapLayout, type MapLayout, mapRect, panCentre, toMap, toWorld } from './minimapmath';
import { partBox } from './geom';

/** The map's size in px (editor.css gives the box the same size). */
const W = 208, H = 148;

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

class Minimap {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private gParts: SVGGElement;
  private wires: SVGPathElement;
  private frame: SVGRectElement;
  private content: Box | null = null;
  private layout: MapLayout | null = null;
  private seen: unknown[] = [];
  private raf = 0;
  /** What the last update drew for: the view box and canvas size, to skip an update a simulation frame asks for. */
  private lastView = '';
  private sized = true;
  private dragOff: [number, number] | null = null;
  private off: (() => void)[] = [];

  constructor(private ed: Editor) {
    this.gParts = s('g', { class: 'mm-parts' });
    this.wires = s('path', { class: 'mm-wires', d: '' });
    this.frame = s('rect', { class: 'mm-frame', rx: 3 });
    this.svg = s('svg', { class: 'mm-svg', preserveAspectRatio: 'none', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, this.wires, this.gParts, this.frame);
    this.el = h('section', {
      class: 'sb-minimap', hidden: true, tabindex: '0', role: 'group', 'aria-keyshortcuts': 'M',
      'aria-label': 'Minimap of the whole chip. Arrow keys pan the view, M hides it',
    }, this.svg, h('span', { class: 'mm-note' }, 'Drag the frame · M hides'));
    ed.slots.overlay.append(this.el);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e));
    this.el.addEventListener('pointercancel', (e) => this.up(e));
    this.el.addEventListener('keydown', (e) => this.arrows(e));
    const paint = () => this.schedule();
    ed.paintHooks.add(paint);
    ed.view.cam.listeners.add(paint);
    this.off.push(() => ed.paintHooks.delete(paint), () => ed.view.cam.listeners.delete(paint), settings.onChange(paint));
    const key = (e: KeyboardEvent) => {
      if (!ed.el.isConnected || typing(e.target) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sb-help, .key-help')) return;
      if (matches(e, 'sb.minimap') && shortcutAllowed(e)) {
        e.preventDefault();
        settings.set('minimap', !settings.minimap);
      }
    };
    document.addEventListener('keydown', key);
    this.off.push(() => document.removeEventListener('keydown', key));
    const ro = new ResizeObserver(() => { this.sized = true; paint(); });
    ro.observe(ed.view.svg);
    this.off.push(() => ro.disconnect());
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.off.forEach((f) => f());
    this.el.remove();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  }

  /** The area of the world the canvas shows (the svg letterboxes the view box: the larger axis rules). */
  private visible(): Box {
    const cam = this.ed.view.cam, vb = cam.vb, r = this.ed.view.svg.getBoundingClientRect();
    const k = cam.scale();
    const w = r.width * k || vb.w, hh = r.height * k || vb.h;
    return { x: vb.x + vb.w / 2 - w / 2, y: vb.y + vb.h / 2 - hh / 2, w, h: hh };
  }

  private update(): void {
    const ed = this.ed;
    const doc = ed.doc;
    const key = [doc.parts, doc.wires, doc.pins, doc.labels, doc.comments, ed.view.polys.size, ed.chipId, ed.ws.chips, settings.minimap];
    const vb = ed.view.cam.vb;
    const view = `${vb.x},${vb.y},${vb.w},${vb.h}`;
    const same = !this.sized && view === this.lastView && key.every((k, i) => k === this.seen[i]);
    // paintHooks fire on every simulation frame: nothing here changes with one
    if (same) return;
    this.lastView = view;
    this.sized = false;
    if (!settings.minimap || !doc.parts.length) { this.seen = key; this.el.hidden = true; return; }
    if (key.some((k, i) => k !== this.seen[i]) || !this.content) {
      this.seen = key;
      this.content = ed.view.contentBox(ed.defOf);
      this.drawContent();
    }
    const seeing = this.visible();
    const content = this.content;
    // The frame is the visible area; with the whole chip in it there is nothing to show
    if (!content || !this.layout || contentFits(content, seeing, CONTENT_PAD)) { this.el.hidden = true; return; }
    this.el.hidden = false;
    // the map also holds the frame when the view reaches beyond the chip
    // ... clipped to the box, so a view wider than the map's reach does not draw outside it
    const f = clampBox(mapRect(this.layout, seeing), W, H);
    this.frame.setAttribute('x', f.x.toFixed(1));
    this.frame.setAttribute('y', f.y.toFixed(1));
    this.frame.setAttribute('width', Math.max(4, f.w).toFixed(1));
    this.frame.setAttribute('height', Math.max(4, f.h).toFixed(1));
  }

  private drawContent(): void {
    const ed = this.ed, doc = ed.doc;
    const c = this.content;
    // the layout covers the chip and (clipped by the svg) as much of the view as fits around it
    this.layout = c ? mapLayout(c, W, H, 10) : null;
    const l = this.layout;
    this.gParts.replaceChildren();
    let d = '';
    if (l) {
      for (const p of doc.parts) {
        const def = ed.defOf(p);
        if (!def) continue;
        const b = mapRect(l, partBox(def, p.at, p.flip, p.rot));
        const hue = 'chip' in p.ref ? ed.ws.chips[p.ref.chip]?.hue : CATEGORY_HUE[def.category];
        const r = s('rect', { x: b.x.toFixed(1), y: b.y.toFixed(1), width: Math.max(2, b.w).toFixed(1), height: Math.max(2, b.h).toFixed(1), rx: 1.5, class: hue === undefined ? 'mm-part' : 'mm-part hued' });
        if (hue !== undefined) r.style.setProperty('--h', String(hue));
        this.gParts.append(r);
      }
      for (const poly of ed.view.polys.values()) {
        poly.forEach((pt, i) => {
          const [x, y] = toMap(l, pt);
          d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
        });
      }
      for (const pin of doc.pins) {
        const [x, y] = toMap(l, pin.at);
        this.gParts.append(s('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.2, class: 'mm-pin' }));
      }
    }
    this.wires.setAttribute('d', d);
  }

  // ---- pointer: drag the frame, or jump and carry on dragging ----------------------------------

  private world(e: PointerEvent): [number, number] | null {
    if (!this.layout) return null;
    const r = this.svg.getBoundingClientRect();
    return toWorld(this.layout, [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]);
  }

  private panTo(c: readonly [number, number]): void {
    const cam = this.ed.view.cam;
    if (!this.content) return;
    const v = panCentre(cam.vb, c, this.content);
    cam.vb = { ...cam.vb, x: v.x, y: v.y };
    cam.fitted = false;
    cam.apply();
  }

  private down(e: PointerEvent): void {
    const p = this.world(e);
    if (!p || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.el.setPointerCapture(e.pointerId);
    const v = this.visible();
    const inside = p[0] >= v.x && p[0] <= v.x + v.w && p[1] >= v.y && p[1] <= v.y + v.h;
    // on the frame: keep the grabbed spot under the pointer; elsewhere: the view jumps to centre there
    this.dragOff = inside ? [p[0] - (v.x + v.w / 2), p[1] - (v.y + v.h / 2)] : [0, 0];
    if (!inside) this.panTo(p);
  }

  private move(e: PointerEvent): void {
    if (!this.dragOff) return;
    const p = this.world(e);
    if (p) this.panTo([p[0] - this.dragOff[0], p[1] - this.dragOff[1]]);
  }

  private up(e: PointerEvent): void {
    if (!this.dragOff) return;
    this.dragOff = null;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
  }

  private arrows(e: KeyboardEvent): void {
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const m = d[e.key];
    if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const v = this.visible();
    this.panTo([v.x + v.w / 2 + m[0] * v.w * 0.2, v.y + v.h / 2 + m[1] * v.h * 0.2]);
  }
}

registerEditorPlugin((ed) => {
  const mm = new Minimap(ed);
  return () => mm.destroy();
});
