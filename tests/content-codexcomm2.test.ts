// The Communication extension's codex entries (codexcomm2*.ts, codexmore8*.ts, codexcheck10*.ts): complete, linked to real chapter steps by their titles, every question answer-first with a reason per wrong option.
// The numbers each group quotes are pinned in tests/content-codexcomm2{a,b,c,d}.test.ts.

import { describe, expect, it } from 'vitest';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CODEX_COMM2, TAUGHT_COMM2 } from '../src/campaign/codexcomm2';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { TAUGHT } from '../src/chapters/taught';

describe('the extension\'s codex entries', () => {
  it('have no id twice, and a chapter of their own', () => {
    expect(new Set(CODEX_COMM2.map((e) => e.id)).size).toBe(CODEX_COMM2.length);
    expect(Object.keys(TAUGHT_COMM2).sort()).toEqual(CODEX_COMM2.map((e) => e.id).sort());
    for (const e of CODEX_COMM2) expect(chapterById(TAUGHT[e.id]), e.id).toBeTruthy();
  });
  for (const e of CODEX_COMM2) it(`${e.id} is complete`, () => {
    const m = moreOf(e.id)!;
    expect(e.body.length, 'summary').toBeGreaterThan(150);
    expect(m?.idea, 'idea').toBeTruthy();
    expect(m.example?.body, 'example').toBeTruthy();
    expect(m.mistakes?.length, 'mistakes').toBeGreaterThanOrEqual(3);
    expect(m.chapters?.length, 'chapters').toBeGreaterThan(0);
    expect(e.related?.length, 'related').toBeGreaterThan(0);
    for (const r of e.related!) expect(codexById(r), `→ ${r}`).toBeTruthy();
    expect(m.chapters!.map((l) => l.chapter), 'the teaching chapter is a link').toContain(TAUGHT[e.id]);
    for (const l of m.chapters!) {
      const ch = chapterById(l.chapter);
      expect(ch, l.chapter).toBeTruthy();
      expect(l.step, `${l.chapter}: a step`).toBeDefined();
      expect(l.label, `${l.chapter} step ${l.step}`).toBe(ch!.steps[l.step!].title);
    }
    const qs = CHECKS[e.id];
    expect(qs?.length, 'questions').toBe(2);
    for (const q of qs) {
      expect(q.answer, 'answer first').toBe(0);
      expect(q.why?.length, 'a why per option').toBe(q.options.length);
      expect(q.why![0], 'the right option has no why').toBe('');
      for (const w of q.why!.slice(1)) expect(w.length, q.question).toBeGreaterThan(10);
      expect(q.explain.length, 'explain').toBeGreaterThan(20);
    }
    // text never types a chapter number that can move (chapters/order.ts)
    const all = [e.body, m.idea, m.example!.body, ...m.mistakes!, ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...q.why!])].join(' ');
    expect(all, 'a typed chapter number').not.toMatch(/\bchapter \d/i);
  });
});
