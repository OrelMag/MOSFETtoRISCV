// My path (DOM-free): each tier's progress, what to do next, and how long things take. The journey teaches, the campaign
// practises: the next step to learn is the first unseen journey step of the learner's tier; the level to practise is the
// first open level built around a skill of that tier which is seen but not yet built; questions due come first.
// Times are estimates ("about"): reading at READ_WPM, plus a few minutes for a stage, a challenge, or a level by kind.

import { statusOf, type ProgressView } from '../campaign/graph';
import { nodeById } from '../campaign/nodes';
import { chapters } from '../chapters';
import type { Chapter, Step } from '../chapters/types';
import { CAPSTONES, capstoneStatus, type Capstone, type CapstoneStatus, type Tier } from './capstones';
import { DONE, skillState, type Evidence, type SkillState } from './mastery';
import { skills, tierChapters, TIERS, type Skill } from './skills';

export const READ_WPM = 200;
const LEVEL_MIN: Record<string, number> = { lesson: 4, drill: 8, build: 15, program: 15, core: 40 };

const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\$\{[^}]*\}/g, ' x ').split(/\s+/).filter(Boolean).length;

/** About how many minutes a step takes: reading, plus the stage or widget, plus its challenge. */
export function stepMinutes(s: Step): number {
  return Math.max(1, Math.round(words(s.body) / READ_WPM + (s.scene || s.widget ? 2 : 0) + (s.challenge ? 2 : 0) + (s.tour ? 1 : 0)));
}

export const levelMinutes = (id: string): number => LEVEL_MIN[nodeById(id)?.kind ?? ''] ?? 10;

export interface TierView {
  tier: Tier;
  title: string;
  blurb: string;
  skills: { skill: Skill; state: SkillState }[];
  done: number;
  /** About how many minutes of unseen steps and unsolved required levels are left. */
  minutesLeft: number;
  capstone?: Capstone & { status: CapstoneStatus };
}

export interface PathCtx extends Evidence {
  campaign: ProgressView;
  unlockAll: boolean;
  /** Review questions due now (answered before, due again; or missed). */
  reviewDue: number;
}

export function tierViews(ctx: PathCtx): TierView[] {
  const all = skills();
  return TIERS.map(({ tier, title, blurb }) => {
    const sk = all.filter((s) => s.tier === tier).map((skill) => ({ skill, state: skillState(skill, ctx) }));
    let minutes = 0;
    for (const c of tierChapters(tier)) {
      if (ctx.testedOut(c.id)) continue;
      const seen = ctx.visited(c.id);
      c.steps.forEach((s, i) => { if (!seen.includes(i)) minutes += stepMinutes(s); });
    }
    const levels = new Set(sk.flatMap(({ skill }) => skill.levels.filter((id) => !nodeById(id)?.optional)));
    for (const id of levels) if (!ctx.levelSolved(id)) minutes += levelMinutes(id);
    const cap = CAPSTONES.find((c) => c.tier === tier);
    return {
      tier, title, blurb, skills: sk, done: sk.filter((x) => DONE.has(x.state)).length, minutesLeft: minutes,
      ...(cap ? { capstone: { ...cap, status: capstoneStatus(cap.id, Object.fromEntries([[cap.id, ctx.campaign(cap.id)]])) } } : {}),
    };
  });
}

/** The tier the learner is in: the first one from their start that is not done (every skill practised, its capstone passed). */
export function currentTier(views: TierView[], start = 0): Tier {
  for (const v of views) if (v.tier >= start && (v.done < v.skills.length || (v.capstone && v.capstone.status !== 'passed'))) return v.tier;
  return 4;
}

export interface NextItem {
  kind: 'review' | 'learn' | 'practise' | 'capstone';
  title: string;
  href: string | null;
  minutes: number;
}

/** Up to three things to do next: questions due, the next journey step of the tier, a level to practise, or the capstone. */
export function nextUp(ctx: PathCtx, start = 0): NextItem[] {
  const views = tierViews(ctx);
  const t = currentTier(views, start);
  const view = views.find((v) => v.tier === t)!;
  const out: NextItem[] = [];
  if (ctx.reviewDue > 0) out.push({ kind: 'review', title: `${ctx.reviewDue} question${ctx.reviewDue > 1 ? 's' : ''} due again`, href: '#/notes', minutes: Math.max(2, ctx.reviewDue) });
  const step = nextStep(t, ctx);
  if (step) out.push({ kind: 'learn', title: `${step.c.title}, step ${step.i + 1}: ${step.c.steps[step.i].title}`, href: `#/c/${step.c.id}/${step.i}`, minutes: stepMinutes(step.c.steps[step.i]) });
  const lv = practiseLevel(view, ctx);
  if (lv) out.push({ kind: 'practise', title: `Level: ${nodeById(lv)!.title}`, href: `#/campaign/n/${lv}`, minutes: levelMinutes(lv) });
  const cap = view.capstone;
  if (out.length < 3 && cap && cap.status !== 'passed' && view.done / Math.max(1, view.skills.length) >= 0.8)
    out.push({ kind: 'capstone', title: `Tier ${t} capstone: ${cap.title}`, href: cap.route, minutes: t <= 1 ? 45 : 120 });
  return out.slice(0, 3);
}

/** The first journey step of a tier not seen yet, skipping chapters tested out. */
function nextStep(t: Tier, ctx: PathCtx): { c: Chapter; i: number } | null {
  for (const c of tierChapters(t)) {
    if (ctx.testedOut(c.id)) continue;
    const seen = ctx.visited(c.id);
    const i = c.steps.findIndex((_, k) => !seen.includes(k));
    if (i >= 0) return { c, i };
  }
  return null;
}

/** A level built around a skill of the tier that is seen but not built yet, open on the campaign (required first). */
function practiseLevel(view: TierView, ctx: PathCtx): string | null {
  for (const { skill, state } of view.skills) {
    if (state !== 'learning') continue;
    for (const id of skill.levels) {
      const n = nodeById(id);
      if (n && !ctx.levelSolved(id) && ['available', 'started'].includes(statusOf(n, ctx.campaign, ctx.unlockAll))) return id;
    }
  }
  return null;
}

export const chapterById = (id: string): Chapter | undefined => chapters.find((c) => c.id === id);

/** "about 2 h", "about 35 min". */
export function fmtMinutes(m: number): string {
  if (m < 60) return `about ${Math.max(1, Math.round(m / 5) * 5 || m)} min`;
  const hours = m / 60;
  return `about ${hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours)} h`;
}
