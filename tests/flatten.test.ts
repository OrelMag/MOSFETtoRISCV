import { describe, expect, it } from 'vitest';
import { rca } from '../src/lib/combinational';
import { findNode, flatten, type HierNode } from '../src/sim/flatten';
import { inPorts, netlistOf } from '../src/sim/types';

// Chapter 34's cube scene flattens to 413 594 leaves and 600 114 nodes. Picking the cube built it while
// the triangle's design was still alive, and the tab died: a design keeps one array per net and no
// stored paths, which halved its memory.
describe('flatten', () => {
  const d = flatten(rca(4));
  const root = d.root;

  it('shares one array per net: the net, the ports on it and the leaves reading it', () => {
    const ni = netlistOf(rca(4))!.nets.findIndex((n) => n.ends.join() === 'fa0.cout,fa1.cin');
    expect(ni).toBeGreaterThanOrEqual(0);
    const carry = root.nets![ni];
    expect(root.children!.get('fa0')!.ports.cout).toBe(carry);
    expect(root.children!.get('fa1')!.ports.cin).toBe(carry);
    expect(d.leaves.length).toBeGreaterThan(0);
    for (const l of d.leaves) inPorts(l.def).forEach((p, i) => expect(l.inputs[i]).toBe(l.node.ports[p.name]));
  });

  it('numbers the nets densely', () => {
    const seen = new Set<number>();
    const walk = (n: HierNode) => {
      for (const k in n.ports) for (const b of n.ports[k]) seen.add(b);
      n.nets?.forEach((a) => a.forEach((b) => seen.add(b)));
      n.children?.forEach(walk);
    };
    walk(root);
    expect(seen.size).toBe(d.netCount);
    expect(Math.max(...seen)).toBe(d.netCount - 1);
    for (const l of d.leaves) for (const a of [...l.inputs, ...l.outputs]) for (const b of a) expect(b).toBeLessThan(d.netCount);
  });

  it('computes every path from the parents', () => {
    expect(root.path).toEqual([]);
    expect(root.children!.get('fa2')!.path).toEqual(['fa2']);
    for (const l of d.leaves) {
      expect(l.node.path.length).toBeGreaterThan(1);
      expect(findNode(root, l.node.path)).toBe(l.node);
    }
  });
});
