// Placement and test-out questions (DOM-free). Placement: twelve questions climbing the tiers, from the campaign's drill
// generators (fresh each run, exact checkers) and the chapters' recap questions; a tier is passed with two thirds right,
// and the suggestion is the first tier not passed. Test-out: a chapter's recap questions plus a fresh drill question where
// one fits; every one right tests the chapter out. Answers go to the learn store only (store.ts), never to the chapters.

import { DRILLS, rng, type Question } from '../campaign/drills';
import { chapters } from '../chapters';
import type { Quiz } from '../chapters/types';
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

function item(s: Src, r: () => number): Item {
  if (s[1] === 'drill') {
    const d = DRILLS[s[2]];
    return { tier: s[0], from: d.title, kind: 'drill', q: d.make(r), how: d.how };
  }
  const c = chapters.find((x) => x.id === s[2])!;
  return { tier: s[0], from: c.title, kind: 'quiz', quiz: c.recap!.check![s[3]] };
}

export function placementItems(seed = Date.now()): Item[] {
  const r = rng(seed);
  return PLACEMENT.map((s) => item(s, r));
}

/** The suggested start: the first tier with fewer than two thirds of its questions right (4 when all are passed). */
export function suggestTier(answers: readonly { tier: Tier; right: boolean }[]): Tier {
  for (const t of [0, 1, 2, 3] as const) {
    const mine = answers.filter((a) => a.tier === t);
    if (mine.length && mine.filter((a) => a.right).length * 3 < mine.length * 2) return t;
  }
  return 4;
}

export function testOutItems(chapter: string, seed = Date.now()): Item[] {
  const c = chapters.find((x) => x.id === chapter);
  if (!c?.recap?.check?.length) return [];
  const out: Item[] = c.recap.check.map((quiz) => ({ tier: 0, from: c.title, kind: 'quiz', quiz }));
  const d = TEST_DRILL[chapter];
  if (d) out.push(item([0, 'drill', d], rng(seed)));
  return out;
}
