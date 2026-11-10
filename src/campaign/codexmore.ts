// The fuller codex: what an entry says beyond its one-line summary (codex.ts `body`, which stays
// the summary and the glossary's hover text). Prose is written here; figures are generated from
// the library on the codex page (schematic, truth table, cost against the alternatives), so they
// cannot drift. The texts live in codexmore0.ts (components, laws, tools) and codexmore1.ts
// (tricks, concepts), act P's in codexmoreP.ts. Loaded on demand: the chapters' hover cards need only aliases (glossary.ts).
// No DOM.

import type { ChapterLink } from './types';
import { MORE0 } from './codexmore0';
import { MORE1 } from './codexmore1';
import { MOREP } from './codexmoreP';
import { MORE2 } from './codexmore2';
import { MORE3 } from './codexmore3';
import { MORE4 } from './codexmore4';
import { MORE5 } from './codexmore5';
import { MORE6 } from './codexmore6';
import { MORE7 } from './codexmore7';
import { MORE8A } from './codexmore8a';
import { MORE8B } from './codexmore8b';
import { MORE8C } from './codexmore8c';
import { MORE8D } from './codexmore8d';
import { MORE9A } from './codexmore9a';
import { MORE9B } from './codexmore9b';
import { MORE9C } from './codexmore9c';
import { MORE9D } from './codexmore9d';
import { MORE9E } from './codexmore9e';
import { MORE9F } from './codexmore9f';
import { MORESIDE } from './codexmoreside';
import { MOREVM } from './codexmorevm';

export { checkOf } from './codexcheck';

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

const ALL: Record<string, CodexMore> = { ...MORESIDE, ...MOREVM, ...MORE0, ...MORE1, ...MOREP, ...MORE2, ...MORE3, ...MORE4, ...MORE5, ...MORE6, ...MORE7, ...MORE8A, ...MORE8B, ...MORE8C, ...MORE8D, ...MORE9A, ...MORE9B, ...MORE9C, ...MORE9D, ...MORE9E, ...MORE9F };

export function moreOf(id: string): CodexMore | undefined {
  return ALL[id];
}

export function moreIds(): string[] {
  return Object.keys(ALL);
}
