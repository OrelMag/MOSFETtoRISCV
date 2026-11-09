// What the coherent dual-core's caches cost, counted from the gates (chapter multicore's cache steps quote these; tests/coherent-costs.test.ts
// pins the chapter's text to them).

import { stats } from '../sim/stats';
import { cohAccess, cohBus, cohRes, coherentCache, coherentDualCore } from './coherent';
import { singleCycleCpu } from './cpu';
import { dualCore } from './multicore';
import { regfileMP } from './storage';

export interface CohCosts {
  /** NANDs of one cache with the snoop port, and without. */
  cache: number;
  privateCache: number;
  /** What one cache is made of. */
  data: number;
  tags: number;
  snoopTags: number;
  access: number;
  reservation: number;
  /** The snoop port: the second tag copy, its comparator and the write-back of snooped states. */
  snoop: number;
  bus: number;
  /** One core without a cache, the shared-memory dual-core, the coherent dual-core. */
  core: number;
  dual: number;
  coherent: number;
}

let memo: CohCosts | undefined;
export function cohCosts(): CohCosts {
  if (memo) return memo;
  const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
  const K = 5, t = K - 4;
  const cache = n(coherentCache(K, true)), privateCache = n(coherentCache(K, false));
  const w = [0x13];
  return (memo = {
    cache, privateCache, data: n(regfileMP(4, 32, 2, 1)), tags: n(regfileMP(2, t + 2, 1, 1)), snoopTags: n(regfileMP(2, t + 2, 1, 1)),
    access: n(cohAccess(t)), reservation: n(cohRes(K - 2, true)), snoop: cache - privateCache, bus: n(cohBus(K)),
    core: n(singleCycleCpu(w, { shared: true, adder: 'ks' })), dual: n(dualCore(w)), coherent: n(coherentDualCore(w)),
  });
}
