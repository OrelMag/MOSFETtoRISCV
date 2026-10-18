// Act P's build levels (before the transistor): relay logic (a NAND, an XOR, an adder with the carry through contacts,
// a self-holding relay, the buzzer clock and its ÷2) and tube logic (an inverter driving another, the Eccles–Jordan
// flip-flop), each at switch level from its own parts only (a strict rule: relays, rails and loads; triodes, diodes,
// resistors and rails). The reference answers are prologue P1 / P2's library circuits drawn as chips. No DOM.

import type { BuildChallenge, ChallengeCheck, CustomRun, LibRule, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { RELAY_CLOCK, RELAY_FA, RELAY_LATCH, RELAY_NAND, RELAY_XOR, relayAdder } from '../lib/relays';
import { ECCLES_JORDAN, TUBE_BUF } from '../lib/tubes';
import { gateLevels, V_CUTOFF } from '../phys/triode';
import { flatten } from '../sim/flatten';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, type Bit, type ComponentDef } from '../sim/types';

export const RELAY_RULE: LibRule = {
  lib: ['relay', 'relay2', 'relay3', 'relay4', 'relay5', 'relay6', 'vdd', 'gnd', 'pulldown'], label: 'relays (1 to 6 poles), VDD, GND and loads', strict: true,
};
export const TUBE_RULE: LibRule = {
  lib: ['triode', 'vdiode', 'bplus', 'vneg', 'gnd', 'res', 'res_div', 'res_bias'], label: 'triodes, diodes, resistors, B+, −150 V and GND', strict: true,
};

const pinsOf = (def: ComponentDef): PinSpec[] => def.ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width }));

const answers = new Map<string, ChipDoc[]>();
/** A reference answer: the top def drawn as a chip, and `subs` (def → chip) drawn as chips it places. */
const refOf = (id: string, def: () => ComponentDef, name: string, subs: () => [ComponentDef, string][] = () => []) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const chips = new Map(subs().map(([d, n], i) => [d, { id: `u_ref_cp_${id}_${i}`, name: `${n} ref` }]));
  const refOfDef = (d: ComponentDef): PartRef | undefined => (chips.has(d) ? { chip: chips.get(d)!.id } : undefined);
  const docs: ChipDoc[] = [];
  for (const [d, c] of chips) {
    const doc = docFromDef(d, { ...c, refOf: refOfDef });
    if ('error' in doc) throw new Error(`reference ${id} (${d.id}): ${doc.error}`);
    docs.push({ ...doc, notes: `Part of the reference answer. ${d.summary ?? ''}`.trim() });
  }
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref`, refOf: refOfDef });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [...docs, { ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

const RELAY_NOTE = 'Relay rules: a pin on a coil\'s a end operates it (b to GND); contacts pass both ways at full strength; an output nobody drives reads Z, so end it on a load (a pull-down: the next coil). Scored in relays and in relay steps, the most steps one input change takes to come to rest.';
const TUBE_NOTE = 'Tube rules: a triode conducts plate → cathode while its grid is 1, only that way; a plate resistor (22 kΩ from B+) pulls the plate up. Every grid reads a plate level (an input pin is one too) through a divider: a divider resistor from it, a bias resistor to −150 V. Scored in tube sections (triodes and diodes).';

// ---- the tube grid rule -----------------------------------------------------------------------

const LV = gateLevels();
const v = (x: number) => `${Math.round(x)} V`;

/**
 * Every triode grid must read its input through a divider: never wired straight to a plate, an input (a plate level)
 * or B+, and held by a bias resistor to −150 V. Logic alone would not notice (the simulator's values are levels, not
 * volts), so Check asks for the divider the volts need.
 */
export function gridProblems(def: ComponentDef): string[] {
  let d;
  try { d = flatten(def, { mode: 'switch' }); } catch { return []; }
  const net = (li: number, t: number) => d.leaves[li].terminals![t];
  const plates = new Set<number>(), bplus = new Set<number>(), vneg = new Set<number>();
  d.leaves.forEach((l, li) => {
    if (l.kind === 'triode') plates.add(net(li, 1));
    if (l.kind === 'vdd' && l.def.id === 'bplus') bplus.add(net(li, 0));
    if (l.kind === 'gnd' && l.def.id === 'vneg') vneg.add(net(li, 0));
  });
  const inputs = new Set<number>();
  for (const p of def.ports) if (p.dir === 'in') for (const n of d.root.ports[p.name] ?? []) inputs.add(n);
  const biased = new Set<number>();
  d.leaves.forEach((l, li) => {
    if (l.kind !== 'res' || l.def.id !== 'res_bias') return;
    const [a, b] = [net(li, 0), net(li, 1)];
    if (vneg.has(b)) biased.add(a);
    if (vneg.has(a)) biased.add(b);
  });
  const out: string[] = [];
  d.leaves.forEach((l, li) => {
    if (l.kind !== 'triode') return;
    const g = net(li, 0), name = l.node.path.join('.') || l.node.name;
    const what = plates.has(g) ? 'a plate' : inputs.has(g) ? 'an input (a plate level)' : bplus.has(g) ? 'B+' : null;
    if (what) out.push(`${name}: its grid is wired straight to ${what}. A plate sits at ${v(LV.low)} or ${v(LV.high)}, far above the grid's cutoff of ${v(V_CUTOFF)}: the tube would conduct whatever it says. Read it through a divider (a divider resistor from the plate, a bias resistor to −150 V).`);
    else if (!biased.has(g)) out.push(`${name}: its grid has no bias resistor to −150 V. Without the divider's bottom leg the grid sits at the plate's voltage, never below cutoff.`);
  });
  return out;
}

// ---- the buzzer clock's bench -------------------------------------------------------------------

const bitText = (b: Bit) => (b === B1 ? '1' : b === B0 ? '0' : 'X');

/**
 * From power-on with en = 0, then en = 1 for 16 relay steps (one step() each), then en = 0 again and once more 1:
 * y must change at every step, q at every second step (from its first change on), and with en = 0 both rest.
 */
function clockBench(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode !== 'switch') return { failures: ['no relays: build the clock from relays'], tested: 0 };
  const sim = new SwitchSim(flatten(def, { mode: 'switch' }));
  if (!sim.hasRelays) return { failures: ['no relays: build the clock from relays'], tested: 0 };
  const read = (p: string) => sim.getBits(sim.design.root.ports[p])[0];
  const fails: string[] = [];
  let tested = 0;
  sim.setInput('en', 0);
  sim.reset('zero');
  sim.settle();
  if (sim.unstable) return { failures: ['with en = 0 it does not come to rest'], tested: 1 };
  const run = (k: number) => {
    const ys: Bit[] = [], qs: Bit[] = [];
    for (let i = 0; i < k; i++) {
      sim.step();
      ys.push(read('y'));
      qs.push(read('q'));
    }
    tested += k;
    return { ys, qs };
  };
  sim.setInput('en', 1);
  const { ys, qs } = run(17);
  const bad = [...ys, ...qs].findIndex((b) => b !== B0 && b !== B1);
  if (bad >= 0) fails.push(`with en = 1, ${bad < ys.length ? 'y' : 'q'} reads X at relay step ${bad % ys.length}: every line must be on the supply or open (0)`);
  else {
    const still = ys.findIndex((b, i) => i > 0 && b === ys[i - 1]);
    if (still >= 0) fails.push(`y stays ${bitText(ys[still])} from relay step ${still - 1} to ${still}: a buzzer changes at every step (y: ${ys.map(bitText).join('')})`);
    const ch = qs.flatMap((b, i) => (i > 0 && b !== qs[i - 1] ? [i] : []));
    const gaps = ch.slice(1).map((c, i) => c - ch[i]);
    if (ch.length < 6 || gaps.some((g) => g !== 2)) fails.push(`q must change at every second relay step (half y's rate); it reads ${qs.map(bitText).join('')} (y: ${ys.map(bitText).join('')})`);
  }
  sim.setInput('en', 0);
  let n = 0;
  while (sim.step() && n < 8) n++;
  tested += n + 1;
  if (n >= 8) fails.push('with en = 0 it keeps moving: en must stop the buzzer');
  else {
    const q0 = read('q');
    const rest = run(4);
    if (rest.ys.some((b) => b !== B0)) fails.push(`with en = 0, y must rest at 0 (it reads ${rest.ys.map(bitText).join('')})`);
    if (rest.qs.some((b) => b !== q0 || (b !== B0 && b !== B1))) fails.push(`with en = 0, q must hold its value (it reads ${bitText(q0)}${rest.qs.map(bitText).join('')})`);
    sim.setInput('en', 1);
    const again = run(5);
    if (again.ys.some((b, i) => i > 0 && b === again.ys[i - 1])) fails.push(`with en = 1 again the buzzer must start again (y: ${again.ys.map(bitText).join('')})`);
  }
  return { failures: fails, tested };
}

// ---- sequences --------------------------------------------------------------------------------

/** Set and reset pulses for a holding element (q, and nq when it has one), from power-on. */
function holdSteps(names: [string, string], nq: boolean): SeqStep[] {
  const [s, r] = names;
  const q = (x: number): Record<string, number> => (nq ? { q: x, nq: 1 - x } : { q: x });
  const pat: [Record<string, number>, number][] = [
    [{ [r]: 1 }, 0], [{ [r]: 0 }, 0], [{ [s]: 1 }, 1], [{ [s]: 0 }, 1], [{ [s]: 1 }, 1], [{ [s]: 0 }, 1],
    [{ [r]: 1 }, 0], [{ [r]: 0 }, 0], [{ [r]: 1 }, 0], [{ [r]: 0 }, 0], [{ [s]: 1 }, 1], [{ [s]: 0 }, 1], [{ [r]: 1 }, 0], [{ [r]: 0 }, 0],
  ];
  return [{ expect: {} }, ...pat.map(([set, x]) => ({ set, expect: q(x) }))];
}

const table = (spec: (ins: number[]) => number[]): ChallengeCheck => ({ kind: 'table', spec });

const ADD4 = relayAdder(4);

export const BUILDR: Record<string, () => BuildChallenge> = {
  r_nand: () => ({
    id: 'r_nand', title: 'A relay NAND', level: 'transistors', allowed: RELAY_RULE,
    brief: `y = ¬(a·b) from relays. ${RELAY_NOTE}`,
    ports: pinsOf(RELAY_NAND), check: table(([a, b]) => [a & b ? 0 : 1]),
    answer: refOf('r_nand', () => RELAY_NAND, 'Relay NAND'),
  }),
  r_xor: () => ({
    id: 'r_xor', title: 'Changeover XOR', level: 'transistors', allowed: RELAY_RULE,
    brief: `y = a ⊕ b from relays, with no coil waiting on another. ${RELAY_NOTE}`,
    ports: pinsOf(RELAY_XOR), check: table(([a, b]) => [a ^ b]),
    answer: refOf('r_xor', () => RELAY_XOR, 'Relay XOR'),
  }),
  r_adder: () => ({
    id: 'r_adder', title: 'Carry through contacts', level: 'transistors', allowed: RELAY_RULE,
    brief: `s = a + b (4 bits), co the carry out, ready one relay step after a and b change. ${RELAY_NOTE}`,
    ports: pinsOf(ADD4), check: table(([a, b]) => [(a + b) & 15, a + b > 15 ? 1 : 0]),
    answer: refOf('r_adder', () => ADD4, '4-bit relay adder', () => [[RELAY_FA, 'Relay full adder']]),
  }),
  r_latch: () => ({
    id: 'r_latch', title: 'A relay that holds', level: 'transistors', allowed: RELAY_RULE,
    brief: `set = 1 makes q = 1, reset = 1 makes q = 0; with both at 0, q holds (they are never 1 together). ${RELAY_NOTE}`,
    ports: pinsOf(RELAY_LATCH), check: { kind: 'sequence', steps: holdSteps(['set', 'reset'], false) },
    answer: refOf('r_latch', () => RELAY_LATCH, 'Self-holding relay'),
  }),
  r_clock: () => ({
    id: 'r_clock', title: 'The buzzer clock', level: 'transistors', allowed: RELAY_RULE,
    brief: `With en = 1, y changes at every relay step (a buzzer) and q at every second one (÷2); with en = 0, y rests at 0 and q holds. ${RELAY_NOTE}`,
    ports: pinsOf(RELAY_CLOCK),
    check: { kind: 'custom', describe: 'From power-on with en = 0: en = 1 for 16 relay steps (y must change at every step, q at every second one), then en = 0 (both must come to rest, q holding), then en = 1 again (the buzzer must restart).', run: clockBench },
    answer: refOf('r_clock', () => RELAY_CLOCK, 'Relay clock'),
  }),
  v_inv: () => ({
    id: 'v_inv', title: 'Two tubes in a row', level: 'transistors', allowed: TUBE_RULE,
    brief: `na = ¬a, y = a, from two tube inverters, the second reading the first's plate. ${TUBE_NOTE}`,
    ports: pinsOf(TUBE_BUF), check: table(([a]) => [a ? 0 : 1, a]), rules: gridProblems,
    answer: refOf('v_inv', () => TUBE_BUF, 'Two tube inverters'),
  }),
  v_ff: () => ({
    id: 'v_ff', title: 'Eccles–Jordan', level: 'transistors', allowed: TUBE_RULE,
    brief: `set = 1 makes q = 1, reset = 1 makes q = 0, and nq = ¬q always; with both at 0 the pair holds (they are never 1 together). ${TUBE_NOTE}`,
    ports: pinsOf(ECCLES_JORDAN), check: { kind: 'sequence', steps: holdSteps(['set', 'reset'], true) }, rules: gridProblems,
    answer: refOf('v_ff', () => ECCLES_JORDAN, 'Eccles–Jordan flip-flop'),
  }),
};
