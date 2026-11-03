// How far a chip is from another, in edits a person would make: a part added, removed or swapped
// for another kind is one, a pin moved from one net to another is one. Where it sits on the canvas,
// how its wires are drawn and what its nets are called cost nothing. A bug hunt grades the fix by
// this distance from the faulty chip it started from. No DOM.
//
// Parts are matched by instance name (a part's id: kept while it is moved). Inside a user chip on
// both sides the count recurses, so a fix inside a sub-chip is counted where it is made. Nets are
// matched greedily by shared pins (the pair sharing most first); a pin whose net on one side is not
// the partner of its net on the other has moved. A pin on no net is a net of its own.

import { type ComponentDef, netlistOf } from '../sim/types';

const custom = (d: ComponentDef) => d.category === 'custom';

/** Edits between two chips of the same pins: parts added / removed / retyped + pins moved between nets. */
export function editCount(a: ComponentDef, b: ComponentDef): number {
  if (a === b) return 0;
  const na = netlistOf(a), nb = netlistOf(b);
  if (!na || !nb) return a.id === b.id ? 0 : 1;
  let edits = 0;
  const ia = new Map(na.instances.map((i) => [i.name, i.def])), ib = new Map(nb.instances.map((i) => [i.name, i.def]));
  // Parts on one side only, or of another kind: their pins are not counted as moves.
  const gone = new Set<string>();
  for (const [name, d] of ia) {
    const e = ib.get(name);
    if (!e) { edits++; gone.add(name); continue; }
    if (d === e) continue;
    if ((custom(d) || custom(e)) && netlistOf(d) && netlistOf(e)) edits += editCount(d, e);
    else if (d.id !== e.id) { edits++; gone.add(name); }
  }
  for (const name of ib.keys()) if (!ia.has(name)) { edits++; gone.add(name); }
  const kept = (end: string) => { const dot = end.indexOf('.'); return dot < 0 || !gone.has(end.slice(0, dot)); };
  const netsOf = (nets: { ends: string[] }[]) => nets.map((n) => n.ends.filter(kept)).filter((s) => s.length);
  const sa = netsOf(na.nets), sb = netsOf(nb.nets);
  // A pin on no net on one side (left open, or its net dropped with a lone driver) is a net of its own there.
  const onA = new Set(sa.flat()), onB = new Set(sb.flat());
  for (const e of onB) if (!onA.has(e)) sa.push([e]);
  for (const e of onA) if (!onB.has(e)) sb.push([e]);
  const inA = new Map<string, number>(), inB = new Map<string, number>();
  sa.forEach((n, i) => n.forEach((e) => inA.set(e, i)));
  sb.forEach((n, j) => n.forEach((e) => inB.set(e, j)));
  // Every overlapping pair, largest overlap first; each net takes one partner.
  const pairs: [number, number, number][] = [];
  sa.forEach((n, i) => {
    const shared = new Map<number, number>();
    for (const e of n) { const j = inB.get(e)!; shared.set(j, (shared.get(j) ?? 0) + 1); }
    for (const [j, k] of shared) pairs.push([k, i, j]);
  });
  pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
  const pa = new Map<number, number>(), pb = new Set<number>();
  for (const [, i, j] of pairs) if (!pa.has(i) && !pb.has(j)) { pa.set(i, j); pb.add(j); }
  // A pin has moved when its net on b is not the partner of its net on a.
  for (const [e, i] of inA) if (pa.get(i) !== inB.get(e)) edits++;
  return edits;
}
