// Where a library part is used: the components whose netlists place it (reverse of "uses"), and
// how many copies of it a flattened CPU holds. Both are read off the netlists, so they cannot
// drift from what the schematics show. The inspector asks on demand: the first call builds every
// reachable netlist and the chapters' CPUs.

import { type ComponentDef, netlistOf } from '../sim/types';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { singleCycleCpu } from './cpu';
import { multicycleCpu } from './multicycle';
import { dualCore } from './multicore';
import { pipelinedCpu } from './pipeline';
import { registry } from './define';
import { reachableDefs, resolveComponent } from './resolve';
import { systemCpu } from './system';

export interface Parent {
  def: ComponentDef;
  /** Instances of the part placed directly in `def`'s netlist. */
  count: number;
  /** The workbench can open it by id (generated internals and CPU tops cannot). */
  openable: boolean;
}

let index: { size: number; parents: Map<ComponentDef, Map<ComponentDef, number>> } | null = null;

/**
 * The components that place `def` directly, most copies first: every library part and the
 * chapters' CPUs (not registered themselves). Rebuilt when the registry grows.
 */
export function usedIn(def: ComponentDef): Parent[] {
  const tops = referenceCpus().map((c) => c.def);
  if (!index || index.size !== registry.size) {
    const parents = new Map<ComponentDef, Map<ComponentDef, number>>();
    const all = new Set(reachableDefs());
    const visit = (d: ComponentDef) => {
      if (all.has(d)) return;
      all.add(d);
      for (const i of netlistOf(d)?.instances ?? []) visit(i.def);
    };
    tops.forEach(visit);
    for (const p of all) {
      for (const inst of netlistOf(p)?.instances ?? []) {
        let m = parents.get(inst.def);
        if (!m) parents.set(inst.def, (m = new Map()));
        m.set(p, (m.get(p) ?? 0) + 1);
      }
    }
    index = { size: registry.size, parents };
  }
  return [...(index.parents.get(def) ?? [])]
    .map(([p, count]) => ({ def: p, count, openable: resolveComponent(p.id) === p }))
    .sort((a, b) => b.count - a.count || a.def.name.localeCompare(b.def.name));
}

/** Copies of `part` once `top` is flattened (through every level, NAND's own transistors included). */
export function copiesIn(top: ComponentDef, part: ComponentDef): number {
  const memo = new Map<ComponentDef, number>();
  const count = (d: ComponentDef): number => {
    if (d === part) return 1;
    let n = memo.get(d);
    if (n !== undefined) return n;
    n = 0;
    for (const inst of netlistOf(d)?.instances ?? []) n += count(inst.def);
    memo.set(d, n);
    return n;
  };
  return count(top);
}

let cpus: { label: string; def: ComponentDef }[] | null = null;

/** The CPUs the chapters build, as the learner first meets each (the first sample program). */
export function referenceCpus(): { label: string; def: ComponentDef }[] {
  if (!cpus) {
    const w = assemble(PROGRAMS[0].source).words;
    cpus = [
      { label: 'Single-cycle', def: singleCycleCpu(w) },
      { label: 'Multicycle', def: multicycleCpu(w, { control: 'fsm' }) },
      { label: 'Pipelined', def: pipelinedCpu(w) },
      { label: 'System (RV32IM)', def: systemCpu(w, { m: true }) },
      { label: 'Dual-core', def: dualCore(w) },
    ];
  }
  return cpus;
}
