// A skill's state from evidence the site already keeps (DOM-free). Three kinds of evidence make it mastered:
//   understand: one of its questions answered right last time (review memo), or a quiz step solved
//   build:      a campaign level built around it solved, or a reach challenge on its steps (waived when it has neither)
//   retain:     one of its questions right twice in a row (streak 2: the second came at least 2 days after the first)
// practised = understand and build, or its chapter tested out (placement never makes anything mastered).
// rusty = mastered, with one of its questions due again now. learning = a step of it seen, or any evidence.

import type { Memo } from '../ui/review';
import type { Skill } from './skills';

export type SkillState = 'new' | 'learning' | 'practised' | 'mastered' | 'rusty';

/** Mastered, rusty and practised count as done for a tier's progress. */
export const DONE: ReadonlySet<SkillState> = new Set(['practised', 'mastered', 'rusty']);

export interface Evidence {
  now: number;
  visited(chapter: string): readonly number[];
  solved(key: string): boolean;
  memo(key: string): Memo | undefined;
  levelSolved(node: string): boolean;
  testedOut(chapter: string): boolean;
}

/** The two halves of practised: a question right (understand) and its level or reach challenge done (build). */
export function skillGaps(s: Skill, ev: Evidence): { understand: boolean; build: boolean } {
  const memos = s.checks.map((k) => ev.memo(k)).filter((m): m is Memo => !!m);
  const understand = memos.some((m) => !m.miss) || s.checks.some((k) => !k.startsWith('codex:') && ev.solved(k));
  const canBuild = s.levels.length > 0 || s.reach.length > 0;
  return { understand, build: !canBuild || s.levels.some((id) => ev.levelSolved(id)) || s.reach.some((k) => ev.solved(k)) };
}

export function skillState(s: Skill, ev: Evidence): SkillState {
  const memos = s.checks.map((k) => ev.memo(k)).filter((m): m is Memo => !!m);
  const { understand, build } = skillGaps(s, ev);
  const canBuild = s.levels.length > 0 || s.reach.length > 0;
  const retain = memos.some((m) => m.streak >= 2 && !m.miss);
  if (understand && build && retain) return memos.some((m) => m.due <= ev.now) ? 'rusty' : 'mastered';
  if ((understand && build) || ev.testedOut(s.chapter)) return 'practised';
  const seen = ev.visited(s.chapter).some((i) => s.steps.includes(i));
  return seen || understand || memos.length > 0 || (canBuild && build) ? 'learning' : 'new';
}
