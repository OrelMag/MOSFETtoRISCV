// "Tune it": every attempt the page can draw (ATTEMPTS) holds the capstone's promises. This file: the book's reference chain decodes all five bands of
// each. tests/dsp-tune-start.test.ts: the chain the page starts from fails at least one, so the capstone always needs the learner's own choices.

import { describe, expect, it } from 'vitest';
import { attemptSeeds, ATTEMPTS, decodes, makeBand, REFERENCE_CHAIN } from '../src/dsp/tune';
import { tick } from './yieldtick';

describe('every attempt the page draws', () => {
  it('the reference decodes all five bands', async () => {
    for (const a of ATTEMPTS) for (const s of attemptSeeds(a)) { expect([a, s, decodes(REFERENCE_CHAIN, makeBand(s))]).toEqual([a, s, true]); await tick(); }
  }, 400_000);
});
