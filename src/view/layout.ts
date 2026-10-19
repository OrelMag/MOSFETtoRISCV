// The learner's own arrangement of a drawn circuit (the stage): parts moved, pointers (net tags)
// unravelled into wires and wires drawn as pointers, per component id, kept in localStorage, with
// undo / redo for this visit. Only the drawing changes: the nets keep their order and ends, so the
// simulation, net indices, probes and highlights are untouched.

import type { Vec } from '../sim/geometry';
import type { NetDef, Netlist } from '../sim/types';
import { netKey } from './nethue';

export interface LayoutEdit {
  /** Instance name → its new top-left (grid units). */
  at: Record<string, Vec>;
  /** netKey of every tagged net drawn as wires instead. */
  wired: string[];
  /** netKey of every wired net drawn as pointers instead (a pointer at each of its ends). */
  tagged: string[];
}

const KEY = 'mosfet2riscv:layouts:v1';
let all: Record<string, LayoutEdit> | null = null;

const empty = (e: LayoutEdit) => !Object.keys(e.at).length && !e.wired.length && !e.tagged.length;
const copy = (e: LayoutEdit | undefined): LayoutEdit => ({ at: { ...e?.at }, wired: [...e?.wired ?? []], tagged: [...e?.tagged ?? []] });
const keys = (v: unknown): string[] => Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];

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
          if (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) at[n] = [p[0], p[1]];
        }
        const ed = { at, wired: keys(e?.wired), tagged: keys(e?.tagged) };
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
 */
export function applyLayout(nl: Netlist, e: LayoutEdit | undefined): Netlist {
  if (!e) return nl;
  const wired = new Set(e.wired), tagged = new Set(e.tagged);
  const delta = new Map<string, Vec>();
  const instances = nl.instances.map((i) => {
    const to = e.at[i.name];
    const from = i.at ?? [0, 0];
    if (!to || (to[0] === from[0] && to[1] === from[1])) return i;
    delta.set(i.name, [to[0] - from[0], to[1] - from[1]]);
    return { ...i, at: to };
  });
  if (!delta.size && !wired.size && !tagged.size) return nl;
  const moved = (end: string) => delta.has(instOf(end) ?? '');
  const nets = nl.nets.map((n): NetDef => {
    const k = isTagged(n) ? null : netKey(n);
    const unravel = !k && wired.has(netKey(n));
    const ravel = !!k && tagged.has(k);
    const touches = n.ends.some(moved);
    if (!unravel && !ravel && !touches) return n;
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
    return out;
  });
  return { ...nl, instances, nets };
}
