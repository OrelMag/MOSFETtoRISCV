// Steps that changed place after going live (DOM-free, no imports). Progress is saved by step index, so a step moved to another chapter,
// or shifted by one that left, must take its ticks, notes and review memos with it. Each batch is one landing: append a batch with a
// row for every step whose index changes, in the same merge as the move; never edit one that has shipped. A store keeps how many batches
// it has seen (`moved`; absent: none), so an old backup file is brought up to date as well (tests/stepmoves.test.ts).

export interface StepMove {
  from: string;
  step: number;
  to: string;
  toStep: number;
  /** The step's title, held to the step now at the target by the test. */
  title: string;
}

export const STEP_MOVES: readonly (readonly StepMove[])[] = [
  [
    { from: 'modem', step: 7, to: 'carriers', toStep: 0, title: 'Many tones, one FFT' },
    { from: 'modem', step: 8, to: 'carriers', toStep: 5, title: 'ADSL: many carriers' },
  ],
];

export interface StepPlace { chapter: string; step: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How many batches a store has seen, from what it saved. */
export const movedOf = (raw: unknown): number => (isObj(raw) && typeof raw.moved === 'number' ? raw.moved : 0);

/** Where a step saved after `since` batches is now. Rows of a batch apply at once, so 6 → 5 does not meet 5 → another chapter. */
export function moveStep(chapter: string, step: number, since = 0): StepPlace {
  let at: StepPlace = { chapter, step };
  for (const batch of STEP_MOVES.slice(since)) {
    const row = batch.find((m) => m.from === at.chapter && m.step === at.step);
    if (row) at = { chapter: row.to, step: row.toStep };
  }
  return at;
}

/** A check's or a review memo's key: `id:i`, `id:i:read:k`, `predict:id:i:k`. A recap's (`id:recap:k`), a codex entry's or a drill's stay. */
export function moveKey(key: string, since = 0): string {
  if (since >= STEP_MOVES.length) return key;
  const m = /^(predict:)?([\w-]+):(\d+)(:.*)?$/.exec(key);
  if (!m || m[2] === 'codex' || m[2] === 'lesson' || m[2] === 'drill') return key;
  const at = moveStep(m[2], Number(m[3]), since);
  return `${m[1] ?? ''}${at.chapter}:${at.step}${m[4] ?? ''}`;
}

/** The settings' progress brought up to date, in place: what was seen, what was solved, the step last viewed. */
export function moveProgress<T>(store: T): T {
  if (!isObj(store)) return store;
  const raw: Record<string, unknown> = store;
  const since = movedOf(raw);
  if (since < STEP_MOVES.length) {
    if (isObj(raw.visited)) {
      const visited: Record<string, number[]> = {};
      for (const [c, steps] of Object.entries(raw.visited)) {
        if (!Array.isArray(steps)) continue;
        for (const s of steps) {
          const at = moveStep(c, s as number, since), to = (visited[at.chapter] ??= []);
          if (!to.includes(at.step)) to.push(at.step);
        }
      }
      raw.visited = visited;
    }
    if (isObj(raw.solved)) raw.solved = Object.fromEntries(Object.entries(raw.solved).map(([k, v]) => [moveKey(k, since), v]));
    const last = raw.last;
    if (isObj(last) && typeof last.chapter === 'string' && typeof last.step === 'number') raw.last = moveStep(last.chapter, last.step, since);
    raw.moved = STEP_MOVES.length;
  }
  return store;
}

/**
 * An old address's new place, for a step past the end of its chapter (`last`: its last index, the recap's if it has one). Only there: within
 * the chapter the same address is also a step of today's, and an address kept today must go on meaning it.
 */
export function movedAddress(chapter: string, step: number, last: number): StepPlace | null {
  if (step <= last) return null;
  const at = moveStep(chapter, step);
  return at.chapter === chapter && at.step === step ? null : at;
}
