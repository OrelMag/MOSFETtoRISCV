import { describe, expect, it } from 'vitest';
import { angleOf, arrow, binChain, cosinePair, expj, lengthOf, polar, product, times } from '../src/comm/arrows';
import { cx, dft } from '../src/comm/fourier';
import { BLOCK, samplesOf, SIGNALS } from '../src/comm/signals';
import { chapterById } from '../src/chapters';

const sig = (id: string) => samplesOf(SIGNALS.find((s) => s.id === id)!);

describe('arrows: the numbers the step quotes', () => {
  it('j is a quarter turn and j × j = −1', () => {
    const j = arrow(0, 1);
    expect(times(j, j)).toEqual({ re: -1, im: 0 });
    let a = arrow(1);
    const seen: [number, number][] = [];
    for (let i = 0; i < 5; i++) { seen.push([a.re + 0, a.im + 0]); a = times(a, j); }
    expect(seen.map(([r, i]) => [Math.abs(r) + 0 === 0 ? 0 : r, Math.abs(i) === 0 ? 0 : i])).toEqual([[1, 0], [0, 1], [-1, 0], [0, -1], [1, 0]]); // 1, j, −1, −j, 1
  });

  it('(2 + j)(1 + j) = 1 + 3j: lengths multiply, angles add', () => {
    const r = product(arrow(2, 1), arrow(1, 1));
    expect(r.p).toEqual({ re: 1, im: 3 });
    expect(r.lengths[0]).toBeCloseTo(Math.sqrt(5), 12);
    expect(r.lengths[0].toFixed(2)).toBe('2.24');
    expect(r.lengths[1].toFixed(2)).toBe('1.41');
    expect(r.lengths[2].toFixed(2)).toBe('3.16');
    expect(r.lengths[2]).toBeCloseTo(r.lengths[0] * r.lengths[1], 12);
    expect(r.angles.map((a) => a.toFixed(1))).toEqual(['26.6', '45.0', '71.6']);
    expect(r.angles[2]).toBeCloseTo(r.angles[0] + r.angles[1], 10);
  });

  it('the quiz: (1 + j)(1 − j) = 2', () => {
    const r = product(arrow(1, 1), arrow(1, -1));
    expect(r.p.re).toBeCloseTo(2, 12);
    expect(Math.abs(r.p.im)).toBeLessThan(1e-12);
    expect(r.angles[1]).toBeCloseTo(-45, 10);
  });

  it('e^jθ at 0, π/2, π; e^jα e^jβ = e^j(α+β)', () => {
    expect(expj(0)).toEqual({ re: 1, im: 0 });
    expect(expj(Math.PI / 2).re).toBeCloseTo(0, 12);
    expect(expj(Math.PI / 2).im).toBeCloseTo(1, 12);
    expect(expj(Math.PI).re).toBeCloseTo(-1, 12);
    const p = times(expj(0.7), expj(1.1));
    expect(p.re).toBeCloseTo(expj(1.8).re, 12);
    expect(p.im).toBeCloseTo(expj(1.8).im, 12);
    expect(lengthOf(polar(3, 30))).toBeCloseTo(3, 12);
    expect(angleOf(polar(3, 30))).toBeCloseTo(30, 10);
  });

  it('a cosine is two arrows of length ½ and their sum is real', () => {
    for (const th of [0, 0.4, 1.9, 3.3]) {
      const c = cosinePair(th);
      expect(lengthOf(c.plus)).toBeCloseTo(0.5, 12);
      expect(lengthOf(c.minus)).toBeCloseTo(0.5, 12);
      expect(c.sum.im).toBeCloseTo(0, 12);
      expect(c.sum.re).toBeCloseTo(Math.cos(th), 12);
    }
  });
});

describe('arrows: a bin is one arrow', () => {
  it('the chain equals the DFT by definition', () => {
    for (const id of ['tone', 'two', 'square', 'pulse', 'burst']) {
      const x = sig(id), X = dft(cx(x));
      for (const k of [0, 1, 8, 9, 24, 40, 128]) {
        const b = binChain(x, k);
        expect(b.total.re).toBeCloseTo(X.re[k], 8);
        expect(b.total.im).toBeCloseTo(X.im[k], 8);
        expect(b.partial.length).toBe(BLOCK + 1);
      }
    }
  });

  it('one tone, bin 8: an arrow of length N / 2 = 128 straight down; bin 9 closes to 0', () => {
    const t = sig('tone');
    const b8 = binChain(t, 8), b9 = binChain(t, 9);
    expect(b8.length).toBeCloseTo(128, 8);
    expect(b8.amplitude).toBeCloseTo(1, 10);
    expect(b8.phase).toBeCloseTo(-90, 8);
    expect(b9.length).toBeLessThan(1e-9);
    // every term of the chain points the same way: sin(2π·8t) is cos with φ = −90°, turned back by exactly as much as it advances... half of them
    // (the other arrow's terms go round and cancel), so the chain's length is N / 2, not N
    expect(b8.partial[BLOCK].im).toBeCloseTo(-128, 8);
  });

  it('square wave: bin 8 about 163, bin 24 about 55, a third as 1 / k says', () => {
    const q = sig('square');
    const a = binChain(q, 8).length, b = binChain(q, 24).length;
    expect(a).toBeCloseTo(163.24, 1);
    expect(b).toBeCloseTo(55.12, 1);
    expect(Math.round(a)).toBe(163);
    expect(Math.round(b)).toBe(55);
    expect(b / a).toBeCloseTo(1 / 3, 1);
  });

  it('A cos(2πkn/N + φ): length (N / 2) A and angle φ', () => {
    const N = 256, A = 0.6, phi = 0.9, k = 5;
    const x = Array.from({ length: N }, (_, n) => A * Math.cos((2 * Math.PI * k * n) / N + phi));
    const b = binChain(x, k);
    expect(b.length).toBeCloseTo((N / 2) * A, 8);
    expect(b.amplitude).toBeCloseTo(A, 10);
    expect(b.phase).toBeCloseTo((phi * 180) / Math.PI, 8);
  });
});

describe('the codex quiz numbers', () => {
  it('length 6 at 70 degrees; a 64-sample bin of 16 is a cosine of 0.5', () => {
    const p = product(polar(2, 30), polar(3, 40));
    expect(lengthOf(p.p)).toBeCloseTo(6, 10);
    expect(angleOf(p.p)).toBeCloseTo(70, 8);
    const x = Array.from({ length: 64 }, (_, n) => 0.5 * Math.cos((2 * Math.PI * 5 * n) / 64));
    const b = binChain(x, 5);
    expect(b.length).toBeCloseTo(16, 9);
    expect(b.phase).toBeCloseTo(0, 8);
  });
});

describe('the step as shipped', () => {
  const step = () => chapterById('signals')!.steps[1];
  const text = () => String(step().body).replace(/<[^>]+>/g, '');
  it('is step 1 of signals, with the four tabs and a quiz whose answer is first', () => {
    expect(step().title).toBe('Arrows that turn: complex numbers');
    expect(typeof step().widget).toBe('function');
    expect(step().challenge?.kind).toBe('quiz');
  });
  it('quotes what the arithmetic gives', () => {
    const r = product(arrow(2, 1), arrow(1, 1));
    const t = text();
    for (const s of [r.lengths[0].toFixed(2), r.lengths[1].toFixed(2), r.lengths[2].toFixed(2), r.angles[0].toFixed(1), r.angles[2].toFixed(1)]) expect(t).toContain(s);
    expect(t).toContain('128');
    const q = sig('square');
    expect(t).toContain(String(Math.round(binChain(q, 8).length)));
    expect(t).toContain(String(Math.round(binChain(q, 24).length)));
  });
});
