// The PDP-8 in gates (Examples ▸ PDP-8 in gates): DEC's 12-bit machine of 1965 built from the library, one clock edge
// per major state. Fetch reads the word at PC; Defer (an indirect reference) reads the pointer, adding 1 first through
// 0010–0017 (auto-index); Execute does AND / TAD / ISZ / DCA / JMS on the operand; a JMP needs no Execute, an operate or
// IOT instruction is Fetch alone. An interrupt takes the place of a Fetch: core[0] = PC, PC = 1 (DEC's JMS 0).
// DEC split each memory cycle into four time pulses (TP1–TP4) to read, rewrite and change the registers in order; here
// one edge does all of it, since the core is a RAM part read at once (no destructive read to restore).
// The golden model is src/pdp8/pdp8.ts; tests/pdp8gates.test.ts runs the gates in lock step with it.
//
// Blocks: CONTROL (major state, IR, RUN, interrupts, the front panel's keys, every select and enable), MA & MB (the
// effective address, the core's address, the next MA and MB, the word written), PC (PC + 1, + 2 for a skip, a jump,
// MA + 1 for JMS), AC & LINK (the adder, AND, both operate groups, MQ), TELETYPE (IOTs 03 and 04: keyboard buffer and
// printer flag). pdp8Core leaves the core outside on maddr / din / mwe / dout; pdp8Computer puts a 4K × 12 RAM inside.

import type { ComponentDef, Netlist, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { instPort } from '../sim/geometry';
import { bigRamWithInit } from './bigmem';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree, rca } from './combinational';
import { define, merger, splitter } from './define';
import { laid } from './layered';
import { AND, NOR, NOT, OR, XOR } from './gates';
import { DFFE, register } from './sequential';
import { TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);
const outs = (ps: PortDef[]) => ps.filter((p) => p.dir === 'out').map((p) => p.name);
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
/** A Builder level as drawn by its columns, the nets driven from `pointers` (driver ends) drawn as pointers: a wire there would run under a part. */
const columns = (f: () => Netlist, pointers: string[] = []) => (): Netlist => { const nl = f(); return { ...nl, nets: nl.nets.map((n) => (pointers.includes(n.ends[0]) ? { ...n, tags: true } : n)) }; };
const ones = (n: number) => Array<number>(n).fill(1);
const M12 = 0o7777;

/** n copies of a 1-bit signal as an n-bit word. */
const rep = (b: Builder, s: string, n: number, label?: string) => b.op1(merger(ones(n)), Array<string>(n).fill(s), label);
/** A 1-bit net's bits of a word: splitter outputs o0 (bit 0) … */
const bitsOf = (b: Builder, w: string, n: number, label?: string) => {
  const s = b.op(splitter(ones(n)), [w], label);
  return Array.from({ length: n }, (_, i) => `${s}.o${i}`);
};

// ---- operate group 1 ---------------------------------------------------------------------------

/** Group 1 on (L, AC): CLA CLL, then CMA CML, then IAC, then one rotate (RAR RAL, twice with bit 1) or BSW. w: bits 7–0. */
export function opr1Ref(w: number, l: number, ac: number): [number, number] {
  const b = (k: number) => (w >> k) & 1;
  if (b(7)) ac = 0;
  if (b(6)) l = 0;
  if (b(5)) ac ^= M12;
  if (b(4)) l ^= 1;
  if (b(0)) { const s = ac + 1; if (s > M12) l ^= 1; ac = s & M12; }
  const two = b(1), right = b(3), left = b(2);
  if (right && !left) for (let k = two ? 2 : 1; k; k--) { const lo = ac & 1; ac = (ac >> 1) | (l << 11); l = lo; }
  else if (left && !right) for (let k = two ? 2 : 1; k; k--) { const hi = ac >> 11; ac = ((ac << 1) & M12) | l; l = hi; }
  else if (two && !left && !right) ac = ((ac & 0o77) << 6) | (ac >> 6);
  return [ac, l];
}

const OPR1_PORTS: PortDef[] = [bus('w', 8, 'in'), bit('l', 'in'), bus('ac', 12, 'in'), bus('y', 12, 'out'), bit('ly', 'out')];

export const PDP8_OPR1: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('w', 'l', 'ac');
  const [iac, two, ral, rar, cml, cma, cll, cla] = bitsOf(b, 'w', 8, 'microinstructions');
  ['iac', 'two', 'ral', 'rar', 'cml', 'cma', 'cll', 'cla'].forEach((n, i) => b.name([iac, two, ral, rar, cml, cma, cll, cla][i], n, true));
  b.next();
  const a1 = b.op1(bitwise('and', 12), ['ac', rep(b, b.op1(NOT, [cla]), 12)], 'CLA');
  const l1 = b.op1(AND, ['l', b.op1(NOT, [cll])], 'CLL');
  b.next();
  const a2 = b.name(b.op1(bitwise('xor', 12), [a1, rep(b, cma, 12)], 'CMA'), 'a2', true);
  const l2 = b.op1(XOR, [l1, cml], 'CML');
  b.next();
  const inc = b.op(incrementer(12), [a2], 'IAC: AC + 1');
  b.next();
  const a3 = b.name(b.op1(busMux2(12), [a2, `${inc}.y`, iac], 'IAC?'), 'a3', true);
  const l3 = b.name(b.op1(XOR, [l2, b.op1(AND, [iac, `${inc}.cout`])], 'carry flips L'), 'l3', true);
  b.next();
  const a = bitsOf(b, a3, 12, 'AC bits');
  b.next();
  // The six arrangements of (L, AC) as wiring: inputs 0–11 the new AC, 12 the new L.
  const word = (acBits: string[], l: string, label: string) => b.op1(merger(ones(13)), [...acBits, l], label);
  const none = word(a, l3, 'as is');
  const bsw = word(a.map((_, i) => a[(i + 6) % 12]), l3, 'BSW');
  const ral1 = word(a.map((_, i) => (i === 0 ? l3 : a[i - 1])), a[11], 'RAL');
  const rtl = word(a.map((_, i) => (i === 0 ? a[11] : i === 1 ? l3 : a[i - 2])), a[10], 'RTL');
  const rar1 = word(a.map((_, i) => (i === 11 ? l3 : a[i + 1])), a[0], 'RAR');
  const rtr = word(a.map((_, i) => (i === 10 ? l3 : i === 11 ? a[0] : a[i + 2])), a[1], 'RTR');
  const sel = b.op1(merger([1, 1, 1]), [two, ral, rar], 'rotate code');
  b.next();
  const out = b.op1(muxTree(3, 13), [none, bsw, ral1, rtl, rar1, rtr, none, none, sel], 'rotate');
  b.next();
  const o = b.op(splitter([12, 1]), [out], 'L, AC');
  b.wire(`${o}.o0`, 'y');
  b.wire(`${o}.o1`, 'ly');
  const R = b.right;
  return define({
    id: 'pdp8_opr1', name: 'Operate group 1 (PDP-8)', category: 'cpu',
    summary: 'The PDP-8\'s group 1 microinstructions on the link and accumulator, in DEC\'s order: CLA CLL, then CMA CML, then IAC (its carry flips L), then one of RAR, RTR, RAL, RTL or BSW, picked by a multiplexer among the six arrangements of the 13 bits (wiring).',
    ports: OPR1_PORTS,
    symbol: { kind: 'box', label: 'GROUP 1' },
    spec: ([w, l, ac]) => opr1Ref(w, l, ac),
    netlist: () => ({ pins: { ...pinsAt(ins(OPR1_PORTS), 0, 6), y: [R, 8], ly: [R, 14] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- operate groups 2 and 3 --------------------------------------------------------------------

/**
 * Group 2 (w bit 0 = 0): the skip test (SMA SZA SNL, bit 3 reverses it to SPA SNA SZL), then CLA, then OSR, then HLT.
 * Group 3 (bit 0 = 1): CLA, then MQA / MQL (both: SWP). Returns [ac, mq, skip, halt].
 */
export function opr23Ref(w: number, l: number, ac: number, mq: number, sr: number): [number, number, number, number] {
  const b = (k: number) => (w >> k) & 1;
  const a = b(7) ? 0 : ac;
  if (!b(0)) {
    const t = (b(6) && ac >> 11) || (b(5) && ac === 0) || (b(4) && l) ? 1 : 0;
    return [a | (b(2) ? sr & M12 : 0), mq, t ^ b(3), b(1)];
  }
  return [(b(4) ? 0 : a) | (b(6) ? mq : 0), b(4) ? a : mq, 0, 0];
}

const OPR23_PORTS: PortDef[] = [
  bus('w', 8, 'in'), bit('l', 'in'), bus('ac', 12, 'in'), bus('mq', 12, 'in'), bus('sr', 12, 'in'),
  bus('y', 12, 'out'), bus('mqy', 12, 'out'), bit('skip', 'out'), bit('halt', 'out'),
];

export const PDP8_OPR23: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('w', 'l', 'ac', 'mq', 'sr');
  const [g3, hlt, osr, rev, snl, sza, sma, cla] = bitsOf(b, 'w', 8, 'microinstructions');
  ['g3', 'hlt', 'osr', 'rev', 'snl', 'sza', 'sma', 'cla'].forEach((n, i) => b.name([g3, hlt, osr, rev, snl, sza, sma, cla][i], n, true));
  const neg = b.name(bitsOf(b, 'ac', 12, 'AC bits')[11], 'neg', true);
  const zero = b.name(b.op1(isZero(12), ['ac'], 'AC = 0'), 'zero', true);
  const ng3 = b.name(b.op1(NOT, [g3], 'group 2'), 'g2', true);
  b.next();
  const t = b.op1(orN(3), [b.op1(AND, [sma, neg], 'SMA'), b.op1(AND, [sza, zero], 'SZA'), b.op1(AND, [snl, 'l'], 'SNL')], 'test');
  const a = b.name(b.op1(bitwise('and', 12), ['ac', rep(b, b.op1(NOT, [cla]), 12)], 'CLA'), 'acl', true);
  const or = b.op1(bitwise('and', 12), ['sr', rep(b, osr, 12)], 'OSR');
  const mqa = b.op1(bitwise('and', 12), ['mq', rep(b, sma, 12)], 'MQA'); // group 3 reuses bit 6 (SMA) as MQA, bit 4 (SNL) as MQL
  const keep = b.op1(bitwise('and', 12), [a, rep(b, b.op1(NOT, [snl]), 12)], 'MQL clears AC');
  b.next();
  b.wire(b.op1(AND, [ng3, b.op1(XOR, [t, rev], 'reverse?')], 'skip'), 'skip');
  b.wire(b.op1(AND, [ng3, hlt], 'HLT'), 'halt');
  const ac2 = b.op1(bitwise('or', 12), [a, or], 'group 2 AC');
  const ac3 = b.op1(bitwise('or', 12), [keep, mqa], 'group 3 AC');
  const mq3 = b.op1(busMux2(12), ['mq', a, snl], 'MQL: MQ ← AC');
  b.next();
  b.wire(b.op1(busMux2(12), [ac2, ac3, g3], 'AC'), 'y');
  b.wire(b.op1(busMux2(12), ['mq', mq3, g3], 'MQ'), 'mqy');
  return define({
    id: 'pdp8_opr23', name: 'Operate groups 2 and 3 (PDP-8)', category: 'cpu',
    summary: 'Group 2: the skip test on AC and L (SMA SZA SNL; bit 3 turns it into SPA SNA SZL), then CLA, OSR (OR the switch register in) and HLT. Group 3: CLA, then MQA (OR the MQ in) and MQL (MQ ← AC, AC ← 0); both together swap them.',
    ports: OPR23_PORTS,
    symbol: { kind: 'box', label: 'GROUPS 2·3' },
    spec: ([w, l, ac, mq, sr]) => opr23Ref(w, l, ac, mq, sr),
    netlist: laid(b, { room: true }),
  });
})();

// ---- AC & link ---------------------------------------------------------------------------------

/** acSel: 0 AND, 1 TAD's sum, 2 group 1, 3 groups 2·3, 4 the teletype's, 5 zero. lSel: 0 L ^ carry, 1 group 1, 2 zero. mqSel: 1 zero. */
const AC_PORTS: PortDef[] = [
  bus('m', 12, 'in'), bus('w', 8, 'in'), bus('sr', 12, 'in'), bus('tty', 12, 'in'),
  bus('acSel', 3, 'in'), bit('acWe', 'in'), bus('lSel', 2, 'in'), bit('lWe', 'in'), bit('mqSel', 'in'), bit('mqWe', 'in'), bit('clk', 'in', true),
  bus('ac', 12, 'out'), bit('l', 'out'), bus('mq', 12, 'out'), bit('skip', 'out'), bit('halt', 'out'),
];

export const PDP8_AC: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('m', 'w', 'sr', 'tty', 'acSel', 'acWe', 'lSel', 'lWe', 'mqSel', 'mqWe', 'clk');
  const z12 = b.name(b.op1(constWord(12, 0), [], '0'), 'zero', true);
  const z1 = b.name(b.op1(constWord(1, 0), [], '0'), 'zero1', true);
  const and = b.op1(bitwise('and', 12), ['', 'm'], 'AND');
  const add = b.op(rca(12), ['', 'm', z1], 'TAD: AC + M');
  const g1 = b.op(PDP8_OPR1, ['w', '', ''], 'group 1', 'g1');
  const g23 = b.op(PDP8_OPR23, ['w', '', '', '', 'sr'], 'groups 2·3', 'g23');
  b.next();
  const lt = b.op1(XOR, ['', `${add}.cout`], 'carry flips L');
  const acN = b.op1(muxTree(3, 12), [and, `${add}.s`, `${g1}.y`, `${g23}.y`, 'tty', z12, z12, z12, 'acSel'], 'next AC');
  const lN = b.op1(muxTree(2, 1), [lt, `${g1}.ly`, z1, z1, 'lSel'], 'next L');
  const mqN = b.op1(busMux2(12), [`${g23}.mqy`, z12, 'mqSel'], 'next MQ');
  b.next();
  const ac = b.name(b.op1(register(12), [acN, 'acWe', 'clk'], 'AC', 'acr'), 'acv', true);
  const l = b.name(b.op1(DFFE, [lN, 'lWe', 'clk'], 'L', 'lr'), 'lv', true);
  const mq = b.name(b.op1(register(12), [mqN, 'mqWe', 'clk'], 'MQ', 'mqr'), 'mqv', true);
  for (const s of [`${and.split('.')[0]}.a`, `${add}.a`, `${g1}.ac`, `${g23}.ac`, 'ac']) b.wire(ac, s);
  for (const s of [`${lt.split('.')[0]}.a`, `${g1}.l`, `${g23}.l`, 'l']) b.wire(l, s);
  for (const s of [`${g23}.mq`, 'mq']) b.wire(mq, s);
  b.wire(`${g23}.skip`, 'skip');
  b.wire(`${g23}.halt`, 'halt');
  const R = b.right;
  return define({
    id: 'pdp8_ac', name: 'AC & link (PDP-8)', category: 'cpu',
    summary: 'The accumulator, its link L and the MQ, with everything that computes their next values: AND, a 12-bit adder for TAD (its carry flips L), the two operate units, the teletype\'s result, or zero (DCA, START).',
    ports: AC_PORTS,
    symbol: { kind: 'box', label: 'AC & LINK' },
    netlist: columns(() => ({ pins: { ...pinsAt(ins(AC_PORTS), 0, 4), ...pinsAt(outs(AC_PORTS), R, 6, 6) }, instances: b.instances, nets: b.nets() }), ['g23.skip']),
  });
})();

// ---- PC ----------------------------------------------------------------------------------------

/** pcSel: 0 inc (PC + 1, or MA + 1 with incMa), 1 inc + 1 (a skip), 2 target (a jump), 3 SR (LOAD ADD), 4 0001 (an interrupt). */
const PC_PORTS: PortDef[] = [
  bus('ma', 12, 'in'), bus('target', 12, 'in'), bus('sr', 12, 'in'), bit('incMa', 'in'), bus('pcSel', 3, 'in'), bit('pcWe', 'in'), bit('clk', 'in', true),
  bus('pc', 12, 'out'),
];

export const PDP8_PC: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('ma', 'target', 'sr', 'incMa', 'pcSel', 'pcWe', 'clk');
  const src = b.op(busMux2(12), ['', 'ma', 'incMa'], 'PC or MA');
  const one = b.op1(constWord(12, 1), [], '0001');
  b.next();
  const i1 = b.name(`${b.op(incrementer(12), [`${src}.y`], '+ 1')}.y`, 'inc', true);
  b.next();
  const i2 = `${b.op(incrementer(12), [i1], '+ 2 (skip)')}.y`;
  b.next();
  const z = b.op1(constWord(12, 0), [], '0');
  const n = b.op1(muxTree(3, 12), [i1, i2, 'target', 'sr', one, z, z, z, 'pcSel'], 'next PC');
  b.next();
  const pc = b.name(b.op1(register(12), [n, 'pcWe', 'clk'], 'PC', 'pcr'), 'pcv', true);
  b.wire(pc, `${src}.a`);
  b.wire(pc, 'pc');
  const R = b.right;
  return define({
    id: 'pdp8_pc', name: 'PC (PDP-8)', category: 'cpu',
    summary: 'The program counter and its next value: PC + 1, PC + 2 when an instruction skips, a jump\'s target, MA + 1 for JMS (the subroutine starts after its return address), the switch register for LOAD ADD, or 0001 for an interrupt.',
    ports: PC_PORTS,
    symbol: { kind: 'box', label: 'PC' },
    netlist: () => ({ pins: { ...pinsAt(ins(PC_PORTS), 0, 4), pc: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- MA & MB -----------------------------------------------------------------------------------

/** maSel: 0 the effective address, 1 PC, 2 the next MB (Defer: the pointer), 3 SR. mbSel: 0 the core's word, 1 that + 1, 2 AC, 3 PC, 4 SR. */
const MAB_PORTS: PortDef[] = [
  bus('pc', 12, 'in'), bus('dout', 12, 'in'), bus('ac', 12, 'in'), bus('sr', 12, 'in'),
  bus('maSel', 2, 'in'), bit('maWe', 'in'), bus('mbSel', 3, 'in'), bit('mbWe', 'in'), bit('useMa', 'in'), bit('zeroA', 'in'), bit('clk', 'in', true),
  bus('maddr', 12, 'out'), bus('din', 12, 'out'), bus('maNext', 12, 'out'), bus('ma', 12, 'out'), bus('mb', 12, 'out'), bit('autoidx', 'out'), bit('zinc', 'out'),
];

export const PDP8_MAB: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('pc', 'dout', 'ac', 'sr', 'maSel', 'maWe', 'mbSel', 'mbWe', 'useMa', 'zeroA', 'clk');
  const z12 = b.name(b.op1(constWord(12, 0), [], '0'), 'zero', true);
  const wf = b.op(splitter([7, 1, 4]), ['dout'], 'word in the page, page bit');
  const pf = b.op(splitter([7, 5]), ['pc'], 'PC\'s page');
  const di = b.op(incrementer(12), ['dout'], 'M + 1');
  b.next();
  const page = b.op1(bitwise('and', 5), [`${pf}.o1`, rep(b, `${wf}.o1`, 5)], 'page 0 or this page');
  const mbN = b.name(b.op1(muxTree(3, 12), ['dout', `${di}.y`, 'ac', 'pc', 'sr', z12, z12, z12, 'mbSel'], 'next MB'), 'mbn', true);
  const pz = b.op1(busMux2(12), ['pc', z12, 'zeroA'], 'interrupt: 0');
  b.next();
  const ea = b.op1(merger([7, 5]), [`${wf}.o0`, page], 'effective address');
  b.next();
  const maN = b.name(b.op1(muxTree(2, 12), [ea, 'pc', mbN, 'sr', 'maSel'], 'next MA'), 'man', true);
  b.next();
  const ma = b.name(b.op1(register(12), [maN, 'maWe', 'clk'], 'MA', 'mar'), 'mav', true);
  const mb = b.op1(register(12), [mbN, 'mbWe', 'clk'], 'MB', 'mbr');
  b.next();
  const ms = b.op(splitter([3, 9]), [ma], 'MA');
  b.next();
  b.wire(b.op1(equal(9), [`${ms}.o1`, b.op1(constWord(9, 1), [], '001')], '0010–0017?'), 'autoidx');
  b.wire(b.op1(busMux2(12), [pz, ma, 'useMa'], 'core address'), 'maddr');
  b.wire(mbN, 'din');
  b.wire(maN, 'maNext');
  b.wire(ma, 'ma');
  b.wire(mb, 'mb');
  b.wire(`${di}.cout`, 'zinc');
  const R = b.right;
  return define({
    id: 'pdp8_mab', name: 'MA & MB (PDP-8)', category: 'cpu',
    summary: 'The memory address and buffer registers. The effective address is the word\'s 7 low bits on page 0 or on PC\'s page (bit 7). The core reads PC in Fetch and MA in Defer and Execute; the next MB is the word read, the word + 1 (ISZ, auto-index), AC (DCA) or PC (JMS, an interrupt), and it is also the word written.',
    ports: MAB_PORTS,
    symbol: { kind: 'box', label: 'MA & MB' },
    netlist: columns(() => ({ pins: { ...pinsAt(ins(MAB_PORTS), 0, 4), ...pinsAt(outs(MAB_PORTS), R, 4) }, instances: b.instances, nets: b.nets() }), ['mbr.q']),
  });
})();

// ---- teletype ----------------------------------------------------------------------------------

/** IOT device 00 (ION, IOF), 03 (keyboard: KSF KCC KRS KRB) and 04 (printer: TSF TCF TPC TLS). w: the word's bits 8–0. */
const TTY_PORTS: PortDef[] = [
  bus('w', 9, 'in'), bit('iot', 'in'), bit('clr', 'in'), bus('ac', 12, 'in'), bus('kcode', 8, 'in'), bit('kready', 'in'), bit('clk', 'in', true),
  bus('y', 12, 'out'), bit('acWe', 'out'), bit('skip', 'out'), bit('prn', 'out'), bit('kack', 'out'), bit('twe', 'out'), bus('tdata', 8, 'out'),
  bit('ion', 'out'), bit('iof', 'out'),
];

export const PDP8_TTY: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('w', 'iot', 'clr', 'ac', 'kcode', 'kready', 'clk');
  const f = b.op(splitter([1, 1, 1, 6]), ['w'], 'pulses, device');
  const [p1, p2, p4] = [0, 1, 2].map((i) => b.name(`${f}.o${i}`, `p${1 << i}`, true));
  const dev = b.name(`${f}.o3`, 'dev', true);
  const kb = b.op(register(8), ['kcode', 'kready', 'clk'], 'keyboard buffer', 'kbuf');
  b.next();
  const is = (n: number, label: string) => b.op1(AND, ['iot', b.op1(equal(6), [dev, b.op1(constWord(6, n), [], `0${n}`)])], label);
  const d0 = b.name(is(0, 'device 00'), 'd0', true), d3 = b.name(is(3, 'keyboard'), 'd3', true), d4 = b.name(is(4, 'printer'), 'd4', true);
  const kv = b.name(b.op1(busMux2(8), [`${kb}.q`, 'kcode', 'kready'], 'character'), 'kv', true);
  b.next();
  const np4 = b.op1(NOT, [p4]);
  const ion = b.op1(AND, [d0, b.op1(andN(3), [p1, b.op1(NOT, [p2]), np4])], 'ION: 6001');
  const iof = b.op1(AND, [d0, b.op1(andN(3), [p2, b.op1(NOT, [p1]), np4])], 'IOF: 6002');
  const kAc = b.op1(bitwise('and', 12), ['ac', rep(b, b.op1(NOT, [p2]), 12)], 'KCC clears AC');
  const kOr = b.op1(merger([8, 4]), [b.op1(bitwise('and', 8), [kv, rep(b, p4, 8)], 'KRS'), b.op1(constWord(4, 0), [], '0')]);
  const prnClr = b.op1(AND, [d4, p2], 'TCF');
  const prnSet = b.name(b.op1(AND, [d4, p4], 'TLS'), 'tls', true);
  b.next();
  const keep = b.op(AND, ['', b.op1(NOT, [prnClr])], 'flag kept');
  const prn = b.name(b.op1(DFFE, [b.op1(NOR, [b.op1(NOR, [`${keep}.y`, prnSet]), 'clr'], 'next flag'), b.op1(TIE1, []), 'clk'], 'printer flag', 'prnf'), 'prnv', true);
  b.wire(prn, `${keep}.a`);
  const skip = b.op1(OR, [b.op1(AND, [d3, b.op1(AND, [p1, 'kready'])], 'KSF'), b.op1(AND, [d4, b.op1(AND, [p1, prn])], 'TSF')], 'skip');
  b.wire(b.op1(bitwise('or', 12), [kAc, kOr], 'AC'), 'y');
  b.wire(b.op1(AND, [d3, b.op1(OR, [p2, p4])], 'AC written'), 'acWe');
  b.wire(skip, 'skip');
  b.wire(prn, 'prn');
  b.wire(b.op1(AND, [d3, p2], 'KCC: next key'), 'kack');
  b.wire(prnSet, 'twe');
  b.wire(b.op1(merger([7, 1]), [b.op(splitter([7, 5]), ['ac'], 'AC bits 6–0') + '.o0', b.op1(constWord(1, 0), [])], 'character'), 'tdata');
  b.wire(ion, 'ion');
  b.wire(iof, 'iof');
  return define({
    id: 'pdp8_tty', name: 'Teletype (PDP-8)', category: 'cpu',
    summary: 'The console teletype\'s IOTs. Keyboard (03): KSF skips while a key waits, KCC clears AC and takes the key, KRS ORs it into AC, KRB does both. Printer (04): TSF skips once the last character is printed, TCF clears that flag, TLS prints AC\'s 7 low bits and sets it. Device 00: ION, IOF.',
    ports: TTY_PORTS,
    symbol: { kind: 'box', label: 'TELETYPE' },
    netlist: laid(b, { keepOrder: true, room: true, wires: { kready: true } }),
  });
})();

// ---- control -----------------------------------------------------------------------------------

const CTL_OUTS: [string, number][] = [
  ['acSel', 3], ['acWe', 1], ['lSel', 2], ['lWe', 1], ['mqSel', 1], ['mqWe', 1], ['pcSel', 3], ['pcWe', 1], ['incMa', 1],
  ['maSel', 2], ['maWe', 1], ['mbSel', 3], ['mbWe', 1], ['mwe', 1], ['useMa', 1], ['zeroA', 1], ['iot', 1], ['clr', 1],
  ['retire', 1], ['run', 1], ['ie', 1], ['state', 2], ['ir', 3],
];
const CTL_PORTS: PortDef[] = [
  bus('dout', 12, 'in'), bit('skipOpr', 'in'), bit('haltOpr', 'in'), bit('ttySkip', 'in'), bit('ttyAc', 'in'), bit('ion', 'in'), bit('iof', 'in'),
  bit('autoidx', 'in'), bit('zinc', 'in'), bit('prn', 'in'), bit('kready', 'in'),
  bit('ld', 'in'), bit('dep', 'in'), bit('exam', 'in'), bit('start', 'in'), bit('cont', 'in'), bit('stop', 'in'), bit('sstep', 'in'), bit('clk', 'in', true),
  ...CTL_OUTS.map(([n, w]) => bus(n, w, 'out')),
];

/** Major states: the state register's code. */
export const PDP8_STATES = { fetch: 0, defer: 1, execute: 2 } as const;

export const PDP8_CONTROL: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('dout', 'skipOpr', 'haltOpr', 'ttySkip', 'ttyAc', 'ion', 'iof', 'autoidx', 'zinc', 'prn', 'kready', 'ld', 'dep', 'exam', 'start', 'cont', 'stop', 'sstep', 'clk');
  const one = b.op1(TIE1, []);
  // A key acts at the first edge it is down (DEC's were momentary): held, it does nothing more.
  const KEYS = ['ld', 'dep', 'exam', 'start', 'cont', 'stop', 'sstep'];
  const prev = bitsOf(b, b.op1(register(7), [b.op1(merger(ones(7)), KEYS, 'keys'), one, 'clk'], 'keys at the last edge', 'keyq'), 7, 'keys');
  // STOP acts on its level (at any edge, held or not): no edge detector for it
  const pressed = Object.fromEntries(KEYS.flatMap((k, n) => (k === 'stop' ? [] : [[k, b.name(b.op1(AND, [k, b.op1(NOT, [prev[n]])], `${k} pressed`), `p_${k}`, true)]])));
  const wf = b.op(splitter([7, 1, 1, 3]), ['dout'], 'fields');
  const ind = b.name(`${wf}.o2`, 'ind', true), wop = b.name(`${wf}.o3`, 'wop', true);
  const st = b.op(register(2), ['', one, 'clk'], 'major state', 'st');
  const ir = b.op(register(3), [wop, '', 'clk'], 'IR', 'irr');
  const run = b.name(b.op1(DFFE, ['', one, 'clk'], 'RUN', 'runf'), 'runv', true);
  const ie = b.name(b.op1(DFFE, ['', one, 'clk'], 'ION', 'ief'), 'iev', true);
  const dly = b.name(b.op1(DFFE, ['', '', 'clk'], 'ION delay', 'dlyf'), 'dlyv', true);
  b.next();
  const ss = b.op(splitter([1, 1]), [`${st}.q`], 'state');
  const isD = b.name(`${ss}.o0`, 'isD', true), isE = b.name(`${ss}.o1`, 'isE', true);
  const isF = b.name(b.op1(NOR, [isD, isE], 'Fetch'), 'isF', true);
  const op = b.op1(busMux2(3), [`${ir}.q`, wop, isF], 'opcode');
  const nrun = b.name(b.op1(NOT, [run]), 'nrun', true);
  b.next();
  const od = b.op(decoder(3), [op], 'opcode');
  const O = ['and', 'tad', 'isz', 'dca', 'jms', 'jmp', 'iotop', 'opr'].map((n, i) => b.name(`${od}.y${i}`, n, true));
  const int = b.name(b.op1(AND, [b.op1(AND, [isF, b.op1(AND, [ie, b.op1(NOT, [dly])])]), b.op1(OR, ['prn', 'kready'])], 'interrupt?'), 'int', true);
  const adv = b.name(b.op1(orN(3), [run, b.op1(NOT, [isF]), pressed.sstep], 'advance'), 'adv', true);
  const K = b.name(b.op1(AND, [nrun, isF], 'keys work'), 'K', true);
  b.next();
  const fA = b.op1(AND, [isF, adv]);
  const f = b.name(b.op1(AND, [fA, b.op1(NOT, [int])], 'Fetch'), 'f', true);
  const i = b.name(b.op1(AND, [fA, int], 'interrupt'), 'i', true);
  const key = (k: string) => b.name(b.op1(AND, [pressed[k], K], k.toUpperCase()), `k_${k}`, true);
  const kLd = key('ld'), kDep = key('dep'), kEx = key('exam'), kStart = key('start'), kCont = key('cont');
  const mri = b.name(b.op1(NOR, [O[6], O[7]], 'memory reference'), 'mri', true);
  b.next();
  const fm = b.name(b.op1(AND, [f, mri]), 'fm', true);
  const toD = b.op1(AND, [fm, ind], 'to Defer');
  const njmp = b.op1(NOT, [O[5]]);
  const toE = b.op1(OR, [b.op1(AND, [fm, b.op1(AND, [b.op1(NOT, [ind]), njmp])]), b.op1(AND, [isD, njmp])], 'to Execute');
  b.wire(b.op1(merger([1, 1]), [toD, toE], 'next state'), `${st}.d`);
  const eOf = (k: number) => b.op1(AND, [isE, O[k]]);
  const eAnd = eOf(0), eTad = eOf(1), eIsz = b.name(eOf(2), 'eIsz', true), eDca = b.name(eOf(3), 'eDca', true), eJms = b.name(eOf(4), 'eJms', true);
  const fOf = (k: number) => b.op1(AND, [f, O[k]]);
  const fIot = b.name(fOf(6), 'fIot', true), fOpr = b.name(fOf(7), 'fOpr', true);
  const dJmp = b.name(b.op1(AND, [isD, O[5]]), 'dJmp', true);
  const aiW = b.name(b.op1(AND, [isD, 'autoidx'], 'auto-index'), 'aiW', true);
  b.next();
  b.wire(b.op1(AND, [b.op1(orN(3), [f, isD, isE]), b.op1(NOR, [toD, toE])], 'instruction done'), 'retire');
  // IR, MB, MA, core
  b.wire(f, `${ir}.en`);
  const sInc = b.op1(OR, [aiW, eIsz]);
  const sPc = b.op1(OR, [eJms, i]);
  b.wire(b.op1(merger([1, 1, 1]), [b.op1(OR, [sInc, sPc]), b.op1(OR, [eDca, sPc]), kDep], 'MB source'), 'mbSel');
  b.wire(b.op1(orN(6), [f, isD, isE, i, kDep, kEx], 'MB written'), 'mbWe');
  b.wire(b.op1(orN(5), [aiW, eIsz, eDca, eJms, b.op1(OR, [i, kDep])], 'core written'), 'mwe');
  const maPc = b.op1(orN(3), [b.op1(AND, [f, b.op1(NOT, [mri])]), kDep, kEx]);
  b.wire(b.op1(merger([1, 1]), [b.op1(OR, [maPc, kLd]), b.op1(OR, [isD, kLd])], 'MA source'), 'maSel');
  b.wire(b.op1(orN(5), [f, isD, kLd, kDep, kEx], 'MA written'), 'maWe');
  b.wire(b.op1(NOT, [isF], 'Defer, Execute'), 'useMa');
  b.wire(i, 'zeroA');
  // PC
  const g = ind; // an operate word's bit 8: group 2 or 3
  const o1 = b.op1(AND, [fOpr, b.op1(NOT, [g])], 'group 1');
  const o23 = b.op1(AND, [fOpr, g], 'groups 2·3');
  const skipF = b.op1(OR, [b.op1(AND, [o23, 'skipOpr']), b.op1(AND, [fIot, 'ttySkip'])], 'skip');
  const jmpT = b.op1(OR, [b.op1(AND, [fm, b.op1(AND, [O[5], b.op1(NOT, [ind])])]), dJmp], 'jump');
  b.wire(b.op1(merger([1, 1, 1]), [b.op1(OR, [skipF, kLd]), b.op1(OR, [jmpT, kLd]), i], 'PC source'), 'pcSel');
  b.wire(b.op1(orN(8), [f, i, dJmp, eJms, b.op1(AND, [eIsz, 'zinc'], 'ISZ skips'), kLd, kDep, kEx], 'PC written'), 'pcWe');
  b.wire(eJms, 'incMa');
  // AC, L, MQ
  const tty = b.op1(AND, [fIot, 'ttyAc'], 'teletype');
  const zAc = b.op1(OR, [eDca, kStart], 'AC ← 0');
  b.wire(b.op1(merger([1, 1, 1]), [b.op1(orN(3), [eTad, o23, zAc]), b.op1(OR, [o1, o23]), b.op1(OR, [tty, zAc])], 'AC source'), 'acSel');
  b.wire(b.op1(orN(6), [eAnd, eTad, o1, o23, tty, zAc], 'AC written'), 'acWe');
  b.wire(b.op1(merger([1, 1]), [o1, kStart], 'L source'), 'lSel');
  b.wire(b.op1(orN(3), [eTad, o1, kStart], 'L written'), 'lWe');
  b.wire(kStart, 'mqSel');
  b.wire(b.op1(OR, [o23, kStart], 'MQ written'), 'mqWe');
  b.wire(fIot, 'iot');
  b.wire(kStart, 'clr');
  // RUN, interrupts
  const hlt = b.op1(AND, [o23, 'haltOpr'], 'HLT');
  b.wire(b.op1(orN(3), [b.op1(AND, [run, b.op1(NOR, [hlt, 'stop'])]), kStart, kCont], 'next RUN'), `${run.split('.')[0]}.d`);
  const ionNow = b.op1(AND, [fIot, 'ion'], 'ION now');
  b.wire(b.op1(AND, [b.op1(OR, [ie, ionNow]), b.op1(NOT, [b.op1(orN(3), [b.op1(AND, [fIot, 'iof']), i, kStart])])], 'next ION'), `${ie.split('.')[0]}.d`);
  b.wire(ionNow, `${dly.split('.')[0]}.d`);
  b.wire(b.op1(OR, [f, kStart]), `${dly.split('.')[0]}.en`);
  b.wire(run, 'run');
  b.wire(ie, 'ie');
  b.wire(`${st}.q`, 'state');
  b.wire(`${ir}.q`, 'ir');
  return define({
    id: 'pdp8_control', name: 'Control (PDP-8)', category: 'cpu',
    summary: 'The major state (Fetch, Defer, Execute), the instruction register, RUN and the interrupt system, and the gates that turn them, the word read and the front panel\'s keys into every select and enable of the data path. An interrupt replaces a Fetch: core[0] ← PC, PC ← 0001.',
    ports: CTL_PORTS,
    symbol: { kind: 'box', label: 'CONTROL' },
    netlist: laid(b, { room: true, wires: { 'u21.y': false, 'u59.y': false, 'u73.out': false, 'u75.y': false, 'u48.y': false, 'u100.y': false, exam: true, start: true } }),
  });
})();

// ---- the processor and the computer ------------------------------------------------------------

/** The front panel's keys, as pins: each acts at the first rising edge it is down, while the machine is stopped (STOP at any time). */
export const PDP8_KEYS = ['ld', 'dep', 'exam', 'start', 'cont', 'stop', 'sstep'] as const;

const CORE_IN: PortDef[] = [bit('clk', 'in', true), bus('sr', 12, 'in'), ...PDP8_KEYS.map((k) => bit(k, 'in')), bus('dout', 12, 'in'), bus('kcode', 8, 'in'), bit('kready', 'in')];
const CORE_OUT: PortDef[] = [bus('maddr', 12, 'out'), bus('din', 12, 'out'), bit('mwe', 'out'), bus('tdata', 8, 'out'), bit('twe', 'out'), bit('kack', 'out'), bit('retire', 'out'), bit('run', 'out'),
  bus('pc', 12, 'out'), bus('ac', 12, 'out'), bit('l', 'out')];

/** The registers' paths in pdp8Core / pdp8Computer (the processor at `cpu` in the computer). */
export const PDP8_STATE = {
  pc: 'pc.pcr', ma: 'mab.mar', mb: 'mab.mbr', ac: 'acl.acr', l: 'acl.lr', mq: 'acl.mqr', ir: 'ctl.irr', state: 'ctl.st',
  run: 'ctl.runf', ie: 'ctl.ief', prn: 'tty.prnf',
} as const;

function body(b: Builder, dout: string, mem: { addr: string; din: string; we: string }): void {
  const ctl = b.op(PDP8_CONTROL, [dout, '', '', '', '', '', '', '', '', '', 'kready', ...PDP8_KEYS, 'clk'], 'control', 'ctl');
  const c = (n: string) => b.name(`${ctl}.${n}`, n, true);
  b.next();
  const mab = b.op(PDP8_MAB, ['', dout, '', 'sr', c('maSel'), c('maWe'), c('mbSel'), c('mbWe'), c('useMa'), c('zeroA'), 'clk'], 'MA & MB', 'mab');
  const pc = b.op(PDP8_PC, [b.name(`${mab}.ma`, 'ma', true), b.name(`${mab}.maNext`, 'maNext', true), 'sr', c('incMa'), c('pcSel'), c('pcWe'), 'clk'], 'PC', 'pc');
  b.next();
  const w = b.op(splitter([8, 1, 3]), [dout], 'word');
  const w9 = b.op(splitter([9, 3]), [dout], 'word');
  const tty = b.op(PDP8_TTY, [`${w9}.o0`, c('iot'), c('clr'), '', 'kcode', 'kready', 'clk'], 'teletype', 'tty');
  const acl = b.op(PDP8_AC, [dout, `${w}.o0`, 'sr', b.name(`${tty}.y`, 'ttyy', true), c('acSel'), c('acWe'), c('lSel'), c('lWe'), c('mqSel'), c('mqWe'), 'clk'], 'AC & link', 'acl');
  const ac = b.name(`${acl}.ac`, 'ac', true);
  const pcv = b.name(`${pc}.pc`, 'pc', true);
  for (const s of [`${mab}.ac`, `${tty}.ac`]) b.wire(ac, s);
  b.wire(pcv, `${mab}.pc`);
  b.wire(`${acl}.skip`, `${ctl}.skipOpr`);
  b.wire(`${acl}.halt`, `${ctl}.haltOpr`);
  b.wire(`${tty}.skip`, `${ctl}.ttySkip`);
  b.wire(`${tty}.acWe`, `${ctl}.ttyAc`);
  b.wire(`${tty}.ion`, `${ctl}.ion`);
  b.wire(`${tty}.iof`, `${ctl}.iof`);
  b.wire(`${mab}.autoidx`, `${ctl}.autoidx`);
  b.wire(`${mab}.zinc`, `${ctl}.zinc`);
  b.wire(`${tty}.prn`, `${ctl}.prn`);
  b.wire(`${mab}.maddr`, mem.addr);
  b.wire(`${mab}.din`, mem.din);
  b.wire(c('mwe'), mem.we);
  b.wire(`${tty}.tdata`, 'tdata');
  b.wire(`${tty}.twe`, 'twe');
  b.wire(`${tty}.kack`, 'kack');
  b.wire(c('retire'), 'retire');
  b.wire(c('run'), 'run');
  b.wire(pcv, 'pc');
  b.wire(ac, 'ac');
  b.wire(`${acl}.l`, 'l');
}

/**
 * The PDP-8 processor with its core outside: maddr, din and mwe to a 4K × 12 memory (written at the rising edge, read at
 * once), dout back. Keyboard: kcode / kready from a queue of keys, kack takes one. Printer: tdata at twe.
 */
export const PDP8_CORE: ComponentDef = (() => {
  const b = new Builder(18, 12, 6);
  b.pins('clk', 'sr', ...PDP8_KEYS, 'dout', 'kcode', 'kready');
  body(b, 'dout', { addr: 'maddr', din: 'din', we: 'mwe' });
  const R = b.right;
  const ports = [...CORE_IN, ...CORE_OUT];
  return define({
    id: 'pdp8_core', name: 'PDP-8 processor', category: 'cpu',
    summary: 'The DEC PDP-8 (1965) without its core memory: a 12-bit accumulator machine, one clock edge per memory cycle (Fetch, Defer, Execute). Control, MA & MB, PC, AC & link with both operate groups and the MQ, and the console teletype\'s IOTs; the front panel\'s keys and switch register as pins.',
    ports,
    symbol: { kind: 'box', label: 'PDP-8' },
    // the keys and kready level with CONTROL's ports, wired straight across; dout at CONTROL's, clk at its bottom port's height
    netlist: () => ({ pins: { ...keyPins(b), ...pinsAt(outs(ports), R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The processor's input pins: each key, kready and dout level with the CONTROL port it feeds, sr above, clk and kcode below. */
function keyPins(b: Builder): Record<string, [number, number]> {
  const ctl = b.instances.find((i) => i.name === 'ctl')!;
  const y = (p: string) => instPort(ctl.def, ctl.at!, ctl.flip, p).pos[1];
  const at = (p: string): [number, number] => [0, y(p)];
  return { sr: [0, y('dout') - 4], dout: at('dout'), kready: at('kready'), ...Object.fromEntries(PDP8_KEYS.map((k) => [k, at(k)])), clk: [0, y('sstep') + 6], kcode: [0, y('sstep') + 10] };
}

const computers = new Map<string, ComponentDef>();

/** The PDP-8 with 4K × 12 of core holding `words` from address 0 at power-on (a RAM: read at once, written at the edge). */
export function pdp8Computer(words: ArrayLike<number>): ComponentDef {
  const R0 = bigRamWithInit(12, 12, words);
  let d = computers.get(R0.id);
  if (d) return d;
  const b = new Builder(18, 12, 6);
  b.pins('clk', 'sr', ...PDP8_KEYS, 'kcode', 'kready');
  const core = b.op(R0, ['', '', '', 'clk'], 'core 4K × 12', 'core');
  b.next();
  body(b, b.name(`${core}.dout`, 'dout', true), { addr: `${core}.addr`, din: `${core}.din`, we: `${core}.we` });
  const R = b.right;
  const ports = [...CORE_IN.filter((p) => p.name !== 'dout'), ...CORE_OUT.filter((p) => !['maddr', 'din', 'mwe'].includes(p.name))];
  d = define({
    id: `pdp8_${R0.id}`, name: 'PDP-8 with 4K of core', category: 'cpu',
    summary: 'The PDP-8 processor and a 4096 × 12 memory standing in for its core, holding a program at power-on. The front panel\'s keys and switch register, the keyboard and the printer are pins.',
    ports,
    symbol: { kind: 'box', label: 'PDP-8' },
    netlist: () => ({ pins: { ...pinsAt(ins(ports), 0, 4), ...pinsAt(outs(ports), R, 6) }, instances: b.instances, nets: b.nets() }),
  });
  computers.set(R0.id, d);
  return d;
}
