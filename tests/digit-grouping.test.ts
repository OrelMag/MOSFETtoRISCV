// One digit-grouping rule on the whole site (sim/numfmt.ts, SI / ISO 80000): groups of three joined by U+202F, and only from five
// integer digits up: "1312", "11 725". A four-digit number grouped ("4 214") sits badly beside "1312" on the same page.
// This reads every chapter's prose (steps, layers, tours, quizzes, recaps) and fails on a grouped four-digit integer.

import { beforeAll, describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { groupDigits, groupFixed, groupNum } from '../src/sim/numfmt';
import { BOOK_TIMEOUT, warmBook, WARM_TIMEOUT } from './warmbook';
import { tick } from './yieldtick';

/** A lone digit, a thin / narrow space and exactly three digits, not part of a longer run ("11 725", "1 234 567" are fine). */
export const FOUR_DIGIT_GROUP = /(?<![\d.,  ])\d[  ]\d{3}(?![\d  ])/g;

/** A comma-grouped integer ("1,312", "11,725", "1,234,567"): one to three digits, then comma-and-three-digit groups, bounded by non-digits and not a decimal's tail. */
export const COMMA_GROUP = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?!\d|,\d)/g;

const plain = (s: string): string => s.replace(/<[^>]*>/g, '\u0001');

/** Every string a chapter shows: JSON takes the getters and the nested quiz / layer / tour texts, not the functions. */
function textsOf(value: unknown): string[] {
  const out: string[] = [];
  JSON.stringify(value, (_k, v) => { if (typeof v === 'string') out.push(v); return v; });
  return out;
}

describe('digit grouping', () => {
  beforeAll(warmBook, WARM_TIMEOUT);

  it('groupNum follows groupDigits: five digits and up, decimals ungrouped, rounding as toLocaleString', () => {
    const N = ' ';
    expect(groupNum(1312)).toBe('1312');
    expect(groupNum(9999)).toBe('9999');
    expect(groupNum(11725)).toBe(`11${N}725`);
    expect(groupNum(1234567)).toBe(`1${N}234${N}567`);
    expect(groupNum(-12345)).toBe(`-12${N}345`);
    expect(groupNum(12345.6789)).toBe(`12${N}345.679`);
    expect(groupNum(1234.5)).toBe('1234.5');
    expect(groupNum(123456789012345678901n)).toBe(`123${N}456${N}789${N}012${N}345${N}678${N}901`);
    expect(groupNum(65536)).toBe(groupDigits(65536));
    expect(groupFixed(65536.5, 1)).toBe(`65${N}536.5`);
  });

  it('the pattern catches a grouped four-digit integer and nothing else', () => {
    const hit = (s: string) => (s.match(FOUR_DIGIT_GROUP) ?? []).length;
    expect(hit('4 214 NANDs')).toBe(1);
    expect(hit('4 214 NANDs')).toBe(1);
    expect(hit('1312 and 11 725 and 1 234 567 and 0.123 456')).toBe(0);
    expect(hit('(4 214.5)')).toBe(1);
  });

  it('the comma pattern catches grouped integers and not lists or coordinates', () => {
    const hit = (s: string) => (s.match(COMMA_GROUP) ?? []).length;
    expect(hit('1,312 NANDs')).toBe(1);
    expect(hit('11,725 and 1,234,567')).toBe(2);
    expect(hit('(3,4) and 1, 2, 3 and a,b and 0.5,123 and 12,34')).toBe(0);
  });

  it('no chapter text groups a four-digit integer', async () => {
    const bad: string[] = [];
    for (const c of chapters) {
      for (const t of textsOf(c)) {
        // (a coordinate pair "(98,102)" is two numbers, not one grouped)
        for (const m of plain(t).matchAll(COMMA_GROUP)) if (!(plain(t)[(m.index ?? 0) - 1] === '(' && plain(t)[(m.index ?? 0) + m[0].length] === ')')) bad.push(`${c.id}: comma group …${plain(t).slice(Math.max(0, (m.index ?? 0) - 25), (m.index ?? 0) + 30)}…`);
        for (const m of plain(t).matchAll(FOUR_DIGIT_GROUP)) {
          const at = m.index ?? 0;
          bad.push(`${c.id}: …${plain(t).slice(Math.max(0, at - 25), at + 30).replace(/[  ]/g, '␣')}…`);
        }
      }
      await tick();
    }
    expect(bad).toEqual([]);
  }, BOOK_TIMEOUT);
});
