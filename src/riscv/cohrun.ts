// A program run to halt on the coherent timing model: the numbers the chapter's cache steps quote (the model is held
// to the gates cycle for cycle by tests/coherent.test.ts, which also pins these to a gate-level run).

import { assemble } from './asm';
import { CohModel, ST_NAMES } from './cohmodel';

export interface CohRun {
  cycles: number;
  /** BusRd + BusRdX + BusUpgr. */
  bus: number;
  rd: number;
  rdx: number;
  upgr: number;
  invalidations: number;
  flushes: number;
  writebacks: number;
  scFails: number;
  scOk: number;
  /** Cycles the bus was busy, as a fraction of the run. */
  busyShare: number;
  stalls: [number, number];
  /** The shared memory as the program sees it (the Modified copies over memory). */
  mem: number[];
  halted: boolean;
}

const cache = new Map<string, CohRun>();

export function runCoherent(source: string, opts: { coherent?: boolean; max?: number } = {}): CohRun {
  const key = `${opts.coherent === false ? 'n' : 'c'}${opts.max ?? ''}:${source}`;
  let r = cache.get(key);
  if (r) return r;
  const m = new CohModel(assemble(source).words, { coherent: opts.coherent });
  for (let c = 0; c < (opts.max ?? 50000) && !m.halted; c++) m.step();
  const s = m.s;
  cache.set(key, r = {
    cycles: m.cycles, bus: s.tx.rd + s.tx.rdx + s.tx.upgr, rd: s.tx.rd, rdx: s.tx.rdx, upgr: s.tx.upgr, invalidations: s.invalidations, flushes: s.flushes,
    writebacks: s.writebacks, scFails: s.scFails[0] + s.scFails[1], scOk: s.scOk[0] + s.scOk[1], busyShare: s.cycles ? s.busBusy / s.cycles : 0,
    stalls: [s.stalls[0], s.stalls[1]], mem: m.memoryView(), halted: m.halted,
  });
  return r;
}

/** The state letters of the line at a byte address in each cache once the program has halted (or after `cycles`). */
export function lineStates(source: string, addr: number, opts: { coherent?: boolean; cycles?: number } = {}): [string, string] {
  const m = new CohModel(assemble(source).words, { coherent: opts.coherent });
  for (let c = 0; c < (opts.cycles ?? 50000) && !m.halted; c++) m.step();
  const set = (addr >>> 4) & 3, tag = (addr >>> 6) & (2 ** m.t - 1);
  return [0, 1].map((i) => { const c = m.s.caches[i]; return c.st[set] !== 0 && c.tag[set] === tag ? ST_NAMES[c.st[set]] : 'I'; }) as [string, string];
}
