// The AGC's RTL NOR3 (lib/agcnor.ts) at switch level and the NOR3 ladder's reference answers: truth tables, the
// register bit clocked, and their counts (NOR3 gates, the transistors and resistors drawing 2005011 shows).
import { describe, expect, it } from 'vitest';
import { nodeById } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { checkChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { AND, FULL_ADDER, NOR3_RTL, NOR_BASIC, NOR_FA, NOR_REG, NOT, OR } from '../src/lib';
import { workspace } from './editorkit';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, type Bit, type ComponentDef } from '../src/sim/types';

function sim(def: ComponentDef) {
  const s = new SwitchSim(flatten(def, { mode: 'switch' }));
  const get = (p: string): Bit => s.get(s.design.root.ports[p][0]);
  const set = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) s.setInput(k, x); s.settle(); };
  return { get, set };
}
function table(def: ComponentDef) {
  const ins = def.ports.filter((p) => p.dir === 'in').map((p) => p.name), outs = def.ports.filter((p) => p.dir === 'out').map((p) => p.name);
  const c = sim(def);
  for (let v = 0; v < 2 ** ins.length; v++) {
    const bits = ins.map((_, i) => (v >> (ins.length - 1 - i)) & 1); // the first input most significant, as spec reads them
    c.set(Object.fromEntries(ins.map((n, i) => [n, bits[i]])));
    const want = def.spec!(bits);
    expect(outs.map((o) => c.get(o)), `${def.id} ${bits.join('')}`).toEqual(want.map((w) => (w ? B1 : B0)));
  }
}

describe('the AGC NOR3 and the ladder\'s answers', () => {
  it('NOR3, NOT / OR / AND and the full adder follow their truth tables at switch level', () => {
    for (const d of [NOR3_RTL, NOR_BASIC, NOR_FA]) table(d);
  });
  it('the register bit takes d at a rising clk edge while en = 1, and holds otherwise', () => {
    const c = sim(NOR_REG);
    const edge = (d: number, en: number) => { c.set({ d, en, clk: 0 }); c.set({ d, en, clk: 1 }); };
    c.set({ d: 0, en: 1, clk: 0 }); c.set({ clk: 1 });
    expect(c.get('q')).toBe(B0);
    edge(1, 1); expect(c.get('q')).toBe(B1);
    c.set({ d: 0, en: 1, clk: 1 }); expect(c.get('q')).toBe(B1); // no edge: d changing while clk is high does nothing
    edge(0, 0); expect(c.get('q')).toBe(B1); // en = 0 holds
    edge(0, 1); expect(c.get('q')).toBe(B0);
    c.set({ d: 1, en: 1, clk: 0 }); expect(c.get('q')).toBe(B0); // clk low: the master follows, q does not
    edge(1, 0); expect(c.get('q')).toBe(B0);
    edge(1, 1); expect(c.get('q')).toBe(B1);
  });
  it('counts: a gate is 3 transistors and 4 resistors (drawing 2005011); the answers 5, 9 and 15 gates', () => {
    expect(stats(NOR3_RTL)).toMatchObject({ transistors: 3, resistors: 4, nor3: 1, nands: 0 });
    for (const [d, n] of [[NOR_BASIC, 5], [NOR_FA, 9], [NOR_REG, 15]] as const) {
      expect(stats(d), d.id).toMatchObject({ nor3: n, transistors: 3 * n, resistors: 4 * n, nands: 0 });
    }
    expect(stats(FULL_ADDER).nands).toBe(9); // the NAND adder the NOR one is the dual of: as many gates
  });
});

describe('the NOR3 ladder (act 1–3, optional)', () => {
  it('each level\'s reference answer passes Check on SwitchSim at par, scored in NOR3 gates; a NAND is refused', () => {
    for (const id of ['nor_basic', 'nor_fa', 'nor_reg']) {
      const n = nodeById(id)!;
      const ch = levelChallenge(n)!;
      const chips = ch.answer();
      const main = chips[chips.length - 1];
      const r = checkChallenge(ch, new UserLibrary(workspace(main, ...chips.slice(0, -1))).compiled(main.id));
      expect(r.failures, id).toEqual([]);
      expect(r.restrictionViolations, id).toEqual([]);
      expect(r.ok, id).toBe(true);
      expect(r.score.nor3, id).toBe(n.par!.nor3);
    }
    const ch = levelChallenge(nodeById('nor_basic')!)!;
    const chips = ch.answer();
    const main = chips[chips.length - 1];
    const withNand = { ...main, parts: [...main.parts, { id: 'extra', ref: { lib: 'nand' }, at: [0, 40] as [number, number] }] };
    expect(checkChallenge(ch, new UserLibrary(workspace(withNand)).compiled(main.id)).restrictionViolations.length).toBeGreaterThan(0);
  });
  it('the levels\' prose quotes the counts the gates give', () => {
    const t = (d: ComponentDef) => stats(d).transistors;
    expect([t(NOR_BASIC), stats(NOR_BASIC).resistors]).toEqual([15, 20]);
    expect([t(NOR_FA), stats(NOR_FA).resistors, t(FULL_ADDER)]).toEqual([27, 36, 36]);
    expect([t(NOR_REG), stats(NOR_REG).resistors]).toEqual([45, 60]);
    expect(nodeById('s_reg4')!.par!.nand! / 4).toBe(13); // the NAND register bit at par: 13 NANDs, 52 transistors
    expect(stats(NOT).nands + stats(AND).nands + stats(OR).nands).toBe(6);
  });
});

describe('Appendix F: the one\'s-complement adder and the 4-bit register in NOR3', async () => {
  const { NOR_ADD4, NOR_REG4, onesAdd4 } = await import('../src/lib/agcnor');
  const word = (c: ReturnType<typeof sim>, p: string) => [0, 1, 2, 3].reduce((v, i) => v | ((c.get(`${p}${i}`) === B1 ? 1 : 0) << i), 0);
  const put = (p: string, v: number) => Object.fromEntries([0, 1, 2, 3].map((i) => [`${p}${i}`, (v >> i) & 1]));
  it('adds in one\'s complement with the end-around carry, from any earlier state, when the carries are cleared first', () => {
    const c = sim(NOR_ADD4);
    for (const [pa, pb] of [[0, 0], [15, 1], [7, 8]]) for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
      c.set({ ...put('a', pa), ...put('b', pb), cc: 0 });
      c.set({ ...put('a', a), ...put('b', b), cc: 1 });
      c.set({ cc: 0 });
      expect(word(c, 's'), `${a} + ${b} after ${pa} + ${pb}`).toBe(onesAdd4(a, b));
    }
    expect(onesAdd4(5, 10)).toBe(15); // a + ¬a is −0
    expect(onesAdd4(12, 6)).toBe(3); // −3 + 6 = 3: the carry out of bit 3 comes back in
  });
  it('without the clear, a carry left circling makes a + ¬a +0 instead of −0 (the ring holds it)', () => {
    const c = sim(NOR_ADD4);
    c.set({ ...put('a', 7), ...put('b', 1), cc: 0 }); // 7 + 1: every carry 1
    c.set({ ...put('a', 5), ...put('b', 10) });
    expect(word(c, 's')).toBe(0);
    c.set({ cc: 1 }); c.set({ cc: 0 });
    expect(word(c, 's')).toBe(15);
  });
  it('the chapter\'s try, one switch at a time: from 0111 + 0001, b1 and b3 on, a1 off, b0 off last shows 0000; a cc pulse gives 1111, whatever the order', () => {
    const start = { ...put('a', 0b0111), ...put('b', 0b0001), cc: 0 };
    const c = sim(NOR_ADD4);
    c.set(start);
    expect(word(c, 's')).toBe(0b1000);
    for (const [k, v] of [['b1', 1], ['b3', 1], ['a1', 0], ['b0', 0]] as const) c.set({ [k]: v });
    expect(word(c, 's')).toBe(0);
    c.set({ cc: 1 }); c.set({ cc: 0 });
    expect(word(c, 's')).toBe(15);
    // every order of the four flips: before the clear the ring may hold anything (carries, or X), after it the sum is −0
    const flips = [['a1', 0], ['b0', 0], ['b1', 1], ['b3', 1]] as const;
    const perms = <T,>(xs: readonly T[]): T[][] => (xs.length ? xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])) : [[]]);
    for (const order of perms(flips)) {
      const d = sim(NOR_ADD4);
      d.set(start);
      for (const [k, v] of order) d.set({ [k]: v });
      d.set({ cc: 1 }); d.set({ cc: 0 });
      expect(word(d, 's'), order.map(([k]) => k).join(' ')).toBe(15);
    }
  });
  it('the 4-bit register takes d at a rising edge while en = 1; counts 38 and 60 gates', () => {
    const c = sim(NOR_REG4);
    c.set({ ...put('d', 0), en: 1, clk: 0 }); c.set({ clk: 1 });
    expect(word(c, 'q')).toBe(0);
    c.set({ ...put('d', 9), clk: 0 }); expect(word(c, 'q')).toBe(0);
    c.set({ clk: 1 }); expect(word(c, 'q')).toBe(9);
    c.set({ ...put('d', 6), en: 0, clk: 0 }); c.set({ clk: 1 }); expect(word(c, 'q')).toBe(9);
    expect(stats(NOR_ADD4)).toMatchObject({ nor3: 38, nands: 0 });
    expect(stats(NOR_REG4)).toMatchObject({ nor3: 60, nands: 0 });
  });
});
