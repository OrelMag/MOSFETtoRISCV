import { describe, expect, it } from 'vitest';
import { CODEX } from '../src/campaign/codex';
import { matchNote, searchCodex } from '../src/campaign/codexsearch';

describe('codex search: why a hit matched', () => {
  it('says nothing when the title matches, something for every other hit', () => {
    for (const q of ['flip', 'adder', 'twos complement']) {
      const hits = searchCodex(q);
      expect(hits.length).toBeGreaterThan(0);
      for (const e of hits) {
        const note = matchNote(e, q);
        const inTitle = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').includes(q.replace(/[^a-z0-9]/g, ''));
        if (!inTitle) expect(note, `${q} → ${e.id}`).not.toBe('');
      }
    }
  });
  it('marks the hit inside the summary', () => {
    const e = searchCodex('flip').find((x) => !x.title.toLowerCase().includes('flip'))!;
    expect(matchNote(e, 'flip')).toMatch(/«flip/i);
  });
  it('is empty for no query', () => expect(matchNote(CODEX[0], '  ')).toBe(''));
});
