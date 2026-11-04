// `npm run build` measures every component (scripts/hwstats.ts), so one that never finishes stalls the build and the deploy
// while every other test passes. A flip-flop with no boundary mark (DFF_R) is a loop to static timing: the arrival counts it
// as 0, and the traceback used to follow it around for ever (found on chapter 44's SPI memory).

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { hwStatsLive } from '../src/lib/hwstats';
import { spiDevice } from '../src/lib/spi';
import { flatten } from '../src/sim/flatten';
import { analyzeTiming } from '../src/sim/timing';

describe('static timing and the Statistics tab', () => {
  it('a critical path through a loop ends: its traceback visits a net at most once', () => {
    const r = analyzeTiming(flatten(spiDevice(), { mode: 'gate' }));
    expect(r).toBeTruthy();
    expect(new Set(r!.nets).size).toBe(r!.nets.length);
    expect(r!.period).toBeGreaterThan(0);
  });
  it('every component measures, and each row has a cost', async () => {
    const rows = await hwStatsLive(() => {});
    expect(rows.length).toBeGreaterThan(1000);
    for (const r of rows) expect(Number.isFinite(r.nands), r.id).toBe(true);
  }, 300_000);
});
