// Third-party obligations that ship with the site: Doom's image is GPL-2, so its licence text travels beside it
// and the Play step points at the exact source; every other notice is in one served file.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { chAppendixDoom as DOOM } from '../src/chapters/ch-doom';

const pub = (p: string) => new URL(`../public/${p}`, import.meta.url);

describe('licences', () => {
  it("Doom's GPL-2 text ships beside the image", () => {
    expect(existsSync(pub('doom/doom.img'))).toBe(true);
    expect(readFileSync(pub('doom/COPYING.txt'), 'utf8')).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/);
  });

  it('the Play step names the licence and links the source the image is built from', () => {
    const play = DOOM.steps.find((s) => s.title === 'Play')!;
    expect(play.body).toContain('href="doom/COPYING.txt"');
    expect(play.body).toContain('github.com/OrelMag/MOSFETtoRISCV/tree/main/ports/doom');
  });

  it('the notices file covers everything third-party the site serves', () => {
    const t = readFileSync(pub('THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const s of ['doomgeneric', 'Freedoom', 'riscv-tests', 'Yosys', 'ABC', 'SIL Open Font License', 'SingleStepTests', 'dsp/voice-8k.wav'])
      expect(t, s).toContain(s);
  });
});
