// Open blocks as you zoom (docs/transparent/DESIGN.md, Revision 3): with the View option on, a block's inside is drawn
// within its own outline once it is big enough for the names inside it to read (lensplan.ts openAtPx, the one rule), live,
// crossfading from the symbol. It grows on screen only with the view's zoom: neighbours and their wires never move and are
// never covered. Every block on screen that meets the rule opens, one built per frame, nearest the pointer first. Once an
// inside's drawing covers the canvas in width or height the view becomes that level (a drill, nothing jumps); zooming back
// out to fit there shows "Keep zooming out to go up to cpu", and a fresh zoom-out goes up (view/zoomout.ts), the level left
// drawn open in its box where it was.
// Each inside is its own SchematicView in an overlay on the box, so the level's own svg never holds one: print and image
// export draw closed boxes. The stage imports this module only while the setting is on, so off costs nothing.
import '../styles/lens.css';
import { reducedMotion } from '../ui/motion';
import { ICON } from './boxtext';
import { MIN_VIEW_UNITS, TAP_SLOP } from './camera';
import type { ViewCtx } from './context';
import { isConstantDef } from '../sim/constant';
import { bandOf, NO_BAND, type Band, capOpenAt, decide, fitInside, FADE_MS, FLOOR_PX, runsOf, handOffView, handsOff, insideExtent, openAtPx, smallestNamed, type Rect } from './lensplan';
import { cueWords, progress, ZoomOutGate } from './zoomout';
import type { OverlayResult } from './overlays';
import { SchematicView, type SchematicEvents } from './schematic';
import { netlistOf, type ComponentDef } from '../sim/types';

const SVG = 'http://www.w3.org/2000/svg';
/** Past this factor still to zoom the hint also offers the double-click (zooming that far is a chore). */
export const HINT_MAX_ZOOM = 4;
/** An inside built more than this far (px) outside the canvas is dropped: it would only cost repaints. */
const KEEP_PX = 200;
const nearCanvas = (r: Rect | null, c: DOMRect): boolean => !!r && r.x + r.w > -KEEP_PX && r.y + r.h > -KEEP_PX && r.x < c.width + KEEP_PX && r.y < c.height + KEEP_PX;
/** The size (px) a run's end names are drawn at (legible.ts draws block names at about this size). */
const RUN_NAME_PX = 11;
/** The hint's height with its gap (px): it goes where it has that much room. */
const HINT_ROOM_PX = 30;
/** A category icon (boxtext.ts ICON units) is hidden past this size on screen (px). */
const ICON_MAX_PX = 36;
/** On a touch screen a tap inside an open box selects a part at least this big on screen (px, the coarse-pointer target);
 *  anywhere else it steps into the box (DESIGN.md item 6). */
export const TAP_SELECT_PX = 40;
/** A touch is a tap while it moves less than this (px) and lifts within TAP_MS (a longer press is the held-finger menu). */
const TAP_SLOP_PX = 8, TAP_MS = 450;
/**
 * Run `f` at the next animation frame, or after SOON_MS if frames are held back (a page not in front: the smoke's parallel
 * tabs, a window behind another), whichever comes first: the rule must not wait for a paint to decide. A handle for cancelSoon.
 */
const SOON_MS = 60;
const pending = new Map<number, [number, number]>();
let soonId = 0;
function soon(f: () => void): number {
  const id = ++soonId;
  const run = () => {
    const h = pending.get(id);
    if (!h) return;
    pending.delete(id);
    cancelAnimationFrame(h[0]);
    clearTimeout(h[1]);
    f();
  };
  pending.set(id, [requestAnimationFrame(run), window.setTimeout(run, SOON_MS)]);
  return id;
}
function cancelSoon(id: number): void {
  const h = pending.get(id);
  if (!h) return;
  pending.delete(id);
  cancelAnimationFrame(h[0]);
  clearTimeout(h[1]);
}
/** The view has settled when the camera has not moved for this long (ms). */
export const SETTLE_MS = 160;

export interface LensHost {
  /** The level on screen and its view. */
  readonly view: SchematicView;
  ctx(): ViewCtx | null;
  /** The element the view draws in; the insides are placed over it, in its pixels. */
  readonly canvas: HTMLElement;
  /** Unused since Revision 3 (an inside stays in its box): kept so hosts need not change. */
  covers?(): Rect[];
  /** May an inside open on this scene at all (not on the breadboards, an NMOS scene, a leaf's widget)? */
  allowed(): boolean;
  /** Unused since phase 2f. */
  tooLarge?(ctx: ViewCtx, name: string): boolean;
  /** Step into a level (history as for a double-click); `vb`: the view box to show it at, so nothing jumps. */
  drill(path: string[], vb?: { x: number; y: number; w: number; h: number }): void;
  /** The breadcrumb's inside crumb (null: none). */
  peek(ctx: ViewCtx | null): void;
  /** The overlay for a level (null: none on), as the stage paints its own. */
  overlay(ctx: ViewCtx): OverlayResult | null;
  /** Why the overlay is not drawn inside (a sub-simulation's activity), or null. */
  overlayGap(ctx: ViewCtx): string | null;
  /** An inner part selected (null: none): the inspector follows. */
  selected(): void;
  /** The cue after a hand-off ("Keep zooming out to go up to cpu"); null removes it. */
  cue(parent: { label: string; path: string[]; words?: string; progress?: number } | null): void;
  say(text: string): void;
  /** More of an inside view's events for its level (Why? clicks, the menu's Why this value? and Explain); its open / select /
   *  up stay the lens's. */
  events?(ctx: ViewCtx): Partial<SchematicEvents>;
}

/** A block of the level on screen that can open, and its inside once built. */
interface Box {
  name: string;
  def: ComponentDef;
  /** View px per unit at which it opens (lensplan.ts openAtPx), from the box and its inside alone. */
  openAt: number;
  /** Its own opening zoom (openAtPx, from the box and its inside), before the canvas's cap (capOpenAt). */
  base: number;
  /** Room it keeps inside its edges for its port names (lensplan.ts bandOf). */
  band: Band;
  /** Its size, outer grid units. */
  size: { w: number; h: number };
  /** What the rule said last (decide's hysteresis). */
  want: boolean;
  /** Its level once prepared (the first half of a build). */
  child?: ViewCtx;
  childMs?: number;
  ctx?: ViewCtx;
  view?: SchematicView;
  el?: HTMLElement;
  /** The drawn inside's extent (inner units). */
  extent?: Rect;
  stubs?: SVGGElement;
  runs?: SVGGElement;
  shown?: boolean;
  /** Its fade-out's start (a show in between cancels the drop). */
  gone?: number;
  /** Faded out while fingers were down: dropped when they lift (removing the element under a finger ends its gesture). */
  dropLater?: boolean;
  /** A finger's press on the inside handed to the canvas's pinch: its pan and tap let go. */
  cancelTouch?: (id: number) => void;
  sel?: string | null;
}

export class Lens {
  private boxes = new Map<string, Box>();
  /** The level the boxes belong to (path key). */
  private levelKey = '';
  private focus: [number, number] | null = null;
  /** The open box the pointer is over: the crumb names it, Why? and the inspector use it. */
  private over: string | null = null;
  private hint: { el: HTMLElement; name: string } | null = null;
  /** The level the last hand-off (or step in) entered, for the cue once the zoom-out reaches fit. */
  private handed: { path: string[]; parent: { label: string; path: string[] }; px: number } | null = null;
  private off: (() => void)[] = [];
  private gate = new ZoomOutGate();
  private pinchLive = false;
  /** A zoom-in step since the last evaluation (the wheel, `+`, a spreading pinch): at the zoom limit it steps in. */
  private pushIn = false;
  /** Touch pointers down on the canvas, by id. While any is, nothing the lens does moves the camera or changes the level:
   *  a hand-off, a step in at the zoom limit and going up wait for the last finger to lift (the gesture's). */
  private fingers = new Set<number>();
  /** The touch gesture under way: the zoom it began at, and what it asked for (a step in at the limit, going up). */
  private gesture: { px: number; limit: boolean; up: boolean } | null = null;
  /** A pointercancel of our own on its way (cancelPress): the lens's listeners let it pass. */
  private forwarding = false;
  /** What the stage lights now (its own level's names, `box.part` for parts inside a box). */
  private litNames: string[] = [];
  /** The view's px per unit at the last evaluation: a hand-off needs a zoom in. */
  private lastPx = 0;
  private frame = 0;
  private buildFrame = 0;
  private settleTimer = 0;
  /** When the camera last moved (a sub-simulation waits for it to settle). */
  private moved = 0;
  /** One layer over the canvas for every inside and the hint (a child added to the canvas itself re-checks its :has() rules). */
  private layer: HTMLElement;

  constructor(private host: LensHost) {
    const v = host.view;
    this.layer = document.createElement('div');
    this.layer.className = 'lens-layer';
    host.canvas.append(this.layer);
    this.off.push(() => this.layer.remove());
    const wheel = (e: WheelEvent) => {
      if (this.gate.wheel(e.timeStamp, e.deltaY) === 'up') return this.goUp();
      this.zoomed(e.clientX, e.clientY, e.deltaY < 0);
    };
    v.el.addEventListener('wheel', wheel, { passive: true });
    this.off.push(() => v.el.removeEventListener('wheel', wheel));
    v.onCamera(() => this.schedule());
    this.off.push(v.onPinch((mid, done, k) => this.pinched(mid, done, k)));
    // the hint: hovering a closed block that can open says how much more zoom it needs
    const move = (e: PointerEvent) => {
      this.focus = [e.clientX, e.clientY];
      if (e.pointerType === 'touch') return;
      const g = (e.target as Element).closest?.('g.inst') as SVGGElement | null;
      this.hover(g?.dataset.inst ?? null);
    };
    const leave = () => this.hover(null);
    v.el.addEventListener('pointermove', move);
    v.el.addEventListener('pointerleave', leave);
    this.off.push(() => { v.el.removeEventListener('pointermove', move); v.el.removeEventListener('pointerleave', leave); });
    // the fingers on the canvas: in the capture phase on the window, ahead of the pinches that swallow their events
    const fingerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      // a primary touch begins a new touch session: no other finger can still be down (a lift we never heard)
      if (e.isPrimary) this.fingers.clear();
      if (!this.fingers.size) this.gesture = { px: this.unitPx(), limit: false, up: false };
      this.fingers.add(e.pointerId);
    };
    const fingerUp = (e: PointerEvent) => {
      if (this.forwarding) return;
      if (this.fingers.delete(e.pointerId) && !this.fingers.size) this.released();
    };
    // One pinch for the whole circuit. Two fingers on the board, on an inside, or one on each (an inside ~200 px wide takes
    // one finger of a pinch as often as not) are one pinch, tracked here in the canvas's capture phase, ahead of the
    // board's and the insides' own handlers: those each saw one finger, so nothing zoomed and the inside's pan slid the
    // view with both. The second finger's events never reach them, and the first's press is cancelled where it landed
    // (its pan, hold or tap; cancelPress), its later events swallowed here until it lifts.
    const pts = new Map<number, { at: [number, number]; target: Element }>();
    const owned = new Set<number>();
    let pinching = false, lastMid: [number, number] = [0, 0];
    const onCircuit = (t: EventTarget | null) => t instanceof Element && (v.el.contains(t) || this.layer.contains(t));
    const swallow = (e: Event) => { e.stopImmediatePropagation(); e.preventDefault(); };
    const geom = () => {
      const [a, b] = [...pts.values()].map((p) => p.at);
      return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number] };
    };
    const pDown = (e: PointerEvent) => {
      if (this.forwarding || e.pointerType !== 'touch') return;
      if (e.isPrimary) { pts.clear(); owned.clear(); pinching = false; }
      if (pts.size >= 2) { owned.add(e.pointerId); return swallow(e); } // a third finger
      if (!onCircuit(e.target)) return;
      pts.set(e.pointerId, { at: [e.clientX, e.clientY], target: e.target as Element });
      if (pts.size < 2) return;
      pinching = true;
      for (const [id, p] of pts) if (id !== e.pointerId) this.cancelPress(p.target, id, p.at);
      for (const id of pts.keys()) owned.add(id);
      swallow(e);
    };
    const pMove = (e: PointerEvent) => {
      if (this.forwarding) return;
      const p = pts.get(e.pointerId);
      if (p) {
        const before = pinching ? geom() : null;
        p.at = [e.clientX, e.clientY];
        const after = before && geom();
        // the stage's camera, and its pinch listeners: this lens's pinched()
        if (before && after && before.d > 0 && after.d > 0) v.pinchAt(after.d / before.d, after.mid, before.mid);
      }
      if (owned.has(e.pointerId)) swallow(e);
    };
    const pEnd = (e: PointerEvent) => {
      if (this.forwarding) return;
      if (pinching && pts.has(e.pointerId)) lastMid = geom().mid;
      const was = pinching;
      pts.delete(e.pointerId);
      pinching = pts.size === 2;
      if (was && !pinching) this.pinched(lastMid, true);
      if (owned.delete(e.pointerId)) swallow(e);
    };
    host.canvas.addEventListener('pointerdown', pDown, { capture: true });
    window.addEventListener('pointermove', pMove, { capture: true });
    this.off.push(() => {
      host.canvas.removeEventListener('pointerdown', pDown, { capture: true });
      window.removeEventListener('pointermove', pMove, { capture: true });
    });
    const lost = () => {
      if (!this.fingers.size) return;
      this.fingers.clear();
      this.released();
    };
    host.canvas.addEventListener('pointerdown', fingerDown, { capture: true });
    // the count first, then the pinch's end (which swallows its fingers' lifts)
    window.addEventListener('pointerup', fingerUp, { capture: true });
    window.addEventListener('pointercancel', fingerUp, { capture: true });
    window.addEventListener('pointerup', pEnd, { capture: true });
    window.addEventListener('pointercancel', pEnd, { capture: true });
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', lost);
    this.off.push(() => {
      host.canvas.removeEventListener('pointerdown', fingerDown, { capture: true });
      window.removeEventListener('pointerup', fingerUp, { capture: true });
      window.removeEventListener('pointercancel', fingerUp, { capture: true });
      window.removeEventListener('pointerup', pEnd, { capture: true });
      window.removeEventListener('pointercancel', pEnd, { capture: true });
      window.removeEventListener('blur', lost);
      document.removeEventListener('visibilitychange', lost);
    });
    this.levelChanged(host.ctx()?.path ?? []);
    this.started = true;
  }

  /** Torn down (the setting turned off, the stage gone). */
  dispose(): void {
    this.dropAll();
    for (const b of this.boxes.keys()) this.groupOf(b)?.removeAttribute('data-open-at');
    this.host.view.el.classList.remove('lens-bigicons');
    this.hideHint();
    this.off.forEach((f) => f());
    this.off = [];
    cancelSoon(this.frame);
    cancelSoon(this.buildFrame);
    clearTimeout(this.settleTimer);
  }

  /** A zoom step toward a client point (the wheel's pointer, the keyboard cursor's part). */
  zoomed(clientX: number, clientY: number, inward = false): void {
    this.focus = [clientX, clientY];
    if (inward) this.pushIn = true;
    this.hideHint();
    this.schedule();
  }

  /** A pinch step (scale `k`) or its end around a client point. */
  pinched(mid: [number, number], done: boolean, k = 1): void {
    if (done) {
      this.pinchLive = false;
      this.gate.pinchEnd();
    } else {
      const start = !this.pinchLive;
      this.pinchLive = true;
      // going up changes the level and the camera: not under the fingers, when they lift
      if (this.gate.pinch(performance.now(), k, start) === 'up') {
        if (this.fingers.size && this.gesture) this.gesture.up = true;
        else this.goUp();
      }
    }
    this.focus = mid;
    if (k > 1) this.pushIn = true;
    this.schedule();
  }

  /** Is any inside shown? */
  get isOpen(): boolean {
    return [...this.boxes.values()].some((b) => b.shown);
  }

  /** The open box the crumb, the inspector and Why? follow: the one under the pointer. */
  private get cur(): Box | null {
    const b = this.over ? this.boxes.get(this.over) : null;
    return b?.shown && b.ctx ? b : null;
  }

  /** An inner part selected in a shown inside, with its level. */
  selection(): { ctx: ViewCtx; name: string } | null {
    const c = this.cur;
    if (c?.sel && c.ctx) return { ctx: c.ctx, name: c.sel };
    for (const b of this.boxes.values()) if (b.shown && b.ctx && b.sel) return { ctx: b.ctx, name: b.sel };
    return null;
  }

  /** The inside the pointer is over (Why? lights and selects in it). */
  get innerView(): SchematicView | null {
    return this.cur?.view ?? null;
  }

  /** Its level (the breadcrumb's "alu (inside)"). */
  get peekCtx(): ViewCtx | null {
    return this.cur?.ctx ?? null;
  }

  /** The stage lit these: parts named `<box>.<part>` light inside that box's inside; the box alone, its outline glows. */
  lit(names: readonly string[]): void {
    this.litNames = [...names];
    for (const b of this.boxes.values()) this.applyLit(b);
  }

  private applyLit(b: Box): void {
    const pre = `${b.name}.`;
    const on = !!(b.shown && b.view && b.ctx);
    const have = b.ctx?.node.children;
    const inner = on ? [...new Set(this.litNames.filter((n) => n.startsWith(pre)).map((n) => n.slice(pre.length).split('.')[0]))].filter((n) => have?.has(n)) : [];
    if (on) b.view!.highlight(inner, inner.length > 0);
    this.host.view.boxClass(b.name, 'lens-lit', on && !inner.length && this.litNames.includes(b.name));
  }

  /** Nothing modal to close since Revision 3 (the zoom decides): Esc and tours go on as without the setting. False. */
  close(): boolean {
    return false;
  }

  /** The level on screen changed (a drill, going up, a new scene): its blocks are measured again; a hand-off keeps its cue. */
  levelChanged(path: string[]): void {
    this.dropAll();
    this.hideHint();
    const was = this.levelKey;
    this.levelKey = path.join('.');
    if (this.handed && path.join('.') !== this.handed.path.join('.')) {
      this.handed = null;
      this.cueFits = null;
      this.host.cue(null);
      this.gate.clear();
    }
    // one step in from the level before, however it came (a hand-off, a double-click, the crumb): the way up is shown
    const now = this.host.ctx(), up = now?.parent;
    if (!this.handed && now && up && now.path.join('.') === this.levelKey && up.path.join('.') === was && this.started) {
      this.handed = { path: now.path, parent: { label: up.path[up.path.length - 1] ?? up.def.name, path: up.path }, px: this.unitPx() };
    }
    this.measure();
    this.schedule();
  }

  /** Live values: after every repaint of the stage. */
  update(): void {
    for (const b of this.boxes.values()) if (b.shown && b.view) {
      b.view.update();
      this.paintStubs(b);
    }
  }

  /** The stage's overlay changed or ticked. */
  paintOverlay(): void {
    for (const b of this.boxes.values()) if (b.view && b.ctx) b.view.overlay(this.host.overlay(b.ctx));
  }

  /** The stage's covers moved: an inside stays in its box, so nothing to do but follow it. */
  coversChanged(): void {
    this.schedule();
  }

  // ---- the rule ------------------------------------------------------------------------------

  /** Every block of the level that can open, with the zoom it opens at (data-open-at on its group, for tests and the hint). */
  private measure(): void {
    const ctx = this.host.ctx();
    const v = this.host.view;
    if (!ctx || ctx.path.join('.') !== this.levelKey || v.context !== ctx) return;
    for (const [name, r] of v.partBoxes()) {
      if (!ctx.canOpen(name)) continue;
      const def = ctx.node.children?.get(name)?.def;
      // a constant (a tie cell: a rail and a stub) has nothing to show in place
      const e = def && !isConstantDef(def) && insideExtent(def);
      if (!def || !e) continue;
      const inst = netlistOf(ctx.def)?.instances.find((i) => i.name === name);
      const band = bandOf(def, inst?.flip, inst?.rot);
      const base = openAtPx(r, fitInside(r, e, band).k, smallestNamed(def));
      if (!Number.isFinite(base)) continue;
      this.boxes.set(name, { name, def, base, band, openAt: base, size: { w: r.w, h: r.h }, want: false });
    }
    this.capFor = '';
    this.cap(this.canvasRect());
  }

  private groupOf(name: string): SVGGElement | null {
    return this.host.view.el.querySelector<SVGGElement>(`g.inst[data-inst="${CSS.escape(name)}"]`);
  }

  private schedule(): void {
    this.moved = performance.now();
    if (this.frame) return;
    this.frame = soon(() => {
      this.frame = 0;
      this.evaluate();
    });
  }

  /** Screen px per grid unit of the level on screen. */
  private unitPx(): number {
    const a = this.host.view.toClient([0, 0]), b = this.host.view.toClient([1, 0]);
    return a && b ? b[0] - a[0] : 0;
  }

  private canvasRect(): DOMRect {
    return this.host.canvas.getBoundingClientRect();
  }

  /** A grid rectangle of the level on screen → canvas px. */
  private toPx(r: Rect, c: DOMRect): Rect | null {
    const p = this.host.view.toClient([r.x, r.y]), q = this.host.view.toClient([r.x + r.w, r.y + r.h]);
    return p && q ? { x: p[0] - c.left, y: p[1] - c.top, w: q[0] - p[0], h: q[1] - p[1] } : null;
  }

  /** A box's outline on screen, canvas px. */
  private boxPx(name: string, c = this.canvasRect()): Rect | null {
    const r = this.host.view.boxOf(name);
    return r ? this.toPx(r, c) : null;
  }

  private capFor = '';
  /** The canvas's cap on every box's opening zoom (lensplan.ts capOpenAt), again when the canvas changes size; data-open-at
   *  is the capped value, the one the rule uses. */
  private cap(c: DOMRect): void {
    const key = `${Math.round(c.width)}x${Math.round(c.height)}|${this.boxes.size}`;
    if (key === this.capFor) return;
    this.capFor = key;
    for (const b of this.boxes.values()) {
      b.openAt = capOpenAt(b.base, b.size, { w: c.width, h: c.height });
      this.groupOf(b.name)?.setAttribute('data-open-at', b.openAt.toFixed(2));
    }
  }

  /** Apply the rule to every block at the current zoom: show, hide, place, queue builds, hand off. */
  private evaluate(): void {
    this.handedCue();
    const ctx = this.host.ctx();
    if (!ctx || ctx.path.join('.') !== this.levelKey) return;
    // the level drawn after the lens heard of it (a drill draws, then tells): measured now
    if (!this.boxes.size) this.measure();
    const ok = this.host.allowed();
    const px = this.unitPx();
    const c = this.canvasRect();
    this.cap(c);
    this.host.view.el.classList.toggle('lens-bigicons', px * ICON > ICON_MAX_PX);
    const zoomingIn = this.lastPx > 0 && px > this.lastPx * 1.0001;
    // only a zoom out closes a box (R3.4): a panel docking or folding, a resize or a pan moves the cap or the box, not the zoom
    const zoomingOut = this.lastPx > 0 && px < this.lastPx * 0.9999;
    this.lastPx = px;
    let wantBuild = false;
    for (const b of this.boxes.values()) {
      const r = this.boxPx(b.name, c);
      const near = nearCanvas(r, c);
      // the answer is kept for a box panned out of reach (only its drawing goes), so it comes back as it left
      const open = decide(b.want, px, b.openAt);
      b.want = ok && (open || (b.want && !zoomingOut));
      if (!near) { if (b.view || b.child) this.drop(b); }
      else if (b.want && !b.view) wantBuild = true;
      else if (b.want) this.show(b);
      else if (!b.view && b.child) b.child = undefined;
      else this.hide(b);
      if (b.view && r) this.place(b, r);
    }
    if (this.hint) this.hover(this.hint.name);
    if (wantBuild) this.queueBuild();
    // at the deepest zoom a further step in steps into the open box under the pointer: the view cannot zoom on, so the
    // hand-off (R3.5) is reached however small the inside is drawn in its box
    const push = this.pushIn, atLimit = px >= (0.995 * c.width) / MIN_VIEW_UNITS;
    this.pushIn = false;
    // fingers down: the hand-off waits for them to lift (released), the gesture remembering a push at the limit
    if (this.fingers.size) {
      if (push && atLimit && this.gesture) this.gesture.limit = true;
    } else if (zoomingIn || (push && atLimit)) this.maybeHandOff(c, atLimit);
  }

  /**
   * The last finger lifted: what the gesture asked for and the lens held back, now. Going up; else a hand-off when the
   * gesture zoomed in past it (the evaluations during it saw each step, not the whole) or pushed at the zoom limit; the
   * insides faded during it dropped, the crumb's inside let go.
   */
  private released(): void {
    const g = this.gesture;
    this.gesture = null;
    if (g?.up) {
      this.dropDeferred();
      return this.goUp();
    }
    // the evaluation the last move asked for, now, so the hand-off below reads this zoom's boxes
    cancelSoon(this.frame);
    this.frame = 0;
    const key = this.levelKey;
    this.evaluate();
    this.dropDeferred();
    if (!g || this.levelKey !== key || !this.host.ctx() || this.host.ctx()!.path.join('.') !== key) return;
    const c = this.canvasRect(), px = this.unitPx();
    const atLimit = px >= (0.995 * c.width) / MIN_VIEW_UNITS;
    if (px > g.px * 1.0001 || (g.limit && atLimit)) this.maybeHandOff(c, g.limit && atLimit);
  }

  /** A pinch's first finger: whatever it began where it landed (the board's pan, a press-and-hold, a tap; an inside's pan
   *  or tap) is cancelled, as the browser would cancel it, so no handler keeps a finger the pinch now owns. */
  private cancelPress(target: Element, id: number, at: [number, number]): void {
    for (const b of this.boxes.values()) {
      b.cancelTouch?.(id);
      b.view?.cancelHold();
    }
    this.host.view.cancelHold();
    this.forwarding = true;
    try {
      target.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: id, isPrimary: true, clientX: at[0], clientY: at[1], bubbles: true }));
    } finally {
      this.forwarding = false;
    }
  }

  private dropDeferred(): void {
    for (const b of this.boxes.values()) {
      if (!b.dropLater) continue;
      b.dropLater = false;
      if (!b.shown) this.drop(b);
    }
    if (this.over && !this.cur) this.setOver(null);
  }

  /** Build the waiting inside nearest the pointer, one per frame. */
  private queueBuild(): void {
    if (this.buildFrame) return;
    this.buildFrame = soon(() => {
      this.buildFrame = 0;
      const c = this.canvasRect();
      const [fx, fy] = this.focus ?? [c.left + c.width / 2, c.top + c.height / 2];
      let best: Box | null = null, bd = Infinity;
      for (const b of this.boxes.values()) {
        if (!b.want || b.view) continue;
        const r = this.boxPx(b.name, c);
        if (!r || !nearCanvas(r, c)) continue;
        const d = Math.hypot(c.left + r.x + r.w / 2 - fx, c.top + r.y + r.h / 2 - fy);
        if (d < bd) { bd = d; best = b; }
      }
      if (!best) return;
      if (!best.child) {
        // a sub-simulation starts only once the zoom has settled, so its one long task never lands in a moving gesture
        const quiet = performance.now() - this.moved;
        if (best.def.preferBehavior && quiet < SETTLE_MS) {
          clearTimeout(this.settleTimer);
          this.settleTimer = window.setTimeout(() => this.queueBuild(), SETTLE_MS - quiet + 10);
          return;
        }
        // the level in this frame, its drawing in the next: two tasks, each under DESIGN.md's 50 ms
        if (this.prepare(best)) this.queueBuild();
        return;
      }
      this.draw(best);
      const r = this.boxPx(best.name, c);
      if (best.view && r) {
        this.place(best, r);
        this.show(best);
      }
      if ([...this.boxes.values()].some((b) => b.want && !b.view && nearCanvas(this.boxPx(b.name, c), c))) this.queueBuild();
    });
  }

  // ---- an inside ------------------------------------------------------------------------------

  /** Build an inside at once (going up, where it must be there in the same frame). */
  private build(b: Box, instant = false): void {
    if (this.prepare(b)) this.draw(b, instant);
  }

  /** The first half of a build: the inside's level (for a behavioural leaf such as a ROM, a lock-step sub-simulation of its
   *  structure starts here: ~50 ms for the single-cycle CPU's program ROM). False when it has none. */
  private prepare(b: Box): boolean {
    if (b.child) return true;
    const outer = this.host.ctx();
    if (!outer) return false;
    const t0 = performance.now();
    try {
      b.child = outer.child(b.name) ?? undefined;
    } catch {
      // its inside cannot be simulated on its own (the sandbox's flatten throws): it stays closed, as a drill stops there
      this.boxes.delete(b.name);
      this.groupOf(b.name)?.removeAttribute('data-open-at');
      return false;
    }
    b.childMs = performance.now() - t0;
    return !!b.child;
  }

  /** The second half: its drawing. */
  private draw(b: Box, instant = false): void {
    const child = b.child;
    if (!child) return;
    const t0 = performance.now();
    const el = document.createElement('div');
    el.className = 'inside';
    el.dataset.inst = b.name;
    el.setAttribute('role', 'group');
    const n = child.node.children?.size ?? 0;
    el.setAttribute('aria-label', `Inside ${b.name} (${child.def.name}): ${n} parts, live`);
    if (instant || reducedMotion()) el.classList.add('instant');
    const events: SchematicEvents = {
      ...this.host.events?.(child),
      open: (p) => this.host.drill([...child.path, p]),
      select: (p) => {
        b.sel = p;
        this.host.selected();
      },
      toggleInput: () => {},
      editInput: () => {},
      up: () => {},
    };
    this.wire(el, b, child);
    const view = new SchematicView(el, events);
    view.trace = !!this.host.events;
    view.show(child, false);
    b.ctx = child;
    b.view = view;
    b.el = el;
    // the rule's extent (lensplan.ts insideExtent: what the view draws, from the netlist), so the scale it read is the drawing's
    b.extent = insideExtent(b.def) ?? view.contentBox();
    b.sel = null;
    b.stubs = undefined;
    this.layer.append(el);
    view.overlay(this.host.overlay(child));
    // what each half took on the main thread, each a task of its own: the smoke reads the larger (DESIGN.md's 50 ms)
    const ms = performance.now() - t0;
    el.dataset.buildMs = Math.max(ms, b.childMs ?? 0).toFixed(1);
    el.dataset.drawMs = ms.toFixed(1);
    el.dataset.childMs = (b.childMs ?? 0).toFixed(1);
  }

  /** The inside is read-only for arranging: the wheel and drags go to the view; a click selects; a double-click steps in. */
  private wire(el: HTMLElement, b: Box, child: ViewCtx): void {
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.gate.wheel(e.timeStamp, e.deltaY) === 'up') return this.goUp();
      this.host.view.wheelAt(e.deltaY, e.clientX, e.clientY);
      this.zoomed(e.clientX, e.clientY, e.deltaY < 0);
    }, { capture: true, passive: false });
    // two fingers are the canvas's pinch (the constructor's), wherever they land: this pan is one finger's, its own
    let endPan: ((u: PointerEvent | true) => void) | null = null, panId = -1, pinched = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('.inst')) return;
      e.stopPropagation();
      endPan?.(true);
      let x = e.clientX, y = e.clientY;
      const x0 = x, y0 = y, wire = (e.target as Element).closest('[data-net]'), id = e.pointerId;
      const move = (m: PointerEvent) => {
        if (m.pointerId !== id) return;
        this.host.view.panBy(m.clientX - x, m.clientY - y);
        x = m.clientX;
        y = m.clientY;
      };
      const up = (u: PointerEvent | true) => {
        if (u !== true && u.pointerId !== id) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        endPan = null;
        panId = -1;
        // a press on a wire that did not pan is a click on it (Why? traces it, else it is selected); a cancel is not
        if (u === true || u.type === 'pointercancel') return;
        if (wire && (Math.abs(x - x0) + Math.abs(y - y0)) / (this.unitPx() || 1) <= TAP_SLOP) this.wireTap(b, Number(wire.getAttribute('data-net')));
      };
      endPan = up;
      panId = id;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }, { capture: true });
    b.cancelTouch = (id) => {
      if (panId === id) endPan?.(true);
      pinched = true;
    };
    // a double-click off the inner parts (the letterbox, a wire) steps into the box itself
    el.addEventListener('dblclick', (e) => {
      if ((e.target as Element).closest('.inst')) return;
      e.stopPropagation();
      this.stepIn(b, child);
    });
    el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') this.setOver(b.name); });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && this.over === b.name) this.setOver(null); });
    // A finger's tap (DESIGN.md item 6): on an inner part at least TAP_SELECT_PX on screen it selects (the inside's own
    // click, the crumb names the box); anywhere else but a wire it steps into the box: most inner parts are under a
    // fingertip, and a drill that lands beats a tap that misses. A double tap on a large part steps into that part.
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
      if (e.pointerType !== 'touch' || !d || d.id !== e.pointerId || pinched || !b.shown) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP_PX || e.timeStamp - d.t > TAP_MS) return;
      // a tap on a wire is the inside's (it selects it; Why? traces it)
      if ((e.target as Element).closest?.('[data-net]')) return;
      const g = (e.target as Element).closest?.('.inst');
      const r = g?.getBoundingClientRect();
      if (r && Math.min(r.width, r.height) >= TAP_SELECT_PX) return this.setOver(b.name);
      e.stopPropagation();
      e.preventDefault();
      // the click the browser sends after this tap must not select what the next level draws there
      const eat = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 600);
      this.stepIn(b, child);
    }, { capture: true });
  }

  /** Step into a box from its inside: the drill shows its level where the inside was drawn, nothing jumps. */
  private stepIn(b: Box, child: ViewCtx): void {
    const c = this.canvasRect();
    const fit = this.fitPx(b, c);
    const parent = this.parentOf();
    this.host.drill(child.path, fit && b.extent ? handOffView(fit, b.extent, { w: c.width, h: c.height }) : undefined);
    if (parent) this.handed = { path: child.path, parent, px: this.unitPx() };
  }

  private parentOf(): { label: string; path: string[] } | null {
    const outer = this.host.ctx();
    return outer ? { label: outer.path[outer.path.length - 1] ?? outer.def.name, path: outer.path } : null;
  }

  private setOver(name: string | null): void {
    if (this.over === name) return;
    this.over = name;
    const b = this.cur;
    this.host.peek(b?.ctx ?? null);
    if (b) this.host.say(`${b.name}: inside, live; double-click steps in`);
  }

  /** A click on a wire inside. */
  private wireTap(b: Box, idx: number): void {
    if (!b.view || !b.ctx || this.host.events?.(b.ctx).netClick?.(idx)) return;
    b.view.select(null);
    b.view.selectNet(idx);
  }

  /** The drawn inside's rectangle on screen (canvas px). */
  private fitPx(b: Box, c = this.canvasRect()): Rect | null {
    const r = this.host.view.boxOf(b.name);
    return r && b.extent ? this.toPx(fitInside(r, b.extent, b.band), c) : null;
  }

  /** Lay the overlay on the box's outline and the inside letterboxed in it. */
  private place(b: Box, r: Rect): void {
    const el = b.el!, view = b.view!, e = b.extent!, box = this.host.view.boxOf(b.name);
    if (!box) return;
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const f = fitInside(box, e, b.band);
    if (!(f.k > 0) || !(r.w > 0)) return;
    // the inner point e.x sits at the fit's left edge: (f.x − box.x) outer units into the box, f.k outer units per inner unit
    view.setView({ x: e.x - (f.x - box.x) / f.k, y: e.y - (f.y - box.y) / f.k, w: box.w / f.k, h: box.h / f.k }, { w: r.w, h: r.h });
    this.paintRuns(b, (r.w / box.w) * f.k);
  }

  private show(b: Box): void {
    if (!b.el || b.shown) return;
    b.shown = true;
    b.gone = undefined;
    this.host.view.boxClass(b.name, 'inside-on', true);
    // the overlay starts transparent (lens.css) and fades in on the next style change
    void b.el.offsetWidth;
    b.el.classList.add('on');
    this.applyLit(b);
    this.paintStubs(b);
  }

  /** Crossfade back to the symbol, then drop the inside (FADE_MS). */
  private hide(b: Box): void {
    if (!b.el || !b.shown) return;
    b.shown = false;
    b.el.classList.remove('on');
    this.host.view.boxClass(b.name, 'inside-on', false);
    this.host.view.boxClass(b.name, 'lens-lit', false);
    // the crumb changes when the fingers lift (dropDeferred): the stage bar does not rewrap under a gesture
    if (this.over === b.name && !this.fingers.size) this.setOver(null);
    const t = (b.gone = performance.now());
    setTimeout(() => { if (b.gone === t && !b.shown) this.drop(b); }, b.el.classList.contains('instant') ? 0 : FADE_MS + 20);
  }

  private drop(b: Box, force = false): void {
    this.host.view.boxClass(b.name, 'inside-on', false);
    this.host.view.boxClass(b.name, 'lens-lit', false);
    // a finger may be on it: its element taken out of the page would end that finger's pinch (its events lost, the browser's
    // own gesture or nothing left to follow it). Faded and kept until the fingers lift (released)
    if (!force && this.fingers.size && b.el) {
      if (b.shown) {
        b.shown = false;
        b.el.classList.remove('on');
      }
      b.dropLater = true;
      return;
    }
    if (this.over === b.name) this.setOver(null);
    b.view?.clear();
    b.el?.remove();
    b.view = b.el = b.ctx = b.child = b.extent = b.stubs = b.runs = undefined;
    b.shown = false;
    b.gone = undefined;
    b.sel = null;
  }

  private dropAll(): void {
    for (const b of this.boxes.values()) this.drop(b, true);
    this.boxes.clear();
    this.setOver(null);
  }

  // ---- stubs: the box's ports to the inner pins, inside the outline ---------------------------

  /** A run's first and last parts named ("ff0", "ff31") while its cells are too small for their own names (lensplan.ts
   *  runsOf): fixed-size text in the inside's own units, so it stays readable as the zoom changes. `innerPx`: screen px per
   *  inner unit. */
  private paintRuns(b: Box, innerPx: number): void {
    const view = b.view;
    if (!view || !(innerPx > 0)) return;
    let g = b.runs;
    if (!g || !g.isConnected) {
      g = document.createElementNS(SVG, 'g') as SVGGElement;
      g.setAttribute('class', 'inside-runs');
      // under the view's names layer, which stays last (its names win every overlap)
      view.el.insertBefore(g, view.el.querySelector(':scope > .lg-names'));
      b.runs = g;
    }
    const size = RUN_NAME_PX / innerPx;
    const want = runsOf(b.def).filter((run) => run.cellLong * innerPx < FLOOR_PX).flatMap((run) => [[run.first, run.firstRect], [run.last, run.lastRect]] as const);
    while (g.children.length > want.length) g.lastChild!.remove();
    want.forEach(([name, rc], i) => {
      let t = g.children[i] as SVGTextElement | undefined;
      if (!t) { t = document.createElementNS(SVG, 'text') as SVGTextElement; g.append(t); }
      if (t.textContent !== name) t.textContent = name;
      t.setAttribute('x', String(rc.x + rc.w / 2));
      t.setAttribute('y', String(rc.y + rc.h / 2));
      t.setAttribute('font-size', size.toFixed(4));
    });
  }

  /** A stub per port with an inner pin of the same name: from the port on the box edge to the pin, in the inside's own
   *  units (so it scales with it), coloured as the pin's wire. */
  private paintStubs(b: Box): void {
    const view = b.view, e = b.extent, box = this.host.view.boxOf(b.name);
    if (!view || !e || !box || !b.shown) return;
    const f = fitInside(box, e, b.band);
    if (!(f.k > 0)) return;
    const vx = e.x - (f.x - box.x) / f.k, vy = e.y - (f.y - box.y) / f.k;
    const toInner = (p: readonly number[]): [number, number] => [vx + (p[0] - box.x) / f.k, vy + (p[1] - box.y) / f.k];
    let g = b.stubs;
    if (!g || !g.isConnected) {
      g = document.createElementNS(SVG, 'g') as SVGGElement;
      g.setAttribute('class', 'inside-stubs');
      view.el.prepend(g);
      b.stubs = g;
    }
    const pins = new Map(view.levelPins().map((p) => [p.pin.name, p]));
    let n = 0;
    for (const port of this.host.view.portsOf(b.name)) {
      const pin = pins.get(port.name);
      if (!pin) continue;
      const [ax, ay] = toInner(port.pos);
      const [bx, by] = pin.pin.pos;
      // horizontal from a side port (a vertical in the middle), vertical from a top or bottom one
      const vertical = port.exit === 'up' || port.exit === 'down' || port.exit === 'top' || port.exit === 'bottom';
      const d = vertical ? `M${ax},${ay}V${(ay + by) / 2}H${bx}V${by}` : `M${ax},${ay}H${(ax + bx) / 2}V${by}H${bx}`;
      let path = g.children[n] as SVGPathElement | undefined;
      if (!path) {
        path = document.createElementNS(SVG, 'path') as SVGPathElement;
        g.append(path);
      }
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
      const cls = `${pin.path?.getAttribute('class') ?? 'wire'} inside-stub`;
      if (path.getAttribute('class') !== cls) path.setAttribute('class', cls);
      n++;
    }
    while (g.children.length > n) g.lastChild!.remove();
  }

  // ---- the hint -----------------------------------------------------------------------------

  /** Hovering a closed block that can open: "zoom in to see inside (×2.4)", or past ×4 "double-click to step in". */
  private hover(name: string | null): void {
    const b = name ? this.boxes.get(name) : null;
    if (!b || b.shown || !this.host.allowed()) return this.hideHint();
    const r = this.boxPx(b.name);
    if (!r) return this.hideHint();
    const need = b.openAt / (this.unitPx() || 1);
    const x = `×${Math.max(1.1, need).toFixed(1)}`;
    const text = need > HINT_MAX_ZOOM ? `zoom in ${x} to see inside, or double-click to step in` : `zoom in to see inside (${x})`;
    let el = this.hint?.el;
    if (!el) {
      el = document.createElement('div');
      el.className = 'inside-hint';
      this.layer.append(el);
    }
    if (el.textContent !== text) el.textContent = text;
    // below the box (its name sits on or above it), else above it, else just inside its top edge: never under the bar
    const ch = this.canvasRect().height, room = HINT_ROOM_PX;
    const below = r.y + r.h + room <= ch, above = r.y >= room;
    el.style.left = `${Math.min(Math.max(r.x + r.w / 2, 0), this.canvasRect().width)}px`;
    el.style.top = `${below ? r.y + r.h : above ? r.y : Math.max(r.y, 0) + 4}px`;
    el.style.transform = below ? 'translate(-50%, 4px)' : above ? 'translate(-50%, calc(-100% - 4px))' : 'translate(-50%, 0)';
    this.hint = { el, name: b.name };
  }

  private hideHint(): void {
    this.hint?.el.remove();
    this.hint = null;
  }

  // ---- the hand-off and going up --------------------------------------------------------------

  /** A drawn inside covers the canvas in width or height (the one under the pointer first): the view becomes its level. */
  private maybeHandOff(c: DOMRect, atLimit = false): void {
    const canvas = { w: c.width, h: c.height };
    const [fx, fy] = this.focus ?? [c.left + c.width / 2, c.top + c.height / 2];
    let pick: { b: Box; fit: Rect } | null = null;
    for (const b of this.boxes.values()) {
      if (!b.shown || !b.extent || !b.ctx) continue;
      const fit = this.fitPx(b, c);
      if (!fit || !(handsOff(fit, canvas) || atLimit)) continue;
      const under = fx >= c.left + fit.x && fx <= c.left + fit.x + fit.w && fy >= c.top + fit.y && fy <= c.top + fit.y + fit.h;
      // only the box under the pointer: zooming on a small part must never step into a big neighbour
      if (under) { pick = { b, fit }; break; }
    }
    if (!pick) return;
    const { b, fit } = pick;
    const path = b.ctx!.path, parent = this.parentOf();
    const vb = handOffView(fit, b.extent!, canvas);
    this.host.drill(path, vb);
    if (parent) this.handed = { path, parent, px: this.unitPx() };
  }

  /**
   * After a hand-off or a step in, the rule up is on screen the whole time (Smith's zoomout.ts words): "Zoom out to see all
   * of alu, then once more to go up to cpu" while the level does not fit, "Zoom out once more to go up to cpu" once it does,
   * and from then a fresh zoom-out goes up (goUp).
   */
  private handedCue(): void {
    const hd = this.handed, ctx = this.host.ctx();
    if (!hd || !ctx || ctx.path.join('.') !== hd.path.join('.')) return;
    const b = this.host.view.contentBox();
    const p = this.host.view.toClient([b.x, b.y]), q = this.host.view.toClient([b.x + b.w, b.y + b.h]);
    const c = this.canvasRect();
    const fits = !!p && !!q && p[0] >= c.left - 1 && p[1] >= c.top - 1 && q[0] <= c.right + 1 && q[1] <= c.bottom + 1;
    if (fits && !this.gate.cued) this.gate.cue(performance.now());
    else if (!fits && this.gate.cued) this.gate.clear();
    // the bar: from the scale the level was entered at (hd.px) to the scale it would fit at (the canvas over its drawing now)
    const px = this.unitPx();
    // zoomed in further than it was entered: the bar starts from the deepest zoom since
    if (!fits && px > hd.px) hd.px = px;
    const fitPx = p && q && q[0] > p[0] && q[1] > p[1] ? px * Math.min(c.width / (q[0] - p[0]), c.height / (q[1] - p[1])) : px;
    const prog = fits ? 1 : Math.round(progress(px, fitPx, hd.px) * 50) / 50;
    if (this.cueFits === fits && this.cueProg === prog) return;
    this.cueFits = fits;
    this.cueProg = prog;
    const level = hd.path[hd.path.length - 1] ?? '';
    this.host.cue({ ...hd.parent, words: cueWords(level, hd.parent.label, fits), progress: fits ? undefined : prog });
  }
  private cueFits: boolean | null = null;
  private cueProg = -1;
  private started = false;

  /** The `−` key or the zoom-out button, before it zooms: true when it went up a level instead (so the press does not
   *  also zoom the parent). */
  zoomOutKey(): boolean {
    if (this.gate.key(performance.now()) !== 'up') return false;
    this.goUp();
    return true;
  }

  /** A fresh zoom-out after the cue: one level up, the level left drawn open in its box exactly where its drawing was (the
   *  hand-off in reverse), then shrinking with the zoom until the rule closes it. */
  private goUp(): void {
    const hd = this.handed;
    if (!hd) return;
    const name = hd.path[hd.path.length - 1];
    // where the level's drawing is now, before it goes
    const c = this.canvasRect();
    const e = this.host.view.contentBox();
    const p = this.host.view.toClient([e.x, e.y]), q = this.host.view.toClient([e.x + e.w, e.y + e.h]);
    this.handed = null;
    this.cueFits = null;
    this.gate.clear();
    this.host.cue(null);
    this.host.drill(hd.parent.path);
    if (name === undefined || !p || !q || !(e.w > 0)) return;
    this.land(name, e, { x: p[0] - c.left, y: p[1] - c.top, w: q[0] - p[0], h: q[1] - p[1] }, c);
  }

  /** The band a box of the level on screen keeps for its port names (lensplan.ts bandOf). */
  private bandFor(name: string): Band {
    const ctx = this.host.ctx(), inst = ctx ? netlistOf(ctx.def)?.instances.find((i) => i.name === name) : undefined;
    return this.boxes.get(name)?.band ?? (inst ? bandOf(inst.def, inst.flip, inst.rot) : NO_BAND);
  }

  /** Show the level on screen so `name`'s inside (drawn extent `e`) sits on `at` (canvas px), drawn at once. */
  private land(name: string, e: Rect, at: Rect, c: DOMRect): void {
    const box = this.host.view.boxOf(name);
    if (!box) return;
    const f = fitInside(box, e, this.bandFor(name));
    // px per outer unit: an inner unit is f.k outer units, drawn at.w / e.w px
    const P = at.w / e.w / f.k;
    if (!(P > 0)) return;
    this.host.view.setView({ x: f.x - at.x / P, y: f.y - at.y / P, w: c.width / P, h: c.height / P });
    this.lastPx = this.unitPx();
    if (this.host.ctx()?.path.join('.') !== this.levelKey) this.levelChanged(this.host.ctx()?.path ?? []);
    if (!this.boxes.size) this.measure();
    // drawn at once, without a fade: it is the drawing the learner was just looking at
    const b = this.boxes.get(name);
    if (b && !b.view && decide(false, this.lastPx, b.openAt) && this.host.allowed()) {
      b.want = true;
      this.build(b, true);
      const r = this.boxPx(name, c);
      if (b.view && r) {
        this.place(b, r);
        this.show(b);
      }
    }
    this.schedule();
  }
}
