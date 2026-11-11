// The learner's own arrangement of a drawn circuit (the stage): parts moved, wires reshaped, pointers
// (net tags) unravelled into wires and wires drawn as pointers, per component id, kept in localStorage,
// with undo / redo for this visit. Only the drawing changes: the nets keep their order and ends, so the
// simulation, net indices, probes and highlights are untouched. The learner's net colours live here too (hues):
// a colour belongs to the level it was set on, as a moved part does.

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
  /** netKey → the colour the learner picked for that net: an OKLCH hue (the sandbox's swatches, editor/wirehue.ts) or
   *  'auto' (its own colour-per-net hue, shown with that switch off too). Drawn as a user hue (nethue.ts USER_HUE). */
  hues?: Record<string, NetColour>;
  /** drawingKey of the drawing the moves and corners were made on: when the author redraws the level it no longer
   *  matches, and they are set aside (aside) rather than laid over a drawing they were not made for. */
  fp?: string;
  /** The learner's arrangement of an earlier drawing of this level, kept for one "Bring mine back". */
  aside?: Arrangement;
}

/** The part of a layout that belongs to one drawing: moved parts, reshaped wires, pointers unravelled or drawn. */
export type Arrangement = Pick<LayoutEdit, 'at' | 'wired' | 'tagged' | 'via' | 'fp'>;

/** A learner's net colour: a hue in degrees, or 'auto'. */
export type NetColour = number | 'auto';
/** A stored colour, or nothing when it is not one: a finite hue (taken mod 360) or 'auto'. */
export const netColour = (v: unknown): NetColour | undefined =>
  v === 'auto' ? 'auto' : typeof v === 'number' && Number.isFinite(v) ? ((v % 360) + 360) % 360 : undefined;

const KEY = 'mosfet2riscv:layouts:v1';
let all: Record<string, LayoutEdit> | null = null;

/** Moves, corners or pointers: what a redraw of the level sets aside (colours belong to nets and carry over). */
export const arranged = (e: Arrangement | undefined): boolean => !!e && (Object.keys(e.at).length > 0 || e.wired.length > 0 || e.tagged.length > 0 || !!e.via);
const empty = (e: LayoutEdit) => !arranged(e) && !e.hues && !e.aside;
const copyArr = (e: Arrangement): Arrangement => {
  const out: Arrangement = { at: { ...e.at }, wired: [...e.wired], tagged: [...e.tagged] };
  if (e.via) out.via = Object.fromEntries(Object.entries(e.via).map(([k, ends]) => [k, { ...ends }]));
  if (e.fp) out.fp = e.fp;
  return out;
};
const copy = (e: LayoutEdit | undefined): LayoutEdit => {
  const out: LayoutEdit = { at: { ...e?.at }, wired: [...e?.wired ?? []], tagged: [...e?.tagged ?? []] };
  if (e?.via) out.via = Object.fromEntries(Object.entries(e.via).map(([k, ends]) => [k, { ...ends }]));
  if (e?.hues) out.hues = { ...e.hues };
  if (e?.fp) out.fp = e.fp;
  if (e?.aside) out.aside = copyArr(e.aside);
  return out;
};
const keys = (v: unknown): string[] => Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
const isVec = (p: unknown): p is Vec => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

/** A net's sinks with corners left; none: no `via` at all. */
function tidyVia(e: Arrangement): void {
  for (const [k, ends] of Object.entries(e.via ?? {})) {
    for (const [end, pts] of Object.entries(ends)) if (!pts.length) delete ends[end];
    if (!Object.keys(ends).length) delete e.via![k];
  }
  if (e.via && !Object.keys(e.via).length) delete e.via;
}

/** An arrangement as stored, every field checked. */
function readArrangement(e: Partial<Arrangement> | undefined): Arrangement {
  const at: Record<string, Vec> = {};
  for (const [n, p] of Object.entries(e?.at ?? {})) {
    if (isVec(p)) at[n] = [p[0], p[1]];
  }
  const ed: Arrangement = { at, wired: keys(e?.wired), tagged: keys(e?.tagged) };
  if (e?.via && typeof e.via === 'object') {
    ed.via = {};
    for (const [k, ends] of Object.entries(e.via)) {
      ed.via[k] = {};
      for (const [end, pts] of Object.entries(ends ?? {})) if (Array.isArray(pts) && pts.every(isVec)) ed.via[k][end] = pts.map(([x, y]) => [x, y]);
    }
    tidyVia(ed);
  }
  if (typeof e?.fp === 'string') ed.fp = e.fp;
  return ed;
}

function store(): Record<string, LayoutEdit> {
  if (all) return all;
  all = {};
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') {
      for (const [id, e] of Object.entries(v as Record<string, Partial<LayoutEdit>>)) {
        const ed: LayoutEdit = readArrangement(e);
        if (e?.aside && typeof e.aside === 'object') {
          const a = readArrangement(e.aside);
          if (arranged(a)) ed.aside = a;
        }
        if (e?.hues && typeof e.hues === 'object') {
          const hues: Record<string, NetColour> = {};
          for (const [k, v] of Object.entries(e.hues)) { const c = netColour(v); if (c !== undefined) hues[k] = c; }
          if (Object.keys(hues).length) ed.hues = hues;
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
  if (e.hues && !Object.keys(e.hues).length) delete e.hues;
  // an arrangement belongs to the drawing it was made on (the one on screen: checkDrawing saw it)
  const fp = drawn.get(id);
  if (!arranged(e)) delete e.fp;
  else if (fp) e.fp = fp;
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

// The writes of the learner's colours (setColour, resetColours) are view/netcolours.ts: they load with the menu.

/** The arrangement as the chapter drew it (one undo step); the learner's colours stay. */
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

/** The drawing of each level shown this visit (drawingKey), set by checkDrawing: an edit is stamped with it. */
const drawn = new Map<string, string>();

/**
 * A short key of a level's drawing as its author placed it: instance names, places and turns, and each net's ends,
 * pointers and routing hints. Two drawings with the same key take the same arrangement; a redraw changes it.
 */
export function drawingKey(nl: Netlist): string {
  const parts = nl.instances.map((i) => [i.name, i.at ?? [0, 0], i.rot ?? 0, i.flip ? 1 : 0]);
  const nets = nl.nets.map((n) => [n.ends, isTagged(n) ? 1 : 0, n.trunk ?? null, n.via ?? null]);
  const text = JSON.stringify([parts, nets]);
  // FNV-1a twice with different primes: 64 bits tell one drawing of a level from the next
  let a = 0x811c9dc5, b = (0x01000193 ^ text.length) >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000197) >>> 0;
  }
  return a.toString(36) + '.' + b.toString(36);
}

/**
 * The level is about to be drawn from `nl` (its author's drawing): an arrangement made on another drawing of it is
 * set aside (kept in `aside` for one restore) and the new drawing shown. Pointers unravelled or drawn on nets the new
 * drawing still has stay, and so do colours. An arrangement saved before keys existed is taken as made on this
 * drawing. True when it set one aside just now.
 */
export function checkDrawing(id: string, nl: Netlist): boolean {
  const fp = drawingKey(nl);
  drawn.set(id, fp);
  const e = store()[id];
  if (!e || !arranged(e)) return false;
  if (!e.fp) {
    e.fp = fp;
    save();
    return false;
  }
  if (e.fp === fp) return false;
  const nets = new Set(nl.nets.map((n) => netKey(n)));
  e.aside = copyArr(e);
  e.at = {};
  delete e.via;
  e.wired = e.wired.filter((k) => nets.has(k));
  e.tagged = e.tagged.filter((k) => nets.has(k));
  if (arranged(e)) e.fp = fp;
  else delete e.fp;
  // the undo steps were made on the old drawing
  history.delete(id);
  save();
  return true;
}

/** An arrangement set aside by a redraw, if any. */
export const asideOf = (id: string): Arrangement | undefined => store()[id]?.aside;

/** The set-aside arrangement over the new drawing (one undo step); a part the redraw renamed is skipped by applyLayout. */
export function restoreAside(id: string): void {
  const a = asideOf(id);
  if (!a) return;
  editLayout(id, (e) => {
    const b = copyArr(a);
    e.at = b.at;
    e.wired = b.wired;
    e.tagged = b.tagged;
    if (b.via) e.via = b.via;
    else delete e.via;
    delete e.aside;
  });
}

/** Forget the set-aside arrangement. */
export function dropAside(id: string): void {
  const e = store()[id];
  if (!e?.aside) return;
  delete e.aside;
  put(id, e);
}

/** How much of the learner's arrangement a level shows: parts moved, wires reshaped, pointers changed. */
export function arrangedCount(e: LayoutEdit | undefined): { parts: number; wires: number; pointers: number } {
  return { parts: Object.keys(e?.at ?? {}).length, wires: Object.keys(e?.via ?? {}).length, pointers: (e?.wired.length ?? 0) + (e?.tagged.length ?? 0) };
}

/** Levels that carry an arrangement of the learner's or one set aside (colours alone do not count). */
export function arrangedLevels(): string[] {
  return Object.entries(store()).filter(([, e]) => arranged(e) || !!e.aside).map(([id]) => id);
}

/** Every level back to its author's drawing (colours stay); not undone. */
export function resetAllLayouts(): void {
  for (const id of arrangedLevels()) {
    const e = store()[id];
    e.at = {};
    e.wired = [];
    e.tagged = [];
    delete e.via;
    delete e.aside;
    history.delete(id);
    put(id, e);
  }
}

/** For tests: forget what was loaded, so the next read comes from storage again. */
export function reloadLayouts(): void {
  all = null;
  drawn.clear();
  history.clear();
}

/** Below this many screen pixels a press is still a click: a mouse as the sandbox's (editor/tools.ts DRAG_PX), a finger
 *  more, since it shakes. In pixels, not grid units: at fit on a big circuit a unit is a pixel or two. */
export const SLOP_PX = 4, SLOP_TOUCH_PX = 10;
export const pastSlop = (a: { clientX: number; clientY: number; pointerType: string }, b: { clientX: number; clientY: number }): boolean =>
  Math.abs(b.clientX - a.clientX) + Math.abs(b.clientY - a.clientY) >= (a.pointerType === 'touch' ? SLOP_TOUCH_PX : SLOP_PX);

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
  const hues = e.hues ?? {};
  if (!delta.size && !wired.size && !tagged.size && !e.via && !e.hues) return nl;
  const moved = (end: string) => delta.has(instOf(end) ?? '');
  const nets = nl.nets.map((n): NetDef => {
    const k = isTagged(n) ? null : netKey(n);
    const unravel = !k && wired.has(netKey(n));
    const ravel = !!k && tagged.has(k);
    const touches = n.ends.some(moved);
    const mine = own[netKey(n)], hue = hues[netKey(n)];
    if (!unravel && !ravel && !touches && !mine && hue === undefined) return n;
    const out: NetDef = { ...n };
    if (hue !== undefined) out.hue = hue;
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
