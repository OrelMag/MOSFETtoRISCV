// Quick navigation: every chapter and step reachable, search ranking.

import { describe, expect, it } from 'vitest';
import { chapterById, chapters } from '../src/chapters';
import { LADDER, ladderFocus } from '../src/widgets/journey';
import { chapterMark, navEntries, plainText, resumeTarget, searchNav, snippet, type NavChapter } from '../src/ui/chapternav';

const book: NavChapter[] = [
  { id: 'gates', num: 4, title: 'Logic gates', blurb: 'Everything from NAND.', level: 'Gates', steps: [
    { title: 'NOT from NAND', body: '<p>Tie both inputs.</p>' },
    { title: 'XOR', body: '<p>Four NANDs &amp; a <b>trick</b>.</p>' },
  ] },
  { id: 'cache', num: 21, title: 'Caches', blurb: 'Hide the memory wall.', level: 'Memory', steps: [
    { title: 'Direct-mapped', body: '<p>A miss costs 20 cycles.</p>' },
    { title: 'Write-back', body: '<p>Dirty lines go back on eviction.</p>' },
  ] },
];

describe('chapter navigation', () => {
  it('has one entry per chapter and per step of the real book, each resolving', () => {
    const es = navEntries(chapters);
    expect(es.length).toBe(chapters.reduce((n, c) => n + 1 + c.steps.length, 0));
    expect(new Set(es.map((e) => `${e.chapter}/${e.step}`)).size).toBe(es.length);
    for (const e of es) {
      const m = /^#\/c\/([^/]+)\/(\d+)$/.exec(e.href)!;
      const c = chapterById(m[1])!;
      expect(c).toBeDefined();
      expect(Number(m[2])).toBeLessThan(c.steps.length);
      expect(e.text).not.toMatch(/<[a-z/]/i);
    }
    expect(navEntries(chapters)).toBe(es);
  });

  it('numbers an appendix by its letter, and finds it by that letter', () => {
    const withA: NavChapter[] = [...book, { id: 'app', num: 3, appendix: 'A', title: '1975: the 6502', blurb: 'NMOS.', level: 'NMOS', steps: [{ title: 'NMOS', body: '<p>Loads.</p>' }] }];
    const es = navEntries(withA);
    expect(es.filter((e) => e.chapter === 'app').map((e) => e.no)).toEqual(['A', 'A']);
    expect(es.find((e) => e.chapter !== 'app')!.no).toMatch(/^[0-9]{2}$/);
    expect(searchNav(es, 'a')[0]).toMatchObject({ chapter: 'app', step: -1 });
    // a chapter number does not find the appendix that continues the count
    expect(searchNav(es, '3').some((e) => e.chapter === 'app')).toBe(false);
  });

  it('strips markup and entities', () => {
    expect(plainText('<p>Four NANDs &amp; a <b>trick</b> &#x2192; x&lt;y</p>')).toBe('Four NANDs & a trick → x<y');
  });

  it('lists the chapters for an empty query', () => {
    expect(searchNav(navEntries(book), '  ').map((e) => e.title)).toEqual(['Logic gates', 'Caches']);
  });

  it('finds a chapter by number, before its steps', () => {
    const r = searchNav(navEntries(book), '21');
    expect(r[0]).toMatchObject({ chapter: 'cache', step: -1 });
    expect(r.every((e) => e.chapter === 'cache')).toBe(true);
  });

  it('ranks title matches above body matches', () => {
    const r = searchNav(navEntries(book), 'nand');
    expect(r.map((e) => e.title)).toEqual(['NOT from NAND', 'Logic gates', 'XOR']);
  });

  it('requires every word, one may match the chapter title', () => {
    expect(searchNav(navEntries(book), 'cache miss').map((e) => e.title)).toEqual(['Direct-mapped']);
    expect(searchNav(navEntries(book), 'xor eviction')).toEqual([]);
  });

  it('cuts a snippet around a body match', () => {
    const e = navEntries(book).find((x) => x.title === 'Write-back')!;
    expect(snippet(e, 'eviction')).toContain('eviction');
  });
});

describe('the journey ladder', () => {
  it('links every rung to a real chapter, numbered as that chapter, in descending order', () => {
    for (const r of LADDER) expect(chapterById(r.chapter)?.num, r.title).toBe(r.num);
    const nums = LADDER.map((r) => r.num);
    expect(nums).toEqual([...nums].sort((a, b) => b - a));
    // The top rung opens the last track (the chapters sharing the last chapter's level): the ladder reaches the end.
    // Appendices come after the journey and are not on it.
    const last = chapters.filter((c) => !c.appendix).at(-1)!;
    expect(LADDER[0].num).toBe(chapters.find((c) => c.level === last.level)?.num);
  });

  it('opens at the bottom rung (the first chapter) for a new visitor, else at the highest rung visited', () => {
    expect(LADDER.at(-1)!.chapter).toBe(chapters.find((c) => c.num === 1 && !c.prologue && !c.appendix)!.id);
    expect(ladderFocus(() => false)).toBe(LADDER.length - 1);
    expect(LADDER[ladderFocus((id) => id === 'mosfet' || id === 'cpu' || id === 'alu')].chapter).toBe('cpu');
  });
});

describe('Continue on the home page', () => {
  const three = [
    { id: 'a', steps: [1, 2, 3] },
    { id: 'b', steps: [1, 2] },
    { id: 'c', steps: [1] },
  ];
  const seen = (m: Record<string, number[]>) => (id: string) => m[id] ?? [];

  it('is absent for a new visitor', () => {
    expect(resumeTarget(three, seen({}))).toBeNull();
  });

  it('goes to the step last viewed, not to step 0', () => {
    expect(resumeTarget(three, seen({ a: [0, 1] }), { chapter: 'a', step: 1 })).toEqual({ chapter: three[0], step: 1, next: false });
    // the step last viewed, even when a later chapter was started before (Continue follows the learner, not book order)
    expect(resumeTarget(three, seen({ a: [0], b: [0] }), { chapter: 'a', step: 0 })).toEqual({ chapter: three[0], step: 0, next: false });
  });

  it('offers the next chapter once every step of the last one has been seen', () => {
    expect(resumeTarget(three, seen({ a: [0, 1, 2] }), { chapter: 'a', step: 2 })).toEqual({ chapter: three[1], step: 0, next: true });
    // the next chapter partly seen: its first unseen step
    expect(resumeTarget(three, seen({ a: [0, 1, 2], b: [0] }), { chapter: 'a', step: 1 })).toEqual({ chapter: three[1], step: 1, next: true });
    // the last chapter of the book: stay on it
    expect(resumeTarget(three, seen({ c: [0] }), { chapter: 'c', step: 0 })).toEqual({ chapter: three[2], step: 0, next: false });
  });

  it('falls back to the last started chapter and its furthest step without a record of the last view', () => {
    expect(resumeTarget(three, seen({ a: [0], b: [1] }))).toEqual({ chapter: three[1], step: 1, next: false });
    // a record naming a chapter that no longer exists, or a step past its end
    expect(resumeTarget(three, seen({ a: [0] }), { chapter: 'gone', step: 4 })).toEqual({ chapter: three[0], step: 0, next: false });
    expect(resumeTarget(three, seen({ b: [0] }), { chapter: 'b', step: 9 })).toEqual({ chapter: three[1], step: 0, next: false });
  });
});

describe('a chapter card\'s mark', () => {
  it('is the full tick only when every step was seen and every check done', () => {
    expect(chapterMark(1, { done: 6, total: 6 })).toBe('done');
    expect(chapterMark(1, { done: 0, total: 0 })).toBe('done');
    expect(chapterMark(1, { done: 2, total: 6 })).toBe('seen');
    expect(chapterMark(0.5, { done: 6, total: 6 })).toBeNull();
    expect(chapterMark(0, { done: 0, total: 3 })).toBeNull();
  });
});
