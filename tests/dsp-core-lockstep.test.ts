// The DSP core on the gates against its golden model after every clock: the five benchmarks.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { assemble24 } from '../src/dsp/asm24';
import { BENCH24 } from '../src/dsp/programs24';
import { dsp24Computer } from '../src/lib/dsp24core';
import { DspRig } from './dsp-core-kit';
import { tick } from './yieldtick';

describe('benchmarks, gates against the model every clock', () => {
  for (const id of ['dot', 'fir16', 'biquad', 'fft', 'fir64']) {
    it(id, async () => {
      const b = BENCH24.find((x) => x.id === id)!;
      const words = assemble24(b.src).words;
      const rig = new DspRig(dsp24Computer(words, b.x, b.y), words, b.x, b.y);
      rig.run(20000, (i) => void (i % 400 === 0 && tick()));
      await tick();
      expect(rig.mismatches.slice(0, 3)).toEqual([]);
      expect(rig.iss.halted).toBe(true);
      expect(rig.memoryMismatch()).toBeNull();
    }, 120000);
  }
});

describe('GateSim cross-check', () => {
  it('the first 300 clocks of the dot product on GateSim, every register compared', () => {
    const b = BENCH24.find((x) => x.id === 'dot')!;
    const words = assemble24(b.src).words;
    const rig = new DspRig(dsp24Computer(words, b.x, b.y), words, b.x, b.y, { gate: true });
    rig.run(300);
    expect(rig.mismatches.slice(0, 3)).toEqual([]);
    expect(rig.cycles).toBeGreaterThan(130);
  }, 120000);
});
