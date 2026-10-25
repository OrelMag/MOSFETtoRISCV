// Codex search: aliases, spellings that differ only in case, hyphens, apostrophes or spaces, and a ranking that puts
// the entry a reader means first (probe queries from the codex audit, several of which found nothing before).

import { describe, expect, it } from 'vitest';
import { normalizeQuery, searchCodex } from '../src/campaign/codexsearch';

const first = (q: string) => searchCodex(q)[0]?.id;

describe('codex search', () => {
  it('normalizes spelling', () => {
    expect(normalizeQuery('Flip flop')).toBe('flipflop');
    expect(normalizeQuery('flip-flop')).toBe('flipflop');
    expect(normalizeQuery('two’s complement')).toBe('twoscomplement');
    expect(normalizeQuery('Tri–state')).toBe('tristate');
  });

  it('finds what the probe queries mean, first', () => {
    expect(first('fsm')).toBe('fsm');
    expect(first('flip flop')).toBe('dff');
    expect(first('flipflop')).toBe('dff');
    expect(first('flip-flop')).toBe('dff');
    expect(first('twos complement')).toBe('twos');
    expect(first('k-map')).toBe('kmap');
    expect(first('kmap')).toBe('kmap');
    expect(first('nand')).toBe('nand');
    expect(first('NAND')).toBe('nand');
    expect(first('sign')).toBe('signext');
  });

  it('ranks names above summaries', () => {
    const r = searchCodex('nand').map((e) => e.id);
    expect(r.indexOf('nand')).toBe(0);
    expect(r.indexOf('nandnand')).toBeLessThan(r.findIndex((id) => !['nand', 'nandnand'].includes(id)) + 1);
    // words apart still match, all of them
    expect(searchCodex('carry adder').length).toBeGreaterThan(2);
    expect(searchCodex('zzzz')).toEqual([]);
  });
});
