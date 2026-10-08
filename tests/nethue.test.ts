// Colour per net: a net's hue depends only on its identity (name, else its ends in any order),
// stays clear of the X red and spreads over the allowed range.

import { describe, expect, it } from 'vitest';
import { netHue, netKey } from '../src/view/nethue';

describe('net hues', () => {
  it('come from the name, else the ends in any order', () => {
    expect(netKey({ name: 'pc', ends: ['a.y', 'b.a'] })).toBe('pc');
    expect(netKey({ ends: ['b.a', 'a.y'] })).toBe(netKey({ ends: ['a.y', 'b.a'] }));
    expect(netHue('pc')).toBe(netHue('pc'));
  });

  it('stay in 40°–320° and spread over it', () => {
    const hues = Array.from({ length: 400 }, (_, i) => netHue(`fa${i}.cout`));
    for (const h of hues) expect(h >= 40 && h <= 320 && Number.isInteger(h)).toBe(true);
    const buckets = new Set(hues.map((h) => Math.floor((h - 40) / 20)));
    expect(buckets.size).toBe(15); // every 20° bucket of the range is used
  });
});
