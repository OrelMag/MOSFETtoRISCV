// GateSim under the unit model is pinned (tests/gatesimfingerprint.ts, docs/PLAN-FINEDELAY.md): the fine-delay engine may
// add a scale, never change a single event, evaluation, time or stepping instant of the unit model.

import { describe, expect, it } from 'vitest';
import { stepFingerprints, traceFingerprints } from './gatesimfingerprint';
import pinned from './gatesim-fingerprints.json';
import { tick } from './yieldtick';

describe('GateSim under the unit model', () => {
  it('reports every change at the same time, with the same evaluations, as when pinned', async () => {
    await tick();
    expect(traceFingerprints()).toEqual(pinned.trace);
  }, 120_000);

  it('steps through the same instants: edges with and without a period, Step through an input change', () => {
    expect(stepFingerprints()).toEqual(pinned.steps);
  }, 60_000);
});
