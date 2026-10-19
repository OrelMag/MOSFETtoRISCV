// The learner's own arrangement of a drawn circuit (the stage): parts moved and pointers (net tags)
// unravelled into wires, per component id, kept in localStorage. Only the drawing changes: the nets
// keep their order and ends, so the simulation, net indices, probes and highlights are untouched.

import type { Vec } from '../sim/geometry';
import type { NetDef, Netlist } from '../sim/types';
import { netKey } from './nethue';

export interface LayoutEdit {
  /** Instance name → its new top-left (grid units). */
  at: Record<string, Vec>;
  /** netKey of every tagged net drawn as wires instead. */
  wired: string[];
}

const KEY = 'mosfet2riscv:layouts:v1';
let all: Record<string, LayoutEdit> | null = null;

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
        const wired = Array.isArray(e?.wired) ? e.wired.filter((k): k is string => typeof k === 'string') : [];
        if (Object.keys(at).length || wired.length) all[id] = { at, wired };
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

/** Change a component's layout; an edit left empty is dropped. */
export function editLayout(id: string, f: (e: LayoutEdit) => void): void {
  const st = store();
  const e = st[id] ?? { at: {}, wired: [] };
  f(e);
  e.wired = [...new Set(e.wired)];
  if (Object.keys(e.at).length || e.wired.length) st[id] = e;
  else delete st[id];
  save();
}

export function resetLayout(id: string): void {
  editLayout(id, (e) => {
    e.at = {};
    e.wired = [];
  });
}

/** A net drawn with tags (pointers) by its author. */
export const isTagged = (n: NetDef): boolean => n.tags === true || (n.tags?.length ?? 0) > 0;

const instOf = (end: string): string | null => {
  const i = end.indexOf('.');
  return i < 0 ? null : end.slice(0, i);
};

/**
 * The netlist as the learner arranged it. A moved part's nets lose the author's routing hints that
 * no longer fit (the trunk, corners to or from it) and their hand-placed tags move with it.
 */
export function applyLayout(nl: Netlist, e: LayoutEdit | undefined): Netlist {
  if (!e) return nl;
  const wired = new Set(e.wired);
  const delta = new Map<string, Vec>();
  const instances = nl.instances.map((i) => {
    const to = e.at[i.name];
    const from = i.at ?? [0, 0];
    if (!to || (to[0] === from[0] && to[1] === from[1])) return i;
    delta.set(i.name, [to[0] - from[0], to[1] - from[1]]);
    return { ...i, at: to };
  });
  if (!delta.size && !wired.size) return nl;
  const moved = (end: string) => delta.has(instOf(end) ?? '');
  const nets = nl.nets.map((n): NetDef => {
    const unravel = isTagged(n) && wired.has(netKey(n));
    const touches = n.ends.some(moved);
    if (!unravel && !touches) return n;
    const out: NetDef = { ...n };
    if (unravel) {
      delete out.tags;
      delete out.tagAt;
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
