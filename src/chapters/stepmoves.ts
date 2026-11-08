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
  // Fourier goes to the new signals chapter
  [
    { from: 'serial', step: 5, to: 'signals', toStep: 0, title: 'A wave is a sum of sines' },
    { from: 'serial', step: 6, to: 'serial', toStep: 5, title: 'The eye diagram' },
    { from: 'serial', step: 7, to: 'serial', toStep: 6, title: 'Equalization' },
    { from: 'serial', step: 8, to: 'serial', toStep: 7, title: 'PAM4' },
    { from: 'serial', step: 9, to: 'serial', toStep: 8, title: 'Fibre' },
  ],
  [
    { from: 'modem', step: 7, to: 'carriers', toStep: 0, title: 'Many tones, one FFT' },
    { from: 'modem', step: 8, to: 'carriers', toStep: 5, title: 'ADSL: many carriers' },
  ],
  [
    { from: 'errors', step: 9, to: 'codes', toStep: 0, title: 'A code with memory' },
    { from: 'errors', step: 10, to: 'codes', toStep: 1, title: 'The Viterbi decoder' },
    { from: 'errors', step: 11, to: 'codes', toStep: 2, title: 'Reed-Solomon: errors in bytes' },
    { from: 'errors', step: 12, to: 'codes', toStep: 5, title: 'Bursts: interleaving' },
    { from: 'errors', step: 13, to: 'codes', toStep: 6, title: 'How far from Shannon' },
  ],
  // noise: the noise-figure chain follows the floor it extends; the chapter ends on Shannon, which hands off to the codes
  [
    { from: 'noise', step: 6, to: 'noise', toStep: 1, title: 'A chain: who pays' },
    { from: 'noise', step: 1, to: 'noise', toStep: 2, title: 'A decision' },
    { from: 'noise', step: 2, to: 'noise', toStep: 3, title: 'The matched filter' },
    { from: 'noise', step: 3, to: 'noise', toStep: 4, title: 'One axis for every link' },
    { from: 'noise', step: 4, to: 'noise', toStep: 5, title: 'Power or band' },
    { from: 'noise', step: 5, to: 'noise', toStep: 6, title: "Shannon's argument, and his code" },
  ],
  // pipeline: "The line, drawn as a factory" joins at step 5; the steps behind it move up one (the recap's keys are `recap:k`, they stay)
  [
    { from: 'pipeline', step: 5, to: 'pipeline', toStep: 6, title: 'Does it pay? Measured' },
    { from: 'pipeline', step: 6, to: 'pipeline', toStep: 7, title: 'Your own instruction, pipelined' },
    { from: 'pipeline', step: 7, to: 'pipeline', toStep: 8, title: 'A compiled program on the pipeline' },
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
