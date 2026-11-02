// The tier capstones: each reference passes its own check (with its parts allowed), a broken variant fails, and a
// capstone keeps its answer shut until it is passed.

import { describe, expect, it } from 'vitest';
import { accNext, accumulatorDef, builtCapstones, capstoneChallenge, capstoneRule, referenceScore, solutionsOpen } from '../src/campaign/capstone';
import { coreSpecOf, runCore } from '../src/campaign/corecheck';
import { progress as getProgress } from '../src/campaign/progress';
import { type BuildChallenge, checkChallenge } from '../src/editor/challenges';
import { checkSimulatable } from '../src/editor/compile';
import { docFromDef } from '../src/editor/fromdef';
import { UserLibrary } from '../src/editor/library';
import { deadParts, openInputs } from '../src/editor/lint';
import { CAPSTONES, capstoneStatus } from '../src/learn/capstones';
import { rv16Core } from '../src/lib/rv16/cpu';
import '../src/lib';
import { workspace } from './editorkit';

function checkReference(ch: BuildChallenge) {
  const chips = ch.answer();
  const main = chips[chips.length - 1];
  const lib = new UserLibrary(workspace(main, ...chips.slice(0, -1)));
  for (const d of chips) {
    expect(lib.compiled(d.id)!.diags, d.id).toEqual([]);
    expect(checkSimulatable(lib.compiled(d.id)!), d.id).toEqual([]);
    expect(deadParts(d, lib.compiled(d.id)!), d.id).toEqual([]);
    expect(openInputs(lib.compiled(d.id)!), d.id).toEqual([]);
  }
  return checkChallenge(ch, lib.compiled(main.id));
}

describe('the capstone set', () => {
  it('tiers 1–3 are built, tier 4 has no checker', () => {
    expect(builtCapstones().map((c) => c.id)).toEqual(['cap_t1', 'cap_t2', 'cap_t3']);
    expect(capstoneChallenge('cap_t4')).toBeUndefined();
    expect(CAPSTONES.find((c) => c.id === 'cap_t4')!.route).toBeNull();
    for (const c of builtCapstones()) expect(c.route, c.id).toBe(`#/campaign/play/${c.id}`);
  });

  it('no capstone allows the finished block it is about', () => {
    expect(capstoneRule('cap_t2')!.lib).not.toContain('rv16_cpu');
    expect(capstoneRule('cap_t3')!.lib).not.toContain('rv16_cpu');
    expect(capstoneRule('cap_t1')!.lib).not.toContain('rv16_reg4');
    expect(capstoneRule('cap_t1')!.lib).toContain('full_adder');
  });

  it('the answer opens only after a pass (a record under the capstone id survives the campaign sanitizer)', () => {
    expect(solutionsOpen('cap_t2', {})).toBe(false);
    expect(solutionsOpen('cap_t2', { cap_t2: { status: 'started' } })).toBe(false);
    expect(solutionsOpen('cap_t2', { cap_t2: { status: 'solved' } })).toBe(true);
    expect(capstoneStatus('cap_t2', { cap_t2: { status: 'solved' } })).toBe('passed');
    const p = getProgress();
    p.reset();
    p.open('cap_t1', true);
    expect(p.get('cap_t1')?.status).toBe('started');
    const first = p.solveCapstone('cap_t1', { nand: 108, period: 20 });
    expect(first).toEqual({ first: true, best: true });
    expect(p.solveCapstone('cap_t1', { nand: 120, period: 20 })).toEqual({ first: false, best: false });
    expect(p.solveCapstone('cap_t1', { nand: 100, period: 20 })).toEqual({ first: false, best: true });
    expect(p.get('cap_t1')).toMatchObject({ status: 'solved', best: { nand: 100 } });
    p.reset();
  });
});

describe('tier 1: an adding machine', () => {
  it('the model is the spec', () => {
    expect(accNext({ acc: 9, c: 0 }, 9, 1, 0)).toEqual({ acc: 2, c: 1 });
    expect(accNext({ acc: 9, c: 1 }, 9, 0, 0)).toEqual({ acc: 9, c: 1 });
    expect(accNext({ acc: 9, c: 1 }, 9, 1, 1)).toEqual({ acc: 0, c: 0 });
  });

  it('the reference passes its check with its parts allowed', () => {
    const r = checkReference(capstoneChallenge('cap_t1')!);
    expect(r.failures).toEqual([]);
    expect(r.restrictionViolations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tested).toBeGreaterThan(50);
    expect(r.score.nand).toBeGreaterThan(50);
    expect(referenceScore('cap_t1')).toMatchObject({ ok: true, nand: r.score.nand });
  });

  it('an accumulator whose reset is wired wrong fails, naming a step', () => {
    const ch = capstoneChallenge('cap_t1')!;
    const doc = docFromDef(accumulatorDef(true), { id: 'u_ch_cap_t1', name: 'broken' });
    if ('error' in doc) throw new Error(doc.error);
    const r = checkChallenge(ch, new UserLibrary(workspace(doc)).compiled(doc.id));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/step|expected/i);
  });

  it('a part outside the rule is refused (the finished 4-bit register)', () => {
    expect(capstoneRule('cap_t1')!.lib).not.toContain('rv16_reg4');
  });
});

describe('tier 2: an RV16 core from its spec', { timeout: 300000 }, () => {
  it('the reference core passes the programs and Pong, scored in NANDs, period and cycles', () => {
    const ch = capstoneChallenge('cap_t2')!;
    const r = checkReference(ch);
    expect(r.failures).toEqual([]);
    expect(r.restrictionViolations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.score.period).toBeGreaterThan(60);
    expect(r.score.cycles).toBeGreaterThan(4000);
    console.log('cap_t2', r.score, r.tested);
  });

  it('a core without branch hardware fails', () => {
    const ch = capstoneChallenge('cap_t2')!;
    const spec = coreSpecOf(ch.check)!;
    const r = runCore(rv16Core(false), 'gate', spec);
    expect(r.failures.length).toBeGreaterThan(0);
  });
});

describe('tier 3: a pipelined core', { timeout: 300000 }, () => {
  it('the pipeline passes, and the single-cycle core is turned away for its period', () => {
    const ch = capstoneChallenge('cap_t3')!;
    const r = checkReference(ch);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    console.log('cap_t3', r.score, r.tested);
    const doc = docFromDef(rv16Core(true), { id: 'u_ch_cap_t3', name: 'single cycle' });
    if ('error' in doc) throw new Error(doc.error);
    const bad = checkChallenge(ch, new UserLibrary(workspace(doc)).compiled(doc.id));
    expect(bad.ok).toBe(false);
    expect(bad.failures.join('\n')).toMatch(/pipeline registers/);
  });
});
