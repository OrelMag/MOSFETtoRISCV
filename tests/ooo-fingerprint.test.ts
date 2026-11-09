// The out-of-order model outside spec mode is pinned cycle by cycle (tests/ooofingerprint.ts): the side-channel
// chapter's spec mode may add behaviour, never change what the ooo chapter, the lab and the gate-level core rely on.

import { describe, expect, it } from 'vitest';
import { oooFingerprints } from './ooofingerprint';
import pinned from './ooo-fingerprints.json';

describe('the out-of-order model without spec mode', () => {
  it('runs every configuration and program exactly as before, cycle by cycle', () => {
    expect(oooFingerprints()).toEqual(pinned);
  }, 60_000);
});
