// Quick navigation: every chapter and step reachable, search ranking.

import { describe, expect, it } from 'vitest';
import { chapterById, chapters } from '../src/chapters';
import { navEntries, plainText, searchNav, snippet, type NavChapter } from '../src/ui/chapternav';

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
