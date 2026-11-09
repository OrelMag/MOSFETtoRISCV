import { describe, expect, it } from 'vitest';
import { iqEntry, RAT, RAT_ROW, SELECT8, STORE_QUEUE } from '../src/lib/ooo';
import { labelOverlaps, routeNetlist, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// The out-of-order core's units as chapter 26 opens them (circuit redraw, pointer review): the rename table and one of its
// rows (step 5), an issue-queue entry (step 6), select (step 7, a crossbar: a column per entry j holding its row of the age
// matrix, a band per entry e whose ANDs each feed their own input of e's OR) and the store queue (step 10). As in
// tests/redrawclear.test.ts: a wire drawn under a part's body seems to vanish and come back elsewhere; no label hides another
// and no symbol sits on another. `pointers`: the share of nets drawn as pointers when they were redrawn (50 %, 56 %, 55 %, 56 %
// and 66 % before), so a later edit cannot slide back unnoticed.
const levels: [string, () => ComponentDef, number][] = [
  ['rename table', () => RAT, 0.30],
  ['rename-table row', () => RAT_ROW, 0],
  ['issue-queue entry', () => iqEntry(98), 0.31],
  ['select (8 entries)', () => SELECT8, 0.12],
  ['store queue', () => STORE_QUEUE, 0.40],
];
const pointerShare = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  return nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length / nl.nets.length;
};

describe('the out-of-order units drawn with wires', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const r = routeNetlist(def, nl);
    expect([...wiresThroughParts(nl, r.nets)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: no label hides another, no symbol sits on another', (_, make) => {
    const def = make();
    expect(labelOverlaps(def, netlistOf(def)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(def)!)).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: drawn mostly with wires', (_, make, share) => {
    expect(pointerShare(make())).toBeLessThanOrEqual(share + 0.005);
  }, 60_000);
});

describe('select as a crossbar', () => {
  it('puts every AND of entry e in e\'s band, one per column j, and feeds each its own input of e\'s OR', () => {
    const nl = netlistOf(SELECT8)!;
    const at = new Map(nl.instances.map((i) => [i.name, i.at!]));
    for (let e = 0; e < 8; e++) {
      const ys = [...Array(8).keys()].filter((j) => j !== e).map((j) => at.get(`o${j}_${e}`)![1]);
      // in the band, top to bottom by column
      expect([...ys].sort((a, b) => a - b)).toEqual(ys);
      // and the bands do not overlap: the next band starts below this one's last gate
      if (e < 7) expect(Math.min(...[...Array(8).keys()].filter((j) => j !== e + 1).map((j) => at.get(`o${j}_${e + 1}`)![1]))).toBeGreaterThan(Math.max(...ys) + 3);
    }
    for (let j = 0; j < 8; j++) {
      const xs = [...Array(8).keys()].filter((e) => e !== j).map((e) => at.get(`o${j}_${e}`)![0]);
      expect(new Set(xs).size, `column ${j}`).toBe(1);
    }
  });
});
