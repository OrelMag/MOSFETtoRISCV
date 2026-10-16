// Reordering (chapter 33, last step): requests from several sources wait in a queue; the controller
// serves one at a time. FCFS takes the oldest; FR-FCFS (first ready, first come first served) takes the
// oldest row hit, and the oldest request only when nothing hits. Each service costs what its bank's row
// buffer says (dram/timing.ts accessCycles), one after another on the data bus.

import { accessCycles, type DramTiming, TIMING } from './timing';

export interface QReq { id: number; src: number; arrive: number; bank: number; row: number }
export interface Served extends QReq { start: number; end: number; outcome: 'hit' | 'miss' | 'conflict' }
export type SchedPolicy = 'fcfs' | 'frfcfs';

export function schedule(reqs: QReq[], policy: SchedPolicy, depth: number, banks: number, t: DramTiming = TIMING): Served[] {
  const open = new Array<number>(banks).fill(-1);
  const pending = [...reqs].sort((a, b) => a.arrive - b.arrive || a.id - b.id);
  const queue: QReq[] = [], out: Served[] = [];
  let now = 0;
  while (pending.length || queue.length) {
    // the queue takes what has arrived, while it has room (a full queue holds the source back)
    while (pending.length && queue.length < depth && pending[0].arrive <= now) queue.push(pending.shift()!);
    if (!queue.length) { now = pending[0].arrive; continue; }
    let k = 0;
    if (policy === 'frfcfs') {
      const h = queue.findIndex((q) => open[q.bank] === q.row);
      if (h >= 0) k = h;
    }
    const q = queue.splice(k, 1)[0];
    const outcome = open[q.bank] === q.row ? 'hit' : open[q.bank] < 0 ? 'miss' : 'conflict';
    open[q.bank] = q.row;
    const end = now + accessCycles(outcome, t);
    out.push({ ...q, start: now, end, outcome });
    now = end;
  }
  return out;
}

/**
 * The step's scene: a CPU reading a line every 6 cycles from one row, a write buffer draining a line
 * every 6 cycles into another row of the same bank, 16 each.
 */
export function twoStreams(n = 16, every = 6): QReq[] {
  const out: QReq[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: out.length, src: 0, arrive: i * every, bank: 0, row: 1 });
    out.push({ id: out.length, src: 1, arrive: i * every + 3, bank: 0, row: 5 });
  }
  return out;
}
