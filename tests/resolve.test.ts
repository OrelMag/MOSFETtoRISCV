import { afterEach, describe, expect, it } from 'vitest';
import '../src/lib';
import { libraryItems } from '../src/lib/catalog';
import { defIndex, reachableDefs, resolveComponent, setUserResolver } from '../src/lib/resolve';
import { rca } from '../src/lib/combinational';
import type { ComponentDef } from '../src/sim/types';

describe('resolve', () => {
  afterEach(() => setUserResolver(null));

  it('asks the user resolver first, only for u_ ids', () => {
    const chip: ComponentDef = { id: 'u_mine', name: 'Mine', category: 'custom', ports: [], symbol: { kind: 'box', color: 200 } };
    const asked: string[] = [];
    setUserResolver((id) => { asked.push(id); return id === 'u_mine' ? chip : undefined; });
    expect(resolveComponent('u_mine')).toBe(chip);
    expect(resolveComponent('u_none')).toBeUndefined();
    expect(resolveComponent('rca4')?.id).toBe('rca4');
    expect(asked).toEqual(['u_mine', 'u_none']);
    setUserResolver(null);
    expect(resolveComponent('u_mine')).toBeUndefined();
  });

  it('indexes every reachable definition, and grows with the registry', () => {
    const idx = defIndex();
    expect(idx.get('nand')).toBeDefined();
    expect(idx.size).toBe(new Set(reachableDefs().map((d) => d.id)).size);
    expect(idx.has('rca13')).toBe(false);
    rca(13);
    expect(defIndex().get('rca13')).toBe(rca(13));
  });

  it('lists the library by category', () => {
    const cats = libraryItems();
    expect(cats.map((c) => c.cat)).toContain('gate');
    expect(cats.flatMap((c) => c.items).some((i) => i.id === 'rca4' && i.family)).toBe(true);
    expect(cats.every((c) => c.items.length > 0)).toBe(true);
  });
});
