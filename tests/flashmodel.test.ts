import { describe, expect, it } from 'vitest';
import { FlashDevice, Ftl, randomWrites } from '../src/flash/model';

const G = { blocks: 8, pagesPerBlock: 8, wordsPerPage: 4 };
const page = (lpn: number, v: number) => [lpn, v, ~v >>> 0, lpn ^ v];

describe('flash device', () => {
  it('programs only 1 → 0, once per erase, and erases whole blocks', () => {
    const d = new FlashDevice(G);
    expect(d.read(3)).toEqual([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
    expect(d.program(3, [0xf0f0f0f0, 0, 1, 2]).ok).toBe(true);
    expect(d.program(3, [0, 0, 0, 0]).ok).toBe(false);
    expect(d.read(3)).toEqual([0xf0f0f0f0, 0, 1, 2]);
    d.erase(0);
    expect(d.read(3)[0]).toBe(0xffffffff);
    expect(d.program(3, [1, 1, 1, 1]).ok).toBe(true);
  });
  it('wears out a block after its endurance', () => {
    const d = new FlashDevice(G, 3, [5]);
    for (let i = 0; i < 3; i++) expect(d.erase(1).ok).toBe(true);
    expect(d.erase(1).ok).toBe(false);
    expect(d.bad[1]).toBe(1);
    expect(d.program(5 * 8, [0, 0, 0, 0]).ok).toBe(false);
  });
});

describe('flash translation layer', () => {
  it.each([[false], [true]])('keeps every logical page through garbage collection (wear levelling %s)', (wl) => {
    const d = new FlashDevice(G, Infinity, [6]);
    const f = new Ftl(d, { logical: 36, wearLevel: wl });
    const shadow = new Map<number, number[]>();
    randomWrites(3000, 36, 9, 8, 0.8).forEach((lpn, i) => {
      const w = page(lpn, i);
      f.write(lpn, w);
      shadow.set(lpn, w);
    });
    for (const [lpn, w] of shadow) expect(f.read(lpn)).toEqual(w);
    expect(f.writeAmplification).toBeGreaterThan(1);
    expect(d.erases[6]).toBe(0); // the bad block is never used
  });
  it('wear levelling evens the erase counts', () => {
    const spread = (wl: boolean) => {
      const d = new FlashDevice(G);
      const f = new Ftl(d, { logical: 40, wearLevel: wl });
      randomWrites(4000, 40, 3, 4, 0.9).forEach((lpn, i) => f.write(lpn, page(lpn, i)));
      const e = Array.from(d.erases);
      return Math.max(...e) - Math.min(...e);
    };
    expect(spread(true)).toBeLessThan(spread(false));
  });
  it('more spare space, less write amplification', () => {
    const wa = (logical: number) => {
      const f = new Ftl(new FlashDevice(G), { logical, wearLevel: true });
      randomWrites(3000, logical, 5).forEach((lpn, i) => f.write(lpn, page(lpn, i)));
      return f.writeAmplification;
    };
    expect(wa(24)).toBeLessThan(wa(44));
  });
});
