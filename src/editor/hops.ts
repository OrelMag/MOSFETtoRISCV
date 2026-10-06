// Path data of the editor's wires (hops over crossings), recomputed incrementally. A wire's hops
// depend on its own polyline and on the vertical segments of the other nets it crosses, so when
// a drag moves a few wires only those, and the wires whose horizontal segments cross their old
// or new vertical segments, are recomputed (hopPathData's `only`). DOM-free: the view applies
// the strings; tests check that the result equals a full recompute.

import type { Vec } from '../sim/geometry';
import { hopPathData, type RoutedNet } from '../view/route';

export interface ShapeWire {
  id: string;
  /** Net group (wireGroups index): wires of one group do not hop each other. */
  group: number;
  /** Drawn polyline (null: an end does not resolve, nothing drawn). */
  poly: Vec[] | null;
}

const R = 0.45;
const keyOf = (p: Vec[] | null) => (p ? p.map(([x, y]) => `${x},${y}`).join(' ') : '');

/** Full recompute: path data of every wire (empty when it has no polyline). */
export function allHops(wires: ShapeWire[]): Map<string, string> {
  const nets: RoutedNet[] = [];
  const ids: string[] = [];
  for (const w of wires) {
    if (!w.poly) continue;
    nets.push(routed(w));
    ids.push(w.id);
  }
  const data = hopPathData(nets, [], R);
  const out = new Map<string, string>(wires.map((w) => [w.id, '']));
  ids.forEach((id, i) => out.set(id, data[i][0] ?? ''));
  return out;
}

const routed = (w: ShapeWire): RoutedNet => ({ index: w.group, width: 1, tags: [], paths: [w.poly!], dots: [], label: null, labelRoom: 0 });

export class HopCache {
  /** Path data of every wire. */
  readonly d = new Map<string, string>();
  private prev = new Map<string, { group: number; key: string; poly: Vec[] | null }>();
  /** Wires recomputed by the last update (for measurements and tests). */
  lastRecomputed = 0;

  /**
   * Bring the path data up to date with `wires`. Returns the ids whose path data changed
   * (including removed wires). A regrouping (connectivity changed) recomputes everything.
   */
  update(wires: ShapeWire[]): Set<string> {
    const prev = this.prev;
    const next = new Map(wires.map((w) => [w.id, { group: w.group, key: keyOf(w.poly), poly: w.poly }]));
    let full = prev.size === 0;
    const moved: (Vec[] | null)[] = [];
    const groups = new Set<number>();
    for (const [id, n] of next) {
      const p = prev.get(id);
      if (p && p.group !== n.group) { full = true; break; }
      if (!p || p.key !== n.key) {
        moved.push(n.poly, p?.poly ?? null);
        groups.add(n.group);
      }
    }
    for (const [id, p] of prev) if (!next.has(id)) moved.push(p.poly);
    this.prev = next;

    const changed = new Set<string>();
    for (const id of this.d.keys()) if (!next.has(id)) { this.d.delete(id); changed.add(id); }
    if (full) {
      for (const [id, d] of allHops(wires)) if (this.d.get(id) !== d) { this.d.set(id, d); changed.add(id); }
      this.lastRecomputed = wires.length;
      return changed;
    }
    if (!moved.length) { this.lastRecomputed = 0; return changed; }

    // Wires whose horizontal segments cross a vertical segment that moved (before or after).
    const verts: [number, number, number][] = [];
    for (const p of moved) {
      if (!p) continue;
      for (let i = 1; i < p.length; i++) {
        const [a, b] = [p[i - 1], p[i]];
        if (a[0] === b[0] && a[1] !== b[1]) verts.push([a[0], Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
      }
    }
    if (verts.length) {
      for (const w of wires) {
        if (!w.poly || groups.has(w.group)) continue;
        if (crossesAny(w.poly, verts)) groups.add(w.group);
      }
    }
    const nets: RoutedNet[] = [];
    const at = new Map<string, number>();
    for (const w of wires) {
      if (!w.poly) continue;
      at.set(w.id, nets.length);
      nets.push(routed(w));
    }
    const data = hopPathData(nets, [], R, groups);
    let n = 0;
    for (const w of wires) {
      if (!groups.has(w.group)) continue;
      n++;
      const i = at.get(w.id);
      const d = i === undefined ? '' : data[i][0] ?? '';
      if (this.d.get(w.id) !== d) { this.d.set(w.id, d); changed.add(w.id); }
    }
    this.lastRecomputed = n;
    return changed;
  }
}

/** Does a horizontal segment of `poly` cross (or touch) one of the vertical segments? A superset of a hop. */
function crossesAny(poly: Vec[], verts: [number, number, number][]): boolean {
  for (let i = 1; i < poly.length; i++) {
    const [a, b] = [poly[i - 1], poly[i]];
    if (a[1] !== b[1] || a[0] === b[0]) continue;
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y = a[1];
    for (const [x, y0, y1] of verts) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  }
  return false;
}
