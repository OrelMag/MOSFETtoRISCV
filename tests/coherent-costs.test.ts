// The numbers chapter 27's cache steps quote: NANDs from the netlists, cycles and bus transactions from the model that the
// gates are held to; the prose must contain them, and a gate-level run must reproduce the measured ones.

import { describe, expect, it } from 'vitest';
import { COH_STEPS } from '../src/chapters/ch-multicore-coh';
import { cohCosts } from '../src/lib/cohcosts';
import { COH_PROGRAMS } from '../src/riscv/cohprograms';
import { runCoherent } from '../src/riscv/cohrun';
import { groupDigits } from '../src/sim/numfmt';
import { lockStep, open } from './cohkit';
import { tick } from './yieldtick';

const text = COH_STEPS.map((s) => `${s.body} ${Object.values(s.more ?? {}).join(' ')}`).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

describe('chapter 27 cache steps: counted, not typed', () => {
  const C = cohCosts();
  it('the cache is mostly data array; the snoop port and the reservation are a few percent', () => {
    expect(C.data / C.privateCache).toBeGreaterThan(0.85);
    expect(C.snoop / C.cache).toBeLessThan(0.05);
    expect(C.cache).toBeGreaterThan(C.privateCache);
    expect(C.coherent).toBeGreaterThan(C.dual);
  });
  it('the prose quotes the counted NANDs', () => {
    for (const v of [C.privateCache, C.data, C.tags, C.access, C.bus, C.coherent, C.dual, C.snoop, C.reservation]) expect(text, String(v)).toContain(groupDigits(v).replace(/\s/g, ' '));
  });
  it('the prose quotes the measured runs', () => {
    for (const id of ['spin', 'ttas', 'falseshare', 'padded', 'lrsc', 'atomic']) {
      const r = runCoherent(COH_PROGRAMS.find((p) => p.id === id)!.source);
      expect(r.halted, id).toBe(true);
      if (id !== 'atomic') expect(text, `${id} cycles`).toContain(`${r.cycles} cycles`);
    }
    const spin = runCoherent(COH_PROGRAMS.find((p) => p.id === 'spin')!.source), ttas = runCoherent(COH_PROGRAMS.find((p) => p.id === 'ttas')!.source);
    expect(ttas.bus).toBeLessThan(spin.bus / 2);
    expect(ttas.cycles).toBeLessThan(spin.cycles);
    const fs = runCoherent(COH_PROGRAMS.find((p) => p.id === 'falseshare')!.source), pad = runCoherent(COH_PROGRAMS.find((p) => p.id === 'padded')!.source);
    expect(fs.bus).toBeGreaterThan(10 * pad.bus);
  });
  for (const id of ['ttas', 'falseshare']) {
    it(`a gate-level run of ${id} takes the measured cycles and transactions`, async () => {
      const src = COH_PROGRAMS.find((p) => p.id === id)!.source, want = runCoherent(src);
      const r = open(src);
      let bad: string | null = null, grants = 0, busy = 0;
      for (let c = 0; c < 3000 && !r.model.halted && !bad; c++) {
        bad = lockStep(r);
        busy += r.sim.getBits(r.root.ports.busy)[0] === 1 ? 1 : 0;
        if (c % 64 === 0) await tick();
      }
      void grants;
      expect(bad).toBeNull();
      expect(r.cycle).toBe(want.cycles);
      expect(busy / r.cycle).toBeCloseTo(want.busyShare, 6);
      const s = r.model.s.tx;
      expect(s.rd + s.rdx + s.upgr).toBe(want.bus);
    }, 600000);
  }
});
