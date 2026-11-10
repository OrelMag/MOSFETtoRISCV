// The toy core rope behind Appendix F's weave widget (src/agc/rope.ts): inhibit decoding leaves exactly one core
// free, a read returns the woven word, rethreading a crossing changes one bit of one word, and the quoted Block II
// figures follow from R-700's (12 words a core, 16 bits: 192 sense lines; 36 864 words in 6 modules).
import { describe, expect, it } from 'vitest';
import { BLOCK2_ROPE, coresOf, readRope, rethread, weave, wordsIn, wordsOf } from '../src/agc/rope';

describe('the toy core rope', () => {
  const words = [0b1011, 0b0110, 0b1100, 0b0001, 0b0111, 0b1000, 0b0101, 0b1110];
  it('reads back every word it was woven with, one core switching each time', () => {
    const r = weave(words);
    expect(wordsOf(r)).toBe(8);
    expect(wordsIn(r)).toEqual(words);
    for (let a = 0; a < 8; a++) {
      const rd = readRope(r, a);
      expect(rd.word).toBe(words[a]);
      expect(rd.inhibits.filter((n) => n === 0)).toHaveLength(1);
      expect(rd.inhibits[rd.core]).toBe(0);
      // the other strand's lines through that core pulse too: the strand switch is what blocks them
      expect(rd.pulse[1 - rd.strand].reduce((v, p, b) => v | (p ? 1 << b : 0), 0)).toBe(words[rd.core * 2 + 1 - rd.strand]);
    }
  });
  it('a core a Hamming distance d from the address carries d driven inhibits', () => {
    const r = weave(words, 3, 1, 4);
    const rd = readRope(r, 5);
    for (let c = 0; c < coresOf(r); c++) expect(rd.inhibits[c]).toBe([0, 1, 2].filter((k) => ((c ^ 5) >> k) & 1).length);
  });
  it('rethreading a crossing flips one bit of one word and nothing else', () => {
    const r = rethread(weave(words), 2, 1, 3);
    const want = words.slice(); want[5] ^= 8;
    expect(wordsIn(r)).toEqual(want);
  });
  it('the Block II figures: 192 sense lines = 12 words × 16 bits; 6144 words and 512 cores a module', () => {
    expect(BLOCK2_ROPE.wordsPerCore * BLOCK2_ROPE.bitsRead).toBe(BLOCK2_ROPE.senseLines);
    expect(BLOCK2_ROPE.wordsPerModule).toBe(6144);
    expect(BLOCK2_ROPE.coresPerModule).toBe(512);
  });
});
