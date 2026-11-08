// My path's evidence from the stores the site already keeps (browser): chapters seen and checks solved (settings), review
// memos, the campaign's levels, and the learn store's test-outs. Loaded with the path pages, never on a chapter. The campaign is read
// from its storage key and the review questions from learn/pathindex.ts, so neither the campaign's nodes nor the chapters load here.

import { readCampaign } from '../campaign/progressread';
import { buildQueue, reviewLog, type Question } from '../ui/review';
import { settings } from '../ui/settings';
import type { PathCtx } from './path';
import { PATH_REVIEW } from './pathindex';
import { learn } from './store';

let questions: Question[] | null = null;
/** The review questions as the queue counts them (ui/reviewqs.ts allQuestions: same keys, chapters and order; no bodies). */
export const reviewKeys = (): Question[] =>
  questions ??= PATH_REVIEW.map(([key, chapter, gen]) => ({ key, origin: '', href: '', ...(chapter ? { chapter } : {}), ...(gen ? { generated: true } : {}) }));

export function pathCtx(now = Date.now()): PathCtx {
  const camp = readCampaign();
  const st = reviewLog().state;
  const lr = learn().state;
  const visited = (c: string) => settings.visited(c).length > 0;
  const due = buildQueue(reviewKeys(), st, { now, visited, limit: 99 }).filter((x) => x.why !== 'new').length;
  return {
    now,
    visited: (c) => settings.visited(c),
    solved: (k) => settings.isSolved(k),
    memo: (k) => st.memos[k],
    levelSolved: (id) => camp.view(id)?.status === 'solved',
    testedOut: (c) => c in lr.tested,
    campaign: camp.view,
    unlockAll: camp.unlockAll,
    reviewDue: due,
  };
}
