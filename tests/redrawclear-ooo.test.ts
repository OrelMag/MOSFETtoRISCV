import { describe, expect, it } from 'vitest';
import { byField, iqEntry, RAT, RAT_ROW, SELECT8, STORE_QUEUE } from '../src/lib/ooo';
import { oooCpu } from '../src/lib/ooocore';
import { resolveComponent } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { labelOverlaps, routeNetlist, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { drawnNetlist, wireCrossings, wiresThroughParts } from '../src/view/wirefirst';

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

// The core's top level and its two largest blocks (chapter 26's steps 9 and 12 open them). The top keeps its five bands
// (lib/ooocore.ts oooDrawing): 18 nets the router could only draw under another part are labels, so none runs through one
// (75.6 % pointers, 103 crossings, 17 through parts before; laid out by depth instead it was 754 crossings, 57 through parts).
// The issue queue is laid out by depth (88.7 % pointers and 285 crossings before). The reorder buffer keeps its 4 × 4 grid
// of entries, which now reach their four field bundles through one wiring box, BY FIELD, in place of 16 splitters crossing
// into 4 mergers (1017 crossings before, 4 wires through parts: the head's read ports, now labels). Laid out by depth it
// stacked its 16 entries in one column too tall to read. Its pointers are pinned as a count (147 before, 151 with the head's
// four labels), since the transpose's 64 wires left the nets with it and a share would rise. Crossings are pinned too.
const core = (o: { rob?: number; iq?: number; sq?: number } = {}) => oooCpu(assemble('li a0, 1\nj .').words, { imemK: 6, dmemK: 6, ...o });
const part = (name: string, o = {}) => netlistOf(core(o))!.instances.find((i) => i.name === name)!.def;
const big: [string, () => ComponentDef, { share?: number; count?: number; crossings: number }][] = [
  ['core top level', () => core(), { share: 0.80, crossings: 49 }],
  ['core top level (ROB 32, issue queue 16, store queue 8)', () => core({ rob: 32, iq: 16, sq: 8 }), { share: 0.80, crossings: 60 }],
  ['issue queue', () => part('iq'), { share: 0.75, crossings: 161 }],
  ['reorder buffer', () => part('rob'), { count: 151, crossings: 116 }],
];
const drawn = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  return { nl, r: routeNetlist(def, nl) };
};

describe('the out-of-order core and its queues drawn clear', () => {
  it.each(big)('%s: no wire runs through a part', (_, make) => {
    const { nl, r } = drawn(make());
    expect([...wiresThroughParts(nl, r.nets)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  }, 60_000);
  it.each(big)('%s: no label hides another, no symbol sits on another', (_, make) => {
    const def = make();
    expect(labelOverlaps(def, netlistOf(def)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(def)!)).toEqual([]);
  }, 60_000);
  it.each(big)('%s: its pointers and crossings no more than when redrawn', (_, make, pin) => {
    const { nl, r } = drawn(make());
    const tagged = nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length;
    if (pin.share !== undefined) expect(tagged / nl.nets.length).toBeLessThanOrEqual(pin.share + 0.005);
    if (pin.count !== undefined) expect(tagged).toBeLessThanOrEqual(pin.count);
    expect(wireCrossings(r.nets)).toBeLessThanOrEqual(pin.crossings);
  }, 60_000);
});

describe('BY FIELD', () => {
  it('is wiring only: output i holds field i of every entry, entry 0 lowest, and resolves by its id', () => {
    const F = [1, 3, 2], def = byField(4, F);
    expect(def.prim).toBe('alias');
    expect(resolveComponent(def.id)).toBe(def);
    const at = new Map(def.alias!.map(([pa, ba, pb, bb]) => [`${pb}:${bb}`, `${pa}:${ba}`]));
    // field 1 (3 bits at offset 1) of entry 2 is f1's bits 6..8
    expect([6, 7, 8].map((b) => at.get(`f1:${b}`))).toEqual(['e2:1', 'e2:2', 'e2:3']);
    expect(def.alias!.length).toBe(4 * 6);
  });
});
