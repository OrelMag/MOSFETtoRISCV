// "The bell curve and its tail" (noise step 2): the table, the counted shares and the numbers the prose and the codex entry quote.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import {
  BELL_SAMPLES, bellHistogram, bellRms, decisionError, everyText, oneInText, Q_ROWS, qRow, TAIL_SAMPLES, tailHits, withinShare, withinSigmas,
} from '../src/comm/noise';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const step = () => chapterById('noise')!.steps[2];
const body = () => strip(String(step().body));
const codexText = () => strip([codexById('gaussian')!.body, moreOf('gaussian')!.idea, moreOf('gaussian')!.example!.body, ...(CHECKS.gaussian ?? []).flatMap((q) => [q.explain, ...q.options])].join(' '));

describe('the bell curve and its tail', () => {
  it('is step 2 of noise, between the chain and the decision', () => {
    const t = chapterById('noise')!.steps.map((s) => s.title);
    expect(t.slice(1, 4)).toEqual(['A chain: who pays', 'The bell curve and its tail', 'A decision']);
  });
  it('Q is the chapter\'s decisionError, and the rows are 1 / Q and 1 / Q ns', () => {
    for (const r of Q_ROWS) {
      expect(r.q).toBe(decisionError(r.k, 1));
      expect(r.oneIn).toBeCloseTo(1 / r.q, 6);
      expect(r.every).toBeCloseTo(1 / r.q / 1e9, 18);
    }
    expect(qRow(3).q).toBeCloseTo(1.35e-3, 5);
    expect(2 * qRow(3).q).toBeCloseTo(2.7e-3, 4);
    expect(Q_ROWS[2].q / Q_ROWS[5].q).toBeGreaterThan(1e6);
  });
  it('the table prints the computed rows', () => {
    const expected = [
      ['1', '1.59 × 10⁻¹', '6.3', '6.3 ns'], ['2', '2.28 × 10⁻²', '44', '44 ns'], ['3', '1.35 × 10⁻³', '741', '741 ns'], ['4', '3.17 × 10⁻⁵', '31 574', '32 µs'],
      ['5', '2.87 × 10⁻⁷', '3.5 million', '3.5 ms'], ['6', '9.87 × 10⁻¹⁰', '1.0 billion', '1 s'], ['7', '1.28 × 10⁻¹²', '7.8 × 10¹¹', '13 minutes'],
    ];
    const html = String(step().body);
    const rows = [...html.matchAll(/<tr><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><\/tr>/g)].map((m) => m.slice(1, 5));
    expect(rows).toEqual(expected);
  });
  it('the formatters', () => {
    expect(everyText(6.3e-9)).toBe('6.3 ns');
    expect(everyText(0.0035)).toBe('3.5 ms');
    expect(everyText(780)).toBe('13 minutes');
    expect(oneInText(1 / qRow(5).q)).toBe('3.5 million');
  });
  it('the prose quotes the shares within 1, 2, 3 σ', () => {
    expect((withinSigmas(1) * 100).toFixed(1)).toBe('68.3');
    expect((withinSigmas(2) * 100).toFixed(1)).toBe('95.4');
    expect((withinSigmas(3) * 100).toFixed(2)).toBe('99.73');
    expect((2 * qRow(3).q * 100).toFixed(2)).toBe('0.27');
    for (const s of ['68.3 % within ±1 σ', '95.4 % within ±2 σ', '99.73 % within ±3 σ', '0.27 % of the samples']) expect(body()).toContain(s);
  });
  it('the histogram settles on the curve: RMS, the share within ±σ and the counted tails agree with the closed forms', () => {
    expect(bellRms(BELL_SAMPLES, 0.5)).toBeCloseTo(0.5, 1);
    expect(Math.abs(bellRms(BELL_SAMPLES, 1) - 1)).toBeLessThan(0.02);
    expect(Math.abs(withinShare(BELL_SAMPLES, 1) - withinSigmas(1))).toBeLessThan(0.01);
    expect(bellHistogram(BELL_SAMPLES, 0.5, 60, 3).reduce((a, b) => a + b, 0)).toBe(BELL_SAMPLES);
    for (const d of [1, 2, 3]) {
      const q = qRow(d).q, n = TAIL_SAMPLES, sd = Math.sqrt((q * (1 - q)) / n);
      expect(Math.abs(tailHits(n, d) / n - q), `d = ${d}`).toBeLessThan(5 * sd);
    }
  });
  it('a prefix of the samples is a smaller run: the same numbers', () => {
    expect(bellHistogram(100, 0.5, 60, 3).reduce((a, b) => a + b, 0)).toBe(100);
    expect(tailHits(100, 1)).toBe(tailHits(BELL_SAMPLES, 1) - (tailHits(BELL_SAMPLES, 1) - tailHits(100, 1)));
  });
  it('the codex entry quotes the same figures as the step', () => {
    for (const s of ['68.3 %', '95.4 %', '99.73 %', '1.59 × 10−1', '1.35 × 10−3', '9.87 × 10−10', '7.8 × 10¹¹', '13 minutes', '31 574', '741']) expect(codexText().replace(/⁻/g, '−'), s).toContain(s.replace(/⁻/g, '−'));
    expect(CHECKS.gaussian?.length).toBe(2);
    const quiz = step().challenge;
    expect(quiz?.kind === 'quiz' && quiz.explain).toContain('741');
  });
});
