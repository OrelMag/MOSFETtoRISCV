// Print a chapter's plan: which steps give a figure, a note or a link, the numbering, the size limits.
// Over every chapter, so none throws and no huge design is ever picked for a simulated figure.

import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { classify, figureNo, planChapter, truthEligible, truthTable } from '../src/chapters/printplan';
import { chapterById } from '../src/chapters';
import { resolveComponent } from '../src/lib/resolve';
import { tick } from './yieldtick';
import { MODELS_3D } from '../src/widgets/models3dindex';

describe('print plan', () => {
  it('figure numbers carry the chapter number the way the chapter shows it', () => {
    expect(figureNo({ num: 4 }, 3)).toBe('4.3');
    expect(figureNo({ num: 12 }, 1)).toBe('12.1');
    expect(figureNo({ num: 0, prologue: 'P1' }, 2)).toBe('P1.2');
    expect(figureNo({ num: 30, appendix: 'A' }, 1)).toBe('A.1');
    expect(figureNo({ num: 0, label: 'Start' }, 2)).toBe('2');
  });

  it('plans every chapter: numbered figures in order, one question number each, no throw', async () => {
    for (const c of chapters) {
      const plan = planChapter(c);
      expect(plan.steps.length, c.id).toBe(c.steps.length);
      // every figure in reading order: a step's scene, then its 3D models
      const figs = plan.steps.flatMap((s) => [...(s.figure !== undefined ? [s.figure] : []), ...s.models.map((m) => m.figure)]);
      expect(figs, c.id).toEqual(figs.map((_, i) => i + 1));
      expect(plan.figures, c.id).toBe(figs.length);
      for (const s of plan.steps) {
        const st = c.steps[s.step];
        if (s.mode === 'sim' || s.mode === 'top') expect(s.scene && st.scene, `${c.id} ${s.step}`).toBeTruthy();
        if (s.mode === 'live') expect(st.widget && !st.scene && !s.models.length, `${c.id} ${s.step}`).toBeTruthy();
        if (s.mode === 'model') expect(st.widget && !st.scene && s.models.length, `${c.id} ${s.step}`).toBeTruthy();
        for (const m of s.models) expect(m.label, `${c.id} ${s.step}`).toBe(`Figure ${figureNo(c, m.figure)}`);
        if (s.mode === 'none') expect(st.scene || st.widget, `${c.id} ${s.step}`).toBeFalsy();
        if (s.mode === 'link') expect(s.reason, `${c.id} ${s.step}`).toBeTruthy();
        if (s.truth) expect(s.mode, `${c.id} ${s.step}`).toBe('sim');
      }
      expect(plan.questions.map((q) => q.n), c.id).toEqual(plan.questions.map((_, i) => i + 1));
      await tick();
    }
  });

  it('every 3D model is planned as a figure, at the step that mounts it', () => {
    for (const m of MODELS_3D) {
      const plan = planChapter(chapterById(m.chapter)!);
      expect(plan.steps[m.step].models.map((x) => x.id), m.id).toContain(m.id);
    }
    // the ENIAC decade ring is chapter P2's eighth step, and the chapter's only figure there
    const tubes = planChapter(chapterById('tubes')!);
    expect(tubes.steps[7].mode).toBe('model');
    expect(tubes.steps[7].models[0].id).toBe('eniac');
  });

  it('big designs are never simulated for a figure; small ones are', () => {
    const modes = (id: string) => planChapter(chapterById(id)!).steps.map((s) => s.mode);
    // the transistor-level 6502 and Doom's computer are links; the gates chapter is all figures
    expect(modes('appendix-6502').filter((m) => m === 'link').length).toBeGreaterThan(0);
    expect(modes('appendix-doom')).toContain('link');
    expect(modes('gates').filter((m) => m === 'sim').length).toBeGreaterThan(3);
    // the CPU chapter draws its single-cycle CPU at the top level only; the cycle-engine GPU chapters never simulate
    expect(modes('cpu')).toContain('top');
    expect(modes('cpu')).not.toContain('link');
    for (const id of ['simt', 'warps', 'lanes', 'appendix-runner']) expect(modes(id), id).not.toContain('sim');
  });

  it('a step with a quiz or a recap question is counted once, a reach challenge is listed for a link', () => {
    const c = chapterById('gates')!;
    const plan = planChapter(c);
    const nq = c.steps.filter((s) => s.challenge?.kind === 'quiz').length + c.steps.reduce((a, s) => a + (s.reading?.quizzes.length ?? 0), 0) + (c.recap?.check?.length ?? 0);
    expect(plan.questions.length).toBe(nq);
    expect(plan.challenges.length).toBe(c.steps.filter((s) => s.challenge?.kind === 'reach').length);
  });

  it('a truth table for a small combinational scene, from its structure', () => {
    const nand = resolveComponent('nand')!;
    expect(truthEligible(nand)).toBe(true);
    const t = truthTable(nand);
    expect(t.head.length).toBe(3);
    expect(t.rows.map((r) => r.join(''))).toEqual(['001', '011', '101', '110']);
    // sequential parts have none
    expect(truthEligible(resolveComponent('dff')!)).toBe(false);
  });

  it('classify keeps a cycle-engine scene off the simulator whatever its size', () => {
    const cpu = planChapter(chapterById('cpu')!);
    const scene = cpu.steps.find((s) => s.scene)!.scene!;
    expect(classify({ ...scene, engine: 'cycle' }).mode).not.toBe('sim');
    expect(classify({ ...scene, engine: 'nmos' }).mode).toBe('link');
  });
});
