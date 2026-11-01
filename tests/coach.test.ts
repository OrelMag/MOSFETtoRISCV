import { describe, expect, it } from 'vitest';
import { move, mayAutoStart, pickBeats, SANDBOX_BEATS, STAGE_BEATS } from '../src/ui/coachplan';

describe('coach marks', () => {
  it('keeps the beats whose control is on the page, in order', () => {
    const on = new Set(['.stage .crumbs', '.stage .probe-btn', '.stage .remix-btn']);
    expect(pickBeats(STAGE_BEATS, (t) => on.has(t)).map((b) => b.id)).toEqual(['drill', 'probe', 'remix']);
    expect(pickBeats(STAGE_BEATS, () => false)).toEqual([]);
  });
  it('every beat has a target, a title and text; ids are unique', () => {
    for (const set of [STAGE_BEATS, SANDBOX_BEATS]) {
      expect(new Set(set.map((b) => b.id)).size).toBe(set.length);
      for (const b of set) { expect(b.target).toBeTruthy(); expect(b.title).toBeTruthy(); expect(b.text.length).toBeGreaterThan(40); }
    }
  });
  it('moves: back stops at the first, next past the last ends the tour', () => {
    expect(move({ index: 0, count: 3 }, 'back')).toBe(0);
    expect(move({ index: 1, count: 3 }, 'back')).toBe(0);
    expect(move({ index: 1, count: 3 }, 'next')).toBe(2);
    expect(move({ index: 2, count: 3 }, 'next')).toBeNull();
  });
  it('does not start over a seen tour, a running content tour or a dialog', () => {
    expect(mayAutoStart({ done: false, otherTour: false, dialogOpen: false })).toBe(true);
    expect(mayAutoStart({ done: true, otherTour: false, dialogOpen: false })).toBe(false);
    expect(mayAutoStart({ done: false, otherTour: true, dialogOpen: false })).toBe(false);
    expect(mayAutoStart({ done: false, otherTour: false, dialogOpen: true })).toBe(false);
  });
});
