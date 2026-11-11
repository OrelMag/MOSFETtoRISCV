// The zoom lens (docs/transparent/DESIGN.md, phase 1): with View options ▸ Open blocks as you zoom on, a zoom gesture
// that settles on a block opens its inside over it, live, in a rounded window anchored on the box; the level around it
// stays drawn and dims (the view's own focus layer). Zooming on grows it; once it would not fit the free stage the view
// becomes that level (a drill, no jump). Esc, zooming out under the close size, or panning the box away closes it.
// The stage imports this module only while the setting is on, so off costs nothing.
import '../styles/lens.css';
import { reducedMotion } from '../ui/motion';
import type { ViewCtx } from './context';
import { closesAt, freeStage, growPlan, LENS_CLOSE_PX, openPlan, opensAt, rimJogs, type LensPlan, type Rect, type RimPort, type Size } from './lensplan';
import type { OverlayResult } from './overlays';
import { SchematicView, type SchematicEvents } from './schematic';

const SVG = 'http://www.w3.org/2000/svg';
/** A zoom has settled when no wheel event came for this long (ms). */
export const SETTLE_MS = 160;
/** The grow and fade as it opens (ms); none with reduced motion. */
const OPEN_MS = 180;
/** A pin further than this (px) inside the rim gets its connector ended on the rim (the author's choice, 2026-11-11). */
export const DEEP_PX = 30;

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
  /** The cue after a hand-off ("Esc or cpu goes back up"); null removes it. */
  cue(parent: { label: string; path: string[] } | null): void;
  say(text: string): void;
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
  /** Ports whose inner pin is deep inside the drawing this paint (their connector ends on the rim). */
  private deep = new Set<string>();

  constructor(private host: LensHost) {
    const v = host.view;
    const wheel = (e: WheelEvent) => this.zoomed(e.clientX, e.clientY);
    v.el.addEventListener('wheel', wheel, { passive: true });
    this.off.push(() => v.el.removeEventListener('wheel', wheel));
    v.onCamera(() => this.cameraMoved());
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

  get isOpen(): boolean {
    return !!this.open;
  }

  /** The inner part selected, with the lens's level. */
  selection(): { ctx: ViewCtx; name: string } | null {
    return this.open && this.sel ? { ctx: this.open.ctx, name: this.sel } : null;
  }

  /** The level the lens shows (the breadcrumb's peek crumb). */
  get peekCtx(): ViewCtx | null {
    return this.open?.ctx ?? null;
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

  /** The stage's covers moved (a panel docked or folded, the Why? card): placed again. */
  coversChanged(): void {
    if (this.open) this.cameraMoved();
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
    if (this.host.tooLarge(ctx, name)) return this.showHint(box, 'too large to open here: double-click to step in');
    const def = ctx.node.children?.get(name)?.def;
    const key = `${def?.id}|${Math.round(this.canvasSize().w)}x${Math.round(this.canvasSize().h)}`;
    if (this.refused.has(key)) return this.showHint(box, this.refused.get(key)!);
    this.build(ctx, name, box, key);
  }

  private build(outer: ViewCtx, name: string, box: Rect, key: string): void {
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
    // drawn while hidden so its extent is known before it is placed
    el.style.visibility = 'hidden';
    this.host.canvas.append(el);
    const events: SchematicEvents = {
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
      this.host.view.wheelAt(e.deltaY, e.clientX, e.clientY);
      this.zoomed(e.clientX, e.clientY);
    }, { capture: true, passive: false });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('.inst')) return;
      e.stopPropagation();
      let x = e.clientX, y = e.clientY;
      const move = (m: PointerEvent) => { this.host.view.panBy(m.clientX - x, m.clientY - y); x = m.clientX; y = m.clientY; };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }, { capture: true });
    const view = new SchematicView(body, events);
    view.show(child, false);
    const extent = view.contentBox();
    // the blocks whose names the lens must show (gate glyphs carry none): legible.ts planNames names a block once its
    // longer side is MIN_BLOCK_PX on screen
    const named = new Set([...body.querySelectorAll<SVGGElement>('g.lg-named')].map((g) => g.dataset.inst));
    const parts = view.partBoxes().filter(([n]) => named.has(n));
    const smallest = parts.length ? Math.min(...parts.map(([, b]) => Math.max(b.w, b.h))) : 4;
    const free = freeStage(this.canvasSize(), this.host.covers(), extent);
    const plan = openPlan(box, extent, smallest, free);
    if (!plan) {
      view.clear();
      el.remove();
      const why = 'double-click to step in';
      this.refused.set(key, why);
      return this.showHint(box, why);
    }
    const n = child.node.children?.size ?? 0;
    const label = `${name} · ${def.name} · ${n} part${n === 1 ? '' : 's'} · live`;
    el.setAttribute('aria-label', `Inside ${name} (${def.name}): ${n} parts, live`);
    const rim = document.createElementNS(SVG, 'svg') as SVGSVGElement;
    rim.setAttribute('class', 'lens-rim');
    rim.setAttribute('aria-hidden', 'true');
    this.host.canvas.append(rim);
    this.open = { name, ctx: child, view, el, body, tag, rim, extent, opened: { plan, boxH: box.h }, plan, label };
    this.place(plan);
    el.style.visibility = '';
    this.host.view.setLensBox(name);
    this.host.peek(child);
    this.paintOverlay();
    this.paintRim();
    // the box's outline grows into the lens while the inside fades in
    if (!reducedMotion()) {
      const r = plan.rect;
      el.animate([
        { transform: `translate(${box.x - r.x}px, ${box.y - r.y}px) scale(${box.w / r.w}, ${box.h / r.h})`, opacity: 0.55 },
        { transform: 'none', opacity: 1 },
      ], { duration: OPEN_MS, easing: 'ease-out' });
      rim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-in' });
    }
    this.host.say(`${name} opened in place; Enter steps in`);
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
    const free = freeStage(this.canvasSize(), this.host.covers(), o.extent);
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

  /** After a hand-off, once the zoom-out shows the whole level again: "Esc or cpu goes back up". */
  private handedCue(): void {
    const hd = this.handed, ctx = this.host.ctx();
    if (!hd || !ctx || ctx.path.join('.') !== hd.path.join('.')) return;
    // only once the learner zooms out from where the hand-off left the level
    if (this.unitPx() > hd.px * 0.9) return;
    const b = this.host.view.contentBox();
    const p = this.host.view.toClient([b.x, b.y]), q = this.host.view.toClient([b.x + b.w, b.y + b.h]);
    const c = this.host.canvas.getBoundingClientRect();
    if (p && q && p[0] >= c.left - 1 && p[1] >= c.top - 1 && q[0] <= c.right + 1 && q[1] <= c.bottom + 1) this.host.cue(hd.parent);
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
    this.host.canvas.append(el);
    this.hint = el;
    this.host.say(text);
  }

  private hideHint(): void {
    this.hint?.remove();
    this.hint = null;
  }
}
