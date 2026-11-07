// "Tune it": every attempt the page can draw (ATTEMPTS) holds the capstone's two promises. The book's reference chain decodes all five bands, and the
// chain the page starts from fails at least one, so the capstone always needs the learner's own choices.

import { describe, expect, it } from 'vitest';
import { attemptSeeds, ATTEMPTS, decodes, DEFAULT_CHAIN, makeBand, REFERENCE_CHAIN } from '../src/dsp/tune';
import { tick } from './yieldtick';

describe('every attempt the page draws', () => {
  it('the reference decodes all five bands', async () => {
    for (const a of ATTEMPTS) for (const s of attemptSeeds(a)) { expect([a, s, decodes(REFERENCE_CHAIN, makeBand(s))]).toEqual([a, s, true]); await tick(); }
  }, 300_000);
  it('the starting chain fails at least one', async () => {
    for (const a of ATTEMPTS) {
      let fails = 0;
      for (const s of attemptSeeds(a)) { if (!decodes(DEFAULT_CHAIN, makeBand(s))) fails++; await tick(); }
      expect([a, fails > 0]).toEqual([a, true]);
    }
  }, 300_000);
});
