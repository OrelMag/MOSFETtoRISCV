// The campaign: a tree of levels from a transistor NAND to a pipelined RV16 processor. A node is
// one level: a lesson to read, a drill to answer, a chip to build (a sandbox build challenge), a
// program to write, or a CPU core to build. Nodes name the nodes they build on (`requires`); the
// parts a build may use are the library parts unlocked by that closure (graph.ts ruleFor), never
// the learner's progress, so a level's rule and its reference answer are fixed. No DOM here.

import type { BuildChallenge, Limits } from '../editor/challenges';

export type NodeKind = 'lesson' | 'drill' | 'build' | 'program' | 'core';

/** A link into the chapters for more depth. */
export interface ChapterLink {
  chapter: string;
  step?: number;
  label: string;
}

/** Metrics a level is graded on (lower is better). */
export type Metric = 'nand' | 'transistors' | 'depth' | 'period' | 'cycles' | 'size' | 'mistakes';

export type Par = Partial<Record<Metric, number>>;

export interface CampaignNode {
  id: string;
  /** Act number (0 = prologue). */
  act: number;
  title: string;
  kind: NodeKind;
  /** Side quest: never required by a required node. */
  optional?: boolean;
  requires: string[];
  /** HTML: why this block is needed, where it sits in the CPU. Shown first. */
  why: string;
  /** HTML: the lesson itself, or extra explanation for a build. */
  body?: string;
  /** Hints, revealed one at a time (HTML). */
  tips: string[];
  /** Codex entries revealed when the node is solved or skipped (a lesson: when opened). */
  codex: string[];
  /** Library ids (or `prefix*`) a later level may place once this one is behind it. */
  unlocks?: string[];
  /** Library parts given for this level only (cells it arranges rather than builds). */
  gives?: string[];
  /** Also given: these parts' ids (the reference design's own building blocks, for side quests). */
  givesOf?: () => string[];
  /** Blocks of the CPU anatomy diagram this node builds (anatomy.ts). */
  anatomy?: string[];
  chapters?: ChapterLink[];
  /** The chip to build (build and core nodes), before the campaign's rule and par are applied (levels.ts). */
  base?: () => BuildChallenge;
  /** A drill's generator id (drills.ts). */
  drill?: string;
  /** Graded against: shown as par, three stars at or under it on every metric. */
  par?: Par;
  /** Not built yet: shown on the map, cannot be started. */
  soon?: boolean;
}

export interface Act {
  num: number;
  title: string;
  /** HTML: the act's place in the story. */
  blurb: string;
}

export type Status = 'locked' | 'available' | 'started' | 'solved' | 'skipped';

/** Converts a node's par to the challenge engine's limits (shown in the sandbox strip). */
export function parLimits(par: Par | undefined): Limits | undefined {
  if (!par) return undefined;
  const l: Limits = {};
  if (par.nand !== undefined) l.maxNand = par.nand;
  if (par.transistors !== undefined) l.maxTransistors = par.transistors;
  if (par.depth !== undefined) l.maxDepth = par.depth;
  if (par.period !== undefined) l.maxPeriod = par.period;
  if (par.cycles !== undefined) l.maxCycles = par.cycles;
  return l;
}
