// "Open on a bench" for a program level (campaign/owncore.ts ownBench): every scalar level's reference program, test by
// test, on the debug bench around the reference single-cycle, multicycle and pipelined cores, runs to its halt in lock
// step with the CPU panel's golden model (editor/cpu16.ts): IN served from the bench's ROM of the test's words as the
// model reads them, data in the 512-word RAM. A core that cannot branch disagrees.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { solveChallenge } from '../src/editor/challenges';
import { emptyWorkspace, type Workspace } from '../src/editor/model';
import { UserLibrary } from '../src/editor/library';
import { EditorSim } from '../src/editor/runtime';
import { detectRv16, Rv16Monitor } from '../src/editor/cpu16';
import { resolveCpu } from '../src/editor/cpu';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { benchRefusal, coreOptions, modelOnly, ownBench, ownTests } from '../src/campaign/owncore';
import { PUZZLES } from '../src/campaign/puzzles';
import { tick } from './yieldtick';

const CORES = ['c_core3', 'o_mc', 'pi_core3'];
const solved = (ids: string[]): Workspace => ids.reduce((ws, id) => solveChallenge(ws, levelChallenge(nodeById(id)!)!).ws, emptyWorkspace());

function onBench(ws: Workspace, core: string, test: Parameters<typeof ownBench>[2], mode: 'cycle' | 'gate' = 'cycle') {
  const b = ownBench(ws, core, test);
  if ('error' in b) throw new Error(b.error);
  const doc = b.ws.chips[b.id];
  // the CPU drawer takes it for an RV16 computer (not an RV32 one), with the IN device
  expect(resolveCpu(doc, b.ws.chips)).toBeNull();
  expect(detectRv16(doc, b.ws.chips)?.input?.words ?? []).toEqual((test.input ?? []).map((v) => v & 0xffff));
  const es = new EditorSim({ debounceMs: 0 });
  es.update(new UserLibrary(b.ws).compiled(b.id)!, doc.pins);
  if (mode === 'gate') es.setMode('gate');
  const m = new Rv16Monitor(es, () => doc, () => b.ws.chips);
  m.runToHalt(Infinity, 30000);
  return { m, doc };
}

describe('a program level on the bench around your core', { timeout: 600000 }, () => {
  const ws = solved([...CORES, 'c_core1']);
  for (const [id, p] of Object.entries(PUZZLES)) {
    if (p.lanes || p.nic || modelOnly(p)) continue;
    it(`${id}: every test runs to its halt with the golden model on each reference core`, async () => {
      const tests = ownTests(p, p.ref);
      if ('error' in tests) throw new Error(tests.error);
      const cores = coreOptions(p, () => true).filter((o) => !o.why && CORES.includes(o.id)).map((o) => o.id);
      expect(cores.length).toBeGreaterThan(0);
      for (const core of cores) for (const t of tests) {
        expect(benchRefusal(t), t.name).toBeNull();
        const { m, doc } = onBench(ws, core, t);
        if (t.input?.length) expect(m.desc?.input?.words, t.name).toEqual(t.input.map((v) => v & 0xffff));
        expect(doc.parts.some((q) => q.id === 'inidx')).toBe(!!t.input?.length);
        expect(m.mismatch, `${core} ${t.name}: ${m.mismatch?.detail}`).toBeNull();
        expect(m.iss!.halted, `${core} ${t.name}`).toBe(true);
        expect(m.done, `${core} ${t.name}`).toBe(true);
        expect(m.iss!.input.length, `${core} ${t.name}: IN words left`).toBe(0);
        await tick();
      }
    });
  }

  it('in gate-delay mode too (GateSim: the bank is poked and settled after each edge), and the RAM is 64 gate-level words unless the data needs 512', () => {
    const p = PUZZLES.p_add;
    const tests = ownTests(p, p.ref);
    if ('error' in tests) throw new Error(tests.error);
    for (const core of ['pi_core3', 'c_core3']) {
      const { m, doc } = onBench(ws, core, tests[0], 'gate');
      expect(m.mismatch, `${core}: ${m.mismatch?.detail}`).toBeNull();
      expect(m.done).toBe(true);
      expect(doc.parts.find((q) => q.id === 'mem')?.ref).toMatchObject({ ram: { k: 6 } });
    }
    const sort = ownTests(PUZZLES.p_sort, PUZZLES.p_sort.ref);
    if ('error' in sort) throw new Error(sort.error);
    expect(onBench(ws, 'c_core3', sort[0]).doc.parts.find((q) => q.id === 'mem')?.ref).toMatchObject({ ram: { k: 9 } });
  });

  it('a core without branches disagrees on a program that loops', () => {
    const p = PUZZLES.p_loop;
    const tests = ownTests(p, p.ref);
    if ('error' in tests) throw new Error(tests.error);
    const t = tests.find((x) => (x.input?.[0] ?? 0) > 1)!;
    const { m } = onBench(ws, 'c_core1', t);
    expect(m.mismatch).not.toBeNull();
  });
});
