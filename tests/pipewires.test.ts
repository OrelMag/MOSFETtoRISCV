import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { OWN_ANSWER } from '../src/widgets/owninstr';
import { netlistOf } from '../src/sim/types';
import { symbolGeom } from '../src/sim/geometry';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { wireCrossings } from '../src/view/wirefirst';

// The plain pipeline (ripple adders, no predictor / cache / M / ports) is drawn with wires: control below the
// datapath, feedback over the top and under the hazard unit, the hazard unit flipped below the decode stage.
describe('the pipelined CPU drawn with wires', () => {
  const words = [0x13];
  for (const opts of [{}, { imemK: 8, dmemK: 6 }, { imemK: 5, dmemK: 4 }, { custom: [OWN_ANSWER] }]) {
    it(`keeps pointers to a handful and never draws two nets on one line ${JSON.stringify(opts)}`, () => {
      const d = pipelinedCpu(words, opts);
      const nl = netlistOf(d)!;
      const r = routeNetlist(d, nl).nets;
      const labels = r.reduce((t, n) => t + n.tags.length, 0);
      expect(labels).toBeLessThanOrEqual(12);
      expect(wireOverlaps(r)).toEqual([]);
      expect(symbolOverlaps(nl)).toEqual([]);
      expect(labelOverlaps(d, nl)).toEqual([]);
      // no wire runs through a part (a splitter bar excepted)
      const through: string[] = [];
      r.forEach((n, k) => { for (const p of n.paths) for (let i = 0; i + 1 < p.length; i++) {
        const [x0, y0] = p[i], [x1, y1] = p[i + 1];
        for (const inst of nl.instances) { if (inst.def.prim === 'alias') continue; const g = symbolGeom(inst.def); const [bx, by] = inst.at!; const e = 1e-6;
          const hit = x0 === x1 ? x0 > bx + e && x0 < bx + g.w - e && Math.max(y0, y1) > by + e && Math.min(y0, y1) < by + g.h - e : y0 > by + e && y0 < by + g.h - e && Math.max(x0, x1) > bx + e && Math.min(x0, x1) < bx + g.w - e;
          if (hit) through.push(`${nl.nets[k].name} through ${inst.name}`); } } });
      expect(through).toEqual([]);
      // plain unravelling of the author's original placement was 920 crossings
      expect(wireCrossings(r)).toBeLessThan(600);
    });
  }

  it('keeps the hazard unit flipped and quiet control, and leaves the variants as they were', () => {
    const nl = netlistOf(pipelinedCpu(words))!;
    expect(nl.instances.find((i) => i.name === 'hz')!.flip).toBe(true);
    expect(nl.nets.find((n) => n.name === 'forwardA')!.quiet).toBe(true);
    for (const v of [{ adder: 'ks' as const }, { balanced: true, adder: 'ks' as const }, { predictor: true, balanced: true, adder: 'ks' as const }, { dcache: 'wt' as const }, { m: true }]) {
      const n = netlistOf(pipelinedCpu(words, v))!;
      expect(n.instances.find((i) => i.name === 'hz')!.flip).toBeUndefined();
      expect(n.nets.filter((x) => x.tags === true || (x.tags?.length ?? 0) > 0).length).toBeGreaterThan(40);
    }
  });
});
