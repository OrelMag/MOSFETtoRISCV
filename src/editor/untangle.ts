// A drawing made by docFromDef with no two nets on one line. docFromDef's router can leave a pin's stub on another net's run,
// which the sandbox's lint reports ("two nets drawn on one line"); generated chips (examples, state machines) go through this
// before the learner sees them, so they open without warnings they cannot act on.

import { UserLibrary } from './library';
import { lintChip } from './lint';
import { type ChipDoc, emptyWorkspace, type PartRef, polyline } from './model';
import { partDef } from './parts';
import { collapseWires } from './unravel';

/**
 * The drawing with no two nets on one line (the sandbox's lint): where docFromDef's wires of two nets share a line (its
 * router leaves a pin's stub on another net's run), one of them becomes a pair of pointers, as a schematic would label it.
 * `chips`: the user chips the drawing places.
 */
export function untangled(doc: ChipDoc, chips: Record<string, ChipDoc> = {}): ChipDoc {
  for (let round = 0; round < 16; round++) {
    const lib = new UserLibrary({ ...emptyWorkspace(), chips: { ...chips, [doc.id]: doc } });
    const built = lib.compiled(doc.id);
    if (!built) return doc;
    const defOf = (p: { ref: PartRef }) => {
      const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    const clash = lintChip(doc, built, polys).diags.find((d) => d.msg.startsWith('two nets drawn on one line') && d.wires?.length);
    if (!clash) return doc;
    // the net with fewer wires on that line becomes pointers
    const byNet = new Map<number, string[]>();
    for (const w of clash.wires!) {
      const n = built.netOfWire.get(w) ?? -1;
      byNet.set(n, [...(byNet.get(n) ?? []), w]);
    }
    const pick = [...byNet.values()].sort((a, b) => a.length - b.length)[0];
    const r = collapseWires(doc, pick, defOf);
    if (r.reason || r.doc === doc) return doc;
    doc = r.doc;
  }
  return doc;
}
