// How the mouse and keyboard edit the canvas: a small state machine in the manner of Digital
// Logic Sim. Press on a port starts a free-hand wire (clicks add corners, a click on a port,
// pointer or wire ends it); press on an object selects and drags it; press on empty canvas
// draws a rubber band; Space or the middle button pans (camera.ts). Palette items are dragged
// onto the canvas, or clicked and then placed with a click. Dragging a wire reshapes it: a
// corner (a straight wire's breakpoint) moves, a segment slides across (a straight one bends
// where it was grabbed); a double-click on a corner takes it out. With the "Simple connections"
// setting new wires run straight between the clicked points.
//
// Geometry and the wire being drawn are DOM-free (geom.ts); this file only routes events.

import { type ExitDir, orientExit, type Rot, type Vec } from '../sim/geometry';
import { installPanZoom } from '../view/camera';
import { installHold } from '../ui/holdpress';
import { anchorPoint, isMenuKey } from '../ui/menu';
import { closePopover, editNumber } from '../view/popover';
import { drawPinGlyph } from '../view/symbols';
import { coarsePointer, s } from '../ui/dom';
import { DoubleTap } from '../ui/doubletap';
import { settings } from '../ui/settings';
import { nextDrive } from './chips';
import type { Editor } from './editor';
import { cycle, endName, hitName, ownPorts, stepCursor, targetsOf } from './keynav';
import { lookInside } from './inside';
import { flipSwitch, ioInfo, switchAt, type SwitchState } from './ioparts';
import { canTurn, faceHit, nodeAt } from './face';
import { toggleSwitch } from './ioface';
import { branchPoint, drives, grabOn, type Hit, hitTest, hitWire, knobPortSide, nextSameName, onPinKnob, partAnchor, pointerGeom, sectionCornerAt, snapPt, WireDraft } from './geom';
import { renamePin } from './chips';
import { type ChipDoc, commentBox, sectionCorners, endGeom, endKey, type EndRef, type ExitDir as Face, type PinDoc, pinBig, pinValue } from './model';
import {
  addComment, addLabel, addPart, addPin, addWire, boxSelect, type Clip, copySel, deleteSel, dragWire, duplicate, flipParts, moveSel, pasteClip,
  addSection, groupInSection, namePart, removeBend, resizeSection, rotateParts, type Sel, selectAll, setComment, setLabel, setPin, setSection, type WireGrab, withContents,
} from './ops';
import type { PaletteItem } from './palette';
import { matches, shortcutAllowed } from '../ui/keys';

type State =
  | { k: 'idle' }
  /** Pressed on an object; a click or a drag, not decided yet. */
  /** `name`: the press was on the object's drawn name (a click then renames a selected object). */
  /** `wire`: on a pin knob's port side, where a drag draws a wire from the pin (a tap still toggles it). */
  /** `tap`: a mode's click (Tools.onPress), run instead of the usual one if the press does not move. */
  | { k: 'press'; hit: Hit; at: Vec; sx: number; sy: number; was: boolean; shift: boolean; name: boolean; wire?: { end: EndRef; pos: Vec }; tap?: () => void }
  | { k: 'move'; at: Vec; base: ChipDoc; sel: Sel; d: Vec }
  /**
   * Reshaping one wire: what the press grabbed on it (geom.ts grabOn), from the document before the drag.
   * `hover`: carried with the button up (Add a bend here) until a click drops it.
   */
  | { k: 'reshape'; id: string; grab: WireGrab; at: Vec; base: ChipDoc; d: Vec; hover?: boolean }
  | { k: 'band'; at: Vec; add: boolean }
  /** A mode that took the whole press (Tools.capture: the Cut tool's line). */
  | { k: 'capture'; sx: number; sy: number; moved: boolean }
  /** A section's corner handle dragged: `fixed` is the opposite corner. */
  | { k: 'resize'; id: string; fixed: Vec }
  /** `held`: the button is still down since the press that started it (drag-to-connect). */
  | { k: 'wire'; draft: WireDraft; held: boolean; sx: number; sy: number }
  /** Placing a palette item; `drag` while it is being dragged out of the palette. `flip` / `rot`: F and R pressed meanwhile. */
  | { k: 'place'; item: PaletteItem; drag: boolean; sx: number; sy: number; key: string; flip?: boolean; rot?: Rot };

/** Clipboard shared by every chip of the session (copy in one tab, paste in another). */
let clipboard: Clip | null = null;

const DRAG_PX = 4;
/** Port hit radius in screen px: a mouse, and a finger (a touch press, larger: the knob itself stays the pin's). */
const PORT_PX = 8, PORT_PX_TOUCH = 14;
const MIRROR: Record<Face, Face> = { left: 'right', right: 'left', up: 'up', down: 'down' };

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};
/** A focused control: Space presses it (a button, a summary, a menu item), it does not start a pan. */
const control = (t: EventTarget | null) =>
  !!(t as Element | null)?.closest?.('button, a[href], summary, [role=button], [role^=menuitem], [role=tab], [role=checkbox], [role=switch], [role=option], [role=radio]');

export class Tools {
  state: State = { k: 'idle' };
  /** Last cursor position over the canvas (world units), for paste and placing. */
  cursor: Vec | null = null;
  private space = false;
  /** A double tap does what a double-click does (iOS Safari may send no dblclick for it). */
  private taps = new DoubleTap();
  private panning = false;
  /** The last press came from a finger: ports are hit from further away (tol). */
  private touch = false;
  private buttonHeld: PinDoc | null = null;
  /** The keyboard cursor (a grid point), once a key moved it; a pointer press or move hides it (kcHide). */
  private kc: Vec | null = null;
  private kcOn = false;
  /** A hold just opened the menu: the contextmenu some browsers send for the same press is dropped. */
  private holdQuiet: () => boolean = () => false;
  private off: (() => void)[] = [];
  /**
   * A mode that takes clicks first (probing): true when it consumed the press; a function to run if the press stays a
   * click (a drag goes on as usual: probing, a wire still moves).
   */
  onPress: ((h: Hit, e: PointerEvent) => boolean | (() => void)) | null = null;
  /** The right-click menu (ctxmenu.ts plugs it in), at a screen point, for the selection or the canvas point `at`. */
  onContext: ((x: number, y: number, at: Vec) => void) | null = null;
  /**
   * A mode that takes whole presses (the Cut tool): `down` returns true to own the press, then gets every move and the
   * release (`moved`: it left the click radius), or `cancel` (Esc, a lost pointer). Pans and pinches still come first.
   */
  capture: { down(p: Vec, e: PointerEvent): boolean; move(p: Vec): void; up(p: Vec, moved: boolean): void; cancel(): void } | null = null;

  constructor(private ed: Editor) {
    const svg = ed.view.svg;
    installPanZoom(svg, ed.view.cam, {
      canStart: (e) => this.panStart(e),
      onTap: () => {},
      onPinch: () => this.pinched(),
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
    on(svg, 'contextmenu', (e) => this.context(e));
    // A held finger is the right-click (no browser sends a contextmenu for it everywhere): same menu, same rules.
    const held = installHold(svg, { accept: () => this.state.k === 'press' || this.state.k === 'band', onHold: (x, y) => this.hold(x, y) });
    this.off.push(held.off);
    this.holdQuiet = held.quiet;
    on(svg, 'pointerleave', () => {
      if (this.state.k === 'place' && !this.state.drag) this.ed.view.showGhost(null);
      this.ed.view.showHot(null);
      this.ed.view.showPortsOf([], []);
      this.ed.hoverWire(null);
    });
    on(document, 'keydown', (e) => this.key(e));
    on(document, 'keyup', (e) => { if (e.key === ' ') this.space = false; });
  }

  destroy(): void {
    this.off.forEach((f) => f());
    this.off = [];
  }

  /**
   * Two fingers came down: what the first one started (a press, drag or band) is dropped; a
   * wire being drawn or a part being placed carries on after the zoom.
   */
  private pinched(): void {
    const st = this.state;
    if (st.k === 'press' || st.k === 'move' || st.k === 'reshape' || st.k === 'band') this.cancel();
    else if (st.k === 'wire') st.held = false;
    if (this.buttonHeld) this.release();
  }

  private panStart(e: PointerEvent): boolean {
    this.panning = e.button === 1 || (e.button === 0 && this.space && this.state.k !== 'wire');
    return this.panning;
  }

  private world(e: { clientX: number; clientY: number }): Vec {
    return this.ed.view.cam.toWorld(e.clientX, e.clientY);
  }

  private tol(): number {
    return this.touch ? Math.min(1.5, Math.max(0.5, this.ed.view.px(PORT_PX_TOUCH))) : Math.min(1.2, Math.max(0.35, this.ed.view.px(PORT_PX)));
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
    if (h.k === 'comment') return !!s.comments?.includes(h.id);
    if (h.k === 'section') return !!s.sections?.includes(h.id);
    return false;
  }

  /** A selection with what lies inside its sections: a section carries its contents when it moves. */
  carried(sel: Sel): Sel {
    return withContents(this.ed.doc, sel, this.ed.defOf);
  }

  /** Abandon whatever is in progress. */
  cancel(): void {
    const st = this.state;
    if (st.k === 'move' || st.k === 'reshape') this.ed.cancel();
    if (st.k === 'capture') this.capture?.cancel();
    // placed, finished or given up: the touch screen's "armed" pill has done its job
    this.ed.endMode();
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
    if (this.kcOn) this.kcHide();
    this.ed.hoverWire(null);
    // No text selection or focus change from presses on the canvas (a press that opens the
    // pointer-name prompt must not blur it right away); a field being edited commits first.
    e.preventDefault();
    const act = document.activeElement as HTMLElement | null;
    if (act && act !== document.body && !this.ed.view.svg.contains(act)) act.blur();
    if (this.panning || e.button !== 0) return;
    this.touch = e.pointerType === 'touch';
    const ed = this.ed;
    const p = this.world(e);
    this.cursor = p;
    ed.view.svg.setPointerCapture(e.pointerId);
    closePopover();
    const st = this.state;
    if (this.capture && (st.k === 'idle' || st.k === 'press') && this.capture.down(p, e)) return void (this.state = { k: 'capture', sx: e.clientX, sy: e.clientY, moved: false });

    // A bend carried without a mouse: the press picks it up, and it follows the finger until it lifts.
    if (st.k === 'reshape' && st.hover && this.touch) {
      st.hover = false;
      st.at = p;
      st.d = [0, 0];
      ed.endMode();
      return;
    }
    if (st.k === 'reshape' && st.hover) {
      this.state = { k: 'idle' };
      ed.view.svg.style.cursor = '';
      ed.commit();
      return;
    }
    if (st.k === 'place') return this.place(st.item, p, e.shiftKey);
    if (st.k === 'wire') {
      this.wireClick(st.draft, p);
      if (this.state.k === 'wire') this.state.held = false;
      return;
    }

    // a selected section's corner: resize it (the opposite corner stays)
    const corner = ed.sel.sections?.length && !e.shiftKey ? sectionCornerAt(ed.doc, ed.sel.sections, p, this.tol()) : null;
    if (corner) {
      const s = ed.doc.sections!.find((q) => q.id === corner.id)!;
      ed.begin();
      this.state = { k: 'resize', id: s.id, fixed: sectionCorners(s)[(corner.corner + 2) % 4] };
      return;
    }
    const named = nameHit(e.target);
    let h = named ?? this.hit(p);
    const took = this.onPress?.(h, e);
    if (took === true) return;
    if (took) {
      // nothing selected yet: a click is the mode's, a drag selects as it starts
      this.state = { k: 'press', hit: h, at: p, sx: e.clientX, sy: e.clientY, was: this.isSelected(h), shift: false, name: !!named, tap: took };
      return;
    }
    let wire: { end: EndRef; pos: Vec } | undefined;
    // A finger on a pin's connection point presses the pin: a tap toggles it, a drag draws the wire. At a
    // phone's zoom the knob and the stub's end are a few px apart, too close for a finger to choose between.
    if (h.k === 'port' && 'pin' in h.end && this.touch && !e.shiftKey) {
      wire = { end: h.end, pos: h.pos };
      h = { k: 'pin', id: h.end.pin };
    }
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
      if (pin && !wire && !named && !e.shiftKey && knobPortSide(pin, p)) wire = { end: { pin: pin.id }, pos: pin.at };
    }
    this.state = { k: 'press', hit: h, at: p, sx: e.clientX, sy: e.clientY, was, shift: e.shiftKey, name: !!named, wire };
  }

  private move(e: PointerEvent): void {
    if (this.panning) return;
    if (this.kcOn) this.kcHide();
    const ed = this.ed;
    const p = this.world(e);
    this.cursor = p;
    const st = this.state;
    switch (st.k) {
      case 'capture':
        if (!st.moved && Math.hypot(e.clientX - st.sx, e.clientY - st.sy) >= DRAG_PX) st.moved = true;
        this.capture?.move(p);
        return;
      case 'press': {
        if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < DRAG_PX) return;
        // Dragged out of a knob's port side: a wire from the pin, as from its connection point.
        if (st.wire) {
          if (this.buttonHeld) this.release();
          this.startWire(st.wire.end, st.wire.pos, e);
          return;
        }
        const h = st.hit;
        if (h.k === 'pin' && !st.name && !st.shift) {
          const kp = ed.doc.pins.find((q) => q.id === h.id);
          if (kp && kp.width === 1 && onPinKnob(kp, st.at)) this.knobHint();
        }
        // A wire dragged on its own reshapes; one of several selected moves with the rest.
        const poly = h.k === 'wire' && ed.selCount <= 1 ? ed.view.polys.get(h.id) : undefined;
        if (h.k === 'wire' && poly) {
          if (!st.was) ed.select(selOf(h));
          ed.begin();
          this.state = { k: 'reshape', id: h.id, grab: grabOn(poly, st.at, this.tol()), at: st.at, base: ed.doc, d: [0, 0] };
          return this.move(e);
        }
        if (!this.isSelected(st.hit)) ed.select(selOf(st.hit));
        ed.begin();
        this.state = { k: 'move', at: st.at, base: ed.doc, sel: this.carried(ed.sel), d: [0, 0] };
        return this.move(e);
      }
      case 'move': {
        const d: Vec = [Math.round(p[0] - st.at[0]), Math.round(p[1] - st.at[1])];
        if (d[0] === st.d[0] && d[1] === st.d[1]) return;
        st.d = d;
        ed.edit(() => moveSel(st.base, st.sel, d, ed.defOf));
        return;
      }
      case 'reshape': {
        const d: Vec = [Math.round(p[0] - st.at[0]), Math.round(p[1] - st.at[1])];
        if (d[0] === st.d[0] && d[1] === st.d[1]) return;
        st.d = d;
        ed.edit(() => dragWire(st.base, st.id, st.grab, d, ed.defOf).doc);
        return;
      }
      case 'band':
        ed.view.showBand(st.at, p);
        return;
      case 'resize': {
        const q: Vec = [Math.round(p[0]), Math.round(p[1])];
        ed.edit((d) => resizeSection(d, st.id, st.fixed, q).doc);
        return;
      }
      case 'wire':
        return this.previewWire(st.draft, p);
      case 'place':
        return this.ghost(st.item, p);
      default: {
        if (e.pointerType === 'mouse' || e.pointerType === 'pen') this.touch = false;
        const cc = ed.sel.sections?.length ? sectionCornerAt(ed.doc, ed.sel.sections, p, this.tol()) : null;
        if (cc) { ed.view.svg.style.cursor = cc.corner % 2 ? 'nesw-resize' : 'nwse-resize'; return; }
        const h = this.hit(p);
        const pin = h.k === 'pin' ? ed.doc.pins.find((q) => q.id === h.id) : undefined;
        // On a knob's port side the connection point lights up: a drag from here draws a wire.
        ed.view.showHot(h.k === 'port' ? h.pos : pin && knobPortSide(pin, p) ? pin.at : null);
        const owner = h.k === 'port' ? hitOwner(h) : h;
        ed.view.showPortsOf(owner.k === 'part' ? [owner.id] : [], owner.k === 'pin' ? [owner.id] : []);
        ed.hoverWire(h.k === 'wire' ? h.id : null, e);
        // a pin's knob: the stub half draws a wire (crosshair), the far half moves the pin (grab)
        const onKnob = !!pin && pin.width === 1 && onPinKnob(pin, p);
        ed.view.svg.style.cursor = h.k === 'wire' ? this.wireCursor(h.id, p)
          : onKnob ? (knobPortSide(pin, p) ? 'crosshair' : 'grab') : h.k === 'port' ? 'crosshair' : pin && pin.dir !== 'out' ? 'pointer' : h.k === 'none' ? '' : this.isSelected(h) ? 'move' : 'pointer';
      }
    }
  }

  /** The first time a drag from a knob's far half moves the pin: say how to wire instead (once, remembered). */
  private knobHint(): void {
    const key = 'sb-knob-hint';
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch { /* storage blocked: say it every session */ }
    this.ed.toast('That moved the pin. To wire, drag from the stub side of its knob (the crosshair half).');
  }

  private up(e: PointerEvent): void {
    const ed = this.ed;
    if (ed.view.svg.hasPointerCapture(e.pointerId)) ed.view.svg.releasePointerCapture(e.pointerId);
    if (this.panning) { this.panning = false; return; }
    if (this.buttonHeld) this.release();
    const st = this.state;
    const p = this.world(e);
    switch (st.k) {
      case 'capture':
        this.state = { k: 'idle' };
        this.capture?.up(p, st.moved);
        return;
      case 'press': {
        this.state = { k: 'idle' };
        if (st.tap) return st.tap();
        this.click(st, e);
        // what was tapped, the same thing twice (a wire anywhere along it)
        const h = st.hit, key = h.k === 'wire' ? `wire ${h.id}` : `${st.name} ${JSON.stringify(h)}`;
        if (this.taps.upEvent(e, key) && this.state.k === 'idle') this.dbl(e);
        return;
      }
      case 'resize':
        this.state = { k: 'idle' };
        ed.commit();
        return;
      case 'move':
      case 'reshape':
        if (st.k === 'reshape' && st.hover) return;
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
          // Back where it started: the wire stays armed for a click, as after a press without a drag.
          if (t.end && !atStart(st.draft, t.end)) this.finish(st.draft, t.end, t.pos, t.exit);
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

  /** A click on a switch of a switch bank flips it (it is the world outside: no undo step). */
  private flipSwitchAt(id: string, at: Vec): boolean {
    const ed = this.ed;
    const p = ed.doc.parts.find((q) => q.id === id);
    const def = p && ed.defOf(p);
    const info = ioInfo(def);
    if (!p || !def) return false;
    const x = at[0] - p.at[0], y = at[1] - p.at[1];
    // A switch bank shown on a placed chip's face flips too (face.ts).
    const hit = info ? null : faceHit(def, !!p.flip, x, y, p.rot);
    if (hit?.d.kind === 'switches') {
      const bit = switchAt(hit.d.width, hit.lx, hit.ly);
      const node = nodeAt(ed.sim.sim?.design.root.children?.get(id), hit.d.path);
      if (bit !== null && node) toggleSwitch(ed.sim, node, bit);
      return bit !== null;
    }
    if (info?.kind !== 'switches') return false;
    const bit = switchAt(info.width, x, y); // the face is not mirrored (only its port moves)
    const sim = ed.sim.sim, li = sim?.design.root.children?.get(id)?.leafIndex;
    if (bit === null || !sim || li === undefined) return bit !== null;
    const v = (sim.leafState(li) as SwitchState | undefined)?.v ?? 0;
    ed.sim.pokeLeaf(li, { v: flipSwitch(v, bit) } satisfies SwitchState);
    return true;
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
    // A click on the name of what was already selected: type a new one.
    if (st.was && st.name && ed.selCount <= 1) return this.rename(h);
    if (h.k === 'pin') return void this.pinAction(h.id, new DOMRect(e.clientX, e.clientY, 0, 0));
    if (h.k === 'part' && this.flipSwitchAt(h.id, st.at)) return;
    if (h.k === 'label' && st.was) this.jump(h.id);
  }

  /** What a click on a pin does: an input toggles (a wide one asks for a number), a clock starts or stops, a bidirectional pin cycles. */
  private pinAction(id: string, fallback: DOMRect): boolean {
    const ed = this.ed;
    const pin = ed.doc.pins.find((q) => q.id === id);
    if (pin?.dir === 'inout') { ed.setPinValue(pin.id, nextDrive(pin)); return true; }
    if (!pin || pin.dir !== 'in') return false;
    if (pin.kind === 'clock') { ed.sim.toggleClocks(); return true; }
    if (pin.kind === 'button') return false;
    if (pin.width === 1) { ed.setPinValue(pin.id, pin.value ? 0 : 1); return true; }
    const g = ed.view.svg.querySelector(`[data-pin-id="${pin.id}"]`);
    const r = g ? g.getBoundingClientRect() : fallback;
    editNumber(r, pin.name, pin.width, pinBig(pin.value), (v) => ed.setPinValue(pin.id, pinValue(v)));
    return true;
  }

  private dbl(e: MouseEvent): void {
    if (e.type === 'dblclick' && !this.taps.dblclick(e.timeStamp)) return;
    const ed = this.ed;
    const named = nameHit(e.target);
    if (named) {
      if (!ed.typingOnCanvas) this.rename(named);
      return;
    }
    const p = this.world(e);
    const h = this.hit(p);
    if (h.k === 'label') return; // the second click of a double-click already jumped
    if (h.k === 'comment') return this.editComment(h.id);
    if (h.k === 'section') return this.rename(h);
    if (h.k === 'wire') {
      const poly = ed.view.polys.get(h.id);
      const g = poly && grabOn(poly, p, this.tol());
      if (g && 'corner' in g) this.unbend(h.id, g.corner);
      return;
    }
    if (h.k === 'part') {
      // A user chip opens for editing; anything else opens read-only, live (look inside).
      const part = ed.doc.parts.find((q) => q.id === h.id);
      if (part && 'chip' in part.ref) ed.editChip(part.ref.chip);
      else if (part) lookInside(ed, [part.id]);
    }
  }

  /** Right-click: cancel what is in progress, else the actions for what is under the cursor. */
  private context(e: MouseEvent): void {
    // Shift: the browser's own menu, the way out of this one
    if (e.shiftKey) return;
    e.preventDefault();
    if (this.holdQuiet()) return;
    if (this.state.k === 'wire' || this.state.k === 'place' || (this.state.k === 'reshape' && this.state.hover)) return this.cancel();
    if (this.state.k !== 'idle') return;
    const p = this.world(e);
    this.cursor = p;
    this.menuFor(nameHit(e.target) ?? this.hit(p), e.clientX, e.clientY, p);
  }

  /** The menu key: for the selection, at its place on the canvas; with nothing selected, the canvas's own. */
  keyMenu(): void {
    const ed = this.ed, s = ed.sel, svg = ed.view.svg;
    const q = s.parts?.length ? `[data-part="${CSS.escape(s.parts[0])}"]` : s.pins?.length ? `[data-pin-id="${CSS.escape(s.pins[0])}"]`
      : s.wires?.length ? `[data-wire="${CSS.escape(s.wires[0])}"]` : s.labels?.length ? `[data-label="${CSS.escape(s.labels[0])}"]` : '';
    const box = q ? svg.querySelector(q)?.getBoundingClientRect() ?? null : null;
    let { x, y } = anchorPoint(box, svg.getBoundingClientRect());
    let p = this.world({ clientX: x, clientY: y });
    // the keyboard cursor, if it is out: the menu is for the point it marks
    if (this.kcOn && this.kc) {
      const m = svg.getScreenCTM();
      if (m && !box) {
        const sp = new DOMPoint(this.kc[0], this.kc[1]).matrixTransform(m);
        x = sp.x;
        y = sp.y;
      }
      p = this.kc;
    }
    this.cursor = p;
    this.onContext?.(x, y, p);
  }

  /** Select what the menu is for (what was under the press), then open it at a screen point. */
  private menuFor(h: Hit, x: number, y: number, p: Vec): void {
    const ed = this.ed;
    const target: Hit = h.k === 'port' ? hitOwner(h) : h;
    if (target.k !== 'none' && !this.isSelected(target)) ed.select(selOf(target));
    if (target.k === 'none' && ed.selCount) ed.select({});
    this.onContext?.(x, y, p);
  }

  /**
   * A finger held still where a press began (hold.ts): the right-click menu for what is under it. The press that is
   * still down (a part about to be dragged, a band, a held button) is let go first, so the lift does nothing.
   */
  private hold(x: number, y: number): boolean {
    const st = this.state;
    if (!this.onContext || (st.k !== 'press' && st.k !== 'band') || (st.k === 'press' && st.tap)) return false;
    const hit: Hit = st.k === 'press' ? st.hit : { k: 'none' };
    if (this.buttonHeld) this.release();
    this.state = { k: 'idle' };
    this.ed.view.showBand(null);
    const p = this.world({ clientX: x, clientY: y });
    this.cursor = p;
    this.menuFor(st.k === 'press' ? hit : this.hit(p), x, y, p);
    return true;
  }

  /** Rename the one selected object (F2). */
  renameSel(): void {
    const s = this.ed.sel;
    if (this.ed.selCount !== 1) return;
    const h: Hit = s.parts?.length ? { k: 'part', id: s.parts[0] } : s.pins?.length ? { k: 'pin', id: s.pins[0] }
      : s.labels?.length ? { k: 'label', id: s.labels[0] } : s.comments?.length ? { k: 'comment', id: s.comments[0] }
      : s.sections?.length ? { k: 'section', id: s.sections[0], on: 'title' } : { k: 'none' };
    this.rename(h);
  }

  /**
   * Type a new name where the object's name is drawn. A part edits what it shows: its caption if
   * it has one, else its instance name (text that cannot be an instance name becomes a caption).
   * A pin's rename keeps the chips that place this one wired; a comment edits its text.
   */
  rename(h: Hit): void {
    const ed = this.ed;
    const svg = ed.view.svg;
    const el = (sel: string) => svg.querySelector(sel);
    if (h.k === 'comment') return this.editComment(h.id);
    if (h.k === 'section') {
      const sc = ed.doc.sections?.find((q) => q.id === h.id);
      const at = sc && (el(`[data-section="${CSS.escape(sc.id)}"] .ed-sec-title`) ?? el(`[data-section="${CSS.escape(sc.id)}"]`));
      if (!sc || !at) return;
      ed.editInline(at, sc.title, { label: 'Section title' }, (v) => {
        if (v === null || v.trim() === sc.title) return;
        ed.edit((d) => setSection(d, sc.id, { title: v }).doc);
      });
      return;
    }
    if (h.k === 'part') {
      const p = ed.doc.parts.find((q) => q.id === h.id);
      const at = p && (el(`[data-part="${p.id}"] .inst-name`) ?? el(`[data-part="${p.id}"]`));
      if (!p || !at) return;
      ed.editInline(at, p.label ?? p.id, { label: 'Part name' }, (v) => {
        if (v === null) return;
        const r = namePart(ed.doc, p.id, v, ed.defOf);
        if (r.reason) return void ed.toast(r.reason, 'err');
        if (r.doc === ed.doc) return;
        ed.edit(() => r.doc);
        if (r.id !== p.id) ed.select({ parts: [r.id] });
      });
      return;
    }
    if (h.k === 'pin') {
      const pin = ed.doc.pins.find((q) => q.id === h.id);
      const at = pin && (el(`[data-pin-id="${pin.id}"] .pin-name`) ?? el(`[data-pin-id="${pin.id}"]`));
      if (!pin || !at) return;
      ed.editInline(at, pin.name, { label: 'Pin name' }, (v) => {
        if (!v || v === pin.name) return;
        const r = renamePin(ed.ws, ed.chipId, pin.id, v, ed.defOf);
        if ('reason' in r) return void ed.toast(r.reason, 'err');
        ed.editWs(() => r.ws);
      });
      return;
    }
    if (h.k === 'label') {
      const l = ed.doc.labels.find((q) => q.id === h.id);
      const at = l && (el(`[data-label="${l.id}"] .ed-ptr-name`) ?? el(`[data-label="${l.id}"]`));
      if (!l || !at) return;
      ed.editInline(at, l.name, { label: 'Pointer name', names: [...new Set(ed.doc.labels.map((q) => q.name))] }, (v) => {
        if (!v || v === l.name) return;
        const r = setLabel(ed.doc, l.id, { name: v }, ed.defOf);
        if (r.reason) return void ed.toast(r.reason, 'err');
        ed.edit(() => r.doc);
      });
    }
  }

  /** Take corner j (of its drawn polyline) out of a wire. */
  unbend(id: string, j: number): void {
    const r = removeBend(this.ed.doc, id, j, this.ed.defOf);
    if (r.reason) return void this.ed.toast(r.reason);
    this.ed.edit(() => r.doc);
  }

  /** Add a bend here: a new corner on the wire at p, carried by the pointer until a click drops it (Esc cancels). */
  bendAt(id: string, p: Vec): void {
    const poly = this.ed.view.polys.get(id);
    const g = poly && grabOn(poly, p, this.tol());
    if (!g || !('seg' in g)) return;
    this.cancel();
    const at: Vec = [Math.round(g.at[0]), Math.round(g.at[1])];
    this.ed.begin();
    this.state = { k: 'reshape', id, grab: { bend: g.seg, at }, at, base: this.ed.doc, d: [0, 0], hover: true };
    this.ed.view.svg.style.cursor = 'move';
    if (this.touch) this.ed.showMode('Bend: drag anywhere to move it, lift to drop');
    else this.ed.toast('Move the bend, click to drop it (Esc cancels)');
  }

  /** The corner of a wire's polyline under p (within the click tolerance), or -1. */
  cornerAt(id: string, p: Vec): number {
    const poly = this.ed.view.polys.get(id);
    const g = poly && grabOn(poly, p, this.tol());
    return g && 'corner' in g ? g.corner : -1;
  }

  /** What a drag would do to a wire under p: move a corner, slide a segment across, bend a straight one. */
  private wireCursor(id: string, p: Vec): string {
    const poly = this.ed.view.polys.get(id);
    if (!poly) return 'pointer';
    if (this.ed.selCount > 1 && this.ed.sel.wires?.includes(id)) return 'move';
    const g = grabOn(poly, p, this.tol());
    if ('corner' in g) return 'move';
    if (this.ed.doc.wires.find((w) => w.id === id)?.straight) return 'grab';
    const [a, b] = [poly[g.seg], poly[g.seg + 1]];
    return a[1] === b[1] ? 'ns-resize' : 'ew-resize';
  }

  /** Place a palette item at a world point (the context menu's "Add … here"). */
  placeAt(item: PaletteItem, p: Vec): void {
    this.cancel();
    this.place(item, p, false);
  }

  /** Edit a comment's text in place (blank text deletes it). */
  editComment(id: string): void {
    const ed = this.ed;
    const c = ed.doc.comments?.find((q) => q.id === id);
    if (!c) return;
    ed.promptText(c.at, c.text, (text) => {
      if (text === null) return;
      if (!text) {
        ed.edit((d) => deleteSel(d, { comments: [id] }));
        return ed.select({});
      }
      ed.edit((d) => setComment(d, id, { text }).doc);
    });
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
    this.beginWire(from, pos, true, e.clientX, e.clientY, this.world(e));
    if (this.touch) ed.showMode('Wire: tap a pin to finish, the canvas to bend');
  }

  private beginWire(from: EndRef, pos: Vec, held: boolean, sx: number, sy: number, at: Vec): void {
    const ed = this.ed;
    const g = 'wire' in from ? null : endGeom(ed.doc, from, ed.defOf);
    const draft = new WireDraft(from, pos, g?.exit ?? null, settings.simpleWires);
    this.state = { k: 'wire', draft, held, sx, sy };
    ed.view.svg.style.cursor = 'crosshair';
    this.previewWire(draft, at);
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
    // A second tap where the wire started, before any corner: the wire is let go, no complaint.
    if (t.end && atStart(draft, t.end)) return this.cancel();
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
    const r = addWire(ed.doc, draft.from, end, draft.corners(pos, exit), ed.defOf, draft.straight);
    if (r.reason) {
      ed.toast(`Cannot wire: ${r.reason}`, 'err');
      return;
    }
    const said = `Wire connected: ${endName(ed.doc, ed.defOf, draft.from)} to ${endName(ed.doc, ed.defOf, end)}`;
    this.cancel();
    ed.edit(() => r.doc);
    ed.announce(said);
  }

  // ---- placing -----------------------------------------------------------------------------

  /** Pointer down on a palette item: drag it out, or (released in place) arm it for a click. */
  pickFromPalette(item: PaletteItem, e: PointerEvent): void {
    const ed = this.ed;
    const key = (e.currentTarget as HTMLElement | null)?.dataset.item ?? item.id;
    // A finger on the item that is already armed lets it go (a touch screen has no Esc; the pill's Cancel does it too).
    if (e.pointerType === 'touch' && this.state.k === 'place' && !this.state.drag && this.state.key === key) return this.cancel();
    this.cancel();
    this.state = { k: 'place', item, drag: true, sx: e.clientX, sy: e.clientY, key };
    ed.palette.setArmed(key);
    const svg = ed.view.svg;
    const over = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    };
    // A user chip dragged onto a folder of My chips (or the group itself: out of its folder) is filed there.
    const chip = 'part' in item.place && 'chip' in item.place.part ? item.place.part.chip : null;
    const moved = (ev: PointerEvent) => Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) >= DRAG_PX;
    const folder = (ev: PointerEvent) => (chip && !ed.level && moved(ev) ? ed.palette.folderAt(ev.clientX, ev.clientY) : null);
    const mv = (ev: PointerEvent) => {
      if (this.state.k !== 'place') return;
      if (over(ev)) this.ghost(item, this.world(ev));
      else ed.view.showGhost(null);
      ed.palette.markDrop(folder(ev));
    };
    const off = () => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', upH);
      document.removeEventListener('pointercancel', cancelH);
    };
    // The browser took the touch over (a swipe scrolling the phone's parts drawer: editor.css pan-y): no part.
    const cancelH = () => {
      off();
      ed.palette.markDrop(null);
      if (this.state.k === 'place' && this.state.drag) this.cancel();
    };
    const upH = (ev: PointerEvent) => {
      off();
      ed.palette.markDrop(null);
      const st = this.state;
      if (st.k !== 'place') return;
      const into = folder(ev);
      if (chip && into !== null) {
        this.cancel();
        const at = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.sb-item')?.dataset.item;
        const before = at?.startsWith('mine/') && at !== `mine/${chip}` ? at.slice(5) : undefined;
        ed.fileChip(chip, into || null, into ? before : undefined);
      } else if (over(ev)) {
        this.place(item, this.world(ev), ev.shiftKey);
      } else if (Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) < DRAG_PX) {
        st.drag = false; // a click: armed until a click on the canvas (Esc cancels)
      } else this.cancel();
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', upH);
    document.addEventListener('pointercancel', cancelH);
  }

  /** Arm the comment tool (key T). */
  armComment(): void {
    this.arm({ id: 'comment', name: 'Comment', place: { comment: true } }, 'wiring/comment');
  }

  /** Arm the pointer tool (key L). */
  armPointer(): void {
    this.arm({ id: 'pointer', name: 'Pointer', place: { pointer: true } }, 'wiring/pointer');
  }

  /** Arm a palette item (`key`: its palette key) for a click on the canvas, as a click on it would. */
  arm(item: PaletteItem, key: string): void {
    this.cancel();
    this.state = { k: 'place', item, drag: false, sx: 0, sy: 0, key };
    this.ed.palette.setArmed(key);
    if (coarsePointer()) this.ed.showMode(`Tap the canvas to place ${item.name}`);
    if (this.cursor) this.ghost(item, this.cursor);
  }

  private ghost(item: PaletteItem, p: Vec): void {
    const v = this.ed.view;
    const pl = item.place;
    const key = JSON.stringify(pl);
    if ('part' in pl) {
      const def = this.ed.defOfRef(pl.part);
      if (!def) return v.showGhost(null);
      const st = this.state, flip = st.k === 'place' ? st.flip : undefined, rot = st.k === 'place' ? st.rot : undefined;
      return v.showGhost(`${key}|${!!flip}|${rot ?? 0}`, () => v.ghostOf(def, pl.part, flip, rot), partAnchor(def, p, flip, rot));
    }
    v.showGhost(key, () => {
      if ('comment' in pl) {
        const b = commentBox({ id: '', at: [0, 0], text: 'comment' });
        return s('g', { class: 'ed-note' },
          s('rect', { class: 'ed-note-bg', x: 0, y: 0, width: b.w, height: b.h, rx: 0.4 }),
          s('text', { class: 'ed-note-text', x: 0.6, y: 1.3 }, 'comment'));
      }
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
    const st = this.state, flip = st.k === 'place' ? st.flip : undefined, rot = st.k === 'place' ? st.rot : undefined;
    const again = () => {
      if (keep) {
        this.state = { k: 'place', item, drag: false, sx: 0, sy: 0, key: ed.palette.armed ?? item.id, flip, rot };
        ed.palette.setArmed(ed.palette.armed);
      }
    };
    this.cancel();
    // a part dropped by hand is where the learner chose: a still-fitted view must not refit around it when the layout shifts
    ed.view.cam.fitted = false;
    if ('part' in pl) {
      const def = ed.defOfRef(pl.part);
      if (!def) return void ed.toast(`Cannot place ${item.name}`, 'err');
      const r = addPart(ed.doc, pl.part, partAnchor(def, p, flip, rot));
      if (r.id === undefined) return void ed.toast(r.reason, 'err');
      const id = r.id;
      const turned = flip || rot ? { ...r.doc, parts: r.doc.parts.map((q) => (q.id === id ? { ...q, ...(flip ? { flip } : {}), ...(rot ? { rot } : {}) } : q)) } : r.doc;
      ed.edit(() => turned);
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
    if ('comment' in pl) {
      this.ghost(item, at);
      ed.promptText(at, '', (text) => {
        ed.view.showGhost(null);
        if (!text) return;
        const r = addComment(ed.doc, text, at);
        if (r.id === undefined) return void ed.toast(r.reason, 'err');
        const id = r.id;
        ed.edit(() => r.doc);
        ed.select({ comments: [id] });
      });
      return;
    }
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
    if ((e.target as HTMLElement | null)?.closest?.('.sb-help, .key-help')) return;
    const ed = this.ed;
    const st = this.state;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const done = () => e.preventDefault();

    if (isMenuKey(e) && (!control(e.target) || ed.view.svg.contains(e.target as Node))) {
      done();
      if (st.k === 'idle' || (st.k === 'place' && !st.drag)) this.keyMenu();
      return;
    }
    // A bend being carried: any key but a modifier drops the edit (Esc included).
    if (st.k === 'reshape' && st.hover && !['Control', 'Shift', 'Alt', 'Meta'].includes(k)) { done(); this.cancel(); return; }
    if (st.k === 'wire') {
      if (k === ' ' || (k === '/' && shortcutAllowed(e))) { done(); st.draft.flip(); if (this.cursor) this.previewWire(st.draft, this.cursor); return; }
      if (k === 'Backspace') { done(); if (!st.draft.undo()) this.cancel(); else if (this.cursor) this.previewWire(st.draft, this.cursor); return; }
      if (k === 'Escape') { done(); this.cancel(); return; }
    }
    if (this.keyCanvas(e, st)) { done(); return; }
    if (k === ' ' && !control(e.target)) { done(); this.space = true; return; }
    if (k === 'Escape') {
      done();
      closePopover();
      if (st.k !== 'idle') this.cancel();
      else {
        // the second Esc puts the keyboard cursor away
        if (!ed.selCount && this.kcOn) this.kcHide();
        ed.select({});
      }
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
    // single character keys: off with the setting (WCAG 2.1.4); letters by their position on a non-Latin layout (keys.ts)
    if (!shortcutAllowed(e)) return;
    // F and R while a part waits to be placed turn the part to be placed
    if (st.k === 'place' && 'part' in st.item.place && (matches(e, 'sb.flip') || matches(e, 'sb.rotate'))) {
      done();
      const def = ed.defOfRef(st.item.place.part);
      if (matches(e, 'sb.flip')) {
        st.flip = !st.flip || undefined;
        if (st.rot && st.rot !== 2) st.rot = (4 - st.rot) as Rot;
      } else if (canTurn(st.item.place.part, def)) st.rot = (((st.rot ?? 0) + (e.shiftKey ? 3 : 1)) % 4 || undefined) as Rot | undefined;
      else return void ed.toast(`${st.item.name} does not turn (it can mirror: F)`);
      if (this.cursor) this.ghost(st.item, this.cursor);
      return;
    }
    if (matches(e, 'sb.flip')) { done(); this.flip(); return; }
    if (matches(e, 'sb.rotate')) { done(); this.rotate(e.shiftKey ? 3 : 1); return; }
    if (matches(e, 'sb.pointer')) { done(); this.armPointer(); return; }
    if (matches(e, 'sb.comment')) { done(); this.armComment(); return; }
    if (matches(e, 'sb.section')) { done(); this.groupSel(); return; }
    switch (k) {
      case 'Delete': case 'Backspace': done(); this.del(); return;
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9': {
        const f = ed.palette.favorite(+k - 1);
        if (!f) return;
        done();
        if (f.item.disabled) return void ed.toast(f.item.disabled, 'err');
        this.arm(f.item, f.key);
        return;
      }
      case 'F2': done(); this.renameSel(); return;
      case '?': done(); ed.showHelp(); return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!ed.selCount) return;
        done();
        const n = e.shiftKey ? 5 : 1;
        const d: Vec = k === 'ArrowLeft' ? [-n, 0] : k === 'ArrowRight' ? [n, 0] : k === 'ArrowUp' ? [0, -n] : [0, n];
        ed.edit((doc) => moveSel(doc, this.carried(ed.sel), d, ed.defOf));
      }
    }
  }

  // ---- the keyboard cursor (WCAG 2.1.1) ------------------------------------------------------

  /** The focus is on the canvas, or nowhere (a mouse press leaves none): the keys below are the canvas's. */
  private onCanvas(t: EventTarget | null): boolean {
    const svg = this.ed.view.svg;
    return t === svg || t === document.body || t === document.documentElement || (t instanceof Node && svg.contains(t));
  }

  /** The part, if any, that Enter or the menu would place: armed, not being dragged. */
  get armedItem(): PaletteItem | null {
    const st = this.state;
    return st.k === 'place' && !st.drag ? st.item : null;
  }

  /** The cursor, started where the pointer last was if it is in view, else in the middle of the view. */
  private kcPoint(): Vec {
    if (this.kc && this.kcOn) return this.kc;
    const v = this.ed.view.cam.vb, c = this.cursor;
    const inView = c && c[0] >= v.x && c[0] <= v.x + v.w && c[1] >= v.y && c[1] <= v.y + v.h;
    const p = snapPt(inView ? c : [v.x + v.w / 2, v.y + v.h / 2]);
    this.kc = p;
    return p;
  }

  /** Show the keyboard cursor (an item was armed from the parts list). */
  keyboardStart(): void {
    this.kcSet(this.kcPoint(), false);
  }

  private kcHide(): void {
    this.kcOn = false;
    this.ed.view.showKeyCursor(null);
    this.ed.view.showHot(null);
    this.ed.view.showPortsOf([], []);
  }

  /** Move the keyboard cursor to a grid point: the view follows, what is under it lights and is said. */
  private kcSet(p: Vec, say = true): void {
    const ed = this.ed;
    this.kc = p;
    this.kcOn = true;
    this.cursor = [p[0], p[1]];
    ed.view.cam.centerOn(p);
    ed.view.showKeyCursor(p);
    const st = this.state;
    const h = this.hit(p);
    const name = hitName(ed.doc, ed.defOf, h);
    let msg = `${name ?? 'empty'}, ${p[0]}, ${p[1]}`;
    if (st.k === 'place') {
      this.ghost(st.item, p);
      msg = `${st.item.name} goes here (${name ? `over ${name}, ` : ''}${p[0]}, ${p[1]})`;
    } else if (st.k === 'wire') {
      this.previewWire(st.draft, p);
      const t = this.target(p);
      const why = t.end ? this.refusal(st.draft, t.end) : null;
      msg = t.end ? `${endName(ed.doc, ed.defOf, t.end)}${why ? `: ${why}` : ': Enter connects'}` : `corner ${p[0]}, ${p[1]}: Enter adds a bend`;
    } else {
      ed.view.showHot(h.k === 'port' ? h.pos : null);
      const owner = h.k === 'port' ? hitOwner(h) : h;
      ed.view.showPortsOf(owner.k === 'part' ? [owner.id] : [], owner.k === 'pin' ? [owner.id] : []);
    }
    if (say) ed.announce(msg);
  }

  /** The keys of a canvas without a mouse. True when the key was one of them. */
  private keyCanvas(e: KeyboardEvent, st: State): boolean {
    const ed = this.ed;
    const k = e.key;
    if (e.ctrlKey || e.metaKey || !this.onCanvas(e.target)) return false;
    // With the focus nowhere (a mouse press leaves none) these keys are the canvas's only once the keyboard cursor is out.
    if ((e.target === document.body || e.target === document.documentElement) && !this.kcOn) return false;
    if (k.startsWith('Arrow')) {
      if (st.k !== 'idle' && st.k !== 'wire' && !(st.k === 'place' && !st.drag)) return false;
      // Alt+arrows always move the cursor; plain arrows nudge a selection, and move the cursor when nothing is selected,
      // a part is armed or a wire begun
      if (!e.altKey && st.k === 'idle' && ed.selCount) return false;
      this.kcSet(stepCursor(this.kcPoint(), k, e.shiftKey));
      return true;
    }
    if (e.altKey) return false;
    if (k === 'Enter' || (k === ' ' && st.k === 'place' && !st.drag)) {
      const p = this.kcPoint();
      if (st.k === 'place' && !st.drag) {
        this.kcSet(p, false);
        this.placeAtCursor(st.item, p, e.shiftKey);
        return true;
      }
      if (st.k === 'wire') {
        this.wireClick(st.draft, p);
        if (this.state.k === 'wire') this.kcSet(p);
        return true;
      }
      if (st.k === 'idle' && k === 'Enter') {
        this.activate(p, e.shiftKey);
        return true;
      }
      return false;
    }
    if (!shortcutAllowed(e)) return false;
    if (matches(e, 'sb.nextpin') && (st.k === 'idle' || st.k === 'wire')) {
      const dir = e.shiftKey ? -1 : 1;
      const all = targetsOf(ed.doc, ed.defOf);
      const here = this.kcOn ? this.kcPoint() : null;
      let a;
      if (st.k === 'wire') a = cycle(all.filter((t) => !this.refusal(st.draft, t.end)), here, dir);
      else {
        // the selected part's own pins first; with nothing selected, every pin of the chip
        const own = ownPorts(ed.doc, ed.defOf, ed.sel);
        a = own.length ? cycle(own, here && own.some((t) => t.pos[0] === here[0] && t.pos[1] === here[1]) ? here : null, dir) : cycle(all, here, dir);
      }
      if (!a) ed.announce('No pins here');
      else this.kcSet(a.pos);
      return true;
    }
    if (matches(e, 'sb.wirekey') && st.k === 'idle') {
      this.wireFromKeyboard();
      return true;
    }
    return false;
  }

  /** Enter with a part armed: place it at the cursor, and say what was placed. */
  private placeAtCursor(item: PaletteItem, p: Vec, keep: boolean): void {
    const ed = this.ed;
    this.place(item, p, keep);
    const s = ed.sel;
    const part = s.parts?.length ? ed.doc.parts.find((q) => q.id === s.parts![0]) : undefined;
    const pin = s.pins?.length ? ed.doc.pins.find((q) => q.id === s.pins![0]) : undefined;
    if (part) ed.announce(`Placed ${part.id} (${item.name}) at ${p[0]}, ${p[1]}${keep ? '; still armed' : ''}`);
    else if (pin) ed.announce(`Placed ${pin.dir === 'in' ? 'input' : pin.dir === 'out' ? 'output' : 'bidirectional'} pin ${pin.name} at ${p[0]}, ${p[1]}${keep ? '; still armed' : ''}`);
  }

  /** Enter with nothing armed: select what is under the cursor; on an input, toggle it. */
  private activate(p: Vec, add: boolean): void {
    const ed = this.ed;
    const h = this.hit(p);
    const t: Hit = h.k === 'port' ? hitOwner(h) : h;
    if (t.k === 'none') {
      ed.select({});
      return ed.announce(`Nothing here, ${p[0]}, ${p[1]}`);
    }
    const was = this.isSelected(t);
    if (add) ed.select(toggle(ed.sel, t));
    else if (!was) ed.select(selOf(t));
    const name = hitName(ed.doc, ed.defOf, t) ?? '';
    if (add) return ed.announce(`${this.isSelected(t) ? 'Added' : 'Removed'} ${name}`);
    if (t.k === 'pin') {
      const pin = ed.doc.pins.find((q) => q.id === t.id);
      if (pin && this.pinAction(pin.id, new DOMRect(0, 0, 0, 0))) return this.sayPin(pin.id);
      return ed.announce(`Selected ${name}`);
    }
    if (t.k === 'part' && was && this.flipSwitchAt(t.id, p)) return ed.announce(`${name}: switch flipped`);
    if (t.k === 'label' && was) return this.jump(t.id);
    ed.announce(`Selected ${name}${t.k === 'part' ? '. W starts a wire from its pins, N steps through them' : ''}`);
  }

  /** After a pin was used by key: its value now, and the outputs it moved. */
  private sayPin(id: string): void {
    const ed = this.ed;
    setTimeout(() => {
      const bits = (name: string) => ed.sim.pinBits(name)?.map((b) => String(b)).reverse().join('') ?? '?';
      const pin = ed.doc.pins.find((q) => q.id === id);
      if (!pin) return;
      const outs = ed.doc.pins.filter((q) => q.dir === 'out').slice(0, 6).map((q) => `${q.name} = ${bits(q.name)}`);
      ed.announce(`${pin.name} = ${bits(pin.name)}${pin.kind === 'clock' ? ' (clock)' : ''}${outs.length ? `; outputs: ${outs.join(', ')}` : ''}`);
    }, 150);
  }

  /** W: a wire from the pin under the cursor, else from the selected part's first pin. */
  private wireFromKeyboard(): void {
    const ed = this.ed;
    const t = this.target(this.kcPoint());
    if (t.end && !('wire' in t.end)) return this.keyWire(t.end, t.pos);
    const own = ownPorts(ed.doc, ed.defOf, ed.sel);
    if (!own.length) return ed.announce('Put the cursor on a pin first: N steps to the next pin');
    this.keyWire(own[0].end, own[0].pos);
  }

  private keyWire(end: EndRef, pos: Vec): void {
    const ed = this.ed;
    this.beginWire(end, pos, false, 0, 0, pos);
    this.kcSet(pos, false);
    ed.showMode('Wire: arrows move, N next pin, Enter connects or bends, Esc cancels');
    ed.announce(`Wire from ${endName(ed.doc, ed.defOf, end)}. Arrow keys move, N jumps to the next pin, Enter connects, Escape cancels`);
  }

  /** The menu's "Start a wire from …": the pins of the selected part (a pin, a pointer), else the one under the keyboard cursor. */
  wireStarts(): { label: string; run(): void }[] {
    const ed = this.ed;
    if (this.state.k !== 'idle') return [];
    let list = ownPorts(ed.doc, ed.defOf, ed.sel);
    if (!list.length && this.kcOn && this.kc) {
      const t = this.target(this.kc);
      if (t.end && !('wire' in t.end)) list = [{ end: t.end, pos: t.pos }];
    }
    return list.slice(0, 8).map((a) => ({ label: `Start a wire from ${endName(ed.doc, ed.defOf, a.end)}`, run: () => this.keyWire(a.end, a.pos) }));
  }

/** A new section with its top-left corner at p (the canvas menu's "Add a section here"), selected, its title being typed. */
  addSectionAt(p: Vec): void {
    const ed = this.ed;
    this.cancel();
    const r = addSection(ed.doc, snapPt(p), [20, 12]);
    if (r.id === undefined) return void ed.toast(r.reason, 'err');
    ed.edit(() => r.doc);
    ed.select({ sections: [r.id] });
    requestAnimationFrame(() => this.rename({ k: 'section', id: r.id, on: 'title' }));
  }

  /** A section fitted around the selection (its title being typed); the toolbar's Section with nothing selected adds one in the view's middle. */
  groupSel(): void {
    const ed = this.ed;
    if (!ed.selCount) {
      const v = ed.view.cam.vb;
      return this.addSectionAt([Math.round(v.x + v.w / 2 - 10), Math.round(v.y + v.h / 2 - 6)]);
    }
    const r = groupInSection(ed.doc, ed.sel, ed.defOf);
    if (r.id === undefined) return void ed.toast(r.reason, 'err');
    ed.edit(() => r.doc);
    ed.select({ sections: [r.id] });
    ed.announce('Grouped in a section: type its title');
    requestAnimationFrame(() => this.rename({ k: 'section', id: r.id, on: 'title' }));
  }

  del(): void {
    const ed = this.ed;
    if (!ed.selCount) return;
    ed.edit((doc) => deleteSel(doc, ed.sel));
    ed.select({});
  }

  copy(): void {
    const ed = this.ed;
    if (!ed.selCount) return;
    clipboard = copySel(ed.doc, ed.sel);
  }

  /** Paste at the cursor. */
  paste(): void {
    const ed = this.ed;
    if (!clipboard) return;
    const c = clipboard;
    const xs = [...c.parts.map((p) => p.at), ...c.pins.map((p) => p.at), ...c.labels.map((l) => l.at), ...(c.comments ?? []).map((q) => q.at), ...(c.sections ?? []).map((q) => q.at), ...c.wires.flatMap((w) => w.pts)];
    if (!xs.length) return;
    const o: Vec = [Math.min(...xs.map((q) => q[0])), Math.min(...xs.map((q) => q[1]))];
    const want = this.cursor ? snapPt(this.cursor) : [o[0] + 2, o[1] + 2] as Vec;
    const r = pasteClip(ed.doc, c, [want[0] - Math.round(o[0]), want[1] - Math.round(o[1])]);
    ed.edit(() => r.doc);
    ed.select(r.sel);
  }

  dup(): void {
    const ed = this.ed;
    if (!ed.selCount) return;
    const r = duplicate(ed.doc, ed.sel, [2, 2]);
    ed.edit(() => r.doc);
    ed.select(r.sel);
  }

  /**
   * Turn the selection a quarter clockwise (turns 3: anticlockwise), each object in place: parts about their middle,
   * pins and pointers face the next way round. Displays and I/O parts do not turn (face.ts canTurn).
   */
  rotate(turns: 1 | 3 = 1): void {
    const ed = this.ed;
    const sel = ed.sel;
    if (!ed.selCount) return;
    const parts = (sel.parts ?? []).filter((id) => { const p = ed.doc.parts.find((q) => q.id === id); return !!p && canTurn(p.ref, ed.defOf(p)); });
    const fixed = (sel.parts?.length ?? 0) - parts.length;
    if (fixed && !parts.length && !sel.pins?.length && !sel.labels?.length) {
      return void ed.toast(fixed === 1 ? 'Displays and I/O parts do not turn (they can mirror: F)' : `These ${fixed} parts do not turn (displays and I/O parts can mirror: F)`);
    }
    const turn = (f: Face): Face => orientExit(f, false, turns);
    ed.edit((doc0) => {
      let doc = rotateParts(doc0, parts, turns, ed.defOf);
      for (const id of sel.pins ?? []) {
        const p = doc.pins.find((q) => q.id === id);
        if (p) doc = setPin(doc, id, { face: turn(p.face ?? (p.dir === 'in' ? 'right' : 'left')) }, ed.defOf).doc;
      }
      for (const id of sel.labels ?? []) {
        const l = doc.labels.find((q) => q.id === id);
        if (l) doc = setLabel(doc, id, { face: turn(l.face ?? 'right') }, ed.defOf).doc;
      }
      return doc;
    });
    if (fixed) ed.toast(`${fixed} ${fixed === 1 ? 'part' : 'parts'} left as ${fixed === 1 ? 'it was' : 'they were'}: displays and I/O parts do not turn`);
  }

  /** Mirror the selection: parts flip, pins and pointers face the other way. */
  flip(): void {
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

/** `end` is where the draft started, and no corner was fixed yet. */
const atStart = (draft: WireDraft, end: EndRef) => !draft.pts.length && endKey(end) === endKey(draft.from);

/** The clipboard holds something to paste. */
export const canPaste = () => !!clipboard;

/**
 * The part or pin whose drawn name is under the pointer. Not a pointer's: its name fills its flag,
 * whose click jumps to the next pointer of that name (F2 or the menu renames it).
 */
function nameHit(t: EventTarget | null): Hit | null {
  const el = t as Element | null;
  if (!el?.closest) return null;
  const name = el.closest('.inst-name, .pin-name');
  if (!name) return null;
  const part = name.closest('[data-part]')?.getAttribute('data-part');
  if (part) return { k: 'part', id: part };
  const pin = name.closest('[data-pin-id]')?.getAttribute('data-pin-id');
  return pin ? { k: 'pin', id: pin } : null;
}

/** The object a port belongs to (a right-click on a port acts on its part, pin or pointer). */
function hitOwner(h: Extract<Hit, { k: 'port' }>): Hit {
  const e = h.end;
  return 'part' in e ? { k: 'part', id: e.part } : 'pin' in e ? { k: 'pin', id: e.pin } : 'label' in e ? { k: 'label', id: e.label } : { k: 'none' };
}

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
  if (h.k === 'comment') return { comments: [h.id] };
  if (h.k === 'section') return { sections: [h.id] };
  return {};
}

function toggle(sel: Sel, h: Hit): Sel {
  const key = h.k === 'part' ? 'parts' : h.k === 'pin' ? 'pins' : h.k === 'label' ? 'labels' : h.k === 'wire' ? 'wires' : h.k === 'comment' ? 'comments' : h.k === 'section' ? 'sections' : null;
  if (!key || !('id' in h)) return sel;
  const cur = sel[key] ?? [];
  return { ...sel, [key]: cur.includes(h.id) ? cur.filter((x) => x !== h.id) : [...cur, h.id] };
}

function union(a: Sel, b: Sel): Sel {
  const u = (x?: string[], y?: string[]) => [...new Set([...(x ?? []), ...(y ?? [])])];
  const r: Sel = { parts: u(a.parts, b.parts), pins: u(a.pins, b.pins), wires: u(a.wires, b.wires), labels: u(a.labels, b.labels) };
  const cs = u(a.comments, b.comments);
  if (cs.length) r.comments = cs;
  const ss = u(a.sections, b.sections);
  if (ss.length) r.sections = ss;
  return r;
}
