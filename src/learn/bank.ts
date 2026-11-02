// The review bank (DOM-free): generated multiple-choice questions beyond the authored quizzes, asked by the same review
// queue (ui/reviewqs.ts) and counted toward the skills they test (learn/skills.ts). The file is written by
// scripts/review-bank.ts (bankgen.ts) and checked by tests/reviewbank.test.ts; nothing is computed in the browser.

import type { Quiz } from '../chapters/types';
import bank from './reviewbank.json';

export type BankQ = {
  key: string;
  question: string;
  options: string[];
  answer: number;
  explain: string;
} & ({ kind: 'predict'; chapter: string; step: number } | { kind: 'ablate'; codex: string[] });

export const REVIEW_BANK = bank as BankQ[];

export const bankQuiz = (q: BankQ): Quiz => ({ question: q.question, options: q.options, answer: q.answer, explain: q.explain });

/** The campaign's drills in the review: one memo each, a fresh question every time, counted toward these skills. */
export const DRILL_REVIEW: { drill: string; chapter: string; level: string; codex: string[] }[] = [
  { drill: 'binary', chapter: 'binary', level: 'n_bin', codex: ['positional', 'hex'] },
  { drill: 'twos', chapter: 'binary', level: 'n_twos', codex: ['twos', 'overflow'] },
  { drill: 'boolean', chapter: 'gates', level: 'l_bool', codex: ['identities', 'demorgan'] },
  { drill: 'kmap', chapter: 'memory', level: 'd_kmap', codex: ['sop'] },
  { drill: 'isa16', chapter: 'isa', level: 'i_enc', codex: ['formats', 'immediates'] },
  { drill: 'float', chapter: 'float', level: 'n_float', codex: ['ieee754', 'rounding'] },
];
