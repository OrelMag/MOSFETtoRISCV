import { describe, expect, it } from 'vitest';
import { SLICE } from '../src/lib/fpga';
import { bistAdder } from '../src/lib/bist';
import { netlistOf } from '../src/sim/types';
import { routeNetlist, symbolOverlaps, labelOverlaps } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// The FPGA chapter's logic cell: arith, clk and reg run as wires under the cell and f over the flip-flop (lib/fpga.ts SLICE):
// no net left as a label, no wire under a part, nothing on top of anything.
describe('FPGA logic cell drawn with wires', () => {
  const nl = drawnNetlist(SLICE, netlistOf(SLICE)!);
  it('no net is a pointer', () => {
    expect(nl.nets.filter((n) => n.tags).map((n) => n.name)).toEqual([]);
  });
  it('no wire runs through a part, no overlaps', () => {
    const hit = wiresThroughParts(nl, routeNetlist(SLICE, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(labelOverlaps(SLICE, nl)).toEqual([]);
  });
});

// The verify chapter's self-testing adder: columns 8 units apart (was 12), so the row is 82 units wide instead of 106 and reads larger at fit.
describe('self-testing adder, compact', () => {
  const def = bistAdder(4), nl = drawnNetlist(def, netlistOf(def)!);
  it('82 units wide, clean', () => {
    expect((netlistOf(def)!.pins as Record<string, [number, number]>).pattern[0]).toBeLessThanOrEqual(82);
    expect([...wiresThroughParts(nl, routeNetlist(def, nl).nets)]).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(labelOverlaps(def, nl)).toEqual([]);
  });
});
