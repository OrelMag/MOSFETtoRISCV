// The fuller codex: what an entry says beyond its one-line summary (codex.ts `body`, which stays
// the summary and the glossary's hover text). Prose is written here; figures are generated from
// the library on the codex page (schematic, truth table, cost against the alternatives), so they
// cannot drift. The texts live in codexmore0.ts (components) and codexmore1.ts (laws, tools,
// tricks, concepts). Loaded on demand: the chapters' hover cards need only aliases (glossary.ts).
// No DOM.

import type { ChapterLink } from './types';
import { MORE0 } from './codexmore0';
import { MORE1 } from './codexmore1';

export interface CodexMore {
  /** HTML: the idea in a paragraph or two, for an engineer meeting it for the first time. */
  idea: string;
  /** A worked example: numbers, a K-map, a derivation (HTML). */
  example?: { title: string; body: string };
  /** HTML items: mistakes people actually make with it. */
  mistakes?: string[];
  /** Library id drawn as the figure (schematic) and, when combinational and small, its truth table. */
  lib?: string;
  /** Library ids measured next to `lib` in a cost bar (NANDs, depth). */
  compare?: string[];
  /** Anatomy blocks (anatomy.ts BLOCKS ids) where it sits in the finished CPU. */
  anatomy?: string[];
  chapters?: ChapterLink[];
}

const ALL: Record<string, CodexMore> = { ...MORE0, ...MORE1 };

export function moreOf(id: string): CodexMore | undefined {
  return ALL[id];
}

export function moreIds(): string[] {
  return Object.keys(ALL);
}
