// The sandbox Examples gallery: every example has a section and text, the search filter, and a thumbnail drawn from each circuit.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { EXAMPLE_GROUPS, exampleMatches, filterExamples } from '../src/editor/examplefilter';
import { EXAMPLES } from '../src/editor/examples';
import { exampleThumb } from '../src/editor/examplethumb';

describe('gallery data', () => {
  it('every example has a known group, a name, a card line and a blurb; ids are unique', () => {
    const groups = EXAMPLE_GROUPS.map((g) => g.id);
    for (const ex of EXAMPLES) {
      expect(groups, ex.id).toContain(ex.group);
      expect(ex.name.trim(), ex.id).not.toBe('');
      expect(ex.short.trim(), ex.id).not.toBe('');
      expect(ex.blurb.trim(), ex.id).not.toBe('');
      expect(ex.short.length, `${ex.id} card line`).toBeLessThanOrEqual(70);
    }
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    for (const g of groups) expect(EXAMPLES.some((e) => e.group === g), g).toBe(true);
  });
});

describe('search filter', () => {
  it('an empty query keeps every example in section order', () => {
    const all = filterExamples(EXAMPLES, '  ');
    expect(all.map((g) => g.id)).toEqual(EXAMPLE_GROUPS.map((g) => g.id));
    expect(all.flatMap((g) => g.items).length).toBe(EXAMPLES.length);
  });

  it('matches name, card line and blurb, every word, any case, and drops empty sections', () => {
    const r = filterExamples(EXAMPLES, 'PONG');
    expect(r.flatMap((g) => g.items.map((e) => e.id))).toEqual(['rv16pong']);
    expect(r.map((g) => g.id)).toEqual(['computers']);
    expect(exampleMatches(EXAMPLES.find((e) => e.id === 'sharedbus')!, 'tri-state pull-down')).toBe(true);
    expect(exampleMatches(EXAMPLES.find((e) => e.id === 'sharedbus')!, 'tri-state flash')).toBe(false);
    expect(filterExamples(EXAMPLES, 'verilog').map((g) => g.id)).toEqual(['techniques']);
  });

  it('nothing matches: no sections', () => {
    expect(filterExamples(EXAMPLES, 'zzzz no such circuit')).toEqual([]);
  });
});

describe('thumbnails', () => {
  it('each example draws its own top level, and the set stays small', () => {
    let bytes = 0;
    for (const ex of EXAMPLES) {
      const svg = exampleThumb(ex);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="'), ex.id).toBe(true);
      expect(svg, ex.id).toContain('<rect'); // at least the board and a part
      expect(svg, ex.id).not.toMatch(/NaN|undefined|Infinity/);
      const [, w, h] = /viewBox="\S+ \S+ (\S+) (\S+)"/.exec(svg)!.map(Number);
      expect(w / h, ex.id).toBeCloseTo(16 / 10, 1);
      bytes += svg.length;
    }
    expect(bytes).toBeLessThan(300 * 1024);
  });
});
