// dsp/fixed.ts against exact integers, and lib/fixedpt.ts against dsp/fixed.ts on every input of a small word and random ones of a large one.
import { describe, expect, it } from 'vitest';
import { addOverflows, fit, fracMul, fromFixed, guardBits, qName, satAdd, satTo, shiftRound, toFixed, wordMax, wordMin, wrapTo } from '../src/dsp/fixed';
import { clampWord, fracMultiplier, satAdder } from '../src/lib/fixedpt';
import { evalOnce, simulate } from '../src/sim/harness';

const uns = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;

describe('words', () => {
  it('wrap is BigInt.asIntN, on the edges and at random', () => {
    let s = 1;
    const vals = [0, 1, -1, 127, 128, -128, -129, 255, 256, 32767, 32768, -32769];
    for (let i = 0; i < 2000; i++) { s = (s * 1664525 + 1013904223) >>> 0; vals.push(s - 2 ** 31); }
    for (const w of [2, 4, 8, 16, 24]) for (const v of vals) expect(wrapTo(v, w), `${v} in ${w}`).toBe(Number(BigInt.asIntN(w, BigInt(v))));
  });
  it('saturate stays within the word and leaves what fits alone', () => {
    for (let v = -300; v <= 300; v++) {
      const y = satTo(v, 8);
      expect(y).toBeGreaterThanOrEqual(wordMin(8)); expect(y).toBeLessThanOrEqual(wordMax(8));
      if (v >= -128 && v <= 127) expect(y).toBe(v);
      expect(fit(v, 8, 'sat')).toBe(y);
    }
  });
  it('names a format with the sign counted in its integer part', () => {
    expect(qName({ w: 16, f: 15 })).toBe('Q1.15');
    expect(fromFixed(toFixed(0.5, { w: 16, f: 15 }), { w: 16, f: 15 })).toBe(0.5);
    expect(toFixed(1, { w: 16, f: 15 })).toBe(32767);
    expect(toFixed(1, { w: 16, f: 15 }, 'wrap')).toBe(-32768);
    expect(guardBits(256)).toBe(8);
    expect(guardBits(257)).toBe(9);
  });
});

describe('rounding', () => {
  it('each mode, on every tie and non-tie, against exact rationals', () => {
    for (let v = -64; v <= 64; v++) for (const s of [1, 2, 3]) {
      const p = 2 ** s, fl = Math.floor(v / p), rem = v - fl * p;
      expect(shiftRound(v, s, 'trunc')).toBe(fl);
      expect(shiftRound(v, s, 'half-up')).toBe(2 * rem >= p ? fl + 1 : fl);
      const c = 2 * rem > p ? fl + 1 : 2 * rem < p ? fl : (fl % 2 === 0 ? fl : fl + 1);
      expect(shiftRound(v, s, 'convergent'), `${v} >> ${s}`).toBe(c);
    }
  });
  it('truncation is biased by nearly half a step, half-up by a little from its ties, convergent not at all', () => {
    // over every remainder of a 3-bit drop, in units of the input's step
    const mean = (m: 'trunc' | 'half-up' | 'convergent') => { let e = 0, n = 0; for (let v = -4096; v < 4096; v++) { e += shiftRound(v, 3, m) * 8 - v; n++; } return e / n; };
    expect(mean('trunc')).toBeCloseTo(-3.5, 9);
    expect(mean('half-up')).toBeCloseTo(0.5, 9);
    expect(mean('convergent')).toBeCloseTo(0, 9);
  });
});

describe('the gates equal the model', () => {
  it('clamp, every word', () => {
    for (const w of [4, 8]) {
      const sim = simulate(clampWord(w));
      for (let x = 0; x < 2 ** (w + 1); x++) {
        const v = wrapTo(x, w + 1), [y, sat] = evalOnce(sim, [x]);
        expect(wrapTo(y, w), `${v}`).toBe(satTo(v, w));
        expect(sat).toBe(v > wordMax(w) || v < wordMin(w) ? 1 : 0);
      }
    }
  });
  it('saturating adder, every pair at 6 bits, random at 16', () => {
    let sim = simulate(satAdder(6));
    for (let a = -32; a < 32; a++) for (let b = -32; b < 32; b++) {
      const [y, sat] = evalOnce(sim, [uns(a, 6), uns(b, 6)]);
      expect(wrapTo(y, 6)).toBe(satAdd(a, b, 6));
      expect(sat).toBe(addOverflows(a, b, 6) ? 1 : 0);
    }
    sim = simulate(satAdder(16));
    let s = 7;
    for (let i = 0; i < 400; i++) {
      s = (s * 1664525 + 1013904223) >>> 0; const a = wrapTo(s >>> 8, 16);
      s = (s * 1664525 + 1013904223) >>> 0; const b = wrapTo(s >>> 8, 16);
      expect(wrapTo(evalOnce(sim, [uns(a, 16), uns(b, 16)])[0], 16)).toBe(satAdd(a, b, 16));
    }
  });
  it('fraction multiplier, every pair at 6 bits, the corners and random at 12', () => {
    let sim = simulate(fracMultiplier(6));
    for (let a = -32; a < 32; a++) for (let b = -32; b < 32; b++) {
      const [y, sat] = evalOnce(sim, [uns(a, 6), uns(b, 6)]);
      expect(wrapTo(y, 6), `${a} × ${b}`).toBe(fracMul(a, b, 6));
      expect(sat).toBe(a === -32 && b === -32 ? 1 : 0);
    }
    sim = simulate(fracMultiplier(12));
    const corner = [-2048, -2047, -1, 0, 1, 2047];
    let s = 3;
    const pairs: [number, number][] = corner.flatMap((a) => corner.map((b): [number, number] => [a, b]));
    for (let i = 0; i < 100; i++) { s = (s * 1664525 + 1013904223) >>> 0; const a = wrapTo(s >>> 10, 12); s = (s * 1664525 + 1013904223) >>> 0; pairs.push([a, wrapTo(s >>> 10, 12)]); }
    for (const [a, b] of pairs) expect(wrapTo(evalOnce(sim, [uns(a, 12), uns(b, 12)])[0], 12), `${a} × ${b}`).toBe(fracMul(a, b, 12));
  });
  it('−1 × −1 is the only product that needs the clamp', () => {
    for (let a = -128; a < 128; a++) for (let b = -128; b < 128; b++) {
      const raw = shiftRound(a * b, 7, 'half-up');
      expect(raw > 127 || raw < -128, `${a} × ${b}`).toBe(a === -128 && b === -128);
    }
  });
});
