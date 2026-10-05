// The schematic: one component's internal netlist drawn as SVG, with live wire values.
// Rendering builds the DOM once; update() only touches classes and labels.

import { symbolGeom, type Vec } from '../sim/geometry';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, BX, BZ, type Bit, netlistOf } from '../sim/types';
import { formatBits, type Radix } from '../sim/values';
import { icon, s } from '../ui/dom';
import type { ViewCtx } from './context';
import { routeNetlist, type PinGeom, type RoutedNet } from './route';
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
  dots: SVGCircleElement[];
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
  radix: Radix = 'hex';
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
    const nl = netlistOf(ctx.def);
    this.el.replaceChildren();
    this.wires = [];
    this.pins = [];
    this.insts.clear();
    if (!nl) return;
    const { nets, pins } = routeNetlist(ctx.def, nl);

    const defs = s('defs');
    defs.innerHTML = `<pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
      <circle cx="0" cy="0" r="0.06" class="grid-dot"/></pattern>`;
    this.el.append(defs);
    const gridRect = s('rect', { class: 'grid-bg', x: -500, y: -500, width: 1000, height: 1000, fill: 'url(#grid)' });
    const wiresG = s('g', { class: 'wires' });
    const instG = s('g', { class: 'insts' });
    const pinG = s('g', { class: 'pins' });
    const labelG = s('g', { class: 'labels' });
    this.el.append(gridRect, wiresG, instG, pinG, labelG);

    // Bounding box of everything drawn.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };

    // Wires
    for (const net of nets) {
      const cls = net.width > 1 ? 'wire bus' : 'wire';
      const w: WireEls = { net, paths: [], dots: [] };
      for (const p of net.paths) {
        p.forEach(([x, y]) => grow(x, y));
        const d = 'M' + p.map(([x, y]) => `${x},${y}`).join(' L');
        const path = s('path', { d, class: cls, 'data-net': net.index });
        w.paths.push(path);
        wiresG.append(path);
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
      const dcls = `dot ${w.net.width > 1 ? busClass(bits) : bitClass(bits[0])}`;
      for (const d of w.dots) d.setAttribute('class', dcls);
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
  }

  get selection(): string | null {
    return this.selected;
  }

  // ---- pan & zoom ---------------------------------------------------------------------

  fit(): void {
    const r = this.host.getBoundingClientRect();
    const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 10;
    let { x, y, w, h } = this.bbox;
    // Never zoom in so far that a tiny circuit looks cartoonish.
    const minW = 34;
    if (w < minW) { x -= (minW - w) / 2; w = minW; }
    if (w / h > aspect) {
      const nh = w / aspect; y -= (nh - h) / 2; h = nh;
    } else {
      const nw = h * aspect; x -= (nw - w) / 2; w = nw;
    }
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
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      this.zoom(Math.exp(e.deltaY * 0.0015), wx, wy);
    }, { passive: false });
    this.el.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('.inst, .pin.clickable, .bus-label')) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false };
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
        this.select(null);
        this.events.select(null);
      }
      drag = null;
      if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('pointerleave', () => (this.tooltip.style.opacity = '0'));
  }

  private hoverTip(e: PointerEvent): void {
    const t = (e.target as Element).closest('[data-net]');
    if (!t || !this.ctx) {
      this.tooltip.style.opacity = '0';
      return;
    }
    const idx = Number(t.getAttribute('data-net'));
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
