// The Communication chapters' generated state machines (lib/rtl.ts) are drawn as boxes of boxes: a large block becomes its
// next-state logic, its state register and its outputs, with the gates one level down. That is a drawing change only, held
// here two ways: every design does what it did before, output by output and cycle by cycle on seeded random inputs, at the
// same NAND count (tests/fixtures/rtl-traces.json, recorded before the change); and every such block reads left to right,
// each register's d a wire from next state into the state block, no wire under a part.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RTL_SPLITS } from '../src/lib/rtl';
import { netlistOf } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';
import { rtlDesigns } from './rtlcollect';
import { traceOf, type Trace } from './rtltrace';
import { tick } from './yieldtick';

const FIXTURE: Record<string, Trace> = JSON.parse(readFileSync(new URL('./fixtures/rtl-traces.json', import.meta.url), 'utf8'));
const designs = rtlDesigns();

describe('generated state machines', () => {
  it('are all here: every design the fixture knows is built, and no new one is missing from it', () => {
    expect(designs.map((d) => d.id).sort()).toEqual(Object.keys(FIXTURE).sort());
  });

  it('do what they did before the drawing changed, every output every cycle, at the same cost', async () => {
    const changed: string[] = [];
    for (const d of designs) {
      const t = traceOf(d);
      if (JSON.stringify(t) !== JSON.stringify(FIXTURE[d.id])) changed.push(`${d.id}: ${JSON.stringify(t)} against ${JSON.stringify(FIXTURE[d.id])}`);
      await tick();
    }
    expect(changed).toEqual([]);
  }, 120_000);

  it('draw every large block as next state, state and outputs', () => {
    expect(RTL_SPLITS.length).toBeGreaterThan(30);
    for (const def of RTL_SPLITS) {
      const names = netlistOf(def)!.instances.map((i) => i.name);
      expect(names.some((n) => n.startsWith('next')), def.id).toBe(true);
      expect(names.some((n) => n.startsWith('state')), def.id).toBe(true);
    }
  });

  it.each(RTL_SPLITS.map((d) => [d.id, d] as const))('%s: each register\'s d is a wire into the state block, and no wire runs through a part', (_, def) => {
    const nl = drawnNetlist(def, netlistOf(def)!);
    const toState = nl.nets.filter((n) => /^next\d*\./.test(n.ends[0]) && n.ends.some((e) => /^state\d*\./.test(e)));
    expect(toState.length).toBeGreaterThan(0);
    for (const n of toState) expect(n.tags === true || (Array.isArray(n.tags) && n.tags.some((t) => /^state\d*\./.test(t))), `${def.id}: ${n.name}`).toBe(false);
    const hit = wiresThroughParts(nl, routeNetlist(def, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  });
});
