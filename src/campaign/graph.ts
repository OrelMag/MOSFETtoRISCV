// The campaign as a graph: closures, the parts a level may use, and each level's status from
// the learner's progress. No DOM.

import { type LibRule, libAllowed, transistorLevel } from '../editor/challenges';
import { libraryItems } from '../lib/catalog';
import { resolveComponent } from '../lib/resolve';
import { NODES, nodeById } from './nodes';
import { isDone, statusOf, type NodeState, type ProgressView } from './status';
import type { CampaignNode } from './types';

export { isDone, statusOf, type NodeState, type ProgressView };

/** Everything a node builds on, transitively (the node itself excluded), in no particular order. */
export function ancestors(id: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(nodeById(id)?.requires ?? [])];
  while (stack.length) {
    const r = stack.pop()!;
    if (out.has(r)) continue;
    out.add(r);
    stack.push(...(nodeById(r)?.requires ?? []));
  }
  return out;
}

/** Nodes in an order where every node comes after the nodes it requires. Throws on a cycle. */
export function topo(nodes: readonly CampaignNode[] = NODES): CampaignNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 1 | 2>();
  const out: CampaignNode[] = [];
  const visit = (n: CampaignNode, path: string[]) => {
    const s = state.get(n.id);
    if (s === 2) return;
    if (s === 1) throw new Error(`campaign cycle: ${[...path, n.id].join(' → ')}`);
    state.set(n.id, 1);
    for (const r of n.requires) {
      const m = byId.get(r);
      if (m) visit(m, [...path, n.id]);
    }
    state.set(n.id, 2);
    out.push(n);
  };
  for (const n of nodes) visit(n, []);
  return out;
}

/** A switch-level level: graded in transistors, not NANDs (act 0, m_sense). */
export const switchLevel = (n: CampaignNode | undefined): boolean => n?.par?.transistors !== undefined && n.par.nand === undefined;

/**
 * What a level may be built from: NAND, wiring, constants, displays, the learner's own chips and
 * the library parts unlocked by every level it builds on. Fixed per level (not per learner), so
 * a reference answer that passes once passes for everyone. A level scored in NANDs takes no
 * transistor-level part (act 0's cells, MOSFETs, the DRAM column): there a transistor would cost nothing.
 */
export function ruleFor(id: string): LibRule {
  const n0 = nodeById(id);
  const gates = !switchLevel(n0);
  const lib = new Set<string>(['nand', ...(n0?.gives ?? []), ...(n0?.givesOf?.() ?? [])]);
  for (const a of ancestors(id)) for (const u of nodeById(a)?.unlocks ?? []) lib.add(u);
  if (gates) for (const u of lib) { const d = u.endsWith('*') ? undefined : resolveComponent(u); if (d && transistorLevel(d)) lib.delete(u); }
  const rule: LibRule = { lib: [...lib].sort(), ...(n0?.withhold?.length ? { except: n0.withhold } : {}) };
  const n = unlockedPartCount(rule);
  return { ...rule, label: n ? `NAND + ${n} unlocked part${n === 1 ? '' : 's'}` : 'NAND only', ...(gates ? { gates } : {}) };
}

/** How many parts the palette's "Unlocked parts" lists for a rule (editor/challengeui.ts unlockedItems): a `prefix*` stands
 *  for the library parts it matches, not for one entry, so the badge counts what is on the shelf. */
export function unlockedPartCount(rule: Pick<LibRule, 'lib'>): number {
  const ids = new Set<string>();
  for (const c of libraryItems()) for (const it of c.items) if (it.id !== 'nand' && libAllowed(rule as LibRule, it.id)) ids.add(it.id);
  for (const id of rule.lib) if (!id.endsWith('*') && id !== 'nand' && !ids.has(id) && libAllowed(rule as LibRule, id) && resolveComponent(id)) ids.add(id);
  return ids.size;
}

/** The next level to play after `id`: an open, unfinished, playable node, required ones first. */
export function nextAvailable(view: ProgressView, unlockAll = false, after?: string): CampaignNode | undefined {
  const order = topo();
  const from = after ? order.findIndex((n) => n.id === after) + 1 : 0;
  const rotated = [...order.slice(from), ...order.slice(0, from)];
  const open = (n: CampaignNode) => !n.soon && ['available', 'started'].includes(statusOf(n, view, unlockAll));
  return rotated.find((n) => !n.optional && open(n)) ?? rotated.find(open);
}

/** Nodes that list `id` among their requirements. */
export const dependents = (id: string): CampaignNode[] => NODES.filter((n) => n.requires.includes(id));
