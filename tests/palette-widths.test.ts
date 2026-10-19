// Sized palette parts: the width they place at, remembered per item, inside the limits the properties panel uses.

import { describe, expect, it } from 'vitest';
import { itemWidth, paletteGroups, setItemWidth, sizedItem, WIDTH_LIMITS } from '../src/editor/palette';
import { MAX_WIDTH } from '../src/editor/parts';
import { MAX_SWITCHES } from '../src/editor/ioparts';
import { PUZZLE_MAX_WIDTH } from '../src/editor/puzzleparts';
import '../src/editor/memui';

describe('palette widths', () => {
  it('the limits are the properties panel\'s', () => {
    expect(WIDTH_LIMITS.pin).toBe(MAX_WIDTH);
    expect(WIDTH_LIMITS.switches).toBe(MAX_SWITCHES);
    expect(WIDTH_LIMITS.puzzle).toBe(PUZZLE_MAX_WIDTH);
    expect(WIDTH_LIMITS.constant).toBe(53);
  });

  it('a sized item places at its width, remembered, clamped to its range', () => {
    const ctx = { ws: { chips: {}, open: [] } as never, chipId: 'x', canPlace: () => true };
    const items = paletteGroups().flatMap((g) => g.items(ctx).map((it) => [g.id, it] as const));
    const [gid, bus] = items.find(([, it]) => it.id === 'in8')!;
    const key = `${gid}/${bus.id}`;
    expect(itemWidth(key, bus)).toBe(8);
    setItemWidth(key, 32);
    expect(itemWidth(key, bus)).toBe(32);
    expect(sizedItem(bus, 32)).toMatchObject({ tag: '32-bit', place: { pin: { dir: 'in', width: 32 } } });
    setItemWidth(key, 5000);
    expect(itemWidth(key, bus)).toBe(8);
    const sized = items.filter(([, it]) => it.sized).map(([, it]) => it.id).sort();
    expect(sized).toEqual(['in8', 'k8', 'leds', 'out8', 'pzin', 'pzout', 'switches', 'value']);
    for (const [, it] of items) if (it.sized) expect(sizedItem(it, it.sized.def).place).toEqual(it.place);
  });
});
