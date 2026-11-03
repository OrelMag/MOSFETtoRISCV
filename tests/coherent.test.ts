import { describe, expect, it } from 'vitest';
import { randomCoherentProgram } from '../src/riscv/cohfuzz';
import { COH_PROGRAMS } from '../src/riscv/cohprograms';
import { lockStep, open } from './cohkit';
import { tick } from './yieldtick';

describe('coherent dual-core: gates against the timing model, every cycle', () => {
  for (const coherent of [true, false]) {
    for (const p of COH_PROGRAMS) {
      it(`${p.id} (${coherent ? 'MSI' : 'no snooping'})`, async () => {
        const r = open(p.source, { coherent });
        let bad: string | null = null;
        for (let c = 0; c < 3000 && !r.model.halted && !bad; c++) { bad = lockStep(r); if (c % 64 === 0) await tick(); }
        expect(bad).toBeNull();
        expect(r.model.halted).toBe(true);
      }, 600000);
    }
  }

  // random programs with shared lines, conflict misses and lr / sc loops, the model and the gates in step
  for (const [coherent, seeds] of [[true, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]], [false, [21, 22, 23]]] as const) {
    for (const seed of seeds) {
      it(`fuzz seed ${seed} (${coherent ? 'MSI' : 'no snooping'})`, async () => {
        const r = open(randomCoherentProgram(seed), { coherent });
        let bad: string | null = null;
        for (let c = 0; c < 6000 && !r.model.halted && !bad; c++) { bad = lockStep(r); if (c % 64 === 0) await tick(); }
        expect(bad).toBeNull();
        expect(r.model.halted).toBe(true);
      }, 600000);
    }
  }
  // a 64-word memory: two tag bits
  for (const id of ['ttas', 'lrsc']) {
    it(`${id} with dmemK 6`, async () => {
      const r = open(COH_PROGRAMS.find((p) => p.id === id)!.source, { K: 6 });
      let bad: string | null = null;
      for (let c = 0; c < 3000 && !r.model.halted && !bad; c++) { bad = lockStep(r); if (c % 64 === 0) await tick(); }
      expect(bad).toBeNull();
      expect(r.model.halted).toBe(true);
    }, 600000);
  }
});
