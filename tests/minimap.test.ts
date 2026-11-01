import { describe, expect, it } from 'vitest';
import { centredOn, contentFits, mapLayout, mapRect, panCentre, toMap, toWorld } from '../src/editor/minimapmath';

describe('minimap coordinates', () => {
  const content = { x: -10, y: 0, w: 100, h: 50 };
  it('fits the content in the map, centred', () => {
    const l = mapLayout(content, 220, 160, 10)!;
    expect(l.k).toBeCloseTo(2); // 200 / 100
    const r = mapRect(l, content);
    expect(r.w).toBeCloseTo(200);
    expect(r.x).toBeCloseTo(10);
    expect(r.y + r.h / 2).toBeCloseTo(80); // vertically centred
  });
  it('round-trips map and world positions', () => {
    const l = mapLayout(content, 220, 160)!;
    const p = toMap(l, [12, 34]);
    const q = toWorld(l, p);
    expect(q[0]).toBeCloseTo(12);
    expect(q[1]).toBeCloseTo(34);
  });
  it('an empty box has no layout', () => expect(mapLayout({ x: 0, y: 0, w: 0, h: 5 }, 100, 100)).toBeNull());
  it('is hidden when the view holds the whole content', () => {
    expect(contentFits(content, { x: -20, y: -10, w: 150, h: 100 })).toBe(true);
    expect(contentFits(content, { x: -20, y: -10, w: 60, h: 100 })).toBe(false);
  });
  it('centres the view on a point and keeps the chip in reach', () => {
    const view = { x: 0, y: 0, w: 40, h: 30 };
    expect(centredOn(view, [50, 20])).toEqual({ x: 30, y: 5, w: 40, h: 30 });
    const far = panCentre(view, [1000, -1000], content);
    expect(far.x + far.w / 2).toBe(90);
    expect(far.y + far.h / 2).toBe(0);
  });
});
