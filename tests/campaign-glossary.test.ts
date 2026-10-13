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

  it('finds the GPU act\'s terms', () => {
    expect(ids('Four lanes form a warp; the leader decides a divergent branch.')).toEqual(['lane', 'warp', 'leader', 'divergence']);
    expect(ids('SIMT keeps lane utilization up with a reconvergence stack and the active mask.')).toEqual(['simt', 'utilization', 'reconvergence', 'activemask']);
    expect(ids('A lane register file per lane: SIMD trades latency for throughput.')).toEqual(['vrf', 'lane', 'simd', 'throughput']);
  });
});
