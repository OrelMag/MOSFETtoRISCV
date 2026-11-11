// The schematic: one component's internal netlist drawn as SVG, with live wire values.
// Rendering builds the DOM once; update() only touches classes and labels.

import { orientGeom, type Vec } from '../sim/geometry';
import { NmosSim } from '../sim/nmossim';
import { SwitchSim, VDD_VOLTS, weakLevel, weakTag } from '../sim/switchsim';
import { B0, B1, BX, BZ, type Bit, type Netlist, netlistOf } from '../sim/types';
import { describeBits, formatBits, pack, type Radix } from '../sim/values';
import { coreDrive, coreSwitching, isCoreState } from '../sim/core';
import { h, icon, s, tx } from '../ui/dom';
import { DoubleTap } from '../ui/doubletap';
import { reducedMotion } from '../ui/motion';
import { Camera, fitBox, offerReadable, readableBox, installPanZoom, underCover, type ViewBox } from './camera';
import { applyFlow, flowDash, flowKey, flowText, laneTails } from './flow';
import { FlowTokens, type Lane } from './flowtokens';
import type { ViewCtx } from './context';
import { hopPathData, overlaps, routeNetlist, splitterBars, tagGeom, tapLabels, textWidth, type PinGeom, type Rect, type RoutedNet, type TapLabel } from './route';
import { partnerLines } from './partners';
import { drawnNetlist } from './wirefirst';
import type { OverlayMarks } from './overlays';
import { applyLayout, canRedo, canUndo, checkDrawing, dragSegment, dropAside, dropCorners, dropLastEdit, editLayout, isTagged, layoutOf, nearestSegment, pastSlop, restoreAside, showsTags, undoLayout, type LayoutEdit } from './layout';
import { settings } from '../ui/settings';
import { drawnHue, netKey, setNetHue, spreadHues } from './nethue';
import { drawPinGlyph, drawSymbol, instNameAt, placePinValue } from './symbols';
import { cmosLod, cmosShown, paintCmos } from './cmosdraw';
import type { ViewFocus } from '../ui/viewlink';
import type { NetEnd } from './netfacts';
import type { ElsewhereHost, ExplainHost, MeasureHost } from './tracemenu';
import type { HueSite, MenuSite } from './circuitmenu';
import type { ComponentDef } from '../sim/types';
import { anchorPoint, closeMenu, closePicker, menuOpenFor, type MenuEntry, showMenu } from '../ui/menu';
import { installHold } from '../ui/holdpress';
import { isConstantDef } from '../sim/constant';
import { isGeneratedNetName, Legibility, nameEligible, nameRotated, type NameEl, type Seg, type TagEl } from './legible';
import type { CursorItem } from './kcursor';

/** A note's marker on a part of the level shown. */
export interface NotePin {
  inst: string;
  n: number;
  title: string;
  open(): void;
}

/** The first drag on a part with the layout locked says where the lock is; once a visit. */
let lockSaid = false;

export interface SchematicEvents {
  open(child: string): void;
  select(child: string | null): void;
  toggleInput(port: string): void;
  editInput(port: string, anchor: DOMRect): void;
  /** A click on a wire; return true to consume it (probe mode). */
  netClick?(net: number): boolean;
  /** The menu's Why this value? on a net. */
  why?(net: number): void;
  /** The menu's Inspect on a part, or (null) the level on screen. */
  inspect?(child: string | null): void;
  /** May the menu offer Inspect now (a level's look inside: its drawer has an HDL tab)? Absent: yes, if there is an inspect. */
  canInspect?(): boolean;
  /** The menu's Explain for a part or (null) the level on screen: what it is about, and how this surface opens things. */
  explain?(child: string | null): { def: ComponentDef; host: ExplainHost } | null;
  /** The menu's Measure: probes, timing and power for a net or a part of this level. */
  measure?(target: ViewFocus): MeasureHost;
  /** Up one level, for the menu's jump to a port of this level. */
  up?(): void;
  /** The menu's Take it elsewhere, for a part, a wire or (null) the level on screen (null: nothing goes). */
  elsewhere?(target: ViewFocus | null): ElsewhereHost | null;
  /** The probe on a net of the current view, if any. */
  probeOf?(net: number): { color: number; label: string } | null;
  /** The learner moved a part or a wire, or unravelled a pointer (the level was redrawn). */
  layoutChanged?(): void;
  /** A "find it" step (widgets/findfault.ts): its rows for a wire, given the wire's flat nets and name, first in its menu. */
  accuse?(flat: readonly number[], name: string): MenuEntry[];
}

type MenuItem = NonNullable<MenuEntry>;

/** A level routed faster than this (ms) re-routes its wires live while a part is dragged. */
const LIVE_ROUTE_MS = 25;

interface WireEls {
  net: RoutedNet;
  paths: SVGPathElement[];
  tags: SVGGElement[];
  dots: SVGCircleElement[];
  /** Bit-range labels where this net leaves a splitter tap or enters a merger tap. */
  taps: SVGGElement[];
  /** Colour per net: the hue its elements carry (nethue.ts), and its spread hue (what a learner's colour stands in for). */
  hue?: number;
  spread: number;
  /** Value class on screen, the one a front in flight is drawing, and that front. */
  shown?: string;
  target?: string;
  flow?: Animation[];
  flowEls?: SVGPathElement[];
  /** Flowing bits: pellets on a 1-bit wire (one overlay per path, made on first use), what they show; a bus's lanes for its riding value. */
  ants?: SVGPathElement[];
  antsKey?: string;
  lanes?: Lane[];
  /** The wide invisible stroke a pointer finds the net by (its tooltip under an overlay). */
  hit?: SVGPathElement;
  label?: SVGGElement;
  labelText?: SVGTextElement;
  labelBg?: SVGRectElement;
  /** Switch level with charge levels: the voltage tag of a capacitive or half-charged net (made on first use). */
  level?: { g: SVGGElement; t: SVGTextElement; bg: SVGRectElement; at: Vec };
}

interface PinEls {
  pin: PinGeom;
  g: SVGGElement;
  name: SVGTextElement;
  value?: SVGTextElement;
  valueBg?: SVGRectElement;
  /** The wire inside that ends on this pin. */
  wire?: WireEls;
}

export function bitClass(b: Bit | undefined): string {
  return b === B1 ? 'v1' : b === B0 ? 'v0' : b === BZ ? 'vz' : 'vx';
}

export function busClass(bits: Bit[]): string {
  if (bits.some((b) => b === BX)) return 'bus vx';
  if (bits.every((b) => b === BZ)) return 'bus vz';
  return bits.some((b) => b === B1) ? 'bus bus1' : 'bus bus0';
}

let menuFetched = false;
let pickFetched = false;

/** The menu's rows (view/circuitmenu.ts) fetched once the page is loaded and idle, so the first right-click
 *  does not wait on the network. Data saver and a 2G link skip it (they pay on the click, as before); a page
 *  busy with a simulation simply never goes idle until it is not. */
function prefetchMenu(pick: boolean): void {
  if (menuFetched && (pickFetched || !pick)) return;
  const net = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (net?.saveData || /2g/.test(net?.effectiveType ?? '') || typeof requestIdleCallback !== 'function') return;
  const fetch = (): void => {
    requestIdleCallback(() => {
      if (!menuFetched) { menuFetched = true; void import('./circuitmenu').catch(() => { menuFetched = false; }); }
      if (pick && !pickFetched) { pickFetched = true; void import('../ui/menupick').catch(() => { pickFetched = false; }); }
    });
  };
  if (document.readyState === 'complete') fetch();
  else addEventListener('load', fetch, { once: true });
}

export class SchematicView {
  readonly el: SVGSVGElement;
  private ctx: ViewCtx | null = null;
  private wires: WireEls[] = [];
  private pins: PinEls[] = [];
  private insts = new Map<string, SVGGElement>();
  /** The learner's notes pinned to parts of this level (ui/notes.ts): a numbered marker on each part, a click opens the note. */
  private notePins: NotePin[] = [];
  private bbox = { x: 0, y: 0, w: 10, h: 10 };
  private cam: Camera;
  /** Small text hidden and block names kept at a readable size (view/legible.ts): a view rule only. */
  private legible: Legibility;
  /** Each block's fixed-size name, in the top layer: it mirrors the block's highlight and ghost state (the layer is not inside the block). */
  private nameOf = new Map<string, SVGTextElement>();
  private radixOverride = new Map<number, Radix>();
  private interactive = false;
  private selected: string | null = null;
  private selectedNet = -1;
  /** Nets faded by a focus highlight. */
  private faded = new Set<number>();
  /** Extra classes per net (instruction fields); marked nets never fade. */
  private netMarks = new Map<number, string>();
  private lastHl: { names: string[]; focus: boolean } = { names: [], focus: false };
  /** The slack heatmap on this level (instance → band and tooltip), kept across a relayout, dropped on another level. */
  /** The overlay drawn (view/overlays.ts): marked parts and wires in their band, the rest faded. */
  private ov: OverlayMarks | null = null;
  private probeG: SVGGElement | null = null;
  private flowG: SVGGElement | null = null;
  private labelG: SVGGElement | null = null;
  private partnerG: SVGGElement | null = null;
  private tokens: FlowTokens | null = null;
  radix: Radix = 'hex';
  /** When > 0, value changes travel along the wires as fronts lasting this many ms. */
  flowMs = 0;
  /** Screen rectangles (from the canvas's corner) the stage's panels cover; fit() keeps the circuit clear of them. */
  cover: Rect[] = [];
  /** A small badge over the canvas's corner (the stage's level label), as a rectangle in the same px: the fit leaves it
   *  clear only when the circuit, fitted without it, would reach under it (a corner nothing draws in costs no room). */
  badge: (() => Rect | null) | null = null;
  /**
   * The learner's layout (view/layout.ts): true, parts and wires can be dragged and pointers unravelled (the stage);
   * 'wires', only wires and pointers, the parts stay put (the sandbox's look inside, the codex); false, as authored.
   */
  arrange: boolean | 'wires' = false;
  /** Show the author's drawing whatever the learner arranged (the stage's Original peek): nothing moves while it is on. */
  original = false;
  /** The level's netlist as authored (before the learner's layout). */
  private base: Netlist | null = null;
  /** A part drag just ended: the click it ends with does not select. */
  private dragged = false;
  /** A double tap opens a part like a double-click (iOS Safari may send no dblclick for it). */
  private taps = new DoubleTap();
  /** Parts picked to move together; the parts being dragged; their places while a live drag goes on. */
  private group = new Set<string>();
  private dragging = new Set<string>();
  private preview: Record<string, Vec> | null = null;
  /** A wire is being dragged: no hover tips meanwhile. */
  private reshaping = false;
  /** Where each part is drawn now, and its box (grid units); how long the last routing took. */
  private atOf = new Map<string, Vec>();
  private boxes = new Map<string, Rect>();
  /** The keyboard part cursor (Stage's arrows): the item under it and its ring, cleared when a level is shown. */
  private kcur: CursorItem | null = null;
  private kring: SVGRectElement | null = null;
  /** Instances a block name may cover (legible.ts): constants (tie cells too) and pure wiring (splitters, mergers, alias boxes). */
  private quiet = new Set<string>();
  /** Gates drawn with their insides (working gates): painted from their input ports in update(). */
  private cmos: { name: string; el: Element; ins: string[] }[] = [];
  /** Ferrite cores drawn at this level (painted from their leaf state and the current through them). */
  private cores: { name: string; el: Element }[] = [];
  private routeMs = 0;
  private tooltip: HTMLDivElement;

  constructor(private host: HTMLElement, private events: SchematicEvents) {
    this.el = s('svg', { class: 'schematic', role: 'img' });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'wire-tip';
    host.append(this.el, this.tooltip);
    this.cam = new Camera(this.el, host);
    this.legible = new Legibility(this.el);
    this.cam.listeners.add(() => {
      this.legible.view(this.cam.pxPerUnit());
      if (cmosLod(this.el, this.cam.pxPerUnit())) this.update();
    });
    installPanZoom(this.el, this.cam, {
      // shift-drag on the canvas picks parts (bandSelect) instead of panning
      canStart: (e) => !(this.arrange === true && e.shiftKey) && !(e.target as Element).closest('.inst, .pin.clickable, .bus-label') && this.grabbedNet(e) < 0,
      onTap: (target) => {
        const n = target.closest('[data-net]');
        if (n) this.clickNet(Number(n.getAttribute('data-net')), target);
        else {
          this.select(null);
          this.events.select(null);
          this.selectNet(-1);
          this.setGroup([]);
        }
      },
      onHover: (e) => this.hoverTip(e),
      onLeave: () => (this.tooltip.style.opacity = '0'),
    });
    this.el.addEventListener('contextmenu', (e) => this.contextMenu(e));
    // A held finger is the right-click (the browser's own contextmenu for it is not reliable): the same menu.
    this.holdQuiet = installHold(this.el, {
      onHold: (x, y, e) => {
        if (this.traceMenu(e.target as Element, x, y)) return;
        const items = this.menuItems(e.target as Element);
        if (!items.length) return false;
        this.openMenu(items, x, y);
      },
    }).quiet;
    this.el.addEventListener('pointerdown', (e) => {
      if (this.arrange === true && e.shiftKey && e.button === 0 && !(e.target as Element).closest('.inst, .pin, .bus-label')) this.bandSelect(e);
      const net = this.grabbedNet(e);
      if (net >= 0) this.dragWire(e, net);
    });
  }

  /** Drop the drawing and its context (which holds the simulation), until the next show(). */
  clear(): void {
    this.closeMenu();
    this.ctx = null;
    this.base = null;
    this.selected = null;
    this.selectedNet = -1;
    this.el.replaceChildren();
    this.wires = [];
    this.pins = [];
    this.insts.clear();
    this.cmos = [];
    this.cores = [];
  }

  /** Markers for the notes pinned to this level's parts (replaces the previous ones; a name not on this level is skipped). */
  setNotePins(pins: NotePin[]): void {
    this.notePins = pins;
    for (const [name, g] of this.insts) this.paintNotePins(name, g);
  }

  private paintNotePins(name: string, g: SVGGElement): void {
    g.querySelectorAll(':scope > .note-pin').forEach((e) => e.remove());
    const mine = this.notePins.filter((p) => p.inst === name);
    mine.forEach((p, k) => {
      const m = s('g', { class: 'note-pin', transform: `translate(${-0.9 + k * 1.5},${-1.1})` });
      m.append(s('title', {}, p.title), s('circle', { cx: 0.7, cy: 0.7, r: 0.75 }), s('text', { x: 0.7, y: 0.72 }, String(p.n)));
      m.addEventListener('pointerdown', (e) => e.stopPropagation());
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        p.open();
      });
      g.append(m);
    });
  }

  /** Draw the inside of ctx. `interactive` makes the root input pins clickable. */
  show(ctx: ViewCtx, interactive: boolean, keepView = false): void {
    this.ctx = ctx;
    if (this.trace) prefetchMenu(this.pickable);
    this.interactive = interactive;
    this.radixOverride.clear();
    this.selected = null;
    this.selectedNet = -1;
    this.faded.clear();
    this.netMarks = new Map();
    this.closeMenu();
    if (!keepView) { this.group = new Set(); this.ov = null; this.original = false; }
    const authored = netlistOf(ctx.def);
    const base = this.base = authored ? drawnNetlist(ctx.def, authored) : null;
    this.el.replaceChildren();
    this.wires = [];
    this.pins = [];
    this.insts.clear();
    this.cmos = [];
    this.cores = [];
    this.atOf.clear();
    this.boxes.clear();
    this.kcur = null;
    this.kring = null;
    this.quiet.clear();
    if (!base) return;
    // an arrangement made on an earlier drawing of this level is set aside (asideOf), not laid over this one: keyed on the
    // author's netlist, so a change to the wires-first rules (wirefirst.ts) is not taken for a redraw
    if (this.arrange && !this.preview && authored) checkDrawing(ctx.def.id, authored);
    let lay = this.arrange && !this.original ? layoutOf(ctx.def.id) : undefined;
    if (this.arrange && this.preview) {
      // a live part drag: drawn as it will be on drop, without the corners it leaves behind
      const p: LayoutEdit = lay = { wired: [], tagged: [], ...lay, at: { ...lay?.at, ...this.preview } };
      dropCorners(p, base, Object.keys(this.preview));
    }
    const nl = !this.arrange ? base : applyLayout(base, lay);
    this.el.classList.toggle('arrange', this.arrange === true);
    const t0 = performance.now();
    const { nets, pins } = routeNetlist(ctx.def, nl);
    this.routeMs = performance.now() - t0;
    const pathData = hopPathData(nets, splitterBars(nl));
    const tapsOf = new Map<number, TapLabel[]>();
    for (const t of tapLabels(nl)) tapsOf.set(t.net, [...tapsOf.get(t.net) ?? [], t]);

    const defs = s('defs');
    defs.innerHTML = `<pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
      <circle cx="0" cy="0" r="0.06" class="grid-dot"/><path d="M1,0 H0 V1" class="grid-line"/></pattern>
      <pattern id="grid5" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M5,0 H0 V5" class="grid-line major"/></pattern>`;
    this.el.append(defs);
    const gridRect = s('rect', { class: 'grid-bg', x: -500, y: -500, width: 1000, height: 1000, fill: 'url(#grid)' });
    const grid5Rect = s('rect', { class: 'grid-bg', x: -500, y: -500, width: 1000, height: 1000, fill: 'url(#grid5)' });
    const wiresG = s('g', { class: 'wires' });
    this.flowG = s('g', { class: 'wire-flows' });
    const tokG = s('g', { class: 'flow-tokens-layer' });
    this.tokens = new FlowTokens(tokG);
    const hitG = s('g', { class: 'wire-hits' });
    const instG = s('g', { class: 'insts' });
    const pinG = s('g', { class: 'pins' });
    const labelG = s('g', { class: 'labels' });
    this.labelG = labelG;
    this.probeG = s('g', { class: 'probes' });
    // the fixed-size block names (legible.ts) have a layer of their own, last: nothing is painted over them
    const nameG = s('g', { class: 'lg-names', 'aria-hidden': 'true' });
    this.nameOf.clear();
    this.partnerG = s('g', { class: 'partner-lines' });
    this.hovered = -1;
    this.el.append(gridRect, grid5Rect, wiresG, this.flowG, tokG, hitG, instG, pinG, labelG, this.partnerG, this.probeG, nameG);

    // Bounding box of everything drawn.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };

    // Wires
    // keyed by the authored net: a wire drawn as pointers is named for its driver, but keeps its colour
    const tagEls: TagEl[] = [];
    const hues = spreadHues(nets.map((n) => ({ key: netKey(base.nets[n.index]), polys: n.paths })));
    for (const [ni, net] of nets.entries()) {
      const cls = net.width > 1 ? 'wire bus' : 'wire';
      const w: WireEls = { net, paths: [], dots: [], tags: [], taps: [], spread: hues[ni] };
      const name = nl.nets[net.index].name ?? `n${net.index}`;
      // a colour the learner picked (applyLayout puts it on the net) wins over the spread hue
      const hue = drawnHue(hues[ni], nl.nets[net.index].hue);
      w.hue = hue;
      for (const t of net.tags) {
        const { tip, stub: sp, rect: { x: rx, y: ry, w: tw, h: th } } = tagGeom(t, name);
        const g = s('g', { class: 'net-tag', 'data-net': net.index });
        setNetHue(g, hue);
        // A hand-placed tag's stub is one of the net's paths (drawn below with the wires).
        const stub = s('path', { d: sp.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' '), class: cls });
        // The dot stands in for the box when the name is too small to read (styles/app.css lg-h-tag).
        g.append(stub, s('rect', { x: rx, y: ry, width: tw, height: th, rx: 0.35 }), s('circle', { class: 'tag-end', cx: tip[0], cy: tip[1], r: 0.5 }),
          s('text', { x: rx + tw / 2, y: ry + th / 2 + 0.3, 'text-anchor': 'middle' }, name));
        w.tags.push(g);
        tagEls.push({ g, tip, rect: { x: rx, y: ry, w: tw, h: th }, named: nl.nets[net.index].name !== undefined && !isGeneratedNetName(name) });
        labelG.append(g);
        grow(rx, ry);
        grow(rx + tw, ry + th);
      }
      net.paths.forEach((p, pi) => {
        p.forEach(([x, y]) => grow(x, y));
        const path = s('path', { d: pathData[net.index][pi], class: cls, 'data-net': net.index });
        setNetHue(path, hue);
        w.paths.push(path);
        wiresG.append(path);
      });
      // One wide invisible stroke per net makes thin wires easy to point at and click.
      if (net.paths.length) {
        const d = net.paths.map((p) => 'M' + p.map(([x, y]) => `${x},${y}`).join(' L')).join(' ');
        w.hit = s('path', { d, class: 'wire-hit', 'data-net': net.index });
        hitG.append(w.hit);
      }
      for (const t of tapsOf.get(net.index) ?? []) {
        const g = s('g', { class: 'tap-label', 'data-net': net.index, 'data-ts': String(Math.min(8, Math.max(3, Math.round(t.size * 10)))) });
        setNetHue(g, hue);
        const { x, y, w: tw, h: th } = t.rect;
        g.append(s('rect', { x, y, width: tw, height: th, rx: th / 2 }),
          s('text', { x: x + tw / 2, y: y + th * 0.76, 'text-anchor': 'middle', style: `font-size:${t.size}px` }, t.text));
        w.taps.push(g);
        labelG.append(g);
      }
      for (const [x, y] of net.dots) {
        const c = s('circle', { cx: x, cy: y, r: net.width > 1 ? 0.32 : 0.24, class: 'dot' });
        setNetHue(c, hue);
        w.dots.push(c);
        wiresG.append(c);
      }
      const touchesPin = nl.nets[net.index].ends.some((e) => !e.includes('.'));
      if (net.label && !touchesPin && nl.nets[net.index].showValue !== false) {
        const g = s('g', { class: 'bus-label', 'data-net': net.index });
        setNetHue(g, hue);
        const bg = s('rect', { rx: 0.45, height: 1.3, y: net.label[1] - 0.65 - 0.9 });
        const t = s('text', { x: net.label[0], y: net.label[1] - 0.9 + 0.38, 'text-anchor': 'middle' });
        g.append(bg, t);
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          const order: Radix[] = ['hex', 'bin', 'dec', 'sdec'];
          const cur = this.radixOverride.get(net.index) ?? this.radix;
          this.radixOverride.set(net.index, order[(order.indexOf(cur) + 1) % order.length]);
          this.update();
        });
        labelG.append(g);
        w.label = g;
        w.labelText = t;
        w.labelBg = bg;
      }
      this.wires.push(w);
      this.paintOvWire(w);
    }

    // Instances
    const names: NameEl[] = [];
    for (const inst of nl.instances) {
      const at: Vec = inst.at ?? [0, 0];
      const geo = orientGeom(inst.def, inst.flip, inst.rot);
      grow(at[0], at[1]);
      grow(at[0] + geo.w, at[1] + geo.h);
      const openable = ctx.canOpen(inst.name);
      const g = s('g', {
        class: `inst${openable ? ' openable' : ''}${inst.def.prim === 'alias' ? ' plumbing' : ''}${this.group.has(inst.name) ? ' grouped' : ''}${this.dragging.has(inst.name) ? ' dragging' : ''}`,
        transform: `translate(${at[0]},${at[1]})`, 'data-inst': inst.name,
      });
      this.atOf.set(inst.name, at);
      this.boxes.set(inst.name, { x: at[0], y: at[1], w: geo.w, h: geo.h });
      if (isConstantDef(inst.def) || inst.def.prim === 'alias') this.quiet.add(inst.name);
      g.append(s('rect', { class: 'hit', x: -0.4, y: -0.4, width: geo.w + 0.8, height: geo.h + 0.8, rx: 0.6 }));
      g.append(drawSymbol(inst.def, inst.flip, inst.rot));
      const cm = g.querySelector('.cmos');
      if (cm) this.cmos.push({ name: inst.name, el: cm, ins: inst.def.ports.filter((p) => p.dir !== 'out').map((p) => p.name) });
      if (inst.def.prim === 'core') this.cores.push({ name: inst.name, el: g });
      const nameAt = instNameAt(inst.def, inst.flip, inst.rot);
      if (nameAt) g.append(s('text', { class: 'inst-name', x: nameAt.x, y: nameAt.y, 'text-anchor': nameAt.anchor }, inst.label ?? inst.name));
      // A fixed-size copy of the block's label for when its own is too small to read (legible.ts); decoration, so
      // hidden from assistive tech, never hit, and left out of exported images.
      const own = g.querySelector('.sym-label');
      // a box whose symbol is one glyph (a comparator's "=") is named by its instance label ("wa = ra1") when it has one
      // a constant's value is planned as a name of its own kind (legible.ts isConstantBox), and always titled with its name and value
      const isConst = !!own && isConstantDef(inst.def) && (own.textContent?.trim().length ?? 0) >= 2;
      // (also a one-character constant, which is not drawn larger: the title is for all of them)
      if (own && isConstantDef(inst.def)) g.append(s('title', {}, `${inst.label ?? inst.name} = ${own.textContent!.trim()}`));
      const nm = isConst ? own!.textContent!.trim() : nameEligible(own?.textContent, geo.w, geo.h) ? own!.textContent!.trim() : own && own.textContent!.trim().length === 1 && inst.label && nameEligible(inst.label, geo.w, geo.h) ? inst.label.trim() : null;
      if (nm) {
        const rot = nameRotated(geo.w, geo.h), cx = geo.w / 2, cy = geo.h / 2;
        const ax = at[0] + cx, ay = at[1] + cy;
        const t = s('text', { class: 'lg-name', x: ax, y: ay, 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: rot ? `rotate(-90 ${ax} ${ay})` : null }, nm);
        g.classList.add('lg-named');
        // the full name whatever is drawn: hover, and the block's accessible name
        if (!isConst) g.append(s('title', {}, nm));
        nameG.append(t);
        this.nameOf.set(inst.name, t);
        names.push({ t, box: { cx: at[0] + cx, cy: at[1] + cy, w: geo.w, h: geo.h, chars: nm.length, rot, text: nm, ports: Object.keys(geo.ports).length, ...(isConst ? { const: true } : {}) } });
      }
      if (openable) {
        const badge = s('g', { class: 'open-badge', transform: `translate(${geo.w - 0.2},${-0.9})` });
        badge.append(s('circle', { r: 0.62, cx: 0.5, cy: 0.5 }));
        const ic = icon('zoomin', 1);
        ic.setAttribute('x', '0');
        ic.setAttribute('y', '0');
        badge.append(ic);
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          this.events.open(inst.name);
        });
        g.append(badge);
      }
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.dragged) return;
        if (this.arrange === true && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          this.toggleGroup(inst.name);
          return;
        }
        this.setGroup([]);
        this.select(inst.name);
        this.events.select(inst.name);
      });
      g.addEventListener('pointerdown', (e) => this.pressInst(e, inst.name));
      g.addEventListener('pointerup', (e) => {
        if (this.taps.upEvent(e, inst.name) && openable && !this.dragged) this.events.open(inst.name);
      });
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (openable && this.taps.dblclick(e.timeStamp)) this.events.open(inst.name);
      });
      this.insts.set(inst.name, g);
      instG.append(g);
      this.paintOv(inst.name, g);
      this.paintNotePins(inst.name, g);
    }

    // The component's own pins
    for (const pin of pins.values()) {
      const clickable = pin.dir !== 'out' && interactive;
      const { g, name, value, valueBg, bounds: b } = drawPinGlyph(pin, clickable);
      const els: PinEls = { pin, g, name, value, valueBg };
      grow(b.x, b.y);
      grow(b.x + b.w, b.y + b.h);
      if (clickable) {
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (pin.width === 1) this.events.toggleInput(pin.name);
          else this.events.editInput(pin.name, (g as unknown as Element).getBoundingClientRect());
        });
      }
      els.wire = this.wires.find((w) => nl.nets[w.net.index].ends.includes(pin.name));
      this.pins.push(els);
      pinG.append(g);
    }

    const m = 3;
    this.bbox = { x: x0 - m, y: y0 - m - 1, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m + 1 };
    this.legible.setNames(names);
    this.legible.setWires(nets.flatMap((n) => n.paths.flatMap((p) => p.slice(1).map((q, i): Seg => [p[i][0], p[i][1], q[0], q[1]]))));
    this.legible.setTags(tagEls, [...this.boxes.values()], [...this.boxes].filter(([n]) => !this.quiet.has(n)).map(([, b]) => b));
    if (!keepView) this.fit();
    else this.cam.apply();
    this.drawProbes();
    this.update();
  }

  /** Refresh every value on screen from the simulation. */
  update(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.sync();
    const flow = this.flowMs > 0 && !reducedMotion();
    const lvSim = ctx.sim instanceof SwitchSim && ctx.sim.hasLevels ? ctx.sim : null;
    // a crowbar: current from a 1 source to a 0 source through this net (its own look, not just X)
    const shorts = ctx.sim instanceof SwitchSim && ctx.sim.hasShort ? ctx.sim.shorted : null;
    // weak levels (an NMOS passing a 1, a PMOS a 0): between the net's colours, tagged 'H · 0.80 V'
    const wkSim = ctx.sim instanceof SwitchSim && ctx.sim.hasWeak ? ctx.sim : null;
    for (const w of this.wires) {
      const bits = ctx.netBits(w.net.index);
      let vcls = w.net.width > 1 ? busClass(bits) : bitClass(bits[0]);
      let tag = NaN, tagText = '';
      if (lvSim && w.net.width === 1) {
        // A charge level between the rails (a bit line at VDD/2, after sharing): its own colour and a voltage tag.
        const net = ctx.node.nets?.[w.net.index]?.[0];
        const l = net === undefined ? NaN : lvSim.level(net);
        const mid = Number.isFinite(l) && bits[0] === BX;
        if (mid) {
          vcls = 'vl';
          for (const p of w.paths) p.style.setProperty('--lv', l.toFixed(3));
        }
        tag = mid || (net !== undefined && lvSim.design.caps.has(net)) ? l : NaN;
      }
      const wk = wkSim && w.net.width === 1 ? wkSim.weakOf(ctx.node.nets?.[w.net.index]?.[0] ?? -1) : 0;
      if (wk) {
        vcls = 'vl weak';
        tag = weakLevel(wk);
        tagText = weakTag(wk);
        for (const p of w.paths) p.style.setProperty('--lv', tag.toFixed(3));
      }
      if (lvSim || wk || w.level) this.paintLevel(w, tag, tagText);
      if (shorts && ctx.node.nets?.[w.net.index]?.some((n) => shorts[n])) vcls += ' short';
      if (vcls !== w.shown) {
        if (flow && w.shown !== undefined && w.paths.length) this.flowWire(w, vcls);
        else this.paintWire(w, vcls);
      }
      if (!w.flow) this.paintFlow(w, bits);
      if (w.labelText && w.labelBg && w.net.label) {
        const txt = formatBits(bits, this.radixOverride.get(w.net.index) ?? this.radix);
        w.labelText.textContent = txt;
        const tw = textWidth(txt, 0.95);
        w.labelBg.setAttribute('x', String(w.net.label[0] - tw / 2));
        w.labelBg.setAttribute('width', String(tw));
        // Too wide for its segment (a 64-bit value on a short hop): it would cover the ports at
        // either end. The value is still in the hover tooltip, and a narrower radix may fit.
        w.label!.setAttribute('display', tw > w.net.labelRoom - 0.4 ? 'none' : 'inline');
        // While its value rides the wire (flowing bits), the fixed label steps aside.
        w.label!.setAttribute('class', `bus-label ${busClass(bits)}${flowText(bits, 'hex') ? ' riding' : ''}${this.marks(w.net.index)}`);
      }
    }
    this.updatePins();
    // Working gates: each drawn inside from its own input bits.
    // (only while shown at this scale: cmosLod repaints when it appears)
    if (this.cmos.length && cmosShown(this.el)) for (const c of this.cmos) paintCmos(c.el, c.ins.map((p) => ctx.childPortBits(c.name, p)[0]));
    // Transistors: show which ones conduct.
    if (ctx.sim instanceof SwitchSim || ctx.sim instanceof NmosSim) {
      for (const [name, g] of this.insts) {
        const li = ctx.childLeaf(name);
        if (li === undefined) continue;
        const k = ctx.sim.design.leaves[li].kind;
        if (k !== 'nmos' && k !== 'pmos' && k !== 'relay' && k !== 'triode' && k !== 'diode') continue;
        // a relay: conducting while operated (its make contacts closed), maybe while unknown; a tube while its grid
        // lets current through (a diode while current flows)
        const c = ctx.sim.conducting[li];
        g.classList.toggle('conducting', c === 1);
        g.classList.toggle('maybe', c === 2);
        // partly on (its gate at a weak level): static current through it
        g.classList.toggle('leaky', ctx.sim instanceof SwitchSim && ctx.sim.leaky(li));
        if (k === 'relay' && ctx.sim instanceof SwitchSim) g.classList.toggle('energized', ctx.sim.relayEnergized(li) === 1);
      }
    }
    // Ferrite cores: the ring shows its bit; its wires the current through it now (a half, or a full select where two
    // halves meet); the sense wire the pulse of a core that is switching
    if (this.cores.length) {
      const sim = ctx.sim as { leafState?: (li: number) => unknown };
      for (const c of this.cores) {
        const li = ctx.childLeaf(c.name);
        const st = li === undefined ? undefined : sim.leafState?.(li);
        const b = isCoreState(st) ? st.b : -1;
        const bits = (p: string) => pack(ctx.childPortBits(c.name, p));
        const { lo, hi } = coreDrive(bits('x'), bits('y'), bits('inh'));
        const amp = lo === hi ? Math.abs(lo) : -1;
        const cl = c.el.classList;
        cl.toggle('core-1', b === 1);
        cl.toggle('core-x', b < 0);
        cl.toggle('core-half', amp === 1);
        cl.toggle('core-full', amp >= 2);
        cl.toggle('core-pulse', coreSwitching(b, lo, hi) === 1);
      }
    }
  }

  /** Output pins wait for the front on their wire to arrive. */
  private updatePins(): void {
    const ctx = this.ctx!;
    for (const p of this.pins) {
      if (p.pin.dir === 'out' && p.wire?.flow) continue;
      const bits = ctx.portBits(p.pin.name);
      const base = `pin ${p.pin.dir !== 'out' ? 'pin-in' : 'pin-out'}${p.pin.dir !== 'out' && this.interactive ? ' clickable' : ''}`;
      if (p.pin.width === 1) {
        p.g.setAttribute('class', `${base} ${bitClass(bits[0])}`);
      } else {
        p.g.setAttribute('class', `${base} ${busClass(bits)}`);
        placePinValue(p.pin, p, formatBits(bits, this.radix));
        const stub = p.g.querySelector('.pin-stub');
        stub?.setAttribute('class', `wire ${busClass(bits)} pin-stub`);
      }
    }
  }

  /** Probe flags: a coloured flag on every probed wire of this view (same flat nets). */
  drawProbes(): void {
    const g = this.probeG;
    if (!g) return;
    g.replaceChildren();
    for (const w of this.wires) {
      const p = this.events.probeOf?.(w.net.index);
      if (!p) continue;
      // Pin the flag to the middle of the net's longest segment.
      let best: Vec | null = null, len = -1;
      for (const path of w.net.paths) {
        for (let i = 1; i < path.length; i++) {
          const [a, b] = [path[i - 1], path[i]];
          const l = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
          if (l > len) { len = l; best = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
        }
      }
      if (!best) continue;
      const tw = textWidth(p.label, 0.78) + 0.7;
      const [x, y] = best;
      // data-net: a click on the flag acts as a click on its wire (in probe mode: remove the probe).
      const f = s('g', { class: `probe-flag p${p.color}`, transform: `translate(${x},${y})`, 'data-net': String(w.net.index) });
      f.append(s('title', null, `${p.label}: click to remove the probe`),
        s('circle', { r: 0.42, class: 'probe-tip' }),
        s('path', { d: 'M0,0 L0.9,-1.6', class: 'probe-pole' }),
        s('rect', { x: 0.9, y: -2.65, width: tw, height: 1.2, rx: 0.3 }),
        s('text', { x: 0.9 + tw / 2, y: -1.8, 'text-anchor': 'middle' }, p.label));
      g.append(f);
    }
  }

  /** Selection / hover classes a net's elements keep across repaints. */
  private marks(idx: number): string {
    const mark = this.netMarks.get(idx);
    return `${idx === this.selectedNet ? ' net-sel' : ''}${idx === this.hovered ? ' net-hover' : ''}${this.base?.nets[idx]?.quiet ? ' quiet' : ''}${this.faded.has(idx) ? ' faded' : ''}${mark ? ` ${mark}` : ''}`;
  }

  /** Colour nets by role (net index → classes, e.g. `fld fld-rd`); replaces the previous marks. */
  markNets(marks: Map<number, string>): void {
    const same = marks.size === this.netMarks.size && [...marks].every(([k, v]) => this.netMarks.get(k) === v);
    if (same) return;
    this.netMarks = marks;
    for (const w of this.wires) if (w.shown !== undefined && !w.flow) this.paintWire(w, w.shown);
    this.highlight(this.lastHl.names, this.lastHl.focus);
  }

  /** Give every element of a wire the value class vcls (finishing any front in flight). */
  /** A net's voltage tag (NaN hides it), at the middle of its longest segment. */
  private paintLevel(w: WireEls, l: number, text = ''): void {
    if (!Number.isFinite(l)) {
      w.level?.g.setAttribute('display', 'none');
      return;
    }
    if (!w.level) {
      let best: Vec = [0, 0], len = -1;
      for (const p of w.net.paths) for (let i = 1; i < p.length; i++) {
        const d = Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1]) + (p[i][1] === p[i - 1][1] ? 0.5 : 0);
        if (d > len) { len = d; best = [(p[i][0] + p[i - 1][0]) / 2, (p[i][1] + p[i - 1][1]) / 2]; }
      }
      const g = s('g', { class: 'level-tag', 'data-net': w.net.index });
      const bg = s('rect', { rx: 0.4, height: 1.2, y: best[1] - 1.9 });
      const t = s('text', { x: best[0], y: best[1] - 1.0, 'text-anchor': 'middle' });
      g.append(bg, t);
      this.labelG?.append(g);
      w.level = { g, t, bg, at: best };
    }
    const txt = text || `${(l * VDD_VOLTS).toFixed(2)} V`;
    w.level.t.textContent = txt;
    const tw = textWidth(txt, 0.8);
    w.level.bg.setAttribute('x', String(w.level.at[0] - tw / 2));
    w.level.bg.setAttribute('width', String(tw));
    w.level.g.removeAttribute('display');
  }

  private paintWire(w: WireEls, vcls: string): void {
    w.flow?.forEach((a) => a.cancel());
    w.flow = undefined;
    w.flowEls?.forEach((e) => e.remove());
    w.flowEls = undefined;
    w.shown = vcls;
    const m = this.marks(w.net.index);
    const cls = `wire ${vcls}${m}`;
    for (const p of w.paths) p.setAttribute('class', cls);
    for (const t of w.tags) {
      t.setAttribute('class', `net-tag ${vcls}${m}`);
      t.firstElementChild!.setAttribute('class', cls);
    }
    for (const d of w.dots) d.setAttribute('class', `dot ${vcls}${m}`);
    for (const t of w.taps) t.setAttribute('class', `tap-label ${vcls}${m}`);
  }

  /** Bits flowing from the driver along every path of the net (null: none); a bus carries its value. */
  private paintFlow(w: WireEls, bits: Bit[] | null): void {
    if (w.net.width > 1) {
      const text = bits && flowText(bits, this.radixOverride.get(w.net.index) ?? this.radix);
      this.tokens?.set(w.net.index, text ? (w.lanes ??= laneTails(w.net.paths)) : null, text, w.hue);
      return;
    }
    const f = bits && flowDash(bits);
    const key = flowKey(f, 0, 0, false);
    if (key === (w.antsKey ?? '')) return;
    w.antsKey = key;
    if (f && !w.ants) {
      const cls = `wire-flow${this.faded.has(w.net.index) ? ' faded' : ''}`;
      w.ants = w.paths.map((p) => s('path', { d: p.getAttribute('d')!, class: cls }));
      for (const a of w.ants) setNetHue(a, w.hue);
      this.flowG?.append(...w.ants);
    }
    for (const a of w.ants ?? []) applyFlow(a, f);
  }

  /**
   * Draw the new value as a front travelling from the driver along every branch, over
   * flowMs (one gate delay of the animation). The wire keeps its old colour underneath
   * until the front arrives; tags, dots and tap labels switch when it does.
   */
  private flowWire(w: WireEls, vcls: string): void {
    if (w.flow) this.paintWire(w, w.target!);
    w.target = vcls;
    this.paintFlow(w, null);
    const cls = `wire ${vcls} flow-front`;
    const els: SVGPathElement[] = [];
    const anims: Animation[] = [];
    for (const p of w.paths) {
      const L = p.getTotalLength();
      const f = p.cloneNode() as SVGPathElement;
      f.setAttribute('class', cls);
      f.removeAttribute('data-net');
      f.style.strokeDasharray = `${L} ${L + 1}`;
      p.after(f);
      els.push(f);
      const timing: KeyframeAnimationOptions = { duration: this.flowMs, easing: 'linear', fill: 'forwards' };
      anims.push(f.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], timing));
      // The old value retreats ahead of the front (complementary dash), so a thin new
      // colour never sits on top of a thicker old one.
      const dash = `${L} ${L + 1}`;
      anims.push(p.animate([{ strokeDasharray: dash, strokeDashoffset: 0 }, { strokeDasharray: dash, strokeDashoffset: -L }], timing));
    }
    this.flowPartners(w);
    w.flowEls = els;
    w.flow = anims;
    anims[0].finished.then(() => {
      if (w.flow !== anims) return;
      this.paintWire(w, vcls);
      this.paintFlow(w, this.ctx?.netBits(w.net.index) ?? null);
      this.updatePins();
    }, () => {});
  }

  /**
   * Highlight instances. With `focus`, everything else fades, and so does every wire that does
   * not join two highlighted parts (or a highlighted part and a pin): the data path stands out.
   */
  /** Draw these instances as removed (a tour's "before": dashed, faded); [] restores them. */
  ghost(names: string[]): void {
    const on = new Set(names);
    for (const [name, g] of this.insts) g.classList.toggle('ghost', on.has(name));
    for (const [name, t] of this.nameOf) t.classList.toggle('ghost', on.has(name));
  }

  /** The screen rectangle around these instances (null: none drawn). */
  instRect(names: string[]): DOMRect | null {
    // from the parts' boxes, not the drawn elements: hidden or fixed-size text (view/legible.ts) must not move what points here
    const m = this.el.getScreenCTM();
    if (!m) return null;
    let r: DOMRect | null = null;
    for (const n of names) {
      const b = this.boxes.get(n);
      if (!b) continue;
      const p = new DOMPoint(b.x - 0.4, b.y - 1.2).matrixTransform(m), q = new DOMPoint(b.x + b.w + 0.4, b.y + b.h + 0.4).matrixTransform(m);
      if (!(q.x - p.x)) continue;
      r = r ? new DOMRect(Math.min(r.left, p.x), Math.min(r.top, p.y), Math.max(r.right, q.x) - Math.min(r.left, p.x), Math.max(r.bottom, q.y) - Math.min(r.top, p.y)) : new DOMRect(p.x, p.y, q.x - p.x, q.y - p.y);
    }
    return r;
  }

  highlight(names: string[], focus = false): void {
    this.lastHl = { names, focus };
    const on = new Set(names);
    for (const [name, g] of this.insts) g.classList.toggle('hl', on.has(name));
    for (const [name, t] of this.nameOf) t.classList.toggle('hl', on.has(name));
    for (const p of this.pins) p.g.classList.toggle('hl', on.has(`pin:${p.pin.name}`));
    this.el.classList.toggle('focus', focus && names.length > 0);
    const nl = this.ctx ? netlistOf(this.ctx.def) : undefined;
    for (const w of this.wires) {
      let live = !focus;
      if (focus && nl) {
        const ends = nl.nets[w.net.index].ends;
        const hit = ends.filter((e) => !e.includes('.') || on.has(e.slice(0, e.indexOf('.')))).length;
        live = this.netMarks.has(w.net.index) || (hit >= 2 && ends.some((e) => e.includes('.') && on.has(e.slice(0, e.indexOf('.')))));
      }
      if (live) this.faded.delete(w.net.index);
      else this.faded.add(w.net.index);
      for (const p of w.paths) p.classList.toggle('faded', !live);
      for (const a of w.ants ?? []) a.classList.toggle('faded', !live);
      this.tokens?.fade(w.net.index, !live);
      for (const t of w.tags) t.classList.toggle('faded', !live);
      for (const t of w.taps) t.classList.toggle('faded', !live);
      w.label?.classList.toggle('faded', !live);
    }
  }

  /** Tint instances by slack (sim/slack.ts slackHeat; null clears): the Slack overlay. */
  heat(map: Map<string, { band: number; tip: string }> | null): void {
    this.overlay(map ? { kind: 'slack', inst: map, net: new Map() } : null);
  }

  /**
   * One overlay over this level (view/overlays.ts): each marked part and wire carries its band (data-ov: 0 … 4, or x)
   * and its value as a tooltip; the rest fades (app.css, svg.schematic.ov). null clears.
   */
  overlay(o: OverlayMarks | null): void {
    this.ov = o;
    for (const c of [...this.el.classList]) if (c.startsWith('ov-')) this.el.classList.remove(c);
    this.el.classList.toggle('ov', !!o);
    if (o) this.el.classList.add(`ov-${o.kind}`);
    for (const [name, g] of this.insts) this.paintOv(name, g);
    for (const w of this.wires) this.paintOvWire(w);
  }

  private paintOv(name: string, g: SVGGElement): void {
    const m = this.ov?.inst.get(name);
    g.querySelector(':scope > title.ov-tip')?.remove();
    if (!m) { g.removeAttribute('data-ov'); g.removeAttribute('data-ov-src'); return; }
    g.setAttribute('data-ov', String(m.band));
    g.toggleAttribute('data-ov-src', !!m.src);
    g.prepend(s('title', { class: 'ov-tip' }, m.tip));
  }

  private paintOvWire(w: WireEls): void {
    const m = this.ov?.net.get(w.net.index);
    const els: Element[] = [...w.paths, ...w.tags, ...w.taps, ...w.dots, ...(w.label ? [w.label] : [])];
    for (const e of els) if (m) e.setAttribute('data-ov', String(m.band)); else e.removeAttribute('data-ov');
    if (!w.hit) return;
    w.hit.querySelector('title')?.remove();
    if (m) w.hit.append(s('title', null, m.tip));
  }

  select(name: string | null): void {
    this.selected = name;
    for (const [n, g] of this.insts) g.classList.toggle('selected', n === name);
    if (name !== null) this.selectNet(-1);
  }

  /** Select a net: every wire, label and tag of it stays highlighted (-1 clears). */
  selectNet(idx: number): void {
    this.selectedNet = idx;
    for (const w of this.wires) if (w.shown !== undefined && !w.flow) this.paintWire(w, w.shown);
    this.el.querySelectorAll('.net-sel').forEach((e) => e.classList.remove('net-sel'));
    if (idx >= 0) this.el.querySelectorAll(`[data-net="${idx}"]`).forEach((e) => e.classList.add('net-sel'));
    this.showPartners();
  }

  /** The lines from a net's driver to its pointers (view/partners.ts), as `class` elements in the net's colour. */
  private partnerEls(w: WireEls, cls: string): SVGLineElement[] {
    const nl = this.base;
    if (!nl || !this.partnerG) return [];
    const def = nl.nets[w.net.index];
    return partnerLines(w.net, def.name ?? `n${w.net.index}`, def.ends[0]).map(([a, b]) => {
      const l = s('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: `${cls}${w.net.width > 1 ? ' bus' : ''}` });
      setNetHue(l, w.hue);
      this.partnerG!.append(l);
      return l;
    });
  }

  /** Lines for the hovered net, else the selected one: a touch screen has no hover. */
  private showPartners(): void {
    this.partnerG?.querySelectorAll('.partner-line').forEach((e) => e.remove());
    const idx = this.hovered >= 0 ? this.hovered : this.selectedNet;
    const w = idx >= 0 ? this.wires.find((x) => x.net.index === idx) : undefined;
    if (w?.tags.length) this.partnerEls(w, 'partner-line');
  }

  /** In slow motion a value crosses the gap between pointers too, as the front does on a wire. */
  private flowPartners(w: WireEls): void {
    if (!w.tags.length) return;
    for (const l of this.partnerEls(w, 'partner-flow')) {
      const L = Math.hypot(+l.getAttribute('x2')! - +l.getAttribute('x1')!, +l.getAttribute('y2')! - +l.getAttribute('y1')!);
      l.style.strokeDasharray = `${L} ${L + 1}`;
      const a = l.animate([{ strokeDashoffset: L, opacity: 0.9 }, { strokeDashoffset: 0, opacity: 0.9 }, { strokeDashoffset: 0, opacity: 0 }], { duration: this.flowMs * 1.5, easing: 'linear' });
      a.finished.then(() => l.remove(), () => l.remove());
    }
  }

  /** Clicking a net selects it; clicking one of its tags again pans to the net's next tag. */
  private clickNet(idx: number, target: Element): void {
    if (this.events.netClick?.(idx)) return;
    if (idx !== this.selectedNet) {
      this.select(null);
      this.events.select(null);
      this.selectNet(idx);
      return;
    }
    const w = this.wires.find((x) => x.net.index === idx);
    const tag = target.closest('.net-tag');
    if (!w || !tag || w.tags.length < 2) return;
    const k = (w.tags.indexOf(tag as SVGGElement) + 1) % w.tags.length;
    this.centerOn(w.net.tags[k].pos);
    w.tags[k].classList.add('net-ping');
    setTimeout(() => w.tags[k].classList.remove('net-ping'), 900);
  }

  /** What the keyboard cursor can stand on: this level's parts (wiring and constants left out) and its own pins. */
  cursorItems(): CursorItem[] {
    const items: CursorItem[] = [];
    for (const [name, b] of this.boxes) if (!this.quiet.has(name)) items.push({ kind: 'inst', name, ...b });
    for (const { pin } of this.pins) items.push({ kind: 'pin', name: pin.name, dir: pin.dir, x: pin.pos[0] - 1.5, y: pin.pos[1] - 1.5, w: 3, h: 3 });
    return items;
  }

  get cursor(): CursorItem | null {
    return this.kcur;
  }

  /** Put the keyboard cursor on an item (null: none): a ring around it, panned into view. */
  setCursor(it: CursorItem | null): void {
    this.kcur = it;
    if (!it) return void this.kring?.remove();
    if (!this.kring) this.kring = s('rect', { class: 'kcursor', rx: 0.8 });
    const m = 0.7;
    for (const [k, v] of [['x', it.x - m], ['y', it.y - m], ['width', it.w + 2 * m], ['height', it.h + 2 * m]] as const) this.kring.setAttribute(k, String(v));
    this.el.append(this.kring); // last: over everything
    this.centerOn([it.x + it.w / 2, it.y + it.h / 2]);
  }

  /** Can the learner drive this level's input pins (the top level of a scene)? */
  get drivable(): boolean {
    return this.interactive;
  }

  /** The item under the cursor in words, for a screen reader: a pin and its value as shown, a part's name and kind. */
  cursorText(): string {
    const it = this.kcur;
    if (!it) return '';
    if (it.kind === 'pin') {
      const p = this.pins.find((q) => q.pin.name === it.name);
      const v = p?.value?.textContent?.trim();
      return `${it.dir === 'out' ? 'output' : 'input'} ${it.name}${v ? ` = ${v}` : ''}`;
    }
    const inst = this.base?.instances.find((i) => i.name === it.name);
    const what = inst ? inst.label ?? inst.def.name : it.name;
    const open = this.ctx?.canOpen(it.name) ? ', Enter opens it' : '';
    return `${what} (${it.name})${open}`;
  }

  /** The drawn element of the item under the cursor (for the menu key), if any. */
  cursorEl(): Element | null {
    const it = this.kcur;
    if (!it) return null;
    return it.kind === 'inst' ? this.insts.get(it.name) ?? null : this.pins.find((p) => p.pin.name === it.name)?.g ?? null;
  }

  /** Zoom to an instance (about `span` grid units wide around it). */
  focusInst(name: string, span = 70): void {
    const g = this.insts.get(name);
    if (!g) return;
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
    if (!m) return;
    // `span` units across the widest free part of the canvas, centred on the part's corner
    const x = Number(m[1]) + 6, y = Number(m[2]);
    this.cam.fit({ x: x - span / 2, y: y - span / 20, w: span, h: span / 10 }, this.cover, 0);
    this.cam.fitted = false;
  }

  /**
   * Frame instances (and pins, `pin:<name>`) with a margin, never zooming in past `minW` grid units: a part named in a
   * chapter's text and pinned. Leaves the view alone when none of them is drawn here.
   */
  frameInsts(names: string[], margin = 4, minW = 40): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    // from the parts' boxes (and a pin's place with room for its glyph), not the drawn elements: hidden or fixed-size
    // text (view/legible.ts) must not change the framing
    for (const n of names) {
      let b: Rect | undefined;
      if (n.startsWith('pin:')) {
        const p = this.pins.find((q) => q.pin.name === n.slice(4))?.pin;
        if (p) b = { x: p.pos[0] - 3, y: p.pos[1] - 3, w: 6, h: 6 };
      } else {
        const r = this.boxes.get(n);
        if (r) b = { x: r.x, y: r.y - 1.2, w: r.w, h: r.h + 1.2 };
      }
      if (!b) continue;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    if (!Number.isFinite(x0)) return;
    this.cam.fit({ x: x0 - margin, y: y0 - margin, w: x1 - x0 + 2 * margin, h: y1 - y0 + 2 * margin }, this.cover, minW);
    this.cam.fitted = false;
  }

  /** Pan (without zooming) so that a point is centred, unless it is already well inside the view. */
  centerOn(p: Vec): void {
    this.cam.centerOn(p);
  }

  get selection(): string | null {
    return this.selected;
  }

  // ---- the learner's layout (view/layout.ts) ----------------------------------------------

  /** Parts picked to move together (shift-click, or shift-drag a box), as a set; empty clears. */
  setGroup(names: Iterable<string>): void {
    this.group = new Set([...names].filter((n) => this.insts.has(n)));
    for (const [n, g] of this.insts) g.classList.toggle('grouped', this.group.has(n));
  }

  /** Let go of the picked parts (Esc); false when none were picked. */
  dropGroup(): boolean {
    if (!this.group.size) return false;
    this.setGroup([]);
    return true;
  }

  private toggleGroup(name: string): void {
    const g = new Set(this.group);
    if (this.selected && !g.size) g.add(this.selected);
    if (g.has(name)) g.delete(name);
    else g.add(name);
    this.setGroup(g);
  }

  /** Shift-drag on the canvas: a box; every part it touches joins the picked ones. */
  private bandSelect(e: PointerEvent): void {
    const [x0, y0] = this.cam.toWorld(e.clientX, e.clientY);
    const band = s('rect', { class: 'pick-band', x: x0, y: y0, width: 0, height: 0 });
    this.el.append(band);
    this.el.setPointerCapture(e.pointerId);
    let box = { x: x0, y: y0, w: 0, h: 0 };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const [x, y] = this.cam.toWorld(ev.clientX, ev.clientY);
      box = { x: Math.min(x, x0), y: Math.min(y, y0), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      band.setAttribute('x', String(box.x));
      band.setAttribute('y', String(box.y));
      band.setAttribute('width', String(box.w));
      band.setAttribute('height', String(box.h));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
      band.remove();
      if (ev.type === 'pointercancel' || box.w + box.h < 0.5) return;
      const hit = [...this.boxes].filter(([, b]) => overlaps(b, box)).map(([n]) => n);
      this.setGroup([...this.group, ...hit]);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  /** Parts and wires move when dragged: a level the learner may arrange, layout not locked (settings.moveParts), not the Original peek. */
  get movable(): boolean {
    return !!this.arrange && !this.original && settings.moveParts;
  }

  /**
   * A press on a part: a drag moves it (and the parts picked with it) where parts move: with a mouse or a pen, or a
   * finger on a part already selected (tap it first: a finger otherwise pans, as on wires). Anywhere else the drag
   * pans the view, and on a locked layout the first such drag says where the lock is.
   */
  private pressInst(e: PointerEvent, name: string): void {
    if (e.button !== 0 || (e.target as Element).closest('.open-badge')) return;
    if (this.arrange === true && this.movable && (e.pointerType !== 'touch' || this.selected === name || this.group.has(name))) {
      this.dragInst(e, name);
      return;
    }
    if (e.shiftKey && this.arrange === true) return;
    this.panFrom(e, this.arrange === true && !settings.moveParts && !this.original);
  }

  /** Pan the view from a press on a part (installPanZoom pans only from the board): past the slop, the part's click is
   *  swallowed. `locked`: the drag would have moved the part had the layout not been locked. */
  private panFrom(e: PointerEvent, locked: boolean): void {
    const vx = this.cam.vb.x, vy = this.cam.vb.y, k = this.cam.scale();
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moved) {
        if (!pastSlop(e, ev)) return;
        moved = true;
        this.el.setPointerCapture(e.pointerId);
        this.tooltip.style.opacity = '0';
        if (locked && !lockSaid) {
          lockSaid = true;
          this.note('The layout is locked, so dragging moves the view. To move parts, open the lock on the stage bar');
        }
      }
      this.cam.vb.x = vx - (ev.clientX - e.clientX) * k;
      this.cam.vb.y = vy - (ev.clientY - e.clientY) * k;
      this.cam.fitted = false;
      this.cam.apply();
    };
    const stop = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId && ev.type !== 'pointerdown') return;
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', stop);
      this.el.removeEventListener('pointercancel', stop);
      this.el.removeEventListener('pointerdown', other);
      if (!moved) return;
      if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
      this.dragged = true;
      setTimeout(() => (this.dragged = false));
    };
    // a second finger: the pinch takes over
    const other = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) stop(ev); };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', stop);
    this.el.addEventListener('pointercancel', stop);
    this.el.addEventListener('pointerdown', other);
  }

  /**
   * Drag a part (and the parts picked with it) to a new place, in whole grid units. On a level that routes quickly
   * the wires follow while it moves; on a big one the symbols move alone, their wires faded, and the wires are routed
   * when they are dropped. A second finger (a pinch) or Esc puts them back.
   */
  private dragInst(e: PointerEvent, name: string): void {
    const id = this.ctx?.def.id, base = this.base;
    if (e.button !== 0 || !id || !base || (e.target as Element).closest('.open-badge')) return;
    const [x0, y0] = this.cam.toWorld(e.clientX, e.clientY);
    const moving = this.group.has(name) ? [...this.group] : [name];
    const start = new Map(moving.map((n) => [n, this.atOf.get(n) ?? [0, 0] as Vec]));
    const live = this.routeMs < LIVE_ROUTE_MS;
    let moved = false, d: Vec = [0, 0], frame = 0;
    const set = new Set(moving);
    const mine = this.wires.filter((w) => base.nets[w.net.index].ends.some((x) => set.has(x.slice(0, x.indexOf('.')))));
    // inline opacity: value classes are rewritten on every repaint
    const fade = (on: boolean) => {
      for (const w of mine) {
        for (const el of [...w.paths, ...w.tags, ...w.dots, ...w.taps, ...(w.ants ?? []), ...(w.label ? [w.label] : [])]) el.style.opacity = on ? '0.2' : '';
      }
    };
    const placed = (): Record<string, Vec> => Object.fromEntries(moving.map((n) => {
      const p = start.get(n)!;
      return [n, [p[0] + d[0], p[1] + d[1]] as Vec];
    }));
    const place = () => {
      for (const [n, p] of Object.entries(placed())) this.insts.get(n)?.setAttribute('transform', `translate(${p[0]},${p[1]})`);
    };
    const reroute = () => {
      frame = 0;
      this.preview = placed();
      this.relayout(false);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const [x, y] = this.cam.toWorld(ev.clientX, ev.clientY);
      if (!moved) {
        if (!pastSlop(e, ev)) return;
        moved = true;
        // on the svg, which outlives the redraws of a live drag
        this.el.setPointerCapture(e.pointerId);
        this.dragging = set;
        for (const n of moving) this.insts.get(n)?.classList.add('dragging');
        this.tooltip.style.opacity = '0';
        if (!live) fade(true);
      }
      const nd: Vec = [Math.round(x - x0), Math.round(y - y0)];
      if (nd[0] === d[0] && nd[1] === d[1]) return;
      d = nd;
      if (!live) place();
      else if (!frame) frame = requestAnimationFrame(reroute);
    };
    const stop = (commit: boolean) => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', cancel);
      this.el.removeEventListener('pointerdown', other);
      document.removeEventListener('keydown', key, true);
      if (!moved) return;
      if (frame) cancelAnimationFrame(frame);
      this.dragging = new Set();
      this.preview = null;
      for (const n of moving) this.insts.get(n)?.classList.remove('dragging');
      // the click that follows pointerup must not select the part
      this.dragged = true;
      setTimeout(() => (this.dragged = false));
      if (commit && (d[0] || d[1])) {
        const to = placed();
        this.edit((l) => {
          for (const n of moving) {
            const home = base.instances.find((i) => i.name === n)?.at ?? [0, 0];
            if (to[n][0] === home[0] && to[n][1] === home[1]) delete l.at[n];
            else l.at[n] = to[n];
          }
          dropCorners(l, base, moving);
        });
      } else if (live) {
        this.relayout(false);
      } else {
        d = [0, 0];
        place();
        fade(false);
      }
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) stop(true); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) stop(false); };
    const other = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) stop(false); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !moved) return;
      ev.stopPropagation();
      stop(false);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', cancel);
    this.el.addEventListener('pointerdown', other);
    document.addEventListener('keydown', key, true);
  }

  /**
   * The net whose wire a press would drag (-1: none): a plain press on a wire, probing too (a press that does not
   * move is still a click: the probe). A finger pans the canvas over wires, so it moves only the wire already
   * selected (tap it first).
   */
  private grabbedNet(e: PointerEvent): number {
    if (!this.movable || e.button !== 0 || e.shiftKey) return -1;
    const t = (e.target as Element).closest('.wire-hit, .wires [data-net]');
    const idx = t ? Number(t.getAttribute('data-net')) : -1;
    return idx >= 0 && (e.pointerType !== 'touch' || idx === this.selectedNet) ? idx : -1;
  }

  /** On the stage a wire's hit stroke shows which way the segment under the pointer moves. */
  private wireCursor(t: SVGPathElement, e: PointerEvent): void {
    const w = this.arrange ? this.wires.find((x) => x.net.index === Number(t.dataset.net)) : undefined;
    const seg = w && nearestSegment(w.net.paths, this.cam.toWorld(e.clientX, e.clientY), 0.7, (i) => !w.net.ends?.[i]);
    t.style.cursor = seg ? (seg.axis === 'h' ? 'ns-resize' : 'ew-resize') : '';
  }

  /**
   * Drag a segment of a wire across its direction, in half grid units: the wire moves as one (the net's other
   * paths along the same line too), its neighbours stretch, and at a pin a short stub stays. On drop its corners
   * are kept (NetDef.via, in the layout). A press that does not move is a click on the wire; Esc or a second
   * finger puts it back.
   */
  private dragWire(e: PointerEvent, idx: number): void {
    const w = this.wires.find((x) => x.net.index === idx), base = this.base;
    if (!w || !base) return;
    const target = e.target as Element;
    const ends = w.net.ends ?? [];
    const fixed = (i: number) => !ends[i];
    const [x0, y0] = this.cam.toWorld(e.clientX, e.clientY);
    // only stubs to hand-placed tags under the press: a click
    const grab = nearestSegment(w.net.paths, [x0, y0], 0.7, fixed);
    const hit = this.el.querySelector<SVGPathElement>(`.wire-hit[data-net="${idx}"]`);
    const was = { d: w.paths.map((p) => p.getAttribute('d') ?? ''), hit: hit?.getAttribute('d') ?? '' };
    const extras = [...w.dots, ...w.taps, ...(w.ants ?? []), ...(w.flowEls ?? []), ...(w.label ? [w.label] : [])];
    let moved = false, by = 0, paths = w.net.paths;
    const line = (p: Vec[]) => 'M' + p.map(([x, y]) => `${x},${y}`).join(' L');
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId || !grab) return;
      const [x, y] = this.cam.toWorld(ev.clientX, ev.clientY);
      if (!moved) {
        if (!pastSlop(e, ev)) return;
        moved = true;
        this.el.setPointerCapture(e.pointerId);
        this.reshaping = true;
        this.tooltip.style.opacity = '0';
        this.el.classList.add('reshaping');
        // inline opacity: value classes are rewritten on every repaint
        for (const el of extras) el.style.opacity = '0';
      }
      const nb = Math.round((grab.axis === 'h' ? y - y0 : x - x0) * 2) / 2;
      if (nb === by) return;
      by = nb;
      paths = dragSegment(w.net.paths, grab.pi, grab.k, by, fixed);
      w.paths.forEach((el, i) => el.setAttribute('d', line(paths[i])));
      hit?.setAttribute('d', paths.map(line).join(' '));
    };
    const stop = (commit: boolean) => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', cancel);
      this.el.removeEventListener('pointerdown', other);
      document.removeEventListener('keydown', key, true);
      if (!moved) {
        if (commit) this.clickNet(idx, target);
        return;
      }
      this.reshaping = false;
      this.el.classList.remove('reshaping');
      if (commit && by) {
        const k = netKey(base.nets[idx]);
        this.edit((l) => {
          const own = (l.via ??= {})[k] = { ...l.via[k] };
          paths.forEach((p, i) => {
            const end = ends[i];
            if (p !== w.net.paths[i] && end) own[end] = p.slice(1, -1);
          });
        });
        return;
      }
      w.paths.forEach((el, i) => el.setAttribute('d', was.d[i]));
      hit?.setAttribute('d', was.hit);
      for (const el of extras) el.style.opacity = '';
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) stop(true); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) stop(false); };
    const other = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) stop(false); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !moved) return;
      ev.stopPropagation();
      stop(false);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', cancel);
    this.el.addEventListener('pointerdown', other);
    document.addEventListener('keydown', key, true);
  }

  /** What the menu needs to colour this level's nets (the writes are view/netcolours.ts, in its chunk): where the learner can
   *  arrange it (a sandbox chip's wires are coloured there). `done` recolours in place: nothing moves, nothing is routed again. */
  private hueSite(): HueSite | undefined {
    const id = this.ctx?.def.id, base = this.base;
    return this.arrange && id && base ? { id, key: (i) => netKey(base.nets[i]), done: () => { this.paintHues(); this.events.layoutChanged?.(); } } : undefined;
  }

  /** Every net's hue again from the stored colours, applied to what is drawn where it changed. */
  private paintHues(): void {
    const id = this.ctx?.def.id, base = this.base;
    if (!id || !base) return;
    const hues = layoutOf(id)?.hues ?? {};
    for (const w of this.wires) {
      const hue = drawnHue(w.spread, hues[netKey(base.nets[w.net.index])]);
      if (hue === w.hue) continue;
      w.hue = hue;
      for (const el of [...w.paths, ...w.tags, ...w.taps, ...w.dots, ...(w.label ? [w.label] : []), ...(w.ants ?? [])]) setNetHue(el, hue);
    }
    this.update();
  }

  /** Change this level's layout (one undo step) and draw it again. */
  private edit(f: Parameters<typeof editLayout>[1]): void {
    const id = this.ctx?.def.id;
    if (!id) return;
    editLayout(id, f);
    this.redraw();
  }

  /** Undo (or redo) the last layout edit of this level; false when there is none. */
  undo(redo = false): boolean {
    const id = this.ctx?.def.id;
    if (!id || !this.arrange || !undoLayout(id, redo)) return false;
    this.redraw();
    return true;
  }

  /**
   * Draw the level again after a layout edit. Routing a big level takes seconds (a hundred unravelled nets on one of
   * chapter feed's blocks: ~7 s), so a badge says so first, painted before the work starts.
   */
  private redraw(after?: () => void): void {
    const ctx = this.ctx;
    this.host.classList.add('routing');
    requestAnimationFrame(() => setTimeout(() => {
      this.host.classList.remove('routing');
      if (this.ctx !== ctx) return;
      this.relayout();
      after?.();
    }));
  }

  private setWired(keys: string[], on: boolean): void {
    const ks = new Set(keys);
    this.edit((l) => (l.wired = on ? [...l.wired, ...keys] : l.wired.filter((k) => !ks.has(k))));
  }

  private setTagged(keys: string[], on: boolean): void {
    const ks = new Set(keys);
    this.edit((l) => (l.tagged = on ? [...l.tagged, ...keys] : l.tagged.filter((k) => !ks.has(k))));
  }

  /**
   * Draw one wire as pointers. The router wires a net anyway when its labels would sit on each other (a sink right
   * next to its driver): then the edit is taken back, and the learner told why, rather than nothing happening.
   */
  private toPointers(index: number, name: string): void {
    const ctx = this.ctx, base = this.base;
    if (!ctx || !base) return;
    editLayout(ctx.def.id, (l) => l.tagged.push(netKey(base.nets[index])));
    this.redraw(() => {
      if (this.wires.find((w) => w.net.index === index)?.tags.length) return;
      dropLastEdit(ctx.def.id);
      this.relayout();
      this.note(`${name} is too short for pointers: its labels would sit on each other`);
    });
  }

  /** A short message over the canvas, for a few seconds. */
  private note(text: string): void {
    this.host.dataset.note = text;
    this.host.classList.add('noting');
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.host.classList.remove('noting'), 3500);
  }
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  /** Draw the level again after a layout edit, keeping the view, the selection, picked parts, highlights and marks. */
  private relayout(notify = true): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const keep = { hl: this.lastHl, marks: this.netMarks, sel: this.selected, net: this.selectedNet, radix: new Map(this.radixOverride), group: this.group };
    this.show(ctx, this.interactive, true);
    this.radixOverride = keep.radix;
    this.netMarks = keep.marks;
    this.select(keep.sel && this.insts.has(keep.sel) ? keep.sel : null);
    this.setGroup(keep.group);
    // repaints every wire, with the marks
    this.selectNet(keep.net);
    this.highlight(keep.hl.names, keep.hl.focus);
    this.update();
    if (notify) this.events.layoutChanged?.();
  }

  /** What the learner can do to this level's layout, and to the net or part under the pointer. */
  private layoutItems(target?: Element | null): MenuItem[] {
    const ctx = this.ctx, base = this.base;
    if (!ctx || !base || !this.arrange) return [];
    const id = ctx.def.id;
    const lay = layoutOf(id);
    const items: MenuItem[] = [];
    const ni = target?.closest('[data-net]')?.getAttribute('data-net');
    const net = ni == null ? undefined : base.nets[Number(ni)];
    if (net) {
      const key = netKey(net), shown = showsTags(net, lay);
      if (isTagged(net)) {
        const name = net.name ?? `n${ni}`;
        if (shown) items.push({ label: `Unravel ${name}`, hint: 'Draw this pointer as wires from its driver', run: () => this.setWired([key], true) });
        else items.push({ label: `${name} back to pointers`, hint: 'Its labels again, as first drawn', run: () => this.setWired([key], false) });
      } else {
        const name = net.name ?? net.ends[0];
        if (!shown) items.push({ label: `Draw ${name} as pointers`, hint: 'A label at each end instead of the wire', run: () => this.toPointers(Number(ni), name) });
        else items.push({ label: `${name} back to a wire`, hint: 'As first drawn', run: () => this.setTagged([key], false) });
      }
      if (!shown && lay?.via?.[key]) {
        items.push({ label: `Reroute ${net.name ?? net.ends[0]}`, hint: 'Let go of your bends: drawn as the router would', run: () => this.edit((l) => delete l.via?.[key]) });
      }
    }
    const inst = target?.closest('[data-inst]')?.getAttribute('data-inst');
    const back = this.arrange !== true ? [] : inst && this.group.has(inst) ? [...this.group].filter((n) => lay?.at[n]) : inst && lay?.at[inst] ? [inst] : [];
    if (back.length) {
      items.push({ label: back.length > 1 ? `Put the ${back.length} picked parts back` : `Put ${back[0]} back`, hint: 'Where it was first drawn',
        run: () => this.edit((l) => {
          back.forEach((n) => delete l.at[n]);
          dropCorners(l, base, back);
        }) });
    }
    if (canUndo(id)) items.push({ label: 'Undo', hint: 'Ctrl+Z', run: () => this.undo() });
    if (canRedo(id)) items.push({ label: 'Redo', hint: 'Ctrl+Shift+Z', run: () => this.undo(true) });
    const left = base.nets.filter((x) => showsTags(x, lay));
    if (left.length) {
      const hint = `${left.length} net${left.length > 1 ? 's' : ''} drawn as wires${left.length > 60 ? ': a few seconds to route' : ''}`;
      items.push({ label: 'Unravel all pointers', hint, run: () => this.edit((l) => {
        l.wired = [...l.wired, ...left.filter(isTagged).map(netKey)];
        l.tagged = [];
      }) });
    }
    const hs = lay?.hues && this.hueSite();
    // (netcolours.ts resetColours, inline: an import here would put that module back in the stage's chunk)
    if (hs) items.push({ label: 'Reset colours', hint: 'Your wire colours on this level', run: () => { editLayout(id, (e) => void delete e.hues); hs.done(); } });
    if (lay && (Object.keys(lay.at).length || lay.wired.length || lay.tagged.length || lay.via)) items.push({ label: 'Reset layout', hint: 'This level as first drawn (wire colours you picked stay)', run: () => this.edit((l) => {
      l.at = {};
      l.wired = [];
      l.tagged = [];
      delete l.via;
    }) });
    return items;
  }

  private holdQuiet: () => boolean = () => false;

  private contextMenu(e: MouseEvent): void {
    if (this.holdQuiet()) return void e.preventDefault();
    // Shift: the browser's own menu, the way out of this one
    if (e.shiftKey) return;
    if (this.traceMenu(e.target as Element, e.clientX, e.clientY)) return void e.preventDefault();
    const items = this.menuItems(e.target as Element);
    if (!items.length) return;
    e.preventDefault();
    this.openMenu(items, e.clientX, e.clientY);
  }

  /** A host whose canvas takes the focus sets this: the level's menu then offers the picker, a keyboard's way to any target. */
  pickable = false;

  /** A host that wants Trace on its circuit (stage, look inside, a codex figure) sets this. */
  trace = false;

  /** What the menu holds for what is under the pointer: on empty ground, a way to everything else first. */
  private menuItems(target: Element | null): MenuItem[] {
    const items = this.layoutItems(target);
    if (!this.pickable || !this.ctx || target?.closest('[data-net], [data-inst]')) return items;
    // the groups' rows load when one opens (view/circuitmenu.ts)
    const later = (label: string, which: 'explain' | 'elsewhere'): MenuItem => ({ label, sub: () => import('./circuitmenu').then((m) => m.levelGroup(this.events, which)) });
    const more: MenuItem[] = [
      ...(this.events.inspect && this.events.canInspect?.() !== false ? [{ label: 'Inspect', run: () => this.events.inspect!(null) }] : []),
      ...(this.events.explain?.(null) ? [later('Explain', 'explain')] : []),
      ...(this.events.elsewhere?.(null) ? [later('Take it elsewhere', 'elsewhere')] : []),
    ];
    return [{ label: 'Pick a part or wire…', run: () => this.pickTarget() }, ...more, ...items];
  }

  /** A wire's or a part's full menu. It selects what it is for now; its rows load on the first right-click
   *  (view/circuitmenu.ts), so a stage page carries only the shell. */
  private traceMenu(target: Element, x: number, y: number): boolean {
    const ctx = this.ctx;
    if (!this.trace || !ctx) return false;
    const ni = target.closest('[data-net]')?.getAttribute('data-net');
    const name = ni == null ? target.closest('[data-inst]')?.getAttribute('data-inst') : null;
    if (ni == null && (!name || !ctx.node.children?.has(name))) return false;
    if (ni != null) {
      const idx = Number(ni);
      if (idx !== this.selectedNet) {
        this.select(null);
        this.events.select(null);
        this.selectNet(idx);
      }
    } else if (!this.group.has(name!)) {
      this.setGroup([]);
      this.select(name!);
      this.events.select(name!);
    }
    const site: MenuSite = {
      ctx, events: this.events, owner: this, back: this.menuBack, layout: this.layoutItems(target),
      selectNet: (i) => { this.select(null); this.selectNet(i); },
      jump: (e) => this.jumpTo(e),
      netNote: (i) => this.netNote(ctx, i),
      hues: this.hueSite(),
    };
    void import('./circuitmenu').then(
      (m) => {
        // the view moved on while it loaded (another level, a cleared scene): the menu would be for something gone
        if (this.ctx !== ctx) return;
        if (!(ni != null ? m.openNet(site, Number(ni), x, y) : m.openPart(site, name!, x, y))) this.openMenu(site.layout.filter((r): r is MenuItem => !!r), x, y);
      },
      // offline with a stale page: the layout rows still answer
      () => this.openMenu(site.layout.filter((r): r is MenuItem => !!r), x, y));
    return true;
  }

  /** Under the value: what a switch-level net's bit does not say (a short, a weak level). */
  private netNote(ctx: ViewCtx, idx: number): string {
    if (!(ctx.sim instanceof SwitchSim)) return '';
    const flat = ctx.node.nets?.[idx] ?? [];
    if (flat.some((n) => (ctx.sim as SwitchSim).shorted?.[n])) return 'Shorted: sure paths to both a 1 and a 0.';
    const wk = flat.length === 1 ? ctx.sim.weakOf(flat[0]) : 0;
    return wk ? `Weak level: ${weakTag(wk)}` : '';
  }

  /** The menu's jump: lights the end, moving the view only when it is off screen. A port of a level goes up to its parent. */
  private jumpTo(e: NetEnd): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (e.inst !== null) {
      this.select(e.inst);
      this.events.select(e.inst);
      this.bring(this.insts.get(e.inst));
      return;
    }
    if (ctx.parent && this.events.up) {
      const from = ctx.path[ctx.path.length - 1];
      this.events.up();
      const end = `${from}.${e.port}`;
      // the parent is on screen now: light the net this port sits on
      const i = netlistOf(this.ctx?.def ?? ctx.parent.def)?.nets.findIndex((n) => n.ends.includes(end)) ?? -1;
      if (i >= 0 && this.ctx === ctx.parent) {
        this.select(null);
        this.selectNet(i);
        this.bring(this.el.querySelector(`[data-net="${i}"]`));
      }
      return;
    }
    this.bring(this.pins.find((p) => p.pin.name === e.port)?.g);
  }

  /** Light the parts of this level these hierarchical paths go through (a path lit from a menu); the count lit. */
  lightPaths(paths: string[][]): number {
    const at = this.ctx?.path ?? [];
    const names = new Set<string>();
    for (const p of paths) if (p.length > at.length && at.every((x, i) => p[i] === x) && this.insts.has(p[at.length])) names.add(p[at.length]);
    // nothing of this level on it: what is lit stays lit
    if (names.size) this.highlight([...names], true);
    return names.size;
  }

  /** What a link points at: selected, into view, flashed. False: nothing by that name or number at this level. */
  showTarget(t: ViewFocus): boolean {
    const nl = this.base;
    if (!nl) return false;
    if ('inst' in t) {
      if (!this.insts.has(t.inst)) return false;
      this.select(t.inst);
      this.events.select(t.inst);
      this.bring(this.insts.get(t.inst));
      return true;
    }
    if (!nl.nets[t.net]) return false;
    this.select(null);
    this.selectNet(t.net);
    this.bring(this.el.querySelector(`[data-net="${t.net}"]`));
    return true;
  }

  /** Into view if it is not (at this zoom), then a short flash so the eye finds it. */
  private bring(el: Element | null | undefined): void {
    if (!el) return;
    const r = el.getBoundingClientRect(), v = this.host.getBoundingClientRect();
    // not drawn right now (a pin hidden by the view): nothing to go to
    if (!r.width && !r.height) return;
    if (r.left < v.left || r.right > v.right || r.top < v.top || r.bottom > v.bottom) {
      const g = el as SVGGraphicsElement, b = g.getBBox(), m = g.getCTM(), root = this.el.getCTM();
      if (m && root) {
        const k = root.inverse().multiply(m);
        this.centerOn([k.a * (b.x + b.width / 2) + k.c * (b.y + b.height / 2) + k.e, k.b * (b.x + b.width / 2) + k.d * (b.y + b.height / 2) + k.f]);
      }
    }
    el.classList.remove('jump-ping');
    void (el as SVGElement).getBoundingClientRect();
    el.classList.add('jump-ping');
    setTimeout(() => el.classList.remove('jump-ping'), 1400);
  }

  /** The menu key: for the selected wire or part, at its place; with nothing selected, the level's. */
  keyMenu(from?: Element | null): void {
    if (!this.ctx) return;
    // a control of the drawing with the focus (a pin, a part) goes first
    const el = from?.closest('[data-inst], [data-net]') ?? (this.selectedNet >= 0 ? this.el.querySelector(`[data-net="${this.selectedNet}"]`)
      : this.selected ? this.el.querySelector(`[data-inst="${CSS.escape(this.selected)}"]`) : null);
    const { x, y } = anchorPoint(el?.getBoundingClientRect() ?? null, this.host.getBoundingClientRect());
    if (el && this.traceMenu(el, x, y)) return;
    this.openMenu(this.menuItems(el), x, y);
  }

  private pickTarget(): void {
    const nl = this.base;
    if (!nl) return;
    const back = this.menuBack;
    void import('../ui/menupick').then(({ showPicker }) => showPicker('Pick a part or wire', [
      ...nl.instances.map((i) => ({ label: i.name, note: i.def.name, run: () => {
        this.select(i.name);
        this.events.select(i.name);
        this.keyMenu();
      } })),
      ...nl.nets.map((n, i) => ({ label: n.name ?? n.ends[0] ?? `net ${i}`, note: 'wire', run: () => {
        this.select(null);
        this.events.select(null);
        this.selectNet(i);
        this.keyMenu();
      } })),
    ], back, this));
  }

  /** The level's layout actions as a menu at a point on the screen (the stage's Layout button, `toggle`). */
  /** The stage's layout pill: the author's drawing shown or the learner's again, the learner's reset, an arrangement set
   *  aside by a redraw brought back or let go. */
  layoutAction(a: 'original' | 'mine' | 'reset' | 'restore' | 'dismiss'): void {
    const id = this.ctx?.def.id;
    if (!id || !this.arrange) return;
    if (a === 'original' || a === 'mine') {
      this.original = a === 'original';
      this.relayout();
    } else if (a === 'reset') {
      this.original = false;
      this.edit((l) => {
        l.at = {};
        l.wired = [];
        l.tagged = [];
        delete l.via;
      });
    } else if (a === 'restore') {
      this.original = false;
      restoreAside(id);
      this.redraw();
    } else {
      dropAside(id);
      this.events.layoutChanged?.();
    }
  }

  layoutMenu(x: number, y: number, toggle?: Element): void {
    this.openMenu(this.layoutItems(), x, y, toggle);
  }

  get menuOpen(): boolean {
    return menuOpenFor(this);
  }

  /** What takes the focus when a menu over this view closes, if nothing had it. */
  menuBack: HTMLElement | null = null;

  private openMenu(items: MenuItem[], x: number, y: number, toggle?: Element): void {
    const into = items.length ? undefined : h('div', {}, h('p', { class: 'ctx-note' }, tx('Drag a part to move it (shift-click or shift-drag to pick several), or a wire to move it sideways. Right-click a wire to draw it as pointers.', 'Drag a part to move it; a wire moves sideways once you have tapped it. Press and hold a wire to draw it as pointers.')));
    showMenu(x, y, items, { owner: this, ...(into ? { into } : {}), ...(toggle ? { toggle } : {}), ...(this.menuBack ? { back: this.menuBack } : {}) });
  }

  closeMenu(): void {
    closeMenu(this);
    closePicker(this);
  }

  // ---- pan & zoom ---------------------------------------------------------------------

  /** Screen pixels per grid unit now (0 before a layout). */
  pxPerUnit(): number { return this.cam.pxPerUnit(); }

  /** Is the overview too small to read (the stage offers Zoom to readable)? */
  get readableOffered(): boolean { return offerReadable(this.cam.pxPerUnit()); }

  /** The camera moved (a fit, a zoom, a pan): the stage's Zoom to readable button follows. */
  onCamera(f: () => void): void { this.cam.listeners.add(f); }

  /** Zoom to readable: ~3 px per unit from the drawing's left edge; the view is the learner's now (Fit goes back). */
  zoomReadable(): void {
    const r = this.host.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) this.cam.setView(readableBox(this.bbox, r.width, r.height));
  }

  /** Everything drawn at this level, in grid units (what fit() frames, and what an image exports). */
  contentBox(): ViewBox {
    return { ...this.bbox };
  }

  fit(): void {
    this.cam.fit(this.bbox, this.coverFor());
  }

  /** The panels' covers, and the badge's too when the circuit fitted beside the panels alone reaches under it. */
  private coverFor(): Rect[] {
    const b = this.badge?.();
    if (!b) return this.cover;
    const r = this.host.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return this.cover;
    const vb = fitBox(this.bbox, r.width, r.height, this.cover);
    return underCover(vb, this.bbox, r.width, r.height, [b]) ? [...this.cover, b] : this.cover;
  }

  /** Still showing what the last fit() chose (the learner has not zoomed or panned since). */
  get fitted(): boolean {
    return this.cam.fitted;
  }

  /** The canvas changed size: refit only a view the learner has not zoomed or panned. */
  resized(): void {
    if (!this.cam.resized()) this.fit();
  }

  /** The panels moved or changed size: a fitted view refits when they now cover part of the circuit (only then: a
   *  panel growing during a run into empty space, or shrinking, leaves the drawing still). */
  setCover(cover: Rect[], refit = false): void {
    this.cover = cover;
    if (!this.cam.fitted) return;
    const r = this.host.getBoundingClientRect();
    if (refit || underCover(this.cam.vb, this.bbox, r.width, r.height, [...cover, ...(this.badge?.() ? [this.badge()!] : [])])) this.fit();
  }

  zoom(factor: number, cx?: number, cy?: number): void {
    this.cam.zoom(factor, cx, cy);
  }

  private hovered = -1;
  private setHover(idx: number): void {
    if (idx === this.hovered) return;
    this.el.querySelectorAll('.net-hover').forEach((e) => e.classList.remove('net-hover'));
    this.hovered = idx;
    if (idx >= 0) this.el.querySelectorAll(`[data-net="${idx}"]`).forEach((e) => e.classList.add('net-hover'));
    this.showPartners();
  }

  private hoverTip(e: PointerEvent): void {
    const t = (e.target as Element).closest('[data-net]');
    if (t?.classList.contains('wire-hit')) this.wireCursor(t as SVGPathElement, e);
    if (!t || !this.ctx || this.dragging.size || this.reshaping) {
      this.tooltip.style.opacity = '0';
      this.setHover(-1);
      return;
    }
    const idx = Number(t.getAttribute('data-net'));
    this.setHover(idx);
    const nl = netlistOf(this.ctx.def)!;
    const net = nl.nets[idx];
    const bits = this.ctx.netBits(idx);
    const name = net.name ?? net.ends[0];
    const val = describeBits(bits);
    this.tooltip.textContent = `${name}${bits.length > 1 ? `[${bits.length - 1}:0]` : ''} = ${val}`;
    const r = this.host.getBoundingClientRect();
    this.tooltip.style.left = `${e.clientX - r.left + 14}px`;
    this.tooltip.style.top = `${e.clientY - r.top + 14}px`;
    this.tooltip.style.opacity = '1';
  }
}
