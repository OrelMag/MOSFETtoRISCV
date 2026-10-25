// Test tables in Digital's test syntax (editor/testtable.ts): the parser unrolls what Digital unrolls, a table on a
// chip runs as Check runs a sequence, and "Fill outputs from the circuit" writes what the circuit shows.

import { describe, expect, it } from 'vitest';
import { challengeById } from '../src/editor/challengeset';
import { UserLibrary } from '../src/editor/library';
import { fillOutputs, parseTest, planTest, runTest, starterTest, type ParsedTest, type TestPlan } from '../src/editor/testtable';
import { workspace } from './editorkit';

const ok = (src: string): ParsedTest => {
  const p = parseTest(src);
  if ('error' in p) throw new Error(`line ${p.line}: ${p.error}`);
  return p;
};
const vals = (p: ParsedTest) => p.rows.map((r) => r.cells.map((c) => (typeof c === 'bigint' ? Number(c) : c)));

/** A challenge's reference answer, compiled. */
function ref(id: string) {
  const chips = challengeById(id)!.answer();
  const main = chips[chips.length - 1];
  const c = new UserLibrary(workspace(main, ...chips.slice(0, -1))).compiled(main.id)!;
  return { main, def: c.def, mode: c.mode };
}
const plan = (def: Parameters<typeof planTest>[0], src: string): TestPlan => {
  const p = planTest(def, { name: 't', src });
  if ('error' in p) throw new Error(`line ${p.line}: ${p.error}`);
  return p;
};

describe('parseTest', () => {
  it('reads names, numbers in every base, X / Z / C and comments', () => {
    const p = ok('# a comment\nA  B   Y\n0 0x1 0b1   # trailing\n-1 X Z\nC c x\n');
    expect(p.names).toEqual(['A', 'B', 'Y']);
    expect(vals(p)).toEqual([[0, 1, 1], [-1, 'X', 'Z'], ['C', 'C', 'X']]);
    expect(p.rows.map((r) => r.line)).toEqual([3, 4, 5]);
  });
  it('unrolls repeat with n, loop with its variable, let and bits()', () => {
    const p = ok('a b c d\nrepeat(3) (n) (n*2) 0 0\nlet k = 5;\nloop(i, 2)\n  (i+k) bits(3, 6)\nend loop\n');
    expect(vals(p)).toEqual([[0, 0, 0, 0], [1, 2, 0, 0], [2, 4, 0, 0], [5, 1, 1, 0], [6, 1, 1, 0]]);
    expect(p.rows[4].where).toBe('i = 1');
    expect(p.rows[1].where).toBe('n = 1');
  });
  it('runs while, nested loops and the functions', () => {
    const p = ok('a b\nlet x = 0;\nwhile (x < 3)\n  (x) (ite(x == 1, 7, 9))\n  let x = x + 1;\nend while\nloop(i,2)\nloop(j,2)\n(i) (j)\nend loop\nend loop\n0 (signExt(15, 4))');
    expect(vals(p)).toEqual([[0, 9], [1, 7], [2, 9], [0, 0], [0, 1], [1, 0], [1, 1], [0, -1]]);
    expect(p.rows[6].where).toBe('i = 1, j = 1');
  });
  it('a fixed random sequence, restarted by resetRandom', () => {
    const p = ok('a\n(random(100))\n(random(100))\nresetRandom;\n(random(100))\n');
    expect(p.rows[0].cells[0]).toBe(p.rows[2].cells[0]);
    expect(p.rows.every((r) => (r.cells[0] as bigint) < 100n)).toBe(true);
  });
  it.each([
    ['', 'the first line names'],
    ['a b\n0', '1 value for 2 signals'],
    ['a\nfoo', 'in parentheses'],
    ['a\nloop(i, 2)\n0', "'end loop' missing"],
    ['a\nend loop', 'without'],
    ['a\n(q)', "no variable 'q'"],
    ['a\nrepeat(200000) 0', 'at most'],
    ['a a\n0 0', 'named twice'],
    ['a\nprogram(1,2)', 'not supported'],
    ['a\n0 $', "unexpected '$'"],
  ])('%j is refused: %s', (src, msg) => {
    const p = parseTest(src);
    expect('error' in p && p.error).toContain(msg);
  });
  it('errors name their line', () => {
    const p = parseTest('a b\n0 0\n\n1 2 3\n');
    expect(p).toEqual({ error: '3 values for 2 signals', line: 4 });
  });
});

describe('a table on a chip', () => {
  it('a half adder passes its truth table, X inputs expanded', () => {
    const { def, mode } = ref('a_ha');
    const p = plan(def, 'a b s c\n0 0 0 0\n0 1 1 0\n1 0 1 0\n1 1 0 1\nX X X X\n');
    expect(p.ch.check.kind === 'sequence' && p.ch.check.steps.length).toBe(8);
    const r = runTest(def, mode, p, ['a', 'b', 's', 'c']);
    expect(r.failed).toEqual([]);
    expect(r.steps).toHaveLength(8);
  });
  it('a wrong row fails, the others pass', () => {
    const { def, mode } = ref('a_ha');
    const p = plan(def, 'a b s c\n0 0 0 0\n1 1 1 1\n1 0 1 0\n');
    expect(runTest(def, mode, p, ['a', 'b', 's', 'c']).failed).toEqual([1]);
  });
  it('a counter with a clock column counts and wraps', () => {
    const { def, mode } = ref('s_cnt4');
    const src = 'clk en rst q\n0 0 1 X\nC 0 1 0\nrepeat(15) C 1 0 (n+1)\nC 1 0 0\nC 0 0 0\n';
    const p = plan(def, src);
    expect(p.ch.ports.find((x) => x.name === 'clk')?.clock).toBe(true);
    const r = runTest(def, mode, p, ['clk', 'en', 'rst', 'q']);
    expect(r.failed).toEqual([]);
    const bad = plan(def, 'clk en rst q\nC 0 1 0\nC 1 0 2\n');
    expect(runTest(def, mode, bad, ['clk', 'en', 'rst', 'q']).failed).toEqual([1]);
  });
  it.each([
    ['a b zz\n0 0 0', "no pin named 'zz'"],
    ['a b s\n2 0 0', 'does not fit'],
    ['a b s\nZ 0 0', 'is an input'],
    ['a b s\nC 0 0\n0 C 0', 'one clock column'],
    ['s a\nC 0', 'is an output'],
  ])('%j is refused on the chip: %s', (src, msg) => {
    const { def } = ref('a_ha');
    const p = planTest(def, { name: 't', src });
    expect('error' in p && p.error).toContain(msg);
  });
  it('Z expected is noted and not checked; inputs left out are held at 0', () => {
    const { def, mode } = ref('a_ha');
    const p = plan(def, 'a s c\n1 1 Z\n');
    expect(p.notes[0]).toContain('Z expected on c');
    expect(runTest(def, mode, p, ['a', 's', 'c']).failed).toEqual([]);
  });
  it('fills the outputs of plain rows from the circuit, keeping bases, comments and loops', () => {
    const { def, mode } = ref('s_cnt4');
    const names = ['clk', 'en', 'rst', 'q'];
    const src = 'clk en rst q\nC 0 1 X   # clear\nC 1 0 0x0\nrepeat(2) C 1 0 X\nC 1 0 0b0000\n';
    const p = plan(def, src);
    const r = runTest(def, mode, p, names);
    const f = fillOutputs(src, p, names, r);
    expect(f.src).toBe('clk en rst q\nC 0 1 0   # clear\nC 1 0 0x1\nrepeat(2) C 1 0 X\nC 1 0 0b0100\n');
    expect(f).toMatchObject({ filled: 3, kept: 1 });
  });
  it('a starter table names the pins: inputs, then outputs as X', () => {
    const { main } = ref('a_ha');
    expect(starterTest(main, 'first').src).toBe('a b s c\n0 0 X X\n');
  });
});

describe('widths', () => {
  it('an expression wraps to the pin width; a literal that does not fit is refused', () => {
    const { def, mode } = ref('s_cnt4');
    const names = ['clk', 'en', 'rst', 'q'];
    const p = plan(def, 'clk en rst q\nC 0 1 0\nrepeat(20) C 1 0 (n+1)\n');
    expect(runTest(def, mode, p, names).failed).toEqual([]);
    const lit = planTest(def, { name: 't', src: 'clk en rst q\nC 0 1 16\n' });
    expect('error' in lit && lit.error).toContain('does not fit');
  });
});
