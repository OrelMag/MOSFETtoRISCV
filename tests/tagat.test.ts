import { describe, expect, it } from 'vitest';
import type { ComponentDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, tagGeom, wireOverlaps } from '../src/view/route';

// A plain NOT symbol (not registered): input at (0, 1) exiting left, output at (3, 1) exiting right.
const INV: ComponentDef = {
  id: 'tagat_inv', name: 'NOT', category: 'gate', symbol: { kind: 'not' },
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
};

// Pin a drives g.a through tags; g.a's tag is placed by hand above and left of the gate.
const def: ComponentDef = {
  id: 'tagat_t', name: 'tagAt', category: 'gate',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'box' },
  netlist: () => ({
    instances: [{ name: 'g', def: INV, at: [10, 4] }],
    pins: { a: [0, 5], y: [20, 5] },
    nets: [
      { name: 'in', ends: ['a', 'g.a'], tags: true, tagAt: { 'g.a': [6, 0] } },
      { ends: ['g.y', 'y'] },
    ],
  }),
};

describe('hand-placed net tags (tagAt)', () => {
  const nl = netlistOf(def)!;
  const { nets } = routeNetlist(def, nl);
  const n = nets[0];

  it('draws the tag at the authored point, continuing the last leg of its stub', () => {
    const t = n.tags.find((x) => x.end === 'g.a')!;
    expect(t.at).toEqual([6, 0]);
    // g.a is at (10, 5) and exits left: left to x = 6, then up to the tag.
    expect(t.dir).toBe('up');
    const g = tagGeom(t, 'in');
    expect(g.tip).toEqual([6, 0]);
    expect(g.rect.y + g.rect.h).toBeCloseTo(0);
    expect(g.rect.x + g.rect.w / 2).toBeCloseTo(6);
    expect(g.stub).toEqual([]);
  });

  it('wires the stub as a path of the net, running into the sink', () => {
    expect(n.paths).toContainEqual([[6, 0], [6, 5], [10, 5]]);
    // The driver's own tag is automatic: a straight stub drawn with the tag.
    const d = n.tags.find((x) => x.end === 'a')!;
    expect(d.at).toBeUndefined();
    expect(tagGeom(d, 'in').stub).toEqual([[0, 5], [1.4, 5]]);
    expect(wireOverlaps(nets)).toEqual([]);
    expect(labelOverlaps(def, nl)).toEqual([]);
  });

  it('steps out of the pin first when the tag lies behind it', () => {
    const behind: ComponentDef = { ...def, id: 'tagat_b', netlist: () => ({ ...netlistOf(def)!, nets: [
      { name: 'in', ends: ['a', 'g.a'], tags: true, tagAt: { 'g.a': [14, 9] } }, { ends: ['g.y', 'y'] },
    ] }) };
    const r = routeNetlist(behind, netlistOf(behind)!).nets[0];
    expect(r.paths).toContainEqual([[14, 9], [9, 9], [9, 5], [10, 5]]);
    expect(r.tags.find((x) => x.end === 'g.a')!.dir).toBe('right');
  });
});
