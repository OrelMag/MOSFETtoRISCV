import { beforeAll, describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { BOOK_TIMEOUT, warmBook, WARM_TIMEOUT } from './warmbook';

// An option that carries its own justification ("4: an OR (3) then a NOT (1)") gives the answer away by its length:
// the reasoning belongs in `explain`. Walks every quiz reachable from the chapters (steps, challenges, recaps).
interface Q { question?: string; options: string[]; answer: number }
function quizzes(o: unknown, out: Q[] = [], seen = new Set<unknown>()): Q[] {
  if (!o || typeof o !== 'object' || seen.has(o)) return out;
  seen.add(o);
  const q = o as Partial<Q>;
  if (Array.isArray(q.options) && typeof q.answer === 'number' && q.options.every((x) => typeof x === 'string')) out.push(q as Q);
  for (const v of Object.values(o)) if (typeof v === 'object') quizzes(v, out, seen);
  return out;
}

describe('quiz options', () => {
  // reads every chapter: warm the book first, as the other whole-book tests do
  beforeAll(warmBook, WARM_TIMEOUT);

  it('the right option does not explain itself while the wrong ones are bare', () => {
    const bad: string[] = [];
    for (const c of chapters) for (const q of quizzes(c)) {
      const right = q.options[q.answer] ?? '';
      const others = q.options.filter((_, i) => i !== q.answer);
      const longest = Math.max(...others.map((x) => x.length));
      if (/^[^:]{1,12}: /.test(right) && !others.some((x) => /^[^:]{1,12}: /.test(x)) && right.length > 2 * longest + 8) bad.push(`${c.id}: ${q.question ?? ''} -> ${right}`);
    }
    expect(bad).toEqual([]);
  }, BOOK_TIMEOUT);
});
