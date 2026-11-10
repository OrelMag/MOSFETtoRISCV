// The codex entries for Appendix E (the Williams tube and the Manchester Baby): every number their text quotes is the chapter's
// own, measured on the gates and the golden model (tests/baby.test.ts pins those), and every chapter link names a step by
// its title.

import { describe, expect, it } from 'vitest';
import { CODEX, codexById } from '../src/campaign/codex';
import { ALIASES_BABY, BABY_AWAITING_LEVELS, CODEX_BABY } from '../src/campaign/codexbaby';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { Glossary } from '../src/campaign/glossary';
import { NODES } from '../src/campaign/nodes';
import { BABY_COST, BABY_RUN, BABY_STORE_NANDS } from '../src/chapters/ch-baby';
import { chapters } from '../src/chapters';
import { TAUGHT, TAUGHT_OPTIONAL } from '../src/chapters/taught';
import { BEAT_US, DIGIT_US, HOLD_BEATS, HOLD_S, REFRESH_BEATS } from '../src/lib/baby';
import { groupDigits } from '../src/sim/numfmt';

const text = (id: string) => (codexById(id)!.body + JSON.stringify(moreOf(id))).replace(/<[^>]+>/g, ' ').replace(/\\'/g, "'");
const squash = (s: string) => s.replace(/[  ]/g, ' ');

describe('the Baby\'s codex entries', () => {
  it('are in the codex, with their fuller text and two questions each, and no level teaches them', () => {
    for (const e of CODEX_BABY) {
      expect(CODEX.includes(e), e.id).toBe(true);
      expect(moreOf(e.id)?.idea, e.id).toBeTruthy();
      expect(CHECKS[e.id]?.length, e.id).toBe(2);
      for (const r of e.related ?? []) expect(codexById(r), `${e.id} → ${r}`).toBeTruthy();
      expect(NODES.some((n) => n.codex.includes(e.id)), `${e.id} is in a level now: drop it from BABY_AWAITING_LEVELS`).toBe(false);
      expect(BABY_AWAITING_LEVELS.has(e.id)).toBe(true);
    }
  });

  it('quote the machine\'s size: the chapter\'s NAND counts (the pins of tests/baby.test.ts)', () => {
    expect(BABY_COST.all).toBe(22_694);
    expect(BABY_STORE_NANDS).toBe(19_653);
    for (const id of ['williamstube', 'ssem']) {
      const t = squash(text(id));
      if (id === 'ssem') expect(t).toContain(`${squash(groupDigits(BABY_COST.all))} NANDs`);
      if (id === 'ssem') expect(t).toContain(squash(groupDigits(BABY_STORE_NANDS)));
    }
  });

  it('quote the timing: 8.5 µs a digit, 306 µs a beat, four beats an instruction, 654 beats in 0.2 s, 64 beats and 19.6 ms a regeneration', () => {
    expect(DIGIT_US).toBe(8.5);
    expect(BEAT_US).toBe(306);
    expect(HOLD_S).toBe(0.2);
    expect(HOLD_BEATS).toBe(654);
    expect(REFRESH_BEATS).toBe(64);
    expect((REFRESH_BEATS * BEAT_US) / 1000).toBeCloseTo(19.6, 1);
    // the regenerator visits every line about ten times inside the charge's life (the quiz's answer)
    expect(Math.round((HOLD_S * 1000) / ((REFRESH_BEATS * BEAT_US) / 1000))).toBe(10);
    const w = text('williamstube'), s = text('ssem');
    expect(w).toContain('8.5 µs');
    expect(w).toContain('306 µs');
    expect(w).toContain('654 beats');
    expect(w).toContain('every 64 beats = 19.6 ms');
    expect(w).toContain('19.6 ms');
    expect(s).toContain('8.5 µs');
    expect(s).toContain('four beats');
    expect(s).toContain('1.224 ms');
    expect(4 * BEAT_US).toBe(1224);
  });

  it('quote Kilburn\'s run: 2 097 154 instructions, answer 131 072, about 43 minutes at 1.224 ms an instruction', () => {
    expect(BABY_RUN.instrs).toBe(2_097_154);
    expect(BABY_RUN.answer).toBe(131_072);
    const s = squash(text('ssem'));
    expect(s).toContain(`${squash(groupDigits(BABY_RUN.instrs))} instructions, answer ${squash(groupDigits(BABY_RUN.answer))}`);
    expect(Math.round((BABY_RUN.instrs * 4 * BEAT_US) / 1e6 / 60)).toBe(43);
    expect(s).toContain('about 43 minutes');
  });

  it('say seven instructions, and name them', () => {
    const s = text('ssem');
    for (const m of ['JMP', 'JRP', 'LDN', 'STO', 'SUB', 'CMP', 'STP']) expect(s, m).toContain(m);
    expect(s).toContain('seven instructions');
  });

  it('link the chapter\'s steps by title, and are taught there for readers who took the appendix path', () => {
    const baby = chapters.find((c) => c.id === 'appendix-baby')!;
    for (const id of ['williamstube', 'ssem']) {
      const links = moreOf(id)!.chapters!;
      expect(links.length).toBeGreaterThan(0);
      for (const l of links) expect(baby.steps[l.step!].title, `${id} ${l.label}`).toBe(l.label);
      expect(TAUGHT[id]).toBeUndefined();
      expect(TAUGHT_OPTIONAL[id]).toEqual(['appendix-baby']);
    }
    expect(moreOf('williamstube')!.chapters!.map((l) => l.step)).toEqual([1, 2, 3]);
    expect(moreOf('ssem')!.chapters!.map((l) => l.step)).toEqual([0]);
  });

  it('are found in prose by their names', () => {
    const g = new Glossary();
    const ids = (t: string) => g.find(t).map((m) => m.id);
    expect(ids('The Williams tube holds a bit as a charge.')).toContain('williamstube');
    expect(ids('Kilburn\'s program on the SSEM.')).toContain('ssem');
    expect(ids('the Small-Scale Experimental Machine')).toContain('ssem');
    // "Manchester Baby" is not a term: the secret chapter names it long before Appendix E
    expect(ids('the Manchester Baby')).not.toContain('ssem');
    for (const [id, names] of Object.entries(ALIASES_BABY)) for (const n of names) expect(ids(`about the ${n} here`), `${id}: ${n}`).toContain(id);
  });
});
