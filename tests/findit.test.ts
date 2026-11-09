// The core CPU chapters' "find it" steps (widgets/findfault.ts): each plants a fault that resolves on the chapter's
// CPU, that the healthy CPU runs clean, that the planted one shows (riscv/firstwrong.ts, as the CPU panel sees it), and
// that only the planted nets and value count as found; a wrong accusation gets its own computed first wrong instruction.

import { describe, expect, it } from 'vitest';
import { chapterById } from '../src/chapters';
import { firstWrong } from '../src/riscv/firstwrong';
import { flatten } from '../src/sim/flatten';
import { plantedDef, plantedFaults } from '../src/sim/faults';
import { accusedRight, findSpecs, wouldText } from '../src/widgets/findfault';
import { tick } from './yieldtick';

const CHAPTERS = ['cpu', 'pipeline', 'multicycle', 'traps', 'cache'];

const findStep = (id: string) => {
  const ch = chapterById(id)!;
  const steps = ch.steps.filter((s) => s.challenge && findSpecs.has(s.challenge));
  expect(steps, id).toHaveLength(1);
  return { ch, step: steps[0], spec: findSpecs.get(steps[0].challenge!)! };
};

describe('find-it steps', () => {
  for (const id of CHAPTERS) {
    it(`${id}: the last step, deep, and its fault shows only where planted`, async () => {
      const { ch, step, spec } = findStep(id);
      expect(ch.steps[ch.steps.length - 1]).toBe(step);
      expect(step.deep).toBe(true);
      expect(step.challenge!.kind).toBe('reach');
      expect((step.challenge as { hints?: string[] }).hints?.length).toBeGreaterThanOrEqual(2);

      // the planted faults resolve on the healthy CPU's nets, every one of them
      const root = flatten(spec.healthy(), { mode: 'gate' }).root;
      const planted = plantedFaults(root, spec.planted);
      expect(planted).toHaveLength(spec.planted.length);

      // the scene's CPU carries them
      const scene = step.scene!();
      const sceneRoot = flatten(scene.root, { mode: 'gate' }).root;
      expect(plantedFaults(sceneRoot, spec.planted).map((f) => f.nets)).toEqual(planted.map((f) => f.nets));

      const run = (def: typeof scene.root) => firstWrong(def, spec.words, spec.iss, { inputs: spec.inputs, pipelined: spec.pipelined });
      expect(run(spec.healthy())).toBeNull();
      await tick();
      const shown = run(scene.root);
      expect(shown, 'the planted fault never shows').not.toBeNull();

      // the accusation rule: each planted fault is right, its other value and a neighbouring bit are not
      for (const f of planted) {
        expect(accusedRight(planted, f.kind as 'stuck0' | 'stuck1', f.nets)).toBe(true);
        expect(accusedRight(planted, f.kind === 'stuck0' ? 'stuck1' : 'stuck0', f.nets)).toBe(false);
        expect(accusedRight(planted, f.kind as 'stuck0' | 'stuck1', f.nets.map((n) => n + 1))).toBe(false);
      }
    }, 60_000);
  }

  it('a wrong accusation is answered with what that fault would do, computed', () => {
    const { spec } = findStep('cpu');
    const root = flatten(spec.healthy(), { mode: 'gate' }).root;
    const runWith = (faults: ReturnType<typeof plantedFaults>) =>
      firstWrong(plantedDef(spec.healthy(), (n) => (n.parent === null ? faults : []), 'accused'), spec.words, spec.iss, { inputs: spec.inputs });
    const planted = runWith(plantedFaults(root, spec.planted));
    expect(planted).not.toBeNull();
    // regWrite stuck at 0 first shows exactly as aluSrcB stuck at 0 does (t0 stays 0): said so, not called different
    const regWrite = plantedFaults(root, [{ kind: 'stuck0', end: 'ctl.regWrite' }]);
    expect(regWrite).toHaveLength(1);
    expect(wouldText(runWith(regWrite), planted)).toMatch(/exactly as this CPU does/);
    // memWrite stuck at 1 shows otherwise
    const memWrite = plantedFaults(root, [{ kind: 'stuck1', end: 'ctl.memWrite' }]);
    expect(memWrite).toHaveLength(1);
    expect(wouldText(runWith(memWrite), planted)).toMatch(/would first show otherwise|run right to the end/);
    expect(wouldText(null, planted)).toMatch(/run right to the end/);
  }, 30_000);
});
