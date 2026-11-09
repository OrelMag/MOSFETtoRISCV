// A codex entry that quotes RV16 numbers and links to the 32-bit CPU chapters says so beside its links (proposal 3 of the ship review).

import { describe, expect, it } from 'vitest';
import { CODEX } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { needsRv16Note } from '../src/campaign/codexlinks';

const textOf = (id: string) => { const e = CODEX.find((x) => x.id === id)!; const m = moreOf(id); return [e.body, m?.idea ?? '', m?.example?.body ?? '', ...(m?.mistakes ?? [])].join(' '); };

describe('the RV16 note on codex links', () => {
  it('is needed only with RV16 in the text and an RV32 chapter among the links', () => {
    expect(needsRv16Note('RV16 has eight registers', [{ chapter: 'isa' }])).toBe(true);
    expect(needsRv16Note('RV16 has eight registers', [{ chapter: 'dram' }])).toBe(false);
    expect(needsRv16Note('RV32I has 32 registers', [{ chapter: 'isa' }])).toBe(false);
  });
  it('marks the RV16 entries that send a reader to the 32-bit chapters', () => {
    for (const id of ['rv16', 'formats', 'immediates', 'regfile', 'datapath', 'pipeline', 'precise']) {
      const m = moreOf(id);
      if (!m?.chapters?.length) continue;
      expect(needsRv16Note(textOf(id), m.chapters), id).toBe(/\bRV16\b/.test(textOf(id)));
    }
    expect(needsRv16Note(textOf('rv16'), moreOf('rv16')!.chapters!)).toBe(true);
  });
});
