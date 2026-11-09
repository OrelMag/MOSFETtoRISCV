// A state-machine chip is drawn by docFromDef, whose router can leave two nets on one line: the sandbox's lint then warns on a
// chip the learner never touched (the GCD starter showed "2 warnings" as it opened). Every chip a new machine makes, in every
// encoding and form, lints clean.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { ENCODINGS, FSM_TEMPLATE, newFsmChip } from '../src/editor/fsmchip';
import { GCD_FSMD } from '../src/editor/fsmd';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type FsmDoc, type PartRef, polyline, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { setUserResolver } from '../src/lib/resolve';

function warnings(ws: Workspace): string[] {
  const lib = new UserLibrary(ws);
  setUserResolver((id) => lib.defOf(id));
  const out: string[] = [];
  for (const [cid, doc] of Object.entries(ws.chips)) {
    const c = lib.compiled(cid);
    if (!c) { out.push(`${cid}: does not compile`); continue; }
    const defOf = (p: { ref: PartRef }) => {
      const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    for (const d of [...c.diags, ...lintChip(doc, c, polys).diags]) if (d.level !== 'hint') out.push(`${cid}: ${d.msg}`);
  }
  return out;
}

describe('a new state machine lints clean', () => {
  const cases: [string, FsmDoc][] = [];
  for (const enc of ENCODINGS) for (const form of ['nand', 'andor', 'pla'] as const) {
    cases.push([`101 detector, ${enc}, ${form}`, { ...FSM_TEMPLATE, encoding: enc, form }]);
    cases.push([`GCD, ${enc}, ${form}`, { ...GCD_FSMD, encoding: enc, form }]);
  }
  it.each(cases)('%s', (_, doc) => {
    const { ws } = newFsmChip(emptyWorkspace(), doc);
    expect(warnings(ws)).toEqual([]);
  });
});
