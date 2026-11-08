import { describe, expect, it } from 'vitest';
import { csrUnit, systemCpu } from '../src/lib/system';
import { busCore } from '../src/lib/soc';
import { assemble } from '../src/riscv/asm';
import { labelOverlaps, routeNetlist, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// The system CPU's variants drawn on the plain system's wires (circuit redraw, pointer review): the M extension and the
// memory over a bus (and the bus core the sandbox places, its boot ROM outside), and the CSR unit's select crossbar. As in
// tests/redrawclear.test.ts: a wire drawn under a part's body seems to vanish and come back elsewhere; no label hides
// another and no symbol sits on another. `pointers`: the share of nets drawn as pointers when they were redrawn (82 % and
// 87 % before for M and the bus, 29 % for the CSR unit), so a later edit cannot slide back unnoticed.
const w = assemble('j .').words;
const levels: [string, () => ComponentDef, number][] = [
  ['system CPU, M extension', () => systemCpu(w, { m: true }), 0.25],
  ['system CPU on a bus', () => systemCpu(w, { bus: true }), 0.43],
  ['system core on a bus (boot ROM outside)', () => busCore(7), 0.43],
  ['CSR unit', () => csrUnit(false), 0.22],
  ['CSR unit, M', () => csrUnit(true), 0.22],
];
const pointerShare = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  return nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length / nl.nets.length;
};

describe('system CPU variants drawn with wires', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const r = routeNetlist(def, nl);
    expect([...wiresThroughParts(nl, r.nets)].map((i) => nl.nets[i].name)).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: no label hides another, no symbol sits on another', (_, make) => {
    const def = make();
    expect(labelOverlaps(def, netlistOf(def)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(def)!)).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: every pointer is a named line', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    expect(nl.nets.filter((n) => (n.tags === true || (n.tags?.length ?? 0) > 0) && !n.name).length).toBe(0);
  }, 60_000);
  it.each(levels)('%s: drawn mostly with wires', (_, make, share) => {
    expect(pointerShare(make())).toBeLessThanOrEqual(share + 0.005);
  }, 60_000);
});

describe('the CSR unit\'s select crossbar', () => {
  it('wires every comparator to the known OR and the index encoders; only the write gates stay pointers', () => {
    const nl = netlistOf(csrUnit(false))!;
    for (const n of nl.nets.filter((x) => x.name?.startsWith('is_'))) {
      const tags = Array.isArray(n.tags) ? n.tags : n.tags ? n.ends.slice(1) : [];
      expect(tags.every((e) => e.startsWith('w_')), `${n.name}: ${tags.join(', ')}`).toBe(true);
      expect(n.ends.some((e) => e.startsWith('known.'))).toBe(true);
    }
  });
});
