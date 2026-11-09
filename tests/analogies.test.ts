import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { ANALOGIES, ANALOGY_INDEX_ID, analogiesForCodex, analogiesOf, analogyIndex } from '../src/chapters/analogies';
import { FIGURES } from '../src/ui/analogyfigs';
import { CODEX } from '../src/campaign/codex';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

describe('analogies', () => {
  it('each sits on a step that exists', () => {
    for (const a of ANALOGIES) {
      const c = chapters.find((x) => x.id === a.chapter);
      expect(c, `${a.title}: chapter ${a.chapter}`).toBeDefined();
      expect(c!.steps.map((s) => s.title), `${a.title}: step "${a.step}"`).toContain(a.step);
    }
  });

  it('one per step, and each title once', () => {
    const steps = ANALOGIES.map((a) => `${a.chapter}/${a.step}`);
    expect(new Set(steps).size).toBe(steps.length);
    const titles = ANALOGIES.map((a) => a.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('each says where it breaks, in a sentence or two', () => {
    for (const a of ANALOGIES) {
      const b = text(a.breaks);
      expect(b.length, a.title).toBeGreaterThan(40);
      expect(b.length, a.title).toBeLessThan(400);
      expect(b, a.title).not.toMatch(/^where it breaks/i);
      expect(text(a.body).length, a.title).toBeGreaterThan(60);
    }
  });

  it('names only codex entries that exist', () => {
    const ids = new Set(CODEX.map((e) => e.id));
    for (const a of ANALOGIES) for (const id of a.codex ?? []) expect(ids.has(id), `${a.title}: codex ${id}`).toBe(true);
  });

  it('lookups find them', () => {
    const a = ANALOGIES[0];
    expect(analogiesOf(a.chapter, a.step)).toEqual([a]);
    expect(analogiesForCodex('mosfet').map((x) => x.step)).toContain('Three regions');
  });
});

describe('analogy figures', () => {
  it('every figure key is registered', async () => {
    const { FIGURES } = await import('../src/ui/analogyfigs');
    for (const a of ANALOGIES) if (a.figure) expect(FIGURES[a.figure], `${a.title}: figure ${a.figure}`).toBeDefined();
  });
});

describe('analogy acceptance', () => {
  // Every one, the two whose step widget also has a Water view included (the loop, the faucet): the card is read without
  // the widget (a phone's text above the stage, a codex entry), so it carries the picture itself.
  it('every analogy has a figure, and each figure is registered', () => {
    expect(ANALOGIES.filter((a) => !a.figure).map((a) => `${a.chapter}/${a.step}`)).toEqual([]);
    for (const a of ANALOGIES) expect(FIGURES[a.figure!], a.figure).toBeDefined();
  });

  it('the hover card finds an analogy for the entries that name one', () => {
    for (const a of ANALOGIES) for (const id of a.codex ?? []) expect(analogiesForCodex(id).map((x) => x.title), id).toContain(a.title);
    expect(analogiesForCodex('refresh')[0].title).toBe('A row of leaky buckets');
  });

  it('the cache chapter tells leaks before the DRAM chapter, under its own title', () => {
    const cache = ANALOGIES.find((a) => a.chapter === 'cache' && a.step === 'Leaks, refresh and sense amplifiers')!;
    const dram = ANALOGIES.find((a) => a.chapter === 'dram' && a.figure === 'leaky')!;
    expect(cache.figure).toBe('leaky');
    expect(cache.title).not.toBe(dram.title);
  });
});

describe('the analogy index', () => {
  const groups = analogyIndex(chapters);

  it('lists every analogy once, on its own step, chapters in journey order', () => {
    const listed = groups.flatMap((g) => g.items.map((x) => x.a));
    expect(listed.length).toBe(ANALOGIES.length);
    expect(new Set(listed).size).toBe(ANALOGIES.length);
    const order = chapters.map((c) => c.id);
    expect(groups.map((g) => order.indexOf(g.chapter))).toEqual(groups.map((g) => order.indexOf(g.chapter)).sort((a, b) => a - b));
    for (const g of groups) {
      const c = chapters.find((x) => x.id === g.chapter)!;
      for (const { a, step } of g.items) expect(c.steps[step]?.title, a.title).toBe(a.step);
      expect(g.items.map((x) => x.step)).toEqual(g.items.map((x) => x.step).sort((a, b) => a - b));
    }
  });

  it('has a route no codex entry takes', () => {
    expect(CODEX.some((e) => e.id === ANALOGY_INDEX_ID)).toBe(false);
  });
});
