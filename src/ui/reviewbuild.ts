// The review questions built from the chapters given (DOM-free), so My notes asks only about the chapters it has loaded, the
// visited ones, instead of importing every chapter: chapters/index.ts evaluated all of them, a 5 s freeze on opening #/notes.
// Generated questions name their chapter from the outline. ui/reviewqs.ts allQuestions() is this over every chapter.

import { CHECKS } from '../campaign/codexcheck';
import { codexById } from '../campaign/codex';
import { chapterNo } from '../chapters/meta';
import { outlineOf } from '../chapters/outline';
import type { Chapter, Quiz } from '../chapters/types';
import { DRILLS } from '../campaign/drills';
import { bankQuiz, DRILL_REVIEW, REVIEW_BANK } from '../learn/bank';
import { LESSON_EXTRAS } from '../campaign/lessonextras';
import { NODES } from '../campaign/nodes';
import { TAUGHT } from '../chapters/taught';
import type { Question } from './review';

export interface ReviewQ extends Question {
  /** A multiple-choice question, or a campaign drill (a fresh question of it each time, typed answer). */
  quiz?: Quiz;
  drill?: string;
}

/** Every question of `chs` (step quizzes, the spec's, recap checks), the codex's and lessons', and the generated ones (all chapters). */
export function buildQuestions(chs: readonly Chapter[]): ReviewQ[] {
  const out: ReviewQ[] = [];
  for (const c of chs) {
    const name = `${chapterNo(c)} · ${c.title}`;
    c.steps.forEach((s, i) => {
      if (s.challenge?.kind === 'quiz') out.push({ key: `${c.id}:${i}`, origin: `${name} · step ${i + 1}, ${s.title}`, href: `#/c/${c.id}/${i}`, chapter: c.id, quiz: s.challenge });
      s.reading?.quizzes.forEach((q, k) => out.push({ key: `${c.id}:${i}:read:${k}`, origin: `${name} · step ${i + 1}, ${s.title}, the spec`, href: `#/c/${c.id}/${i}`, chapter: c.id, quiz: q }));
    });
    c.recap?.check?.forEach((q, k) => out.push({ key: `${c.id}:recap:${k}`, origin: `${name} · recap`, href: `#/c/${c.id}/${c.steps.length}`, chapter: c.id, quiz: q }));
  }
  for (const [id, qs] of Object.entries(CHECKS)) {
    const e = codexById(id);
    if (!e) continue;
    qs.forEach((q, k) => out.push({ key: `codex:${id}:${k}`, origin: `Codex · ${e.title}`, href: `#/campaign/codex/${id}`, quiz: q }));
  }
  for (const n of NODES) {
    const x = n.kind === 'lesson' && n.body ? LESSON_EXTRAS[n.body] : undefined;
    x?.check.forEach((q, k) => out.push({ key: `lesson:${n.body}:${k}`, origin: `Campaign · ${n.title}`, href: `#/campaign/n/${n.id}`, quiz: q }));
  }
  // generated: predict a tour's beat (from its chapter, once visited), what breaks when a part goes (from the chapter teaching it)
  for (const b of REVIEW_BANK) {
    if (b.kind === 'predict') {
      const c = outlineOf(b.chapter);
      if (c) out.push({ key: b.key, origin: `${chapterNo(c)} · ${c.title} · step ${b.step + 1}, predict`, href: `#/c/${c.id}/${b.step}`, chapter: c.id, quiz: bankQuiz(b), generated: true });
    } else {
      const e = codexById(b.codex[0]);
      if (e) out.push({ key: b.key, origin: `Codex · ${e.title} · what breaks`, href: `#/campaign/codex/${e.id}`, chapter: TAUGHT[e.id], quiz: bankQuiz(b), generated: true });
    }
  }
  for (const d of DRILL_REVIEW) {
    const c = outlineOf(d.chapter);
    if (c) out.push({ key: `drill:${d.drill}`, origin: `${chapterNo(c)} · ${c.title} · drill: ${DRILLS[d.drill].title}`, href: `#/campaign/n/${d.level}`, chapter: c.id, drill: d.drill, generated: true });
  }
  return out;
}
