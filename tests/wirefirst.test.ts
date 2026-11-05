import { describe, expect, it } from 'vitest';
import { DFF_EDGE6 } from '../src/lib/seqdeep';
import { netlistOf, type ComponentDef, type Netlist } from '../src/sim/types';
import { reachableDefs } from '../src/lib/resolve';
import { labelOverlaps, routeNetlist, wireOverlaps } from '../src/view/route';
import { drawnNetlist, MAX_CROSSINGS_PER_NET, WHOLE_NETS, wireCrossings } from '../src/view/wirefirst';
import { tick } from './yieldtick';

const hasTags = (nl: Netlist) => nl.nets.some((n) => n.tags === true || (n.tags?.length ?? 0) > 0);

describe('wires first', () => {
  it('draws the six-gate flip-flop with wires: its loops are what the step teaches', () => {
    const nl = netlistOf(DFF_EDGE6)!;
    expect(hasTags(nl)).toBe(true);
    expect(hasTags(drawnNetlist(DFF_EDGE6, nl))).toBe(false);
  });

  it('keeps nets, ends and order: only how a net is drawn changes', () => {
    const nl = netlistOf(DFF_EDGE6)!, dn = drawnNetlist(DFF_EDGE6, nl);
    expect(dn.nets.map((n) => n.ends)).toEqual(nl.nets.map((n) => n.ends));
    expect(dn.instances).toBe(nl.instances);
  });

  it('counts a crossing once, between two nets only', () => {
    expect(wireCrossings([{ paths: [[[0, 5], [10, 5]]] }, { paths: [[[5, 0], [5, 10]]] }])).toBe(1);
    expect(wireCrossings([{ paths: [[[0, 5], [10, 5]], [[5, 0], [5, 10]]] }])).toBe(0);
  });

  it('never draws two nets on one line, on any level with pointers', async () => {
    const bad: string[] = [];
    const defs: ComponentDef[] = reachableDefs();
    expect(defs.length).toBeGreaterThan(200);
    for (const def of defs) {
      const nl = netlistOf(def);
      if (!nl || !hasTags(nl)) continue;
      const dn = drawnNetlist(def, nl);
      await tick();
      if (dn === nl) continue;
      const r = routeNetlist(def, dn).nets;
      if (wireOverlaps(r).length) bad.push(`${def.id}: wires overlap`);
      if (!hasTags(dn) && nl.nets.length <= WHOLE_NETS && wireCrossings(r) > MAX_CROSSINGS_PER_NET * nl.nets.length) bad.push(`${def.id}: too many crossings`);
      if (labelOverlaps(def, dn).length > labelOverlaps(def, nl).length) bad.push(`${def.id}: labels collide`);
    }
    expect(bad).toEqual([]);
  }, 600_000);
});
