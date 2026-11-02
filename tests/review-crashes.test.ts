import { describe, expect, it } from 'vitest';
import { bench } from '../src/chapters/types';
import { registry } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { needsSwitchLevel } from '../src/sim/harness';
import { netlistOf } from '../src/sim/types';

describe('workbench opens every part', () => {
  it('flattens the root the workbench would load, at the level the stage picks', () => {
    for (const id of ['nmos', 'pmos', 'nmos_strong', 'pmos_weak']) {
      const def = registry.get(id)!;
      const root = bench(def);
      expect(needsSwitchLevel(root), id).toBe(true);
      expect(() => flatten(root, { mode: 'switch' }), id).not.toThrow();
    }
  });
  it('every registered primitive with ports benches', () => {
    for (const def of registry.values()) {
      if (!def.prim || netlistOf(def)) continue;
      const root = bench(def);
      expect(() => flatten(root, { mode: needsSwitchLevel(root) ? 'switch' : 'gate' }), def.id).not.toThrow();
    }
  });
});
