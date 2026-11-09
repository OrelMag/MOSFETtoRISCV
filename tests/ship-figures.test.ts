// Figures the chapters quote as named constants (no load-time cost) are measured here, so they cannot drift from the gates.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { singleCycleCpu } from '../src/lib/cpu';
import { withoutParts } from '../src/lib/tech';
import { stats } from '../src/sim/stats';
import { assemble } from '../src/riscv/asm';
import { CPU_NANDS } from '../src/widgets/cpucost';

describe('constants the chapters quote', () => {
  it('CPU_NANDS: the single-cycle CPU without its program ROM, ripple adders', () => {
    const cpu = singleCycleCpu(assemble('li a0, 1\nhalt: j halt').words);
    expect(stats(withoutParts(cpu, ['imem'])).nands).toBe(CPU_NANDS);
  }, 60000);
});
