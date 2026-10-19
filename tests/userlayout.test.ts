import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { flatten } from '../src/sim/flatten';
import { netlistOf, type ComponentDef, type Netlist } from '../src/sim/types';
import { applyLayout, canRedo, canUndo, dragSegment, dropCorners, editLayout, layoutOf, nearestSegment, resetLayout, shiftSegment, showsTags, undoLayout } from '../src/view/layout';
import { netKey } from '../src/view/nethue';
import { routeNetlist } from '../src/view/route';
import type { Vec } from '../src/sim/geometry';

describe('the learner moves parts and unravels pointers (view/layout.ts)', () => {
  it('unravels every pointer into wires: same nets, same circuit', () => {
    const def = [...registry.values()].find((d) => d.netlist && netlistOf(d)!.nets.some((n) => n.tags) && netlistOf(d)!.nets.length < 60);
    expect(def).toBeDefined();
    const nl = netlistOf(def!)!;
    const out = applyLayout(nl, { at: {}, wired: nl.nets.map(netKey), tagged: [] });
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
    const out = applyLayout(nl, { at: { b: [10, 8] }, wired: [], tagged: [] });
    expect(out.instances[0]).toBe(nl.instances[0]);
    expect(out.instances[1].at).toEqual([10, 8]);
    expect(out.nets[0].trunk).toBeUndefined();
    expect(out.nets[0].via).toBeUndefined();
    // the driver stayed: the unmoved sink keeps its corners; the moved part's tag goes with it
    expect(out.nets[1].via).toEqual({ 'a.a': [[1, 3]] });
    expect(out.nets[1].tagAt).toEqual({ 'b.b': [8, 12] });
    expect(out.nets[2].trunk).toBeUndefined();
    // put back where it was: no edit at all
    expect(applyLayout(nl, { at: { b: [10, 2] }, wired: [], tagged: [] })).toBe(nl);
  });

  it('keeps edits per component and drops an emptied one', () => {
    editLayout('t_layout', (l) => (l.at.u1 = [3, 4]));
    editLayout('t_layout', (l) => l.wired.push('k', 'k'));
    expect(layoutOf('t_layout')).toEqual({ at: { u1: [3, 4] }, wired: ['k'], tagged: [] });
    resetLayout('t_layout');
    expect(layoutOf('t_layout')).toBeUndefined();
  });

  it('draws a wire as pointers: a tag at every end, named for its driver, same colour key', () => {
    const def = [...registry.values()].find((d) => d.netlist && netlistOf(d)!.nets.some((n) => !n.tags && n.ends.length > 2) && netlistOf(d)!.nets.length < 40);
    expect(def).toBeDefined();
    const nl = netlistOf(def!)!;
    const i = nl.nets.findIndex((n) => !n.tags && n.ends.length > 2);
    const lay = { at: {}, wired: [], tagged: [netKey(nl.nets[i])] };
    const out = applyLayout(nl, lay);
    expect(out.nets[i].tags).toBe(true);
    expect(out.nets[i].name).toBe(nl.nets[i].name ?? nl.nets[i].ends[0]);
    expect(out.nets[i].ends).toEqual(nl.nets[i].ends);
    expect(showsTags(nl.nets[i], lay)).toBe(true);
    expect(showsTags(nl.nets[i], undefined)).toBe(false);
    expect(routeNetlist(def!, out).nets[i].tags.length).toBeGreaterThan(0);
  });

  it('undoes and redoes layout edits, one step per edit', () => {
    const id = 't_undo';
    expect(canUndo(id)).toBe(false);
    editLayout(id, (l) => (l.at.a = [1, 1]));
    editLayout(id, (l) => (l.at.a = [5, 5]));
    editLayout(id, (l) => l.tagged.push('n'));
    expect(undoLayout(id)).toBe(true);
    expect(layoutOf(id)).toEqual({ at: { a: [5, 5] }, wired: [], tagged: [] });
    expect(undoLayout(id)).toBe(true);
    expect(layoutOf(id)?.at.a).toEqual([1, 1]);
    expect(canRedo(id)).toBe(true);
    expect(undoLayout(id, true)).toBe(true);
    expect(layoutOf(id)?.at.a).toEqual([5, 5]);
    // a new edit drops what could be redone
    editLayout(id, (l) => (l.at.b = [2, 2]));
    expect(canRedo(id)).toBe(false);
    expect(undoLayout(id)).toBe(true);
    expect(undoLayout(id)).toBe(true);
    expect(undoLayout(id)).toBe(true);
    expect(layoutOf(id)).toBeUndefined();
    expect(undoLayout(id)).toBe(false);
  });

  it('moves a wire segment sideways: neighbours stretch, a stub stays on each pin', () => {
    // middle segment: its neighbours stretch
    expect(shiftSegment([[0, 0], [4, 0], [4, 6], [8, 6]], 1, 2)).toEqual([[0, 0], [6, 0], [6, 6], [8, 6]]);
    // the first one: a unit stays on the driver, a leg joins it
    expect(shiftSegment([[0, 0], [4, 0], [4, 6]], 0, -1.5)).toEqual([[0, 0], [1, 0], [1, -1.5], [4, -1.5], [4, 6]]);
    // the last one, short: half of it stays on the sink
    expect(shiftSegment([[0, 0], [0, 3], [1, 3]], 1, 1)).toEqual([[0, 0], [0, 4], [0.5, 4], [0.5, 3], [1, 3]]);
    // along its own direction: nothing
    const p: Vec[] = [[0, 0], [4, 0]];
    expect(shiftSegment(p, 0, 0)).toBe(p);
  });

  it('drags a shared trunk as one wire, and leaves a tag stub', () => {
    const paths: Vec[][] = [
      [[0, 0], [3, 0], [3, 4], [8, 4]],
      [[0, 0], [3, 0], [3, 8], [8, 8]],
      [[5, 5], [5, 7]],
      // the trunk's other half, up from the driver's row: the same line on screen
      [[0, 0], [3, 0], [3, -5], [8, -5]],
      [[0, 0], [12, 0], [12, 3]],
    ];
    const out = dragSegment(paths, 0, 1, 1, (i) => i === 2);
    expect(out[0]).toEqual([[0, 0], [4, 0], [4, 4], [8, 4]]);
    expect(out[1]).toEqual([[0, 0], [4, 0], [4, 8], [8, 8]]);
    expect(out[2]).toBe(paths[2]);
    expect(out[3]).toEqual([[0, 0], [4, 0], [4, -5], [8, -5]]);
    expect(out[4]).toBe(paths[4]);
    expect(nearestSegment(paths, [3.3, 6])).toEqual({ pi: 1, k: 1, axis: 'v' });
    expect(nearestSegment(paths, [5.2, 6], 0.7, (i) => i === 2)).toBeNull();
  });

  it('keeps the corners the learner dragged: the router draws the wire just so', () => {
    const def = [...registry.values()].find((d) => {
      const nl = d.netlist && netlistOf(d);
      return nl && nl.nets.length < 40 && routeNetlist(d, nl).nets.some((n) => n.paths.some((p) => p.length >= 4));
    });
    expect(def).toBeDefined();
    const nl = netlistOf(def!)!;
    const net = routeNetlist(def!, nl).nets.find((n) => n.paths.some((p) => p.length >= 4))!;
    const pi = net.paths.findIndex((p) => p.length >= 4);
    const moved = dragSegment(net.paths, pi, 1, 2, (i) => !net.ends?.[i]);
    const via: Record<string, Vec[]> = {};
    moved.forEach((p, i) => { if (p !== net.paths[i]) via[net.ends![i]!] = p.slice(1, -1); });
    const out = applyLayout(nl, { at: {}, wired: [], tagged: [], via: { [netKey(nl.nets[net.index])]: via } });
    expect(out.nets.map((n) => n.ends)).toEqual(nl.nets.map((n) => n.ends));
    const again = routeNetlist(def!, out).nets[net.index];
    for (const [i, p] of moved.entries()) if (p !== net.paths[i]) expect(again.paths[i]).toEqual(p);
  });

  it('drops the corners of wires on a part that moves, and keeps them through undo', () => {
    const nl: Netlist = {
      instances: [{ name: 'a', def: {} as ComponentDef, at: [2, 2] }, { name: 'b', def: {} as ComponentDef, at: [10, 2] }],
      nets: [{ ends: ['a.y', 'b.a', 'y'] }, { ends: ['x', 'a.a'] }],
    };
    const k0 = netKey(nl.nets[0]), k1 = netKey(nl.nets[1]);
    const via: Record<string, Record<string, Vec[]>> = { [k0]: { 'b.a': [[7, 3]], y: [[7, 9]] }, [k1]: { 'a.a': [[1, 3]] } };
    const moveB = { at: {}, wired: [], tagged: [], via: structuredClone(via) };
    dropCorners(moveB, nl, ['b']);
    expect(moveB.via).toEqual({ [k0]: { y: [[7, 9]] }, [k1]: { 'a.a': [[1, 3]] } });
    // the driver moved: every wire of its net goes
    const moveA = { at: {}, wired: [], tagged: [], via: structuredClone(via) };
    dropCorners(moveA, nl, ['a']);
    expect(moveA.via).toBeUndefined();
    expect(via[k0]['b.a']).toEqual([[7, 3]]);

    const id = 't_via';
    editLayout(id, (l) => (l.via = { [k0]: { y: [[7, 9]] } }));
    expect(applyLayout(nl, layoutOf(id)).nets[0].via).toEqual({ y: [[7, 9]] });
    editLayout(id, (l) => delete l.via![k0]);
    expect(layoutOf(id)).toBeUndefined();
    undoLayout(id);
    expect(layoutOf(id)?.via).toEqual({ [k0]: { y: [[7, 9]] } });
    resetLayout(id);
    expect(layoutOf(id)).toBeUndefined();
  });
});
