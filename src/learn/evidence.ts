// My path's evidence from the stores the site already keeps (browser): chapters seen and checks solved (settings), review
// memos, the campaign's levels, and the learn store's test-outs. Loaded with the path pages, never on a chapter.

import { progress } from '../campaign/progress';
import { buildQueue, reviewLog } from '../ui/review';
import { allQuestions } from '../ui/reviewqs';
import { settings } from '../ui/settings';
import type { PathCtx } from './path';
import { learn } from './store';

export function pathCtx(now = Date.now()): PathCtx {
  const p = progress();
  const st = reviewLog().state;
  const lr = learn().state;
  const visited = (c: string) => settings.visited(c).length > 0;
  const due = buildQueue(allQuestions(), st, { now, visited, limit: 99 }).filter((x) => x.why !== 'new').length;
  return {
    now,
    visited: (c) => settings.visited(c),
    solved: (k) => settings.isSolved(k),
    memo: (k) => st.memos[k],
    levelSolved: (id) => p.state.nodes[id]?.status === 'solved',
    testedOut: (c) => c in lr.tested,
    campaign: p.view,
    unlockAll: !!p.state.unlockAll,
    reviewDue: due,
  };
}

