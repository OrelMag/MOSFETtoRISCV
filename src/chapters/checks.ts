// A chapter's checks (DOM-free): the step challenges and the recap's questions, keyed as in settings.solved, so the
// chapter page, the chapter menu and the map count the same things. Works on a chapter's outline (meta.ts) as on the chapter.

/** What the counts read: a Chapter, or its ChapterMeta. */
export interface CheckSource {
  id: string;
  steps: readonly { challenge?: unknown }[];
  recap?: { check?: readonly unknown[]; checks?: number };
}

const recapChecks = (c: CheckSource): number => c.recap?.checks ?? c.recap?.check?.length ?? 0;

/** The settings.solved keys of a chapter's checks: `id:i` for step i's challenge, `id:recap:k` for recap question k. */
export function checkKeys(c: CheckSource): string[] {
  const keys = c.steps.flatMap((s, i) => (s.challenge ? [`${c.id}:${i}`] : []));
  for (let k = 0; k < recapChecks(c); k++) keys.push(`${c.id}:recap:${k}`);
  return keys;
}

/** Solved and total checks of a chapter. */
export function checksDone(c: CheckSource, isSolved: (key: string) => boolean): { done: number; total: number } {
  const keys = checkKeys(c);
  return { done: keys.filter(isSolved).length, total: keys.length };
}

/** The recap's index in the chapter's routes (one past the last step), or null without a recap. */
export const recapIndex = (c: CheckSource): number | null => (c.recap ? c.steps.length : null);
