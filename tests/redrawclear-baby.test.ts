import { describe, expect, it } from 'vitest';
import { BABY, BABY_ACC, BABY_CONTROL, BABY_DECODE, BABY_STAT, BABY_TIMING, BABY_WRITE } from '../src/lib/baby';
import { BABY_SERIAL, SERIAL_STAGE } from '../src/lib/babyserial';
import { williamsColumn, williamsScan, williamsTube } from '../src/lib/babytube';
import { TUBE_K } from '../src/widgets/babytubeview';
import { labelOverlaps, routeNetlist, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { drawnNetlist, wireCrossings, wiresThroughParts } from '../src/view/wirefirst';

// Appendix E's levels (the Baby, its blocks, the serial subtractor, the Williams tube line), as in tests/redrawclear.test.ts:
// no wire runs under a part's body, no label hides another, no symbol sits on another. Before the audit of 2026-11-10 the
// accumulator had 1 such wire, the serial subtractor 4 (and 93 crossings: its result was 32 loose flip-flops fanned into a
// merger; now a shift register like its operands'), the tube line 4, its column 1 and its scanner 1. `pointers` and
// `crossings` are what the fix left.
const levels: [string, () => ComponentDef, number, number][] = [
  ['the Baby', () => BABY, 0.52, 14],
  ['beats', () => BABY_TIMING, 0, 3],
  ['decode', () => BABY_DECODE, 0, 1],
  ['CI', () => BABY_CONTROL, 0.05, 17],
  ['accumulator', () => BABY_ACC, 0.28, 3],
  ['staticisor', () => BABY_STAT, 0, 12],
  ['rewrite', () => BABY_WRITE, 0, 0],
  ['serial subtractor', () => BABY_SERIAL, 0.05, 40],
  ['serial stage', () => SERIAL_STAGE, 0, 5],
  ['tube line', () => williamsTube(TUBE_K), 0.16, 48],
  ['tube column', () => williamsColumn(2 ** TUBE_K), 0, 77],
  ['tube scanner', () => williamsScan(TUBE_K), 0.11, 18],
];
const drawn = (def: ComponentDef) => { const nl = drawnNetlist(def, netlistOf(def)!); return { nl, r: routeNetlist(def, nl) }; };
const pointerShare = (nl: ReturnType<typeof drawn>['nl']) =>
  nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length / nl.nets.length;

describe('Appendix E drawn with wires', () => {
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
});
