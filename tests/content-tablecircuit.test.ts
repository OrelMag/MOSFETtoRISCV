// The logic chapter "From a table to a circuit" (chapters/ch-logic.ts; tests/content-logic.test.ts is an older file about other chapters):
// every number its text quotes, computed and pinned; the circuits against their functions; the glitch on GateSim; the widgets' models;
// the codex entry and its places.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { PRIMES4, PRIME4 } from '../src/lib/rv16/logic';
import { CODEX, codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { nodeById } from '../src/campaign/nodes';
import { chLogic, LOGIC_NUMBERS } from '../src/chapters/ch-logic';
import { TAUGHT } from '../src/chapters/taught';
import { loopRects, kLayout } from '../src/lib/kmap';
import {
  ABCD, costOf, coverLogic, dipWidth, FONT, fontIntact, LAWS, lawRow, mintermLogic, MUX_CONSENSUS, MUX_HAZARD, muxRun, PRIME_MINTERMS, PRIME_ONES, SEGMENTS,
  sevenSegCost, sevenSegRows, tableOf,
} from '../src/lib/logiclab';
import { MUX2 } from '../src/lib/gates';
import { tableDef, tableLogic } from '../src/lib/tablelogic';
import { kmapState } from '../src/widgets/kmap';
import { GREEDY_ONES, SEG_BUDGET, sharingRows } from '../src/widgets/logiclab';
import { evalOnce, simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';

const N = LOGIC_NUMBERS();
const bits4 = (x: number) => [(x >> 3) & 1, (x >> 2) & 1, (x >> 1) & 1, x & 1];

describe('logic chapter: the sum of minterms and the minimal sum', () => {
  it('the prime detector is the campaign\'s', () => {
    expect(PRIME_ONES).toEqual(PRIMES4);
  });
  it('the named minterm circuit is the sandbox\'s NAND–NAND for one all-literal term per 1, and computes the primes', () => {
    const t = tableOf(ABCD, PRIME_ONES);
    const ref = tableDef(t, 'q_minterms', mintermLogic(PRIME_ONES));
    expect(stats(PRIME_MINTERMS()).nands).toBe(stats(ref).nands);
    expect(logicDepth(PRIME_MINTERMS())).toBe(logicDepth(ref));
    const sim = simulate(PRIME_MINTERMS());
    for (let x = 0; x < 16; x++) expect(evalOnce(sim, bits4(x))[0], `row ${x}`).toBe(PRIME_ONES.includes(x) ? 1 : 0);
    const names = PRIME_MINTERMS().netlist!().instances.map((i) => i.name);
    for (const m of PRIME_ONES) expect(names).toContain(`m${m}`);
    for (const n of ['na', 'nb', 'nc', 'nd', 'or']) expect(names).toContain(n);
    expect(N.MIN.nands).toBe(43);
  });
  it('the minimal sum: four loops of two, 20 NANDs at depth 7 (the campaign\'s text), five primes, the same from the greedy cover', () => {
    expect(N.PS.texts).toEqual(['¬a·¬b·c', '¬b·c·d', 'b·¬c·d', '¬a·c·d']);
    expect(N.PS.cost.nands).toBe(20);
    expect(N.PS.cost.depth).toBe(7);
    expect(N.PS.cost.literals).toBe(12);
    expect(N.PS.exact).toBe(true);
    expect(N.N_PRIMES).toBe(5);
    expect(N.PS.mintermNands).toBe(43);
    expect(N.PG.texts).toEqual(N.PS.texts);
    expect(nodeById('g_sop')!.tips.join(' ')).toContain('20 NANDs here, depth 7');
  });
  it('exactly one loop wraps over the edge of the map: ¬b·c·d, cells 3 and 11', () => {
    const lay = kLayout(4);
    expect(N.PS.terms.map((p) => loopRects(lay, p).length > 1)).toEqual([false, true, false, false]);
    expect(N.PS.texts[1]).toBe('¬b·c·d');
  });
  it('the product of sums is the sum of products of the 0s plus a NOT: 15 NANDs, four factors', () => {
    expect(N.PP.texts.join('')).toBe('(b + c)(¬b + d)(¬a + d)(¬a + ¬b + ¬c)');
    expect(N.PP.cost.nands).toBe(15);
    expect(N.PP.cost.literals).toBe(9);
    const bit = (x: number, i: number) => (x >> i) & 1; // a = bit 3 … d = bit 0
    const f = (x: number) => (bit(x, 2) | bit(x, 1)) & (bit(x, 2) ^ 1 | bit(x, 0)) & (bit(x, 3) ^ 1 | bit(x, 0)) & (bit(x, 3) ^ 1 | bit(x, 2) ^ 1 | bit(x, 1) ^ 1);
    for (let x = 0; x < 16; x++) expect(f(x), `row ${x}`).toBe(PRIME_ONES.includes(x) ? 1 : 0);
  });
});

describe('logic chapter: algebra', () => {
  it('every law holds on all rows, and the counts are the ones the text quotes', () => {
    const rows = LAWS.map(lawRow);
    expect(rows.every((r) => r.same)).toBe(true);
    expect(Object.fromEntries(rows.map((r) => [r.law.id, [r.before, r.after]]))).toEqual({
      absorb: [5, 0], absorb2: [6, 3], combine: [8, 0], demorgan: [5, 1], consensus: [13, 8], mux: [8, 4], xor: [9, 4],
    });
    expect(lawRow(LAWS.find((l) => l.id === 'mux')!).after).toBe(stats(MUX2).nands);
  });
  it('the quiz\'s three terms: dropping b·c changes nothing, dropping a·b or ¬a·c does', () => {
    const f = (a: number, b: number, c: number, drop: number) => (drop === 0 ? 0 : a & b) | (drop === 1 ? 0 : (a ^ 1) & c) | (drop === 2 ? 0 : b & c);
    const diff = (drop: number) => [...Array(8).keys()].some((x) => f(x >> 2, (x >> 1) & 1, x & 1, drop) !== f(x >> 2, (x >> 1) & 1, x & 1, -1));
    expect(diff(2)).toBe(false);
    expect(diff(0)).toBe(true);
    expect(diff(1)).toBe(true);
  });
});

describe('logic chapter: don\'t cares and where minimal is not cheapest', () => {
  it('segment e of a BCD digit', () => {
    expect(N.E_PLAIN.texts).toEqual(['¬a·c·¬d', '¬b·¬c·¬d']);
    expect(N.E_PLAIN.cost.nands).toBe(11);
    expect(N.E_PLAIN.cost.literals).toBe(6);
    expect(N.E_DC.texts).toEqual(['¬b·¬d', 'c·¬d']);
    expect(N.E_DC.cost.nands).toBe(5);
    expect(N.E_DC.cost.literals).toBe(4);
    expect([...Array(10).keys()].filter((d) => FONT[d].includes('e'))).toEqual([0, 2, 6, 8]);
  });
  it('the sharing table: XOR 5 against 4, the prime detector 20 against 8, seven segments alone against together', () => {
    const rows = sharingRows();
    expect(rows[0]).toMatchObject({ name: 'XOR', two: 5, better: 4 });
    expect(rows[1]).toMatchObject({ two: 20, better: 8 });
    expect(rows[1].better).toBe(stats(PRIME4).nands);
    expect(rows[2].two).toBeGreaterThan(rows[2].better);
    expect(rows[2].better).toBe(N.SEG_DC.nands);
  });
  it('greedy takes a loop more than the exact cover on the step\'s table, and both are the same function', () => {
    expect(GREEDY_ONES).toEqual([3, 6, 7, 8, 10, 11, 12, 14]);
    expect(N.G_EXACT.texts).toEqual(['a·¬d', '¬b·c·d', '¬a·b·c']);
    expect(N.G_GREEDY.texts).toEqual(['a·¬d', '¬a·c·d', '¬b·c·d', '¬a·b·c']);
    expect(N.G_EXACT.exact).toBe(true);
    expect(N.G_GREEDY.exact).toBe(false);
    expect(N.G_EXACT.cost.nands).toBe(13);
    expect(N.G_GREEDY.cost.nands).toBe(18);
    const t = tableOf(ABCD, GREEDY_ONES);
    for (const logic of [coverLogic(t), coverLogic(t, true)]) {
      const sim = simulate(tableDef(t, 'q_g', logic));
      for (let x = 0; x < 16; x++) expect(evalOnce(sim, bits4(x))[0]).toBe(GREEDY_ONES.includes(x) ? 1 : 0);
    }
  });
  it('the map widget\'s state matches the sandbox chip\'s own logic', () => {
    const t = tableOf(ABCD, PRIME_ONES);
    expect(costOf(t, tableLogic(t)).nands).toBe(kmapState(ABCD, 'y', t.rows[0], false).cost.nands);
  });
});

describe('logic chapter: the seven-segment lab', () => {
  const dc = Array(7).fill('------'), zero = Array(7).fill('000000');
  it('the font spells the digits, the budget is the all-don\'t-care design', () => {
    expect(FONT).toHaveLength(10);
    expect(fontIntact(sevenSegRows(dc))).toBe(true);
    expect(SEG_BUDGET()).toBe(sevenSegCost(sevenSegRows(dc)).nands);
    expect(N.SEG_DC.nands).toBe(44);
    expect(N.SEG_ZERO.nands).toBe(75);
    expect(SEGMENTS).toHaveLength(7);
  });
  it('the reach\'s test passes with the unused rows as don\'t cares and fails with them dark', () => {
    const ok = (fill: string[]) => { const rows = sevenSegRows(fill); return fontIntact(rows) && sevenSegCost(rows).nands <= SEG_BUDGET(); };
    expect(ok(dc)).toBe(true);
    expect(ok(zero)).toBe(false);
  });
});

describe('logic chapter: the multiplexer that glitches', () => {
  it('computes s ? b : a for every input, cons or not', () => {
    const sim = simulate(MUX_HAZARD);
    for (let x = 0; x < 16; x++) {
      const [a, b, s, cons] = bits4(x);
      expect(evalOnce(sim, [a, b, s, cons])[0]).toBe(s ? b : a);
    }
    const sim2 = simulate(MUX_CONSENSUS);
    for (let x = 0; x < 8; x++) expect(evalOnce(sim2, [(x >> 2) & 1, (x >> 1) & 1, x & 1])[0]).toBe(x & 1 ? (x >> 1) & 1 : (x >> 2) & 1);
  });
  it('s falling with a = b = 1: y is 0 for one gate delay without the consensus term, never with it; the other edges are clean', () => {
    const bad = muxRun({ a: 1, b: 1, cons: 0 }, 1, 0);
    expect(bad.y0).toBe(1);
    expect(bad.settled).toBe(1);
    expect(bad.edges).toEqual([{ t: 4, v: 0 }, { t: 5, v: 1 }]);
    expect(dipWidth(bad)).toBe(1);
    expect(N.DIP).toBe(1);
    const good = muxRun({ a: 1, b: 1, cons: 1 }, 1, 0);
    expect(good.edges).toEqual([]);
    expect(dipWidth(good)).toBe(0);
    expect(dipWidth(muxRun({ a: 1, b: 1, cons: 0 }, 0, 1))).toBe(0);
    expect(dipWidth(muxRun({ a: 0, b: 1, cons: 0 }, 1, 0))).toBe(0);
  });
  it('the cost: 4 NANDs, 7 with the consensus term built in', () => {
    expect(N.MUX_PLAIN_NANDS).toBe(4);
    expect(N.MUX_CONS_NANDS).toBe(7);
  });
});

describe('logic chapter: the chapter and its codex entry', () => {
  it('eight steps, three keeps, three checks, four practice levels that exist, the stage of each step', () => {
    expect(chLogic.steps.map((s) => s.title)).toEqual([
      'Any rule is a circuit: minterms', 'Algebra that removes gates', 'The Karnaugh map', 'Don\'t cares: inputs that never happen',
      'Products of sums, and NAND–NAND', 'Minimal is not cheapest', 'A glitch in two-level logic', 'Your own: a 7-segment digit',
    ]);
    expect(chLogic.goals).toHaveLength(4);
    expect(chLogic.recap!.keep).toHaveLength(3);
    expect(chLogic.recap!.check).toHaveLength(3);
    expect(chLogic.recap!.practise).toEqual(['l_bool', 'd_kmap', 'g_sop', 'g_wide']);
    expect(chLogic.builds).toEqual(['gates', 'nand']);
    expect(chLogic.steps.map((s) => `${s.scene ? 'scene' : 'widget'}:${s.challenge?.kind ?? '-'}`)).toEqual([
      'scene:-', 'widget:quiz', 'widget:quiz', 'widget:reach', 'widget:quiz', 'widget:-', 'scene:reach', 'widget:reach',
    ]);
  });
  it('the campaign levels link the chapter', () => {
    expect(nodeById('l_bool')!.chapters!.some((c) => c.chapter === 'logic' && c.step === 1)).toBe(true);
    expect(nodeById('d_kmap')!.chapters!.map((c) => `${c.chapter}:${c.step}`)).toEqual(['logic:2', 'logic:3']);
    expect(nodeById('g_sop')!.chapters!.map((c) => `${c.chapter}:${c.step}`)).toEqual(['logic:0']);
  });
  it('hazard: a codex entry with a fuller text, two checks, a taught row and the chapter\'s link', () => {
    expect(codexById('hazard')!.title).toBe('Static hazard');
    expect(CODEX.filter((e) => e.id === 'hazard')).toHaveLength(1);
    expect(TAUGHT.hazard).toBe('logic');
    expect(moreOf('hazard')!.chapters![0]).toMatchObject({ chapter: 'logic', step: 6 });
    expect(CHECKS.hazard).toHaveLength(2);
    expect(moreOf('hazard')!.example!.body).toContain(`${N.MUX_PLAIN_NANDS} NANDs`);
    expect(moreOf('hazard')!.example!.body).toContain(`${N.MUX_CONS_NANDS} NANDs`);
  });
  it('sop, kmap, qm and dontcare are taught here, each with a link to the chapter', () => {
    for (const id of ['sop', 'kmap', 'qm', 'dontcare']) {
      expect(TAUGHT[id], id).toBe('logic');
      expect(moreOf(id)!.chapters!.some((c) => c.chapter === 'logic'), id).toBe(true);
    }
  });
});
