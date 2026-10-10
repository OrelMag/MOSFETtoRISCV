// The glossary finds codex terms in prose: titles, parenthetical names, aliases and plurals, acronyms
// only as written, whole words only, longest term first.

import { describe, expect, it } from 'vitest';
import { codexById } from '../src/campaign/codex';
import { Glossary, terms } from '../src/campaign/glossary';

const g = new Glossary();
const ids = (s: string) => g.find(s).map((m) => m.id);

describe('the glossary', () => {
  it('names only known entries', () => {
    for (const t of terms()) expect(codexById(t.id), t.id).toBeDefined();
  });

  it('finds titles, aliases and plurals, longest first', () => {
    expect(ids('Chain four full adders into a ripple-carry adder.')).toEqual(['fulladder', 'ripple']);
    expect(ids('The CPU fetches; a processor decodes.')).toEqual(['cpu', 'cpu']);
    expect(ids('Draw a K-map, then a sum of products.')).toEqual(['kmap', 'sop']);
    expect(ids('Two D flip-flops make a register.')).toContain('dff');
  });

  it('marks acronyms only as written and whole words only', () => {
    expect(ids('this or that, and not the other')).toEqual([]);
    expect(ids('An OR of two ANDs')).toEqual(['or', 'and']);
    expect(ids('nandgate halfadders')).toEqual([]);
  });
});
