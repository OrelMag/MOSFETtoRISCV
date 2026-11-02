// The review bank (learn/reviewbank.json) agrees with the chapters and the simulator: every predict answer is its beat's
// expect, every combinational beat with one has a question (a stale file fails: rerun scripts/review-bank.ts), every
// "what breaks" answer is what sim/ablate.ts finds; a queue holds at most NEW_GENERATED new generated questions.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { chapters } from '../src/chapters';
import { REVIEW_BANK } from '../src/learn/bank';
import { resolveComponent } from '../src/lib/resolve';
import { ablate } from '../src/sim/ablate';
import { buildQueue, emptyReview, NEW_GENERATED } from '../src/ui/review';
import { allQuestions } from '../src/ui/reviewqs';

const byId = new Map(chapters.map((c) => [c.id, c]));

describe('review bank', () => {
  it('has a predict question for every beat of a combinational tour that sets and expects, and only those', () => {
    const want: string[] = [];
    for (const c of chapters) c.steps.forEach((s, i) => {
      if (!s.tour || !s.scene || s.tour.beats.some((b) => b.cycles || b.reset)) return;
      s.tour.beats.forEach((b, k) => { if (b.set && b.expect && Object.keys(b.expect).length) want.push(`predict:${c.id}:${i}:${k}`); });
    });
    const have = REVIEW_BANK.filter((q) => q.kind === 'predict').map((q) => q.key);
    expect(have.filter((k) => !want.includes(k)), 'stale: rerun scripts/review-bank.ts').toEqual([]);
    // a beat whose expected port is not on the scene's root is left out by the generator; never more than a few
    expect(want.filter((k) => !have.includes(k)).length).toBeLessThan(10);
  });

  it('every predict answer is the beat\'s expected value', () => {
    for (const q of REVIEW_BANK) {
      if (q.kind !== 'predict') continue;
      const [, ch, st, bt] = q.key.split(':');
      const beat = byId.get(ch)!.steps[+st].tour!.beats[+bt];
      const port = /<code>([^<]+)<\/code>/.exec(q.question)![1];
      expect(q.options[q.answer], q.key).toBe(String(beat.expect![port]));
      expect(new Set(q.options).size, `${q.key}: options distinct`).toBe(q.options.length);
    }
  });

  it('every "what breaks" answer is what ablation finds', () => {
    for (const q of REVIEW_BANK) {
      if (q.kind !== 'ablate') continue;
      const [, lib, inst] = q.key.split(':');
      const ab = ablate(resolveComponent(lib)!);
      if (typeof ab === 'string') throw new Error(ab);
      const serves = ab.parts.find((p) => p.inst === inst)!.serves;
      expect(q.options[q.answer], q.key).toBe(serves.join(' and '));
    }
  });

  it('a queue holds at most a few new generated questions', () => {
    const all = buildQueue(allQuestions(), emptyReview(), { now: 0, visited: () => true, limit: 5000 });
    expect(all.filter((x) => x.q.generated).length).toBe(NEW_GENERATED);
    // and a twelve-question session meets one by its third question
    const s = buildQueue(allQuestions(), emptyReview(), { now: 0, visited: () => true });
    expect(s[2].q.generated).toBe(true);
  });
});
