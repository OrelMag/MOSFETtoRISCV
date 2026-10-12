// Hardware statistics: every library component measured from its own netlist (cost, logic depth,
// and for a clocked part the period its slowest register-to-register path needs), for the
// workbench's Statistics tab. The build computes it once (scripts/hwstats.ts → hwstats.json);
// without that file (the dev server) the page computes it here, a few rows at a time.

import { flatten } from '../sim/flatten';
import { needsSwitchLevel } from '../sim/harness';
import { hasFeedback, logicDepth, stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import type { Category, ComponentDef } from '../sim/types';
import { registry } from './define';
import { combos, families, familyOf, resolveComponent } from './resolve';
import { referenceCpus } from './usage';

export interface HwRow {
  id: string;
  name: string;
  cat: Category;
  transistors: number;
  nands: number;
  /** Gate delays on the worst path of a combinational part (null: clocked, switch level, or unknown). */
  depth: number | null;
  /** NAND delays a clocked part's slowest register-to-register path needs (null: not clocked). */
  period: number | null;
  /** Levels of boxes inside, and boxes inside at every level. */
  levels: number;
  parts: number;
  /** Solved by the switch-level simulator (transistor circuits): no gate depth. */
  switchLevel: boolean;
  /** The workbench family it is one size of (id, name). */
  family?: { id: string; name: string };
  /** Where a click opens it: the workbench, or for a chapter's CPU its chapter ('' if neither). */
  route: string;
  /** One of the chapters' CPUs (not in the library itself). */
  cpu?: true;
}

const SKIP = new Set(['alias', 'vdd', 'gnd']);

/** What the page lists: the chapters' CPUs, every size each workbench family offers, the registry. */
export function hwTargets(): ComponentDef[] {
  const out = new Set<ComponentDef>(referenceCpus().map((c) => c.def));
  for (const f of families) for (const p of combos(f)) {
    try {
      out.add(f.make(p));
    } catch { /* a size the generator refuses */ }
  }
  for (const d of registry.values()) out.add(d);
  return [...out].filter((d) => !d.prim || !SKIP.has(d.prim));
}

export function measure(d: ComponentDef): HwRow {
  const s = stats(d);
  const switchLevel = needsSwitchLevel(d);
  let depth: number | null = null, period: number | null = null;
  try {
    if (!switchLevel) {
      if (!hasFeedback(d)) depth = logicDepth(d);
      else period = analyzeTiming(flatten(d, { mode: 'gate' }))?.period ?? null;
    }
  } catch { /* unmeasurable: shown as a dash */ }
  const f = familyOf(d.id);
  const cpu = referenceCpus().find((c) => c.def === d);
  const row: HwRow = {
    id: d.id, name: d.name, cat: d.category, transistors: s.transistors, nands: s.nands, depth, period,
    levels: s.levels, parts: s.descendants, switchLevel,
    route: cpu ? cpu.route : resolveComponent(d.id) === d ? `#/workbench/${d.id}` : '',
  };
  if (f) row.family = { id: f.fam.id, name: f.fam.name };
  if (cpu) row.cpu = true;
  return row;
}

/** Every row at once (the build script). */
export function hwStats(): HwRow[] {
  return hwTargets().map(measure);
}

/** Every row, yielding to the page every ~30 ms; `progress` gets (done, total). */
export async function hwStatsLive(progress: (done: number, total: number) => void): Promise<HwRow[]> {
  const pause = () => new Promise<void>((r) => setTimeout(r, 0));
  await pause();
  const targets = hwTargets();
  const rows: HwRow[] = [];
  let t = performance.now();
  for (const d of targets) {
    rows.push(measure(d));
    if (performance.now() - t > 30) {
      progress(rows.length, targets.length);
      await pause();
      t = performance.now();
    }
  }
  return rows;
}
