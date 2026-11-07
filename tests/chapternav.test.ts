// Quick navigation: every chapter and step reachable, search ranking.

import { beforeAll, describe, expect, it } from 'vitest';
import { chapterById, chapters } from '../src/chapters';
import { ladderFocus } from '../src/widgets/journey';
import { SECTIONS, sectionsOf } from '../src/chapters/sections';
import { chapterMark, navEntries, plainText, resumeTarget, searchNav, snippet, type NavChapter } from '../src/ui/chapternav';
import { BOOK_TIMEOUT, warmBook, WARM_TIMEOUT } from './warmbook';

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
  beforeAll(warmBook, WARM_TIMEOUT);

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
  }, BOOK_TIMEOUT);

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

describe('the map', () => {
  it('cuts the book into its sections: all there, in order, each chapter once', () => {
    const secs = sectionsOf(chapters);
    expect(secs.map((s) => s.name)).toEqual(SECTIONS.map((s) => s.name));
    expect(secs.flatMap((s) => s.chapters.map((c) => c.id))).toEqual(chapters.map((c) => c.id));
    for (const s of SECTIONS) expect(chapterById(s.first), s.name).toBeTruthy();
  });

  it('gives each section the tone of its chapters and the range of their numbers', () => {
    for (const s of sectionsOf(chapters)) for (const c of s.chapters) expect(c.appendix ? 'appendix' : c.prologue ? 'prologue' : 'journey', c.id).toBe(s.tone);
    const of = (name: string) => sectionsOf(chapters).find((s) => s.name === name)!;
    expect(of('Transistors to gates').range).toBe('01–04');
    expect(of('Prologue: before the transistor').range).toBe('P1–P3');
    expect(of('Start').range).toBe('');
  });

  it('copes with the communication ladder cut into groups, with a labelled on-ramp in front', () => {
    const ch = (id: string, num: number, label?: string) => ({ id, num, ...(label ? { label } : {}) });
    const book = [ch('bus', 38), ch('onramp', 0, 'C0'), ch('telegraph', 39), ch('spi', 44), ch('signals', 45), ch('light', 50), ch('errors', 51), ch('pcie', 53), ch('ethernet', 54), ch('path', 61), ch('radio', 62), ch('bench', 66), { id: 'a', num: 67, appendix: 'A' }];
    const secs = sectionsOf(book, [
      { name: 'Memory in depth', first: 'bus' },
      { name: 'Communication: wires and clocks', first: 'onramp' },
      { name: 'Communication: the channel', first: 'signals' },
      { name: 'Communication: getting it right', first: 'errors' },
      { name: 'Communication: networks', first: 'ethernet' },
      { name: 'Communication: without a wire, and at scale', first: 'radio' },
      { name: 'Appendix', first: 'a' },
    ]);
    expect(secs.map((s) => s.range)).toEqual(['38', '39–44', '45–50', '51–53', '54–61', '62–66', 'A']);
    expect(secs.map((s) => s.tone)).toEqual(['journey', 'journey', 'journey', 'journey', 'journey', 'journey', 'appendix']);
    expect(secs[1].chapters.map((c) => c.id)).toEqual(['onramp', 'telegraph', 'spi']);
    // a section of nothing but a labelled chapter has no range to show
    expect(sectionsOf([ch('onramp', 0, 'C0')], [{ name: 'On-ramp', first: 'onramp' }])[0].range).toBe('');
  });

  it('opens at the MOSFET for a new visitor or one still in Start, else at the chapter being read or the last one opened', () => {
    expect(ladderFocus(() => false)).toBe('mosfet');
    expect(ladderFocus((id) => id === 'basics', 'map')).toBe('mosfet');
    expect(ladderFocus((id) => id === 'mosfet' || id === 'cpu' || id === 'alu')).toBe('cpu');
    expect(ladderFocus(() => true, 'dram')).toBe('dram');
    expect(ladderFocus((id) => id === 'cpu', 'no-such-chapter')).toBe('cpu');
    expect(ladderFocus((id) => id === 'cpu' || id === 'map', 'map')).toBe('cpu');
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
