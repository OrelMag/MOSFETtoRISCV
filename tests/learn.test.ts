// My path's model: the skill map points at real steps, questions and levels; mastery follows its rules; the learn store
// survives junk and merges; placement and test-out draw real questions; the next step starts at Basics.

import { beforeAll, describe, expect, it } from 'vitest';
import { checkOf } from '../src/campaign/codexmore';
import { DRILL_REVIEW, REVIEW_BANK } from '../src/learn/bank';
import { nodeById } from '../src/campaign/nodes';
import { chapters } from '../src/chapters';
import { skillState, type Evidence } from '../src/learn/mastery';
import { fmtMinutes, nextUp, tierViews, type PathCtx } from '../src/learn/path';
import { PLACEMENT, placementItems, suggestTier, TEST_DRILL, testOutItems } from '../src/learn/placement';
import { skills, tierChapters, TIERS, type Skill } from '../src/learn/skills';
import { emptyLearn, Learn, LEARN_KEY, mergeLearn, sanitizeLearn } from '../src/learn/store';
import type { Memo } from '../src/ui/review';
import { BOOK_TIMEOUT, warmBook, WARM_TIMEOUT } from './warmbook';

const byId = new Map(chapters.map((c) => [c.id, c]));

describe('skill map', () => {
  it('every skill points at real steps, questions and levels, in a journey chapter of its tier', () => {
    const bad: string[] = [];
    for (const s of skills()) {
      const c = byId.get(s.chapter);
      if (!c || c.prologue || c.appendix) { bad.push(`${s.id}: ${s.chapter}`); continue; }
      if (!tierChapters(s.tier).includes(c)) bad.push(`${s.id}: tier ${s.tier} but ${c.id}`);
      for (const i of s.steps) if (!c.steps[i]) bad.push(`${s.id}: step ${i}`);
      if (!s.checks.length) bad.push(`${s.id}: no question, so it can never be remembered`);
      for (const k of s.checks) {
        const [a, b, d] = k.split(':');
        const ok = a === 'drill' ? !!DRILL_REVIEW.find((x) => x.drill === b) : a === 'predict' || a === 'ablate' ? REVIEW_BANK.some((q) => q.key === k) : a === 'codex' ? !!checkOf(b)?.[+d] : b === 'recap' ? !!byId.get(a)?.recap?.check?.[+d] : byId.get(a)?.steps[+b]?.challenge?.kind === 'quiz';
        if (!ok) bad.push(`${s.id}: ${k}`);
      }
      for (const id of s.levels) if (!nodeById(id)) bad.push(`${s.id}: level ${id}`);
    }
    expect(bad).toEqual([]);
  });

  it('every tier has skills, and every required level practises one', () => {
    for (const t of TIERS) expect(skills().filter((s) => s.tier === t.tier).length, `tier ${t.tier}`).toBeGreaterThan(0);
    expect(new Set(skills().map((s) => s.id)).size).toBe(skills().length);
  });
});

const memo = (o: Partial<Memo>): Memo => ({ n: 1, last: 0, streak: 1, due: 1e15, ...o });
const sk: Skill = { id: 'x', title: 'X', tier: 1, chapter: 'adders', steps: [2], checks: ['codex:x:0', 'adders:4'], reach: [], levels: ['lv'] };
function ev(o: Partial<Evidence> = {}): Evidence {
  return { now: 1000, visited: () => [], solved: () => false, memo: () => undefined, levelSolved: () => false, testedOut: () => false, ...o };
}

describe('mastery', () => {
  it('new, then learning once a step is seen', () => {
    expect(skillState(sk, ev())).toBe('new');
    expect(skillState(sk, ev({ visited: () => [2] }))).toBe('learning');
    expect(skillState(sk, ev({ visited: () => [3] }))).toBe('new');
  });
  it('practised needs a question right and its level built; a test-out also counts', () => {
    expect(skillState(sk, ev({ memo: (k) => (k === 'codex:x:0' ? memo({}) : undefined) }))).toBe('learning');
    expect(skillState(sk, ev({ memo: () => memo({}), levelSolved: () => true }))).toBe('practised');
    expect(skillState(sk, ev({ solved: (k) => k === 'adders:4', levelSolved: () => true }))).toBe('practised');
    expect(skillState(sk, ev({ testedOut: (c) => c === 'adders' }))).toBe('practised');
  });
  it('mastered needs a streak of two, and turns rusty when a question is due', () => {
    const two = memo({ streak: 2, due: 5000 });
    expect(skillState(sk, ev({ memo: () => two, levelSolved: () => true }))).toBe('mastered');
    expect(skillState(sk, ev({ memo: () => two, levelSolved: () => true, now: 6000 }))).toBe('rusty');
    expect(skillState(sk, ev({ memo: () => memo({ streak: 2, miss: true }), levelSolved: () => true }))).not.toBe('mastered');
    // a test-out never makes it mastered
    expect(skillState(sk, ev({ testedOut: () => true, memo: () => memo({ streak: 1 }) }))).toBe('practised');
  });
  it('a skill with nothing to build is built by default', () => {
    expect(skillState({ ...sk, levels: [], reach: [] }, ev({ memo: () => memo({}) }))).toBe('practised');
  });
});

describe('learn store', () => {
  it('keeps only what is well formed', () => {
    expect(sanitizeLearn(null)).toEqual(emptyLearn());
    const s = sanitizeLearn({ start: { persona: 'software', tier: 1, at: 5 }, tested: { adders: 7, 'bad key!': 1, x: -1 }, placement: { at: 1, right: 9, total: 3, tier: 1 } });
    expect(s.start).toEqual({ persona: 'software', tier: 1, at: 5 });
    expect(s.tested).toEqual({ adders: 7 });
    expect(s.placement).toBeUndefined();
    expect(sanitizeLearn({ start: { persona: 'wizard', tier: 1, at: 5 } }).start).toBeUndefined();
  });
  it('merges: every test-out, the later start', () => {
    const a = { ...emptyLearn(), start: { persona: 'new' as const, tier: 0, at: 1 }, tested: { adders: 5 } };
    const b = { ...emptyLearn(), start: { persona: 'logic' as const, tier: 2, at: 9 }, tested: { adders: 3, gates: 4 } };
    const m = mergeLearn(a, b);
    expect(m.start?.persona).toBe('logic');
    expect(m.tested).toEqual({ adders: 3, gates: 4 });
  });
  it('saves to its key', () => {
    const map = new Map<string, string>();
    const kv = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const l = new Learn(kv);
    l.setStart('hardware', 3, 10);
    l.testOut('cpu', 11);
    expect(new Learn(kv).state.tested).toEqual({ cpu: 11 });
    expect(JSON.parse(map.get(LEARN_KEY)!).start.tier).toBe(3);
  });
});

describe('placement and test-out', () => {
  it('placement asks twelve real questions climbing the tiers', () => {
    const items = placementItems(42);
    expect(items).toHaveLength(PLACEMENT.length);
    expect(items.map((i) => i.tier)).toEqual([...items.map((i) => i.tier)].sort());
    for (const i of items) if (i.kind === 'drill') expect(i.q.check(i.q.answer).ok, i.from).toBe(true);
  });
  it('suggests the first tier with under two thirds right', () => {
    const a = (tier: 0 | 1 | 2 | 3, right: boolean) => ({ tier, right });
    expect(suggestTier([a(0, true), a(0, true), a(1, true), a(1, false), a(1, false)])).toBe(1);
    expect(suggestTier([a(0, false), a(0, true)])).toBe(0);
    expect(suggestTier([a(0, true), a(1, true), a(2, true), a(3, true)])).toBe(4);
  });
  it('every journey chapter with a recap can be tested out; drills fit their chapters', () => {
    for (const c of chapters) if (!c.prologue && !c.appendix && c.recap?.check?.length) expect(testOutItems(c.id).length, c.id).toBeGreaterThanOrEqual(c.recap.check.length);
    for (const ch of Object.keys(TEST_DRILL)) expect(byId.has(ch), ch).toBe(true);
  });
});

function ctx(o: Partial<PathCtx> = {}): PathCtx {
  return { ...ev(), campaign: () => undefined, unlockAll: false, reviewDue: 0, ...o };
}

describe('next up', () => {
  // the path reads every chapter's prose (for its minutes): warm it first, as the other whole-book tests do
  beforeAll(warmBook, WARM_TIMEOUT);

  it('a fresh learner starts at Basics, step 1', () => {
    const n = nextUp(ctx());
    expect(n[0]).toMatchObject({ kind: 'learn', href: '#/c/basics/0' });
  }, BOOK_TIMEOUT);
  it('questions due come first; a start tier skips the tiers below', () => {
    const n = nextUp(ctx({ reviewDue: 3 }), 2);
    expect(n[0].kind).toBe('review');
    expect(n[1].href).toMatch(/^#\/c\/alu\//);
  });
  it('a tested-out chapter is skipped, and tiers count their skills', () => {
    expect(nextUp(ctx({ testedOut: (c) => c === 'basics' }))[0].href).toBe('#/c/map/0');
    const v = tierViews(ctx({ testedOut: () => true }));
    for (const t of v) expect(t.done, `tier ${t.tier}`).toBe(t.skills.length);
  });
  it('formats times as estimates', () => {
    expect(fmtMinutes(33)).toBe('about 35 min');
    expect(fmtMinutes(150)).toBe('about 2.5 h');
  });
});
