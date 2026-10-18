// keepPorts: a component cut down to some of its ports, without the parts that served only the others (a level's
// reference drawn from a library part with more outputs than the level checks).

import { describe, expect, it } from 'vitest';
import { koggeStone } from '../src/lib/fastadd';
import { keepPorts } from '../src/sim/dead';
import { evalOnce, simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';

describe('keepPorts', () => {
  const ks = koggeStone(16), cut = keepPorts(ks, ['a', 'b', 'cin', 's', 'cout']);

  it('drops the other ports and the parts only they read, and nothing else', () => {
    expect(cut.ports.map((p) => p.name)).toEqual(['a', 'b', 'cin', 's', 'cout']);
    const before = netlistOf(ks)!.instances.map((i) => i.name), after = netlistOf(cut)!.instances.map((i) => i.name);
    expect(before.filter((n) => !after.includes(n))).toEqual(['vx']);
    expect(stats(cut).nands).toBeLessThan(stats(ks).nands);
    expect(logicDepth(cut)).toBe(14);
    expect(keepPorts(ks, ['cout', 's', 'cin', 'b', 'a'])).toBe(cut);
  });

  it('computes the kept outputs as before', () => {
    const full = simulate(ks), part = simulate(cut);
    for (const [a, b, c] of [[0, 0, 0], [0xffff, 1, 0], [0x1234, 0xedcb, 1], [0x8000, 0x8000, 1], [40000, 30000, 0]]) {
      const [s, cout] = evalOnce(full, [a, b, c]);
      expect(evalOnce(part, [a, b, c])).toEqual([s, cout]);
    }
  });
});
