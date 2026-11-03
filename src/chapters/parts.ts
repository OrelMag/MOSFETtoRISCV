// A long chapter's named parts (DOM-free). Parts only group the existing steps in order; see Chapter.parts.

import type { Chapter } from './types';

/** Chapters with at least this many steps are given parts (tests/chapter-guide.test.ts holds them to it). */
export const PARTS_MIN = 15;

export interface PartInfo {
  name: string;
  /** Index of its first step. */
  from: number;
  /** Its step count. */
  count: number;
  /** Its deep-dive steps. */
  deep: number;
}

/** The chapter's parts with where each starts; null for a chapter without (or whose counts do not fit its steps). */
export function partsOf(c: Pick<Chapter, 'parts' | 'steps'>): PartInfo[] | null {
  if (!c.parts?.length) return null;
  let from = 0;
  const out = c.parts.map(([name, count]) => {
    const p = { name, from, count, deep: c.steps.slice(from, from + count).filter((s) => s.deep).length };
    from += count;
    return p;
  });
  return from === c.steps.length ? out : null;
}

/** Which part holds step `i` (-1: none, e.g. the recap). */
export const partIndex = (parts: readonly PartInfo[], i: number): number => parts.findIndex((p) => i >= p.from && i < p.from + p.count);

/** Steps that are not deep dives. */
export const corePath = (c: Pick<Chapter, 'steps'>): number => c.steps.filter((s) => !s.deep).length;
