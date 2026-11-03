import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { COH_PROGRAMS } from '../src/riscv/cohprograms';
import { CohModel } from '../src/riscv/cohmodel';
import { MultiISS } from '../src/riscv/multi';
import { replayCheck } from './cohkit';

function runModel(source: string, coherent = true, max = 20000) {
  const w = assemble(source).words, m = new CohModel(w, { coherent }), ref = new MultiISS(w, 2);
  for (let c = 0; c < max && !m.halted; c++) {
    const pre = m.m.harts.map((h): [boolean, number] => [h.resValid, h.resLine]);
    const r = m.step();
    const inv = m.invariants();
    if (inv) throw new Error(`cycle ${c}: ${inv}`);
    if (coherent) { const bad = replayCheck(m, ref, r, pre); if (bad) throw new Error(`cycle ${c}: ${bad}`); }
  }
  if (coherent) expect([...m.memoryView()], "memory view at halt = the sequentially consistent replay").toEqual([...ref.dmem]);
  return m;
}

describe('coherent timing model', () => {
  for (const p of COH_PROGRAMS) {
    it(`${p.id}: halts, invariants hold, retirement order is sequentially consistent`, () => {
      const m = runModel(p.source);
      expect(m.halted).toBe(true);
      const mem = m.memoryView();
      if (p.id === 'atomic' || p.id === 'spin' || p.id === 'ttas' || p.id === 'lrsc') expect(mem[16]).toBe(40);
      if (p.id === 'race') expect(mem[16]).toBeLessThan(40);
      if (p.id === 'falseshare' || p.id === 'padded') expect([mem[16], mem[p.id === 'padded' ? 20 : 17]]).toEqual([20, 20]);
      if (p.id === 'stale') expect(m.m.harts[1].x[7]).toBe(7); // t2
      console.log(p.id, m.cycles, 'cycles', JSON.stringify({ tx: m.s.tx, inv: m.s.invalidations, fl: m.s.flushes, wb: m.s.writebacks, scF: m.s.scFails, stalls: m.s.stalls }));
    });
  }
  it('without snooping the second read of x is stale', () => {
    const m = runModel(COH_PROGRAMS[0].source, false);
    expect(m.m.harts[1].x[7]).toBe(0);
  });
});

import { randomCoherentProgram } from '../src/riscv/cohfuzz';
import { tick } from './yieldtick';

describe('coherent model fuzz', () => {
  it('random programs: halt, SWMR, sequentially consistent retirement order, memory view = golden at halt', async () => {
    const seen = { tx: 0, flush: 0, scFail: 0, wb: 0, scOk: 0, resvLost: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const src = randomCoherentProgram(seed);
      let m: CohModel;
      try { m = runModel(src); } catch (e) { throw new Error(`seed ${seed}: ${(e as Error).message}\n${src}`); }
      expect(m.halted, `seed ${seed}`).toBe(true);
      seen.tx += m.s.tx.rd + m.s.tx.rdx + m.s.tx.upgr; seen.flush += m.s.flushes; seen.wb += m.s.writebacks;
      seen.scFail += m.s.scFails[0] + m.s.scFails[1]; seen.scOk += m.s.scOk[0] + m.s.scOk[1];
      seen.resvLost += m.s.log.filter((e) => e.resvLost).length;
      if (seed % 20 === 0) await tick();
    }
    console.log('fuzz coverage', JSON.stringify(seen));
    expect(seen.flush).toBeGreaterThan(100);
    expect(seen.wb).toBeGreaterThan(20);
    expect(seen.scFail).toBeGreaterThan(20);
    expect(seen.scOk).toBeGreaterThan(20);
  }, 300000);
});

// A plain shared memory: the same lr / sc rule through MultiISS alone (every store to a reserved line takes the reservation)
import { assemble as asmb } from '../src/riscv/asm';
describe('MultiISS lr.w / sc.w', () => {
  it('the lr / sc atomic add loses no update on one plain memory either', () => {
    const m = new MultiISS(asmb(COH_PROGRAMS.find((p) => p.id === 'lrsc')!.source).words);
    for (let c = 0; c < 4000 && !m.halted; c++) m.step();
    expect(m.halted).toBe(true);
    expect(m.dmem[16]).toBe(40);
  });
});
