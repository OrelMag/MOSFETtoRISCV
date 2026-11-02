// Tier 4's design brief: the references are measured and pinned, a broken core fails, and the grades follow the front.

import { describe, expect, it } from 'vitest';
import { BRIEF_REFS, briefFront, briefRefs, briefSpec, briefStars, measureCore, timeOf } from '../src/campaign/brief';
import { capstoneChallenge, capstoneRank, capstoneRule } from '../src/campaign/capstone';
import { runCore } from '../src/campaign/corecheck';
import { MAX_SUBMISSIONS, Progress, sanitizeCampaign } from '../src/campaign/progress';
import { checkChallenge } from '../src/editor/challenges';
import type { KV } from '../src/editor/store';
import { docFromDef } from '../src/editor/fromdef';
import { UserLibrary } from '../src/editor/library';
import { rv16Core } from '../src/lib/rv16/cpu';
import '../src/lib';
import { niceAxis } from '../src/ui/pages/briefview';
import { workspace } from './editorkit';

describe('the design brief', { timeout: 300000 }, () => {
  it('the checked-in reference numbers equal a fresh measurement', () => {
    for (const r of BRIEF_REFS) {
      const m = measureCore(r.def());
      expect(m, r.id).not.toBeNull();
      const pinned = briefRefs().find((x) => x.id === r.id)!;
      expect({ nand: pinned.nand, period: pinned.period, cycles: pinned.cycles }, r.id).toEqual(m);
    }
  });

  it('the challenge counts the same NANDs as the direct measurement, and its reference passes', () => {
    const ch = capstoneChallenge('cap_t4')!;
    expect(ch).toBeDefined();
    const chips = ch.answer();
    const r = checkChallenge(ch, new UserLibrary(workspace(chips[chips.length - 1], ...chips.slice(0, -1))).compiled(chips[chips.length - 1].id));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    const single = briefRefs().find((x) => x.id === 'single')!;
    expect(r.score.nand).toBe(single.nand);
    expect(r.score.period).toBe(single.period);
    expect(r.score.cycles).toBe(single.cycles);
    expect(capstoneRule('cap_t4')!.lib).not.toContain('rv16_cpu');
  });

  it('a core without branch hardware fails the workload', () => {
    const r = runCore(rv16Core(false), 'gate', briefSpec());
    expect(r.failures.length).toBeGreaterThan(0);
    const doc = docFromDef(rv16Core(false), { id: 'u_ch_cap_t4', name: 'no branches' });
    if ('error' in doc) throw new Error(doc.error);
    const bad = checkChallenge(capstoneChallenge('cap_t4')!, new UserLibrary(workspace(doc)).compiled(doc.id));
    expect(bad.ok).toBe(false);
  });

  it('every reference passes its own workload and the three differ', () => {
    const refs = briefRefs();
    expect(refs).toHaveLength(3);
    expect(new Set(refs.map((r) => r.nand)).size).toBe(3);
    for (const r of refs) expect(r.time).toBe(timeOf(r));
  });

  it('is graded on the front: a reference is a star, cheaper and faster than one is three, between is two', () => {
    const refs = briefRefs();
    const single = refs.find((r) => r.id === 'single')!, pipe = refs.find((r) => r.id === 'pipe')!, multi = refs.find((r) => r.id === 'multi')!;
    const as = (r: { nand: number; period: number; cycles: number }) => ({ nand: r.nand, period: r.period, cycles: r.cycles });
    expect(briefStars(as(single), refs)).toBe(1);
    expect(briefStars(as(pipe), refs)).toBe(1);
    expect(briefStars({ nand: single.nand + 100, period: single.period, cycles: single.cycles }, refs)).toBe(1);
    // between single and multi in cost and faster than single: on the front, and cheaper and faster than the multicycle core
    expect(briefStars({ nand: 5000, period: 100, cycles: 1000 }, refs)).toBe(3);
    // a dearer, slower design than the multicycle core's is turned back to one star
    expect(briefStars({ nand: multi.nand + 1, period: multi.period, cycles: multi.cycles + 1 }, refs)).toBe(1);
    // cheaper than every reference but slower than all: nobody dominates it, and it beats none on both
    const slow = { nand: Math.min(...refs.map((r) => r.nand)) - 1, period: 1000, cycles: 10000 };
    expect(briefStars(slow, refs)).toBe(2);
    // between single and pipe in cost, faster than both: cheaper and faster than the pipelined core
    expect(briefStars({ nand: (single.nand + pipe.nand) / 2, period: 1, cycles: 1000 }, refs)).toBe(3);
    // faster than every reference but dearer than all of them: on the front, beats none on both
    expect(briefStars({ nand: Math.max(...refs.map((r) => r.nand)) + 1, period: 1, cycles: 1 }, refs)).toBe(2);
  });

  it('the front leaves out a reference another one dominates', () => {
    const pts = [{ nand: 10, time: 100 }, { nand: 20, time: 50 }, { nand: 25, time: 120 }];
    expect(briefFront(pts)).toEqual([pts[0], pts[1]]);
  });

  it('ranks a pass by total time, then NANDs', () => {
    expect(capstoneRank('cap_t4')({ nand: 5000, period: 80, cycles: 1500 })).toEqual([120000, 5000]);
  });

  it('keeps the last submissions, newest first, through the sanitizer', () => {
    const kv = new Map<string, string>();
    const store: KV = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) };
    const p = new Progress(store);
    for (let i = 0; i < MAX_SUBMISSIONS + 3; i++) p.addSubmission('cap_t4', { nand: 5000 + i, period: 80, cycles: 1500, stars: i % 3 === 0 ? 2 : 1 });
    const subs = new Progress(store).get('cap_t4')!.subs!;
    expect(subs).toHaveLength(MAX_SUBMISSIONS);
    expect(subs[0].nand).toBe(5000 + MAX_SUBMISSIONS + 2);
    expect(new Progress(store).get('cap_t4')!.stars).toBe(2);
    const bad = sanitizeCampaign({ nodes: { cap_t4: { subs: [{ nand: -1, period: 1, cycles: 1, stars: 2, at: 1 }, { nand: 1, period: 1, cycles: 1, stars: 5, at: 1 }, 7] }, cap_t1: { subs: [{ nand: 1, period: 1, cycles: 1, stars: 1, at: 1 }] } } });
    expect(bad.nodes.cap_t4.subs).toBeUndefined();
    expect(bad.nodes.cap_t1.subs).toBeDefined();
  });

  it('chart axes round up to 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceAxis(121128)).toEqual({ max: 150000, step: 50000 });
    expect(niceAxis(9218)).toEqual({ max: 10000, step: 2500 });
  });
});
