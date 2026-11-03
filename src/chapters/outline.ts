// The chapters' outline for the first-load path (DOM-free): every chapter as a ChapterMeta, in book order. Import this, not
// chapters/index.ts (which holds every chapter's code), from anything the first page can reach; tests/firstload.test.ts holds it.

import { MANIFEST } from './manifest';
import type { ChapterMeta, FutureChapter } from './meta';

export const outline: readonly ChapterMeta[] = MANIFEST;

/** Planned chapters, shown as "coming soon" (none now: the GPU track is complete). */
export const future: FutureChapter[] = [];

const byId = new Map(outline.map((c, i) => [c.id, i]));

export const outlineOf = (id: string): ChapterMeta | undefined => outline[byId.get(id) ?? -1];
/** A chapter's position in book order, or -1. */
export const outlineIndex = (id: string): number => byId.get(id) ?? -1;
