// The campaign as a graph: closures, the parts a level may use, and each level's status from
// the learner's progress. No DOM.

import type { LibRule } from '../editor/challenges';
import { NODES, nodeById } from './nodes';
import type { CampaignNode, Status } from './types';

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

/**
 * What a level may be built from: NAND, wiring, constants, displays, the learner's own chips and
 * the library parts unlocked by every level it builds on. Fixed per level (not per learner), so
 * a reference answer that passes once passes for everyone.
 */
export function ruleFor(id: string): LibRule {
  const n0 = nodeById(id);
  const lib = new Set<string>(['nand', ...(n0?.gives ?? []), ...(n0?.givesOf?.() ?? [])]);
  for (const a of ancestors(id)) for (const u of nodeById(a)?.unlocks ?? []) lib.add(u);
  const n = lib.size - 1;
  return { lib: [...lib].sort(), label: n ? `NAND + ${n} unlocked part${n === 1 ? '' : 's'}` : 'NAND only' };
}

/** A node's progress as the graph needs it. */
export interface NodeState {
  status?: 'started' | 'solved' | 'skipped';
  stars?: number;
}

export type ProgressView = (id: string) => NodeState | undefined;

/** Done for the purpose of unlocking what follows: solved or skipped. */
export const isDone = (s: NodeState | undefined) => s?.status === 'solved' || s?.status === 'skipped';

export function statusOf(n: CampaignNode, view: ProgressView, unlockAll = false): Status {
  const s = view(n.id)?.status;
  if (s === 'solved' || s === 'skipped') return s;
  const open = unlockAll || n.requires.every((r) => isDone(view(r)));
  if (!open) return 'locked';
  return s === 'started' ? 'started' : 'available';
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
