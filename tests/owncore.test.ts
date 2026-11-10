// A program level run on the learner's own core (campaign/owncore.ts): every level's reference program agrees with every
// reference core that can run it; a single-cycle core takes one cycle an instruction; back-to-back reads of IN reach a
// pipeline in order; a faulty core disagrees where it goes wrong, naming the instruction; levels no core can run say why.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { solveChallenge, startChallenge } from '../src/editor/challenges';
import { emptyWorkspace } from '../src/editor/model';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { coreOptions, modelOnly, type OwnRun, registersAt, runOnCore } from '../src/campaign/owncore';
import { type ProgramPuzzle, PUZZLES } from '../src/campaign/puzzles';
import type { Workspace } from '../src/editor/model';
import { tick } from './yieldtick';

const solved = (ids: string[]): Workspace => ids.reduce((ws, id) => solveChallenge(ws, levelChallenge(nodeById(id)!)!).ws, emptyWorkspace());
const done = (r: OwnRun) => {
  if (r.kind !== 'done') throw new Error(r.kind === 'error' ? r.error : 'fails on the model');
  return r;
};

const SCALAR = ['c_core3', 'c_fast', 'o_mc', 'pi_core0', 'pi_core3', 'o_mcore', 'y_final'];
const ws = solved(SCALAR);

describe('a program level on your own core', () => {
  for (const [id, p] of Object.entries(PUZZLES)) {
    if (p.lanes || modelOnly(p)) continue;
    it(`${id}: the reference agrees on every reference core that can run it`, async () => {
      const fit = coreOptions(p, () => true).filter((o) => !o.why && SCALAR.includes(o.id));
      expect(fit.length, id).toBeGreaterThan(0);
      for (const o of fit) {
        const r = done(runOnCore(p, p.ref, o.id, ws));
        expect(r.tests.filter((t) => !t.ok).map((t) => `${o.id} ${t.name}: ${t.why?.got ?? t.text}`)).toEqual([]);
        expect(r.ok).toBe(true);
        // a single-cycle core: a cycle an instruction; any other at least that
        for (const t of r.tests) {
          if (o.id === 'c_core3') expect(t.cycles, t.name).toBe(t.steps);
          else expect(t.cycles, t.name).toBeGreaterThanOrEqual(t.steps);
        }
        await tick();
      }
    }, 120_000);
  }

  it('back-to-back reads of IN arrive in order on a pipeline and on a single-cycle core', () => {
    const p: ProgramPuzzle = {
      brief: '', starter: '', maxSteps: 200,
      ref: '        lw a0, -4(x0)\n        lw a1, -4(x0)\n        lw a2, -4(x0)\n        sub a0, a0, a1\n        sub a0, a0, a2\n        sw a0, -3(x0)\n        halt\n',
      tests: () => [{ name: 'three', input: [100, 7, 3], expect: { out: [90] } }, { name: 'more', input: [9, 1, 1, 5], expect: { out: [7] } }],
    };
    for (const core of ['c_core3', 'pi_core3', 'o_mc', 'y_final']) {
      const r = done(runOnCore(p, p.ref, core, ws));
      expect(r.ok, core).toBe(true);
    }
  });

  it('a program that fails on the model is not run on the core', () => {
    expect(runOnCore(PUZZLES.p_add, PUZZLES.p_add.starter, 'c_core3', ws).kind).toBe('model');
  });

  it('a faulty core disagrees at the instruction it gets wrong, and Step to it shows both register files', () => {
    const ch = levelChallenge(nodeById('b_jal')!)!;
    const bad = startChallenge(emptyWorkspace(), ch).ws;
    const p = PUZZLES.p_call;
    const r = done(runOnCore(p, p.ref, 'b_jal', bad));
    expect(r.ok).toBe(false);
    const i = r.tests.findIndex((t) => !t.ok);
    const t = r.tests[i];
    expect(t.why?.kind).toMatch(/reg|store|stuck|extra/);
    if (t.why?.kind === 'reg' || t.why?.kind === 'store') {
      expect(t.why.expected).not.toBe(t.why.got);
      const regs = registersAt(p, p.ref, i, t)!;
      expect(regs.model).toHaveLength(8);
      expect(regs.pc).toBe(t.why.pc);
      if (t.why.kind === 'reg') {
        // just after it: the register it wrote differs, and only that one
        expect(regs.after).toBe(true);
        const diff = regs.model.map((v, k) => (v !== regs.core[k] ? k : -1)).filter((k) => k >= 0);
        expect(diff).toEqual([t.why.wrote!.rd]);
      }
    }
  });

  it('greys out cores that cannot run a program, and says why a level runs on the model only', () => {
    const o = coreOptions(PUZZLES.p_loop, () => true);
    expect(o.find((x) => x.id === 'c_core1')?.why).toMatch(/loads or branches/);
    expect(o.find((x) => x.id === 'c_core3')?.why).toBeUndefined();
    expect(o.find((x) => x.id === 'k_simd')?.why).toMatch(/lane/);
    expect(coreOptions({ ...PUZZLES.p_add, m: true }, () => true).find((x) => x.id === 'c_core3')?.why).toMatch(/multiply/);
    expect(coreOptions(PUZZLES.p_loop, () => true).find((x) => x.id === 'pi_core0')?.why).toMatch(/loads or branches/);
    for (const id of ['p_handler', 'p_switch', 'p_boot', 'l_driver']) expect(modelOnly(PUZZLES[id]), id).toBeTruthy();
    expect(coreOptions(PUZZLES.p_saxpy, () => true).find((x) => x.id === 'k_simd')?.why).toBeUndefined();
    expect(coreOptions(PUZZLES.p_hist, () => true).find((x) => x.id === 'k_warps')?.why).toBeUndefined();
    expect(coreOptions(PUZZLES.p_spin, () => true).find((x) => x.id === 'k_warps')?.why).toMatch(/rasterizer/);
  });

  it('the lane and warp kernels agree on their reference cores', async () => {
    const lw = solved(['k_simd', 'k_simt', 'k_warps', 'k_frame']);
    for (const [id, core] of [['p_saxpy', 'k_simd'], ['p_reduce', 'k_simt'], ['p_hist', 'k_warps'], ['p_spin', 'k_frame']] as const) {
      const p = PUZZLES[id];
      const r = done(runOnCore(p, p.ref, core, lw));
      expect(r.tests.filter((t) => !t.ok).map((t) => `${t.name}: ${t.text}`), `${id} on ${core}`).toEqual([]);
      expect(r.cycles).toBeGreaterThan(0);
      await tick();
    }
  }, 300_000);
});

describe('own-core progress', () => {
  it('keeps the switch per level and the fewest cycles per core, through sanitize, merge and a backup', async () => {
    const { Progress, sanitizeCampaign, mergeCampaign } = await import('../src/campaign/progress');
    const kv = new Map<string, string>();
    const store = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) };
    const pr = new Progress(store);
    pr.setRunOn('p_loop', 'c_core3');
    expect(pr.coreRun('p_loop', 'c_core3', 330)).toBe(true);
    expect(pr.coreRun('p_loop', 'c_core3', 400)).toBe(false);
    expect(pr.coreRun('p_loop', 'c_core3', 300)).toBe(true);
    expect(new Progress(store).get('p_loop')).toMatchObject({ on: 'c_core3', cores: { c_core3: 300 } });
    pr.setRunOn('p_loop', undefined);
    expect(pr.get('p_loop')?.on).toBeUndefined();
    // only core levels, finite non-negative counts
    const s = sanitizeCampaign({ nodes: { p_add: { on: 'p_loop', cores: { c_core3: 5, p_loop: 3, pi_core3: -1, o_mc: 'x' } } } });
    expect(s.nodes.p_add.on).toBeUndefined();
    expect(s.nodes.p_add.cores).toEqual({ c_core3: 5 });
    const m = mergeCampaign(sanitizeCampaign({ nodes: { p_add: { on: 'c_core3', cores: { c_core3: 9, o_mc: 20 } } } }),
      sanitizeCampaign({ nodes: { p_add: { on: 'pi_core3', cores: { c_core3: 7, pi_core3: 11 } } } }));
    expect(m.nodes.p_add).toMatchObject({ on: 'pi_core3', cores: { c_core3: 7, o_mc: 20, pi_core3: 11 } });
  });
});
