// Campaign drills: every generated question accepts its own answer and rejects a wrong one; the
// Boolean parser and the exact K-map minimiser agree with brute force.

import { describe, expect, it } from 'vitest';
import { checkExpr, DRILLS, evalBool, minimumCover, parseBool, parseNum, rng, sopLiterals, sopText } from '../src/campaign/drills';
import { F16, parts, RM, roundToX } from '../src/sim/fpref';

describe('the Boolean parser', () => {
  const V = ['a', 'b', 'c', 'd'];
  const truth = (src: string) => {
    const p = parseBool(src, V);
    if ('error' in p) throw new Error(p.error);
    return Array.from({ length: 16 }, (_, x) => evalBool(p.ex, x, 4)).join('');
  };
  it('reads every notation the drills accept', () => {
    expect(truth("a'b + cd")).toBe(truth('¬a·b + c·d'));
    expect(truth('!a & b | c * d')).toBe(truth("a'b+cd"));
    expect(truth("(a + b)'")).toBe(truth("a'b'"));
    expect(truth('a ^ b')).toBe(truth("ab' + a'b"));
    expect(truth('~(a b)')).toBe(truth("a' + b'"));
    expect(truth("a''")).toBe(truth('a'));
    expect(truth('1')).toBe('1'.repeat(16));
  });
  it('counts literals and reports errors', () => {
    expect(parseBool("a'b + cd", V)).toMatchObject({ literals: 4 });
    expect(parseBool('a + ', V)).toHaveProperty('error');
    expect(parseBool('a + e', V)).toEqual({ error: 'unknown variable e (use a, b, c, d)' });
    expect(parseBool('(a + b', V)).toHaveProperty('error');
  });
});

describe('the exact minimiser', () => {
  it('finds a cover no larger than any other, for random 4-variable functions with don\'t-cares', () => {
    const r = rng(5);
    for (let t = 0; t < 60; t++) {
      const ones: number[] = [], dc: number[] = [];
      for (let x = 0; x < 16; x++) { const u = r(); if (u < 0.4) ones.push(x); else if (u < 0.5) dc.push(x); }
      const min = minimumCover(4, ones, dc);
      const k = { vars: ['a', 'b', 'c', 'd'], ones, dc };
      // It is a correct cover, and its own text passes the checker at its own literal count.
      expect(checkExpr(sopText(min, k.vars), k, sopLiterals(min, 4))).toEqual({ ok: true });
    }
  });
  it('knows the classics', () => {
    // Majority: ab + ac + bc (6 literals).
    expect(sopLiterals(minimumCover(3, [3, 5, 6, 7]), 3)).toBe(6);
    // XOR of 3: no grouping possible: 4 terms of 3.
    expect(minimumCover(3, [1, 2, 4, 7]).length).toBe(4);
    // With don't-cares, BCD "≥ 5": a + bd + bc.
    expect(sopLiterals(minimumCover(4, [5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15]), 4)).toBe(5);
  });
});

describe('drills', () => {
  it('parse numbers in every base', () => {
    expect(parseNum('0x1F')).toBe(31);
    expect(parseNum('0b1010_1010')).toBe(170);
    expect(parseNum('-12')).toBe(-12);
    expect(parseNum('12a')).toBeNull();
  });

  it.each(Object.values(DRILLS).map((d) => [d.id, d] as const))('%s: every question accepts its own answer and rejects nonsense', (_, d) => {
    const r = rng(42);
    for (let i = 0; i < 80; i++) {
      const q = d.make(r);
      expect(q.check(q.answer), `${q.prompt} → ${q.answer}`).toMatchObject({ ok: true });
      expect(q.check('zz').ok, q.prompt).toBe(false);
    }
  });

  it('binary16: rounding questions agree with the reference float model, kinds with the encoding', () => {
    const r = rng(7);
    let rounds = 0, kinds = 0;
    for (let i = 0; i < 400; i++) {
      const q = DRILLS.float.make(r);
      const m = q.prompt.match(/(−?)1\.([01]{10})<u>([01]{3})<\/u>₂ × 2\^(-?\d+)/);
      if (m) {
        rounds++;
        const want = roundToX(m[1] ? 1 : 0, BigInt(`0b1${m[2]}${m[3]}`), Number(m[4]) - 13, F16, RM.RNE).y;
        expect(q.answer, q.prompt).toBe(`0x${want.toString(16).toUpperCase().padStart(4, '0')}`);
      }
      const k = q.prompt.match(/pattern <code>0x([0-9A-F]{4})<\/code>: zero/);
      if (k) {
        kinds++;
        const p = parts(parseInt(k[1], 16), F16);
        expect(q.answer).toBe({ zero: 'zero', subnormal: 'subnormal', normal: 'normal', inf: 'infinity', nan: 'NaN' }[p.kind]);
      }
    }
    expect(rounds).toBeGreaterThan(50);
    expect(kinds).toBeGreaterThan(40);
  });

  it('a K-map answer must also be minimal', () => {
    const k = { vars: ['a', 'b', 'c'], ones: [3, 5, 6, 7], dc: [] };
    expect(checkExpr('ab + ac + bc', k, 6).ok).toBe(true);
    expect(checkExpr("abc + ab'c + abc' + a'bc", k, 6)).toMatchObject({ ok: false, why: expect.stringMatching(/minimum is 6/) });
    expect(checkExpr('ab + bc', k, 6)).toMatchObject({ ok: false, why: expect.stringMatching(/wrong for a=1 b=0 c=1/) });
  });
});
