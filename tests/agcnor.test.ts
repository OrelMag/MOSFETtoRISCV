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
