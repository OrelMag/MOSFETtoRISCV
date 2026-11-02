import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { ANALOGIES, analogiesForCodex, analogiesOf } from '../src/chapters/analogies';
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
