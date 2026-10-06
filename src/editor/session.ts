// Workspace-level steps of an editing session that need no DOM: the tab stack, new chips, and
// the "volatile" parts of the document (open tabs, input values) that undo must leave alone.

import { emptyChip, type PinDoc, slug, uniqueName, type Workspace } from './model';

/** The chip being edited: the top of the tab stack (falls back to any chip). */
export function activeChip(ws: Workspace): string {
  const top = ws.open[ws.open.length - 1];
  return top && ws.chips[top] ? top : Object.keys(ws.chips)[0];
}

/** Make `id` the active tab (it moves to the top of the stack). */
export function openChip(ws: Workspace, id: string): Workspace {
  if (!ws.chips[id]) return ws;
  if (ws.open[ws.open.length - 1] === id) return ws;
  return { ...ws, open: [...ws.open.filter((o) => o !== id && ws.chips[o]), id] };
}

/** Close a tab; the last remaining tab stays open. */
export function closeChip(ws: Workspace, id: string): Workspace {
  const open = ws.open.filter((o) => o !== id && ws.chips[o]);
  if (!open.length) return ws;
  return { ...ws, open };
}

/** A new empty chip named `name` (made unique), opened as the active tab. */
export function newChip(ws: Workspace, name = 'Chip'): { ws: Workspace; id: string } {
  const names = Object.values(ws.chips).map((c) => c.name);
  let nm = name;
  for (let i = 2; names.includes(nm); i++) nm = `${name} ${i}`;
  const id = uniqueName(`u_${slug(nm)}`, Object.keys(ws.chips));
  const chips = { ...ws.chips, [id]: emptyChip(id, nm) };
  return { ws: { ...ws, chips, open: [...ws.open.filter((o) => ws.chips[o]), id] }, id };
}

/** Set an input pin's value (kept across reloads, not an undo step). */
export function setPinValue(ws: Workspace, chipId: string, pinId: string, value: number): Workspace {
  const doc = ws.chips[chipId];
  const i = doc?.pins.findIndex((p) => p.id === pinId) ?? -1;
  if (i < 0 || doc.pins[i].value === value) return ws;
  const pins = doc.pins.slice();
  pins[i] = { ...pins[i], value };
  return { ...ws, chips: { ...ws.chips, [chipId]: { ...doc, pins } } };
}

/**
 * `next` (a state from undo / redo) with the volatile parts of `cur`: the open tabs, the purist
 * toggle and every input value. Objects that already agree are kept.
 */
export function keepVolatile(next: Workspace, cur: Workspace): Workspace {
  let chips = next.chips;
  for (const [id, doc] of Object.entries(next.chips)) {
    const old = cur.chips[id];
    if (!old || old === doc) continue;
    const vals = new Map<string, PinDoc>(old.pins.map((p) => [p.id, p]));
    let changed = false;
    const pins = doc.pins.map((p) => {
      const o = vals.get(p.id);
      if (!o || o.value === p.value || o.dir !== 'in' || o.width !== p.width) return p;
      changed = true;
      const q = { ...p, value: o.value };
      if (o.value === undefined) delete q.value;
      return q;
    });
    if (changed) {
      if (chips === next.chips) chips = { ...chips };
      chips[id] = { ...doc, pins };
    }
  }
  const open = cur.open.filter((o) => next.chips[o]);
  const res: Workspace = { ...next, chips, open: open.length ? open : next.open.filter((o) => next.chips[o]) };
  if (cur.purist) res.purist = true;
  else delete res.purist;
  return res;
}
