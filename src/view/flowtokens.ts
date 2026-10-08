// Values riding along buses, like packets in a pipe: small upright tags with the bus's value,
// spaced along every lane (a polyline from the driver's side) and moved by one shared
// requestAnimationFrame loop. Positions come from the polylines (no layout queries), and a
// tag's distance from the driver is a function of time alone, so a tag reaching a junction
// carries on along every branch. Tags fade in at the driver and out at a sink, as if leaving and
// entering the ports, but never at a junction: there they pass straight on to every branch. A view owns one FlowTokens per layer; once the layer leaves the document
// the loop forgets it.

import type { Vec } from '../sim/geometry';
import { s } from '../ui/dom';
import { FLOW_SPEED } from './flow';
import { textWidth } from './route';

/**
 * A stretch of wire: points from the end nearer the driver, `d0` its distance from the driver.
 * `sink` false: the signal carries on past the far end (a junction), so tags do not fade there.
 */
export interface Lane { pts: Vec[]; d0: number; sink?: boolean }

const FONT = 0.78, H = 1.15, GAP = 5, FADE = 1.5;

export interface Track { pts: Vec[]; cum: number[]; len: number; d0: number; sink: boolean }
interface Entry { g: SVGGElement; lanes: readonly Lane[]; tracks: Track[]; text: string; w: number; spacing: number; pool: SVGGElement[] }

const live = new Set<FlowTokens>();
let raf = 0;
const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

function loop(t: number): void {
  raf = 0;
  const on = document.documentElement.getAttribute('data-wireflow') !== 'off' && !motion?.matches;
  for (const ft of live) {
    if (!ft.layer.isConnected || !ft.size) live.delete(ft);
    else if (on) ft.tick(t / 1000);
  }
  if (live.size) raf = requestAnimationFrame(loop);
}

export class FlowTokens {
  private entries = new Map<string | number, Entry>();

  constructor(readonly layer: SVGGElement) {}

  get size(): number {
    return this.entries.size;
  }

  /** Show `text` riding along `lanes` (null: nothing). Same lanes (identity) keep their tags. */
  set(id: string | number, lanes: readonly Lane[] | null, text: string | null): void {
    let e = this.entries.get(id);
    if (!lanes || !lanes.length || text === null) {
      if (e) {
        e.g.remove();
        this.entries.delete(id);
      }
      return;
    }
    if (!e) {
      e = { g: s('g', { class: 'flow-tokens' }), lanes: [], tracks: [], text: '', w: 0, spacing: 0, pool: [] };
      this.layer.append(e.g);
      this.entries.set(id, e);
    }
    if (e.lanes !== lanes) {
      e.lanes = lanes;
      e.tracks = lanes.map(track);
    }
    if (e.text !== text) {
      e.text = text;
      e.w = textWidth(text, FONT) - 0.2;
      e.spacing = e.w + GAP;
      for (const g of e.pool) this.label(g, e);
    }
    live.add(this);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  /** Hide a net's tags while it is faded by a focus highlight. */
  fade(id: string | number, on: boolean): void {
    this.entries.get(id)?.g.classList.toggle('faded', on);
  }

  /** Place every tag for time t (seconds). */
  tick(t: number): void {
    for (const e of this.entries.values()) {
      if (e.g.classList.contains('faded')) continue;
      let used = 0;
      for (const tr of e.tracks) {
        for (const { x, y, op } of tagsOn(tr, e.spacing, t)) {
          let g = e.pool[used];
          if (!g) {
            g = s('g', { class: 'flow-token' });
            g.append(s('rect'), s('text', { 'text-anchor': 'middle', y: FONT * 0.36 }));
            this.label(g, e);
            e.pool.push(g);
            e.g.append(g);
          }
          used++;
          g.setAttribute('transform', `translate(${x.toFixed(3)},${y.toFixed(3)})`);
          g.setAttribute('opacity', op.toFixed(2));
          g.removeAttribute('display');
        }
      }
      for (let i = used; i < e.pool.length; i++) e.pool[i].setAttribute('display', 'none');
    }
  }

  private label(g: SVGGElement, e: Entry): void {
    const [rect, text] = g.children as unknown as [SVGRectElement, SVGTextElement];
    rect.setAttribute('x', String(-e.w / 2));
    rect.setAttribute('y', String(-H / 2));
    rect.setAttribute('width', String(e.w));
    rect.setAttribute('height', String(H));
    rect.setAttribute('rx', String(H / 2));
    text.textContent = e.text;
  }
}

export function track({ pts, d0, sink }: Lane): Track {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1], d0, sink: sink !== false };
}

/**
 * Tags on a track at time t (seconds), `spacing` apart: wherever the distance from the driver
 * is ≡ speed·t (mod spacing). `at` is the distance along the track, `op` the opacity (fading at
 * the driver and at a sink only).
 */
export function tagsOn(tr: Track, spacing: number, t: number): { at: number; x: number; y: number; op: number }[] {
  const out: { at: number; x: number; y: number; op: number }[] = [];
  let s0 = (FLOW_SPEED * t - tr.d0) % spacing;
  if (s0 < 0) s0 += spacing;
  for (let at = s0; at <= tr.len; at += spacing) {
    const op = Math.min(1, tr.d0 === 0 ? at / FADE : 1, tr.sink ? (tr.len - at) / FADE : 1);
    if (op <= 0.02) continue;
    const [x, y] = pointAt(tr, at);
    out.push({ at, x, y, op });
  }
  return out;
}

function pointAt(tr: Track, at: number): Vec {
  const { pts, cum } = tr;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < at) i++;
  const [a, b] = [pts[i - 1], pts[i]];
  const l = cum[i] - cum[i - 1] || 1;
  const f = (at - cum[i - 1]) / l;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
