// "Tune it": chains that must fail. Each is the reference with one choice spoiled; on every attempt the page draws it fails at least one band, and the
// grade blames the block that was spoiled, from measurements of the learner's own chain, not from knowing what was changed.

import { describe, expect, it } from 'vitest';
import { attemptSeeds, ATTEMPTS, decodes, gradeBand, makeBand, PRACTICE_SEED, REFERENCE_CHAIN, type Block, type Cause, type Chain } from '../src/dsp/tune';
import { tick } from './yieldtick';

const R = REFERENCE_CHAIN;
const at = (i: number, b: Partial<Block>): Chain => R.map((x, k) => (k === i ? ({ ...x, ...b } as Block) : x));
const practice = makeBand(PRACTICE_SEED).stations[0].f;

const MUTANTS: { name: string; chain: Chain; blamed: (c: Cause) => boolean }[] = [
  { name: 'a fixed tune (the practice station)', chain: at(0, { tune: { mode: 'fixed', hz: practice } } as Partial<Block>), blamed: (c) => c.kind === 'tune-fixed' },
  { name: '"find it" with too small a margin', chain: at(0, { tune: { mode: 'find', marginDb: 4 } } as Partial<Block>), blamed: (c) => c.kind === 'tune-wrong' },
  { name: '"find it" with too large a margin', chain: at(0, { tune: { mode: 'find', marginDb: 45 } } as Partial<Block>), blamed: (c) => c.kind === 'tune-none' },
  { name: 'a first-order CIC', chain: at(1, { N: 1 } as Partial<Block>), blamed: (c) => c.kind === 'interference' && c.worst.block === 'CIC ÷ R' },
  { name: 'a four-bit oscillator table', chain: at(0, { bits: 4 } as Partial<Block>), blamed: (c) => c.kind === 'interference' && c.worst.spurDb > 6 },
  { name: 'a channel filter of 15 taps', chain: at(2, { taps: 15, cutoff: 75_000 } as Partial<Block>), blamed: (c) => c.kind === 'interference' },
  { name: 'a channel filter narrower than the station', chain: at(2, { cutoff: 5_000 } as Partial<Block>), blamed: (c) => c.kind === 'too-narrow' },
];
/** Attempts whose failing band is diagnosed (slow: every part of the band on its own); every attempt is checked to fail. */
const DIAGNOSED = [ATTEMPTS[0], ATTEMPTS[11], ATTEMPTS[ATTEMPTS.length - 1]];

describe('mutants fail every attempt, and are blamed for what was spoiled', () => {
  for (const m of MUTANTS) {
    it(m.name, async () => {
      for (const a of ATTEMPTS) {
        let failed = false;
        for (const s of attemptSeeds(a)) {
          const band = makeBand(s);
          await tick();
          if (decodes(m.chain, band)) continue;
          failed = true;
          if (DIAGNOSED.includes(a)) {
            const r = gradeBand(m.chain, band);
            expect(r.ok).toBe(false);
            expect([a, s, r.cause!.kind, m.blamed(r.cause!)]).toEqual([a, s, r.cause!.kind, true]);
          }
          break;
        }
        expect([a, failed]).toEqual([a, true]);
      }
    }, 300_000);
  }
});
