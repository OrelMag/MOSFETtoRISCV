// The quiz box's option order: a fixed shuffle per question, so the authored position of the right answer (often
// the first) gives nothing away, and a question looks the same on every visit.

import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/campaign/codexcheck';
import { chapters } from '../src/chapters';
import type { Quiz } from '../src/chapters/types';
import { shuffleOrder } from '../src/ui/quiz';

describe('quiz option order', () => {
  it('is a permutation that depends only on its seed', () => {
    for (const n of [2, 3, 4, 5]) {
      for (const seed of ['a', 'mux|why', 'codex:hazards:0|Why can write-after-read never happen?']) {
        const o = shuffleOrder(n, seed);
        expect([...o].sort()).toEqual([...Array(n).keys()]);
        expect(shuffleOrder(n, seed)).toEqual(o);
      }
    }
  });

  it('spreads the right answers over the shown positions', () => {
    const qs: { key: string; q: Quiz }[] = [
      ...Object.entries(CHECKS).flatMap(([id, l]) => l.map((q, k) => ({ key: `codex:${id}:${k}`, q }))),
      ...chapters.flatMap((c) => (c.recap?.check ?? []).map((q, k) => ({ key: `${c.id}:recap:${k}`, q }))),
    ];
    const at = new Map<number, number>();
    for (const { key, q } of qs) {
      const shown = shuffleOrder(q.options.length, `${key}|${q.question}`).indexOf(q.answer);
      at.set(shown, (at.get(shown) ?? 0) + 1);
    }
    // no position holds more than half of the right answers (authored: about 70 % first)
    for (const [, n] of at) expect(n / qs.length).toBeLessThan(0.5);
  });
});
