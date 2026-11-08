// No term before its chapter: every codex term a chapter shows by default is taught by then (chapters/taught.ts), or
// explained in place (data-ahead), and the table of where terms are taught agrees with the codex's own chapter links.

import { beforeAll, describe, expect, it } from 'vitest';
import { CODEX } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { chapters } from '../src/chapters';
import { earlyUses } from '../src/chapters/firstuse';
import { TAUGHT, TAUGHT_OPTIONAL } from '../src/chapters/taught';
import { BOOK_TIMEOUT, warmBook, WARM_TIMEOUT } from './warmbook';

describe('first use', () => {
  // both read every chapter's prose: warm it first, as the other whole-book tests do
  beforeAll(warmBook, WARM_TIMEOUT);

  it('every taught chapter is one of the entry\'s own links, on the right side of the journey', () => {
    const ids = new Set(CODEX.map((e) => e.id));
    const byId = new Map(chapters.map((c) => [c.id, c]));
    const bad: string[] = [];
    for (const [id, ch] of Object.entries(TAUGHT)) {
      const links = moreOf(id)?.chapters?.map((l) => l.chapter) ?? [];
      if (!ids.has(id)) bad.push(`${id}: no such codex entry`);
      else if (!links.includes(ch)) bad.push(`${id}: taught in ${ch}, which its codex entry does not link`);
      const c = byId.get(ch);
      if (!c || c.prologue || c.appendix) bad.push(`${id}: ${ch} is not a journey chapter`);
    }
    for (const [id, chs] of Object.entries(TAUGHT_OPTIONAL)) {
      const links = moreOf(id)?.chapters?.map((l) => l.chapter) ?? [];
      for (const ch of chs) if (!links.includes(ch) || !(byId.get(ch)?.prologue || byId.get(ch)?.appendix)) bad.push(`${id}: optional ${ch}`);
    }
    // an entry a journey chapter links has a row (else it would never count as taught)
    for (const e of CODEX) {
      const j = moreOf(e.id)?.chapters?.some((l) => { const c = byId.get(l.chapter); return c && !c.prologue && !c.appendix; });
      if (j && !TAUGHT[e.id]) bad.push(`${e.id}: linked from the journey but has no TAUGHT row`);
    }
    expect(bad).toEqual([]);
  }, BOOK_TIMEOUT);

  it('no codex term is used before the chapter that teaches it, unless explained in place', () => {
    const { early, thin } = earlyUses(chapters);
    expect(thin, 'a data-ahead explanation needs a few words of its own').toEqual([]);
    expect(early.map((u) => `${u.chapter} / ${u.where}: ${u.word} (${u.id})`), 'reword it, or explain it in place with data-ahead').toEqual([]);
  }, BOOK_TIMEOUT);
});
