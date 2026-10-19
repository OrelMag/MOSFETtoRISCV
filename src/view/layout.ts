// The learner's own arrangement of a drawn circuit (the stage): parts moved, wires reshaped, pointers
// (net tags) unravelled into wires and wires drawn as pointers, per component id, kept in localStorage,
// with undo / redo for this visit. Only the drawing changes: the nets keep their order and ends, so the
// simulation, net indices, probes and highlights are untouched.

import type { Vec } from '../sim/geometry';
import type { NetDef, Netlist } from '../sim/types';
import { netKey } from './nethue';
import { simplify } from './route';

export interface LayoutEdit {
  /** Instance name → its new top-left (grid units). */
  at: Record<string, Vec>;
  /** netKey of every tagged net drawn as wires instead. */
  wired: string[];
  /** netKey of every wired net drawn as pointers instead (a pointer at each of its ends). */
  tagged: string[];
  /** netKey → sink end → the corners of the wire to that sink, as the learner dragged it (NetDef.via). */
  via?: Record<string, Record<string, Vec[]>>;
}

const KEY = 'mosfet2riscv:layouts:v1';
let all: Record<string, LayoutEdit> | null = null;

const empty = (e: LayoutEdit) => !Object.keys(e.at).length && !e.wired.length && !e.tagged.length && !e.via;
const copy = (e: LayoutEdit | undefined): LayoutEdit => {
  const out: LayoutEdit = { at: { ...e?.at }, wired: [...e?.wired ?? []], tagged: [...e?.tagged ?? []] };
  if (e?.via) out.via = Object.fromEntries(Object.entries(e.via).map(([k, ends]) => [k, { ...ends }]));
  return out;
};
const keys = (v: unknown): string[] => Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
const isVec = (p: unknown): p is Vec => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

/** A net's sinks with corners left; none: no `via` at all. */
function tidyVia(e: LayoutEdit): void {
  for (const [k, ends] of Object.entries(e.via ?? {})) {
    for (const [end, pts] of Object.entries(ends)) if (!pts.length) delete ends[end];
    if (!Object.keys(ends).length) delete e.via![k];
  }
  if (e.via && !Object.keys(e.via).length) delete e.via;
}

function store(): Record<string, LayoutEdit> {
  if (all) return all;
  all = {};
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') {
      for (const [id, e] of Object.entries(v as Record<string, Partial<LayoutEdit>>)) {
        const at: Record<string, Vec> = {};
        for (const [n, p] of Object.entries(e?.at ?? {})) {
          if (isVec(p)) at[n] = [p[0], p[1]];
        }
        const ed: LayoutEdit = { at, wired: keys(e?.wired), tagged: keys(e?.tagged) };
        if (e?.via && typeof e.via === 'object') {
          ed.via = {};
          for (const [k, ends] of Object.entries(e.via)) {
            ed.via[k] = {};
            for (const [end, pts] of Object.entries(ends ?? {})) if (Array.isArray(pts) && pts.every(isVec)) ed.via[k][end] = pts.map(([x, y]) => [x, y]);
          }
          tidyVia(ed);
        }
        if (!empty(ed)) all[id] = ed;
      }
    }
  } catch { /* unreadable: start over */ }
  return all;
}

function save(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(store()));
  } catch { /* full or blocked: the layout lasts for this visit */ }
}

/** The learner's edits to a component's drawing, if any. */
export function layoutOf(id: string): LayoutEdit | undefined {
  return store()[id];
}

/** Undo / redo per component: the layouts before (past) and after (future) each edit, this visit only. */
const history = new Map<string, { past: LayoutEdit[]; future: LayoutEdit[] }>();
const HISTORY_MAX = 100;

function put(id: string, e: LayoutEdit): void {
  e.wired = [...new Set(e.wired)];
  e.tagged = [...new Set(e.tagged)];
  tidyVia(e);
  if (empty(e)) delete store()[id];
  else store()[id] = e;
  save();
}

/** Change a component's layout (one undo step); an edit left empty is dropped. */
export function editLayout(id: string, f: (e: LayoutEdit) => void): void {
  const before = copy(layoutOf(id));
  const e = copy(before);
  f(e);
  const h = history.get(id) ?? { past: [], future: [] };
  h.past.push(before);
  if (h.past.length > HISTORY_MAX) h.past.shift();
  h.future = [];
  history.set(id, h);
  put(id, e);
}

export function resetLayout(id: string): void {
  editLayout(id, (e) => {
    e.at = {};
    e.wired = [];
    e.tagged = [];
    delete e.via;
  });
}

export const canUndo = (id: string): boolean => !!history.get(id)?.past.length;
export const canRedo = (id: string): boolean => !!history.get(id)?.future.length;

/** Step back (or forward again) through this component's layout edits; false when there is none. */
export function undoLayout(id: string, redo = false): boolean {
  const h = history.get(id);
  const from = redo ? h?.future : h?.past;
  const e = from?.pop();
  if (!h || !e) return false;
  (redo ? h.past : h.future).push(copy(layoutOf(id)));
  put(id, e);
  return true;
}

/** Take back the last edit as if it had not been made (nothing to redo): one that changed nothing on screen. */
export function dropLastEdit(id: string): void {
  const e = history.get(id)?.past.pop();
  if (e) put(id, e);
}

/** A net drawn with tags (pointers) by its author. */
export const isTagged = (n: NetDef): boolean => n.tags === true || (n.tags?.length ?? 0) > 0;

/** A net drawn with tags now: its author's, unless unravelled, or the learner's. */
export function showsTags(n: NetDef, e: LayoutEdit | undefined): boolean {
  const k = netKey(n);
  return isTagged(n) ? !e?.wired.includes(k) : !!e?.tagged.includes(k);
}

const instOf = (end: string): string | null => {
  const i = end.indexOf('.');
  return i < 0 ? null : end.slice(0, i);
};

/**
 * The netlist as the learner arranged it. A moved part's nets lose the author's routing hints that
 * no longer fit (the trunk, corners to or from it) and their hand-placed tags move with it. A wire the
 * learner drew as pointers gets one at every end, named for its driver when its author gave it no name.
 * A wire the learner reshaped takes their corners over the author's.
 */
export function applyLayout(nl: Netlist, e: LayoutEdit | undefined): Netlist {
  if (!e) return nl;
  const wired = new Set(e.wired), tagged = new Set(e.tagged), own = e.via ?? {};
  const delta = new Map<string, Vec>();
  const instances = nl.instances.map((i) => {
    const to = e.at[i.name];
    const from = i.at ?? [0, 0];
    if (!to || (to[0] === from[0] && to[1] === from[1])) return i;
    delta.set(i.name, [to[0] - from[0], to[1] - from[1]]);
    return { ...i, at: to };
  });
  if (!delta.size && !wired.size && !tagged.size && !e.via) return nl;
  const moved = (end: string) => delta.has(instOf(end) ?? '');
  const nets = nl.nets.map((n): NetDef => {
    const k = isTagged(n) ? null : netKey(n);
    const unravel = !k && wired.has(netKey(n));
    const ravel = !!k && tagged.has(k);
    const touches = n.ends.some(moved);
    const mine = own[netKey(n)];
    if (!unravel && !ravel && !touches && !mine) return n;
    const out: NetDef = { ...n };
    if (unravel) {
      delete out.tags;
      delete out.tagAt;
    }
    if (ravel) {
      out.tags = true;
      out.name ??= n.ends[0];
      delete out.trunk;
      delete out.via;
    }
    if (touches) {
      delete out.trunk;
      if (out.via) {
        // corners were drawn for the driver and that sink where they were
        const via = moved(n.ends[0]) ? {} : Object.fromEntries(Object.entries(out.via).filter(([end]) => !moved(end)));
        if (Object.keys(via).length) out.via = via;
        else delete out.via;
      }
      if (out.tagAt) {
        out.tagAt = Object.fromEntries(Object.entries(out.tagAt).map(([end, p]) => {
          const d = delta.get(instOf(end) ?? '');
          return [end, p && d ? [p[0] + d[0], p[1] + d[1]] as Vec : p];
        }));
      }
    }
    if (mine && !ravel) out.via = { ...out.via, ...mine };
    return out;
  });
  return { ...nl, instances, nets };
}

/**
 * The learner's corners that no longer fit once these parts move: every wire of a net they drive, and the
 * wires into them. (An author's corners are dropped by applyLayout, which sees where the parts were drawn.)
 */
export function dropCorners(e: LayoutEdit, nl: Netlist, parts: Iterable<string>): void {
  if (!e.via) return;
  // the edit may share its sinks' records with another layout (a drag's preview)
  e.via = Object.fromEntries(Object.entries(e.via).map(([k, ends]) => [k, { ...ends }]));
  const set = new Set(parts);
  const moved = (end: string) => set.has(instOf(end) ?? '');
  for (const n of nl.nets) {
    const ends = e.via[netKey(n)];
    if (!ends) continue;
    for (const end of Object.keys(ends)) if (moved(n.ends[0]) || moved(end)) delete ends[end];
  }
  tidyVia(e);
}

/** Orientation of a segment: horizontal, vertical, or none (a point, or slanted). */
export const segAxis = (a: Vec, b: Vec): 'h' | 'v' | null => (a[1] === b[1] && a[0] !== b[0] ? 'h' : a[0] === b[0] && a[1] !== b[1] ? 'v' : null);

/**
 * Moves segment k of an orthogonal polyline across its direction by `by` (a horizontal one down, a vertical one
 * right). Its neighbours stretch; at an end of the wire a stub of up to one unit stays on the pin, in the
 * direction the wire left (or entered) it, and a short leg joins it to the moved segment.
 */
export function shiftSegment(poly: Vec[], k: number, by: number): Vec[] {
  const o = segAxis(poly[k], poly[k + 1]);
  if (!o || !by) return poly;
  const ax = o === 'h' ? 1 : 0;
  const q = poly.map((p): Vec => [p[0], p[1]]);
  const toward = (from: Vec, to: Vec): Vec => {
    const len = Math.abs(to[1 - ax] - from[1 - ax]), s = Math.min(1, len / 2) * Math.sign(to[1 - ax] - from[1 - ax]);
    return ax ? [from[0] + s, from[1]] : [from[0], from[1] + s];
  };
  if (k + 1 === q.length - 1) {
    const b = toward(q[k + 1], q[k]);
    q.splice(k + 1, 0, b, [b[0], b[1]]);
  }
  if (k === 0) {
    const a = toward(q[0], q[1]);
    q.splice(1, 0, a, [a[0], a[1]]);
    k = 2;
  }
  q[k][ax] += by;
  q[k + 1][ax] += by;
  return simplify(q);
}

/**
 * Drag one segment of a net's wire (path `pi`, segment `k`) across its direction by `by`. The net's paths share
 * their trunk from the driver, so the line drawn on screen is the run of their segments on the grabbed one's line
 * that overlap or touch it, one after another: all of it moves, the wire as one. Returns the net's paths (a moved
 * one is a new array); `fixed` paths (a stub to a hand-placed tag) stay.
 */
export function dragSegment(paths: Vec[][], pi: number, k: number, by: number, fixed: (i: number) => boolean = () => false): Vec[][] {
  const [a, b] = [paths[pi][k], paths[pi][k + 1]];
  const o = segAxis(a, b);
  if (!o || !by) return paths;
  const ax = o === 'h' ? 1 : 0, at = a[ax];
  const on = paths.map((p, i) => fixed(i) ? [] : p.flatMap((c, s) => s + 1 < p.length && segAxis(c, p[s + 1]) === o && c[ax] === at
    ? [{ s, lo: Math.min(c[1 - ax], p[s + 1][1 - ax]), hi: Math.max(c[1 - ax], p[s + 1][1 - ax]) }] : []));
  let lo = Math.min(a[1 - ax], b[1 - ax]), hi = Math.max(a[1 - ax], b[1 - ax]);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of on.flat()) {
      if (g.hi < lo || g.lo > hi || (g.lo >= lo && g.hi <= hi)) continue;
      lo = Math.min(lo, g.lo);
      hi = Math.max(hi, g.hi);
      grew = true;
    }
  }
  return paths.map((p, i) => {
    // one segment per path: after the first shift the indices of the rest move
    const j = i === pi ? k : on[i].find((g) => g.hi >= lo && g.lo <= hi)?.s ?? -1;
    return j < 0 ? p : shiftSegment(p, j, by);
  });
}

/** The segment of a net's paths nearest to p (grid units), within `reach`; `fixed` paths are skipped. */
export function nearestSegment(paths: Vec[][], p: Vec, reach = 0.7, fixed: (i: number) => boolean = () => false): { pi: number; k: number; axis: 'h' | 'v' } | null {
  let best: { pi: number; k: number; axis: 'h' | 'v' } | null = null, bestD = reach;
  paths.forEach((q, pi) => {
    if (fixed(pi)) return;
    for (let k = 0; k + 1 < q.length; k++) {
      const axis = segAxis(q[k], q[k + 1]);
      if (!axis) continue;
      const ax = axis === 'h' ? 0 : 1;
      const lo = Math.min(q[k][ax], q[k + 1][ax]), hi = Math.max(q[k][ax], q[k + 1][ax]);
      const along = Math.max(lo - p[ax], 0, p[ax] - hi), across = Math.abs(p[1 - ax] - q[k][1 - ax]);
      const d = Math.hypot(along, across);
      if (d < bestD) {
        bestD = d;
        best = { pi, k, axis };
      }
    }
  });
  return best;
}
