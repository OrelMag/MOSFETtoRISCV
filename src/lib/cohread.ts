// Reading the coherent dual-core's state out of a running simulation (the Coherence panel, the tests): the caches' lines
// and reservations, the shared memory. regfileMP's registers are u1 … uN (u0 is the write decoder).

import { SETS } from '../riscv/cohmodel';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';

type S = Pick<Sim, 'getBits'>;

export interface HwCache {
  st: number[];
  tag: number[];
  /** 16 words, set × 4 + word. */
  data: number[];
  resV: number;
  resLine: number;
  snoopSt: number[];
  snoopTag: number[];
}

const word = (sim: S, n: HierNode | undefined, port = 'q') => (n ? pack(sim.getBits(n.ports[port])) >>> 0 : 0);

export function readArray(sim: S, arr: HierNode, n: number): number[] {
  return Array.from({ length: n }, (_, i) => word(sim, arr.children!.get(`u${1 + i}`)));
}

export function readCache(sim: S, root: HierNode, i: number, K: number): HwCache {
  const c = root.children!.get(`cache${i}`)!, t = K - 4;
  const dec = (a: number[]) => ({ st: a.map((x) => (((x >>> (t + 1)) & 1) ? 2 : ((x >>> t) & 1) ? 1 : 0)), tag: a.map((x) => x & (2 ** t - 1)) });
  const ct = dec(readArray(sim, c.children!.get('ctags')!, SETS)), sn = c.children!.get('stags'), stg = sn ? dec(readArray(sim, sn, SETS)) : ct;
  const res = c.children!.get('res')!;
  return { st: ct.st, tag: ct.tag, data: readArray(sim, c.children!.get('data')!, 16), resV: word(sim, res.children!.get('rv')), resLine: word(sim, res.children!.get('rl')), snoopSt: stg.st, snoopTag: stg.tag };
}

export function readMem(sim: S, root: HierNode, K: number): number[] {
  const ram = root.children!.get('dm')!.children!.get('ram')!;
  return Array.from({ length: 2 ** K }, (_, i) => word(sim, ram.children!.get(`w${i}`)));
}
