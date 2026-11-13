// A drawing made by docFromDef with no two nets on one line. docFromDef's router can leave a pin's stub on another net's run,
// which the sandbox's lint reports ("two nets drawn on one line"); generated chips (examples, state machines) go through this
// before the learner sees them, so they open without warnings they cannot act on.

import type { ComponentDef } from '../sim/types';
import { type Compiled, compileChip } from './compile';
import { UserLibrary } from './library';
import { lintChip } from './lint';
import { type ChipDoc, emptyWorkspace, type PartRef, polyline } from './model';
import { partDef } from './parts';
import { collapseWires } from './unravel';

/**
 * The drawing with no two nets on one line (the sandbox's lint): where docFromDef's wires of two nets share a line (its
 * router leaves a pin's stub on another net's run), one of them becomes a pair of pointers, as a schematic would label it.
 * `chips`: the user chips the drawing places, or their compiled definitions by id (an importer that has them already: the
 * chips are then not compiled again, which made reading a few hundred circuits quadratic).
 */
export function untangled(doc: ChipDoc, chips: Record<string, ChipDoc> | ((id: string) => ComponentDef | undefined) = {},
  /** Set to the returned drawing's compile when this made one (a caller that compiles it next can take it). */
  out?: { built?: Compiled }): ChipDoc {
  // the placed chips compiled once, not once a round; only the drawing itself is compiled again
  let chipDef: (id: string) => ComponentDef | undefined;
  if (typeof chips === 'function') chipDef = chips;
  else {
    const lib = new UserLibrary({ ...emptyWorkspace(), chips });
    chipDef = (id) => lib.defOf(id);
  }
  for (let round = 0; round < 16; round++) {
    const built = compileChip(doc, (ref) => partDef(ref, chipDef));
    const defOf = (p: { ref: PartRef }) => {
      const d = 'chip' in p.ref ? chipDef(p.ref.chip) : partDef(p.ref, chipDef);
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    const clashes = lintChip(doc, built, polys, { allOverlaps: true }).diags.filter((d) => d.msg.startsWith('two nets drawn on one line') && d.wires?.length);
    if (!clashes.length) { if (out) out.built = built; return doc; }
    // per clash the net with fewer wires on that line becomes pointers; every clash of a round at once (an imported sheet has
    // hundreds), skipping a clash whose nets an earlier pick of this round already touches: that collapse may have settled it
    const pick: string[] = [], touched = new Set<number>();
    for (const clash of clashes) {
      const byNet = new Map<number, string[]>();
      for (const w of clash.wires!) {
        const n = built.netOfWire.get(w) ?? -1;
        byNet.set(n, [...(byNet.get(n) ?? []), w]);
      }
      if ([...byNet.keys()].some((n) => touched.has(n))) continue;
      for (const n of byNet.keys()) touched.add(n);
      pick.push(...[...byNet.values()].sort((a, b) => a.length - b.length)[0]);
    }
    const r = collapseWires(doc, pick, defOf, false);
    if (r.doc === doc) return doc;
    doc = r.doc;
  }
  return doc;
}
