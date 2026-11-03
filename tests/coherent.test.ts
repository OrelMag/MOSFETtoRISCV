import { describe, expect, it } from 'vitest';
import { MC_PROGRAMS } from '../src/riscv/mcprograms';
import { lockStep, open } from './cohkit';

describe('coherent dual-core: gates against the timing model, every cycle', () => {
  for (const id of ['race', 'atomic']) {
    it(id, () => {
      const r = open(MC_PROGRAMS.find((p) => p.id === id)!.source);
      let bad: string | null = null;
      for (let c = 0; c < 1500 && !r.model.halted && !bad; c++) bad = lockStep(r);
      expect(bad).toBeNull();
      expect(r.model.halted).toBe(true);
      console.log(id, r.cycle, 'cycles', r.leaves, 'leaves', r.model.memoryView()[16]);
    }, 600000);
  }
});
