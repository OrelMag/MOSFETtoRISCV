import { describe, expect, it } from 'vitest';
import { csrUnitVm, mmu, pcheck, tlb, trapUnitVm, walker } from '../src/lib/vm';
import { labelOverlaps, routeNetlist, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { drawnNetlist, wireCrossings, wiresThroughParts } from '../src/view/wirefirst';

// The virtual-memory units the vmem and os chapters open (lib/vm.ts), as in tests/redrawclear.test.ts: a wire drawn under a
// part's body seems to vanish and come back elsewhere, so none may; no label hides another and no symbol sits on another.
// Before the audit of 2026-11-10 the MMU had 2 such wires, each TLB 4, the walker 2 and the CSR unit 4. `pointers` and
// `crossings` are what the fix left (the share of nets drawn as pointers, wire crossings), so a later edit cannot slide back.
const levels: [string, () => ComponentDef, number, number, number][] = [
  ['MMU', mmu, 0.47, 46, 10],
  ['instruction TLB', () => tlb('i'), 0.24, 50, 4],
  ['data TLB', () => tlb('d'), 0.24, 50, 4],
  ['page-table walker', walker, 0.43, 29, 8],
  ['permission check, fetch', () => pcheck('i'), 0, 0, 0],
  ['permission check, data', () => pcheck('d'), 0, 22, 0],
  ['CSR unit (M, S, U)', csrUnitVm, 0.76, 56, 56],
  ['trap unit (M, S, U)', trapUnitVm, 0.43, 25, 18],
];
const drawn = (def: ComponentDef) => { const nl = drawnNetlist(def, netlistOf(def)!); return { nl, r: routeNetlist(def, nl) }; };
const pointerShare = (nl: ReturnType<typeof drawn>['nl']) =>
  nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length / nl.nets.length;

describe('virtual-memory units drawn with wires', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const { nl, r } = drawn(make());
    expect([...wiresThroughParts(nl, r.nets)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: no label hides another, no symbol sits on another', (_, make) => {
    const def = make();
    expect(labelOverlaps(def, netlistOf(def)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(def)!)).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: pointers and crossings no worse than the redraw left them', (_, make, share, crossings) => {
    const { nl, r } = drawn(make());
    expect(pointerShare(nl)).toBeLessThanOrEqual(share + 0.005);
    expect(wireCrossings(r.nets)).toBeLessThanOrEqual(crossings);
  }, 60_000);
  // an unnamed pointer is drawn as n<index>: lib/autoname.ts names most from their drivers (before: MMU 19, TLBs 5, walker 17, CSR unit 102)
  it.each(levels)('%s: unnamed pointers no more than the naming left', (_, make, _s, _x, unnamed) => {
    const { nl } = drawn(make());
    expect(nl.nets.filter((n) => (n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)) && !n.name).length).toBeLessThanOrEqual(unnamed);
  }, 60_000);
});
