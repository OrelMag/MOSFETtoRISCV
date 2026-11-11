import { describe, expect, it } from 'vitest';
import { codexById } from '../src/campaign/codex';
import { CHECKPDP8 } from '../src/campaign/codexcheckpdp8';
import { moreOf } from '../src/campaign/codexmore';
import { CODEX_PDP8, PDP8_AWAITING_LEVELS } from '../src/campaign/codexpdp8';
import { NODES } from '../src/campaign/nodes';
import { TAUGHT } from '../src/chapters/taught';
import { MANIFEST } from '../src/chapters/manifest';
import { assemblePdp8, PDP8_HELLO } from '../src/pdp8/programs';

// The PDP-8's codex entry (ship audit 2): what the sandbox examples assume, held to the assembler and the model.
describe('the PDP-8 codex entry', () => {
  it('is registered, linked, taught by the multicycle chapter and in no level yet', () => {
    for (const e of CODEX_PDP8) {
      expect(codexById(e.id), e.id).toBe(e);
      expect(CHECKPDP8[e.id]?.length).toBe(2);
      for (const r of e.related ?? []) expect(codexById(r), `${e.id} → ${r}`).toBeTruthy();
      expect(TAUGHT[e.id]).toBe('multicycle');
      expect(NODES.some((n) => n.codex.includes(e.id))).toBe(!PDP8_AWAITING_LEVELS.has(e.id));
      for (const l of moreOf(e.id)!.chapters!) expect(MANIFEST.find((c) => c.id === l.chapter)!.steps[l.step!].title).toBe(l.label);
    }
  });

  it('its worked words are what the assembler makes of them', () => {
    const body = moreOf('pdp8')!.example!.body;
    for (const [src, oct] of [['TAD I 10', '1410'], ['CLA CLL', '7300'], ['TLS', '6046']]) {
      expect(assemblePdp8(` ${src}\n`).words[0].toString(8).padStart(4, '0'), src).toBe(oct);
      expect(body).toContain(`${src.padEnd(10)} ${oct}`);
    }
    expect(PDP8_HELLO.start).toBe(0o200);
    expect(body).toContain('LOAD ADD 0200');
  });
});
