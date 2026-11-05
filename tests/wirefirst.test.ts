import { describe, expect, it } from 'vitest';
import { DFF_EDGE6 } from '../src/lib/seqdeep';
import { netlistOf, type ComponentDef, type Netlist } from '../src/sim/types';
import { reachableDefs } from '../src/lib/resolve';
import { partnerLines } from '../src/view/partners';
import { labelOverlaps, routeNetlist, wireOverlaps, type NetTag } from '../src/view/route';
import { drawnNetlist, MAX_CROSSINGS_PER_NET, WHOLE_NETS, wireCrossings, wiresThroughParts } from '../src/view/wirefirst';
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

describe('wires first and the parts', () => {
  // A wire is drawn under a part's body: run through one, it seems to vanish and come back somewhere else.
  it('never adds a wire through a part', async () => {
    const bad: string[] = [];
    for (const def of reachableDefs()) {
      const nl = netlistOf(def);
      if (!nl || !hasTags(nl)) continue;
      const dn = drawnNetlist(def, nl);
      await tick();
      if (dn === nl) continue;
      const hit = wiresThroughParts(dn, routeNetlist(def, dn).nets);
      const authored = wiresThroughParts(nl, routeNetlist(def, nl).nets);
      const added = [...hit].filter((i) => !authored.has(i));
      if (added.length) bad.push(`${def.id}: ${added.map((i) => nl.nets[i].name ?? nl.nets[i].ends[0]).join(', ')}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it('finds a wire through a part, not one that ends on its edge', () => {
    const nl = netlistOf(DFF_EDGE6)!;
    const i = nl.instances[0], [x, y] = i.at!;
    const net = (paths: [number, number][][]) => ({ index: 0, width: 1, tags: [], paths, ends: [], dots: [], label: null, labelRoom: 0 });
    expect(wiresThroughParts(nl, [net([[[x - 5, y + 1], [x + 20, y + 1]]])]).size).toBe(1);
    expect(wiresThroughParts(nl, [net([[[x - 5, y + 1], [x, y + 1]]])]).size).toBe(0);
  });
});

describe('partner lines', () => {
  const tag = (end: string, x: number): NetTag => ({ end, pos: [x, 0], dir: 'right', stub: 1 });
  it('run from the driver pointer to every other pointer', () => {
    const lines = partnerLines({ tags: [tag('a.y', 0), tag('b.a', 10), tag('c.a', 20)], paths: [] }, 'n', 'a.y');
    expect(lines).toEqual([[[1, 0], [11, 0]], [[1, 0], [21, 0]]]);
  });
  it('start at the wires when the driver has no pointer', () => {
    expect(partnerLines({ tags: [tag('c.a', 20)], paths: [[[3, 4], [5, 4]]] }, 'n', 'a.y')).toEqual([[[3, 4], [21, 0]]]);
  });
});
