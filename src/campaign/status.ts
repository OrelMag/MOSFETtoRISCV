// A level's status from the learner's progress (no imports at run time): graph.ts re-exports it, and My path (learn/path.ts) reads
// it without the campaign's nodes, whose reference answers bring in the component library.

import type { Status } from './types';

/** A node's progress as the graph needs it. */
export interface NodeState {
  status?: 'started' | 'solved' | 'skipped';
  stars?: number;
  helped?: boolean;
}

export type ProgressView = (id: string) => NodeState | undefined;

/** Done for the purpose of unlocking what follows: solved or skipped. */
export const isDone = (s: NodeState | undefined) => s?.status === 'solved' || s?.status === 'skipped';

export function statusOf(n: { id: string; requires: readonly string[] }, view: ProgressView, unlockAll = false): Status {
  const s = view(n.id)?.status;
  if (s === 'solved' || s === 'skipped') return s;
  const open = unlockAll || n.requires.every((r) => isDone(view(r)));
  if (!open) return 'locked';
  return s === 'started' ? 'started' : 'available';
}
