// The light chapter outline (chapters/manifest.ts, loaders.ts) is generated from the chapters: it must equal what the chapters say,
// every loader must give its chapter, and what reads the outline must agree with what reads the chapters.
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chapters } from '../src/chapters';
import { MANIFEST } from '../src/chapters/manifest';
import { LOADERS } from '../src/chapters/loaders';
import { loadChapter, loadChapters } from '../src/chapters/load';
import { loadersSource, manifestSource, metaOf, type Locations } from '../src/chapters/manifestgen';
import { outline, outlineIndex, outlineOf } from '../src/chapters/outline';
import { checkKeys, checksDone, recapIndex } from '../src/chapters/checks';
import { navEntries, plainText } from '../src/ui/chapternav';
import { withText } from '../src/ui/chaptertext';
import { BOOK_TIMEOUT, warmBook, WARM_TIMEOUT } from './warmbook';

const read = (f: string) => readFileSync(new URL(`../src/chapters/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const modules = import.meta.glob('../src/chapters/ch-*.ts', { eager: true }) as Record<string, Record<string, unknown>>;

describe('the chapter manifest', () => {
  beforeAll(warmBook, WARM_TIMEOUT);

  it('is current: npm run manifest rewrites it', () => {
    expect(read('manifest.ts')).toBe(manifestSource(chapters));
  });

  it('lists the chapters in book order, with their steps', () => {
    expect(outline.map((c) => c.id)).toEqual(chapters.map((c) => c.id));
    expect(MANIFEST).toEqual(chapters.map((c) => metaOf(c)));
    for (const c of chapters) expect(outlineIndex(c.id)).toBe(chapters.indexOf(c));
    expect(outlineOf('no-such-chapter')).toBeUndefined();
  });

  it('has a loader for every chapter, written as literal imports that give that chapter', async () => {
    const where: Locations = {};
    for (const [path, mod] of Object.entries(modules)) {
      for (const [name, v] of Object.entries(mod)) {
        const c = chapters.find((x) => x === v);
        if (c) where[c.id] = [path.split('/').pop()!.replace(/\.ts$/, ''), name];
      }
    }
    expect(read('loaders.ts')).toBe(loadersSource(chapters, where));
    expect(Object.keys(LOADERS)).toEqual(chapters.map((c) => c.id));
    for (const c of chapters) expect(await LOADERS[c.id]()).toBe(c);
  });

  it('loads one chapter, or all in book order, and rejects an unknown id', async () => {
    expect(await loadChapter('adders')).toBe(chapters.find((c) => c.id === 'adders'));
    expect((await loadChapters()).map((c) => c.id)).toEqual(chapters.map((c) => c.id));
    await expect(loadChapter('nope')).rejects.toThrow(/No such chapter/);
  });

  it('counts checks as the chapters do', () => {
    for (const c of chapters) {
      const m = outlineOf(c.id)!;
      expect(checkKeys(m)).toEqual(checkKeys(c));
      expect(recapIndex(m)).toBe(recapIndex(c));
      expect(checksDone(m, (k) => k.endsWith(':0'))).toEqual(checksDone(c, (k) => k.endsWith(':0')));
    }
  });

  it('gives the search the same entries from the index file as from the chapters', () => {
    const index = { v: 1, text: Object.fromEntries(chapters.map((c) => [c.id, c.steps.map((s) => plainText(s.body))])) };
    const got = withText(index)!;
    expect(got).not.toBeNull();
    expect(navEntries(got)).toEqual(navEntries(chapters));
    // a stale file (a step added since) is refused, not trusted
    expect(withText({ v: 1, text: { ...index.text, [chapters[0].id]: index.text[chapters[0].id].slice(1) } })).toBeNull();
    expect(withText({ v: 2, text: index.text })).toBeNull();
    expect(withText(null)).toBeNull();
  }, BOOK_TIMEOUT);
});
