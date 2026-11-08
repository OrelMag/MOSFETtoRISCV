// Placement and test-out questions (DOM-free). Placement: twelve questions climbing the tiers, from the campaign's drill
// generators (fresh each run, exact checkers) and the chapters' recap questions; a tier is passed with two thirds right,
// and the suggestion is the first tier not passed. Test-out: a chapter's recap questions plus a fresh drill question where
// one fits; every one right tests the chapter out. Answers go to the learn store only (store.ts), never to the chapters.
// The questions load when asked for (the drills and learn/recaps.ts are chunks of their own), so My path and Where are you
// starting? open without them.

import type { Question } from '../campaign/drills';
import type { Quiz } from '../chapters/types';
import { outlineOf } from '../chapters/outline';
import type { Tier } from './capstones';

export type Item = { tier: Tier; from: string } & ({ kind: 'quiz'; quiz: Quiz } | { kind: 'drill'; q: Question; how: string });

type Src = [Tier, 'drill', string] | [Tier, 'recap', string, number];

export const PLACEMENT: Src[] = [
  [0, 'recap', 'basics', 2], [0, 'drill', 'binary'],
  [1, 'drill', 'twos'], [1, 'drill', 'boolean'], [1, 'recap', 'latches', 0], [1, 'recap', 'adders', 0],
  [2, 'drill', 'isa16'], [2, 'recap', 'cpu', 0], [2, 'recap', 'regfile', 0],
  [3, 'recap', 'pipeline', 0], [3, 'recap', 'cache', 0], [3, 'drill', 'float'],
];

/** Chapters with a drill that fits their test-out. */
export const TEST_DRILL: Record<string, string> = { basics: 'binary', binary: 'twos', gates: 'boolean', isa: 'isa16', float: 'float' };

/** The question banks: the campaign's drills and every chapter's recap questions (generated, learn/pathgen.ts). */
const banks = () => Promise.all([import('../campaign/drills'), import('./recaps')]).then(([d, r]) => ({ DRILLS: d.DRILLS, rng: d.rng, RECAPS: r.RECAPS }));
type Banks = Awaited<ReturnType<typeof banks>>;

function item(b: Banks, s: Src, r: () => number): Item {
  if (s[1] === 'drill') {
    const d = b.DRILLS[s[2]];
    return { tier: s[0], from: d.title, kind: 'drill', q: d.make(r), how: d.how };
  }
  return { tier: s[0], from: outlineOf(s[2])!.title, kind: 'quiz', quiz: b.RECAPS[s[2]][s[3]] };
}

export async function placementItems(seed = Date.now()): Promise<Item[]> {
  const b = await banks();
  const r = b.rng(seed);
  return PLACEMENT.map((s) => item(b, s, r));
}

/** The suggested start: the first tier with fewer than two thirds of its questions right (4 when all are passed). */
export function suggestTier(answers: readonly { tier: Tier; right: boolean }[]): Tier {
  for (const t of [0, 1, 2, 3] as const) {
    const mine = answers.filter((a) => a.tier === t);
    if (mine.length && mine.filter((a) => a.right).length * 3 < mine.length * 2) return t;
  }
  return 4;
}

export async function testOutItems(chapter: string, seed = Date.now()): Promise<Item[]> {
  const c = outlineOf(chapter);
  if (!c?.recap?.checks) return [];
  const b = await banks();
  const out: Item[] = (b.RECAPS[chapter] ?? []).map((quiz) => ({ tier: 0, from: c.title, kind: 'quiz', quiz }));
  const d = TEST_DRILL[chapter];
  if (d) out.push(item(b, [0, 'drill', d], b.rng(seed)));
  return out;
}
