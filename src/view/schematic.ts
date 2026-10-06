// The schematic: one component's internal netlist drawn as SVG, with live wire values.
// Rendering builds the DOM once; update() only touches classes and labels.

import { instPort, symbolGeom, type Vec } from '../sim/geometry';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, BX, BZ, type Bit, netlistOf } from '../sim/types';
import { formatBits, type Radix } from '../sim/values';
import { icon, s } from '../ui/dom';
import type { ViewCtx } from './context';
import { hopPathData, routeNetlist, splitterBars, type PinGeom, type RoutedNet } from './route';
import { drawSymbol, portLabel } from './symbols';

export interface SchematicEvents {
  open(child: string): void;
  select(child: string | null): void;
  toggleInput(port: string): void;
  editInput(port: string, anchor: DOMRect): void;
}

interface WireEls {
  net: RoutedNet;
  paths: SVGPathElement[];
  tags: SVGGElement[];
  dots: SVGCircleElement[];
  /** Bit-range labels where this net leaves a splitter tap or enters a merger tap. */
  taps: SVGGElement[];
  label?: SVGGElement;
  labelText?: SVGTextElement;
  labelBg?: SVGRectElement;
}

interface PinEls {
  pin: PinGeom;
  g: SVGGElement;
  name?: SVGTextElement;
  value?: SVGTextElement;
  valueBg?: SVGRectElement;
}

export function bitClass(b: Bit | undefined): string {
  return b === B1 ? 'v1' : b === B0 ? 'v0' : b === BZ ? 'vz' : 'vx';
}

function busClass(bits: Bit[]): string {
  if (bits.some((b) => b === BX)) return 'bus vx';
  if (bits.every((b) => b === BZ)) return 'bus vz';
  return bits.some((b) => b === B1) ? 'bus bus1' : 'bus bus0';
}

const textWidth = (t: string, size: number) => t.length * size * 0.62 + 0.8;

export class SchematicView {
  readonly el: SVGSVGElement;
  private ctx: ViewCtx | null = null;
  private wires: WireEls[] = [];
  private pins: PinEls[] = [];
  private insts = new Map<string, SVGGElement>();
  private bbox = { x: 0, y: 0, w: 10, h: 10 };
  private vb = { x: 0, y: 0, w: 10, h: 10 };
  private radixOverride = new Map<number, Radix>();
  private interactive = false;
  private selected: string | null = null;
  private selectedNet = -1;
  radix: Radix = 'hex';
  /** Screen pixels on the right covered by a docked panel; fit() keeps the circuit clear of them. */
  insetRight = 0;
  private tooltip: HTMLDivElement;

  constructor(private host: HTMLElement, private events: SchematicEvents) {
    this.el = s('svg', { class: 'schematic', role: 'img' });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'wire-tip';
    host.append(this.el, this.tooltip);
    this.installPanZoom();
  }

  /** Draw the inside of ctx. `interactive` makes the root input pins clickable. */
  show(ctx: ViewCtx, interactive: boolean, keepView = false): void {
    this.ctx = ctx;
    this.interactive = interactive;
    this.radixOverride.clear();
    this.selected = null;
    this.selectedNet = -1;
    const nl = netlistOf(ctx.def);
    this.el.replaceChildren();
    this.wires = [];
    this.pins = [];
    this.insts.clear();
    if (!nl) return;
    const { nets, pins } = routeNetlist(ctx.def, nl);
    const pathData = hopPathData(nets, splitterBars(nl));
    const tapsOf = splitterTaps(nl);

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
    this.el.append(gridRect, wiresG, hitG, instG, pinG, labelG);

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
        const D: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
        const d = D[t.dir];
        const E: Vec = [t.pos[0] + d[0] * 1.4, t.pos[1] + d[1] * 1.4];
        const tw = textWidth(name, 0.8) + 0.6, th = 1.35;
        const rx = t.dir === 'right' ? E[0] : t.dir === 'left' ? E[0] - tw : E[0] - tw / 2;
        const ry = t.dir === 'down' ? E[1] : t.dir === 'up' ? E[1] - th : E[1] - th / 2;
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
        const tw = textWidth(t.text, t.size) + 0.1, th = t.size * 1.3;
        const x = t.right ? t.pos[0] + 0.12 : t.pos[0] - 0.12 - tw;
        const y = t.pos[1] - th - 0.1;
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
      const [px, py] = pin.pos;
      const back = pin.exit === 'right' ? -1 : pin.exit === 'left' ? 1 : 0;
      const vert = pin.exit === 'down' ? -1 : pin.exit === 'up' ? 1 : 0;
      const cx = px + back * 0.9, cy = py + vert * 0.9;
      const isIn = pin.dir !== 'out';
      const clickable = isIn && interactive;
      const g = s('g', { class: `pin ${isIn ? 'pin-in' : 'pin-out'}${clickable ? ' clickable' : ''}`, 'data-pin': pin.name });
      g.append(s('path', { d: `M${cx},${cy} L${px},${py}`, class: pin.width > 1 ? 'wire bus pin-stub' : 'wire pin-stub' }));
      const els: PinEls = { pin, g };
      if (pin.width === 1) {
        g.append(s('circle', { cx, cy, r: 0.8, class: 'pin-knob' }));
      } else {
        const bg = s('rect', { class: 'pin-box', rx: 0.5, height: 1.6, y: cy - 0.8 });
        const t = s('text', { class: 'pin-value', y: cy + 0.42, 'text-anchor': 'middle' });
        g.append(bg, t);
        els.value = t;
        els.valueBg = bg;
      }
      // Name label, away from the circuit (beyond the value box for buses; placed in update()).
      const ax = back !== 0 ? cx + back * 1.3 : cx;
      const ay = vert !== 0 ? cy + vert * 1.6 + (vert > 0 ? 0.4 : 0) : cy + 0.42;
      const anchor = back > 0 ? 'start' : back < 0 ? 'end' : 'middle';
      const name = s('text', { class: 'pin-name', x: ax, y: ay, 'text-anchor': anchor }, portLabel(pin.name));
      g.append(name);
      els.name = name;
      const extra = textWidth(pin.name, 1.1) + 3 + (pin.width > 1 ? textWidth('0x'.padEnd(2 + Math.ceil(pin.width / 4), '0'), 1.05) : 0);
      grow(cx - 2 - (back < 0 ? extra : 0), cy - 2);
      grow(cx + 2 + (back > 0 ? extra : 0), cy + 2);
      if (clickable) {
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (pin.width === 1) this.events.toggleInput(pin.name);
          else this.events.editInput(pin.name, (g as unknown as Element).getBoundingClientRect());
        });
      }
      this.pins.push(els);
      pinG.append(g);
    }

    const m = 3;
    this.bbox = { x: x0 - m, y: y0 - m - 1, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m + 1 };
    if (!keepView) this.fit();
    else this.applyViewBox();
    this.update();
  }

  /** Refresh every value on screen from the simulation. */
  update(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.sync();
    for (const w of this.wires) {
      const bits = ctx.netBits(w.net.index);
      const cls = w.net.width > 1 ? `wire ${busClass(bits)}` : `wire ${bitClass(bits[0])}`;
      for (const p of w.paths) p.setAttribute('class', cls);
      const vcls = w.net.width > 1 ? busClass(bits) : bitClass(bits[0]);
      for (const t of w.tags) {
        t.setAttribute('class', `net-tag ${vcls}`);
        t.firstElementChild!.setAttribute('class', cls);
      }
      const dcls = `dot ${w.net.width > 1 ? busClass(bits) : bitClass(bits[0])}`;
      for (const d of w.dots) d.setAttribute('class', dcls);
      for (const t of w.taps) t.setAttribute('class', `tap-label ${vcls}`);
      if (w.labelText && w.labelBg && w.net.label) {
        const txt = formatBits(bits, this.radixOverride.get(w.net.index) ?? this.radix);
        w.labelText.textContent = txt;
        const tw = textWidth(txt, 0.95);
        w.labelBg.setAttribute('x', String(w.net.label[0] - tw / 2));
        w.labelBg.setAttribute('width', String(tw));
        w.label!.setAttribute('class', `bus-label ${busClass(bits)}`);
      }
    }
    for (const p of this.pins) {
      const bits = ctx.portBits(p.pin.name);
      const base = `pin ${p.pin.dir !== 'out' ? 'pin-in' : 'pin-out'}${p.pin.dir !== 'out' && this.interactive ? ' clickable' : ''}`;
      if (p.pin.width === 1) {
        p.g.setAttribute('class', `${base} ${bitClass(bits[0])}`);
      } else {
        p.g.setAttribute('class', `${base} ${busClass(bits)}`);
        const txt = formatBits(bits, this.radix);
        p.value!.textContent = txt;
        const tw = Math.max(3, textWidth(txt, 1.05));
        const back = p.pin.exit === 'right' ? -1 : p.pin.exit === 'left' ? 1 : 0;
        const cx = p.pin.pos[0] + back * 0.9;
        const bx = back < 0 ? cx - tw + 0.6 : back > 0 ? cx - 0.6 : cx - tw / 2;
        p.valueBg!.setAttribute('x', String(bx));
        p.valueBg!.setAttribute('width', String(tw));
        p.value!.setAttribute('x', String(bx + tw / 2));
        if (back !== 0) p.name?.setAttribute('x', String(back < 0 ? bx - 0.4 : bx + tw + 0.4));
        const stub = p.g.querySelector('.pin-stub');
        stub?.setAttribute('class', `wire ${busClass(bits)} pin-stub`);
      }
    }
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

  highlight(names: string[]): void {
    for (const [name, g] of this.insts) g.classList.toggle('hl', names.includes(name));
    for (const p of this.pins) p.g.classList.toggle('hl', names.includes(`pin:${p.pin.name}`));
  }

  select(name: string | null): void {
    this.selected = name;
    for (const [n, g] of this.insts) g.classList.toggle('selected', n === name);
    if (name !== null) this.selectNet(-1);
  }

  /** Select a net: every wire, label and tag of it stays highlighted (-1 clears). */
  selectNet(idx: number): void {
    this.selectedNet = idx;
    this.el.querySelectorAll('.net-sel').forEach((e) => e.classList.remove('net-sel'));
    if (idx >= 0) this.el.querySelectorAll(`[data-net="${idx}"]`).forEach((e) => e.classList.add('net-sel'));
  }

  /** Clicking a net selects it; clicking one of its tags again pans to the net's next tag. */
  private clickNet(idx: number, target: Element): void {
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

  /** Pan (without zooming) so that a point is centred, unless it is already well inside the view. */
  centerOn(p: Vec): void {
    const v = this.vb;
    const mx = v.w * 0.15, my = v.h * 0.15;
    if (p[0] > v.x + mx && p[0] < v.x + v.w - mx && p[1] > v.y + my && p[1] < v.y + v.h - my) return;
    this.vb = { ...v, x: p[0] - v.w / 2, y: p[1] - v.h / 2 };
    this.applyViewBox();
  }

  get selection(): string | null {
    return this.selected;
  }

  // ---- pan & zoom ---------------------------------------------------------------------

  fit(): void {
    const r = this.host.getBoundingClientRect();
    const usable = Math.max(200, r.width - this.insetRight);
    const aspect = usable > 0 && r.height > 0 ? usable / r.height : 16 / 10;
    let { x, y, w, h } = this.bbox;
    // Never zoom in so far that a tiny circuit looks cartoonish.
    const minW = 34;
    if (w < minW) { x -= (minW - w) / 2; w = minW; }
    if (w / h > aspect) {
      const nh = w / aspect; y -= (nh - h) / 2; h = nh;
    } else {
      const nw = h * aspect; x -= (nw - w) / 2; w = nw;
    }
    // Extend the view to the right so the circuit sits in the uncovered part.
    if (this.insetRight > 0 && r.width > 0) w = w * (r.width / usable);
    this.vb = { x, y, w, h };
    this.applyViewBox();
  }

  zoom(factor: number, cx?: number, cy?: number): void {
    const v = this.vb;
    const px = cx ?? v.x + v.w / 2, py = cy ?? v.y + v.h / 2;
    const nw = Math.min(Math.max(v.w * factor, 8), 4000);
    const k = nw / v.w;
    this.vb = { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w: v.w * k, h: v.h * k };
    this.applyViewBox();
  }

  private applyViewBox(): void {
    const { x, y, w, h } = this.vb;
    this.el.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  private toWorld(clientX: number, clientY: number): Vec {
    const m = this.el.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }

  private installPanZoom(): void {
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null = null;
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      this.zoom(Math.exp(e.deltaY * 0.0015), wx, wy);
    }, { passive: false });
    this.el.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('.inst, .pin.clickable, .bus-label')) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false, target: e.target as Element };
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (drag) {
        const r = this.el.getBoundingClientRect();
        const k = Math.max(this.vb.w / r.width, this.vb.h / r.height);
        const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
        if (Math.abs(dx) + Math.abs(dy) > 0.2) drag.moved = true;
        this.vb.x = drag.vx - dx;
        this.vb.y = drag.vy - dy;
        this.applyViewBox();
        return;
      }
      this.hoverTip(e);
    });
    const end = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        const n = drag.target.closest('[data-net]');
        if (n) this.clickNet(Number(n.getAttribute('data-net')), drag.target);
        else {
          this.select(null);
          this.events.select(null);
          this.selectNet(-1);
        }
      }
      drag = null;
      if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('pointerleave', () => (this.tooltip.style.opacity = '0'));
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

interface TapLabel { pos: Vec; right: boolean; text: string; size: number }

/** Bit ranges carried by each splitter output / merger input, keyed by the net on the tap. */
function splitterTaps(nl: NonNullable<ReturnType<typeof netlistOf>>): Map<number, TapLabel[]> {
  const netOf = new Map<string, number>();
  nl.nets.forEach((n, i) => n.ends.forEach((e) => netOf.set(e, i)));
  const out = new Map<number, TapLabel[]>();
  for (const inst of nl.instances) {
    const k = inst.def.symbol.kind;
    if (k !== 'split' && k !== 'merge') continue;
    const size = Math.min(0.72, (inst.def.symbol.pitch ?? 2) * 0.4);
    let bit = 0;
    for (const p of inst.def.ports) {
      if ((k === 'split') !== (p.dir === 'out')) continue;
      const text = p.width === 1 ? `${bit}` : `${bit + p.width - 1}:${bit}`;
      bit += p.width;
      const net = netOf.get(`${inst.name}.${p.name}`);
      if (net === undefined) continue;
      const g = instPort(inst.def, inst.at ?? [0, 0], inst.flip, p.name);
      const list = out.get(net) ?? [];
      list.push({ pos: g.pos, right: g.exit === 'right', text, size });
      out.set(net, list);
    }
  }
  return out;
}
