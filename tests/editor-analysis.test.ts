// The sandbox's analysis tools and performance caches, DOM-free: incremental hops, the derived
// model cache, probe lanes remapped across rebuilds, static timing mapped back to the drawing,
// and the lint checks.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { allHops, HopCache, type ShapeWire } from '../src/editor/hops';
import { UserLibrary } from '../src/editor/library';
import type { ChipDoc } from '../src/editor/model';
import type { Vec } from '../src/sim/geometry';
import { chip, compileLib, part, pin, wire, workspace } from './editorkit';
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

describe('derived model cache', () => {
  const nor = (at: Vec = [8, 1], swap = false) => chip('u_nor', 'NOR', {
    pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('y', 'out', [20, 3])],
    parts: [part('g', { lib: 'nor_cmos' }, at)],
    wires: [wire('w1', 'pin:a', swap ? 'g.b' : 'g.a'), wire('w2', 'pin:b', swap ? 'g.a' : 'g.b'), wire('w3', 'g.y', 'pin:y')],
  });

  it('moving parts reuses the derived truth table; rewiring derives again', () => {
    const c1 = compileLib(nor());
    expect(c1.mode).toBe('switch');
    expect(c1.derived?.ok).toBe(true);
    const c2 = compileLib(nor([9, 3]));
    expect(c2.def).not.toBe(c1.def); // the drawing changed: a new def …
    expect(c2.connKey).toBe(c1.connKey);
    expect(c2.derived).toBe(c1.derived); // … with the same model, not derived again
    const c3 = compileLib(nor([8, 1], true));
    expect(c3.connKey).not.toBe(c1.connKey);
    expect(c3.derived).not.toBe(c1.derived);
  });

  it('a chip placing an edited chip derives again even if its own wiring is the same', () => {
    const inner = nor();
    const outer = (d: ChipDoc) => chip('u_out', 'OUT', {
      pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('y', 'out', [30, 3])],
      // A transistor part of its own keeps it at switch level (the user chip alone would be
      // used through its derived model).
      parts: [part('n', { chip: d.id }, [8, 0]), part('g', { lib: 'nor_cmos' }, [20, 0])],
      wires: [wire('w1', 'pin:a', 'n.a'), wire('w2', 'pin:b', 'n.b'), wire('w4', 'pin:b', 'g.b'), wire('w5', 'n.y', 'g.a'), wire('w3', 'g.y', 'pin:y')],
    });
    const lib = new UserLibrary(workspace(outer(inner), inner));
    const d1 = lib.compiled('u_out')!.derived;
    expect(d1?.ok).toBe(true);
    lib.update(workspace(outer(inner), nor([8, 5]))); // inner moved: same structure
    expect(lib.compiled('u_out')!.derived).toBe(d1);
    lib.update(workspace(outer(inner), nor([8, 1], true))); // inner rewired (a NOR is symmetric, but it is another circuit)
    expect(lib.compiled('u_out')!.derived).not.toBe(d1);
  });
});
