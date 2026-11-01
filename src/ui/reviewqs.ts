// Every question the review queue can ask (DOM-free): the chapters' step quizzes and recap checks, and the codex's Check
// yourself. Keys are the ones quizBox logs and settings.solved holds (`id:step`, `id:recap:k`, `codex:id:k`).

import { CHECKS } from '../campaign/codexcheck';
import { codexById } from '../campaign/codex';
import { chapters } from '../chapters';
import { chapterNo, type Quiz } from '../chapters/types';
import type { Question } from './review';

export interface ReviewQ extends Question {
  quiz: Quiz;
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
  return cache = out;
}
