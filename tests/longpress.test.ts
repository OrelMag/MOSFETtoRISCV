import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, LONG_PRESS_SLOP, LongPress, type LongPressTimers } from '../src/ui/longpress';

function rig() {
  let t = 0, next = 1;
  const pending = new Map<number, { at: number; f: () => void }>();
  const timers: LongPressTimers = { set: (f, ms) => { pending.set(next, { at: t + ms, f }); return next++; }, clear: (h) => void pending.delete(h as number) };
  const fired: [number, number][] = [];
  const lp = new LongPress((x, y) => fired.push([x, y]), timers, () => t);
  const wait = (ms: number) => { t += ms; for (const [k, v] of [...pending]) if (v.at <= t) { pending.delete(k); v.f(); } };
  return { lp, fired, wait };
}

describe('long press', () => {
  it('fires where the finger is after the delay', () => {
    const { lp, fired, wait } = rig();
    lp.press(1, 10, 20);
    wait(LONG_PRESS_MS - 1);
    expect(fired).toEqual([]);
    wait(1);
    expect(fired).toEqual([[10, 20]]);
    expect(lp.duplicate()).toBe(true);
  });
  it('does not fire when released early or moved past the slop', () => {
    const a = rig();
    a.lp.press(1, 0, 0); a.wait(100); a.lp.release(1); a.wait(1000);
    expect(a.fired).toEqual([]);
    const b = rig();
    b.lp.press(1, 0, 0); b.lp.move(1, LONG_PRESS_SLOP + 1, 0); b.wait(1000);
    expect(b.fired).toEqual([]);
    const c = rig();
    c.lp.press(1, 0, 0); c.lp.move(1, 3, 3); c.wait(1000);
    expect(c.fired.length).toBe(1);
  });
  it('a second finger cancels, and a later press waits until all fingers lifted', () => {
    const { lp, fired, wait } = rig();
    lp.press(1, 0, 0); lp.press(2, 50, 50); wait(1000);
    expect(fired).toEqual([]);
    lp.release(2); lp.press(3, 5, 5); wait(1000);
    expect(fired).toEqual([]);
    lp.release(1); lp.release(3); lp.press(4, 7, 7); wait(LONG_PRESS_MS);
    expect(fired).toEqual([[7, 7]]);
  });
  it('cancel() (a drag began) stops it', () => {
    const { lp, fired, wait } = rig();
    lp.press(1, 0, 0); lp.cancel(); wait(1000);
    expect(fired).toEqual([]);
    expect(lp.duplicate()).toBe(false);
  });
});
