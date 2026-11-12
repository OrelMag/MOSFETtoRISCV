import { describe, expect, it } from 'vitest';
import { coherentCache, cohBus } from '../src/lib/coherent';

// Release review m2: the face lookup stripped /d+n?$/ (a lost backslash), so no block ever got its faces and the
// wires between core, cache, bus and memory looped back.
describe('coherent blocks show the faces they were drawn with', () => {
  const side = (d: ReturnType<typeof cohBus>, n: string) => d.ports.find((p) => p.name === n)?.side;
  for (const [what, d] of [['cache', coherentCache(5, true)], ['private cache', coherentCache(5, false)], ['cache, 6', coherentCache(6, true)]] as const) {
    it(what, () => {
      expect(side(d, 'memRData')).toBe('left');
      expect(side(d, 'need')).toBe('right');
    });
  }
  it('bus', () => {
    const b = cohBus(5);
    expect(side(b, 'need0')).toBe('left');
    expect(side(b, 'memAddr')).toBe('right');
  });
});
