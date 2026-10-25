// A state diagram drawn from an FsmSpec (lib/fsm.ts): states as pills or circles at their spec positions,
// transitions as curves clipped to the state outlines, self-loops, and returns along a shared rail.
// mark() lights the current state, the arc taken at the last edge, the arc the next edge takes, the
// path of states visited and a hovered state or arc; nothing is re-laid out.

import type { FsmArc, FsmSpec, FsmState } from '../lib/fsm';
import { s } from '../ui/dom';

export interface FsmMarks {
  cur?: number;
  /** Arc indices. */
  last?: number;
  next?: number;
  hoverArc?: number;
  hoverState?: number;
  /** States visited, in order (numbered badges). */
  trail?: number[];
}

export interface FsmDiagram {
  el: SVGSVGElement;
  mark(m: FsmMarks): void;
}

export interface FsmDiagramOptions {
  onArc?: (arc: number | null) => void;
  onState?: (state: number | null) => void;
}

let uid = 0;
const PILL_H = 26, R = 30;

function size(spec: FsmSpec, st: FsmState): [number, number] {
  return spec.shape === 'circle' ? [2 * R, 2 * R] : [Math.max(66, st.name.length * 7.6 + 20), PILL_H];
}

/** Where the line from a state's centre towards (tx, ty) leaves its outline. */
function edge(spec: FsmSpec, st: FsmState, tx: number, ty: number): [number, number] {
  const [x, y] = st.at, dx = tx - x, dy = ty - y, len = Math.hypot(dx, dy) || 1;
  if (spec.shape === 'circle') return [x + (dx / len) * R, y + (dy / len) * R];
  const [w, h] = size(spec, st);
  const k = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  return [x + dx * k, y + dy * k];
}

const f = (n: number) => n.toFixed(1);

/** Path and label position of an arc. */
function geometry(spec: FsmSpec, a: FsmArc): { d: string; lx: number; ly: number } {
  const A = spec.states[a.from], B = spec.states[a.to];
  if (a.rail && spec.rail) {
    const r = spec.rail, T = spec.states[r.to], [, h] = size(spec, A), [tw] = size(spec, T);
    return { d: `M${f(A.at[0])},${f(A.at[1] + h / 2)} V${r.y} H${r.x} V${T.at[1]} H${f(T.at[0] + tw / 2 + 1.5)}`, lx: r.labelX, ly: r.y };
  }
  if (a.from === a.to) {
    const th = ((a.loop ?? -90) * Math.PI) / 180, sp = 0.45, r = spec.shape === 'circle' ? R : PILL_H / 2;
    const p = (ang: number, d: number) => [A.at[0] + Math.cos(ang) * d, A.at[1] + Math.sin(ang) * d];
    const [sx, sy] = p(th - sp, r), [ex, ey] = p(th + sp, r + 1.5), [c1x, c1y] = p(th - 0.55, r * 2.5), [c2x, c2y] = p(th + 0.55, r * 2.5);
    const [lx, ly] = p(th, r * 2.2 + 8);
    return { d: `M${f(sx)},${f(sy)} C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(ex)},${f(ey)}`, lx, ly };
  }
  const [ax, ay] = A.at, [bx, by] = B.at, len = Math.hypot(bx - ax, by - ay) || 1, bend = a.bend ?? 0;
  const cx = (ax + bx) / 2 - ((by - ay) / len) * bend, cy = (ay + by) / 2 + ((bx - ax) / len) * bend;
  const [sx, sy] = edge(spec, A, cx, cy), [ex0, ey0] = edge(spec, B, cx, cy);
  // stop just short of the outline so the arrowhead's tip touches it
  const ul = Math.hypot(cx - ex0, cy - ey0) || 1, ex = ex0 + ((cx - ex0) / ul) * 1.5, ey = ey0 + ((cy - ey0) / ul) * 1.5;
  const t = a.t ?? 0.5, q = (p0: number, p1: number, p2: number) => (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
  return { d: `M${f(sx)},${f(sy)} Q${f(cx)},${f(cy)} ${f(ex)},${f(ey)}`, lx: q(sx, cx, ex) + (a.dx ?? 0), ly: q(sy, cy, ey) + (a.dy ?? 0) };
}

const fires = (a: FsmArc) => !!a.out && Object.values(a.out).some((v) => v === 1);

export function fsmDiagram(spec: FsmSpec, opts: FsmDiagramOptions = {}): FsmDiagram {
  const id = `fsm${uid++}`;
  const [W, H] = spec.size;
  const svg = s('svg', { class: 'fsm-dg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `State diagram: ${spec.title}` });
  const defs = s('defs');
  for (const k of ['base', 'acc', 'good', 'bad']) {
    defs.append(s('marker', { id: `${id}-${k}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse', class: `fsm-mk ${k}` },
      s('path', { d: 'M0,0 L10,5 L0,10 z' })));
  }
  svg.append(defs);
  const marker = (cls: string) => `url(#${id}-${/\bbad\b/.test(cls) ? 'bad' : /\b(last|next|hov)\b/.test(cls) ? 'acc' : /\bout\b/.test(cls) ? 'good' : 'base'})`;

  // reset entry arrow
  if (spec.entry) {
    const [x, y] = spec.entry, T = spec.states[spec.reset], [ex] = edge(spec, T, x, y);
    svg.append(s('path', { class: 'fsm-arc', d: `M${x},${y} H${f(ex - 1.5)}`, 'marker-end': marker('') }),
      s('text', { class: 'fsm-al', x: x + 4, y: y - 11 }, Object.keys(spec.resetIn ?? {}).join(' ') || 'reset'));
  }
  // the rail: drops with junction dots and one label (each rail arc is a full path on top, so one can be lit)
  const arcs = spec.arcs.map((a) => {
    const g = geometry(spec, a), base = `fsm-arc${a.cls ? ` ${a.cls}` : ''}${fires(a) ? ' out' : ''}`;
    const path = s('path', { class: base, d: g.d, 'marker-end': marker(base) });
    const hit = s('path', { class: 'fsm-hit', d: g.d });
    const label = a.label && !a.rail ? s('text', { class: `fsm-al${fires(a) ? ' out' : ''}${/\bbad\b/.test(a.cls ?? '') ? ' bad' : ''}`, x: f(g.lx), y: f(g.ly) }, a.label) : null;
    return { a, path, hit, label, base };
  });
  const railArcs = arcs.filter((x) => x.a.rail), plain = arcs.filter((x) => !x.a.rail);
  if (spec.rail && railArcs.length) {
    const r = spec.rail;
    svg.append(...railArcs.map((x) => x.path));
    for (const x of railArcs) svg.append(s('circle', { class: 'fsm-dot', cx: spec.states[x.a.from].at[0], cy: r.y, r: 2.6 }));
    svg.append(s('text', { class: 'fsm-al', x: r.labelX, y: r.y }, r.label));
  }
  svg.append(...plain.map((x) => x.path), ...arcs.map((x) => x.hit), ...plain.flatMap((x) => (x.label ? [x.label] : [])));

  const states = spec.states.map((st, i) => {
    const [w, hh] = size(spec, st), [x, y] = st.at;
    const shape = spec.shape === 'circle' ? s('circle', { cx: x, cy: y, r: R }) : s('rect', { x: f(x - w / 2), y: f(y - hh / 2), width: f(w), height: hh, rx: hh / 2 });
    const g = s('g', { class: `fsm-st${st.cls ? ` ${st.cls}` : ''}` }, shape,
      s('text', { class: 'n', x, y: spec.shape === 'circle' && (st.sub || (spec.codeBits && st.code >= 0)) ? y - 6 : y }, st.name));
    if (spec.shape === 'circle' && st.sub) g.append(s('text', { class: 'c sub', x, y: y + 11, textLength: st.sub.length > 11 ? 52 : null, lengthAdjust: 'spacingAndGlyphs' }, st.sub));
    else if (spec.shape === 'circle' && spec.codeBits && st.code >= 0) g.append(s('text', { class: 'c', x, y: y + 11 }, st.code.toString(2).padStart(spec.codeBits, '0')));
    const badge = s('g', { class: 'fsm-badge', transform: `translate(${f(x - w / 2 - 2)},${f(y - hh / 2 - 2)})` }, s('circle', { r: 8 }), s('text', { y: 0.5 }));
    badge.style.display = 'none';
    g.append(s('title', null, st.does ? `${st.name}: ${st.does}` : st.name));
    if (opts.onState) {
      g.addEventListener('mouseenter', () => opts.onState!(i));
      g.addEventListener('mouseleave', () => opts.onState!(null));
    }
    svg.append(g, badge);
    return { g, badge };
  });
  if (opts.onArc) {
    arcs.forEach((x, i) => {
      x.hit.addEventListener('mouseenter', () => opts.onArc!(i));
      x.hit.addEventListener('mouseleave', () => opts.onArc!(null));
    });
  }

  const mark = (m: FsmMarks) => {
    arcs.forEach((x, i) => {
      const cls = `${x.base}${i === m.last ? ' last' : ''}${i === m.next ? ' next' : ''}${i === m.hoverArc ? ' hov' : ''}`;
      x.path.setAttribute('class', cls);
      x.path.setAttribute('marker-end', marker(cls));
      // a lit rail arc is drawn over its neighbours
      if (x.a.rail && cls !== x.base) x.path.parentNode?.insertBefore(x.path, railArcs[railArcs.length - 1].path.nextSibling);
      x.label?.classList.toggle('acc', i === m.next || i === m.last || i === m.hoverArc);
    });
    const target = m.next !== undefined && m.next >= 0 ? spec.arcs[m.next].to : -1;
    const trail = m.trail ?? [];
    states.forEach((x, i) => {
      x.g.classList.toggle('cur', i === m.cur);
      x.g.classList.toggle('target', i === target && i !== m.cur);
      x.g.classList.toggle('hover', i === m.hoverState);
      const k = trail.lastIndexOf(i);
      x.g.classList.toggle('trail', k >= 0 && i !== m.cur);
      x.badge.style.display = k >= 0 ? '' : 'none';
      if (k >= 0) x.badge.querySelector('text')!.textContent = String(k + 1);
    });
  };
  mark({});
  return { el: svg, mark };
}
