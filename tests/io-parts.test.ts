import { describe, expect, it } from 'vitest';
import { buzzerHz, ledGrid, partDef } from '../src/editor/parts';
import { cycleCounter, randomSource, xnorLfsrNext } from '../src/lib/seqparts';
import { resolveComponent } from '../src/lib/resolve';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { symbolGeom } from '../src/sim/geometry';
import { pack } from '../src/sim/values';

const run = (def: ReturnType<typeof randomSource>, cycles: number): number[] => {
  const sim = new GateSim(flatten(def, { mode: 'gate' }));
  sim.setInput('clk', 0);
  sim.reset('zero');
  sim.settle();
  const out = [pack(sim.getBits(sim.design.root.ports.q))];
  for (let i = 0; i < cycles; i++) {
    sim.setInput('clk', 1);
    sim.settle();
    sim.setInput('clk', 0);
    sim.settle();
    out.push(pack(sim.getBits(sim.design.root.ports.q)));
  }
  return out;
};

describe('sources', () => {
  it('the random source runs from zero through 2^n − 1 states, never all ones, matching its model', () => {
    for (const n of [4, 8]) {
      const seq = run(randomSource(n), 2 ** n - 1);
      expect(seq[0]).toBe(0);
      for (let i = 1; i < seq.length; i++) expect(seq[i], `n=${n} step ${i}`).toBe(xnorLfsrNext(seq[i - 1], n));
      expect(new Set(seq.slice(0, -1)).size).toBe(2 ** n - 1);
      expect(seq).not.toContain(2 ** n - 1);
      expect(seq[seq.length - 1]).toBe(0); // the period
    }
  });

  it('the 16-bit random source follows its model', () => {
    const seq = run(randomSource(16), 40);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBe(xnorLfsrNext(seq[i - 1], 16));
  });

  it('the cycle counter counts every edge and wraps', () => {
    expect(run(cycleCounter(8), 300).every((v, i) => v === i % 256)).toBe(true);
    expect(run(cycleCounter(32), 5)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('both resolve by id for the sandbox palette', () => {
    expect(resolveComponent('random8')).toBe(randomSource(8));
    expect(resolveComponent('cycles16')).toBe(cycleCounter(16));
  });
});

describe('LED bank and buzzer', () => {
  it('an LED bank grows with its width, its port on the grid', () => {
    expect(ledGrid(1)).toMatchObject({ w: 4, h: 2 });
    expect(ledGrid(8)).toMatchObject({ cols: 8, rows: 1 });
    expect(ledGrid(32)).toMatchObject({ cols: 8, rows: 4 });
    for (const w of [1, 4, 8, 13, 32, 64]) {
      const d = partDef({ display: 'led', width: w }, () => undefined);
      if ('error' in d) throw new Error(d.error);
      const g = symbolGeom(d);
      expect(Number.isInteger(g.ports.a.pos[1]), `width ${w}`).toBe(true);
      expect(g.h).toBeGreaterThanOrEqual(ledGrid(w).rows * 1.4);
    }
  });

  it('a buzzer sounds A4 on 1, MIDI notes on a bus, nothing on 0', () => {
    expect(buzzerHz(1, 0)).toBe(0);
    expect(buzzerHz(1, 1)).toBe(440);
    expect(buzzerHz(7, 69)).toBe(440);
    expect(buzzerHz(7, 81)).toBeCloseTo(880);
    expect(buzzerHz(7, 60)).toBeCloseTo(261.63, 1);
    expect(buzzerHz(16, 1000)).toBe(buzzerHz(7, 127));
    const d = partDef({ display: 'buzzer' }, () => undefined);
    expect('error' in d ? d.error : d.alias).toEqual([]);
  });
});
