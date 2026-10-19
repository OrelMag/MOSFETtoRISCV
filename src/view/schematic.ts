// The schematic: one component's internal netlist drawn as SVG, with live wire values.
// Rendering builds the DOM once; update() only touches classes and labels.

import { symbolGeom, type Vec } from '../sim/geometry';
import { NmosSim } from '../sim/nmossim';
import { SwitchSim, VDD_VOLTS } from '../sim/switchsim';
import { B0, B1, BX, BZ, type Bit, type Netlist, netlistOf } from '../sim/types';
import { describeBits, formatBits, type Radix } from '../sim/values';
import { h, icon, s } from '../ui/dom';
import { DoubleTap } from '../ui/doubletap';
import { reducedMotion } from '../ui/motion';
import { Camera, installPanZoom, underCover, type ViewBox } from './camera';
import { applyFlow, flowDash, flowKey, flowText, laneTails } from './flow';
import { FlowTokens, type Lane } from './flowtokens';
import type { ViewCtx } from './context';
import { hopPathData, overlaps, routeNetlist, splitterBars, tagGeom, tapLabels, textWidth, type PinGeom, type Rect, type RoutedNet, type TapLabel } from './route';
import { applyLayout, canRedo, canUndo, dropLastEdit, editLayout, isTagged, layoutOf, showsTags, undoLayout } from './layout';
import { netKey, setNetHue, spreadHues } from './nethue';
import { drawPinGlyph, drawSymbol, instNameAt, placePinValue } from './symbols';

export interface SchematicEvents {
  open(child: string): void;
  select(child: string | null): void;
  toggleInput(port: string): void;
  editInput(port: string, anchor: DOMRect): void;
  /** A click on a wire; return true to consume it (probe mode). */
  netClick?(net: number): boolean;
  /** The probe on a net of the current view, if any. */
  probeOf?(net: number): { color: number; label: string } | null;
  /** The learner moved a part or unravelled a pointer (the level was redrawn). */
  layoutChanged?(): void;
}

interface MenuItem { label: string; hint?: string; run: () => void }

/** A level routed faster than this (ms) re-routes its wires live while a part is dragged. */
const LIVE_ROUTE_MS = 25;

interface WireEls {
  net: RoutedNet;
  paths: SVGPathElement[];
  tags: SVGGElement[];
  dots: SVGCircleElement[];
  /** Bit-range labels where this net leaves a splitter tap or enters a merger tap. */
  taps: SVGGElement[];
  /** Colour per net: the hue its elements carry (nethue.ts). */
  hue?: number;
  /** Value class on screen, the one a front in flight is drawing, and that front. */
  shown?: string;
  target?: string;
  flow?: Animation[];
  flowEls?: SVGPathElement[];
  /** Flowing bits: pellets on a 1-bit wire (one overlay per path, made on first use), what they show; a bus's lanes for its riding value. */
  ants?: SVGPathElement[];
  antsKey?: string;
  lanes?: Lane[];
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

export class SchematicView {
  readonly el: SVGSVGElement;
  private ctx: ViewCtx | null = null;
  private wires: WireEls[] = [];
  private pins: PinEls[] = [];
  private insts = new Map<string, SVGGElement>();
  private bbox = { x: 0, y: 0, w: 10, h: 10 };
  private cam: Camera;
  private radixOverride = new Map<number, Radix>();
  private interactive = false;
  private selected: string | null = null;
  private selectedNet = -1;
  /** Nets faded by a focus highlight. */
  private faded = new Set<number>();
  /** Extra classes per net (instruction fields); marked nets never fade. */
  private netMarks = new Map<number, string>();
  private lastHl: { names: string[]; focus: boolean } = { names: [], focus: false };
  private probeG: SVGGElement | null = null;
  private flowG: SVGGElement | null = null;
  private labelG: SVGGElement | null = null;
  private tokens: FlowTokens | null = null;
  radix: Radix = 'hex';
  /** When > 0, value changes travel along the wires as fronts lasting this many ms. */
  flowMs = 0;
  /** Screen rectangles (from the canvas's corner) the stage's panels cover; fit() keeps the circuit clear of them. */
  cover: Rect[] = [];
  /** Parts can be dragged and pointers unravelled (view/layout.ts): the stage's views, not a read-only look inside. */
  arrange = false;
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
  /** Where each part is drawn now, and its box (grid units); how long the last routing took. */
  private atOf = new Map<string, Vec>();
  private boxes = new Map<string, Rect>();
  private routeMs = 0;
  private menu: HTMLElement | null = null;
  private tooltip: HTMLDivElement;

  constructor(private host: HTMLElement, private events: SchematicEvents) {
    this.el = s('svg', { class: 'schematic', role: 'img' });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'wire-tip';
    host.append(this.el, this.tooltip);
    this.cam = new Camera(this.el, host);
    installPanZoom(this.el, this.cam, {
      // shift-drag on the canvas picks parts (bandSelect) instead of panning
      canStart: (e) => !(this.arrange && e.shiftKey) && !(e.target as Element).closest('.inst, .pin.clickable, .bus-label'),
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
    this.el.addEventListener('pointerdown', (e) => {
      if (this.arrange && e.shiftKey && e.button === 0 && !(e.target as Element).closest('.inst, .pin, .bus-label')) this.bandSelect(e);
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
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
  }

  /** Draw the inside of ctx. `interactive` makes the root input pins clickable. */
  show(ctx: ViewCtx, interactive: boolean, keepView = false): void {
    this.ctx = ctx;
    this.interactive = interactive;
    this.radixOverride.clear();
    this.selected = null;
    this.selectedNet = -1;
    this.faded.clear();
    this.netMarks = new Map();
    this.closeMenu();
    if (!keepView) this.group = new Set();
    const base = this.base = netlistOf(ctx.def) ?? null;
    this.el.replaceChildren();
    this.wires = [];
    this.pins = [];
    this.insts.clear();
    this.atOf.clear();
    this.boxes.clear();
    if (!base) return;
    const lay = this.arrange ? layoutOf(ctx.def.id) : undefined;
    const nl = !this.arrange ? base
      : applyLayout(base, this.preview ? { wired: [], tagged: [], ...lay, at: { ...lay?.at, ...this.preview } } : lay);
    this.el.classList.toggle('arrange', this.arrange);
    const t0 = performance.now();
    const { nets, pins } = routeNetlist(ctx.def, nl);
    this.routeMs = performance.now() - t0;
    const pathData = hopPathData(nets, splitterBars(nl));
    const tapsOf = new Map<number, TapLabel[]>();
    for (const t of tapLabels(nl)) tapsOf.set(t.net, [...tapsOf.get(t.net) ?? [], t]);

    const defs = s('defs');
    defs.innerHTML = `<pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
      <circle cx="0" cy="0" r="0.06" class="grid-dot"/></pattern>`;
    this.el.append(defs);
    const gridRect = s('rect', { class: 'grid-bg', x: -500, y: -500, width: 1000, height: 1000, fill: 'url(#grid)' });
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
    this.el.append(gridRect, wiresG, this.flowG, tokG, hitG, instG, pinG, labelG, this.probeG);

    // Bounding box of everything drawn.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };

    // Wires
    // keyed by the authored net: a wire drawn as pointers is named for its driver, but keeps its colour
    const hues = spreadHues(nets.map((n) => ({ key: netKey(base.nets[n.index]), polys: n.paths })));
    for (const [ni, net] of nets.entries()) {
      const cls = net.width > 1 ? 'wire bus' : 'wire';
      const w: WireEls = { net, paths: [], dots: [], tags: [], taps: [] };
      const name = nl.nets[net.index].name ?? `n${net.index}`;
      const hue = hues[ni];
      w.hue = hue;
      for (const t of net.tags) {
        const { stub: sp, rect: { x: rx, y: ry, w: tw, h: th } } = tagGeom(t, name);
        const g = s('g', { class: 'net-tag', 'data-net': net.index });
        setNetHue(g, hue);
        // A hand-placed tag's stub is one of the net's paths (drawn below with the wires).
        const stub = s('path', { d: sp.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' '), class: cls });
        g.append(stub, s('rect', { x: rx, y: ry, width: tw, height: th, rx: 0.35 }),
          s('text', { x: rx + tw / 2, y: ry + th / 2 + 0.3, 'text-anchor': 'middle' }, name));
        w.tags.push(g);
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
        hitG.append(s('path', { d, class: 'wire-hit', 'data-net': net.index }));
      }
      for (const t of tapsOf.get(net.index) ?? []) {
        const g = s('g', { class: 'tap-label' });
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
    }

    // Instances
    for (const inst of nl.instances) {
      const at: Vec = inst.at ?? [0, 0];
      const geo = symbolGeom(inst.def);
      grow(at[0], at[1]);
      grow(at[0] + geo.w, at[1] + geo.h);
      const openable = ctx.canOpen(inst.name);
      const g = s('g', {
        class: `inst${openable ? ' openable' : ''}${inst.def.prim === 'alias' ? ' plumbing' : ''}${this.group.has(inst.name) ? ' grouped' : ''}${this.dragging.has(inst.name) ? ' dragging' : ''}`,
        transform: `translate(${at[0]},${at[1]})`, 'data-inst': inst.name,
      });
      this.atOf.set(inst.name, at);
      this.boxes.set(inst.name, { x: at[0], y: at[1], w: geo.w, h: geo.h });
      g.append(s('rect', { class: 'hit', x: -0.4, y: -0.4, width: geo.w + 0.8, height: geo.h + 0.8, rx: 0.6 }));
      g.append(drawSymbol(inst.def, inst.flip));
      const nameAt = instNameAt(inst.def);
      if (nameAt) g.append(s('text', { class: 'inst-name', x: nameAt.x, y: nameAt.y, 'text-anchor': nameAt.anchor }, inst.label ?? inst.name));
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
        if (this.arrange && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          this.toggleGroup(inst.name);
          return;
        }
        this.setGroup([]);
        this.select(inst.name);
        this.events.select(inst.name);
      });
      if (this.arrange) g.addEventListener('pointerdown', (e) => this.dragInst(e, inst.name));
      g.addEventListener('pointerup', (e) => {
        if (this.taps.upEvent(e, inst.name) && openable && !this.dragged) this.events.open(inst.name);
      });
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (openable && this.taps.dblclick(e.timeStamp)) this.events.open(inst.name);
      });
      this.insts.set(inst.name, g);
      instG.append(g);
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
    for (const w of this.wires) {
      const bits = ctx.netBits(w.net.index);
      let vcls = w.net.width > 1 ? busClass(bits) : bitClass(bits[0]);
      if (lvSim && w.net.width === 1) {
        // A charge level between the rails (a bit line at VDD/2, after sharing): its own colour and a voltage tag.
        const net = ctx.node.nets?.[w.net.index]?.[0];
        const l = net === undefined ? NaN : lvSim.level(net);
        const mid = Number.isFinite(l) && bits[0] === BX;
        if (mid) {
          vcls = 'vl';
          for (const p of w.paths) p.style.setProperty('--lv', l.toFixed(3));
        }
        this.paintLevel(w, mid || (net !== undefined && lvSim.design.caps.has(net)) ? l : NaN);
      }
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
        if (k === 'relay' && ctx.sim instanceof SwitchSim) g.classList.toggle('energized', ctx.sim.relayEnergized(li) === 1);
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
    return `${idx === this.selectedNet ? ' net-sel' : ''}${idx === this.hovered ? ' net-hover' : ''}${this.faded.has(idx) ? ' faded' : ''}${mark ? ` ${mark}` : ''}`;
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
  private paintLevel(w: WireEls, l: number): void {
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
    const txt = `${(l * VDD_VOLTS).toFixed(2)} V`;
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
  highlight(names: string[], focus = false): void {
    this.lastHl = { names, focus };
    const on = new Set(names);
    for (const [name, g] of this.insts) g.classList.toggle('hl', on.has(name));
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
    const root = this.el.getScreenCTM();
    if (!root) return;
    const inv = root.inverse();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of names) {
      const g = n.startsWith('pin:') ? this.pins.find((p) => p.pin.name === n.slice(4))?.g : this.insts.get(n);
      const m = g?.getScreenCTM();
      if (!g || !m) continue;
      const b = g.getBBox();
      const toSvg = inv.multiply(m);
      for (const [px, py] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
        const p = new DOMPoint(px, py).matrixTransform(toSvg);
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
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
        // below this (grid units) a press is still a click
        if (Math.abs(x - x0) + Math.abs(y - y0) < 0.6) return;
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
   * chapter 30's blocks: ~7 s), so a badge says so first, painted before the work starts.
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
        else items.push({ label: `${name} back to pointers`, hint: 'Its labels again, as the chapter drew it', run: () => this.setWired([key], false) });
      } else {
        const name = net.name ?? net.ends[0];
        if (!shown) items.push({ label: `Draw ${name} as pointers`, hint: 'A label at each end instead of the wire', run: () => this.toPointers(Number(ni), name) });
        else items.push({ label: `${name} back to a wire`, hint: 'As the chapter drew it', run: () => this.setTagged([key], false) });
      }
    }
    const inst = target?.closest('[data-inst]')?.getAttribute('data-inst');
    const back = inst && this.group.has(inst) ? [...this.group].filter((n) => lay?.at[n]) : inst && lay?.at[inst] ? [inst] : [];
    if (back.length) {
      items.push({ label: back.length > 1 ? `Put the ${back.length} picked parts back` : `Put ${back[0]} back`, hint: 'Where the chapter drew it',
        run: () => this.edit((l) => back.forEach((n) => delete l.at[n])) });
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
    if (lay) items.push({ label: 'Reset layout', hint: 'This level as the chapter drew it', run: () => this.edit((l) => {
      l.at = {};
      l.wired = [];
      l.tagged = [];
    }) });
    return items;
  }

  private contextMenu(e: MouseEvent): void {
    const items = this.layoutItems(e.target as Element);
    if (!items.length) return;
    e.preventDefault();
    this.openMenu(items, e.clientX, e.clientY);
  }

  /** The level's layout actions as a menu at a point on the screen (the stage's Layout button). */
  layoutMenu(x: number, y: number): void {
    this.openMenu(this.layoutItems(), x, y);
  }

  get menuOpen(): boolean {
    return !!this.menu;
  }

  private openMenu(items: MenuItem[], x: number, y: number): void {
    this.closeMenu();
    const m = this.menu = h('div', { class: 'pal-menu open sch-menu', role: 'menu' },
      items.length ? items.map((it) => h('button', { role: 'menuitem', onclick: () => {
        this.closeMenu();
        it.run();
      } }, h('span', null, h('b', null, it.label), it.hint && h('small', null, it.hint))))
        : h('p', { class: 'sch-menu-note' }, 'Drag a part to move it (shift-click or shift-drag to pick several). Right-click a wire to draw it as pointers.'));
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  }

  closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  // ---- pan & zoom ---------------------------------------------------------------------

  /** Everything drawn at this level, in grid units (what fit() frames, and what an image exports). */
  contentBox(): ViewBox {
    return { ...this.bbox };
  }

  fit(): void {
    this.cam.fit(this.bbox, this.cover);
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
    if (refit || underCover(this.cam.vb, this.bbox, r.width, r.height, cover)) this.fit();
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
  }

  private hoverTip(e: PointerEvent): void {
    const t = (e.target as Element).closest('[data-net]');
    if (!t || !this.ctx || this.dragging.size) {
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
