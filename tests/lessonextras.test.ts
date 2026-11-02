// Lessons with figures and questions: every figure is a registered part, every question well formed and in the review queue.
import { describe, expect, it } from 'vitest';
import { LESSON_EXTRAS } from '../src/campaign/lessonextras';
import { NODES } from '../src/campaign/nodes';
import { resolveComponent } from '../src/lib/resolve';
import { allQuestions } from '../src/ui/reviewqs';

describe('lesson extras', () => {
  it('belong to lesson nodes, name real parts and ask well-formed questions', () => {
    const lessons = new Set(NODES.filter((n) => n.kind === 'lesson').map((n) => n.body));
    expect(Object.keys(LESSON_EXTRAS).length).toBeGreaterThanOrEqual(4);
    for (const [body, x] of Object.entries(LESSON_EXTRAS)) {
      expect(lessons.has(body), `${body}: a lesson node`).toBe(true);
      for (const f of x.figures) expect(resolveComponent(f.lib), `${body}: ${f.lib}`).toBeTruthy();
      expect(x.check.length).toBeGreaterThan(0);
      for (const q of x.check) {
        expect(q.answer).toBeLessThan(q.options.length);
        expect(q.why?.length).toBe(q.options.length);
      }
    }
  });
  it('the review queue asks them', () => {
    const keys = new Set(allQuestions().map((q) => q.key));
    for (const [body, x] of Object.entries(LESSON_EXTRAS)) x.check.forEach((_, k) => expect(keys.has(`lesson:${body}:${k}`)).toBe(true));
  });
});

describe('codex figures drawn from library parts', () => {
  it('the entries given a figure by M5 resolve their part', async () => {
    const { hasCodexFigure } = await import('../src/campaign/ui/codexfigs');
    const parts: Record<string, string> = { cpu: 'rv16_cpu', rv16: 'rv16_imm', dontcare: 'rv16_ctl', setuphold: 'dff', interrupts: 'rv16_csr', mext: 'rv16_mul', metastability: 'sr_latch', fpadder: 'fpadd5_10' };
    for (const [id, lib] of Object.entries(parts)) {
      expect(hasCodexFigure(id), id).toBe(true);
      expect(resolveComponent(lib), lib).toBeTruthy();
    }
    expect(hasCodexFigure('loader')).toBe(true);
  });
});
