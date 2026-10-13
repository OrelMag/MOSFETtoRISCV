// The workbench's "did you mean" for an unknown component id.

import { describe, expect, it } from 'vitest';
import { suggestItems } from '../src/lib/catalog';

describe('suggestItems', () => {
  const ids = (q: string) => suggestItems(q).map((i) => i.id);
  it('finds a part by its id, its initials, a typo or its name without the parameters', () => {
    expect(ids('full-adder')[0]).toBe('full_adder');
    expect(ids('fa')[0]).toBe('full_adder');
    expect(ids('regfle')).toContain('regfile8x8');
    expect(ids('kogge')).toContain('ks8');
  });
  it('offers nothing for nonsense, and at most six', () => {
    expect(ids('zzz')).toEqual([]);
    expect(ids('')).toEqual([]);
    expect(suggestItems('a').length).toBeLessThanOrEqual(6);
  });
});
