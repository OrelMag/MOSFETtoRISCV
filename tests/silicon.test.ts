import { describe, expect, it } from 'vitest';
import { FULL_ADDER, NOT, alu, rca, counter } from '../src/lib';
import { Layout, problemOf, routeAll } from '../src/sim/pnr';
import { techMap } from '../src/sim/techmap';

describe('technology mapping', () => {
  it('finds inverters and double inversions', () => {
    expect(techMap(NOT)).toMatchObject({ nands: 1, inverters: 1, mappedTransistors: 2 });
    const fa = techMap(FULL_ADDER);
    expect(fa).toMatchObject({ nands: 9, inverters: 0, mappedTransistors: 36 });
    const a = techMap(alu(32, 'ks'));
    console.log('alu32', JSON.stringify(a));
    expect(a.mappedTransistors).toBeLessThan(a.nandTransistors);
  });
});

describe('place and route', () => {
  for (const [name, def] of [['FA', FULL_ADDER], ['rca4', rca(4)], ['counter4', counter(4)]] as const) {
    it(`${name}: annealing reduces wirelength and every net routes`, () => {
      const lay = new Layout(problemOf(def));
      lay.randomize();
      const before = lay.totalHpwl();
      let T = 8;
      for (let k = 0; k < 40; k++) { lay.anneal(400, T); T *= 0.88; }
      const after = lay.totalHpwl();
      const r = routeAll(lay);
      console.log(`${name}: ${lay.prob.cells.length} cells, ${lay.prob.nets.length} nets, HPWL ${before} → ${after}, wire ${r.wirelength}, vias ${r.vias}, failed ${r.failed.length}`);
      expect(after).toBeLessThan(before);
      expect(r.failed).toEqual([]);
      // every routed path is connected: consecutive points are neighbours (same layer) or a via
      for (const ps of r.paths.values()) for (const p of ps) for (let i = 1; i < p.length; i++) {
        const [x0, y0, l0] = p[i - 1], [x1, y1, l1] = p[i];
        const step = Math.abs(x0 - x1) + Math.abs(y0 - y1);
        expect(l0 === l1 ? step === 1 && (l0 === 0 ? y0 === y1 : x0 === x1) : step === 0).toBe(true);
      }
    });
  }
});
