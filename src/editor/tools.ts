// How the mouse and keyboard edit the canvas: a small state machine in the manner of Digital
// Logic Sim. Press on a port starts a free-hand wire (clicks add corners, a click on a port,
// pointer or wire ends it); press on an object selects and drags it; press on empty canvas
// draws a rubber band; Space or the middle button pans (camera.ts). Palette items are dragged
// onto the canvas, or clicked and then placed with a click.
//
// Geometry and the wire being drawn are DOM-free (geom.ts); this file only routes events.

import { type ExitDir, type Vec } from '../sim/geometry';
import { installPanZoom } from '../view/camera';
import { closePopover, editNumber } from '../view/popover';
import { drawPinGlyph } from '../view/symbols';
import { s } from '../ui/dom';
import type { Editor } from './editor';
import { branchPoint, drives, type Hit, hitTest, hitWire, nextSameName, partAnchor, pointerGeom, snapPt, WireDraft } from './geom';
import { type ChipDoc, endGeom, endKey, type EndRef, type ExitDir as Face, type PinDoc } from './model';
import {
  addLabel, addPart, addPin, addWire, boxSelect, type Clip, copySel, deleteSel, duplicate, flipParts, moveSel, pasteClip,
  type Sel, selectAll, setLabel, setPin,
} from './ops';
import type { PaletteItem } from './palette';

type State =
  | { k: 'idle' }
  /** Pressed on an object; a click or a drag, not decided yet. */
  | { k: 'press'; hit: Hit; at: Vec; sx: number; sy: number; was: boolean; shift: boolean }
  | { k: 'move'; at: Vec; base: ChipDoc; sel: Sel; d: Vec }
  | { k: 'band'; at: Vec; add: boolean }
  /** `held`: the button is still down since the press that started it (drag-to-connect). */
  | { k: 'wire'; draft: WireDraft; held: boolean; sx: number; sy: number }
  /** Placing a palette item; `drag` while it is being dragged out of the palette. */
  | { k: 'place'; item: PaletteItem; drag: boolean; sx: number; sy: number; key: string };

/** Clipboard shared by every chip of the session (copy in one tab, paste in another). */
let clipboard: Clip | null = null;

const DRAG_PX = 4;
const MIRROR: Record<Face, Face> = { left: 'right', right: 'left', up: 'up', down: 'down' };

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export class Tools {
  state: State = { k: 'idle' };
  /** Last cursor position over the canvas (world units), for paste and placing. */
  cursor: Vec | null = null;
  private space = false;
  private panning = false;
  private buttonHeld: PinDoc | null = null;
  private off: (() => void)[] = [];
  /** A mode that takes clicks first (probing): true when it consumed the press. */
  onPress: ((h: Hit, e: PointerEvent) => boolean) | null = null;

  constructor(private ed: Editor) {
    const svg = ed.view.svg;
    installPanZoom(svg, ed.view.cam, {
      canStart: (e) => this.panStart(e),
      onTap: () => {},
    });
    const on = <K extends keyof DocumentEventMap>(t: Document | SVGSVGElement, k: K, f: (e: DocumentEventMap[K]) => void) => {
      t.addEventListener(k, f as EventListener);
      this.off.push(() => t.removeEventListener(k, f as EventListener));
    };
    on(svg, 'pointerdown', (e) => this.down(e));
    on(svg, 'pointermove', (e) => this.move(e));
    on(svg, 'pointerup', (e) => this.up(e));
    on(svg, 'pointercancel', () => this.cancel());
    on(svg, 'dblclick', (e) => this.dbl(e));
    on(svg, 'contextmenu', (e) => { e.preventDefault(); if (this.state.k === 'wire' || this.state.k === 'place') this.cancel(); });
    on(svg, 'pointerleave', () => {
      if (this.state.k === 'place' && !this.state.drag) this.ed.view.showGhost(null);
      this.ed.view.showHot(null);
      this.ed.hoverWire(null);
    });
    on(document, 'keydown', (e) => this.key(e));
    on(document, 'keyup', (e) => { if (e.key === ' ') this.space = false; });
  }

  destroy(): void {
    this.off.forEach((f) => f());
    this.off = [];
  }

  private panStart(e: PointerEvent): boolean {
    this.panning = e.button === 1 || (e.button === 0 && this.space && this.state.k !== 'wire');
    return this.panning;
  }

  private world(e: { clientX: number; clientY: number }): Vec {
    return this.ed.view.cam.toWorld(e.clientX, e.clientY);
  }

  private tol(): number {
    return Math.min(1.2, Math.max(0.35, this.ed.view.px(8)));
  }

  private hit(p: Vec): Hit {
    return hitTest(this.ed.doc, this.ed.defOf, p, this.tol(), this.ed.view.polys);
  }

  private isSelected(h: Hit): boolean {
    const s = this.ed.sel;
    if (h.k === 'part') return !!s.parts?.includes(h.id);
    if (h.k === 'pin') return !!s.pins?.includes(h.id);
    if (h.k === 'label') return !!s.labels?.includes(h.id);
    if (h.k === 'wire') return !!s.wires?.includes(h.id);
    return false;
  }

  /** Abandon whatever is in progress. */
  cancel(): void {
    const st = this.state;
    if (st.k === 'move') this.ed.cancel();
    this.state = { k: 'idle' };
    this.ed.view.showPreview(null);
    this.ed.view.showBand(null);
    this.ed.view.showGhost(null);
    this.ed.view.showHot(null);
    this.ed.palette.setArmed(null);
    this.ed.view.svg.style.cursor = '';
    if (this.buttonHeld) this.release();
  }

  // ---- pointer -----------------------------------------------------------------------------

  private down(e: PointerEvent): void {
    this.ed.hoverWire(null);
    // No text selection or focus change from presses on the canvas (a press that opens the
    // pointer-name prompt must not blur it right away); a field being edited commits first.
    e.preventDefault();
    const act = document.activeElement as HTMLElement | null;
    if (act && act !== document.body && !this.ed.view.svg.contains(act)) act.blur();
    if (this.panning || e.button !== 0) return;
    const ed = this.ed;
    const p = this.world(e);
    this.cursor = p;
    ed.view.svg.setPointerCapture(e.pointerId);
    closePopover();
    const st = this.state;

    if (st.k === 'place') return this.place(st.item, p, e.shiftKey);
    if (st.k === 'wire') {
      this.wireClick(st.draft, p);
      if (this.state.k === 'wire') this.state.held = false;
      return;
    }

    const h = this.hit(p);
    if (this.onPress?.(h, e)) return;
    if (h.k === 'port') return this.startWire(h.end, h.pos, e);
    if (h.k === 'wire' && (e.ctrlKey || e.altKey || e.metaKey)) {
      const poly = ed.view.polys.get(h.id);
      if (poly) return this.startWire({ wire: h.id, at: branchPoint(poly, p) }, branchPoint(poly, p), e);
    }
    if (h.k === 'none') {
      if (!e.shiftKey) ed.select({});
      this.state = { k: 'band', at: p, add: e.shiftKey };
      return;
    }
    const was = this.isSelected(h);
    if (!was && !e.shiftKey) ed.select(selOf(h));
    else if (!was && e.shiftKey) ed.select(toggle(ed.sel, h));
    if (h.k === 'pin') {
      const pin = ed.doc.pins.find((q) => q.id === h.id);
      if (pin?.dir === 'in' && pin.kind === 'button' && !e.shiftKey) {
        this.buttonHeld = pin;
        ed.sim.setInput(pin, 1);
      }
    }
    this.state = { k: 'press', hit: h, at: p, sx: e.clientX, sy: e.clientY, was, shift: e.shiftKey };
  }

  private move(e: PointerEvent): void {
    if (this.panning) return;
    const ed = this.ed;
    const p = this.world(e);
    this.cursor = p;
    const st = this.state;
    switch (st.k) {
      case 'press': {
        if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < DRAG_PX) return;
        if (!this.isSelected(st.hit)) ed.select(selOf(st.hit));
        ed.begin();
        this.state = { k: 'move', at: st.at, base: ed.doc, sel: ed.sel, d: [0, 0] };
        return this.move(e);
      }
      case 'move': {
        const d: Vec = [Math.round(p[0] - st.at[0]), Math.round(p[1] - st.at[1])];
        if (d[0] === st.d[0] && d[1] === st.d[1]) return;
        st.d = d;
        ed.edit(() => moveSel(st.base, st.sel, d, ed.defOf));
        return;
      }
      case 'band':
        ed.view.showBand(st.at, p);
        return;
      case 'wire':
        return this.previewWire(st.draft, p);
      case 'place':
        return this.ghost(st.item, p);
      default: {
        const h = this.hit(p);
        ed.view.showHot(h.k === 'port' ? h.pos : null);
        ed.hoverWire(h.k === 'wire' ? h.id : null, e);
        const pin = h.k === 'pin' ? ed.doc.pins.find((q) => q.id === h.id) : undefined;
        ed.view.svg.style.cursor = h.k === 'port' ? 'crosshair' : pin?.dir === 'in' ? 'pointer' : h.k === 'none' ? '' : this.isSelected(h) ? 'move' : 'pointer';
      }
    }
  }

  private up(e: PointerEvent): void {
    const ed = this.ed;
    if (ed.view.svg.hasPointerCapture(e.pointerId)) ed.view.svg.releasePointerCapture(e.pointerId);
    if (this.panning) { this.panning = false; return; }
    if (this.buttonHeld) this.release();
    const st = this.state;
    const p = this.world(e);
    switch (st.k) {
      case 'press':
        this.state = { k: 'idle' };
        return this.click(st, e);
      case 'move':
        this.state = { k: 'idle' };
        ed.commit();
        return;
      case 'band': {
        this.state = { k: 'idle' };
        ed.view.showBand(null);
        if (Math.abs(p[0] - st.at[0]) + Math.abs(p[1] - st.at[1]) < 0.3) return;
        const got = boxSelect(ed.doc, [st.at, p], ed.defOf);
        ed.select(st.add ? union(ed.sel, got) : got);
        return;
      }
      case 'wire':
        // Released somewhere else after dragging out of a port: connect if it is a target.
        if (st.held && Math.hypot(e.clientX - st.sx, e.clientY - st.sy) >= DRAG_PX) {
          const t = this.target(p);
          if (t.end) this.finish(st.draft, t.end, t.pos, t.exit);
        }
        if (this.state.k === 'wire') this.state.held = false;
        return;
    }
  }

  private release(): void {
    const pin = this.buttonHeld;
    this.buttonHeld = null;
    if (pin) this.ed.sim.setInput(pin, 0);
  }

  /** A press released without dragging. */
  private click(st: Extract<State, { k: 'press' }>, e: PointerEvent): void {
    const ed = this.ed;
    const h = st.hit;
    if (st.shift) {
      if (st.was) ed.select(toggle(ed.sel, h));
      return;
    }
    if (ed.selCount > 1) ed.select(selOf(h));
    if (h.k === 'pin') {
      const pin = ed.doc.pins.find((q) => q.id === h.id);
      if (!pin || pin.dir !== 'in') return;
      if (pin.kind === 'clock') return ed.sim.toggleClocks();
      if (pin.kind === 'button') return;
      if (pin.width === 1) return ed.setPinValue(pin.id, (pin.value ?? 0) ? 0 : 1);
      const g = ed.view.svg.querySelector(`[data-pin-id="${pin.id}"]`);
      const r = g ? g.getBoundingClientRect() : new DOMRect(e.clientX, e.clientY, 0, 0);
      editNumber(r, pin.name, pin.width, pin.value ?? 0, (v) => ed.setPinValue(pin.id, v));
      return;
    }
    if (h.k === 'label' && st.was) this.jump(h.id);
  }

  private dbl(e: MouseEvent): void {
    const ed = this.ed;
    const h = this.hit(this.world(e));
    if (h.k === 'label') return; // the second click of a double-click already jumped
    if (h.k === 'part') {
      const part = ed.doc.parts.find((q) => q.id === h.id);
      if (part && 'chip' in part.ref) ed.openChip(part.ref.chip);
    }
  }

  /** Select the next pointer with the same name and bring it into view. */
  jump(labelId: string): void {
    const ed = this.ed;
    const next = nextSameName(ed.doc, labelId);
    if (!next) return void ed.toast('No other pointer has this name');
    ed.select({ labels: [next.id] });
    ed.view.centerOn(pointerGeom(next).tip);
    ed.view.ping('label', next.id);
  }

  // ---- wires -------------------------------------------------------------------------------

  private startWire(from: EndRef, pos: Vec, e: PointerEvent): void {
    const ed = this.ed;
    const g = 'wire' in from ? null : endGeom(ed.doc, from, ed.defOf);
    const draft = new WireDraft(from, pos, g?.exit ?? null);
    this.state = { k: 'wire', draft, held: true, sx: e.clientX, sy: e.clientY };
    ed.view.svg.style.cursor = 'crosshair';
    this.previewWire(draft, this.world(e));
  }

  /** What a click at p would connect to: a port (snapped onto it), a wire (a branch) or nothing. */
  private target(p: Vec): { end: EndRef | null; pos: Vec; exit: ExitDir | null } {
    const ed = this.ed;
    const h = hitTest(ed.doc, ed.defOf, p, this.tol(), ed.view.polys);
    if (h.k === 'port') return { end: h.end, pos: h.pos, exit: endGeom(ed.doc, h.end, ed.defOf)?.exit ?? null };
    // A pointer's flag or a pin's knob stands for its attach point.
    if (h.k === 'label' || h.k === 'pin') {
      const e: EndRef = h.k === 'label' ? { label: h.id } : { pin: h.id };
      const g = endGeom(ed.doc, e, ed.defOf);
      if (g) return { end: e, pos: g.pos, exit: g.exit };
    }
    const w = h.k === 'wire' ? h : hitWire(ed.doc, ed.defOf, p, this.tol(), ed.view.polys);
    if (w) {
      const poly = ed.view.polys.get(w.id)!;
      const at = branchPoint(poly, p);
      return { end: { wire: w.id, at }, pos: at, exit: null };
    }
    return { end: null, pos: snapPt(p), exit: null };
  }

  private refusal(draft: WireDraft, end: EndRef): string | null {
    const ed = this.ed;
    if (endKey(end) === endKey(draft.from)) return 'A wire needs two different ends';
    if ('wire' in end && 'wire' in draft.from && end.wire === draft.from.wire) return 'A wire cannot branch back onto itself';
    if (drives(ed.doc, draft.from, ed.defOf) && drives(ed.doc, end, ed.defOf)) return 'Both ends are outputs: two drivers on one wire would fight';
    return null;
  }

  private previewWire(draft: WireDraft, p: Vec): void {
    const t = this.target(p);
    const bad = !!t.end && !!this.refusal(draft, t.end);
    this.ed.view.showPreview(draft.preview(t.pos, t.exit), bad);
    this.ed.view.showHot(t.end ? t.pos : null, bad);
  }

  private wireClick(draft: WireDraft, p: Vec): void {
    const t = this.target(p);
    if (t.end) return this.finish(draft, t.end, t.pos, t.exit);
    draft.addCorner(t.pos);
    this.previewWire(draft, p);
  }

  private finish(draft: WireDraft, end: EndRef, pos: Vec, exit: ExitDir | null): void {
    const ed = this.ed;
    const why = this.refusal(draft, end);
    if (why) {
      ed.toast(why, 'err');
      return;
    }
    const r = addWire(ed.doc, draft.from, end, draft.corners(pos, exit), ed.defOf);
    if (r.reason) {
      ed.toast(`Cannot wire: ${r.reason}`, 'err');
      return;
    }
    this.cancel();
    ed.edit(() => r.doc);
  }

  // ---- placing -----------------------------------------------------------------------------

  /** Pointer down on a palette item: drag it out, or (released in place) arm it for a click. */
  pickFromPalette(item: PaletteItem, e: PointerEvent): void {
    const ed = this.ed;
    this.cancel();
    const key = (e.currentTarget as HTMLElement | null)?.dataset.item ?? item.id;
    this.state = { k: 'place', item, drag: true, sx: e.clientX, sy: e.clientY, key };
    ed.palette.setArmed(key);
    const svg = ed.view.svg;
    const over = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    };
    const mv = (ev: PointerEvent) => {
      if (this.state.k !== 'place') return;
      if (over(ev)) this.ghost(item, this.world(ev));
      else ed.view.showGhost(null);
    };
    const upH = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', upH);
      const st = this.state;
      if (st.k !== 'place') return;
      if (over(ev)) {
        this.place(item, this.world(ev), ev.shiftKey);
      } else if (Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) < DRAG_PX) {
        st.drag = false; // a click: armed until a click on the canvas (Esc cancels)
      } else this.cancel();
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', upH);
  }

  /** Arm the pointer tool (key L). */
  armPointer(): void {
    this.cancel();
    this.state = { k: 'place', item: { id: 'pointer', name: 'Pointer', place: { pointer: true } }, drag: false, sx: 0, sy: 0, key: 'wiring/pointer' };
    this.ed.palette.setArmed('wiring/pointer');
    if (this.cursor) this.ghost(this.state.item, this.cursor);
  }

  private ghost(item: PaletteItem, p: Vec): void {
    const v = this.ed.view;
    const pl = item.place;
    const key = JSON.stringify(pl);
    if ('part' in pl) {
      const def = this.ed.defOfRef(pl.part);
      if (!def) return v.showGhost(null);
      return v.showGhost(key, () => v.ghostOf(def, pl.part), partAnchor(def, p));
    }
    v.showGhost(key, () => {
      if ('pin' in pl) {
        return drawPinGlyph({ name: pl.pin.dir === 'in' ? 'in' : 'out', dir: pl.pin.dir, width: pl.pin.width, pos: [0, 0], exit: pl.pin.dir === 'in' ? 'right' : 'left' }, false).g;
      }
      const pg = pointerGeom({ at: [0, 0], name: 'name' });
      return s('g', { class: 'ed-ptr' },
        s('path', { class: 'wire', d: `M0,0 L${pg.tip[0]},${pg.tip[1]}` }),
        s('path', { class: 'ed-flag', d: `M${pg.outline.map(([x, y]) => `${x},${y}`).join(' L')} Z` }));
    }, snapPt(p));
  }

  private place(item: PaletteItem, p: Vec, keep: boolean): void {
    const ed = this.ed;
    const pl = item.place;
    const again = () => {
      if (keep) {
        this.state = { k: 'place', item, drag: false, sx: 0, sy: 0, key: ed.palette.armed ?? item.id };
        ed.palette.setArmed(ed.palette.armed);
      }
    };
    this.cancel();
    if ('part' in pl) {
      const def = ed.defOfRef(pl.part);
      if (!def) return void ed.toast(`Cannot place ${item.name}`, 'err');
      const r = addPart(ed.doc, pl.part, partAnchor(def, p));
      if (r.id === undefined) return void ed.toast(r.reason, 'err');
      const id = r.id;
      ed.edit(() => r.doc);
      ed.select({ parts: [id] });
      return again();
    }
    if ('pin' in pl) {
      const r = addPin(ed.doc, pl.pin.dir, pl.pin.width, snapPt(p));
      if (r.id === undefined) return void ed.toast(r.reason, 'err');
      const id = r.id;
      let doc = r.doc;
      if (pl.pin.kind && pl.pin.kind !== 'toggle') {
        doc = setPin(doc, id, { kind: pl.pin.kind, name: uniqueLike(doc, pl.pin.kind === 'clock' ? 'clk' : 'btn') }).doc;
      }
      ed.edit(() => doc);
      ed.select({ pins: [id] });
      return again();
    }
    const at = snapPt(p);
    const names = [...new Set(ed.doc.labels.map((l) => l.name))];
    this.ghost(item, at); // stays while the name is typed
    ed.promptName(at, lastName ?? names[names.length - 1] ?? 'net', names, (name) => {
      ed.view.showGhost(null);
      if (!name) return;
      const r = addLabel(ed.doc, name, at);
      if (r.id === undefined) return void ed.toast(r.reason, 'err');
      const id = r.id;
      lastName = name;
      ed.edit(() => r.doc);
      ed.select({ labels: [id] });
    });
  }

  // ---- keyboard ----------------------------------------------------------------------------

  private key(e: KeyboardEvent): void {
    if (typing(e.target) || e.defaultPrevented) return;
    if ((e.target as HTMLElement | null)?.closest?.('.sb-help')) return;
    const ed = this.ed;
    const st = this.state;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const done = () => e.preventDefault();

    if (st.k === 'wire') {
      if (k === ' ' || k === '/') { done(); st.draft.flip(); if (this.cursor) this.previewWire(st.draft, this.cursor); return; }
      if (k === 'Backspace') { done(); if (!st.draft.undo()) this.cancel(); else if (this.cursor) this.previewWire(st.draft, this.cursor); return; }
      if (k === 'Escape') { done(); this.cancel(); return; }
    }
    if (k === ' ') { done(); this.space = true; return; }
    if (k === 'Escape') {
      done();
      closePopover();
      if (st.k !== 'idle') this.cancel();
      else ed.select({});
      return;
    }
    if (mod && k === 'Enter') { done(); ed.toggleRun(); return; }
    if (mod) {
      switch (k.toLowerCase()) {
        case 'z': done(); this.cancel(); if (e.shiftKey) ed.redo(); else ed.undo(); return;
        case 'y': done(); this.cancel(); ed.redo(); return;
        case 'c': done(); this.copy(); return;
        case 'x': done(); this.copy(); this.del(); return;
        case 'v': done(); this.paste(); return;
        case 'd': done(); this.dup(); return;
        case 'a': done(); ed.select(selectAll(ed.doc)); return;
      }
      return;
    }
    if (e.altKey) return;
    switch (k) {
      case 'Delete': case 'Backspace': done(); this.del(); return;
      case 'f': case 'F': done(); this.flip(); return;
      case 'l': case 'L': done(); this.armPointer(); return;
      case '?': done(); ed.showHelp(); return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!ed.selCount) return;
        done();
        const n = e.shiftKey ? 5 : 1;
        const d: Vec = k === 'ArrowLeft' ? [-n, 0] : k === 'ArrowRight' ? [n, 0] : k === 'ArrowUp' ? [0, -n] : [0, n];
        ed.edit((doc) => moveSel(doc, ed.sel, d, ed.defOf));
      }
    }
  }

  private del(): void {
    const ed = this.ed;
    if (!ed.selCount) return;
    ed.edit((doc) => deleteSel(doc, ed.sel));
    ed.select({});
  }

  private copy(): void {
    const ed = this.ed;
    if (!ed.selCount) return;
    clipboard = copySel(ed.doc, ed.sel);
  }

  private paste(): void {
    const ed = this.ed;
    if (!clipboard) return;
    const c = clipboard;
    const xs = [...c.parts.map((p) => p.at), ...c.pins.map((p) => p.at), ...c.labels.map((l) => l.at), ...c.wires.flatMap((w) => w.pts)];
    if (!xs.length) return;
    const o: Vec = [Math.min(...xs.map((q) => q[0])), Math.min(...xs.map((q) => q[1]))];
    const want = this.cursor ? snapPt(this.cursor) : [o[0] + 2, o[1] + 2] as Vec;
    const r = pasteClip(ed.doc, c, [want[0] - Math.round(o[0]), want[1] - Math.round(o[1])]);
    ed.edit(() => r.doc);
    ed.select(r.sel);
  }

  private dup(): void {
    const ed = this.ed;
    if (!ed.selCount) return;
    const r = duplicate(ed.doc, ed.sel, [2, 2]);
    ed.edit(() => r.doc);
    ed.select(r.sel);
  }

  /** Mirror the selection: parts flip, pins and pointers face the other way. */
  private flip(): void {
    const ed = this.ed;
    const sel = ed.sel;
    if (!ed.selCount) return;
    ed.edit((doc0) => {
      let doc = flipParts(doc0, sel.parts ?? [], ed.defOf);
      for (const id of sel.pins ?? []) {
        const p = doc.pins.find((q) => q.id === id);
        if (p) doc = setPin(doc, id, { face: MIRROR[p.face ?? (p.dir === 'in' ? 'right' : 'left')] }, ed.defOf).doc;
      }
      for (const id of sel.labels ?? []) {
        const l = doc.labels.find((q) => q.id === id);
        if (l) doc = setLabel(doc, id, { face: MIRROR[l.face ?? 'right'] }, ed.defOf).doc;
      }
      return doc;
    });
  }
}

let lastName: string | undefined;

function uniqueLike(doc: ChipDoc, base: string): string {
  const taken = new Set([...doc.pins.map((p) => p.name), ...doc.parts.map((p) => p.id)]);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

function selOf(h: Hit): Sel {
  if (h.k === 'part') return { parts: [h.id] };
  if (h.k === 'pin') return { pins: [h.id] };
  if (h.k === 'label') return { labels: [h.id] };
  if (h.k === 'wire') return { wires: [h.id] };
  return {};
}

function toggle(sel: Sel, h: Hit): Sel {
  const key = h.k === 'part' ? 'parts' : h.k === 'pin' ? 'pins' : h.k === 'label' ? 'labels' : h.k === 'wire' ? 'wires' : null;
  if (!key || !('id' in h)) return sel;
  const cur = sel[key] ?? [];
  return { ...sel, [key]: cur.includes(h.id) ? cur.filter((x) => x !== h.id) : [...cur, h.id] };
}

function union(a: Sel, b: Sel): Sel {
  const u = (x?: string[], y?: string[]) => [...new Set([...(x ?? []), ...(y ?? [])])];
  return { parts: u(a.parts, b.parts), pins: u(a.pins, b.pins), wires: u(a.wires, b.wires), labels: u(a.labels, b.labels) };
}
