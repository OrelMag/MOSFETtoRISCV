import { describe, expect, it } from 'vitest';
import { alu } from '../src/lib/alu';
import { rca } from '../src/lib/combinational';
import { singleCycleCpu } from '../src/lib/cpu';
import { DRAM4X4 } from '../src/lib/dram';
import { assemble } from '../src/riscv/asm';
import { estimateInstances, flatten, flattenAsync, type FlatDesign, type FlattenOptions } from '../src/sim/flatten';
import { LOAD_PHASES, LoadPlan } from '../src/sim/loadplan';
import { nextTask } from '../src/sim/tasks';
import type { ComponentDef } from '../src/sim/types';

const names = (a: Record<string, number[]> | undefined) => (a ? Object.entries(a).map(([k, v]) => `${k}=${v.join(',')}`).join(';') : '');

/** Everything a view or a simulator reads from a flat design, as comparable text. */
function shape(d: FlatDesign) {
  const nodes: string[] = [];
  const walk = (n: FlatDesign['root'], path: string): void => {
    nodes.push([path, n.def.id, n.expanded, names(n.ports), (n.nets ?? []).map((x) => x.join(',')).join('|'), n.leafIndex ?? ''].join('#'));
    n.children?.forEach((c, k) => walk(c, `${path}/${k}`));
  };
  walk(d.root, '');
  return {
    nets: d.netCount,
    nodes,
    leaves: d.leaves.map((l) => [l.kind, l.def.id, l.node.path.join('.'), l.inputs.map((a) => a.join(',')).join(';'), l.outputs.map((a) => a.join(',')).join(';'), l.terminals?.join(',') ?? ''].join('|')),
    powerOn: [...d.powerOn],
    caps: [...d.caps].sort((a, b) => a - b),
    capWeight: [...(d.capWeight ?? [])].sort((a, b) => a[0] - b[0]),
    leaks: [...(d.leaks ?? [])].sort((a, b) => a[0] - b[0]),
  };
}

// the stage's own expansion rule (Stage.flattenOptions)
const stageExpand: FlattenOptions['expand'] = (d, n) => n.parent === null || !d.preferBehavior;
const prog = assemble('addi x1, x0, 5\nloop: addi x1, x1, -1\nbne x1, x0, loop\nj .').words;

const cases: [string, ComponentDef, FlattenOptions][] = [
  ['rca(8)', rca(8), {}],
  ['alu(32)', alu(32), {}],
  ['the single-cycle CPU (deeper than the pause depth, behaviour leaves)', singleCycleCpu(prog), { expand: stageExpand }],
  ['a DRAM array at switch level (caps, leaks, power-on)', DRAM4X4, { mode: 'switch' }],
];

describe('flatten in slices', () => {
  for (const [name, def, opts] of cases) {
    it(`${name}: the sliced design equals the synchronous one, progress is monotone`, async () => {
      const a = flatten(def, opts);
      const seen: number[] = [];
      // slice 0: a pause after every child, so the generator really is driven
      const b = await flattenAsync(def, opts, (p) => seen.push(p.done), nextTask, 0);
      expect(seen.length).toBeGreaterThan(10);
      expect(shape(b)).toEqual(shape(a));
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }, 60_000);
  }

  it('the switch-level case really has caps and leaks to compare', () => {
    const d = flatten(DRAM4X4, { mode: 'switch' });
    expect(d.caps.size).toBeGreaterThan(0);
    expect(d.leaks?.size ?? 0).toBeGreaterThan(0);
  });

  it('the instance estimate equals the visited count (default expansion)', () => {
    for (const def of [rca(8), alu(32)]) {
      const d = flatten(def);
      let n = 0;
      const count = (x: FlatDesign['root']): void => { n++; x.children?.forEach(count); };
      count(d.root);
      expect(estimateInstances(def)).toBe(n);
    }
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
