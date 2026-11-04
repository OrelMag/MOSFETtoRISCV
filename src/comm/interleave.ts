// Interleaving (DOM-free): a block interleaver and a burst channel, for chapter 47's last step. A burst of b channel bits lands at most
// ⌈b / D⌉ bits in any of the D code words written across it, so a code that corrects t in a word survives bursts up to D · t. It costs a
// buffer of D words at each end and D words of delay, and it adds no redundancy.

import { secdedDecode, secdedEncode } from './fec';
import { rng } from '../phys/line';

/** Channel order: D words of n bits are read out column by column. Returns for channel position c the [word, bit] it carries. */
export const placeOf = (c: number, D: number): [number, number] => [c % D, Math.floor(c / D)];

/** The words as one channel stream. */
export function interleave(words: readonly (readonly number[])[]): number[] {
  const D = words.length, n = words[0].length, out = new Array<number>(D * n);
  for (let c = 0; c < D * n; c++) { const [w, b] = placeOf(c, D); out[c] = words[w][b]; }
  return out;
}

export function deinterleave(stream: readonly number[], D: number): number[][] {
  const n = stream.length / D, words = Array.from({ length: D }, () => new Array<number>(n).fill(0));
  stream.forEach((v, c) => { const [w, b] = placeOf(c, D); words[w][b] = v; });
  return words;
}

/** The most errors any word sees from a burst of b consecutive channel bits. */
export const worstPerWord = (b: number, D: number): number => Math.ceil(b / D);

/** The longest burst every word survives, for a code correcting t per word. */
export const burstTolerance = (D: number, t: number): number => D * t;

/**
 * Gilbert-Elliott: a good state with no errors, a bad state flipping each bit with probability `pBad`, entered with probability
 * `enter` per bit and left with `leave`. Mean burst length 1 / leave; the long-run error rate is pBad · enter / (enter + leave).
 */
export function burstChannel(seed: number, enter: number, leave: number, pBad = 0.5): () => number {
  const u = rng(seed);
  let bad = false;
  return () => {
    bad = bad ? u() >= leave : u() < enter;
    return bad && u() < pBad ? 1 : 0;
  };
}

export const burstRate = (enter: number, leave: number, pBad = 0.5): number => (pBad * enter) / (enter + leave);

export interface BurstRun { words: number; failed: number; rate: number }

/** SEC-DED words of k data bits through the channel, D words interleaved: how many words come out wrong. */
export function secdedOverBursts(D: number, groups: number, enter: number, leave: number, seed = 1, k = 64, pBad = 0.5): BurstRun {
  const data = rng(seed + 1), ch = burstChannel(seed, enter, leave, pBad);
  let failed = 0, words = 0;
  for (let g = 0; g < groups; g++) {
    const ds = Array.from({ length: D }, () => Array.from({ length: k }, () => (data() < 0.5 ? 1 : 0)));
    const rx = interleave(ds.map((d) => secdedEncode(d))).map((v) => v ^ ch());
    deinterleave(rx, D).forEach((w, i) => { words++; const r = secdedDecode(w, k); if (r.data.some((v, j) => v !== ds[i][j])) failed++; });
  }
  return { words, failed, rate: failed / words };
}
