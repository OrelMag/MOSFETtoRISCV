// A big ROM's cost counted from its words (romLevelsStats, the WAD ROM's statsOf) equals stats()
// walking the structure it builds.

import { describe, expect, it } from 'vitest';
import { romLevels, romLevelsStats, wordsHash } from '../src/lib/bigmem';
import { romLeaf, romLeafStats, wadRom } from '../src/lib/doompc';
import { stats } from '../src/sim/stats';

function words(n: number, seed: number): Uint32Array {
  const out = new Uint32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    // some all-zero and all-one words, as a WAD has, among random ones
    out[i] = i % 7 === 0 ? 0 : i % 11 === 0 ? 0xffffffff : s;
  }
  return out;
}

describe('ROM cost from its words', () => {
  it('a leaf ROM: the formula equals the walk', () => {
    const c = words(256, 3);
    expect(romLeafStats(8, 32, c)).toEqual(stats(romLeaf(8, 32, c)));
  });

  for (const k of [10, 12]) {
    it(`a 2^${k}-word ROM tree: the formula equals the walk`, () => {
      const c = words(2 ** k, k);
      const def = romLevels(k, 32, true, c, `romstat_${wordsHash(c)}`, romLeaf);
      expect(romLevelsStats(k, 32, c, romLeafStats)).toEqual(stats(def));
    });
  }

  it('the WAD ROM is counted without building its 32 768 leaf ROMs', () => {
    const wad = new Uint32Array(1 << 23);
    wad.set(words(1 << 16, 9));
    const t = performance.now();
    const s = stats(wadRom(wad, 4 << 16));
    expect(performance.now() - t).toBeLessThan(5000);
    expect(s.transistors).toBeGreaterThan(0);
  });
});
