import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { stageStepOf } from '../src/ui/stageborrow';

describe('a step without a stage', () => {
  const has = (k: number) => [2, 5].includes(k);
  it('borrows the nearest earlier step, never a later one', () => {
    expect([0, 1].map((i) => stageStepOf(has, i))).toEqual([-1, -1]);
    expect([2, 3, 4, 5, 6].map((i) => stageStepOf(has, i))).toEqual([2, 2, 2, 5, 5]);
  });
  it('every chapter: a step shows its own or an earlier stage', () => {
    for (const c of chapters) {
      const h = (k: number) => !!(c.steps[k].scene || c.steps[k].widget);
      c.steps.forEach((_, i) => { const k = stageStepOf(h, i); expect(k <= i, `${c.id}/${i}`).toBe(true); if (k >= 0) expect(h(k)).toBe(true); });
    }
  });
});
