// The 3D canvas's wheel and touch rule (gl/kit/wheel.ts): the page keeps the wheel and vertical swipes until the canvas is
// engaged (focused); Ctrl / ⌘ + wheel, a trackpad pinch and full screen always zoom; the hint once, for a wheel the page took.
import { describe, expect, it } from 'vitest';
import { touchActionOf, wheelHint, wheelZooms } from '../src/gl/kit/wheel';

const st = (o: Partial<{ focused: boolean; ctrl: boolean; meta: boolean; fullscreen: boolean }> = {}) =>
  ({ focused: false, ctrl: false, meta: false, fullscreen: false, ...o });

describe('the wheel over a 3D canvas', () => {
  it('scrolls the page over a canvas nobody clicked', () => {
    expect(wheelZooms(st())).toBe(false);
  });
  it('zooms once the canvas is focused (click, tap, Tab) and until focus leaves', () => {
    expect(wheelZooms(st({ focused: true }))).toBe(true);
  });
  it('Ctrl / ⌘ + wheel (and a trackpad pinch, which arrives as Ctrl + wheel) always zoom', () => {
    expect(wheelZooms(st({ ctrl: true }))).toBe(true);
    expect(wheelZooms(st({ meta: true }))).toBe(true);
  });
  it('full screen always zooms', () => {
    expect(wheelZooms(st({ fullscreen: true }))).toBe(true);
  });
  it('the hint: only for a wheel the page took, and only the first time', () => {
    expect(wheelHint(st(), false)).toBe(true);
    expect(wheelHint(st(), true)).toBe(false);
    expect(wheelHint(st({ focused: true }), false)).toBe(false);
    expect(wheelHint(st({ ctrl: true }), false)).toBe(false);
  });
});

describe('one-finger touch', () => {
  it('a vertical swipe scrolls the page unless the canvas is engaged or full screen', () => {
    expect(touchActionOf(false, false)).toBe('pan-y');
    expect(touchActionOf(true, false)).toBe('none');
    expect(touchActionOf(false, true)).toBe('none');
  });
});
