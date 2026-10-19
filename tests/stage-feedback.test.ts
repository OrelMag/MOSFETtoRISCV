// The stage's feedback notes (ui/feedback.ts): a challenge goal or a "Try" box's text cut to one short line.

import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { oneLine, solvedNote, triedNote } from '../src/ui/feedback';

describe('stage feedback words', () => {
  it('keeps a short text as it is, whitespace collapsed', () => {
    expect(oneLine('  Make the NAND\n   output 0. ')).toBe('Make the NAND output 0.');
  });

  it('cuts a long text at a word boundary with an ellipsis, within the limit', () => {
    const t = 'Set all three inputs to 1: the answer is 3 = 11, so both s and cout are 1, which the table says too.';
    const s = oneLine(t, 40);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('…')).toBe(true);
    expect(t.startsWith(s.slice(0, -1))).toBe(true);
    // ends on a whole word, no dangling punctuation
    expect(s).toBe('Set all three inputs to 1: the answer…');
  });

  it('cuts a single long word too', () => {
    expect(oneLine('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('names what was achieved', () => {
    expect(solvedNote('Make the NAND output 0.')).toBe('Challenge solved: Make the NAND output 0.');
    expect(triedNote('Find the input where the series NMOS pair forms a path.')).toBe('Done: Find the input where the series NMOS pair forms a path.');
  });

  it('announces every chapter goal whole when solved', () => {
    for (const c of chapters) for (const s of c.steps) {
      if (s.challenge?.kind === 'reach') expect(solvedNote(s.challenge.goal)).toBe(`Challenge solved: ${s.challenge.goal.replace(/\s+/g, ' ').trim()}`);
    }
  });
});
