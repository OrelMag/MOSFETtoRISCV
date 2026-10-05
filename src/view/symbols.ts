// SVG drawings of every symbol kind, in grid units. Each returns a <g> whose origin is the
// symbol's top-left corner. Port positions match geometry.ts exactly.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import { s } from '../ui/dom';

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
  els.push(s('text', { x: 3.35, y: 2.35, class: 'sym-tiny' }, p ? 'P' : 'N'));
  return els;
}

export function drawSymbol(def: ComponentDef, flip = false): SVGGElement {
  const g = symbolGeom(def);
  const k = def.symbol.kind;
  const root = s('g', { class: `sym kind-${k}` });
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
      // Port names inside the box (not mirrored).
      for (const p of def.ports) {
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
      root.append(s('text', { x: w / 2, y: h / 2 + 0.45, class: 'sym-label', 'text-anchor': 'middle' }, def.symbol.label ?? def.name));
    }
  }
  return root;
}
