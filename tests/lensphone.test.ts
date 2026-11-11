// Open blocks as you zoom on a touch screen (DESIGN.md item 6): the setting works there and starts off; a pinch opens a box
// as the wheel does (smoke: the touch routes).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { settings } from '../src/ui/settings';

const coarse = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));

describe('the setting on a touch screen', () => {
  afterEach(() => {
    settings.set('zoomOpen', null);
    vi.unstubAllGlobals();
  });
  it('starts off (null) on a coarse pointer, as with a mouse in this phase', () => {
    coarse(true);
    settings.set('zoomOpen', null);
    expect(settings.zoomOpen).toBe(false);
  });
  it('a stored on works on a coarse pointer, and off stays off', () => {
    coarse(true);
    settings.set('zoomOpen', true);
    expect(settings.zoomOpen).toBe(true);
    settings.set('zoomOpen', false);
    expect(settings.zoomOpen).toBe(false);
  });
});
