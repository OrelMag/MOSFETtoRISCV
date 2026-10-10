// "Why we are building it": each level's case, grown from the one-line `why` (nodes.ts). The level
// screen shows it before the level (the Why tab) and again after a pass, next to the learner's
// measured cost. What the screen can compute is not written here: the levels that build on this one
// (graph), the copies of the unlocked part in the finished CPU (lib/usage.ts copiesIn), the learner's
// score and par. Alternatives name library parts where they exist, so their cost is measured too.
// The texts live in cases0.ts (acts 0–3) and cases1.ts (acts 4–8). No DOM.

import { CASES0 } from './cases0';
import { CASES1 } from './cases1';

/** Another way to build the same block, shown next to the learner's result. */
export interface CaseAlt {
  name: string;
  /** Library id: its NANDs, transistors and depth are measured (preferred over numbers). */
  lib?: string;
  /** Numbers for an alternative the library does not hold (counted by hand: say how in `note`). */
  nand?: number;
  depth?: number;
  note?: string;
}

export interface LevelCase {
  /** HTML: the problem in the CPU this block solves (one short paragraph). */
  problem: string;
  /** HTML: what breaks, or what gets slower or bigger, without it. */
  without?: string;
  /** HTML: what it costs against the alternatives (the measured numbers are added by the screen). */
  cost?: string;
  alts?: CaseAlt[];
  /** Library id of the part this level unlocks whose copies in the finished CPU the after-pass card counts (default: the first of the node's unlocks). */
  counts?: string;
}

const ALL: Record<string, LevelCase> = { ...CASES0, ...CASES1 };

export function caseOf(nodeId: string): LevelCase | undefined {
  return ALL[nodeId];
}

/** Every node id with a case (tests). */
export function caseIds(): string[] {
  return Object.keys(ALL);
}
