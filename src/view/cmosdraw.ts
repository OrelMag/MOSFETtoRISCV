// Working gates, drawn: the primitives of view/cmosgate.ts as SVG inside a gate's symbol (view/symbols.ts adds the
// group, so a flip or a turn carries it), and painted from the gate's input bits by SchematicView / EditorView after
// every repaint. Every colour is a class (styles/cmos.css): nets by level, transistors on / off / unknown. Hidden
// unless the setting is on and the view's scale gives the gate room (cmosLod: classes on the svg).

import type { ComponentDef } from '../sim/types';
import type { Bit } from '../sim/types';
import { CMOS_GATES, cmosLayout, cmosSolve, place, type CmosKind, type Level } from './cmosgate';

const NS = 'http://www.w3.org/2000/svg';
function s(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** The kind of a gate this draws, or null (other gates, 3- and 4-input gates, the relay / NMOS NANDs). */
export function cmosKindOf(def: ComponentDef): CmosKind | null {
  if (!CMOS_GATES.has(def.id)) return null;
  const ins = def.ports.filter((p) => p.dir !== 'out').length;
  return ins === (def.id === 'not' ? 1 : 2) ? (def.id as CmosKind) : null;
}

/** The inner drawing for a gate whose body is bw wide (to the bubble) and h high, or null. */
export function drawCmos(def: ComponentDef, bw: number, h: number): SVGGElement | null {
  const kind = cmosKindOf(def);
  if (!kind) return null;
  const l = cmosLayout(kind), p = place(l, bw, h);
  const root = s('g', { class: 'cmos', 'data-kind': kind, 'aria-hidden': 'true' }) as SVGGElement;
  const inner = s('g', { transform: `matrix(${p.sx},0,0,${p.sy},0,${p.oy})` });
  // strokes are given in reference units: undo the scale (the inverter is drawn at half size)
  inner.setAttribute('style', `--ck:${(1 / Math.min(p.sx, p.sy)).toFixed(3)}`);
  const flows: SVGElement[] = [];
  for (const q of l.prims) {
    if (q.t === 'rail') {
      const m = (q.x1 + q.x2) / 2;
      inner.append(s('path', { class: `crail ${q.kind}`, d: q.kind === 'hi' ? `M${q.x1},${q.y}H${q.x2}` : `M${q.x1},${q.y}H${q.x2}M${m - 0.1},${q.y + 0.08}H${m + 0.1}M${m - 0.045},${q.y + 0.15}H${m + 0.045}` }));
    } else if (q.t === 'wire') {
      inner.append(s('path', { class: 'cw', 'data-n': q.net, d: q.d }));
      flows.push(s('path', { class: 'cflow', 'data-n': q.net, d: q.d }));
    } else if (q.t === 'dot') inner.append(s('circle', { class: 'cdot', 'data-n': q.net, cx: q.at[0], cy: q.at[1], r: 0.055 }));
    else if (q.t === 'fet') {
      const g = s('g', { class: 'cfet', 'data-d': q.dev, 'data-n': q.net });
      const L = (q.y2 - q.y1) / 3, gx = q.x + q.side * 0.1, ym = (q.y1 + q.y2) / 2;
      g.append(s('path', { class: 'ch-glow', d: `M${q.x},${q.y1 + 0.05}V${q.y2 - 0.05}` }),
        s('path', { class: 'ch-on', d: `M${q.x},${q.y1}V${q.y2}` }),
        s('path', { class: 'ch-off', d: [0, 1, 2].map((i) => `M${q.x},${(q.y1 + i * L + 0.025).toFixed(3)}V${(q.y1 + (i + 1) * L - 0.025).toFixed(3)}`).join('') }),
        s('path', { class: 'plate', d: `M${gx},${q.y1 + 0.04}V${q.y2 - 0.04}` }));
      if (q.p) g.append(s('circle', { class: 'pbub', cx: q.x + q.side * 0.155, cy: ym, r: 0.045 }), s('path', { class: 'glead', d: `M${q.x + q.side * 0.2},${ym}H${q.x + q.side * 0.25}` }));
      else g.append(s('path', { class: 'glead', d: `M${gx},${ym}H${q.x + q.side * 0.25}` }));
      inner.append(g);
    } else {
      const w = 0.95 * q.s, r = 0.42 * q.s;
      const g = s('g', { class: 'cmini', 'data-n': q.out });
      g.append(s('path', { class: 'mbody', d: `M${q.x},${q.y}H${(q.x + w - r).toFixed(3)}A${r.toFixed(3)},${q.s / 2} 0 0 1 ${(q.x + w - r).toFixed(3)},${q.y + q.s}H${q.x}Z` }),
        s('circle', { class: 'mbub', cx: (q.x + w + 0.11 * q.s).toFixed(3), cy: q.y + q.s / 2, r: (0.11 * q.s).toFixed(3) }));
      inner.append(g);
    }
  }
  // pellets ride on top of every wire, as on the wires outside
  inner.append(...flows);
  root.append(inner);
  // the output wire is placed on the real body, so it ends exactly at its right edge (or the bubble)
  const pts = l.out.map(([x, y], i) => [i === l.out.length - 1 ? bw : x * p.sx, y * p.sy + p.oy]);
  const d = 'M' + pts.map(([x, y]) => `${+x.toFixed(3)},${+y.toFixed(3)}`).join('L');
  root.append(s('path', { class: 'cw cout', 'data-n': 'y', d }), s('path', { class: 'cflow cout', 'data-n': 'y', d }));
  return root;
}

const painted = new WeakMap<Element, string>();
const LEVELS = ['hi', 'lo', 'float', 'x'];

/** Paint a gate's inner drawing from its input bits (port order). Unchanged inputs: nothing to do. */
export function paintCmos(root: Element, ins: (Bit | undefined)[] | null): void {
  const key = ins ? ins.join(',') : '';
  if (painted.get(root) === key) return;
  painted.set(root, key);
  const kind = root.getAttribute('data-kind') as CmosKind;
  const st = ins && ins.every((b) => b !== undefined) ? cmosSolve(kind, ins as Bit[]) : null;
  // the output wire carries the last stage's net (before the bubble: XNOR's bricks compute XOR)
  const level = (n: string): Level | null => (!st ? null : st.nets[n === 'y' ? cmosLayout(kind).outNet : n] ?? null);
  for (const el of root.querySelectorAll('[data-n]')) {
    const n = el.getAttribute('data-n')!;
    const lv = level(n);
    el.classList.remove(...LEVELS);
    if (lv) el.classList.add(lv);
    if (el.classList.contains('cfet')) {
      const on = st ? st.on[el.getAttribute('data-d')!] : undefined;
      el.classList.toggle('on', on === 1);
      el.classList.toggle('maybe', on === 2);
    }
  }
}

/** Detail by scale (px per grid unit), as classes on the svg: transistors in full, simplified, or none (the gate as before). */
export const CMOS_FULL_PX = 22, CMOS_MID_PX = 11;
export function cmosLod(svg: Element, scale: number): void {
  if (!(scale > 0)) return;
  svg.classList.toggle('cmos-full', scale >= CMOS_FULL_PX);
  svg.classList.toggle('cmos-mid', scale >= CMOS_MID_PX && scale < CMOS_FULL_PX);
}
