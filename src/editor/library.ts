// The workspace's chips as a library of ComponentDefs. Chips place each other, so compiling one
// needs the defs of the chips it uses. Results are cached Merkle-style: a chip's key is its own
// document plus the keys of the chips it places, so editing chip A recompiles A and everything
// that (transitively) uses A, and every other chip keeps the very same def object. That identity
// matters: flatten, stats, geometry and the views cache per def in WeakMaps.

import type { ComponentDef } from '../sim/types';
import { compileChip, type Compiled, hash } from './compile';
import { chipDeps, type ChipDoc, type EndRef, SCHEMA, type Workspace } from './model';
import { partDef } from './parts';

/** Hash of a document, once per object (documents are immutable; a big one takes a while to serialize). */
const docHashes = new WeakMap<ChipDoc, string>();
function docHash(doc: ChipDoc): string {
  let h = docHashes.get(doc);
  if (h === undefined) docHashes.set(doc, (h = hash(JSON.stringify(doc))));
  return h;
}

export class UserLibrary {
  private ws: Workspace = { schema: SCHEMA, chips: {}, open: [] };
  private cache = new Map<string, { key: string; c: Compiled }>();
  private cur = new Map<string, Compiled>();

  constructor(ws?: Workspace) {
    if (ws) this.update(ws);
  }

  /** Take a new workspace snapshot; recompiles only what changed (and what uses it). */
  update(ws: Workspace): void {
    this.ws = ws;
    const ids = Object.keys(ws.chips);
    const scc = components(ws);
    const keys = new Map<string, string>();
    const cur = new Map<string, Compiled>();
    // A part placing a chip of its own cycle is cut (an error on that part): every chip of the
    // cycle gets the diagnostic, and the recursion below only follows edges that leave the cycle.
    const cut = (from: string, to: string) => scc.get(from) === scc.get(to);
    const visit = (id: string): string => {
      const done = keys.get(id);
      if (done) return done;
      const doc = ws.chips[id];
      const deps = chipDeps(doc).map((d) => `${d}=${!ws.chips[d] ? 'missing' : cut(id, d) ? 'cycle' : visit(d)}`);
      const key = hash(`${docHash(doc)}|${deps.join(',')}`);
      const hit = this.cache.get(id);
      let c: Compiled;
      if (hit && hit.key === key) c = hit.c;
      else {
        c = compileChip(doc, (ref) => ('chip' in ref && ws.chips[ref.chip] && cut(id, ref.chip)
          ? { error: ref.chip === id ? 'a chip cannot contain itself' : `cycle: '${ref.chip}' contains this chip` }
          : partDef(ref, (d) => cur.get(d)?.def)));
        this.cache.set(id, { key, c });
      }
      keys.set(id, key);
      cur.set(id, c);
      return key;
    };
    for (const id of ids) visit(id);
    for (const id of [...this.cache.keys()]) if (!ws.chips[id]) this.cache.delete(id);
    this.cur = cur;
  }

  compiled(id: string): Compiled | undefined {
    return this.cur.get(id);
  }

  defOf(id: string): ComponentDef | undefined {
    return this.cur.get(id)?.def;
  }

  /** Chips this chip contains, at any depth. */
  deps(id: string): string[] {
    return deps(this.ws, id);
  }

  /** Chips that contain this chip, at any depth. */
  usedBy(id: string): string[] {
    return usedBy(this.ws, id);
  }

  /** May `chip` be placed inside `host`? Not if that would make a chip contain itself. */
  canPlace(host: string, chip: string): boolean {
    return !!this.ws.chips[chip] && chip !== host && !deps(this.ws, chip).includes(host);
  }

  /** For setUserResolver: user chip ids → their current defs. */
  resolver(): (id: string) => ComponentDef | undefined {
    return (id) => this.defOf(id);
  }
}

/** Transitive dependencies of a chip in a workspace (missing chips left out). */
export function deps(ws: Workspace, id: string): string[] {
  const seen = new Set<string>();
  const walk = (c: string) => {
    const doc = ws.chips[c];
    if (!doc) return;
    for (const d of chipDeps(doc)) {
      if (seen.has(d) || !ws.chips[d]) continue;
      seen.add(d);
      walk(d);
    }
  };
  walk(id);
  return [...seen];
}

/** Chips that contain `id` directly or transitively. */
export function usedBy(ws: Workspace, id: string): string[] {
  return Object.keys(ws.chips).filter((c) => c !== id && deps(ws, c).includes(id));
}

/** Strongly connected components of the "places" graph: chip id → component number. */
function components(ws: Workspace): Map<string, number> {
  // Tarjan, iteratively (a long chain of chips must not overflow the stack).
  const index = new Map<string, number>(), low = new Map<string, number>(), comp = new Map<string, number>();
  const stack: string[] = [], on = new Set<string>();
  let next = 0, ncomp = 0;
  const succ = (id: string) => chipDeps(ws.chips[id]).filter((d) => ws.chips[d]);
  for (const root of Object.keys(ws.chips)) {
    if (index.has(root)) continue;
    const work: [string, number][] = [[root, 0]];
    index.set(root, next); low.set(root, next++); stack.push(root); on.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      const s = succ(v);
      if (i < s.length) {
        top[1]++;
        const w = s[i];
        if (!index.has(w)) {
          index.set(w, next); low.set(w, next++); stack.push(w); on.add(w);
          work.push([w, 0]);
        } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        for (let w = ''; w !== v;) {
          w = stack.pop()!;
          on.delete(w);
          comp.set(w, ncomp);
        }
        ncomp++;
      }
    }
  }
  return comp;
}

/**
 * Rename one of a chip's pins (ports): the pin itself, and every wire end on that port of an
 * instance of the chip, in every chip of the workspace. Unchanged chips keep their objects.
 */
export function renamePort(ws: Workspace, chipId: string, oldName: string, newName: string): Workspace {
  const chips: Record<string, ChipDoc> = {};
  for (const [id, c] of Object.entries(ws.chips)) {
    let doc = c;
    if (id === chipId && doc.pins.some((p) => p.name === oldName)) {
      doc = { ...doc, pins: doc.pins.map((p) => (p.name === oldName ? { ...p, name: newName } : p)) };
    }
    const placed = new Set(doc.parts.filter((p) => 'chip' in p.ref && p.ref.chip === chipId).map((p) => p.id));
    if (placed.size) {
      const fix = (e: EndRef): EndRef => ('part' in e && placed.has(e.part) && e.port === oldName ? { part: e.part, port: newName } : e);
      let changed = false;
      const wires = doc.wires.map((w) => {
        const a = fix(w.a), b = fix(w.b);
        if (a === w.a && b === w.b) return w;
        changed = true;
        return { ...w, a, b };
      });
      if (changed) doc = { ...doc, wires };
    }
    chips[id] = doc;
  }
  return { ...ws, chips };
}

/** Delete a chip, unless another chip still contains it. */
export function removeChip(ws: Workspace, id: string): { ws: Workspace } | { error: string; usedBy: string[] } {
  const users = usedBy(ws, id);
  if (users.length) return { error: `'${ws.chips[id]?.name ?? id}' is used by ${users.map((u) => ws.chips[u].name).join(', ')}`, usedBy: users };
  const chips = { ...ws.chips };
  delete chips[id];
  return { ws: { ...ws, chips, open: ws.open.filter((o) => o !== id) } };
}
