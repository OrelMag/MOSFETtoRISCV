// The AGC golden model (src/agc/iss.ts) and its assembler on small programs whose results are worked out by hand from
// the Block II instruction descriptions; scripts/agc/oracle.ts checks the same model against yaAGC in lock step.
import { describe, expect, it } from 'vitest';
import { AgcAsmError, assembleAgc, ropeBin } from '../src/agc/asm';
import { AgcISS, REG } from '../src/agc/iss';
import { W15, W16, val15, word15 } from '../src/agc/word';

function run(src: string) {
  const p = assembleAgc(src);
  const m = new AgcISS(p.fixed);
  const r = m.run(10_000);
  expect(r.halted).toBe(true);
  const at = (name: string) => m.e[p.symbols.get(name.toUpperCase())!];
  return { m, p, at };
}
const prog = (body: string, data = '') => `
X       = 61
Y       = 62
Z1      = 63
        SETLOC 4000
        INHINT
${body}
DONE    TCF DONE
${data}`;

describe('AGC golden model', () => {
  it('adds in one\'s complement: 5 + (−5) is −0, and stores it', () => {
    const { m, at } = run(prog('        CA K5\n        AD KM5\n        TS X', 'K5      DEC 5\nKM5     DEC -5'));
    expect(m.a).toBe(W16);
    expect(at('X')).toBe(W15);
    expect(m.mct).toBe(1 + 2 + 2 + 2 + 1);
  });

  it('TS after an overflow stores the corrected word, sets A to ±1 and skips the next instruction', () => {
    const { m, at } = run(prog('        CA MAX\n        AD ONE\n        TS X\n        TC BAD\n        TS Y', 'MAX     OCT 37777\nONE     OCT 1\nBAD     TCF BAD'));
    expect(at('X')).toBe(0); // 16384 = +1 · 2^14 + 0: the stored word is +0, the carry is in A
    expect(at('Y')).toBe(1);
    expect(m.a).toBe(1);
  });

  it('CCS: |K| − 1 into A and a skip of 0, 1, 2 or 3 for positive, +0, negative, −0', () => {
    for (const [v, skip, dabs] of [[7, 0, 6], [0, 1, 0], [-7, 2, 6], [-0.0, 3, 0], [1, 0, 0]] as const) {
      const word = Object.is(v, -0) ? W15 : word15(v);
      const { m, at } = run(prog(`        CA V\n        TS X\n        CCS X\n        TCF S0\n        TCF S1\n        TCF S2\n        TCF S3
S0      CA K0\n        TCF OUT\nS1      CA K1\n        TCF OUT\nS2      CA K2\n        TCF OUT\nS3      CA K3
OUT     TS Y\n        CA X\n        TS Z1`, `V       OCT ${word.toString(8)}\nK0      DEC 0\nK1      DEC 1\nK2      DEC 2\nK3      DEC 3`));
      expect(at('Y'), `CCS ${String(v)}`).toBe(skip);
      expect(at('Z1')).toBe(word);
      void m; void dabs;
    }
    const { m } = run(prog('        CA V\n        TS X\n        CCS X\n        NOOP\n        NOOP\n        NOOP\n        NOOP', 'V       DEC -9'));
    expect(m.a).toBe(8);
  });

  it('INDEX adds a word to the next instruction: a table lookup', () => {
    const { at } = run(prog('        CA K2\n        TS X\n        INDEX X\n        CA TAB\n        TS Y', 'K2      DEC 2\nTAB     DEC 10\n        DEC 20\n        DEC 30'));
    expect(at('Y')).toBe(30);
  });

  it('the editing registers shift what is written into them', () => {
    const { m } = run(prog('        CA K\n        TS CYR\n        CA K\n        TS SR\n        CA K\n        TS CYL\n        CA K\n        TS EDOP', 'K       OCT 40003'));
    expect(m.e[REG.CYR]).toBe(0o60001); // 100 000 000 000 011 rotated right: the 1 out of bit 0 back in at 14
    expect(m.e[REG.SR]).toBe(0o60001); // shifted right, the sign kept
    expect(m.e[REG.CYL]).toBe(0o00007); // rotated left: bit 14 back in at bit 0
    expect(m.e[REG.EDOP]).toBe(0o0); // 040003 >> 7 = 0400, masked to 7 bits
  });

  it('MP and DV work on fractions: 3/2^14 × 5 and (A, L) / K', () => {
    const { m } = run(prog('        CA K3\n        EXTEND\n        MP K5', 'K3      DEC 3\nK5      DEC 5'));
    expect([m.a, m.l]).toEqual([0, 15]);
    const n = run(prog('        CA KM3\n        EXTEND\n        MP K5', 'KM3     DEC -3\nK5      DEC 5'));
    expect(val15(n.m.l & W15)).toBe(-15);
    expect(n.m.a).toBe(W16); // −0 high word
    // (A, L) = (1, 3) = 2^14 + 3; / 5000 → 3, remainder 1387
    const d = run(prog('        CA K5000\n        TS Z1\n        CA K1\n        TS L\n        CA K3\n        XCH L\n        EXTEND\n        DV Z1','K1      DEC 1\nK3      DEC 3\nK5000   DEC 5000'));
    expect([d.m.a, d.m.l]).toEqual([3, 16387 - 15000]);
  });

  it('DAS adds A, L into a double word and leaves the overflow in A', () => {
    const { m, at } = run(prog('        CA K1\n        TS X\n        CA KMAX\n        TS Y\n        CA K2\n        TS L\n        CA K0\n        DAS X', 'K0      DEC 0\nK1      DEC 1\nK2      DEC 2\nKMAX    OCT 37777'));
    // (1, 16383) + (0, 2) = (2, 1): the low word carries into the high one
    expect([at('X'), at('Y')]).toEqual([2, 1]);
    expect([m.a, m.l]).toEqual([0, 0]);
  });

  it('TC sets Q, and TC Q (RETURN) comes back, leaving Q = 3', () => {
    const { m, at } = run(prog('        TC SUB\n        TS Y', 'SUB     CA K7\n        TS X\n        RETURN\nK7      DEC 7'));
    expect([at('X'), at('Y')]).toEqual([7, 7]);
    expect(m.q).toBe(3);
  });

  it('the assembler refuses an extracode without EXTEND, an erasable-only operand in fixed memory, an unknown symbol', () => {
    expect(() => assembleAgc('        SETLOC 4000\n        MP K\nK       DEC 1')).toThrow(AgcAsmError);
    expect(() => assembleAgc('        SETLOC 4000\n        TS K\nK       DEC 1')).toThrow(/erasable/);
    expect(() => assembleAgc('        SETLOC 4000\n        CA NOPE')).toThrow(/undefined/);
  });

  it('the rope image is yaAGC\'s: banks 2, 3, 0, 1, …, big-endian, the word shifted left one', () => {
    const p = assembleAgc('        SETLOC 4000\n        OCT 12345');
    const b = ropeBin(p.fixed);
    expect(b.length).toBe(36 * 1024 * 2);
    expect((b[0] << 8 | b[1]) >> 1).toBe(0o12345); // bank 2, word 0 first
  });
});

describe('AGC random programs (the oracle\'s)', () => {
  it('assemble, and run on the model to a halt or 5000 instructions', async () => {
    const { randomAgcProgram } = await import('../src/agc/randprog');
    let halted = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const m = new AgcISS(assembleAgc(randomAgcProgram(seed)).fixed);
      try { if (m.run(5000).halted) halted++; } catch { /* wandered into I/O: the oracle compares up to it */ }
    }
    expect(halted).toBeGreaterThan(90);
  });
});
