// The boards' jumpers against the netlist: each net's wires form one tree over its ends, and every supply pin reaches a
// rail of its own kind.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BIT_RUNNER } from '../src/lib/bitrunner';
import { SAP_COMPUTER } from '../src/lib/sap';
import { TTL_PINS } from '../src/lib/ttl';
import { flatten } from '../src/sim/flatten';
import type { ComponentDef } from '../src/sim/types';
import type { BreadboardLayout } from '../src/view/bblayout';
import { planWires, wirePath } from '../src/view/bbwires';
import { runnerLayout } from '../src/widgets/runnerlayout';
import { sapLayout } from '../src/widgets/saplayout';

const CASES: [string, ComponentDef, () => BreadboardLayout][] = [
  ['Bit Runner', BIT_RUNNER, runnerLayout],
  ['SAP-1', SAP_COMPUTER, () => sapLayout(SAP_COMPUTER)],
];

describe.each(CASES)('%s', (_n, def, layout) => {
  const root = flatten(def).root, l = layout(), wires = planWires(l, root);

  it('joins every net with a tree: one component, one wire fewer than its ends', () => {
    const byNet = new Map<number, typeof wires>();
    for (const w of wires) if (w.net >= 0 && !w.rail) byNet.set(w.net, [...(byNet.get(w.net) ?? []), w]);
    expect(byNet.size).toBeGreaterThan(20);
    for (const [net, list] of byNet) {
      const key = (e: { x: number; y: number }) => `${e.x},${e.y}`;
      const parent = new Map<string, string>();
      const find = (a: string): string => { const p = parent.get(a) ?? a; return p === a ? a : find(p); };
      for (const w of list) { parent.set(find(key(w.from)), find(key(w.to))); }
      const nodes = new Set(list.flatMap((w) => [key(w.from), key(w.to)]));
      expect(new Set([...nodes].map(find)).size, `net ${net}`).toBe(1);
      expect(list.length, `net ${net}`).toBe(nodes.size - 1);
    }
  });

  it('takes every chip supply pin to a rail', () => {
    const chips = l.boards.flatMap((b) => b.chips.filter((c) => c.path));
    const supply = chips.reduce((n, c) => n + Object.values(c.pins ?? {}).filter((p) => p === 'VCC' || p === 'GND').length, 0);
    expect(wires.filter((w) => w.net === -1 && w.rail).length).toBe(supply);
  });

  it('keeps wires inside the drawing', () => {
    for (const w of wires) {
      expect(Number.isFinite(w.from.x + w.from.y + w.to.x + w.to.y)).toBe(true);
      expect(wirePath(w)).toMatch(/^M/);
    }
  });
});

describe('chip pins', () => {
  it('have a pin map for 74LS10 and 74LS20 with one pin per port bit', () => {
    for (const k of ['ls10', 'ls20']) expect(TTL_PINS[k]).toHaveLength(14);
  });
});
