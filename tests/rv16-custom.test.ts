// RV16 custom instructions (riscv/rv16/custom16.ts): rows in OPX's free funct3 values. Without rows nothing moves:
// every rv16_* part and every campaign reference answer that places one keeps the fingerprint pinned in
// tests/rv16-fingerprints.json (scripts/rv16-fp.ts --write, taken before rows existed).

import { describe, expect, it } from 'vitest';
import '../src/lib/index';
import { NODES } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { CTL16, RV16_CORE, rv16Core } from '../src/lib/rv16/cpu';
import { RV16_PIPE, rv16Pipe } from '../src/lib/rv16/pipe';
import { rv16Fingerprints } from './rv16fingerprint';
import pinned from './rv16-fingerprints.json';

describe('RV16 without custom rows', () => {
  it('every rv16 part and campaign answer keeps its fingerprint', () => {
    const now = rv16Fingerprints(NODES.map((n) => () => levelChallenge(n)));
    expect(now.answers).toEqual(pinned.answers);
    for (const [id, f] of Object.entries(pinned.parts)) expect(now.parts[id], id).toBe(f);
  }, 60_000);

  it('the cores are the same objects', () => {
    expect(rv16Core(true)).toBe(RV16_CORE);
    expect(rv16Pipe({ fwd: true, stall: true, flush: true })).toBe(RV16_PIPE);
    expect(CTL16.id).toBe('rv16_ctl');
  });
});
