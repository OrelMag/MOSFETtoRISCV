import { describe, expect, it } from 'vitest';
import '../src/lib';
import { MUX16 } from '../src/lib/rv16/logic';
import { srt4Divider } from '../src/lib/srt4';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, symbolRects } from '../src/view/route';
import { drawnNetlist, wireCrossings, wiresThroughParts } from '../src/view/wirefirst';

// Two levels redrawn by hand (ROADMAP "Still open"), measured as in the other redrawclear tests: the drawn netlist (wires first),
// routed; no wire under a part's body, no label hiding another, no symbol on another, and the pointers and crossings held
// where the redraw left them so a later edit cannot slide back unnoticed.
//
// rv16_mux16 (g_mux8's reference answer, still flat with the same instance names) was sixteen rows deep, 0.33 wide for 1 tall,
// so at fit its gates were drawn at about 4 px a grid unit; as four columns of four bits it is about 2.6 times as wide as tall.
// srt4div8 (chapter 21's radix-4 divider) had 17 pointers in 46 nets and 41 crossings: now the register outputs run as a band
// into FINISH with the step's inputs rising from it, and only the clock, load, step and the four next-state words are pointers.
const measure = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  const r = routeNetlist(def, nl);
  return {
    pointers: nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length,
    nets: nl.nets.length,
    crossings: wireCrossings(r.nets),
    through: [...wiresThroughParts(nl, r.nets)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0]),
  };
};
/** The drawing's extent (parts and pins), in grid units. */
const extent = (def: ComponentDef) => {
  const nl = netlistOf(def)!;
  const rs = symbolRects(nl).map((b) => b.r), pins = Object.values(nl.pins ?? {});
  const xs = [...rs.flatMap((r) => [r.x, r.x + r.w]), ...pins.map((p) => p[0])], ys = [...rs.flatMap((r) => [r.y, r.y + r.h]), ...pins.map((p) => p[1])];
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

describe('rv16_mux16 laid out for legibility at fit', () => {
  it('is drawn as four columns of four bits: wider than tall, readable at fit', () => {
    const { w, h } = extent(MUX16);
    expect(w / h).toBeGreaterThanOrEqual(2);
    // a 900 × 560 px canvas (a 1280-wide window less the panes): px per grid unit at fit, 4.06 when sixteen rows deep
    expect(Math.min(900 / w, 560 / h)).toBeGreaterThanOrEqual(5.3);
  });
  it('keeps every wire clear: no crossing, none through a part, no overlap, only s and ¬s as pointers', () => {
    const m = measure(MUX16);
    expect(m.crossings).toBe(0);
    expect(m.through).toEqual([]);
    expect(m.pointers).toBeLessThanOrEqual(2);
    expect(labelOverlaps(MUX16, netlistOf(MUX16)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(MUX16)!)).toEqual([]);
  });
});

describe('srt4div redrawn by hand', () => {
  it.each([4, 8, 16, 32].flatMap((n) => [[n, false], [n, true]] as [number, boolean][]))('srt4div%i (abort %s): fewer pointers and crossings, nothing through a part, no overlap', (n, abort) => {
    const def = srt4Divider(n, abort), m = measure(def);
    expect(m.pointers).toBeLessThanOrEqual(7);
    expect(m.crossings).toBeLessThanOrEqual(17);
    expect(m.through).toEqual([]);
    expect(labelOverlaps(def, netlistOf(def)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(def)!)).toEqual([]);
  }, 60_000);
});
