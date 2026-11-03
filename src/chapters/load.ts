// Chapters on demand: a chapter's module (its steps, scenes, widgets and the library parts only they use) is a chunk of its own.

import { LOADERS } from './loaders';
import type { Chapter } from './types';
import { outline } from './outline';

const loaded = new Map<string, Promise<Chapter>>();

/** One chapter, loaded on first use (a failed load is not remembered: the next call tries again). */
export function loadChapter(id: string): Promise<Chapter> {
  let p = loaded.get(id);
  if (!p) {
    const load = LOADERS[id];
    if (!load) return Promise.reject(new Error(`No such chapter: ${id}`));
    p = load().catch((e: unknown) => { loaded.delete(id); throw e; });
    loaded.set(id, p);
  }
  return p;
}

/** Every chapter in book order (the review queue, My path's questions): loads them all. */
export const loadChapters = (): Promise<Chapter[]> => Promise.all(outline.map((c) => loadChapter(c.id)));
