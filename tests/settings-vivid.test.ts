import { describe, expect, it } from 'vitest';
import { settings } from '../src/ui/settings';

describe('vivid look setting', () => {
  it('turns colour per net on with it, and off again only if it turned it on', () => {
    settings.set('netColors', false);
    settings.setVivid(true);
    expect([settings.vivid, settings.netColors, settings.board]).toEqual([true, true, true]);
    settings.setVivid(false);
    expect([settings.vivid, settings.netColors]).toEqual([false, false]);
    // Colour per net set by hand stays as set.
    settings.setVivid(true);
    settings.set('netColors', false);
    settings.set('netColors', true);
    settings.setVivid(false);
    expect(settings.netColors).toBe(true);
    settings.set('netColors', false);
  });
});
