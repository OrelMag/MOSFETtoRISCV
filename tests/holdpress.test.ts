import { describe, expect, it } from 'vitest';
import { HOLD_MS, HOLD_SLOP, HoldPress, type Timers } from '../src/ui/holdpress';

/** A clock the test turns by hand. */
function fake() {
  let now = 0, next = 1;
  const pending = new Map<number, { at: number; f: () => void }>();
  const timers: Timers = {
    set: (f, ms) => { pending.set(next, { at: now + ms, f }); return next++; },
    clear: (t) => void pending.delete(t as number),
  };
  const advance = (ms: number) => {
    const to = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, p]) => p.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].f();
    }
    now = to;
  };
  return { timers, advance, pending };
}

describe('press and hold', () => {
  it('fires once at the hold time, at the press point', () => {
    const c = fake(), got: [number, number][] = [];
    const h = new HoldPress((x, y) => got.push([x, y]), c.timers);
    h.start(1, 40, 50);
    c.advance(HOLD_MS - 1);
    expect(got).toEqual([]);
    c.advance(1);
    expect(got).toEqual([[40, 50]]);
    expect(h.fired).toBe(true);
    c.advance(2000);
    expect(got.length).toBe(1);
    expect(h.end(1)).toBe(true); // the lift after a fired hold says so
    expect(h.active).toBe(false);
  });

  it('is a tap when the finger lifts early', () => {
    const c = fake();
    let n = 0;
    const h = new HoldPress(() => n++, c.timers);
    h.start(1, 0, 0);
    c.advance(HOLD_MS - 50);
    expect(h.end(1)).toBe(false);
    c.advance(1000);
    expect(n).toBe(0);
    expect(c.pending.size).toBe(0);
  });

  it('is cancelled by moving past the slop, not by a tremor', () => {
    const c = fake();
    let n = 0;
    const h = new HoldPress(() => n++, c.timers);
    h.start(1, 100, 100);
    c.advance(100);
    expect(h.move(1, 100 + HOLD_SLOP, 100)).toBe(true);
    c.advance(HOLD_MS);
    expect(n).toBe(1);
    n = 0;
    h.end(1);
    h.start(2, 100, 100);
    c.advance(100);
    expect(h.move(2, 100, 100 + HOLD_SLOP + 1)).toBe(false);
    c.advance(HOLD_MS * 2);
    expect(n).toBe(0);
    expect(h.active).toBe(false);
  });

  it('is cancelled by a second finger (pinch, pan), before and after it fired', () => {
    const c = fake();
    let n = 0;
    const h = new HoldPress(() => n++, c.timers);
    h.start(1, 0, 0);
    c.advance(200);
    h.start(2, 80, 80);
    c.advance(HOLD_MS * 2);
    expect(n).toBe(0);
    expect(h.active).toBe(false);
    // the second finger's own lift must not fire anything either
    expect(h.end(2)).toBe(false);
    h.start(3, 0, 0);
    c.advance(HOLD_MS);
    expect(n).toBe(1);
    h.start(4, 5, 5);
    expect(h.active).toBe(false);
    expect(h.fired).toBe(false);
  });

  it('ignores moves and lifts of other pointers, and restarts cleanly', () => {
    const c = fake();
    let n = 0;
    const h = new HoldPress(() => n++, c.timers);
    h.start(1, 0, 0);
    expect(h.move(9, 500, 500)).toBe(false);
    expect(h.end(9)).toBe(false);
    c.advance(HOLD_MS);
    expect(n).toBe(1);
    h.end(1);
    h.start(1, 0, 0);
    h.cancel();
    c.advance(HOLD_MS * 2);
    expect(n).toBe(1);
  });
});
