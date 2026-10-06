// Pointers (net labels): same name = same net, with no wire between them. The compiled NetDef
// draws the far islands as tags placed where the user put the pointers.

import { describe, expect, it } from 'vitest';
import { checkSimulatable } from '../src/editor/compile';
import { evalOnce, simulate } from '../src/sim/harness';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, wireOverlaps } from '../src/view/route';
import { chip, compileLib, lbl, part, pin, wire } from './editorkit';

describe('pointers join nets', () => {
  // Island 1: pin a → pointer 'sig'. Island 2: pointer 'sig' → NOT → pin y.
  const doc = chip('u_ptr', 'Pointer', {
    pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [24, 8])],
    parts: [part('g', { lib: 'not' }, [14, 7])],
    labels: [lbl('l1', 'sig', [6, 2]), lbl('l2', 'sig', [10, 8], 'left')],
    wires: [wire('w1', 'pin:a', 'lbl:l1'), wire('w2', 'lbl:l2', 'g.a'), wire('w3', 'g.y', 'pin:y')],
  });
  const c = compileLib(doc);
  const nl = netlistOf(c.def)!;

  it('compiles to one net named after the pointer, drawn as placed tags', () => {
    expect(c.diags).toEqual([]);
    const n = nl.nets[0];
    expect(n.name).toBe('sig');
    expect(n.ends).toEqual(['a', 'g.a']);
    expect(n.tags).toEqual(['a', 'g.a']);
    expect(n.tagAt).toEqual({ a: [6, 2], 'g.a': [10, 8] });
    expect(n.via).toBeUndefined();
    expect(c.netOfLabel.get('l1')).toBe(0);
    expect(c.netOfLabel.get('l2')).toBe(0);
    expect(c.netOfWire.get('w2')).toBe(0);
  });

  it('simulates through the pointer', () => {
    const sim = simulate(c.def);
    expect(evalOnce(sim, [0])).toEqual([1]);
    expect(evalOnce(sim, [1])).toEqual([0]);
    expect(checkSimulatable(c)).toEqual([]);
  });

  it('the inside view puts the tags at the pointers, without overlaps', () => {
    const { nets } = routeNetlist(c.def, nl);
    const tags = nets[0].tags;
    expect(tags.map((t) => [t.end, t.at])).toEqual([['a', [6, 2]], ['g.a', [10, 8]]]);
    // Each tag's stub is a path of the net: the wires the user drew to the pointers.
    expect(nets[0].paths).toEqual([[[0, 2], [6, 2]], [[10, 8], [14, 8]]]);
    expect(wireOverlaps(nets)).toEqual([]);
    expect(labelOverlaps(c.def, nl)).toEqual([]);
  });

  it('a driver island with its own sinks keeps them wired', () => {
    const d2 = {
      ...doc,
      pins: [...doc.pins, pin('z', 'out', [24, 2])],
      wires: [...doc.wires, wire('w4', { wire: 'w1', at: [4, 2] }, 'pin:z', [[4, 0], [24, 0]])],
    };
    const c2 = compileLib(d2);
    expect(c2.diags).toEqual([]);
    const n = netlistOf(c2.def)!.nets[0];
    expect(n.ends).toEqual(['a', 'g.a', 'z']); // drawing order
    expect(n.via).toEqual({ z: [[4, 2], [4, 0], [24, 0]] });
    expect(n.tags).toEqual(['a', 'g.a']);
    const r = routeNetlist(c2.def, netlistOf(c2.def)!).nets[0];
    expect(r.paths[0]).toEqual([[0, 2], [4, 2], [4, 0], [24, 0], [24, 2]]);
    expect(evalOnce(simulate(c2.def), [1])).toEqual([1, 0]);
  });

  it('an 8-bit bus through a pointer, with a display on the far side', () => {
    const bus = chip('u_bus', 'Bus', {
      pins: [pin('a', 'in', [0, 2], 8), pin('y', 'out', [30, 10], 8)],
      parts: [part('d', { display: 'hex', width: 8 }, [20, 14])],
      labels: [lbl('l1', 'data', [8, 2]), lbl('l2', 'data', [12, 10], 'left')],
      wires: [
        wire('w1', 'pin:a', 'lbl:l1'), wire('w2', 'lbl:l2', 'pin:y'),
        wire('w3', { wire: 'w2', at: [16, 10] }, 'd.a', [[16, 15]]),
      ],
    });
    const cb = compileLib(bus);
    expect(cb.diags).toEqual([]);
    const n = netlistOf(cb.def)!.nets[0];
    expect(n.name).toBe('data');
    expect(n.tags).toEqual(['a', 'y', 'd.a']);
    expect(n.tagAt).toEqual({ a: [8, 2], y: [12, 10], 'd.a': [12, 10] });
    const sim = simulate(cb.def);
    for (const v of [0, 1, 0x5a, 0xff]) expect(evalOnce(sim, [v])).toEqual([v]);
  });

  it('same-name pointers on different widths: one error naming both', () => {
    const bad = chip('u_bad', 'Bad', {
      pins: [pin('a', 'in', [0, 2], 8), pin('y', 'out', [30, 10])],
      labels: [lbl('l1', 'w', [8, 2]), lbl('l2', 'w', [12, 10])],
      wires: [wire('w1', 'pin:a', 'lbl:l1'), wire('w2', 'lbl:l2', 'pin:y')],
    });
    const cb = compileLib(bad);
    expect(cb.diags).toHaveLength(1);
    expect(cb.diags[0].level).toBe('error');
    expect(cb.diags[0].msg).toMatch(/width mismatch/);
    expect(cb.diags[0].labels).toEqual(['l1', 'l2']);
    expect(cb.diags[0].pins).toEqual(['a', 'y']);
    expect(cb.netOfLabel.get('l1')).toBe(-1);
    expect(netlistOf(cb.def)!.nets).toEqual([]);
  });

  it('different names stay different nets; a lone pointer is harmless', () => {
    const two = { ...doc, labels: [lbl('l1', 'sig', [6, 2]), lbl('l2', 'other', [10, 8]), lbl('l3', 'lonely', [0, 20])] };
    const ct = compileLib(two);
    expect(ct.diags.map((d) => d.msg)).toEqual(['nothing drives g.a']);
    expect(netlistOf(ct.def)!.nets.map((n) => n.ends)).toEqual([['a'], ['g.y', 'y']]);
    expect(ct.netOfLabel.has('l3')).toBe(false);
  });
});
