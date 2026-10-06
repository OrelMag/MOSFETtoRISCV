// The sandbox's analysis tools and performance caches, DOM-free: incremental hops, the derived
// model cache, probe lanes remapped across rebuilds, static timing mapped back to the drawing,
// and the lint checks.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { allHops, HopCache, type ShapeWire } from '../src/editor/hops';
import type { Vec } from '../src/sim/geometry';
import { lcg } from './util';

describe('incremental hops', () => {
  const randomWires = (rnd: () => number, n: number): ShapeWire[] =>
    Array.from({ length: n }, (_, i) => {
      // Short wires on a large board, two per net (a fan-out), as on a real chip.
      const pts: Vec[] = [[Math.floor(rnd() * 120), Math.floor(rnd() * 90)]];
      for (let k = 0; k < 3; k++) {
        const [x, y] = pts[pts.length - 1];
        const d = Math.floor(rnd() * 25) - 12;
        pts.push(k % 2 ? [x, y + d] : [x + d, y]);
      }
      return { id: `w${i}`, group: i >> 1, poly: rnd() < 0.05 ? null : pts };
    });

  it('a partial recompute equals a full one after every move', () => {
    const r = lcg(7);
    const rnd = () => r(1 << 30) / (1 << 30);
    let wires = randomWires(rnd, 60);
    const cache = new HopCache();
    cache.update(wires);
    expect(cache.d).toEqual(allHops(wires));
    let partial = 0;
    for (let step = 0; step < 200; step++) {
      // Move one or two wires (as a drag of a part moves the wires on its ports).
      const moved = new Set([Math.floor(rnd() * wires.length), Math.floor(rnd() * wires.length)].slice(0, 1 + (step % 2)));
      const dx = Math.floor(rnd() * 5) - 2, dy = Math.floor(rnd() * 5) - 2;
      wires = wires.map((w, i) => (moved.has(i) && w.poly ? { ...w, poly: w.poly.map(([x, y]): Vec => [x + dx, y + dy]) } : w));
      if (step % 50 === 49) wires = wires.slice(1); // a wire deleted: everything regroups
      const before = new Map(cache.d);
      const changed = cache.update(wires);
      const full = allHops(wires);
      expect(cache.d).toEqual(full);
      for (const [id, d] of full) if (before.get(id) !== d) expect(changed.has(id), id).toBe(true);
      if (cache.lastRecomputed < wires.length) partial++;
    }
    expect(partial).toBeGreaterThan(150); // most moves recompute only part of the wires
  });
});
