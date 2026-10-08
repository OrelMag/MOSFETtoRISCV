// A codex component entry's datasheet, read from the library parts its levels unlock: pins, cost
// (NANDs, transistors), logic depth, and for a small combinational part its whole truth table from
// the part's own spec. Computed from the one description, so it cannot drift. No DOM.

import { resolveComponent } from '../lib/resolve';
import { forEachInput } from '../sim/harness';
import { logicDepth, stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { NODES } from './nodes';

export interface Datasheet {
  id: string;
  name: string;
  summary?: string;
  pins: { name: string; dir: 'in' | 'out' | 'inout'; width: number }[];
  nand: number;
  transistors: number;
  /** Gate delays through it (null: sequential). */
  depth: number | null;
  /** Inputs then outputs per row, packed per port (≤ 4 input bits). */
  table?: { head: string[]; rows: number[][] };
}

const TABLE_BITS = 4;

/** The datasheets of a codex entry: one per library part (exact id) unlocked by a level that teaches it. */
export function datasheets(codexId: string): Datasheet[] {
  const ids = [...new Set(NODES.filter((n) => n.codex.includes(codexId)).flatMap((n) => n.unlocks ?? []).filter((u) => !u.includes('*')))];
  return ids.map(resolveComponent).filter((d): d is ComponentDef => !!d).slice(0, 3).map(sheet);
}

function sheet(d: ComponentDef): Datasheet {
  const st = stats(d);
  const ins = d.ports.filter((p) => p.dir === 'in'), outs = d.ports.filter((p) => p.dir === 'out');
  const bits = ins.reduce((a, p) => a + p.width, 0);
  const depth = logicDepth(d);
  let table: Datasheet['table'];
  if (d.spec && depth !== null && bits <= TABLE_BITS && outs.length) {
    const rows: number[][] = [];
    forEachInput(d, (v) => rows.push([...v, ...d.spec!(v)]));
    table = { head: [...ins, ...outs].map((p) => (p.width > 1 ? `${p.name}[${p.width - 1}:0]` : p.name)), rows };
  }
  return {
    id: d.id, name: d.name, ...(d.summary ? { summary: d.summary } : {}),
    pins: d.ports.map((p) => ({ name: p.name, dir: p.dir, width: p.width })),
    nand: st.nands, transistors: st.transistors, depth, ...(table ? { table } : {}),
  };
}
