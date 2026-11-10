// The Vectors chapter's codex entries quote measured numbers (codexvec.ts, codexmorevec.ts): each is recomputed here from
// bench/vectorcosts.json, the strip-mining loop on the golden model and the chaining model.

import { describe, expect, it } from 'vitest';
import { CODEX, codexById } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { CODEX_VEC, TAUGHT_VEC, VEC_AWAITING_LEVELS } from '../src/campaign/codexvec';
import { CHECKS } from '../src/campaign/codexcheck';
import { NODES } from '../src/campaign/nodes';
import { CHAIN_KERNEL, chainTimes } from '../src/riscv/vecmodel';
import { stripRun, VEC } from '../src/widgets/vectors';

const text = (id: string) => `${codexById(id)!.body} ${JSON.stringify(moreOf(id) ?? {})}`;
const has = (id: string, s: string) => expect(text(id), `${id} quotes ${s}`).toContain(s);
const modes = ['serial', 'units', 'chained'] as const;

describe('Vectors codex numbers', () => {
  it('strip-mining', () => {
    for (const v of [128, 256, 512]) {
      const r = stripRun(37, v, 1);
      has('stripmine', `${r.passes.join(' ')}`);
      has('stripmine', `${r.passes.length}`);
      has('stripmine', `${r.instrs}`);
    }
    expect(stripRun(37, 128, 1)).toMatchObject({ passes: { length: 10 }, instrs: 124 });
    has('stripmine', '10 passes and 124 instructions at VLEN 128, 5 passes and 64 at 256, 3 and 40 at 512');
    has('stripmine', stripRun(100, 128, 8).passes.join(', ').replace(/, (\d+)$/, ' and $1'));
  });
  it('LMUL', () => {
    const c = Object.fromEntries(VEC.byLmul.map((r) => [r.lmul, r]));
    has('lmul', `${c[1].cycles} cycles at m1, ${c[2].cycles} at m2, ${c[4].cycles} at m4 and ${c[8].cycles} at m8`);
    for (const r of VEC.byLmul) has('lmul', `m${r.lmul}          ${r.instrs}           ${r.cycles}`);
  });
  it('mask', () => {
    has('vmask', `(${VEC.unit.v0} NANDs)`);
  });
  it('chaining', () => {
    const t = (g: number) => modes.map((m) => chainTimes(CHAIN_KERNEL, g, m).total);
    const [s, u, c] = t(8);
    has('chaining', `${c} cycles chained, ${u} overlapped without chaining and ${s} one at a time`);
    for (const g of [1, 2, 4, 8]) {
      const row = t(g);
      expect(text('chaining'), `row ${g}`).toMatch(new RegExp(`${g}\\s+${row[0]}\\s+${row[1]}\\s+${row[2]}`));
    }
  });
  it('entries are taught in Vectors, have two questions, and await a level', () => {
    for (const e of CODEX_VEC) {
      expect(TAUGHT_VEC[e.id]).toBe('vectors');
      expect(CHECKS[e.id]?.length).toBe(2);
      expect(VEC_AWAITING_LEVELS.has(e.id)).toBe(true);
      expect(NODES.some((n) => n.codex?.includes(e.id)), `${e.id} is in a level now: drop it from VEC_AWAITING_LEVELS`).toBe(false);
      expect(moreOf(e.id)?.chapters?.some((l) => l.chapter === 'vectors')).toBe(true);
    }
    expect(CODEX.filter((e) => TAUGHT_VEC[e.id]).length).toBe(CODEX_VEC.length);
  });
});
