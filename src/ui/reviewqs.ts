// Every question the review queue can ask (DOM-free): the chapters' step quizzes and recap checks, the codex's Check
// yourself (keys as quizBox logs them and settings.solved holds: `id:step`, `id:recap:k`, `codex:id:k`), and generated ones:
// predict a tour's beat and what breaks when a part goes (learn/bank.ts: `predict:…`, `ablate:…`), the campaign's drills (`drill:id`).
// Built by ui/reviewbuild.ts over every chapter (tests, learn/pathgen.ts); My notes builds it over the visited ones only.

import { chapters } from '../chapters';
import { buildQuestions, type ReviewQ } from './reviewbuild';

export type { ReviewQ } from './reviewbuild';

let cache: ReviewQ[] | null = null;

export function allQuestions(): ReviewQ[] {
  return cache ??= buildQuestions(chapters);
}
