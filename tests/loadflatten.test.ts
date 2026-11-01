import { describe, expect, it } from 'vitest';
import { registry } from '../src/lib';
import { estimateInstances, flatten, flattenAsync } from '../src/sim/flatten';
import { LOAD_PHASES, LoadPlan } from '../src/sim/loadplan';
import { nextTask } from '../src/sim/tasks';

const shape = (d: ReturnType<typeof flatten>) => ({
  nets: d.netCount,
  leaves: d.leaves.map((l) => [l.kind, l.def.id, l.node.path.join('.'), l.inputs.map((a) => a.join(',')).join(';'), l.outputs.map((a) => a.join(',')).join(';')].join('|')),
  hints: [...d.powerOn],
});

describe('flatten in slices', () => {
  for (const id of ['fa9', 'rca4', 'dff', 'alu32', 'ram_4x4']) {
    const def = registry.get(id);
    if (!def) continue;
    it(`${id}: the sliced result equals the synchronous one, progress is monotone`, async () => {
      const a = flatten(def);
      const seen: number[] = [];
      // slice 0: a pause after every child, so the generator really is driven
      const b = await flattenAsync(def, {}, (p) => seen.push(p.done), nextTask, 0);
      expect(shape(b)).toEqual(shape(a));
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    });
  }
  it('the instance estimate matches a default flatten', () => {
    const def = registry.get('alu32') ?? registry.get('rca4')!;
    const d = flatten(def);
    let n = 0;
    const count = (x: typeof d.root): void => { n++; x.children?.forEach(count); };
    count(d.root);
    expect(estimateInstances(def)).toBe(n);
  });
});

describe('LoadPlan', () => {
  it('weights finished phases and the running one by its count', () => {
    let t = 0;
    const p = new LoadPlan(LOAD_PHASES, () => t);
    p.completed('hierarchy', 100);
    expect(p.fraction).toBeCloseTo(4 / 100);
    t = 10; p.enter('flatten');
    p.report(300, 600);
    expect(p.fraction).toBeCloseTo((4 + 29) / 100);
    t = 1010; p.enter('engine');
    expect(p.phases[1].state).toBe('done');
    expect(p.phases[1].ms).toBe(1000);
    p.report(5, 1); // total never below done
    p.finish();
    expect(p.phases.at(-1)!.state).toBe('todo');
  });
  it('estimates the time left only once enough is done', () => {
    let t = 0;
    const p = new LoadPlan(LOAD_PHASES, () => t);
    p.enter('flatten');
    t = 1000; p.report(10, 600);
    expect(p.etaMs()).toBeNull();
    p.report(300, 600);
    expect(p.etaMs()!).toBeGreaterThan(0);
  });
});
