// What the level screen measures beyond the learner's score: a library part's cost (for the
// alternatives a level's case names) and how many copies of a part the finished CPU holds (the
// last required core level's reference answer, compiled once). Every number on the after-pass
// card comes from here or from Check. No DOM.

import { UserLibrary } from '../editor/library';
import { emptyWorkspace } from '../editor/model';
import { resolveComponent } from '../lib/resolve';
import { copiesIn } from '../lib/usage';
import { logicDepth, stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { caseOf, type CaseAlt } from './cases';
import { topo } from './graph';
import { levelChallenge } from './levels';
import type { CampaignNode } from './types';

export interface Cost {
  nand: number;
  transistors: number;
  /** null: sequential or switch level. */
  depth: number | null;
}

/** NANDs, transistors and depth of a library part (undefined: unknown id). */
export function libCost(id: string): Cost | undefined {
  const d = resolveComponent(id);
  if (!d) return undefined;
  const s = stats(d);
  return { nand: s.nands, transistors: s.transistors, depth: logicDepth(d) };
}

/** An alternative's cost: measured when it names a library part, else the numbers it states. */
export function altCost(a: CaseAlt): Partial<Cost> {
  return a.lib ? libCost(a.lib) ?? {} : { nand: a.nand, depth: a.depth };
}

let finalDef: { node: CampaignNode; def: ComponentDef } | null | undefined;

/** The finished CPU: the last required core level's reference answer, compiled. */
export function finalCpu(): { node: CampaignNode; def: ComponentDef } | null {
  if (finalDef !== undefined) return finalDef;
  finalDef = null;
  const cores = topo().filter((n) => n.kind === 'core' && !n.optional && !n.soon);
  const node = cores[cores.length - 1];
  const ch = node && levelChallenge(node);
  if (!ch) return finalDef;
  const docs = ch.answer();
  const lib = new UserLibrary();
  lib.update({ ...emptyWorkspace(), chips: Object.fromEntries(docs.map((d) => [d.id, d])) });
  const def = lib.defOf(docs[docs.length - 1].id);
  if (def) finalDef = { node, def };
  return finalDef;
}

/** The part a level's after-pass card counts in the finished CPU: the case's choice, else its first unlock. */
export function countedPart(n: CampaignNode): ComponentDef | undefined {
  const id = caseOf(n.id)?.counts ?? n.unlocks?.find((u) => !u.endsWith('*'));
  return id ? resolveComponent(id) : undefined;
}

/** Copies of the level's part in the finished CPU (0 when it is not there, or is the CPU itself). */
export function copiesInFinal(n: CampaignNode): number {
  const part = countedPart(n);
  const cpu = finalCpu();
  if (!part || !cpu || cpu.node.id === n.id) return 0;
  return copiesIn(cpu.def, part);
}
