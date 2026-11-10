// The Apollo Guidance Computer's brick (Appendix F, the act-1 NOR3 ladder): a three-input NOR in resistor-transistor
// logic, and what the ladder's reference answers build from it alone.
//
// The gate, as drawn on MIT Instrumentation Laboratory drawing 2005011 (Schematic, Dual NOR Gate, April 1965) and as
// R-700 vol. III (E. C. Hall, 1972) p. 9-10 describes the Block I gate: three NPN transistors with their emitters to
// ground and their collectors joined, one collector resistor to B+, and one base resistor in front of each input,
// "three NPN bipolar transistors and four resistors connected as a modified direct-coupled transistor logic or DCTL
// NOR gate". Here the NPNs are NMOS switches and the collector resistor is a pull-up (PULLUP: weaker than any
// transistor, so any input at 1 pulls y to 0). The three base resistors only limit each transistor's base current;
// at switch level they change no value, so they are counted (statsOf: 3 transistors, 4 resistors) but not simulated.
// Block II packed two such gates on one chip in a 10-lead flatpack (R-700 p. 13; drawing 2005011 shows the pair).

import { Builder } from './builder';
import { define } from './define';
import { PULLUP } from './switchparts';
import { GND, NMOS } from './transistors';
import type { ComponentDef, NetDef } from '../sim/types';

const bit = (name: string, dir: 'in' | 'out') => ({ name, width: 1, dir });

export const NOR3_RTL: ComponentDef = define({
  id: 'nor3_rtl', name: 'NOR3 (RTL, as in the AGC)', category: 'cell',
  summary: 'y = ¬(a + b + c): three transistors to ground in parallel under one collector resistor, the Apollo Guidance Computer\'s only logic gate. Counted as drawn on MIT drawing 2005011, 3 transistors and 4 resistors; the three base resistors only limit current, so the simulation leaves them out.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('c', 'in'), bit('y', 'out')],
  symbol: { kind: 'box', label: 'NOR3' },
  spec: ([a, b, c]) => [a || b || c ? 0 : 1],
  statsOf: () => ({ nands: 0, transistors: 3, resistors: 4, capacitors: 0, relays: 0, triodes: 0, diodes: 0, depletion: 0, parts: 5, descendants: 5, levels: 1, nor3: 1 }),
  netlist: () => ({
    level: 'switch',
    pins: { a: [1, 9], b: [1, 13], c: [1, 17], y: [26, 5] },
    instances: [
      { name: 'rc', def: PULLUP, at: [21, 0], label: 'collector resistor' },
      { name: 'qa', def: NMOS, at: [6, 7] },
      { name: 'qb', def: NMOS, at: [11, 11] },
      { name: 'qc', def: NMOS, at: [16, 15] },
      { name: 'gnd', def: GND, at: [21, 22] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'qa.g'] },
      { name: 'b', ends: ['b', 'qb.g'] },
      { name: 'c', ends: ['c', 'qc.g'] },
      { name: 'y', ends: ['rc.y', 'qa.d', 'qb.d', 'qc.d', 'y'] },
      { name: 'gnd', ends: ['gnd.p', 'qa.s', 'qb.s', 'qc.s'] },
    ],
  }),
  hdl: {
    verilog: `module nor3_rtl (input a, input b, input c, output y);
  supply0 gnd;
  pullup  (y);           // the collector resistor
  nmos qa (y, gnd, a);   // the three transistors (the base resistors are left out: they change no value)
  nmos qb (y, gnd, b);
  nmos qc (y, gnd, c);
endmodule`,
  },
});

/** A gate of a NOR3 circuit: its output net and its inputs (one to three nets; a gate with fewer ties the rest to its first). */
export type NorGate = [out: string, ins: string[]];

/**
 * A circuit of NOR3 gates, placed in columns by logic depth (a gate reading a later one, a latch's feedback, is
 * drawn with labels by the Builder). `gates` in order; inputs are pin names or other gates' output names.
 */
export function norCircuit(d: { id: string; name: string; summary: string; ins: string[]; outs: Record<string, string>; gates: NorGate[]; spec?: ComponentDef['spec'] }): ComponentDef {
  const byOut = new Map(d.gates.map(([o, ins], k) => [o, { k, ins }]));
  const depth = new Map<string, number>();
  const dep = (net: string, seen: Set<string>): number => {
    if (!byOut.has(net) || seen.has(net)) return 0;
    if (depth.has(net)) return depth.get(net)!;
    seen.add(net);
    const v = 1 + Math.max(...byOut.get(net)!.ins.map((x) => dep(x, seen)));
    seen.delete(net);
    depth.set(net, v);
    return v;
  };
  d.gates.forEach(([o]) => dep(o, new Set()));
  const cols = Math.max(...depth.values());
  const b = new Builder(8, 10, 4);
  const inst = new Map<string, string>();
  for (let c = 1; c <= cols; c++) {
    b.next();
    for (const [o] of d.gates.filter(([o]) => depth.get(o) === c)) inst.set(o, b.add(NOR3_RTL, undefined, `g_${o}`));
  }
  const drv = (net: string) => (inst.has(net) ? `${inst.get(net)}.y` : net);
  for (const [o, ins] of d.gates) {
    const three = [0, 1, 2].map((i) => ins[Math.min(i, ins.length - 1)]);
    three.forEach((x, i) => b.wire(drv(x), `${inst.get(o)}.${'abc'[i]}`));
    b.name(drv(o), o);
  }
  const outs = Object.keys(d.outs);
  for (const [p, net] of Object.entries(d.outs)) b.wire(drv(net), p);
  b.pins(...d.ins);
  const pins: Record<string, [number, number]> = {};
  d.ins.forEach((p, i) => (pins[p] = [0, 2 + 4 * i]));
  outs.forEach((p, i) => (pins[p] = [b.right, 2 + 4 * i]));
  const nets: NetDef[] = b.nets();
  return define({
    id: d.id, name: d.name, category: 'gate', summary: d.summary,
    ports: [...d.ins.map((n) => bit(n, 'in')), ...outs.map((n) => bit(n, 'out'))],
    symbol: { kind: 'box', label: d.name.toUpperCase() },
    ...(d.spec ? { spec: d.spec } : {}),
    netlist: () => ({ pins, instances: b.instances, nets }),
  });
}

// ---- the ladder's reference answers ----------------------------------------------------------

/** nor_basic: NOT, OR and AND of a and b (na = ¬a, o = a + b, y = a·b): 5 gates, ¬a shared by NOT and AND. */
export const NOR_BASIC = norCircuit({
  id: 'nor_basic', name: 'NOT, OR, AND in NOR3', summary: 'na = ¬a, o = a + b, y = a·b, every gate a NOR3: a gate with its inputs tied is a NOT; NOR then NOT is OR; NOR of the two inverted inputs is AND (De Morgan).',
  ins: ['a', 'b'], outs: { na: 'na', o: 'o', y: 'y' },
  gates: [['na', ['a']], ['nb', ['b']], ['nab', ['a', 'b']], ['o', ['nab']], ['y', ['na', 'nb']]],
  spec: ([a, b]) => [a ? 0 : 1, a | b, a & b],
});

/**
 * nor_fa: a full adder from nine NOR gates. It is the 9-NAND adder with every NAND a NOR: that swaps each gate's
 * function for its dual, and both outputs are self-dual (s = a ⊕ b ⊕ ci and the majority are their own duals),
 * so the same wiring adds. The first four gates give ¬(a ⊕ b), the next four turn that and ci into the sum.
 */
export const NOR_FA = norCircuit({
  id: 'nor_fa', name: 'Full adder in NOR3', summary: 'The 9-NAND full adder with every gate a NOR: s = a ⊕ b ⊕ ci and co the majority are self-dual, so the dual wiring adds too. 9 NOR3 gates.',
  ins: ['a', 'b', 'ci'], outs: { s: 's', co: 'co' },
  gates: [['n1', ['a', 'b']], ['n2', ['a', 'n1']], ['n3', ['b', 'n1']], ['h', ['n2', 'n3']], ['n5', ['h', 'ci']], ['n6', ['h', 'n5']], ['n7', ['ci', 'n5']], ['s', ['n6', 'n7']], ['co', ['n1', 'n5']]],
  spec: ([a, b, c]) => [a ^ b ^ c, a + b + c > 1 ? 1 : 0],
});

/**
 * nor_reg: a 1-bit register: q takes d at the rising edge of clk while en = 1, else holds. A master latch open while
 * clk = 0 (clk itself is its active-low enable), a slave open while clk = 1, each a cross-coupled NOR pair set and
 * reset through NOR gates; in front of the master, the enable's multiplexer chooses d or the register's own q.
 */
export const NOR_REG = norCircuit({
  id: 'nor_reg', name: 'Register bit in NOR3', summary: 'q takes d at the rising edge of clk while en = 1, else holds: a master and a slave latch, each a cross-coupled NOR pair, with the enable\'s multiplexer in front. 15 NOR3 gates.',
  ins: ['d', 'en', 'clk'], outs: { q: 'q' },
  gates: [
    ['enn', ['en']], ['dn', ['d']],
    ['x1', ['enn', 'dn']], ['x2', ['en', 'qn']], ['mn', ['x1', 'x2']], ['m', ['mn']],
    ['ms', ['mn', 'clk']], ['mr', ['m', 'clk']], ['qm', ['mr', 'qmn']], ['qmn', ['ms', 'qm']],
    ['ckn', ['clk']], ['ss', ['qmn', 'ckn']], ['sr', ['qm', 'ckn']], ['q', ['sr', 'qn']], ['qn', ['ss', 'q']],
  ],
});
