// Appendix C's SAP-1, Ben Eater's breadboard computer: every module one of his breadboards, built from the 74xx chips
// of lib/ttl.ts, and sapComputer(bytes) the whole machine. Control lines are active high (the microcode's); where a
// chip pin is active low (the 173's G1 / G2, the 245's G, the 161's LOAD, the 189's WE) the module has the inverter.
// The bus is the OR of the 245s' outputs (a disabled 245 reads 0). Instance names, ports and the timing are the
// contract in docs/SAP.md: the breadboard view, the chapter and the panel find chips by these paths.

import { SAP_DISPLAY_ROM, SAP_ROM_HI, SAP_ROM_LO } from '../sap/isa';
import { stats } from '../sim/stats';
import { type ComponentDef, netlistOf, type PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { define, merger, ones, splitter } from './define';
import { AND, OR } from './gates';
import { TIE0, TIE1 } from './transistors';
import { eeprom2k, LS02, LS04, LS08, LS138, LS157, LS161, LS173, LS189, LS245, LS273, LS283, LS86, ls189Init, ttlKind } from './ttl';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);
const outs = (ps: PortDef[]) => ps.filter((p) => p.dir === 'out').map((p) => p.name);

function built(b: Builder, ports: PortDef[], step = 4) {
  const R = b.right;
  return () => ({ pins: { ...pinsAt(ins(ports), 0, step), ...pinsAt(outs(ports), R, step) }, instances: b.instances, nets: b.nets() });
}

/** A bus split into bits (o0 = bit 0). */
const bitsOf = (b: Builder, drv: string, n: number, label?: string, pitch = 2): string[] => {
  const s = b.op(splitter(ones(n), pitch), [drv], label);
  return Array.from({ length: n }, (_, i) => `${s}.o${i}`);
};
/** Bits (or narrower buses) bundled into one bus, the first lowest. */
const word = (b: Builder, parts: string[], widths = parts.map(() => 1), label?: string, pitch = 2): string => b.op1(merger(widths, pitch), parts, label);

// ---- the clock -----------------------------------------------------------------------------------------------------

const CLOCK_PORTS: PortDef[] = [bit('osc', 'in', true), bit('hlt', 'in'), bit('clk', 'out'), bit('nclk', 'out')];

/**
 * The clock module: HLT gates the clock (clk = osc AND NOT hlt) and an inverter makes nclk, which clocks the step
 * counter. Ben's board also has three 555s (astable, the step button's monostable, the mode switch's debouncer):
 * drawn, not simulated; the stage's clock is osc.
 */
export const SAP_CLOCK: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(CLOCK_PORTS));
  const z = b.op1(TIE0, [], '0');
  const ia = word(b, ['hlt', '', z, z, z, z], undefined, 'inverters');
  b.next();
  const inv = b.op(LS04, [ia], '74LS04', 'inv');
  b.next();
  const iy = bitsOf(b, `${inv}.y`, 6);
  b.next();
  const aa = word(b, ['osc', z, z, z], undefined, 'A');
  const ab = word(b, [iy[0], z, z, z], undefined, 'B');
  b.next();
  const and = b.op(LS08, [aa, ab], '74LS08', 'and');
  b.next();
  const ay = bitsOf(b, `${and}.y`, 4);
  const clk = b.name(ay[0], 'clk', true);
  b.wire(clk, 'clk');
  b.wire(clk, `${ia.slice(0, ia.indexOf('.'))}.i1`);
  b.wire(b.name(iy[1], 'nclk', true), 'nclk');
  return define({
    id: 'sap_clock', name: 'Clock (SAP-1)', category: 'cpu',
    summary: 'The clock module: clk = osc AND NOT HLT (a halted computer stops its own clock), nclk its inverse for the step counter. Ben\'s 555s are drawn, not simulated: the stage\'s clock is osc.',
    ports: CLOCK_PORTS,
    symbol: { kind: 'box', label: 'CLOCK' },
    spec: ([o, h]) => { const c = o & (1 - h); return [c, 1 - c]; },
    netlist: built(b, CLOCK_PORTS),
  });
})();

// ---- registers on the bus ------------------------------------------------------------------------------------------

/** Inverters for active-high lines into active-low pins: the first n bits of a 74LS04 named `name`, the rest tied low. */
function inverters(b: Builder, lines: string[], z: string, name = 'inv'): string[] {
  const a = word(b, [...lines, ...Array(6 - lines.length).fill(z)], undefined, 'to invert');
  b.next();
  const inv = b.op(LS04, [a], '74LS04', name);
  b.next();
  return bitsOf(b, `${inv}.y`, 6).slice(0, lines.length);
}

const AREG_PORTS: PortDef[] = [bit('clk', 'in', true), bit('ai', 'in'), bit('ao', 'in'), bus('bus', 8, 'in'), bit('rst', 'in'), bus('q', 8, 'out'), bus('drv', 8, 'out')];

/** An 8-bit register on the bus: two 173s loading from it (AI), a 245 driving it (AO). The A register. */
export const SAP_AREG: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(AREG_PORTS));
  const z = b.op1(TIE0, [], '0'), one = b.op1(TIE1, [], '1');
  const [nai, nao] = inverters(b, ['ai', 'ao'], z);
  const d = b.op(splitter([4, 4], 2), ['bus'], 'nibbles');
  b.next();
  const lo = b.op(LS173, [z, z, nai, nai, 'rst', 'clk', `${d}.o0`], 'low nibble', 'lo');
  const hi = b.op(LS173, [z, z, nai, nai, 'rst', 'clk', `${d}.o1`], 'high nibble', 'hi');
  b.next();
  const q = b.name(word(b, [`${lo}.q`, `${hi}.q`], [4, 4], 'A'), 'q', true);
  b.next();
  b.wire(b.op1(LS245, [one, nao, q], '74LS245', 'drv'), 'drv');
  b.wire(q, 'q');
  return define({
    id: 'sap_areg', name: 'A register (SAP-1)', category: 'cpu',
    summary: 'The accumulator: two 74LS173s take the bus at the rising edge while AI = 1; a 74LS245 puts the value on the bus while AO = 1. q always feeds the ALU and the LEDs. RST clears it (the 173s\' CLR).',
    ports: AREG_PORTS,
    symbol: { kind: 'box', label: 'A REG' },
    netlist: built(b, AREG_PORTS),
  });
})();

const BREG_PORTS: PortDef[] = [bit('clk', 'in', true), bit('bi', 'in'), bus('bus', 8, 'in'), bit('rst', 'in'), bus('q', 8, 'out')];

/** The B register: two 173s loading from the bus (BI); it only feeds the ALU, so no 245. */
export const SAP_BREG: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(BREG_PORTS));
  const z = b.op1(TIE0, [], '0');
  const [nbi] = inverters(b, ['bi'], z);
  const d = b.op(splitter([4, 4], 2), ['bus'], 'nibbles');
  b.next();
  const lo = b.op(LS173, [z, z, nbi, nbi, 'rst', 'clk', `${d}.o0`], 'low nibble', 'lo');
  const hi = b.op(LS173, [z, z, nbi, nbi, 'rst', 'clk', `${d}.o1`], 'high nibble', 'hi');
  b.next();
  b.wire(word(b, [`${lo}.q`, `${hi}.q`], [4, 4], 'B'), 'q');
  return define({
    id: 'sap_breg', name: 'B register (SAP-1)', category: 'cpu',
    summary: 'The ALU\'s second operand: two 74LS173s take the bus at the rising edge while BI = 1. Ben\'s B never drives the bus, so it has no 245. RST clears it.',
    ports: BREG_PORTS,
    symbol: { kind: 'box', label: 'B REG' },
    netlist: built(b, BREG_PORTS),
  });
})();

const IR_PORTS: PortDef[] = [bit('clk', 'in', true), bit('ii', 'in'), bit('io', 'in'), bus('bus', 8, 'in'), bit('rst', 'in'), bus('op', 4, 'out'), bus('ir', 8, 'out'), bus('drv', 8, 'out')];

/** The instruction register: two 173s (II); the high nibble (the opcode) goes to the control unit, the low one back to the bus (IO). */
export const SAP_IR: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(IR_PORTS));
  const z = b.op1(TIE0, [], '0'), one = b.op1(TIE1, [], '1');
  const [nii, nio] = inverters(b, ['ii', 'io'], z);
  const d = b.op(splitter([4, 4], 2), ['bus'], 'nibbles');
  b.next();
  const lo = b.op(LS173, [z, z, nii, nii, 'rst', 'clk', `${d}.o0`], 'operand', 'lo');
  const hi = b.op(LS173, [z, z, nii, nii, 'rst', 'clk', `${d}.o1`], 'opcode', 'hi');
  b.next();
  const ir = word(b, [`${lo}.q`, `${hi}.q`], [4, 4], 'IR');
  const low = word(b, [`${lo}.q`, b.op1(constWord(4, 0), [], '0000')], [4, 4], 'operand only');
  b.next();
  b.wire(b.op1(LS245, [one, nio, low], '74LS245', 'drv'), 'drv');
  b.wire(ir, 'ir');
  b.wire(`${hi}.q`, 'op');
  return define({
    id: 'sap_ir', name: 'Instruction register (SAP-1)', category: 'cpu',
    summary: 'Two 74LS173s take the instruction from the bus while II = 1. The high nibble, the opcode, goes to the control unit; a 74LS245 puts only the low nibble, the operand, back on the bus while IO = 1. RST clears it (to NOP).',
    ports: IR_PORTS,
    symbol: { kind: 'box', label: 'IR' },
    netlist: built(b, IR_PORTS),
  });
})();

// ---- program counter, memory address register, RAM -----------------------------------------------------------------

const PC_PORTS: PortDef[] = [bit('clk', 'in', true), bit('ce', 'in'), bit('co', 'in'), bit('j', 'in'), bus('bus', 8, 'in'), bit('rst', 'in'), bus('pc', 4, 'out'), bus('drv', 8, 'out')];

/** The program counter: a 161 counting (CE) or loading the bus (J), a 245 putting it on the bus (CO). */
export const SAP_PC: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(PC_PORTS));
  const z = b.op1(TIE0, [], '0'), one = b.op1(TIE1, [], '1');
  const [nj, nco, nrst] = inverters(b, ['j', 'co', 'rst'], z);
  const d = b.op(splitter([4, 4], 2), ['bus'], 'nibbles');
  b.next();
  const cnt = b.op(LS161, [nrst, 'clk', `${d}.o0`, 'ce', 'ce', nj], '74LS161', 'cnt');
  b.next();
  const pc = b.name(`${cnt}.q`, 'pc', true);
  const w = word(b, [pc, b.op1(constWord(4, 0), [], '0000')], [4, 4], 'PC on 8 bits');
  b.next();
  b.wire(b.op1(LS245, [one, nco, w], '74LS245', 'drv'), 'drv');
  b.wire(pc, 'pc');
  return define({
    id: 'sap_pc', name: 'Program counter (SAP-1)', category: 'cpu',
    summary: 'A 74LS161 counts at the rising edge while CE = 1 and loads the bus\'s low nibble instead while J = 1 (a jump); a 74LS245 puts the count on the bus while CO = 1. RST clears it to 0 (the 161\'s CLR).',
    ports: PC_PORTS,
    symbol: { kind: 'box', label: 'PC' },
    netlist: built(b, PC_PORTS),
  });
})();

const MAR_PORTS: PortDef[] = [bit('clk', 'in', true), bit('mi', 'in'), bit('prog', 'in'), bus('bus', 8, 'in'), bus('addrSw', 4, 'in'), bus('addr', 4, 'out')];

/** The memory address register: a 173 loading the bus (MI); a 157 hands the RAM the DIP switches instead in programming mode. */
export const SAP_MAR: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(MAR_PORTS));
  const z = b.op1(TIE0, [], '0');
  const [nmi] = inverters(b, ['mi'], z);
  const d = b.op(splitter([4, 4], 2), ['bus'], 'nibbles');
  b.next();
  const reg = b.op(LS173, [z, z, nmi, nmi, z, 'clk', `${d}.o0`], 'address', 'reg');
  b.next();
  b.wire(b.op1(LS157, [`${reg}.q`, 'addrSw', 'prog', z], 'run / program', 'sel'), 'addr');
  return define({
    id: 'sap_mar', name: 'Memory address register (SAP-1)', category: 'cpu',
    summary: 'A 74LS173 takes the bus\'s low nibble while MI = 1: the RAM address. A 74LS157 gives the RAM the four address switches instead while prog = 1 (programming mode).',
    ports: MAR_PORTS,
    symbol: { kind: 'box', label: 'MAR' },
    netlist: built(b, MAR_PORTS),
  });
})();

const RAM_PORTS: PortDef[] = [
  bit('clk', 'in', true), bus('addr', 4, 'in'), bus('bus', 8, 'in'), bus('dataSw', 8, 'in'), bit('prog', 'in'), bit('write', 'in'), bit('ri', 'in'), bit('ro', 'in'),
  bus('q', 8, 'out'), bus('drv', 8, 'out'),
];

/**
 * 16 bytes: two 189s (one per nibble), 04s turning their inverted outputs back, 157s choosing what to write (the bus,
 * or the data switches in programming mode), a 245 onto the bus (RO). The write is RI AND clk (while the clock is
 * high, so at the rising edge in effect: Ben's RC pulse), or the write button in programming mode.
 */
export const SAP_RAM: ComponentDef = (() => {
  const b = new Builder(16, 14, 4);
  b.pins(...ins(RAM_PORTS));
  const z = b.op1(TIE0, [], '0'), one = b.op1(TIE1, [], '1');
  const db = b.op(splitter([4, 4], 2), ['bus'], 'bus nibbles');
  const ds = b.op(splitter([4, 4], 2), ['dataSw'], 'switch nibbles');
  const wa = word(b, ['ri', z, z, z], undefined, 'RI');
  const wb = word(b, ['clk', z, z, z], undefined, 'CLK');
  b.next();
  const w = b.op(LS08, [wa, wb], 'RI · CLK', 'w');
  const dlo = b.op(LS157, [`${db}.o0`, `${ds}.o0`, 'prog', z], 'data, low', 'dlo');
  const dhi = b.op(LS157, [`${db}.o1`, `${ds}.o1`, 'prog', z], 'data, high', 'dhi');
  b.next();
  const wy = bitsOf(b, `${w}.y`, 4);
  const sa = word(b, [wy[0], z, z, z], undefined, 'run');
  const sb = word(b, ['write', z, z, z], undefined, 'button');
  b.next();
  const wsel = b.op(LS157, [sa, sb, 'prog', z], 'write: run / button', 'wsel');
  b.next();
  const we = bitsOf(b, `${wsel}.y`, 4)[0];
  b.next();
  // ilo's spare inverters make WE and the 245's G from the active-high lines
  const ila = word(b, ['', we, 'ro'], [4, 1, 1], 'low outputs, WE, RO');
  const iha = word(b, ['', z, z], [4, 1, 1], 'high outputs');
  b.next();
  const ilo = b.op(LS04, [ila], '74LS04', 'ilo');
  const ihi = b.op(LS04, [iha], '74LS04', 'ihi');
  b.next();
  const ly = b.op(splitter([4, 1, 1], 2), [`${ilo}.y`]);
  const hy = b.op(splitter([4, 2], 2), [`${ihi}.y`]);
  const nwe = b.name(`${ly}.o1`, 'we_n', true);
  b.next();
  const lo = b.op(LS189, ['addr', z, nwe, `${dlo}.y`], 'low nibble', 'lo');
  const hi = b.op(LS189, ['addr', z, nwe, `${dhi}.y`], 'high nibble', 'hi');
  b.wire(`${lo}.q_n`, `${ila.slice(0, ila.indexOf('.'))}.i0`);
  b.wire(`${hi}.q_n`, `${iha.slice(0, iha.indexOf('.'))}.i0`);
  b.next();
  const q = b.name(word(b, [`${ly}.o0`, `${hy}.o0`], [4, 4], 'RAM[addr]'), 'q', true);
  b.next();
  b.wire(b.op1(LS245, [one, `${ly}.o2`, q], '74LS245', 'drv'), 'drv');
  b.wire(q, 'q');
  return define({
    id: 'sap_ram', name: 'RAM (SAP-1)', category: 'cpu',
    summary: '16 bytes in two 74LS189s (a nibble each), whose inverted outputs 74LS04s turn back; 74LS157s pick the bus or the data switches to write, and RI · CLK or the write button; a 74LS245 puts the byte on the bus while RO = 1.',
    ports: RAM_PORTS,
    symbol: { kind: 'box', label: 'RAM 16×8' },
    netlist: built(b, RAM_PORTS),
  });
})();

// ---- ALU and flags -------------------------------------------------------------------------------------------------

const ALU_PORTS: PortDef[] = [bus('a', 8, 'in'), bus('b', 8, 'in'), bit('su', 'in'), bit('eo', 'in'), bus('sum', 8, 'out'), bus('drv', 8, 'out'), bit('cout', 'out')];

/** A + B or A − B (B XOR SU, carry in SU) in two 283s; a 245 puts the sum on the bus (ΣO). Never clocked. */
export const SAP_ALU: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(ALU_PORTS));
  const z = b.op1(TIE0, [], '0'), one = b.op1(TIE1, [], '1');
  const [neo] = inverters(b, ['eo'], z);
  const sa = b.op(splitter([4, 4], 2), ['a'], 'A nibbles');
  const sb = b.op(splitter([4, 4], 2), ['b'], 'B nibbles');
  const su4 = word(b, ['su', 'su', 'su', 'su'], undefined, 'SU × 4');
  b.next();
  const x0 = b.op(LS86, [`${sb}.o0`, su4], 'B or ¬B, low', 'x0');
  const x1 = b.op(LS86, [`${sb}.o1`, su4], 'B or ¬B, high', 'x1');
  b.next();
  const add0 = b.op(LS283, [`${sa}.o0`, `${x0}.y`, 'su'], 'low nibble', 'add0');
  const add1 = b.op(LS283, [`${sa}.o1`, `${x1}.y`, `${add0}.c4`], 'high nibble', 'add1');
  b.next();
  const sum = b.name(word(b, [`${add0}.s`, `${add1}.s`], [4, 4], 'Σ'), 'sum', true);
  b.next();
  b.wire(b.op1(LS245, [one, neo, sum], '74LS245', 'drv'), 'drv');
  b.wire(sum, 'sum');
  b.wire(`${add1}.c4`, 'cout');
  return define({
    id: 'sap_alu', name: 'ALU (SAP-1)', category: 'cpu',
    summary: 'Two 74LS283s add A and B; for SUB, 74LS86s invert B and SU is the carry in (A + ¬B + 1). The sum is always there for the flags; a 74LS245 puts it on the bus while ΣO = 1.',
    ports: ALU_PORTS,
    symbol: { kind: 'box', label: 'ALU' },
    spec: ([a, bb, su, eo]) => {
      const s = a + (su ? ~bb & 255 : bb) + su;
      return [s & 255, eo ? s & 255 : 0, s >> 8];
    },
    netlist: built(b, ALU_PORTS),
  });
})();

const FLAGS_PORTS: PortDef[] = [bit('clk', 'in', true), bit('fi', 'in'), bus('sum', 8, 'in'), bit('cout', 'in'), bit('rst', 'in'), bit('cf', 'out'), bit('zf', 'out')];

/** The flags register: the zero test (four NORs, three ANDs) and the carry into a 173 while FI = 1. */
export const SAP_FLAGS: ComponentDef = (() => {
  const b = new Builder(16, 14, 4);
  b.pins(...ins(FLAGS_PORTS));
  const z = b.op1(TIE0, [], '0');
  const [nfi] = inverters(b, ['fi'], z);
  const s = bitsOf(b, 'sum', 8, 'Σ bits');
  b.next();
  const na = word(b, [s[0], s[2], s[4], s[6]], undefined, 'even bits');
  const nb = word(b, [s[1], s[3], s[5], s[7]], undefined, 'odd bits');
  b.next();
  const nor = b.op(LS02, [na, nb], 'pairs = 0?', 'nor');
  b.next();
  const ny = bitsOf(b, `${nor}.y`, 4);
  const aa = word(b, [ny[0], ny[2], '', z], undefined, 'A');
  const ab = word(b, [ny[1], ny[3], '', z], undefined, 'B');
  b.next();
  const and = b.op(LS08, [aa, ab], 'all = 0?', 'and');
  b.next();
  const ay = bitsOf(b, `${and}.y`, 4);
  b.wire(ay[0], `${aa.slice(0, aa.indexOf('.'))}.i2`);
  b.wire(ay[1], `${ab.slice(0, ab.indexOf('.'))}.i2`);
  const zero = b.name(ay[2], 'zero', true);
  b.next();
  const d = word(b, ['cout', zero, z, z], undefined, 'CF ZF');
  b.next();
  const reg = b.op(LS173, [z, z, nfi, nfi, 'rst', 'clk', d], 'flags', 'reg');
  b.next();
  const q = bitsOf(b, `${reg}.q`, 4);
  b.wire(q[0], 'cf');
  b.wire(q[1], 'zf');
  return define({
    id: 'sap_flags', name: 'Flags register (SAP-1)', category: 'cpu',
    summary: 'The carry out of the adder and a zero test of the sum (74LS02 NORs on pairs of bits, then 74LS08 ANDs) go into a 74LS173 while FI = 1: CF and ZF, which the microcode\'s address takes for JC and JZ. RST clears both.',
    ports: FLAGS_PORTS,
    symbol: { kind: 'box', label: 'FLAGS' },
    netlist: built(b, FLAGS_PORTS),
  });
})();

// ---- output --------------------------------------------------------------------------------------------------------

const OUT_PORTS: PortDef[] = [bit('clk', 'in', true), bit('oi', 'in'), bus('bus', 8, 'in'), bus('q', 8, 'out')];

/** The output register: a 273 clocked by CLK AND OI (an 08), as Ben's (the 273 has no enable). */
export const SAP_OUT: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(OUT_PORTS));
  const z = b.op1(TIE0, [], '0'), one = b.op1(TIE1, [], '1');
  const aa = word(b, ['clk', z, z, z], undefined, 'CLK');
  const ab = word(b, ['oi', z, z, z], undefined, 'OI');
  b.next();
  const g = b.op(LS08, [aa, ab], 'CLK · OI', 'clk');
  b.next();
  const ck = bitsOf(b, `${g}.y`, 4)[0];
  b.next();
  b.wire(b.op1(LS273, [one, ck, 'bus'], 'value shown', 'reg'), 'q');
  return define({
    id: 'sap_out', name: 'Output register (SAP-1)', category: 'cpu',
    summary: 'A 74LS273 takes the bus at the rising edge of CLK AND OI (a 74LS08: the 273 has no load enable), and holds the value the display shows.',
    ports: OUT_PORTS,
    symbol: { kind: 'box', label: 'OUT' },
    netlist: built(b, OUT_PORTS),
  });
})();

const DISP_PORTS: PortDef[] = [bus('v', 8, 'in'), bus('d0', 8, 'out'), bus('d1', 8, 'out'), bus('d2', 8, 'out')];

/**
 * The display: Ben multiplexes one 28C16 over four digits (a 555, a 74LS76 counting, a 74LS139 choosing the digit);
 * here three copies of the same decoder EEPROM run at once, addressed [unsigned][digit][value]: ones, tens, hundreds.
 * Segments: bit 0 = a … bit 6 = g.
 */
export const SAP_DISPLAY: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(DISP_PORTS));
  const z = b.op1(TIE0, [], '0');
  const E = eeprom2k(SAP_DISPLAY_ROM);
  const addr = [0, 1, 2].map((k) => word(b, ['v', b.op1(constWord(3, k), [], `digit ${k}`)], [8, 3], `value, digit ${k}`));
  b.next();
  [0, 1, 2].forEach((k) => b.wire(b.op1(E, [addr[k], z, z, z], ['ones', 'tens', 'hundreds'][k], `rom${k}`), `d${k}`));
  return define({
    id: 'sap_display', name: 'Display decoder (SAP-1)', category: 'cpu',
    summary: 'The output value in decimal: a 28C16 holding each digit\'s segments for every value. Ben multiplexes one EEPROM over the digits with a 555, a 74LS76 and a 74LS139; here three copies of it show ones, tens and hundreds at once.',
    ports: DISP_PORTS,
    symbol: { kind: 'box', label: 'DISPLAY' },
    netlist: built(b, DISP_PORTS),
  });
})();

// ---- control -------------------------------------------------------------------------------------------------------

/** The 16 control lines, high bit to low (isa.ts SAP_CTRL): the control unit's outputs by these names. */
export const SAP_LINES = ['hlt', 'mi', 'ri', 'ro', 'io', 'ii', 'ai', 'ao', 'eo', 'su', 'bi', 'oi', 'ce', 'co', 'j', 'fi'] as const;

const CTL_PORTS: PortDef[] = [
  bit('nclk', 'in', true), bus('op', 4, 'in'), bit('cf', 'in'), bit('zf', 'in'), bit('rst', 'in'),
  ...SAP_LINES.map((n) => bit(n, 'out')), bus('t', 3, 'out'), bus('ts', 5, 'out'),
];

/**
 * The control unit: a 161 counts the steps on nclk (the falling edge of the clock), a 138 decodes the step (its Y5
 * clears the 161 at once: five steps, T0–T4; 04s light the step LEDs, ts), and two 28C16s map [ZF CF][opcode][step]
 * to the 16 control lines (romhi: HLT … AO, romlo: ΣO … FI).
 */
export const SAP_CONTROL: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(CTL_PORTS));
  const z = b.op1(TIE0, [], '0'), one = b.op1(TIE1, [], '1');
  const d0 = b.op1(constWord(4, 0), [], '0000');
  b.next();
  const step = b.op(LS161, ['', 'nclk', d0, one, one, one], 'step counter', 'step');
  b.next();
  const sq = b.op(splitter([3, 1], 2), [`${step}.q`]);
  const t = b.name(`${sq}.o0`, 't', true);
  b.next();
  const dec = b.op(LS138, [t, one, z, z], 'step decoder', 'dec');
  b.next();
  const yn = bitsOf(b, `${dec}.y_n`, 8);
  b.next();
  const ia = word(b, [...yn.slice(0, 5), 'rst'], undefined, 'steps, RST');
  b.next();
  const inv = b.op(LS04, [ia], 'step LEDs', 'inv');
  b.next();
  const iy = b.op(splitter([5, 1], 2), [`${inv}.y`]);
  b.wire(`${iy}.o0`, 'ts');
  const addr = word(b, [t, 'op', 'cf', 'zf', z, z], [3, 4, 1, 1, 1, 1], '[ZF CF][op][step]');
  b.next();
  const hi = b.op(eeprom2k(SAP_ROM_HI), [addr, z, z, one], 'HLT … AO', 'romhi');
  const lo = b.op(eeprom2k(SAP_ROM_LO), [addr, z, z, one], 'ΣO … FI', 'romlo');
  b.next();
  const h = bitsOf(b, `${hi}.data`, 8, 'high byte'), l = bitsOf(b, `${lo}.data`, 8, 'low byte');
  const all = [...l, ...h]; // bit 0 = FI … bit 15 = HLT
  SAP_LINES.forEach((n, i) => b.wire(all[15 - i], n));
  b.next();
  // the step counter clears at T5 (the end of an instruction) or while RST is held: Y5 AND NOT RST into its CLR
  const ca = word(b, [yn[5], z, z, z], undefined, 'T5');
  const cb = word(b, [`${iy}.o1`, z, z, z], undefined, 'not RST');
  b.next();
  const clr = b.op(LS08, [ca, cb], 'clear: T5 or RST', 'clr');
  b.next();
  b.wire(b.name(bitsOf(b, `${clr}.y`, 4)[0], 'clr_n', true), `${step}.clr_n`);
  b.wire(t, 't');
  return define({
    id: 'sap_control', name: 'Control unit (SAP-1)', category: 'cpu',
    summary: 'Microcode: a 74LS161 counts the steps on the falling clock edge, a 74LS138 decodes them (step 5 clears the counter: five steps an instruction; so does RST, through a 74LS08), and two 28C16 EEPROMs turn [flags][opcode][step] into the 16 control lines.',
    ports: CTL_PORTS,
    symbol: { kind: 'box', label: 'CONTROL' },
    netlist: built(b, CTL_PORTS, 3),
  });
})();

// ---- the bus -------------------------------------------------------------------------------------------------------

/** The bus's drivers, in the order SAP_BUS takes them, with the control line that enables each. */
export const SAP_DRIVERS = [['pc', 'co'], ['ram', 'ro'], ['ir', 'io'], ['a', 'ao'], ['alu', 'eo']] as const;

const BUS_PORTS: PortDef[] = [...SAP_DRIVERS.map(([m]) => bus(m, 8, 'in')), ...SAP_DRIVERS.map(([, e]) => bit(e, 'in')), bus('bus', 8, 'out'), bit('clash', 'out')];

/**
 * The bus: the OR of every 245's output (a disabled one reads 0, as on a bus with pull-downs). clash = two or more
 * drivers enabled at once, which on the real board is a short between outputs (the chapter shows it at switch level).
 */
export const SAP_BUS: ComponentDef = (() => {
  const b = new Builder(16, 10, 4);
  b.pins(...ins(BUS_PORTS));
  const OR8 = bitwise('or', 8);
  const o1 = b.op1(OR8, ['pc', 'ram'], 'PC | RAM');
  const s1 = b.op1(AND, ['co', 'ro']), u1 = b.op1(OR, ['co', 'ro']);
  b.next();
  const o2 = b.op1(OR8, [o1, 'ir'], '| IR');
  const s2 = b.op1(OR, [s1, b.op1(AND, [u1, 'io'])]), u2 = b.op1(OR, [u1, 'io']);
  b.next();
  const o3 = b.op1(OR8, [o2, 'a'], '| A');
  const s3 = b.op1(OR, [s2, b.op1(AND, [u2, 'ao'])]), u3 = b.op1(OR, [u2, 'ao']);
  b.next();
  b.wire(b.op1(OR8, [o3, 'alu'], '| Σ'), 'bus');
  b.wire(b.op1(OR, [s3, b.op1(AND, [u3, 'eo'])], 'two at once?'), 'clash');
  return define({
    id: 'sap_bus', name: 'Bus (SAP-1)', category: 'cpu',
    summary: 'Eight wires every module reads. Each 74LS245 drives it only while its output line is on (a disabled one reads 0, the bus\'s pull-downs), so the bus is the OR of the drivers; clash = 1 when two drive at once, a short on the real board.',
    ports: BUS_PORTS,
    symbol: { kind: 'box', label: 'BUS' },
    spec: (v) => {
      let x = 0, n = 0;
      for (let i = 0; i < 5; i++) { x |= v[i]; n += v[5 + i]; }
      return [x, n >= 2 ? 1 : 0];
    },
    netlist: built(b, BUS_PORTS),
  });
})();

// ---- the computer --------------------------------------------------------------------------------------------------

export const SAP_PORTS: PortDef[] = [
  // RESET first: the bottom bar lists the pins in this order, and a phone shows only its start
  bit('clk', 'in', true), bit('RESET', 'in'), bit('prog', 'in'), bus('addrSw', 4, 'in'), bus('dataSw', 8, 'in'), bit('write', 'in'),
  bus('bus', 8, 'out'), bus('out', 8, 'out'), bus('d0', 8, 'out'), bus('d1', 8, 'out'), bus('d2', 8, 'out'), bit('halt', 'out'), bit('clash', 'out'),
];

/**
 * Where a test (or the panel) reads the architectural state of sapComputer(): [instance path, output port]. Every
 * register is read at a chip's own output (the 173s drive always: M = N = 0), so a value is the bits of those nets.
 */
export const SAP_STATE = {
  pc: ['pc.cnt', 'q'], mar: ['mar.reg', 'q'], irLo: ['ir.lo', 'q'], irHi: ['ir.hi', 'q'], aLo: ['a.lo', 'q'], aHi: ['a.hi', 'q'],
  bLo: ['b.lo', 'q'], bHi: ['b.hi', 'q'], out: ['out.reg', 'q'], flags: ['flags.reg', 'q'], step: ['ctl.step', 'q'],
} as const;

const computers = new Map<string, ComponentDef>();

/**
 * The SAP-1 with `bytes` in its RAM at power-on. Two columns of modules as Ben's breadboards (clock, MAR, RAM,
 * instruction register, control on the left; PC, A, ALU and flags, B, output and display on the right) with the bus
 * between; the 16 control lines are net labels. Memoized by content.
 */
export function sapComputer(bytes: ArrayLike<number>): ComponentDef {
  const ram = Array.from({ length: 16 }, (_, i) => (bytes[i] ?? 0) & 0xff);
  if (!ram.some((x) => x)) return SAP_COMPUTER;
  const key = ram.map((x) => x.toString(16).padStart(2, '0')).join('');
  let d = computers.get(key);
  if (d) return d;
  // Not registered (as editor/memory.ts ramWithInit): the hints reach into the 189s' latches, which a sandbox
  // document (one chip's own wires) cannot hold. The registered SAP_COMPUTER is the same circuit with an empty RAM.
  d = {
    ...SAP_COMPUTER, id: `sap1_${key}`,
    summary: `${SAP_COMPUTER.summary} Its RAM starts with a program.`,
    powerOn: ls189Init('ram.hi', ram.map((x) => x >> 4), ls189Init('ram.lo', ram.map((x) => x & 15))),
  };
  computers.set(key, d);
  return d;
}

/** The computer with an empty RAM (registered: the layout and routing checks cover it; program it with the switches). */
export const SAP_COMPUTER: ComponentDef = (() => {
  const b = new Builder(16, 14, 6);
  b.pins(...ins(SAP_PORTS));
  // left column
  const clock = b.op(SAP_CLOCK, ['clk', ''], 'clock', 'clock');
  const clk = b.name(`${clock}.clk`, 'CLK', true);
  const mar = b.op(SAP_MAR, [clk, '', 'prog', '', 'addrSw'], 'memory address', 'mar');
  const mem = b.op(SAP_RAM, [clk, `${mar}.addr`, '', 'dataSw', 'prog', 'write', '', ''], 'RAM', 'ram');
  const ir = b.op(SAP_IR, [clk, '', '', ''], 'instruction', 'ir');
  const ctl = b.op(SAP_CONTROL, [b.name(`${clock}.nclk`, 'NCLK', true), b.name(`${ir}.op`, 'opcode', true), '', ''], 'control', 'ctl');
  const line = (n: string) => b.name(`${ctl}.${n}`, n.toUpperCase().replace('EO', 'ΣO'), true);
  // RESET: the CLRs of the PC, the step counter, A, B, the IR and the flags (not the MAR, OUT or the RAM)
  const rst = b.name('RESET', 'RESET', true);
  b.wire(rst, `${ctl}.rst`);
  b.wire(rst, `${ir}.rst`);
  b.wire(line('hlt'), `${clock}.hlt`);
  b.wire(line('hlt'), 'halt');
  b.wire(line('mi'), `${mar}.mi`);
  b.wire(line('ri'), `${mem}.ri`);
  b.wire(line('ro'), `${mem}.ro`);
  b.wire(line('ii'), `${ir}.ii`);
  b.wire(line('io'), `${ir}.io`);
  b.next();
  // the bus
  const bs = b.op(SAP_BUS, ['', '', '', '', '', line('co'), line('ro'), line('io'), line('ao'), line('eo')], 'bus', 'bus');
  const BUS = b.name(`${bs}.bus`, 'BUS', true);
  for (const s of [`${mar}.bus`, `${mem}.bus`, `${ir}.bus`]) b.wire(BUS, s);
  b.wire(BUS, 'bus');
  b.wire(`${bs}.clash`, 'clash');
  b.next();
  // right column
  const pc = b.op(SAP_PC, [clk, line('ce'), line('co'), line('j'), BUS], 'program counter', 'pc');
  const a = b.op(SAP_AREG, [clk, line('ai'), line('ao'), BUS], 'A register', 'a');
  const alu = b.op(SAP_ALU, [b.name(`${a}.q`, 'A', true), '', line('su'), line('eo')], 'ALU', 'alu');
  const fl = b.op(SAP_FLAGS, [clk, line('fi'), b.name(`${alu}.sum`, 'Σ', true), b.name(`${alu}.cout`, 'carry', true)], 'flags', 'flags');
  const breg = b.op(SAP_BREG, [clk, line('bi'), BUS], 'B register', 'b');
  b.wire(b.name(`${breg}.q`, 'B', true), `${alu}.b`);
  const out = b.op(SAP_OUT, [clk, line('oi'), BUS], 'output', 'out');
  const shown = b.name(`${out}.q`, 'OUT', true);
  const disp = b.op(SAP_DISPLAY, [shown], 'display', 'disp');
  b.wire(shown, 'out');
  for (const k of [0, 1, 2]) b.wire(`${disp}.d${k}`, `d${k}`);
  for (const m of [pc, a, fl, breg]) b.wire(rst, `${m}.rst`);
  b.wire(b.name(`${fl}.cf`, 'CF', true), `${ctl}.cf`);
  b.wire(b.name(`${fl}.zf`, 'ZF', true), `${ctl}.zf`);
  for (const [m, from] of [['pc', `${pc}.drv`], ['ram', `${mem}.drv`], ['ir', `${ir}.drv`], ['a', `${a}.drv`], ['alu', `${alu}.drv`]]) b.wire(from, `${bs}.${m}`);
  const R = b.right;
  return define({
    id: 'sap1', name: 'SAP-1 breadboard computer', category: 'cpu',
    summary: 'Ben Eater\'s 8-bit breadboard computer (SAP-1 after Malvino and Brown): 16 bytes of RAM, an 8-bit bus, A and B registers, an adder–subtractor with carry and zero flags, a 4-bit program counter, and a microcoded control unit stepping five control words an instruction. Every module is 74xx chips.',
    ports: SAP_PORTS,
    symbol: { kind: 'box', label: 'SAP-1' },
    netlist: () => ({ pins: { ...pinsAt(ins(SAP_PORTS), 0, 6), ...pinsAt(outs(SAP_PORTS), R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** One 74xx chip of the computer: its instance path from the top ('a.lo', 'ctl.romhi'), its TTL_PINS key, its definition. */
export interface SapChip { path: string; kind: string; def: ComponentDef }

/** Every 74xx chip in a SAP-1 module or computer, in drawing order (the breadboard's parts list, the cost line's chip count). */
export function sapChips(def: ComponentDef, prefix = ''): SapChip[] {
  const out: SapChip[] = [];
  for (const i of netlistOf(def)?.instances ?? []) {
    const path = prefix ? `${prefix}.${i.name}` : i.name;
    const kind = ttlKind(i.def);
    if (kind) out.push({ path, kind, def: i.def });
    else if (i.def.id.startsWith('sap_')) out.push(...sapChips(i.def, path));
  }
  return out;
}

/** What a SAP-1 costs: chips, NANDs in all, and the NANDs of its logic (the EEPROMs' ROM trees left out). */
export function sapCost(def: ComponentDef): { chips: number; nands: number; logicNands: number; eepromNands: number } {
  const chips = sapChips(def);
  const eepromNands = chips.filter((c) => c.kind === 'at28c16').reduce((s, c) => s + stats(c.def).nands, 0);
  const nands = stats(def).nands;
  return { chips: chips.length, nands, logicNands: nands - eepromNands, eepromNands };
}
