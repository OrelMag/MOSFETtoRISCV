import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_DEDUPE_MS, DOUBLE_TAP_MS, DOUBLE_TAP_PX, DoubleTap } from '../src/ui/doubletap';

describe('the double-tap detector', () => {
  it('takes two touch taps on the same thing, soon and close, as a double tap', () => {
    const d = new DoubleTap();
    expect(d.up(1000, 100, 100, 'fa0', true)).toBe(false);
    expect(d.up(1000 + DOUBLE_TAP_MS, 100 + DOUBLE_TAP_PX * 0.6, 100 + DOUBLE_TAP_PX * 0.6, 'fa0', true)).toBe(true);
  });

  it('needs both taps on the same target, within the time and the distance', () => {
    const d = new DoubleTap();
    d.up(0, 0, 0, 'fa0', true);
    expect(d.up(100, 0, 0, 'fa1', true)).toBe(false); // another part: a new first tap
    expect(d.up(100 + DOUBLE_TAP_MS + 1, 0, 0, 'fa1', true)).toBe(false); // too late
    expect(d.up(200 + DOUBLE_TAP_MS, DOUBLE_TAP_PX + 1, 0, 'fa1', true)).toBe(false); // too far
    expect(d.up(250 + DOUBLE_TAP_MS, DOUBLE_TAP_PX + 1, 5, 'fa1', true)).toBe(true);
  });

  it('starts a new pair after a double tap: a third tap is a first tap', () => {
    const d = new DoubleTap();
    d.up(0, 0, 0, 'a', true);
    expect(d.up(100, 0, 0, 'a', true)).toBe(true);
    expect(d.up(200, 0, 0, 'a', true)).toBe(false);
    expect(d.up(300, 0, 0, 'a', true)).toBe(true);
  });

  it('leaves mice and pens to dblclick, and a mouse release or a reset breaks a pending pair', () => {
    const d = new DoubleTap();
    d.up(0, 0, 0, 'a', false);
    expect(d.up(100, 0, 0, 'a', false)).toBe(false);
    d.up(200, 0, 0, 'a', true);
    d.up(250, 0, 0, 'a', false);
    expect(d.up(300, 0, 0, 'a', true)).toBe(false);
    d.reset();
    expect(d.up(350, 0, 0, 'a', true)).toBe(false);
    expect(d.up(400, 0, 0, 'a', true)).toBe(true);
  });

  it('drops the browser\'s own dblclick for a double tap it acted on, not a later one', () => {
    const d = new DoubleTap();
    expect(d.dblclick(50)).toBe(true); // a mouse double-click: nothing tapped
    d.up(1000, 0, 0, 'a', true);
    d.up(1150, 0, 0, 'a', true);
    expect(d.dblclick(1160)).toBe(false);
    expect(d.dblclick(1150 + DOUBLE_TAP_DEDUPE_MS)).toBe(false);
    expect(d.dblclick(1151 + DOUBLE_TAP_DEDUPE_MS)).toBe(true);
    // two taps that were not a double tap leave the dblclick to act
    d.up(5000, 0, 0, 'a', true);
    d.up(5000 + DOUBLE_TAP_MS + 50, 0, 0, 'a', true);
    expect(d.dblclick(5000 + DOUBLE_TAP_MS + 60)).toBe(true);
  });

  it('drops it in another view too: the sandbox opens Look inside on the taps, the dblclick lands on that', () => {
    const editor = new DoubleTap(), inside = new DoubleTap();
    editor.up(20000, 0, 0, 'part', true);
    expect(editor.up(20100, 0, 0, 'part', true)).toBe(true);
    expect(inside.dblclick(20110)).toBe(false);
  });
});
