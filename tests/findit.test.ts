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
      expect(run(spec.healthy()).kind).toBe('clean');
      await tick();
      expect(run(scene.root).kind, 'the planted fault shows as a wrong value').toBe('wrong');

      // the accusation rule: each planted fault is right, its other value and a neighbouring bit are not
      for (const f of planted) {
        expect(accusedRight(planted, f.kind as 'stuck0' | 'stuck1', f.nets)).toBe(true);
        expect(accusedRight(planted, f.kind === 'stuck0' ? 'stuck1' : 'stuck0', f.nets)).toBe(false);
        expect(accusedRight(planted, f.kind as 'stuck0' | 'stuck1', f.nets.map((n) => n + 1))).toBe(false);
      }
    }, 60_000);
  }

  // what a wrong accusation's fault does, computed: the three outcomes on the steps' own CPUs
  const outcome = (id: string, fault: Parameters<typeof plantedFaults>[1]) => {
    const { spec } = findStep(id);
    const root = flatten(spec.healthy(), { mode: 'gate' }).root;
    const faults = plantedFaults(root, fault);
    expect(faults).toHaveLength(fault.length);
    const runWith = (ff: ReturnType<typeof plantedFaults>) =>
      firstWrong(plantedDef(spec.healthy(), (n) => (n.parent === null ? ff : []), 'accused'), spec.words, spec.iss, { inputs: spec.inputs, pipelined: spec.pipelined });
    return { would: runWith(faults), planted: runWith(plantedFaults(root, spec.planted)) };
  };

  it('a fault that first looks the same is said so (cpu: RegWrite stuck at 0)', () => {
    const { would, planted } = outcome('cpu', [{ kind: 'stuck0', end: 'ctl.regWrite' }]);
    expect(wouldText(would, planted)).toMatch(/exactly as this CPU does/);
  }, 30_000);

  it('a fault seen only in memory is caught at the end (cpu: MemWrite stuck at 0)', () => {
    const { would, planted } = outcome('cpu', [{ kind: 'stuck0', end: 'ctl.memWrite' }]);
    expect(would.kind).toBe('wrong');
    expect(would.text).toMatch(/word at address 0x0 differs at the end/);
    expect(wouldText(would, planted)).toMatch(/would first show otherwise/);
  }, 30_000);

  it('a CPU that stops finishing instructions is hung, not clean (cache: stall stuck at 1; pipeline: enFD, enPC stuck at 0)', async () => {
    const c = outcome('cache', [{ kind: 'stuck1', end: 'dm.stall' }]);
    expect(c.would.kind).toBe('hung');
    expect(wouldText(c.would, c.planted)).toMatch(/stop finishing instructions/);
    await tick();
    const p = outcome('pipeline', [{ kind: 'stuck0', end: 'hz.enFD' }, { kind: 'stuck0', end: 'hz.enPC' }]);
    expect(p.would.kind).toBe('hung');
  }, 60_000);
});
