import { describe, expect, it } from 'vitest';
import { NOR_ADD4, NOR_BASIC, NOR_ENMUX, NOR_FA, NOR_LATCH, NOR_REG, NOR_REG4, NOR_XNOR } from '../src/lib/agcnor';
import { CORE_PLANE, CORE_STORE } from '../src/lib/coremem';
import { PDP8_AC, PDP8_CONTROL, PDP8_CORE, PDP8_MAB, PDP8_OPR1, PDP8_OPR23, PDP8_PC, PDP8_TTY } from '../src/lib/pdp8';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wireCrossings, wiresThroughParts } from '../src/view/wirefirst';

// Appendix F's NOR3 circuits, the core store and the PDP-8 in gates (ship audit 2): no wire runs through a part's body (see
// tests/redrawclear.test.ts), and the levels redrawn for it keep their crossings (wireCrossings: each path's) and pointers at most
// what the redraw measured.
const levels: [string, ComponentDef, { crossings?: number; pointers?: number }][] = [
  ['NOT, OR, AND in NOR3', NOR_BASIC, {}],
  ['XNOR in NOR3', NOR_XNOR, { crossings: 3 }],
  ['full adder in NOR3', NOR_FA, {}],
  ['latch in NOR3', NOR_LATCH, { crossings: 4 }],
  ['enable mux in NOR3', NOR_ENMUX, { crossings: 0 }],
  ['register bit in NOR3', NOR_REG, { crossings: 4 }],
  ['one\'s-complement adder in NOR3', NOR_ADD4, {}],
  ['4-bit register in NOR3', NOR_REG4, {}],
  ['core plane', CORE_PLANE, {}],
  ['core store', CORE_STORE, {}],
  ['PDP-8 processor', PDP8_CORE, { crossings: 36 }],
  ['PDP-8 control', PDP8_CONTROL, { crossings: 54, pointers: 79 }],
  ['PDP-8 teletype', PDP8_TTY, { crossings: 15, pointers: 25 }],
  ['PDP-8 operate group 1', PDP8_OPR1, {}],
  ['PDP-8 operate groups 2 and 3', PDP8_OPR23, { crossings: 9, pointers: 14 }],
  ['PDP-8 AC & link', PDP8_AC, {}],
  ['PDP-8 PC', PDP8_PC, {}],
  ['PDP-8 MA & MB', PDP8_MAB, {}],
];

describe('Appendix F, core memory and PDP-8 levels', () => {
  it.each(levels)('%s: no wire runs through a part', (_, def, max) => {
    const nl = drawnNetlist(def, netlistOf(def)!);
    const routed = routeNetlist(def, nl).nets;
    expect([...wiresThroughParts(nl, routed)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
    if (max.crossings !== undefined) expect(wireCrossings(routed)).toBeLessThanOrEqual(max.crossings);
    if (max.pointers !== undefined) expect(nl.nets.filter((n) => n.tags).length).toBeLessThanOrEqual(max.pointers);
  });
});
