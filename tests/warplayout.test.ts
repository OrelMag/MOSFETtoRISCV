// The warp core's hand layout (lib/warps.ts warpCoreDrawing) in the variants the chapters, the widgets and the tests
// build: the registry-wide schematic tests never see it (warpCore registers its parts, not its top level).

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { warpCore, type WarpCoreOptions } from '../src/lib/warps';
import { assemble } from '../src/riscv/asm';
import { WARP_PROGRAMS } from '../src/riscv/warpprograms';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const P = (id: string) => WARP_PROGRAMS.find((p) => p.id === id)!;
// a small data memory: the top level's drawing does not depend on it
const variants: [string, string, WarpCoreOptions][] = [
  ['chapter 30, one warp', 'saxpy64', { warps: 1, lanes: 4 }],
  ['chapter 30, four warps', 'saxpy64', { warps: 4, lanes: 4 }],
  ['occupancy: two warps', 'saxpy64', { warps: 2, lanes: 4 }],
  ['occupancy: eight warps', 'saxpy64', { warps: 8, lanes: 4 }],
  ['four warps of two lanes', 'saxpy64', { warps: 4, lanes: 2, latency: 3 }],
  ['eight warps of eight lanes', 'saxpy64', { warps: 8, lanes: 8 }],
  ['chapter 31', 'hist', { warps: 4, lanes: 4, lsu: true }],
  ['chapter 31, mul', 'matmul', { warps: 4, lanes: 4, lsu: true, mul: true, globalEvery: 3 }],
  ['lsu, one warp of two lanes', 'hist', { warps: 1, lanes: 2, lsu: true }],
  ['lsu, two warps of two lanes', 'hist', { warps: 2, lanes: 2, latency: 4, lsu: true }],
  ['lsu, eight warps of eight lanes, mul', 'matmul', { warps: 8, lanes: 8, lsu: true, mul: true }],
  ['chapter 33, the kernel', 'saxpy64', { warps: 1, lanes: 4, mul: true }],
  ['chapter 33, with the host port', 'saxpy64', { warps: 1, lanes: 4, mul: true, host: true }],
  ['host port, four warps', 'saxpy64', { warps: 4, lanes: 4, host: true }],
];

describe('warp core schematic', () => {
  it.each(variants)('%s: no two nets on one line, no overlaps, no wire from behind a pin', (_, prog, o) => {
    const words = assemble(P(prog).source(o.lanes ?? 4)).words;
    const d = warpCore(words, { dmemK: 4, smemK: 4, ...o }), nl = netlistOf(d)!;
    const t0 = performance.now();
    const routed = routeNetlist(d, nl);
    expect(performance.now() - t0, 'route time (ms)').toBeLessThan(2000);
    expect(wireOverlaps(routed.nets)).toEqual([]);
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(backwardEnds(d, nl)).toEqual([]);
    // every label names one net: two nets drawn with the same name would read as one
    const names = nl.nets.map((n) => n.name).filter(Boolean);
    expect(names.length - new Set(names).size).toBe(0);
  }, 60000);
});
