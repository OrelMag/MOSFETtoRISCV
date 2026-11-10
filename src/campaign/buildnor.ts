// The act-1 NOR3 ladder (optional): the same logic from the Apollo Guidance Computer's only gate, a three-input NOR in
// resistor-transistor logic (lib/agcnor.ts), graded in NOR3 gates beside the NAND answers of the levels it follows.
// Switch level, like act P: Check runs the chip on SwitchSim, and the rule allows the NOR3 gate and wiring alone.

import type { BuildChallenge, LibRule, PinSpec, SeqStep } from '../editor/challenges';
import { NOR_BASIC, NOR_ENMUX, NOR_FA, NOR_LATCH, NOR_REG, NOR_XNOR } from '../lib/agcnor';
import type { ComponentDef } from '../sim/types';
import { refOf } from './buildr';

export const NOR3_RULE: LibRule = { lib: ['nor3_rtl'], label: 'NOR3 gates only', strict: true };

const NOR3_NOTE = 'NOR3 rules: the only part is the AGC\'s three-input NOR (y = 1 only while a, b and c are all 0). Tie inputs together for fewer: NOR3(a, a, a) is a NOT, NOR3(a, b, b) a two-input NOR. Each gate is priced as drawn on MIT\'s drawing 2005011, 3 transistors and 4 resistors; the simulation leaves out the three base resistors, which only limit current and change no value. Scored in NOR3 gates.';

const pinsOf = (def: ComponentDef, clock?: string): PinSpec[] =>
  def.ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.name === clock ? { clock: true } : {}) }));

/** The register bit's test: load with en = 1, hold with en = 0 (a value on d must not get in), d changing between edges. */
function regSteps(): SeqStep[] {
  const st: SeqStep[] = [];
  let q = 0;
  [1, 0, 1, 1, 0, 0, 1, 0].forEach((d, i) => {
    const en = i % 3 === 2 ? 0 : 1;
    if (en) q = d;
    st.push({ set: { d, en }, tick: true, expect: { q } });
    st.push({ set: { d: d ^ 1 }, expect: { q } }); // no edge: no change
  });
  return st;
}

export const BUILDNOR: Record<string, () => BuildChallenge> = {
  nor_basic: () => ({
    id: 'nor_basic', title: 'NOT, OR, AND from NOR3', level: 'transistors', allowed: NOR3_RULE,
    brief: `na = ¬a, o = a + b and y = a·b, from NOR3 gates only. ${NOR3_NOTE}`,
    ports: pinsOf(NOR_BASIC), check: { kind: 'table', spec: ([a, b]) => [a ? 0 : 1, a | b, a & b] },
    answer: refOf('nor_basic', () => NOR_BASIC, 'NOT, OR, AND in NOR3'),
  }),
  nor_fa: () => ({
    id: 'nor_fa', title: 'A full adder in NOR3', level: 'transistors', allowed: NOR3_RULE,
    brief: `s = a ⊕ b ⊕ ci and co = 1 when two or more of a, b, ci are 1, from NOR3 gates only. ${NOR3_NOTE}`,
    ports: pinsOf(NOR_FA), check: { kind: 'table', spec: ([a, b, c]) => [a ^ b ^ c, a + b + c > 1 ? 1 : 0] },
    answer: refOf('nor_fa', () => NOR_FA, 'Full adder in NOR3', () => [[NOR_XNOR, 'XNOR in NOR3']]),
  }),
  nor_reg: () => ({
    id: 'nor_reg', title: 'A register bit in NOR3', level: 'transistors', allowed: NOR3_RULE,
    brief: `q takes d at the rising edge of clk while en = 1 and holds while en = 0; d changing between edges must not reach q. From NOR3 gates only. ${NOR3_NOTE}`,
    ports: pinsOf(NOR_REG, 'clk'), check: { kind: 'sequence', steps: regSteps() },
    answer: refOf('nor_reg', () => NOR_REG, 'Register bit in NOR3', () => [[NOR_ENMUX, 'Enable mux in NOR3'], [NOR_LATCH, 'Latch in NOR3']]),
  }),
};
