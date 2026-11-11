// The zoom lens (docs/transparent/DESIGN.md, phase 1): with View options ▸ Open blocks as you zoom on, a zoom gesture
// that settles on a block opens its inside over it, live, in a rounded window anchored on the box; the level around it
// stays drawn and dims (the view's own focus layer). Zooming on grows it; once it would not fit the free stage the view
// becomes that level (a drill, no jump). Esc, zooming out under the close size, or panning the box away closes it.
// After a hand-off, zooming back out to fit shows "Keep zooming out to go up to cpu"; a fresh gesture then goes up, the
// level left shown in its lens at full size, shrinking as the zoom goes on (phase 2e, view/zoomout.ts).
// The stage imports this module only while the setting is on, so off costs nothing.
import '../styles/lens.css';
import { coarsePointer } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import { TAP_SLOP } from './camera';
import type { ViewCtx } from './context';
import { closesAt, EDGE_PX, freeStage, growPlan, LENS_CLOSE_PX, LENS_OPEN_PX, LENS_W, openPlan, opensAt, PHONE_EDGE_PX, PHONE_LENS_W, RIM_PX, rimJogs, TAG_PX, type LensPlan, type Rect, type RimPort, type Size } from './lensplan';
import { ZoomOutGate } from './zoomout';
import { installPinch } from './pinch';
import type { OverlayResult } from './overlays';
import { SchematicView, type SchematicEvents } from './schematic';

const SVG = 'http://www.w3.org/2000/svg';
/** A zoom has settled when no wheel event came for this long (ms). */
export const SETTLE_MS = 160;
/** The grow and fade as it opens (ms); none with reduced motion. */
const OPEN_MS = 180;
/** A pin further than this (px) inside the rim gets its connector ended on the rim (the author's choice, 2026-11-11). */
export const DEEP_PX = 30;
/** On a touch screen a tap inside the lens selects a part at least this big on screen (px, the coarse-pointer target);
 *  anywhere else it steps into the box (DESIGN.md item 6). */
export const TAP_SELECT_PX = 40;
/** A touch is a tap while it moves less than this (px) and lifts within TAP_MS (a longer press is the held-finger menu). */
const TAP_SLOP_PX = 8, TAP_MS = 450;

export interface LensHost {
  /** The level on screen and its view. */
  readonly view: SchematicView;
  ctx(): ViewCtx | null;
  /** The element the view draws in; the lens is placed over it, in its pixels. */
  readonly canvas: HTMLElement;
  /** What the stage keeps clear (docked panels, the Why? card, notes, the LEVEL tag), canvas px. */
  covers(): Rect[];
  /** May a lens open on this scene at all (not on the breadboards, an NMOS scene, a leaf's widget)? */
  allowed(): boolean;
  /** Is this box too large to open here (the out-of-order core's levels, phase 2f)? */
  tooLarge(ctx: ViewCtx, name: string): boolean;
  /** Step into a level (history as for a double-click); `vb`: the view box to show it at, so nothing jumps. */
  drill(path: string[], vb?: { x: number; y: number; w: number; h: number }): void;
  /** The breadcrumb's peek crumb (null: none). */
  peek(ctx: ViewCtx | null): void;
  /** The overlay for a level (null: none on), as the stage paints its own. */
  overlay(ctx: ViewCtx): OverlayResult | null;
  /** Why the overlay is not drawn inside (a sub-simulation's activity), or null. */
  overlayGap(ctx: ViewCtx): string | null;
  /** An inner part selected (null: none): the inspector follows. */
  selected(): void;
  /** The cue after a hand-off ("Keep zooming out to go up to cpu"); null removes it. */
  cue(parent: { label: string; path: string[] } | null): void;
  say(text: string): void;
  /** More of the lens view's events for this level (Why? clicks, the right-click menu's Why this value? and Explain:
   *  track 2b); with them a right-click inside the lens opens the wire and part menus. Its open / select / up stay the lens's. */
  events?(ctx: ViewCtx): Partial<SchematicEvents>;
}

interface Open {
  name: string;
  ctx: ViewCtx;
  view: SchematicView;
  el: HTMLElement;
  body: HTMLElement;
  tag: HTMLElement;
  rim: SVGSVGElement;
  extent: { x: number; y: number; w: number; h: number };
  opened: { plan: LensPlan; boxH: number };
  plan: LensPlan;
  label: string;
}

export class Lens {
  private open: Open | null = null;
  private timer = 0;
  private focus: [number, number] | null = null;
  /** Boxes found not to open (illegible at the cap, or no free stage), by definition: not rebuilt on every zoom. */
  private refused = new Map<string, string>();
  private hint: HTMLElement | null = null;
  private sel: string | null = null;
  /** The level the last hand-off entered, for the cue once the zoom-out reaches fit. */
  private handed: { path: string[]; parent: { label: string; path: string[] }; px: number } | null = null;
  private off: (() => void)[] = [];
  /** After a hand-off and its cue: is this zoom-out a fresh gesture that goes up a level (view/zoomout.ts)? */
  private gate = new ZoomOutGate();
  private pinchLive = false;
  /** Ports whose inner pin is deep inside the drawing this paint (their connector ends on the rim). */
  private deep = new Set<string>();
  /** What the stage lights now (its own level's names, `box.part` for parts inside a box): kept across opening and closing. */
  private litNames: string[] = [];

  /**
   * Where the lens, its rim and its hints go: one layer over the canvas, added once. A child added to or taken from the
   * canvas itself re-checks its :has() rules (app.css) over the whole stage, and on the out-of-order core that restyle
   * was ~100 ms per opening.
   */
  private layer: HTMLElement;

  constructor(private host: LensHost) {
    const v = host.view;
    this.layer = document.createElement('div');
    this.layer.className = 'lens-layer';
    host.canvas.append(this.layer);
    this.off.push(() => this.layer.remove());
    const wheel = (e: WheelEvent) => {
      if (this.gate.wheel(e.timeStamp, e.deltaY)) return this.goUp();
      this.zoomed(e.clientX, e.clientY);
    };
    v.el.addEventListener('wheel', wheel, { passive: true });
    this.off.push(() => v.el.removeEventListener('wheel', wheel));
    v.onCamera(() => this.cameraMoved());
    // a pinch on the board: its midpoint is the focus, and it settles when the fingers lift (not while they move: a pinch
    // that also pans would open and close lenses on the way)
    this.off.push(v.onPinch((mid, done, k) => this.pinched(mid, done, k)));
    // a wheel does not focus the stage, so its own Esc would not reach it: while a lens is open, Esc on the page closes it
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.open || e.defaultPrevented) return;
      const t = e.target as Element | null;
      if (t && t !== document.body && t !== document.documentElement) return;
      e.preventDefault();
      this.close();
    };
    document.addEventListener('keydown', esc);
    this.off.push(() => document.removeEventListener('keydown', esc));
  }

  /** Torn down (the setting turned off, the stage gone). */
  dispose(): void {
    this.close();
    this.off.forEach((f) => f());
    this.off = [];
    this.hint?.remove();
    clearTimeout(this.timer);
  }

  /** A zoom step toward a client point (the wheel's pointer, the keyboard cursor's part): it opens once it settles. */
  zoomed(clientX: number, clientY: number): void {
    this.focus = [clientX, clientY];
    this.hideHint();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.settle(), SETTLE_MS);
  }

  /** A pinch step (scale `k`) or its end around a client point. */
  pinched(mid: [number, number], done: boolean, k = 1): void {
    if (done) {
      this.pinchLive = false;
      this.gate.pinchEnd();
    } else {
      const start = !this.pinchLive;
      this.pinchLive = true;
      // the parent takes the rest of the pinch: it zooms out there, and the lens it opens shrinks with it
      if (this.gate.pinchStep(performance.now(), k, start)) this.goUp();
    }
    this.focus = mid;
    this.hideHint();
    clearTimeout(this.timer);
    if (done) this.timer = window.setTimeout(() => this.settle(), 0);
  }

  /** A touch screen: phone gutters, the whole free width, taps by size, "tap" wording. */
  private get touch(): boolean {
    return coarsePointer();
  }

  /** The free stage for an inside of this extent, with the gutters of this device. */
  private free(extent: Size): Rect {
    return freeStage(this.canvasSize(), this.host.covers(), extent, undefined, this.touch ? PHONE_EDGE_PX : EDGE_PX);
  }

  get isOpen(): boolean {
    return !!this.open;
  }

  /** The inner part selected, with the lens's level. */
  selection(): { ctx: ViewCtx; name: string } | null {
    return this.open && this.sel ? { ctx: this.open.ctx, name: this.sel } : null;
  }

  /** The open lens's view (null once closed): Why? lights and selects inside it. */
  get innerView(): SchematicView | null {
    return this.open?.view ?? null;
  }

  /** The level the lens shows (the breadcrumb's peek crumb). */
  get peekCtx(): ViewCtx | null {
    return this.open?.ctx ?? null;
  }

  /**
   * The stage lit these (the CPU panel's instruction, a data-show): parts named `<box>.<part>` light inside an open lens on
   * that box; naming only the box makes its rim glow (DESIGN.md track 2c). The outer view's own dim is the stage's: not
   * touched here. Kept, so a lens opened later shows them at once.
   */
  lit(names: readonly string[]): void {
    this.litNames = [...names];
    this.applyLit();
  }

  private applyLit(): void {
    const o = this.open;
    if (!o) return;
    const pre = `${o.name}.`;
    // only parts this box has: a CPU whose box is built otherwise (the system CPU's data memory) gets the rim, not a dim with nothing lit
    const have = o.ctx.node.children;
    const inner = [...new Set(this.litNames.filter((n) => n.startsWith(pre)).map((n) => n.slice(pre.length).split('.')[0]))].filter((n) => have?.has(n));
    o.view.highlight(inner, inner.length > 0);
    o.el.classList.toggle('lit', !inner.length && this.litNames.includes(o.name));
  }

  /** Close it (Esc, a scene or level change). True when one was open. */
  close(): boolean {
    const o = this.open;
    if (!o) return false;
    this.open = null;
    this.sel = null;
    o.view.clear();
    o.el.remove();
    o.rim.remove();
    this.host.view.setLensBox(null);
    this.host.peek(null);
    this.host.selected();
    return true;
  }

  /** The level on screen changed (a drill, going up, a new scene): no lens survives it; a hand-off keeps its cue. */
  levelChanged(path: string[]): void {
    this.close();
    this.hideHint();
    clearTimeout(this.timer);
    if (this.handed && path.join('.') !== this.handed.path.join('.')) {
      this.handed = null;
      this.host.cue(null);
      this.gate.clear();
    }
  }

  /** Live values: after every repaint of the stage. */
  update(): void {
    const o = this.open;
    if (!o) return;
    o.view.update();
    this.paintRim();
  }

  /** The stage's overlay changed or ticked. */
  paintOverlay(): void {
    const o = this.open;
    if (!o) return;
    o.view.overlay(this.host.overlay(o.ctx));
    const gap = this.host.overlayGap(o.ctx);
    o.tag.textContent = gap ? `${o.label} · ${gap}` : o.label;
  }

  /** The stage's covers moved (a panel docked or folded, the Why? card growing with a trace): placed again in the free
   *  stage, shrunk to it if it no longer fits. A cover is not a zoom or a pan: it never closes the lens nor hands off. */
  coversChanged(): void {
    const o = this.open;
    if (!o) return;
    const box = this.boxPx(o.name);
    if (!box) return void this.close();
    const free = this.free(o.extent);
    const g = growPlan(o.opened, box, o.extent, free);
    let plan: LensPlan | null = g.plan;
    if (g.handoff) {
      // Infinity skips openPlan's legibility floor on purpose: while a cover is up the lens may briefly draw blocks under
      // MIN_BLOCK_PX rather than close. `opened` restarts here so the next zoom step grows from this scale, not the old one.
      plan = openPlan(box, o.extent, Infinity, free, this.touch ? PHONE_LENS_W : LENS_W);
      if (plan) o.opened = { plan, boxH: box.h };
    }
    if (!plan) return void this.close();
    this.place(plan);
    this.paintRim();
  }

  // ---- opening ----------------------------------------------------------------------------

  /** The part under the focus that may open (the smallest box holding the point). */
  private target(): string | null {
    const ctx = this.host.ctx();
    if (!ctx || !this.focus) return null;
    const [gx, gy] = this.host.view.toGrid(this.focus[0], this.focus[1]);
    let best: string | null = null, area = Infinity;
    for (const [name, b] of this.host.view.partBoxes()) {
      if (gx < b.x || gx > b.x + b.w || gy < b.y || gy > b.y + b.h || b.w * b.h >= area) continue;
      if (!ctx.canOpen(name)) continue;
      best = name;
      area = b.w * b.h;
    }
    return best;
  }

  /** A part's box on screen, canvas px. */
  private boxPx(name: string): Rect | null {
    const r = this.host.view.instRect([name]);
    if (!r) return null;
    const c = this.host.canvas.getBoundingClientRect();
    return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
  }

  private canvasSize(): Size {
    const c = this.host.canvas.getBoundingClientRect();
    return { w: c.width, h: c.height };
  }

  private settle(): void {
    if (!this.host.allowed()) return;
    const ctx = this.host.ctx();
    const name = this.target();
    const o = this.open;
    // still on the open box: the camera listener already grows, hands off or closes it
    if (o && (o.name === name || !name)) {
      if (!name) {
        const box = this.boxPx(o.name);
        if (!box || box.h < LENS_CLOSE_PX) this.close();
      }
      return;
    }
    if (!ctx || !name) return void this.close();
    const box = this.boxPx(name);
    if (!box || !opensAt(box)) return void (o && this.close());
    this.close();
    if (this.host.tooLarge(ctx, name)) return this.showHint(box, `too large to open here: ${this.stepIn}`);
    const def = ctx.node.children?.get(name)?.def;
    const key = `${def?.id}|${Math.round(this.canvasSize().w)}x${Math.round(this.canvasSize().h)}|${this.touch}`;
    if (this.refused.has(key)) return this.showHint(box, this.refused.get(key)!);
    this.build(ctx, name, box, key);
  }

  private get stepIn(): string {
    return this.touch ? 'double-tap to step in' : 'double-click to step in';
  }

  private build(outer: ViewCtx, name: string, box: Rect, key: string, full = false): void {
    const t0 = performance.now();
    // a part whose inside cannot be simulated on its own (the sandbox's flatten throws): it does not open, and a drill stops there too
    let child: ViewCtx | null;
    try {
      child = outer.child(name);
    } catch {
      return this.showHint(box, 'its inside cannot be simulated on its own');
    }
    if (!child) return;
    const def = child.def;
    const el = document.createElement('div');
    el.className = 'lens';
    el.setAttribute('role', 'group');
    const body = document.createElement('div');
    body.className = 'lens-body';
    const tag = document.createElement('span');
    tag.className = 'lens-tag';
    el.append(body, tag);
    // drawn off the page: its extent is known before it is placed, and the page is laid out once, after every change
    // (on the out-of-order core each layout of the stage costs ~50 ms: DESIGN.md item 2's budget is one task)
    const events: SchematicEvents = {
      ...this.host.events?.(child),
      open: (c) => this.host.drill([...child.path, c]),
      select: (c) => {
        this.sel = c;
        this.host.selected();
      },
      toggleInput: () => {},
      editInput: () => {},
      up: () => this.close(),
    };
    // the lens is read-only for arranging: a wheel zooms and a drag pans the level outside (the lens follows its box);
    // a press on a part still selects it, a double-click steps in
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.gate.wheel(e.timeStamp, e.deltaY);
      this.host.view.wheelAt(e.deltaY, e.clientX, e.clientY);
      this.zoomed(e.clientX, e.clientY);
    }, { capture: true, passive: false });
    // two fingers on the lens pinch the level outside, as on the board (registered first: it swallows the second finger
    // before the pan below or the inside's own pinch sees it)
    let endPan: (() => void) | null = null, pinched = false;
    installPinch(el, {
      start: () => { endPan?.(); view.cancelHold(); pinched = true; },
      move: (k, mid, prev) => this.host.view.pinchAt(k, mid, prev),
      end: (mid) => this.pinched(mid, true),
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('.inst')) return;
      e.stopPropagation();
      let x = e.clientX, y = e.clientY;
      const x0 = x, y0 = y, wire = (e.target as Element).closest('[data-net]');
      const move = (m: PointerEvent) => { this.host.view.panBy(m.clientX - x, m.clientY - y); x = m.clientX; y = m.clientY; };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        endPan = null;
        // a press on a wire that did not pan is a click on it (Why? traces it, else it is selected)
        if (wire && (Math.abs(x - x0) + Math.abs(y - y0)) / (this.unitPx() || 1) <= TAP_SLOP) this.wireTap(Number(wire.getAttribute('data-net')));
      };
      endPan = up;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }, { capture: true });
    // a finger's tap (DESIGN.md item 6): on a part at least TAP_SELECT_PX on screen it selects (the inside's own click),
    // anywhere else but a wire it steps into the box: most inner parts are under a fingertip at this size, and a drill that lands
    // beats a tap that misses. A double tap on a large part still steps into that part (the inside's DoubleTap).
    let down: { x: number; y: number; t: number; id: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      if (!e.isPrimary) return void (down = null);
      pinched = false;
      down = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    }, { capture: true });
    el.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (e.pointerType !== 'touch' || !d || d.id !== e.pointerId || pinched || !this.open) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP_PX || e.timeStamp - d.t > TAP_MS) return;
      // a tap on a wire is the inside's (it selects it; Why? traces it)
      if ((e.target as Element).closest?.('[data-net]')) return;
      const g = (e.target as Element).closest?.('.inst');
      const r = g?.getBoundingClientRect();
      if (r && Math.min(r.width, r.height) >= TAP_SELECT_PX) return;
      e.stopPropagation();
      e.preventDefault();
      // the click the browser sends after this tap must not select what the next level draws there
      const eat = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 600);
      this.host.drill(child.path);
    }, { capture: true });
    const view = new SchematicView(body, events);
    view.trace = !!this.host.events;
    view.show(child, false);
    const extent = view.contentBox();
    // the blocks whose names the lens must show (gate glyphs carry none): legible.ts planNames names a block once its
    // longer side is MIN_BLOCK_PX on screen
    const named = new Set([...body.querySelectorAll<SVGGElement>('g.lg-named')].map((g) => g.dataset.inst));
    const parts = view.partBoxes().filter(([n]) => named.has(n));
    const smallest = parts.length ? Math.min(...parts.map(([, b]) => Math.max(b.w, b.h))) : 4;
    const free = this.free(extent);
    let plan = openPlan(box, extent, smallest, free, this.touch ? PHONE_LENS_W : LENS_W);
    if (!plan) {
      view.clear();
      el.remove();
      if (full) return;
      const why = this.stepIn;
      this.refused.set(key, why);
      return this.showHint(box, why);
    }
    let opened = { plan, boxH: box.h };
    if (full) {
      // as if it had opened at the opening size and grown to just under the free stage: the box is zoomed to the size it
      // has at the hand-off, so the zoom-out that follows shrinks the lens and closes it where it would have opened
      const sFull = 0.995 * Math.min((free.w - 2 * RIM_PX) / extent.w, (free.h - TAG_PX - RIM_PX) / extent.h);
      const bOpen = box.h * Math.max(1, LENS_OPEN_PX / Math.min(box.w, box.h));
      opened = { plan, boxH: bOpen };
      const k = (bOpen * sFull) / plan.scale / box.h;
      const c = this.host.canvas.getBoundingClientRect();
      if (k > 1) this.host.view.wheelAt(-Math.log(k) / 0.0015, c.left + box.x + box.w / 2, c.top + box.y + box.h / 2);
      const b1 = this.boxPx(name);
      if (!b1) {
        view.clear();
        el.remove();
        return;
      }
      box = b1;
      plan = growPlan(opened, box, extent, free).plan;
    }
    const n = child.node.children?.size ?? 0;
    const label = `${name} · ${def.name} · ${n} part${n === 1 ? '' : 's'} · live${this.touch ? ' · tap to step in' : ''}`;
    el.setAttribute('aria-label', `Inside ${name} (${def.name}): ${n} parts, live`);
    const rim = document.createElementNS(SVG, 'svg') as SVGSVGElement;
    rim.setAttribute('class', 'lens-rim');
    rim.setAttribute('aria-hidden', 'true');
    this.layer.append(rim);
    this.open = { name, ctx: child, view, el, body, tag, rim, extent, opened, plan, label };
    this.place(plan);
    this.layer.insertBefore(el, rim);
    this.paintOverlay();
    this.paintRim();
    this.applyLit();
    // the dim in the next frame and the peek crumb in a task after it: on a level of thousands of parts (the out-of-order
    // core) restyling them and laying the stage out again are ~60-80 ms each, so each gets a task of its own and the
    // opening itself stays under DESIGN.md's 50 ms (scripts/lens-ooo-measure.mjs)
    const openNow = this.open;
    requestAnimationFrame(() => {
      if (this.open !== openNow) return;
      this.host.view.setLensBox(name);
      // the crumb after that frame has painted, as a task of its own
      setTimeout(() => { if (this.open === openNow) this.host.peek(child); }, 0);
    });
    // the box's outline grows into the lens while the inside fades in
    if (!reducedMotion() && !full) {
      const r = plan.rect;
      el.animate([
        { transform: `translate(${box.x - r.x}px, ${box.y - r.y}px) scale(${box.w / r.w}, ${box.h / r.h})`, opacity: 0.55 },
        { transform: 'none', opacity: 1 },
      ], { duration: OPEN_MS, easing: 'ease-out' });
      rim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-in' });
    }
    // what opening took on the main thread (the sub-simulation, the inside's drawing, its placement): the smoke and
    // the out-of-order measurement read it (DESIGN.md item 2's 50 ms budget)
    el.dataset.buildMs = (performance.now() - t0).toFixed(1);
    this.host.say(`${name} opened in place; Enter steps in`);
  }

  /** A click on a wire inside the lens. */
  private wireTap(idx: number): void {
    const o = this.open;
    if (!o || this.host.events?.(o.ctx).netClick?.(idx)) return;
    o.view.select(null);
    o.view.selectNet(idx);
  }

  /** Position the lens and set its inside's view box for this plan. */
  private place(plan: LensPlan): void {
    const o = this.open!;
    o.plan = plan;
    const { rect: r, inner: i, scale } = plan;
    Object.assign(o.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    Object.assign(o.body.style, { left: `${i.x - r.x}px`, top: `${i.y - r.y}px`, width: `${i.w}px`, height: `${i.h}px` });
    const w = i.w / scale, h = i.h / scale, e = o.extent;
    // centred on the inside while it fits; a tall or wide inside cut by the cap shows the part nearest the box's middle
    o.view.setView({ x: e.x + (e.w - w) / 2, y: e.y + (e.h - h) / 2, w, h }, { w: i.w, h: i.h });
  }

  // ---- following the camera ---------------------------------------------------------------

  private cameraMoved(): void {
    this.handedCue();
    const o = this.open;
    if (!o) return;
    const box = this.boxPx(o.name);
    const free = this.free(o.extent);
    if (!box || closesAt(box, free)) return void this.close();
    const { plan, handoff } = growPlan(o.opened, box, o.extent, free);
    if (handoff) return this.handOff();
    this.place(plan);
    this.paintRim();
  }

  /** The lens reached the free stage: the view becomes its level at the same scale and place. */
  private handOff(): void {
    const o = this.open!;
    const outer = this.host.ctx();
    const { inner: i, scale } = o.plan;
    const w = i.w / scale, h = i.h / scale, e = o.extent;
    const vx = e.x + (e.w - w) / 2, vy = e.y + (e.h - h) / 2;
    const c = this.canvasSize();
    const vb = { x: vx - i.x / scale, y: vy - i.y / scale, w: c.w / scale, h: c.h / scale };
    const path = o.ctx.path;
    const parent = outer ? { label: outer.path[outer.path.length - 1] ?? outer.def.name, path: outer.path } : null;
    this.close();
    this.host.drill(path, vb);
    if (parent) this.handed = { path, parent, px: this.unitPx() };
  }

  /** After a hand-off, once the zoom-out shows the whole level again: "Keep zooming out to go up to cpu"; a fresh zoom-out then does (goUp). */
  private handedCue(): void {
    const hd = this.handed, ctx = this.host.ctx();
    if (!hd || !ctx || ctx.path.join('.') !== hd.path.join('.')) return;
    // only once the learner zooms out from where the hand-off left the level
    if (this.unitPx() > hd.px * 0.9) return;
    const b = this.host.view.contentBox();
    const p = this.host.view.toClient([b.x, b.y]), q = this.host.view.toClient([b.x + b.w, b.y + b.h]);
    const c = this.host.canvas.getBoundingClientRect();
    if (p && q && p[0] >= c.left - 1 && p[1] >= c.top - 1 && q[0] <= c.right + 1 && q[1] <= c.bottom + 1) {
      this.host.cue(hd.parent);
      this.gate.cue(performance.now());
    }
  }

  /** A fresh zoom-out after the cue: one level up, the level we left opened in its lens at full size, shrinking as the
   *  zoom goes on (the hand-off in reverse). Up the way Esc and the crumb go, so history is the same. */
  private goUp(): void {
    const hd = this.handed;
    if (!hd) return;
    this.handed = null;
    this.gate.clear();
    this.host.cue(null);
    this.host.drill(hd.parent.path);
    const name = hd.path[hd.path.length - 1];
    if (name !== undefined) this.openFull(name);
  }

  /** Open the lens on `name` of the level on screen at the size it hands off at: the view zooms onto the box so the lens's
   *  scale law (growPlan) holds, and zooming out shrinks it until it closes under LENS_CLOSE_PX. */
  openFull(name: string): void {
    const ctx = this.host.ctx();
    if (!ctx || !this.host.allowed() || !ctx.canOpen(name) || this.host.tooLarge(ctx, name)) return;
    const box = this.boxPx(name);
    if (!box) return;
    this.close();
    this.hideHint();
    this.build(ctx, name, box, '', true);
  }

  /** Screen px per grid unit of the level on screen. */
  private unitPx(): number {
    const a = this.host.view.toClient([0, 0]), b = this.host.view.toClient([1, 0]);
    return a && b ? b[0] - a[0] : 0;
  }

  // ---- the rim ----------------------------------------------------------------------------

  /** The connectors: each outer port's height on the box, along the rim channel, to the inner pin (named there). */
  private paintRim(): void {
    const o = this.open;
    if (!o) return;
    const c = this.host.canvas.getBoundingClientRect();
    const L = o.plan.rect;
    const inner = new Map(o.view.levelPins().map((p) => [p.pin.name, p]));
    const ports: RimPort[] = [];
    const lensC = { left: L.x + c.left, top: L.y + c.top, right: L.x + L.w + c.left, bottom: L.y + L.h + c.top };
    for (const p of this.host.view.portsOf(o.name)) {
      const pin = inner.get(p.name);
      const ip = pin && o.view.toClient(pin.pin.pos);
      if (!ip) continue;
      const x = this.host.view.wireExit(o.name, p.name, lensC);
      // the pin as drawn inside, kept within the lens when a cut inside leaves it out of view
      const py = Math.min(Math.max(ip[1] - c.top, L.y + 6), L.y + L.h - 6);
      const px = Math.min(Math.max(ip[0] - c.left, L.x + 2), L.x + L.w - 2);
      const side = p.dir === 'out' ? 'right' : 'left';
      // a pin drawn deep inside (the ALU's flags): the connector stops at the rim, so it never crosses the drawing; its dot
      // lights the pin on hover
      const rimX = side === 'left' ? L.x + 2 : L.x + L.w - 2;
      const deep = Math.abs(px - rimX) > DEEP_PX;
      ports.push({ name: p.name, side, outer: x && { x: x.x - c.left, y: x.y - c.top, edge: x.edge }, pin: [deep ? rimX : px, py] });
      if (deep) this.deep.add(p.name);
    }
    const jogs = rimJogs(L, ports);
    const deep = this.deep;
    this.deep = new Set();
    o.rim.replaceChildren(...jogs.flatMap((j) => {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', j.d);
      path.setAttribute('class', 'lens-jog');
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', String(j.pin[0]));
      dot.setAttribute('cy', String(j.pin[1]));
      dot.setAttribute('r', '3.5');
      dot.setAttribute('class', deep.has(j.name) ? 'lens-dot deep' : 'lens-dot');
      if (deep.has(j.name)) {
        const t = document.createElementNS(SVG, 'title');
        t.textContent = `${j.name}: its pin is inside, lit while you point here`;
        dot.append(t);
        dot.addEventListener('pointerenter', () => o.view.highlight([`pin:${j.name}`], true));
        dot.addEventListener('pointerleave', () => o.view.highlight([]));
      }
      const t = document.createElementNS(SVG, 'text');
      t.setAttribute('x', String(j.label[0]));
      t.setAttribute('y', String(j.label[1]));
      t.setAttribute('class', `lens-port ${j.side}`);
      t.textContent = j.name;
      return [path, dot, t];
    }));
  }

  // ---- the hint on a box that does not open -----------------------------------------------

  private showHint(box: Rect, text: string): void {
    this.hideHint();
    const el = document.createElement('div');
    el.className = 'lens-hint';
    el.textContent = text;
    el.style.left = `${box.x + box.w / 2}px`;
    el.style.top = `${box.y + box.h / 2}px`;
    this.layer.append(el);
    this.hint = el;
    this.host.say(text);
  }

  private hideHint(): void {
    this.hint?.remove();
    this.hint = null;
  }
}
