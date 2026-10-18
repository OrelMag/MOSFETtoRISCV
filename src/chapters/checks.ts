// A chapter's checks (DOM-free): the step challenges and the recap's questions, keyed as in settings.solved, so the
// chapter page, the chapter menu and the map count the same things.

import type { Chapter } from './types';

/** The settings.solved keys of a chapter's checks: `id:i` for step i's challenge, `id:recap:k` for recap question k. */
export function checkKeys(c: Chapter): string[] {
  const keys = c.steps.flatMap((s, i) => (s.challenge ? [`${c.id}:${i}`] : []));
  c.recap?.check?.forEach((_, k) => keys.push(`${c.id}:recap:${k}`));
  return keys;
}

/** Solved and total checks of a chapter. */
export function checksDone(c: Chapter, isSolved: (key: string) => boolean): { done: number; total: number } {
  const keys = checkKeys(c);
  return { done: keys.filter(isSolved).length, total: keys.length };
}

/** The recap's index in the chapter's routes (one past the last step), or null without a recap. */
export const recapIndex = (c: Chapter): number | null => (c.recap ? c.steps.length : null);
