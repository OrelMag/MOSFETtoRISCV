// The schematic: one component's internal netlist drawn as SVG, with live wire values.
// Rendering builds the DOM once; update() only touches classes and labels.

import { symbolGeom, type Vec } from '../sim/geometry';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, BX, BZ, type Bit, netlistOf } from '../sim/types';
import { formatBits, type Radix } from '../sim/values';
import { icon, s } from '../ui/dom';
import { Camera, installPanZoom } from './camera';
import type { ViewCtx } from './context';
import { hopPathData, routeNetlist, splitterBars, tagGeom, tapLabels, textWidth, type PinGeom, type RoutedNet, type TapLabel } from './route';
import { drawPinGlyph, drawSymbol, placePinValue } from './symbols';

export interface SchematicEvents {
  open(child: string): void;
  select(child: string | null): void;
  toggleInput(port: string): void;
  editInput(port: string, anchor: DOMRect): void;
  /** A click on a wire; return true to consume it (probe mode). */
  netClick?(net: number): boolean;
  /** The probe on a net of the current view, if any. */
  probeOf?(net: number): { color: number; label: string } | null;
}

interface WireEls {
  net: RoutedNet;
  paths: SVGPathElement[];
  tags: SVGGElement[];
  dots: SVGCircleElement[];
  /** Bit-range labels where this net leaves a splitter tap or enters a merger tap. */
  taps: SVGGElement[];
  /** Value class on screen, the one a front in flight is drawing, and that front. */
  shown?: string;
  target?: string;
  flow?: Animation[];
  flowEls?: SVGPathElement[];
  label?: SVGGElement;
  labelText?: SVGTextElement;
  labelBg?: SVGRectElement;
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
  radix: Radix = 'hex';
  /** When > 0, value changes travel along the wires as fronts lasting this many ms. */
  flowMs = 0;
  /** Screen pixels on the right covered by a docked panel; fit() keeps the circuit clear of them. */
  insetRight = 0;
  private tooltip: HTMLDivElement;

  constructor(private host: HTMLElement, private events: SchematicEvents) {
    this.el = s('svg', { class: 'schematic', role: 'img' });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'wire-tip';
    host.append(this.el, this.tooltip);
    this.cam = new Camera(this.el, host);
    installPanZoom(this.el, this.cam, {
      canStart: (e) => !(e.target as Element).closest('.inst, .pin.clickable, .bus-label'),
      onTap: (target) => {
        const n = target.closest('[data-net]');
        if (n) this.clickNet(Number(n.getAttribute('data-net')), target);
        else {
          this.select(null);
          this.events.select(null);
          this.selectNet(-1);
        }
      },
      onHover: (e) => this.hoverTip(e),
      onLeave: () => (this.tooltip.style.opacity = '0'),
    });
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
    const nl = netlistOf(ctx.def);
    this.el.replaceChildren();
    this.wires = [];
    this.pins = [];
    this.insts.clear();
    if (!nl) return;
    const { nets, pins } = routeNetlist(ctx.def, nl);
    const pathData = hopPathData(nets, splitterBars(nl));
    const tapsOf = new Map<number, TapLabel[]>();
    for (const t of tapLabels(nl)) tapsOf.set(t.net, [...tapsOf.get(t.net) ?? [], t]);

    const defs = s('defs');
    defs.innerHTML = `<pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
      <circle cx="0" cy="0" r="0.06" class="grid-dot"/></pattern>`;
    this.el.append(defs);
    const gridRect = s('rect', { class: 'grid-bg', x: -500, y: -500, width: 1000, height: 1000, fill: 'url(#grid)' });
    const wiresG = s('g', { class: 'wires' });
    const hitG = s('g', { class: 'wire-hits' });
    const instG = s('g', { class: 'insts' });
    const pinG = s('g', { class: 'pins' });
    const labelG = s('g', { class: 'labels' });
    this.probeG = s('g', { class: 'probes' });
    this.el.append(gridRect, wiresG, hitG, instG, pinG, labelG, this.probeG);

    // Bounding box of everything drawn.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };

    // Wires
    for (const net of nets) {
      const cls = net.width > 1 ? 'wire bus' : 'wire';
      const w: WireEls = { net, paths: [], dots: [], tags: [], taps: [] };
      const name = nl.nets[net.index].name ?? `n${net.index}`;
      for (const t of net.tags) {
        const { tip: E, rect: { x: rx, y: ry, w: tw, h: th } } = tagGeom(t, name);
        const g = s('g', { class: 'net-tag', 'data-net': net.index });
        const stub = s('path', { d: `M${t.pos[0]},${t.pos[1]} L${E[0]},${E[1]}`, class: cls });
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
        const { x, y, w: tw, h: th } = t.rect;
        g.append(s('rect', { x, y, width: tw, height: th, rx: th / 2 }),
          s('text', { x: x + tw / 2, y: y + th * 0.76, 'text-anchor': 'middle', style: `font-size:${t.size}px` }, t.text));
        w.taps.push(g);
        labelG.append(g);
      }
      for (const [x, y] of net.dots) {
        const c = s('circle', { cx: x, cy: y, r: net.width > 1 ? 0.32 : 0.24, class: 'dot' });
        w.dots.push(c);
        wiresG.append(c);
      }
      const touchesPin = nl.nets[net.index].ends.some((e) => !e.includes('.'));
      if (net.label && !touchesPin && nl.nets[net.index].showValue !== false) {
        const g = s('g', { class: 'bus-label', 'data-net': net.index });
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
        class: `inst${openable ? ' openable' : ''}${inst.def.prim === 'alias' ? ' plumbing' : ''}`,
        transform: `translate(${at[0]},${at[1]})`, 'data-inst': inst.name,
      });
      g.append(s('rect', { class: 'hit', x: -0.4, y: -0.4, width: geo.w + 0.8, height: geo.h + 0.8, rx: 0.6 }));
      g.append(drawSymbol(inst.def, inst.flip));
      if (inst.def.prim !== 'alias' && inst.def.prim !== 'vdd' && inst.def.prim !== 'gnd') {
        const isBox = inst.def.symbol.kind === 'box';
        const isFet = inst.def.symbol.kind === 'nmos' || inst.def.symbol.kind === 'pmos';
        g.append(s('text', {
          class: 'inst-name', x: isFet ? 3.4 : isBox ? 0.1 : geo.w / 2, y: isFet ? 1.45 : isBox ? -0.45 : -0.35,
          'text-anchor': isFet || isBox ? 'start' : 'middle',
        }, inst.label ?? inst.name));
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
        this.select(inst.name);
        this.events.select(inst.name);
      });
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (openable) this.events.open(inst.name);
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
    for (const w of this.wires) {
      const bits = ctx.netBits(w.net.index);
      const vcls = w.net.width > 1 ? busClass(bits) : bitClass(bits[0]);
      if (vcls !== w.shown) {
        if (flow && w.shown !== undefined && w.paths.length) this.flowWire(w, vcls);
        else this.paintWire(w, vcls);
      }
      if (w.labelText && w.labelBg && w.net.label) {
        const txt = formatBits(bits, this.radixOverride.get(w.net.index) ?? this.radix);
        w.labelText.textContent = txt;
        const tw = textWidth(txt, 0.95);
        w.labelBg.setAttribute('x', String(w.net.label[0] - tw / 2));
        w.labelBg.setAttribute('width', String(tw));
        // Too wide for its segment (a 64-bit value on a short hop): it would cover the ports at
        // either end. The value is still in the hover tooltip, and a narrower radix may fit.
        w.label!.setAttribute('display', tw > w.net.labelRoom - 0.4 ? 'none' : 'inline');
        w.label!.setAttribute('class', `bus-label ${busClass(bits)}${this.marks(w.net.index)}`);
      }
    }
    this.updatePins();
    // Transistors: show which ones conduct.
    if (ctx.sim instanceof SwitchSim) {
      for (const [name, g] of this.insts) {
        const li = ctx.childLeaf(name);
        if (li === undefined) continue;
        const k = ctx.sim.design.leaves[li].kind;
        if (k !== 'nmos' && k !== 'pmos') continue;
        const c = ctx.sim.conducting[li];
        g.classList.toggle('conducting', c === 1);
        g.classList.toggle('maybe', c === 2);
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

  /**
   * Draw the new value as a front travelling from the driver along every branch, over
   * flowMs (one gate delay of the animation). The wire keeps its old colour underneath
   * until the front arrives; tags, dots and tap labels switch when it does.
   */
  private flowWire(w: WireEls, vcls: string): void {
    if (w.flow) this.paintWire(w, w.target!);
    w.target = vcls;
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
    const r = this.host.getBoundingClientRect();
    const usable = Math.max(200, r.width - this.insetRight);
    const h = span * (r.height / usable || 0.6);
    const w = span * (r.width / usable || 1);
    this.cam.vb = { x: Number(m[1]) - span / 2 + 6, y: Number(m[2]) - h / 2, w, h };
    this.cam.apply();
  }

  /** Pan (without zooming) so that a point is centred, unless it is already well inside the view. */
  centerOn(p: Vec): void {
    this.cam.centerOn(p);
  }

  get selection(): string | null {
    return this.selected;
  }

  // ---- pan & zoom ---------------------------------------------------------------------

  fit(): void {
    this.cam.fit(this.bbox, this.insetRight);
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
    if (!t || !this.ctx) {
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
    const val = bits.length === 1
      ? formatBits(bits, 'bin')
      : `${formatBits(bits, 'hex')} · ${formatBits(bits, 'bin')} · ${formatBits(bits, 'dec')}`;
    this.tooltip.textContent = `${name}${bits.length > 1 ? `[${bits.length - 1}:0]` : ''} = ${val}`;
    const r = this.host.getBoundingClientRect();
    this.tooltip.style.left = `${e.clientX - r.left + 14}px`;
    this.tooltip.style.top = `${e.clientY - r.top + 14}px`;
    this.tooltip.style.opacity = '1';
  }
}

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => !!motionQuery?.matches;
