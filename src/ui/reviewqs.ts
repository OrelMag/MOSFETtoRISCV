// Every question the review queue can ask (DOM-free): the chapters' step quizzes and recap checks, the codex's Check
// yourself (keys as quizBox logs them and settings.solved holds: `id:step`, `id:recap:k`, `codex:id:k`), and generated ones:
// predict a tour's beat and what breaks when a part goes (learn/bank.ts: `predict:…`, `ablate:…`), the campaign's drills (`drill:id`).

import { CHECKS } from '../campaign/codexcheck';
import { codexById } from '../campaign/codex';
import { chapters } from '../chapters';
import { chapterNo, type Quiz } from '../chapters/types';
import { DRILLS } from '../campaign/drills';
import { bankQuiz, DRILL_REVIEW, REVIEW_BANK } from '../learn/bank';
import { TAUGHT } from '../chapters/taught';
import type { Question } from './review';

export interface ReviewQ extends Question {
  /** A multiple-choice question, or a campaign drill (a fresh question of it each time, typed answer). */
  quiz?: Quiz;
  drill?: string;
}

let cache: ReviewQ[] | null = null;

export function allQuestions(): ReviewQ[] {
  if (cache) return cache;
  const out: ReviewQ[] = [];
  for (const c of chapters) {
    const name = `${chapterNo(c)} · ${c.title}`;
    c.steps.forEach((s, i) => {
      if (s.challenge?.kind === 'quiz') out.push({ key: `${c.id}:${i}`, origin: `${name} · step ${i + 1}, ${s.title}`, href: `#/c/${c.id}/${i}`, chapter: c.id, quiz: s.challenge });
    });
    c.recap?.check?.forEach((q, k) => out.push({ key: `${c.id}:recap:${k}`, origin: `${name} · recap`, href: `#/c/${c.id}/${c.steps.length}`, chapter: c.id, quiz: q }));
  }
  for (const [id, qs] of Object.entries(CHECKS)) {
    const e = codexById(id);
    if (!e) continue;
    qs.forEach((q, k) => out.push({ key: `codex:${id}:${k}`, origin: `Codex · ${e.title}`, href: `#/campaign/codex/${id}`, quiz: q }));
  }
  // generated: predict a tour's beat (from its chapter, once visited), what breaks when a part goes (from the chapter teaching it)
  const byId = new Map(chapters.map((c) => [c.id, c]));
  for (const b of REVIEW_BANK) {
    if (b.kind === 'predict') {
      const c = byId.get(b.chapter);
      if (c) out.push({ key: b.key, origin: `${chapterNo(c)} · ${c.title} · step ${b.step + 1}, predict`, href: `#/c/${c.id}/${b.step}`, chapter: c.id, quiz: bankQuiz(b), generated: true });
    } else {
      const e = codexById(b.codex[0]);
      if (e) out.push({ key: b.key, origin: `Codex · ${e.title} · what breaks`, href: `#/campaign/codex/${e.id}`, chapter: TAUGHT[e.id], quiz: bankQuiz(b), generated: true });
    }
  }
  for (const d of DRILL_REVIEW) {
    const c = byId.get(d.chapter);
    if (c) out.push({ key: `drill:${d.drill}`, origin: `${chapterNo(c)} · ${c.title} · drill: ${DRILLS[d.drill].title}`, href: `#/campaign/n/${d.level}`, chapter: c.id, drill: d.drill, generated: true });
  }
  return cache = out;
}
