// Statements the release review (2026-11-12) found wrong, pinned so they stay right.
import { describe, expect, it } from 'vitest';
import { chLinking } from '../src/chapters/ch-linking';
import { chAppendixBaby } from '../src/chapters/ch-baby';
import { MORE2 } from '../src/campaign/codexmore2';
import { MC_STATES } from '../src/lib/multicycle';
import { chFsm } from '../src/chapters/ch-fsm';

const text = (c: { steps: { body: string; challenge?: unknown }[] }) => c.steps.map((s) => s.body + JSON.stringify(s.challenge ?? '')).join('\n');

describe('release review content', () => {
  it('linking: the library that provides is named after the one that needs it', () => {
    const t = text(chLinking);
    expect(t).toContain('name the library that provides after the one that needs it');
    expect(t).not.toContain('name the library that needs after the one that provides it');
  });

  it('baby: every distractor of the 11011 110 quiz has a reading that gives it', () => {
    const q = chAppendixBaby.steps.map((s) => s.challenge as { options?: string[] } | undefined).find((c) => c?.options?.includes('STO 27'))!;
    expect(q.options).not.toContain('STO 11'); // 11011 is a palindrome: no digit order gives 11
  });

  it('multiword: the borrow comparison names which difference it is for', () => {
    const m = JSON.stringify(MORE2.multiword);
    expect(m).toContain('For B − A the borrow is B.lo < A.lo (for A − B, A.lo < B.lo)');
  });

  it('fsm: the multicycle controller\'s state count is computed, not "a dozen"', () => {
    const t = text(chFsm);
    expect(t).not.toMatch(/a dozen states|dozen-state/);
    expect(t).toContain(`with ${MC_STATES.length} states`);
  });
});
