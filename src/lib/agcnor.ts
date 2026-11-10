// The Apollo Guidance Computer's brick (Appendix F, the NOR3 ladder): a three-input NOR in resistor-transistor logic,
// and what the ladder's reference answers build from it alone.
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
import { layered } from './layered';
import { PULLUP } from './switchparts';
import { GND, NMOS } from './transistors';
import type { ComponentDef, Netlist } from '../sim/types';

const bit = (name: string, dir: 'in' | 'out') => ({ name, width: 1, dir });

export const NOR3_RTL: ComponentDef = define({
  id: 'nor3_rtl', name: 'NOR3 (RTL, as in the AGC)', category: 'gate',
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
/** A sub-block of a NOR3 circuit: an instance of another NOR3 circuit, its inputs and outputs as nets in port order. */
export interface NorBlock { name: string; def: ComponentDef; ins: string[]; outs: string[] }

/** A hand placement of a NOR3 circuit: instance corners, pin positions, and corner points per net and sink ('inst.port' or a pin). */
export interface NorPlace { at: Record<string, [number, number]>; flip?: string[]; pins: Record<string, [number, number]>; via?: Record<string, Record<string, [number, number][]>> }

/**
 * A circuit of NOR3 gates and smaller NOR3 circuits, laid out by logic depth (lib/layered.ts), every net a wire.
 * Parts in order; inputs are pin names or nets the parts drive. A gate is instance g_<its output net>.
 */
export function norCircuit(d: { id: string; name: string; summary: string; ins: string[]; outs: Record<string, string>; parts: (NorGate | NorBlock)[]; spec?: ComponentDef['spec']; column?: Record<string, number>; place?: NorPlace }): ComponentDef {
  const parts: NorBlock[] = d.parts.map((x) => (Array.isArray(x)
    ? { name: `g_${x[0]}`, def: NOR3_RTL, ins: [0, 1, 2].map((i) => x[1][Math.min(i, x[1].length - 1)]), outs: [x[0]] }
    : x));
  const portsOf = (def: ComponentDef, dir: 'in' | 'out') => def.ports.filter((p) => p.dir === dir).map((p) => p.name);
  const driver = new Map<string, string>();
  for (const q of parts) portsOf(q.def, 'out').forEach((p, i) => q.outs[i] && driver.set(q.outs[i], `${q.name}.${p}`));
  const b = new Builder(8, 10, 4);
  for (const q of parts) b.add(q.def, undefined, q.name);
  const drv = (net: string) => driver.get(net) ?? net;
  for (const q of parts) {
    portsOf(q.def, 'in').forEach((p, i) => b.wire(drv(q.ins[i]), `${q.name}.${p}`));
    for (const o of q.outs) b.name(drv(o), o);
  }
  const outs = Object.keys(d.outs);
  for (const [p, net] of Object.entries(d.outs)) b.wire(drv(net), p);
  b.pins(...d.ins);
  const ports = [...d.ins.map((n) => bit(n, 'in')), ...outs.map((n) => bit(n, 'out'))];
  return define({
    id: d.id, name: d.name, category: 'gate', summary: d.summary,
    ports,
    symbol: { kind: 'box', label: d.name.toUpperCase() },
    ...(d.spec ? { spec: d.spec } : {}),
    netlist: () => (d.place ? placed(d.place, d.ins, outs, d.outs, parts, driver) : { ...layered(ports, b, { gap: 8, ...(d.column ? { column: d.column } : {}), wires: Object.fromEntries(b.nets().map((n) => [n.ends[0], true])) }), level: 'switch' }),
  });
}

// ---- the ladder's reference answers ----------------------------------------------------------

/** nor_basic: NOT, OR and AND of a and b (na = ¬a, o = a + b, y = a·b): 5 gates, ¬a shared by NOT and AND. */
export const NOR_BASIC = norCircuit({
  id: 'nor_basic', name: 'NOT, OR, AND in NOR3', summary: 'na = ¬a, o = a + b, y = a·b, every gate a NOR3: a gate with its inputs tied is a NOT; NOR then NOT is OR; NOR of the two inverted inputs is AND (De Morgan).',
  ins: ['a', 'b'], outs: { na: 'na', o: 'o', y: 'y' },
  parts: [['na', ['a']], ['nb', ['b']], ['nab', ['a', 'b']], ['o', ['nab']], ['y', ['na', 'nb']]],
  spec: ([a, b]) => [a ? 0 : 1, a | b, a & b],
});

/** z = ¬(x ⊕ y) from four NORs, and n = NOR(x, y), the first of them, which the full adder's carry reads. */
export const NOR_XNOR = norCircuit({
  id: 'nor_xnor', name: 'XNOR in NOR3', summary: 'z = ¬(x ⊕ y) from four NOR gates, the 4-NAND XOR with every gate a NOR (the dual of XOR is XNOR); n = NOR(x, y), its first gate, is an output too.',
  ins: ['x', 'y'], outs: { z: 'z', n: 'n' },
  parts: [['n', ['x', 'y']], ['p', ['x', 'n']], ['q', ['y', 'n']], ['z', ['p', 'q']]],
  spec: ([x, y]) => [x ^ y ? 0 : 1, x | y ? 0 : 1],
  // drawn by hand: n's trunk between the first gate and the pair it feeds, n out along the bottom; y crosses it once
  place: {
    at: { g_p: [24, 0], g_n: [10, 8], g_q: [24, 16], g_z: [38, 8] },
    pins: { x: [0, 2], y: [0, 18], z: [52, 12], n: [52, 26] },
    via: {
      x: { 'g_n.a': [[6, 2], [6, 10]] },
      y: { 'g_n.b': [[7, 18], [7, 12]], 'g_n.c': [[7, 18], [7, 14]] },
      n: { 'g_p.b': [[21, 12], [21, 4]], 'g_p.c': [[21, 12], [21, 6]], 'g_q.b': [[21, 12], [21, 20]], 'g_q.c': [[21, 12], [21, 22]], n: [[21, 12], [21, 26]] },
      p: { 'g_z.a': [[34, 4], [34, 10]] },
      q: { 'g_z.b': [[36, 20], [36, 12]], 'g_z.c': [[36, 20], [36, 14]] },
    },
  },
});

/**
 * nor_fa: a full adder from nine NOR gates. It is the 9-NAND adder with every NAND a NOR: that swaps each gate's
 * function for its dual, and both outputs are self-dual (s = a ⊕ b ⊕ ci and the majority are their own duals),
 * so the same wiring adds. The first XNOR gives h = ¬(a ⊕ b); the second, of h and ci, is the sum.
 */
export const NOR_FA = norCircuit({
  id: 'nor_fa', name: 'Full adder in NOR3', summary: 'The 9-NAND full adder with every gate a NOR: s = a ⊕ b ⊕ ci and co the majority are self-dual, so the dual wiring adds too. Two 4-gate XNORs and the carry gate: 9 NOR3 gates.',
  ins: ['a', 'b', 'ci'], outs: { s: 's', co: 'co' },
  parts: [
    { name: 'xa', def: NOR_XNOR, ins: ['a', 'b'], outs: ['h', 'n1'] },
    { name: 'xb', def: NOR_XNOR, ins: ['h', 'ci'], outs: ['s', 'n5'] },
    ['co', ['n1', 'n5']],
  ],
  spec: ([a, b, c]) => [a ^ b ^ c, a + b + c > 1 ? 1 : 0],
  // drawn by hand: the sum runs straight out above the carry gate; n1 passes under the second XNOR to the carry gate
  place: {
    at: { xa: [10, 2], xb: [32, 2], g_co: [52, 8] },
    pins: { a: [0, 4], b: [0, 6], ci: [0, 14], s: [66, 4], co: [66, 12] },
    via: {
      ci: { 'xb.y': [[28, 14], [28, 6]] },
      n1: { 'g_co.a': [[26, 6], [26, 10]] },
      n5: { 'g_co.b': [[49, 6], [49, 12]], 'g_co.c': [[49, 6], [49, 14]] },
    },
  },
});

/** A gated latch, open while en_n = 0: set = NOR(¬d, en_n), reset = NOR(d, en_n), into a cross-coupled NOR pair. */
export const NOR_LATCH = norCircuit({
  id: 'nor_latch', name: 'Latch in NOR3', summary: 'q follows d while en_n = 0 and holds while en_n = 1: two NOR gates set and reset a cross-coupled pair, which holds a bit while both are 0. d and ¬d both come in (a flip-flop\'s slave takes them from its master). 4 NOR3 gates.',
  ins: ['d', 'dn', 'en_n'], outs: { q: 'q', qn: 'qn' },
  parts: [['s', ['en_n', 'en_n', 'dn']], ['r', ['d', 'en_n']], ['q', ['r', 'qn']], ['qn', ['q', 'q', 's']]],
  // drawn by hand: reset and q on top, set and qn below, en_n between them on the left, the pair's feedback crossing once
  place: {
    at: { g_r: [10, 0], g_s: [10, 12], g_q: [26, 0], g_qn: [26, 12] },
    pins: { d: [0, 2], en_n: [0, 10], dn: [0, 18], q: [44, 4], qn: [44, 16] },
    via: {
      en_n: { 'g_r.b': [[6, 10], [6, 4]], 'g_r.c': [[6, 10], [6, 6]], 'g_s.a': [[6, 10], [6, 14]], 'g_s.b': [[6, 10], [6, 16]] },
      r: { 'g_q.a': [[22, 4], [22, 2]] },
      s: { 'g_qn.c': [[22, 16], [22, 18]] },
      q: { 'g_qn.a': [[36, 4], [36, 11], [24, 11], [24, 14]], 'g_qn.b': [[36, 4], [36, 11], [24, 11], [24, 16]] },
      qn: { 'g_q.b': [[38, 16], [38, 9], [23, 9], [23, 4]], 'g_q.c': [[38, 16], [38, 9], [23, 9], [23, 6]] },
    },
  },
});

/** m = en ? d : q, and its inverse: the register's enable, in front of its master latch. */
export const NOR_ENMUX = norCircuit({
  id: 'nor_enmux', name: 'Enable mux in NOR3', summary: 'm = en ? d : q (the register\'s own q, read as ¬q from qn) and mn = ¬m: en·d and ¬en·q as NORs of inverted inputs, their NOR is ¬m, one more gate m. 6 NOR3 gates.',
  ins: ['d', 'en', 'qn'], outs: { m: 'm', mn: 'mn' },
  parts: [['enn', ['en']], ['dn', ['d']], ['x1', ['dn', 'enn']], ['x2', ['en', 'qn']], ['mn', ['x1', 'x2']], ['m', ['mn']]],
  // drawn by hand: the two inverters, the two products, their NOR and its inverse in four columns, no crossing
  place: {
    at: { g_dn: [10, 0], g_enn: [10, 10], g_x1: [24, 0], g_x2: [24, 18], g_mn: [38, 8], g_m: [52, 8] },
    pins: { d: [0, 4], en: [0, 14], qn: [0, 24], m: [66, 12], mn: [66, 20] },
    via: {
      d: { 'g_dn.a': [[7, 4], [7, 2]], 'g_dn.c': [[7, 4], [7, 6]] },
      en: { 'g_enn.a': [[6, 14], [6, 12]], 'g_enn.c': [[6, 14], [6, 16]], 'g_x2.a': [[6, 14], [6, 20]] },
      qn: { 'g_x2.b': [[21, 24], [21, 22]] },
      dn: { 'g_x1.a': [[21, 4], [21, 2]] },
      enn: { 'g_x1.b': [[22, 14], [22, 4]], 'g_x1.c': [[22, 14], [22, 6]] },
      x1: { 'g_mn.a': [[35, 4], [35, 10]] },
      x2: { 'g_mn.b': [[36, 22], [36, 12]], 'g_mn.c': [[36, 22], [36, 14]] },
      mn: { 'g_m.a': [[49, 12], [49, 10]], 'g_m.c': [[49, 12], [49, 14]], mn: [[49, 12], [49, 20]] },
    },
  },
});

/**
 * nor_reg: a 1-bit register: q takes d at the rising edge of clk while en = 1, else holds. The enable's multiplexer
 * chooses d or the register's own q; the master latch is open while clk = 0 (clk itself is its active-low enable),
 * the slave while clk = 1 (one inverter), and it takes the master's q and ¬q, so it needs no inverter of its own.
 */
export const NOR_REG = norCircuit({
  id: 'nor_reg', name: 'Register bit in NOR3', summary: 'q takes d at the rising edge of clk while en = 1, else holds: the enable\'s multiplexer, a master latch open while clk = 0 and a slave open while clk = 1, each a cross-coupled NOR pair. 15 NOR3 gates.',
  ins: ['d', 'en', 'clk'], outs: { q: 'q' },
  parts: [
    { name: 'mux', def: NOR_ENMUX, ins: ['d', 'en', 'qn'], outs: ['m', 'mn'] },
    { name: 'master', def: NOR_LATCH, ins: ['m', 'mn', 'clk'], outs: ['qm', 'qmn'] },
    ['ckn', ['clk']],
    { name: 'slave', def: NOR_LATCH, ins: ['qm', 'qmn', 'ckn'], outs: ['q', 'qn'] },
  ],
  // drawn by hand: multiplexer, master and slave in a row, clk under them into the master and its inverter, q's inverse back along the bottom
  place: {
    at: { mux: [10, 0], master: [34, 0], g_ckn: [42, 10], slave: [56, 0] },
    pins: { d: [0, 2], en: [0, 4], clk: [0, 14], q: [80, 3] },
    via: {
      m: { 'master.d': [[31, 3], [31, 2]] },
      mn: { 'master.dn': [[32, 5], [32, 4]] },
      clk: { 'master.en_n': [[30, 14], [30, 6]], 'g_ckn.a': [[40, 14], [40, 12]], 'g_ckn.c': [[40, 14], [40, 16]] },
      qm: { 'slave.d': [[53, 3], [53, 2]] },
      qmn: { 'slave.dn': [[54, 5], [54, 4]] },
      ckn: { 'slave.en_n': [[55, 14], [55, 6]] },
      qn: { 'mux.qn': [[74, 5], [74, 20], [7, 20], [7, 6]] },
    },
  },
});

/** A NOR3 circuit's netlist from a hand placement: one net per signal, its driver first. */
function placed(p: NorPlace, ins: string[], outs: string[], outNet: Record<string, string>, parts: NorBlock[], driver: Map<string, string>): Netlist {
  const portsOf = (def: ComponentDef, dir: 'in' | 'out') => def.ports.filter((q) => q.dir === dir).map((q) => q.name);
  const ends = new Map<string, string[]>();
  const end = (net: string) => { if (!ends.has(net)) ends.set(net, [driver.get(net) ?? net]); return ends.get(net)!; };
  for (const q of parts) portsOf(q.def, 'in').forEach((port, i) => end(q.ins[i]).push(`${q.name}.${port}`));
  for (const o of outs) end(outNet[o]).push(o);
  for (const n of ins) end(n);
  return {
    level: 'switch',
    pins: p.pins,
    instances: parts.map((q) => ({ name: q.name, def: q.def, at: p.at[q.name], ...(p.flip?.includes(q.name) ? { flip: true } : {}) })),
    nets: [...ends].map(([name, e]) => ({ name, ends: e, ...(p.via?.[name] ? { via: p.via[name] } : {}) })),
  };
}

// ---- Appendix F: the one's-complement adder and register, in NOR3 ------------------------------

const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

/**
 * nor_add4: a 4-bit one's-complement adder: four NOR3 full adders with the carry out of the top bit brought back into
 * the bottom one (the end-around carry), so s = a + b in one's complement (−0 is 1111). The carry ring is a loop that
 * can hold a carry nothing generates: when every bit propagates (a + ¬a) a carry of 0 all round and a carry of 1 all
 * round are both stable (−0 and +0), and while the operands change a gate can glitch a carry into the ring that then
 * stays. So the ring passes through two gates with a carry-clear input cc: hold cc = 1 while a and b change, then
 * release it, and a + ¬a is −0 as the AGC's programs expect. (R-700 p. 69: Block II division needed "the removal of
 * carry propagations in the adder", so logic was added to suppress the carries.) 38 NOR3 gates.
 */
export const NOR_ADD4 = norCircuit({
  id: 'nor_add4', name: 'One\'s-complement adder in NOR3', summary: 'Four NOR3 full adders in a ring: the carry out of bit 3 comes back into bit 0 (the end-around carry), so s = a + b in one\'s complement on 4 bits. The ring passes through a carry clear (cc): held at 1 while the operands change, so no stray carry is left circling; then a + ¬a is −0. 38 NOR3 gates.',
  ins: [...range(4, (i) => `a${i}`), ...range(4, (i) => `b${i}`), 'cc'], outs: Object.fromEntries(range(4, (i) => [`s${i}`, `s${i}`])),
  parts: [
    ...range(4, (i) => ({ name: `fa${i}`, def: NOR_FA, ins: [`a${i}`, `b${i}`, i === 0 ? 'eacin' : `c${i}`], outs: [`s${i}`, i === 3 ? 'eac' : `c${i + 1}`] })),
    ['neac', ['eac']] as NorGate,
    ['eacin', ['neac', 'cc']] as NorGate,
  ],
  place: {
    at: { ...Object.fromEntries(range(4, (i) => [`fa${i}`, [20, 12 * i + 22] as [number, number]])), g_neac: [30, 0], g_eacin: [8, 8] },
    flip: ['g_neac'],
    pins: Object.fromEntries([
      ...range(4, (i) => [`a${i}`, [0, 12 * i + 24]]), ...range(4, (i) => [`b${i}`, [0, 12 * i + 26]]), ...range(4, (i) => [`s${i}`, [60, 12 * i + 25]]), ['cc', [0, 12]],
    ] as [string, [number, number]][]),
    via: {
      ...Object.fromEntries(range(3, (i) => [`c${i + 1}`, { [`fa${i + 1}.ci`]: [[41, 12 * i + 27], [41, 12 * i + 31], [17, 12 * i + 31], [17, 12 * i + 40]] }])),
      eac: { 'g_neac.a': [[44, 63], [44, 2]], 'g_neac.b': [[44, 63], [44, 4]], 'g_neac.c': [[44, 63], [44, 6]] },
      neac: { 'g_eacin.a': [[6, 4], [6, 10]] },
      cc: { 'g_eacin.c': [[4, 12], [4, 14]] },
      eacin: { 'fa0.ci': [[18, 12], [18, 28]] },
    },
  },
});

/** One's-complement sum of two 4-bit words, as nor_add4 gives it with its carries cleared first. */
export const onesAdd4 = (a: number, b: number): number => { const s = a + b; return s > 15 ? (s + 1) & 15 : s; };

/** nor_reg4: four NOR3 register bits on one enable and one clock: q takes d at the rising edge of clk while en = 1. 60 NOR3 gates. */
export const NOR_REG4 = norCircuit({
  id: 'nor_reg4', name: '4-bit register in NOR3', summary: 'Four NOR3 register bits sharing en and clk: q takes d at the rising edge of clk while en = 1, else holds. Each bit is a multiplexer, a master and a slave latch, 15 NOR3 gates; 60 in all.',
  ins: [...range(4, (i) => `d${i}`), 'en', 'clk'], outs: Object.fromEntries(range(4, (i) => [`q${i}`, `q${i}`])),
  parts: range(4, (i) => ({ name: `r${i}`, def: NOR_REG, ins: [`d${i}`, 'en', 'clk'], outs: [`q${i}`] })),
  place: {
    at: Object.fromEntries(range(4, (i) => [`r${i}`, [14, 12 * i + 2] as [number, number]])),
    pins: Object.fromEntries([...range(4, (i) => [`d${i}`, [0, 12 * i + 4]]), ...range(4, (i) => [`q${i}`, [44, 12 * i + 6]]), ['en', [0, 50]], ['clk', [0, 52]]] as [string, [number, number]][]),
    via: {
      en: Object.fromEntries(range(4, (i) => [`r${i}.en`, [[8, 50], [8, 12 * i + 6]]])),
      clk: Object.fromEntries(range(4, (i) => [`r${i}.clk`, [[10, 52], [10, 12 * i + 8]]])),
    },
  },
});
