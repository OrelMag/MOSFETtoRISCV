// SVG drawings of every symbol kind, in grid units. Each returns a <g> whose origin is the
// symbol's top-left corner. Port positions match geometry.ts exactly.

import { symbolGeom } from '../sim/geometry';
import type { Category, ComponentDef } from '../sim/types';
import { s } from '../ui/dom';
import { type PinGeom, type Rect, textWidth } from './route';

const BUBBLE = 0.3;

/** Port names ending in _n are active-low: draw them with an overline. */
export function portLabel(name: string): SVGTSpanElement[] | string {
  if (name.endsWith('_n')) return [s('tspan', { 'text-decoration': 'overline' }, name.slice(0, -2))];
  return name;
}

function gateBody(kind: string, w: number, h: number): SVGElement[] {
  const inv = kind === 'nand' || kind === 'nor' || kind === 'xnor' || kind === 'not';
  const bw = w - (inv ? 2 * BUBBLE : 0);
  const els: SVGElement[] = [];
  let d: string;
  if (kind === 'and' || kind === 'nand') {
    const rx = Math.min(h / 2, bw * 0.55);
    d = `M0,0 H${bw - rx} A${rx},${h / 2} 0 0 1 ${bw - rx},${h} H0 Z`;
  } else if (kind === 'or' || kind === 'nor' || kind === 'xor' || kind === 'xnor') {
    const x0 = kind.startsWith('x') ? 0.45 : 0;
    d = `M${x0},0 Q${x0 + (bw - x0) * 0.6},0 ${bw},${h / 2} Q${x0 + (bw - x0) * 0.6},${h} ${x0},${h} Q${x0 + 0.55},${h / 2} ${x0},0 Z`;
    if (x0) els.push(s('path', { d: `M0,0 Q0.55,${h / 2} 0,${h}`, class: 'sym-line' }));
  } else {
    // not / buf triangle
    d = `M0,0 L${bw},${h / 2} L0,${h} Z`;
  }
  els.unshift(s('path', { d, class: 'sym-body' }));
  if (inv) els.push(s('circle', { cx: bw + BUBBLE, cy: h / 2, r: BUBBLE, class: 'sym-body' }));
  return els;
}

function transistor(def: ComponentDef): SVGElement[] {
  const p = def.symbol.kind === 'pmos';
  const gx = p ? 0.95 : 1.25; // gate plate x
  const els: SVGElement[] = [
    // gate lead and plate
    s('path', { d: `M0,2 H${p ? gx - 0.6 : gx}`, class: 'sym-line' }),
    s('path', { d: `M${gx},1 V3`, class: 'sym-line thick' }),
    // channel (class toggled when conducting)
    s('path', { d: 'M1.65,0.7 V3.3', class: 'sym-channel' }),
    // top and bottom terminals
    s('path', { d: 'M1.65,1 H3 V0', class: 'sym-line' }),
    s('path', { d: 'M1.65,3 H3 V4', class: 'sym-line' }),
  ];
  if (p) els.push(s('circle', { cx: gx - 0.3, cy: 2, r: 0.3, class: 'sym-body' }));
  // arrow on the source terminal: out of the channel for NMOS, into it for PMOS
  els.push(p
    ? s('path', { d: 'M2.55,0.75 L2.05,1 L2.55,1.25', class: 'sym-arrow' })
    : s('path', { d: 'M2.2,2.75 L2.7,3 L2.2,3.25', class: 'sym-arrow' }));
  return els;
}

/** A vertical resistor zig-zag at x = 1 from y0 to y1 (n half-waves), as path commands after a point at y0. */
function zigzag(y0: number, y1: number, n = 6, amp = 0.45): string {
  const d = (y1 - y0) / n;
  let p = '';
  for (let i = 0; i < n; i++) p += ` L${i % 2 ? 1 - amp : 1 + amp},${y0 + d * (i + 0.5)}`;
  return `${p} L1,${y1}`;
}

/** Ground below (1, y): the lead and three shrinking bars (as the GND symbol). */
const groundAt = (y: number) => `M1,${y} V${y + 0.55} M0.2,${y + 0.55} H1.8 M0.5,${y + 0.95} H1.5 M0.8,${y + 1.35} H1.2`;

/** Switch-level parts: resistor, pull-up / pull-down, capacitor, transmission gate, tri-states. */
function switchPart(k: string): SVGElement[] {
  const line = (d: string, thick = false) => s('path', { d, class: thick ? 'sym-line thick' : 'sym-line' });
  switch (k) {
    case 'res':
      return [line(`M1,0 V0.7${zigzag(0.7, 3.3)} V4`)];
    case 'pullup':
      return [line('M0.2,0.15 H1.8 M1,0.15 V0.7', true), line(`M1,0.7${zigzag(0.7, 3.3)} V4`)];
    case 'pulldown':
      return [line(`M1,0 V0.5${zigzag(0.5, 2.9)}`), line(groundAt(2.9), true)];
    case 'cap':
      // wide plates, then a small ground well below them, so it does not read as a ground symbol
      return [
        line('M1,0 V1.05 M1,1.55 V2.45'), line('M0,1.05 H2 M0,1.55 H2', true),
        line('M0.4,2.45 H1.6 M0.65,2.8 H1.35 M0.9,3.15 H1.1', true),
      ];
    case 'tgate':
      // two triangles back to back: an NMOS and a PMOS in parallel (en_n drives the PMOS)
      return [
        line('M0,2 H0.6 M3.4,2 H4 M2,0 V1.4 M2,3.2 V4'),
        s('path', { d: 'M0.6,0.8 L3.4,2 L0.6,3.2 Z', class: 'sym-body' }),
        s('path', { d: 'M3.4,0.8 L0.6,2 L3.4,3.2 Z', class: 'sym-line' }),
        s('circle', { cx: 2, cy: 2.9, r: 0.3, class: 'sym-body' }),
      ];
    case 'tribuf':
      return [line('M0,2 H0.5 M3.5,2 H4 M2,0 V1.25'), s('path', { d: 'M0.5,0.5 L3.5,2 L0.5,3.5 Z', class: 'sym-body' })];
    case 'triinv':
      return [
        line('M0,2 H0.5 M3.8,2 H4 M2,0 V1.33'), s('path', { d: 'M0.5,0.5 L3.2,2 L0.5,3.5 Z', class: 'sym-body' }),
        s('circle', { cx: 3.5, cy: 2, r: 0.3, class: 'sym-body' }),
      ];
  }
  return [];
}

/** Where an instance's name goes, relative to its symbol (null: rails and wiring are not named). */
export function instNameAt(def: ComponentDef): { x: number; y: number; anchor: 'start' | 'middle' } | null {
  if (def.prim === 'alias' || def.prim === 'vdd' || def.prim === 'gnd') return null;
  const k = def.symbol.kind, g = symbolGeom(def);
  if (k === 'nmos' || k === 'pmos') return { x: 3.4, y: 1.45, anchor: 'start' };
  if (k === 'box') return { x: 0.1, y: -0.45, anchor: 'start' };
  if (k === 'res' || k === 'pullup' || k === 'pulldown' || k === 'cap') return { x: 1.75, y: g.h / 2 + 0.3, anchor: 'start' };
  if (k === 'tgate' || k === 'tribuf' || k === 'triinv') return { x: 2.4, y: 0.95, anchor: 'start' };
  return { x: g.w / 2, y: -0.35, anchor: 'middle' };
}

/** Hue of a library box by its kind (styles: .sym.cat), so a schematic reads at a glance: the ALU
 *  green, memories amber, control blue. Wiring boxes and user chips (their own hue) are not tinted. */
export const CATEGORY_HUE: Partial<Record<Category, number>> = {
  transistor: 25, cell: 25, gate: 250, arithmetic: 145, routing: 185, sequential: 330, memory: 45, cpu: 215,
};

export function drawSymbol(def: ComponentDef, flip = false): SVGGElement {
  const g = symbolGeom(def);
  const k = def.symbol.kind;
  // A user chip's hue tints its box (styles: .sym.chip); lightness follows the theme. Library
  // boxes and muxes take their category's hue (.sym.cat: the setting can turn it off).
  const own = k === 'box' && def.symbol.color !== undefined ? def.symbol.color : null;
  const cat = own === null && (k === 'box' || k === 'mux') && def.prim !== 'alias' ? CATEGORY_HUE[def.category] ?? null : null;
  const root = s('g', own !== null ? { class: `sym kind-${k} chip`, style: `--chip-h:${own}` }
    : cat !== null ? { class: `sym kind-${k} cat`, style: `--chip-h:${cat}` } : { class: `sym kind-${k}` });
  const inner = s('g', flip ? { transform: `translate(${g.w},0) scale(-1,1)` } : null);
  root.append(inner);
  const { w, h } = g;

  switch (k) {
    case 'nand': case 'and': case 'or': case 'nor': case 'xor': case 'xnor': case 'not': case 'buf': {
      inner.append(...gateBody(k, w, h));
      // input stubs into curved backs
      if (k.includes('or')) {
        for (const p of def.ports.filter((q) => q.dir === 'in')) {
          const y = g.ports[p.name].pos[1];
          const x0 = k.startsWith('x') ? 0.45 : 0;
          const t = y / h;
          const curve = x0 + 0.55 * 2 * t * (1 - t) * 1.0 * 1; // depth of the back curve at y
          inner.append(s('path', { d: `M0,${y} H${curve + 0.05}`, class: 'sym-line' }));
        }
      }
      break;
    }
    case 'mux': {
      inner.append(s('path', { d: `M0,0 L${w},1 L${w},${h - 1} L0,${h} Z`, class: 'sym-body' }));
      const data = def.ports.filter((p) => p.dir === 'in' && (p.side ?? 'left') === 'left');
      data.forEach((p, i) => {
        const y = g.ports[p.name].pos[1];
        inner.append(s('text', { x: 0.45, y: y + 0.4, class: 'sym-tiny' }, String(i)));
      });
      for (const p of def.ports.filter((q) => q.side === 'bottom')) {
        const x = g.ports[p.name].pos[0];
        inner.append(s('path', { d: `M${x},${h - x / w} V${h}`, class: 'sym-line' }));
      }
      break;
    }
    case 'split': case 'merge': {
      const many = def.ports.filter((p) => (k === 'split' ? p.dir === 'out' : p.dir === 'in'));
      const one = def.ports.find((p) => (k === 'split' ? p.dir === 'in' : p.dir === 'out'))!;
      const ys = many.map((p) => g.ports[p.name].pos[1]);
      inner.append(s('path', { d: `M0.5,${Math.min(...ys) - 0.4} V${Math.max(...ys) + 0.4}`, class: 'sym-bus' }));
      const oy = g.ports[one.name].pos[1];
      inner.append(s('path', { d: k === 'split' ? `M0,${oy} H0.5` : `M0.5,${oy} H1`, class: 'sym-bus-stub' }));
      for (const y of ys) inner.append(s('path', { d: k === 'split' ? `M0.5,${y} H1` : `M0,${y} H0.5`, class: 'sym-tap' }));
      break;
    }
    case 'nmos': case 'pmos':
      inner.append(...transistor(def));
      // the type letter stays readable when the symbol is mirrored
      root.append(s('text', { x: flip ? w - 3.35 : 3.35, y: 2.35, class: 'sym-tiny', 'text-anchor': flip ? 'end' : 'start' }, k === 'pmos' ? 'P' : 'N'));
      break;
    case 'res': case 'pulldown': case 'cap': case 'tgate': case 'tribuf': case 'triinv':
      inner.append(...switchPart(k));
      break;
    case 'pullup':
      inner.append(...switchPart(k));
      root.append(s('text', { x: 1, y: -0.35, class: 'sym-rail', 'text-anchor': 'middle' }, 'VDD'));
      break;
    case 'vdd':
      inner.append(s('path', { d: 'M0.2,0.15 H1.8 M1,0.15 V1', class: 'sym-line thick' }));
      root.append(s('text', { x: 1, y: -0.35, class: 'sym-rail', 'text-anchor': 'middle' }, 'VDD'));
      break;
    case 'gnd':
      inner.append(s('path', { d: 'M1,0 V0.55 M0.2,0.55 H1.8 M0.5,0.95 H1.5 M0.8,1.35 H1.2', class: 'sym-line thick' }));
      break;
    default: {
      inner.append(s('rect', { x: 0, y: 0, width: w, height: h, rx: 0.6, class: 'sym-body sym-box' }));
      // Port names inside the box (not mirrored). Pure-wiring boxes are too small for them.
      for (const p of def.prim === 'alias' || def.symbol.noPortLabels ? [] : def.ports) {
        const pg = g.ports[p.name];
        const side = p.side ?? (p.dir === 'out' ? 'right' : 'left');
        let x = pg.pos[0], y = pg.pos[1] + 0.38;
        let anchor = 'start';
        if (side === 'left') x = 0.45;
        else if (side === 'right') { x = w - 0.45; anchor = 'end'; }
        else if (side === 'top') { y = 1.15; anchor = 'middle'; }
        else { y = h - 0.5; anchor = 'middle'; }
        if (flip && (side === 'left' || side === 'right')) {
          x = w - x;
          anchor = anchor === 'start' ? 'end' : 'start';
        }
        if (p.clock && (side === 'left' || side === 'bottom' || side === 'top')) {
          // clock triangle marker
          const cx = side === 'left' ? (flip ? w : 0) : pg.pos[0];
          const cy = side === 'left' ? pg.pos[1] : side === 'top' ? 0 : h;
          const d = side === 'left'
            ? (flip ? `M${cx},${cy - 0.5} L${cx - 0.7},${cy} L${cx},${cy + 0.5}` : `M${cx},${cy - 0.5} L${cx + 0.7},${cy} L${cx},${cy + 0.5}`)
            : side === 'bottom' ? `M${cx - 0.5},${cy} L${cx},${cy - 0.7} L${cx + 0.5},${cy}` : `M${cx - 0.5},${cy} L${cx},${cy + 0.7} L${cx + 0.5},${cy}`;
          root.append(s('path', { d, class: 'sym-line' }));
          if (side === 'left') x += flip ? -0.7 : 0.7;
          else if (side === 'bottom') y -= 0.6;
        }
        root.append(s('text', { x, y, class: 'sym-port', 'text-anchor': anchor }, portLabel(p.name)));
      }
      if (def.symbol.verticalLabel) {
        root.append(s('text', { x: w / 2, y: h / 2, class: 'sym-label', 'text-anchor': 'middle', transform: `rotate(-90 ${w / 2} ${h / 2})`, dy: 0.4 }, def.symbol.label ?? def.name));
      } else {
        root.append(s('text', { x: w / 2, y: h / 2 + 0.45, class: 'sym-label', 'text-anchor': 'middle' }, def.symbol.label ?? def.name));
      }
    }
  }
  return root;
}

export interface PinGlyph {
  g: SVGGElement;
  name: SVGTextElement;
  /** Value box of a bus pin (placed by placePinValue once the value is known). */
  value?: SVGTextElement;
  valueBg?: SVGRectElement;
  /** What the glyph may cover, with room for the widest value of its width. */
  bounds: Rect;
}

/** Steps from the pin back to its knob: the knob sits outside the circuit, opposite the exit. */
const pinBack = (pin: PinGeom): [number, number] =>
  [pin.exit === 'right' ? -1 : pin.exit === 'left' ? 1 : 0, pin.exit === 'down' ? -1 : pin.exit === 'up' ? 1 : 0];

/**
 * One of a component's own pins in its internal view: a stub from the pin to a knob (1 bit)
 * or a value box (bus), and the name beyond it, away from the circuit. Value classes are the
 * caller's (bitClass / busClass on the group).
 */
export function drawPinGlyph(pin: PinGeom, clickable: boolean): PinGlyph {
  const [px, py] = pin.pos;
  const [back, vert] = pinBack(pin);
  const cx = px + back * 0.9, cy = py + vert * 0.9;
  const isIn = pin.dir !== 'out';
  const g = s('g', { class: `pin ${isIn ? 'pin-in' : 'pin-out'}${clickable ? ' clickable' : ''}`, 'data-pin': pin.name });
  g.append(s('path', { d: `M${cx},${cy} L${px},${py}`, class: pin.width > 1 ? 'wire bus pin-stub' : 'wire pin-stub' }));
  let value: SVGTextElement | undefined, valueBg: SVGRectElement | undefined;
  if (pin.width === 1) {
    g.append(s('circle', { cx, cy, r: 0.8, class: 'pin-knob' }));
  } else {
    valueBg = s('rect', { class: 'pin-box', rx: 0.5, height: 1.6, y: cy - 0.8 });
    value = s('text', { class: 'pin-value', y: cy + 0.42, 'text-anchor': 'middle' });
    g.append(valueBg, value);
  }
  // Name label, away from the circuit (beyond the value box for buses; see placePinValue).
  const ax = back !== 0 ? cx + back * 1.3 : cx;
  const ay = vert !== 0 ? cy + vert * 1.6 + (vert > 0 ? 0.4 : 0) : cy + 0.42;
  const anchor = back > 0 ? 'start' : back < 0 ? 'end' : 'middle';
  const name = s('text', { class: 'pin-name', x: ax, y: ay, 'text-anchor': anchor }, portLabel(pin.name));
  g.append(name);
  const extra = textWidth(pin.name, 1.1) + 3 + (pin.width > 1 ? textWidth('0x'.padEnd(2 + Math.ceil(pin.width / 4), '0'), 1.05) : 0);
  const x0 = cx - 2 - (back < 0 ? extra : 0), x1 = cx + 2 + (back > 0 ? extra : 0);
  return { g, name, value, valueBg, bounds: { x: x0, y: cy - 2, w: x1 - x0, h: 4 } };
}

/** Show a bus pin's value text, sizing its box and pushing the name clear of it. */
export function placePinValue(pin: PinGeom, glyph: Pick<PinGlyph, 'name' | 'value' | 'valueBg'>, txt: string): void {
  if (!glyph.value || !glyph.valueBg) return;
  glyph.value.textContent = txt;
  const tw = Math.max(3, textWidth(txt, 1.05));
  const [back] = pinBack(pin);
  const cx = pin.pos[0] + back * 0.9;
  const bx = back < 0 ? cx - tw + 0.6 : back > 0 ? cx - 0.6 : cx - tw / 2;
  glyph.valueBg.setAttribute('x', String(bx));
  glyph.valueBg.setAttribute('width', String(tw));
  glyph.value.setAttribute('x', String(bx + tw / 2));
  if (back !== 0) glyph.name.setAttribute('x', String(back < 0 ? bx - 0.4 : bx + tw + 0.4));
}
