import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { flatten } from '../src/sim/flatten';
import { netlistOf, type ComponentDef, type Netlist } from '../src/sim/types';
import { applyLayout, editLayout, layoutOf, resetLayout } from '../src/view/layout';
import { netKey } from '../src/view/nethue';
import { routeNetlist } from '../src/view/route';

describe('the learner moves parts and unravels pointers (view/layout.ts)', () => {
  it('unravels every pointer into wires: same nets, same circuit', () => {
    const def = [...registry.values()].find((d) => d.netlist && netlistOf(d)!.nets.some((n) => n.tags) && netlistOf(d)!.nets.length < 60);
    expect(def).toBeDefined();
    const nl = netlistOf(def!)!;
    const out = applyLayout(nl, { at: {}, wired: nl.nets.map(netKey) });
    expect(out.nets.map((n) => n.ends)).toEqual(nl.nets.map((n) => n.ends));
    expect(out.nets.some((n) => n.tags || n.tagAt)).toBe(false);
    expect(routeNetlist(def!, out).nets.every((n) => n.tags.length === 0)).toBe(true);
    const a = flatten(def!), b = flatten({ ...def!, netlist: () => out });
    expect(b.leaves.length).toBe(a.leaves.length);
    expect(b.netCount).toBe(a.netCount);
  });

  it('moves a part and drops the routing hints that no longer fit', () => {
    const nl: Netlist = {
      instances: [{ name: 'a', def: {} as ComponentDef, at: [2, 2] }, { name: 'b', def: {} as ComponentDef, at: [10, 2] }],
      nets: [
        { ends: ['a.y', 'b.a'], trunk: 6, via: { 'b.a': [[6, 3]] } },
        { ends: ['x', 'a.a', 'b.b'], via: { 'a.a': [[1, 3]], 'b.b': [[1, 5]] }, tags: ['b.b'], tagAt: { 'b.b': [8, 6] } },
        { ends: ['b.y', 'y'], trunk: 14 },
      ],
    };
    const out = applyLayout(nl, { at: { b: [10, 8] }, wired: [] });
    expect(out.instances[0]).toBe(nl.instances[0]);
    expect(out.instances[1].at).toEqual([10, 8]);
    expect(out.nets[0].trunk).toBeUndefined();
    expect(out.nets[0].via).toBeUndefined();
    // the driver stayed: the unmoved sink keeps its corners; the moved part's tag goes with it
    expect(out.nets[1].via).toEqual({ 'a.a': [[1, 3]] });
    expect(out.nets[1].tagAt).toEqual({ 'b.b': [8, 12] });
    expect(out.nets[2].trunk).toBeUndefined();
    // put back where it was: no edit at all
    expect(applyLayout(nl, { at: { b: [10, 2] }, wired: [] })).toBe(nl);
  });

  it('keeps edits per component and drops an emptied one', () => {
    editLayout('t_layout', (l) => (l.at.u1 = [3, 4]));
    editLayout('t_layout', (l) => l.wired.push('k', 'k'));
    expect(layoutOf('t_layout')).toEqual({ at: { u1: [3, 4] }, wired: ['k'] });
    resetLayout('t_layout');
    expect(layoutOf('t_layout')).toBeUndefined();
  });
});
