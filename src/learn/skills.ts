// The skill map (DOM-free): a skill is a codex entry, placed at the journey chapter that teaches it (chapters/taught.ts),
// learned on the steps its entry links there, practised by the campaign levels built around it (CampaignNode.codex), and
// checked by its codex questions, the linked steps' quizzes and the generated ones (bank.ts) (their review memos: ui/review.ts). Basics adds the two
// ideas that have no codex entry. Tiers group the journey: 0 Basics and the map, 1 chapters 1–10, 2 11–15, 3 16–25,
// 4 the rest (prologue and appendices are optional and in no tier). Nothing here is authored per skill: it cannot drift.

import { CODEX } from '../campaign/codex';
import { checkOf, moreOf } from '../campaign/codexmore';
import { NODES } from '../campaign/nodes';
import { chapters } from '../chapters';
import { numOf } from '../chapters/order';
import { TAUGHT } from '../chapters/taught';
import type { Chapter } from '../chapters/types';
import { DRILL_REVIEW, REVIEW_BANK } from './bank';
import type { Tier } from './capstones';

export interface Skill {
  /** The codex id, or basics:<name> for Basics' own two. */
  id: string;
  title: string;
  tier: Tier;
  /** The chapter that teaches it, and the steps there that do. */
  chapter: string;
  steps: number[];
  /** Review keys (settings.solved / review memo): the codex's Check yourself and the steps' quizzes. */
  checks: string[];
  /** Step reach challenges (settings.solved keys): building it on the stage. */
  reach: string[];
  /** Campaign levels built around it (not lessons), required ones first. */
  levels: string[];
}

export const TIERS: { tier: Tier; title: string; blurb: string }[] = [
  { tier: 0, title: 'Zero', blurb: 'Voltage, bits, binary, a truth table, a program, and how to read a circuit here' },
  { tier: 1, title: 'Foundations', blurb: 'Transistors, gates, binary arithmetic, adders, latches, registers, memory' },
  { tier: 2, title: 'Builder', blurb: 'ALU, register file, the instruction set, a single-cycle CPU, Python down to gates' },
  { tier: 3, title: 'Architect', blurb: 'Fast adders, pipelines, I/O and traps, multiply and divide, caches, microcode, floating point' },
  { tier: 4, title: 'Master', blurb: 'Out of order, multicore, silicon, the GPU, memory systems' },
];

const optional = (c: Chapter) => !!(c.prologue || c.appendix);

/** The tier a journey chapter belongs to; null for the prologue and the appendices. */
export function tierOfChapter(c: Chapter): Tier | null {
  if (optional(c)) return null;
  return c.num === 0 ? 0 : c.num <= numOf('memory') ? 1 : c.num <= numOf('python') ? 2 : c.num <= numOf('widths') ? 3 : 4;
}

/** The journey chapters of a tier, in order. */
export const tierChapters = (t: Tier): Chapter[] => chapters.filter((c) => tierOfChapter(c) === t);

/** Basics' ideas without a codex entry, checked by its recap's questions. */
const BASICS: { id: string; title: string; step: number; recap: number }[] = [
  { id: 'basics:loop', title: 'A closed loop', step: 0, recap: 1 },
  { id: 'basics:levels', title: 'Two levels', step: 1, recap: 2 },
];

let memo: Skill[] | null = null;

/** Every skill, in journey order (chapter, then the first step that teaches it). */
export function skills(): Skill[] {
  if (memo) return memo;
  const order = new Map(chapters.map((c, i) => [c.id, i]));
  const out: Skill[] = [];
  for (const b of BASICS) out.push({ id: b.id, title: b.title, tier: 0, chapter: 'basics', steps: [b.step], checks: [`basics:recap:${b.recap}`], reach: [], levels: [] });
  for (const e of CODEX) {
    const chId = TAUGHT[e.id];
    const ch = chId ? chapters.find((c) => c.id === chId) : undefined;
    const tier = ch && tierOfChapter(ch);
    if (!ch || tier === null || tier === undefined) continue;
    const steps = [...new Set((moreOf(e.id)?.chapters ?? []).filter((l) => l.chapter === chId && l.step !== undefined).map((l) => l.step!))].sort((a, b) => a - b);
    const quiz = steps.filter((i) => ch.steps[i]?.challenge?.kind === 'quiz').map((i) => `${chId}:${i}`);
    const reach = steps.filter((i) => ch.steps[i]?.challenge?.kind === 'reach').map((i) => `${chId}:${i}`);
    const lv = NODES.filter((n) => n.kind !== 'lesson' && !n.soon && n.codex?.includes(e.id));
    out.push({
      id: e.id, title: e.title.replace(/\s*\([^)]*\)\s*$/, ''), tier, chapter: chId, steps: steps.length ? steps : [0],
      checks: [...(checkOf(e.id) ?? []).map((_, k) => `codex:${e.id}:${k}`), ...quiz], reach,
      levels: [...lv.filter((n) => !n.optional), ...lv.filter((n) => n.optional)].map((n) => n.id),
    });
  }
  // generated questions (learn/bank.ts): a beat to predict counts for the skills its step teaches, a part to remove for the entries drawing it
  for (const b of REVIEW_BANK) for (const s of out) if (b.kind === 'predict' ? s.chapter === b.chapter && s.steps.includes(b.step) : b.codex.includes(s.id)) s.checks.push(b.key);
  for (const d of DRILL_REVIEW) for (const s of out) if (d.codex.includes(s.id)) s.checks.push(`drill:${d.drill}`);
  const at = (s: Skill) => (order.get(s.chapter) ?? 0) * 1000 + s.steps[0];
  memo = out.sort((a, b) => at(a) - at(b));
  return memo;
}

/** The skills a chapter teaches. */
export const skillsOfChapter = (id: string): Skill[] => skills().filter((s) => s.chapter === id);
