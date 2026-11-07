import { describe, expect, it } from 'vitest';
import { offerReadable, READABLE_BELOW, READABLE_PX, readableBox } from '../src/view/camera';

describe('zoom to readable', () => {
  it('is offered only under the threshold, and not before a layout', () => {
    expect(offerReadable(0)).toBe(false);
    expect(offerReadable(1.84)).toBe(true);
    expect(offerReadable(READABLE_BELOW - 0.01)).toBe(true);
    expect(offerReadable(READABLE_BELOW)).toBe(false);
    expect(offerReadable(READABLE_PX)).toBe(false); // so the button goes once it is used
  });
  it('shows ~3 px per unit from the drawing\'s left edge, centred vertically', () => {
    const bbox = { x: 10, y: 20, w: 400, h: 100 };
    const vb = readableBox(bbox, 900, 600);
    expect(900 / vb.w).toBeCloseTo(READABLE_PX);
    expect(600 / vb.h).toBeCloseTo(READABLE_PX);
    expect(vb.x).toBeCloseTo(8);
    expect(vb.y + vb.h / 2).toBeCloseTo(70);
  });
});
