// Appendix F (chapters/ch-agc.ts) and its codex entries (codexagc.ts): the gate counts the prose quotes are the circuits',
// the program's run is the golden model's, the R-700 figures agree with each other, and the codex links name the
// chapter's steps by title.
import { describe, expect, it } from 'vitest';
import { BLOCK2_ROPE } from '../src/agc/rope';
import { CODEX, codexById } from '../src/campaign/codex';
import { AGC_AWAITING_LEVELS, CODEX_AGC } from '../src/campaign/codexagc';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { Glossary } from '../src/campaign/glossary';
import { NODES } from '../src/campaign/nodes';
import { chapters } from '../src/chapters';
import { AGC_NOR, AGC_SUM_RUN, chAppendixAgc } from '../src/chapters/ch-agc';
import { TAUGHT, TAUGHT_OPTIONAL } from '../src/chapters/taught';
import { MCT_US } from '../src/widgets/agcrun';

const text = (id: string) => (codexById(id)!.body + JSON.stringify(moreOf(id))).replace(/<[^>]+>/g, ' ').replace(/\\'/g, "'");
const prose = chAppendixAgc.steps.map((s) => s.body).join(' ');

describe('Appendix F: the Apollo Guidance Computer', () => {
  it('quotes the circuits\' own NOR3 counts', () => {
    expect(AGC_NOR).toMatchObject({ basic: 5, fa: 9, add4: 38, reg: 15, reg4: 60, faNands: 9 });
    expect(prose).toContain(`${AGC_NOR.add4} NOR gates`);
    expect(prose).toContain(`${AGC_NOR.reg4} for the`);
  });
  it('runs its table sum on the golden model: 124 in 44 instructions and 77 memory cycles, 900.9 µs', () => {
    expect(AGC_SUM_RUN).toEqual({ instrs: 44, mct: 77, sum: 124 });
    expect((AGC_SUM_RUN.mct * MCT_US).toFixed(1)).toBe('900.9');
    expect(text('agc')).toContain('44 instructions, 77 MCT, 900.9 µs');
  });
  it('R-700\'s timing table holds together: 2, 3 and 4 memory cycles are its addition, double-precision and multiply times', () => {
    expect((2 * MCT_US).toFixed(1)).toBe('23.4');
    expect((3 * MCT_US).toFixed(1)).toBe('35.1');
    expect((4 * MCT_US).toFixed(1)).toBe('46.8');
    const t = text('agc');
    for (const s of ['23.4 µs', '35.1 µs', '46.8 µs']) expect(t).toContain(s);
  });
  it('the rope\'s figures: 12 words of 16 bits is 192 wires; 36 864 words in 6 modules is 512 cores a module', () => {
    expect(BLOCK2_ROPE.wordsPerCore * BLOCK2_ROPE.bitsRead).toBe(BLOCK2_ROPE.senseLines);
    expect(BLOCK2_ROPE.coresPerModule).toBe(512);
    const t = text('corerope');
    for (const s of ['192 sense wires', '36 864 words', '512 cores a module', 'permalloy']) expect(t).toContain(s);
    expect(prose).toContain('permalloy');
    expect(prose).toContain('removal of carry propagations'); // R-700 p. 69, the carry-clear's source
  });
  it('codex entries: in the codex, two questions each, linked to the chapter\'s steps by title, taught there optionally', () => {
    const ch = chapters.find((c) => c.id === 'appendix-agc')!;
    for (const e of CODEX_AGC) {
      expect(CODEX.includes(e), e.id).toBe(true);
      expect(CHECKS[e.id]?.length, e.id).toBe(2);
      for (const r of e.related ?? []) expect(codexById(r), `${e.id} → ${r}`).toBeTruthy();
      // in a level, or awaiting one: never both
      expect(NODES.some((n) => n.codex.includes(e.id)), e.id).toBe(!AGC_AWAITING_LEVELS.has(e.id));
      for (const l of moreOf(e.id)!.chapters!) expect(ch.steps[l.step!].title, `${e.id} ${l.label}`).toBe(l.label);
      expect(TAUGHT[e.id]).toBeUndefined();
      expect(TAUGHT_OPTIONAL[e.id]).toEqual(['appendix-agc']);
    }
  });
  it('the glossary finds them, and "AGC" stays the radio chapters\' automatic gain control', () => {
    const g = new Glossary();
    const ids = (t: string) => g.find(t).map((m) => m.id);
    expect(ids('The program lived in core rope.')).toContain('corerope');
    expect(ids('rope memory')).toContain('corerope');
    expect(ids('the Apollo Guidance Computer flew')).toContain('agc');
    expect(ids('the receiver\'s AGC loop')).not.toContain('agc');
  });
});
