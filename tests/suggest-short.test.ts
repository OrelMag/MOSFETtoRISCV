import { describe, expect, it } from 'vitest';
import '../src/lib';
import { suggestItems } from '../src/lib/catalog';

describe('suggestItems on a short query', () => {
  it('"rca" finds the adders, not unrelated names a typo away', () => {
    const got = suggestItems('rca').map((i) => i.name.toLowerCase());
    expect(got.length).toBeGreaterThan(0);
    expect(got.some((n) => n.includes('fcsr'))).toBe(false);
  });
});
