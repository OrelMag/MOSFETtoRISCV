// The menu's View inside / Hide inside over the zoom rule (view/lensplan.ts wantOpen; view/lens.ts applies it per box).
import { describe, expect, it } from 'vitest';
import { wantOpen } from '../src/view/lensplan';

const base = { pin: undefined, auto: true, rule: false, was: false, zoomingOut: false, ok: true } as const;

describe('wantOpen', () => {
  it('follows the zoom rule with the setting on and no choice made', () => {
    expect(wantOpen({ ...base, rule: true })).toBe(true);
    expect(wantOpen({ ...base })).toBe(false);
    // an open box stays open through a pan or a resize, closes on a zoom out
    expect(wantOpen({ ...base, was: true })).toBe(true);
    expect(wantOpen({ ...base, was: true, zoomingOut: true })).toBe(false);
  });

  it('opens nothing by zoom with the setting off', () => {
    expect(wantOpen({ ...base, auto: false, rule: true })).toBe(false);
    expect(wantOpen({ ...base, auto: false, rule: true, was: true })).toBe(false);
  });

  it('View inside opens a block at any zoom, with the setting on or off', () => {
    for (const auto of [true, false]) {
      expect(wantOpen({ ...base, auto, pin: true })).toBe(true);
      expect(wantOpen({ ...base, auto, pin: true, was: true, zoomingOut: true })).toBe(true);
    }
  });

  it('Hide inside keeps a block closed however far the zoom goes', () => {
    expect(wantOpen({ ...base, pin: false, rule: true })).toBe(false);
    expect(wantOpen({ ...base, pin: false, rule: true, was: true })).toBe(false);
  });

  it('opens nothing where the host refuses insides', () => {
    expect(wantOpen({ ...base, pin: true, ok: false })).toBe(false);
    expect(wantOpen({ ...base, rule: true, ok: false })).toBe(false);
  });
});
