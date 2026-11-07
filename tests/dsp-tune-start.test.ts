// "Tune it": the chain the page starts from fails at least one band of every attempt the page can draw (ATTEMPTS), so the capstone always needs the
// learner's own choices. The reference's side of the promise is tests/dsp-tune-attempts.test.ts.

import { describe, expect, it } from 'vitest';
import { attemptSeeds, ATTEMPTS, decodes, DEFAULT_CHAIN, makeBand } from '../src/dsp/tune';
import { tick } from './yieldtick';

describe('every attempt the page draws', () => {
  it('the starting chain fails at least one band', async () => {
    for (const a of ATTEMPTS) {
      let fails = false;
      for (const s of attemptSeeds(a)) { await tick(); if (!decodes(DEFAULT_CHAIN, makeBand(s))) { fails = true; break; } }
      expect([a, fails]).toEqual([a, true]);
    }
  }, 400_000);
});
