// Codes near the limit on the page: what its challenges and panels claim, and its place in the book.
import { describe, expect, it } from 'vitest';
import { chCodes } from '../src/chapters/ch-comm-codes';
import { chErrors } from '../src/chapters/ch-comm-errors';
import { numOf } from '../src/chapters/order';
import { moveStep } from '../src/chapters/stepmoves';
import { rsDecode } from '../src/comm/rs';
import { Bp, concatTrial, deAwgn, ldpcTrial, regularCode, syndromeOk } from '../src/comm/ldpc';
import { convSoftBound } from '../src/comm/ber';
import { CONV_K7 } from '../src/comm/conv';
import { rsLatency, rsRtlDecode } from '../src/comm/rsrtl';
import { AWGN_SIGMA } from '../src/comm/ldpc';
import { CONCAT_MEASURED, CONCAT_POINTS, CONCAT_WORDS, GOSSIP_PAIR, GOSSIP_SEED, rsWordHit } from '../src/widgets/codes2';
import { RS_CHECK, RS_MESSAGE } from '../src/widgets/codes';
import { tick } from './yieldtick';

const CW = [...RS_MESSAGE, ...RS_CHECK];

describe('the chapter', () => {
  it('holds the moved steps at the places the table says, and follows When bits go wrong', () => {
    for (const [i, t] of [[9, 'A code with memory'], [10, 'The Viterbi decoder'], [11, 'Reed-Solomon: errors in bytes'], [12, 'Bursts: interleaving'], [13, 'How far from Shannon']] as const) {
      const at = moveStep('errors', i, 1);
      expect(at.chapter).toBe('codes');
      expect(chCodes.steps[at.step].title).toBe(t);
    }
    expect(numOf('codes')).toBe(numOf('errors') + 1);
    expect(chErrors.steps.at(-1)!.title).toBe('Correcting instead of asking');
    expect(chCodes.steps.length).toBeLessThan(15);
  });
  it('every step has text, and something to look at, and a check', () => {
    for (const s of chCodes.steps) { expect(s.body.length, s.title).toBeGreaterThan(200); expect(!!s.scene !== !!s.widget, s.title).toBe(true); expect(!!s.challenge, s.title).toBe(true); }
  });
});

describe('what the decoder steps say', () => {
  it('the panel\'s damage: up to five bytes come back, six to nine are refused, as the software decoder does', () => {
    for (let n = 0; n <= 9; n++) {
      const hw = rsRtlDecode(rsWordHit(n), 10), soft = rsDecode(rsWordHit(n), 10);
      expect(hw.cycles, `${n} hit`).toBe(rsLatency(10, 26));
      expect(hw.fail, `${n} hit`).toBe(soft.word === null);
      if (n <= 5) { expect(hw.fail, `${n} hit`).toBe(false); expect(hw.out).toEqual(CW); } else expect(hw.fail, `${n} hit`).toBe(true);
    }
  });
});

describe('what the LDPC steps say', () => {
  it('the small graph: the two wrong bits come back', () => {
    const t = regularCode(12, 3, 6, GOSSIP_SEED);
    const ch = new Float64Array(12).fill(2.5);
    GOSSIP_PAIR.forEach((v) => { ch[v] = -1; });
    const bp = new Bp(t, ch);
    expect(bp.hard.reduce((a, b) => a + b, 0)).toBe(2);
    for (let i = 0; i < 20 && !bp.ok; i++) bp.iterate();
    expect(syndromeOk(t, bp.hard)).toBe(true);
    expect(bp.hard.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('the threshold bracket quoted is the one the recursion gives', () => {
    expect(deAwgn(AWGN_SIGMA[0], 3, 6, { rounds: 3000 }).converged).toBe(true);
    expect(deAwgn(AWGN_SIGMA[1], 3, 6, { rounds: 3000 }).converged).toBe(false);
  });
  it('the concatenated link: the words the step quotes, at each depth', async () => {
    const run = async (depth: number, frames: number, db = 2.3) => { let failed = 0, words = 0; for (let f = 0; f < 8; f++) for (let g = 0; g < 6; g++) { const r = concatTrial(db, { depth, frames, seed: 300 + f + 100 * g }); failed += r.failed; words += r.words; await tick(); } return [failed, words]; };
    const got = [await run(1, 8), await run(2, 4), await run(8, 1)];
    // eslint-disable-next-line no-console
    console.log('concat at 2.3 dB', got);
    expect(got.map((x) => x[1])).toEqual([CONCAT_WORDS, CONCAT_WORDS, CONCAT_WORDS]);
    expect(got.map((x) => x[0])).toEqual(CONCAT_MEASURED);
    expect((await run(8, 1, 2.2))[0] / CONCAT_WORDS).toBe(CONCAT_POINTS[0][1]);
    expect(got[2][0] / CONCAT_WORDS).toBe(CONCAT_POINTS[1][1]);
  }, 300000);
  it('the waterfall\'s text: 504 bits beat K = 7 at 2.4 dB, and 8064 bits at 1.6 dB beat 504', () => {
    const short = regularCode(504, 3, 6, 5), long = regularCode(8064, 3, 6, 5), frames = (n: number) => Math.ceil(200000 / n);
    const s24 = ldpcTrial(short, 2.4, frames(504), { seed: 1, maxIter: 60 }), s16 = ldpcTrial(short, 1.6, frames(504), { seed: 1, maxIter: 60 }), l16 = ldpcTrial(long, 1.6, frames(8064), { seed: 1, maxIter: 60 });
    expect(s24.ber).toBeGreaterThan(3e-4); expect(s24.ber).toBeLessThan(1e-3);
    expect(convSoftBound(CONV_K7, 2.4)).toBeGreaterThan(5e-3);
    expect(s16.ber).toBeGreaterThan(0.01);
    expect(l16.errors).toBe(0);
  });
});
