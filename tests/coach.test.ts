import { describe, expect, it } from 'vitest';
import { beatsOf, move, mayAutoStart, pickBeats, SANDBOX_BEATS, STAGE_BEATS } from '../src/ui/coachplan';

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
  it('the first-run stage tour is three beats ending on where the rest is; the ? sheet plays all seven', () => {
    for (const coarse of [false, true]) {
      const short = beatsOf('stage', coarse, true);
      expect(short.map((b) => b.id)).toEqual(['drill', 'walk', 'probe']);
      expect(short[2].text.endsWith('Show me the controls, on the ? sheet, tours Why?, Step, Share and Open in Sandbox.')).toBe(true);
      expect(short[0].text).not.toMatch(/sheet/);
      expect(beatsOf('stage', coarse, false)).toHaveLength(STAGE_BEATS.length);
    }
    expect(STAGE_BEATS).toHaveLength(7);
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

describe('coach marks and routes', () => {
  it('a tour belongs to its page only', async () => {
    const { coachFits } = await import('../src/ui/coachplan');
    expect(coachFits('sandbox', '#/sandbox/u_x')).toBe(true);
    expect(coachFits('sandbox', '#/c/basics/0')).toBe(false);
    expect(coachFits('stage', '#/c/cpu/3')).toBe(true);
    expect(coachFits('stage', '#/workbench/rca4')).toBe(true);
    expect(coachFits('stage', '#/sandbox')).toBe(false);
    expect(coachFits('stage', '#/campaign')).toBe(false);
  });
});
