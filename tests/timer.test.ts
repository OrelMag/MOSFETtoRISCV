import { describe, expect, it } from 'vitest';
import { familyOf, resolveComponent } from '../src/lib/resolve';
import { timer, TIMER_PERIODS } from '../src/lib/seqparts';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

describe('timer(period)', () => {
  it.each([10, 100])('period %i: irq every period edges, held until ack, count wraps', (period) => {
    const sim = new GateSim(flatten(timer(period)));
    sim.reset('zero');
    sim.setInput('ack', 0); sim.setInput('clk', 0); sim.settle();
    const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
    const edge = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
    const rises: number[] = [];
    let prev = 0;
    for (let e = 1; e <= 3 * period; e++) {
      edge();
      expect(out('count')).toBe(e % period);
      const irq = out('irq');
      if (irq && !prev) rises.push(e);
      prev = irq;
      // acknowledge two edges after it rises: it stays up until then
      if (irq && rises.length && e === rises[rises.length - 1] + 1) sim.setInput('ack', 1);
      else sim.setInput('ack', 0);
      sim.settle();
    }
    expect(rises).toEqual([period, 2 * period, 3 * period]);
  });

  it('is a workbench family: the properties pick the period', () => {
    for (const p of TIMER_PERIODS) {
      expect(familyOf(`timer${p}`)?.values.period).toBe(p);
      expect(resolveComponent(`timer${p}`)?.id).toBe(`timer${p}`);
    }
  });
});
