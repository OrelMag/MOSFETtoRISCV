// The first computer (chapter 'firstcomputer'): an 8-bit accumulator machine built only from parts the chapters before
// it open. One instruction per clock, Harvard: a 32 × 8 program ROM read by the PC, a 32 × 8 data RAM read and written
// at the instruction's address field. Every state change happens at the rising edge (PC, A, the RAM word, OUT); between
// edges the word flows through the splitter, the control block and the data path. Its golden model is acc8/acc8.ts.

import { ACC_OPS, ACC_PROGRAMS, accAssemble } from '../acc8/acc8';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { addSub, busMux2, decoder, equal, incrementer, muxTree } from './combinational';
import { define, merger, splitter } from './define';
import { AND, OR } from './gates';
import { ram } from './memory';
import { register } from './sequential';
import { TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

/** The control block's outputs, in port order: what each instruction class switches on. */
export const ACC_CTL_OUTS = ['la', 'am', 'ak', 'sub', 'we', 'jump', 'out', 'jmp'] as const;
export type AccCtl = Record<(typeof ACC_CTL_OUTS)[number], number>;

/** What the control block does, written out: the table the gates below must equal (tests/acc8.test.ts). */
export function accControl(op: number, z: number): AccCtl {
  const o = ACC_OPS[op & 7];
  return {
    la: +(o === 'LDA' || o === 'ADD' || o === 'SUB' || o === 'LDI'), // A takes a new value
    am: +(o === 'LDA'), // …from the RAM, not the adder
    ak: +(o === 'LDI'), // …from the instruction's constant
    sub: +(o === 'SUB'),
    we: +(o === 'STA'),
    jump: +(o === 'JMP' || (o === 'JZ' && z === 1)),
    out: +(o === 'OUT'),
    jmp: +(o === 'JMP'),
  };
}

/**
 * The control block: a 3-to-8 decoder raises one line per instruction, and a few OR gates join the lines that switch
 * the same thing on. JZ jumps only when Z = 1: an AND. This is all the "understanding" the machine has.
 */
export const ACC_CTL: ComponentDef = (() => {
  const b = new Builder(10, 10, 2);
  b.pins('op', 'z');
  const dec = b.op(decoder(3), ['op'], 'decoder', 'dec');
  const y = (i: number) => b.name(`${dec}.y${i}`, ACC_OPS[i], true);
  b.next();
  const as = b.op1(OR, [y(1), y(2)], 'ADD|SUB', 'or_as');
  const lm = b.op1(OR, [y(0), y(4)], 'LDA|LDI', 'or_lm');
  const jz = b.op1(AND, [y(6), 'z'], 'JZ·Z', 'and_jz');
  b.next();
  const la = b.op1(OR, [lm, as], 'loads A', 'or_la');
  const jump = b.op1(OR, [y(5), jz], 'jump', 'or_j');
  b.next();
  b.wire(la, 'la');
  b.wire(y(0), 'am');
  b.wire(y(4), 'ak');
  b.wire(y(2), 'sub');
  b.wire(y(3), 'we');
  b.wire(jump, 'jump');
  b.wire(y(7), 'out');
  b.wire(y(5), 'jmp');
  const R = b.right;
  const ports: PortDef[] = [bus('op', 3, 'in'), bit('z', 'in'), ...ACC_CTL_OUTS.map((n) => bit(n, 'out'))];
  return define({
    id: 'acc8_ctl', name: 'Control (first computer)', category: 'cpu',
    summary: 'Decodes the 3-bit op field: a 3-to-8 decoder raises the instruction\'s line, OR gates join the lines that switch on the same thing (A loads on LDA, ADD, SUB and LDI), and an AND lets JZ jump only while Z = 1.',
    ports,
    symbol: { kind: 'box', label: 'CONTROL' },
    spec: ([op, z]) => { const c = accControl(op, z); return ACC_CTL_OUTS.map((n) => c[n]); },
    netlist: () => ({
      pins: { op: [0, 10], z: [0, 22], ...Object.fromEntries(ACC_CTL_OUTS.map((n, i) => [n, [R, 4 + 3 * i]])) },
      instances: b.instances, nets: b.nets(),
    }),
  });
})();

const roms = new Map<string, ComponentDef>();
function hash(words: ArrayLike<number>): string {
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) { h ^= words[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

/** The 32 × 8 program ROM: a 32:1 multiplexer tree of constants (the program is its wiring), simulated as a lookup. */
export function accRom(words: ArrayLike<number>): ComponentDef {
  const content = Array.from({ length: 32 }, (_, i) => (words[i] ?? 0) & 255);
  const key = hash(content);
  const hit = roms.get(key);
  if (hit) return hit;
  const M = muxTree(5, 8, 2);
  const mg = symbolGeom(M);
  const d: ComponentDef = {
    id: `acc8_rom_${key}`, name: 'Program ROM 32×8', category: 'memory',
    summary: '32 words of 8 bits, read-only: a 32:1 multiplexer tree whose inputs are tied to the program\'s bits.',
    ports: [bus('addr', 5, 'in'), bus('data', 8, 'out')],
    symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : content[a & 31]], delay: 15 },
    preferBehavior: true,
    spec: ([a]) => [content[a & 31]],
    netlist: () => {
      const instances: InstanceDef[] = [{ name: 'mux', def: M, at: [16, 0] }];
      const nets: NetDef[] = [
        { name: 'addr', ends: ['addr', 'mux.s'], via: { 'mux.s': [[16 + mg.ports.s.pos[0], mg.h + 7]] } },
        { name: 'data', ends: ['mux.y', 'data'] },
      ];
      content.forEach((v, i) => {
        instances.push({ name: `c${i}`, def: constWord(8, v), at: [8, mg.ports[`d${i}`].pos[1] - 1], label: `[${i}]` });
        nets.push({ ends: [`c${i}.y`, `mux.d${i}`] });
      });
      return { pins: { addr: [0, mg.h + 7], data: [16 + mg.w + 6, mg.ports.y.pos[1]] }, instances, nets };
    },
  };
  roms.set(key, d);
  return d;
}

export const ACC_PORTS: PortDef[] = [bit('clk', 'in', true), bus('out', 8, 'out'), bit('halt', 'out')];

/** Instance paths of the machine's state, for panels and tests. */
export const ACC_STATE = { pc: 'pc', a: 'acc', out: 'outr', ram: 'ram', rom: 'rom' } as const;

const machines = new Map<string, ComponentDef>();

/**
 * The computer: PC (a 5-bit register, an incrementer and a jump multiplexer), the ROM, the word split into op and
 * x, the control block, the RAM at address x, the adder / subtractor of A and M[x], two multiplexers choosing A's
 * next value (M[x], the sum, or x itself), A, its zero test, and the OUT register. halt = 1 on a JMP to itself.
 */
export function accMachine(words: ArrayLike<number>): ComponentDef {
  const R0 = accRom(words);
  const hit = machines.get(R0.id);
  if (hit) return hit;
  const instances: InstanceDef[] = [];
  const geo = new Map<string, ReturnType<typeof symbolGeom>>();
  const at = new Map<string, [number, number]>();
  const place = (name: string, def: ComponentDef, xy: [number, number], label?: string) => {
    instances.push({ name, def, at: xy, ...(label ? { label } : {}) });
    geo.set(name, symbolGeom(def));
    at.set(name, xy);
  };
  const P = (inst: string, port: string): [number, number] => {
    const [x, y] = at.get(inst)!, p = geo.get(inst)!.ports[port].pos;
    return [x + p[0], y + p[1]];
  };
  /** Place def so that its port sits at height y. */
  const alignY = (name: string, def: ComponentDef, x: number, port: string, y: number, label?: string) =>
    place(name, def, [x, y - symbolGeom(def).ports[port].pos[1]], label);

  // The main row: PC → ROM → fields → RAM → adder → A's two multiplexers → A → OUT, each word on one line.
  const Y = 14;
  alignY('jmux', busMux2(5), 4, 'y', Y, 'next PC');
  alignY('pc', register(5), 12, 'd', Y, 'PC');
  place('one', TIE1, [9, P('pc', 'en')[1] - 1]);
  place('inc', incrementer(5), [22, Y - 10], '+1');
  alignY('rom', R0, 26, 'addr', P('pc', 'q')[1], 'program');
  alignY('f', splitter([5, 3]), 40, 'in', P('rom', 'data')[1], 'fields');
  alignY('ram', ram(5, 8), 52, 'addr', P('f', 'o0')[1], 'RAM');
  alignY('alu', addSub(8), 72, 'b', P('ram', 'dout')[1], 'A ± M');
  alignY('mux1', busMux2(8), 92, 'a', P('alu', 's')[1], 'sum | M');
  alignY('mux2', busMux2(8), 102, 'a', P('mux1', 'y')[1], '… | k');
  alignY('acc', register(8), 112, 'd', P('mux2', 'y')[1], 'A');
  alignY('outr', register(8), 128, 'd', P('acc', 'q')[1], 'OUT');
  // Below: the control block under the fields, the zero test under A, k = x widened to 8 bits, the halt test.
  place('ctl', ACC_CTL, [46, Y + 10], 'Control');
  place('zero', isZero(8), [124, Y + 10], 'A = 0?');
  place('kx', merger([5, 3]), [98, Y + 6], 'k');
  alignY('k0', constWord(3, 0), 90, 'y', P('kx', 'i1')[1], '0');
  place('self', equal(5), [22, Y + 14], 'x = PC?');
  place('hlt', AND, [34, Y + 22], 'halt');

  const R = 142;
  const ctlNet = (n: string, sink: string): NetDef => ({ name: n, ends: [`ctl.${n}`, sink], tags: true });
  const nets: NetDef[] = [
    { name: 'clk', ends: ['clk', 'pc.clk', 'ram.clk', 'acc.clk', 'outr.clk'], tags: true },
    { name: 'next', ends: ['jmux.y', 'pc.d'] },
    { name: 'one', ends: ['one.y', 'pc.en'] },
    { name: 'pc', ends: ['pc.q', 'rom.addr', 'inc.a', 'self.b'] },
    { name: 'pc+1', ends: ['inc.y', 'jmux.a'] },
    { name: 'instr', ends: ['rom.data', 'f.in'] },
    { name: 'x', ends: ['f.o0', 'ram.addr', 'jmux.b', 'kx.i0', 'self.a'], tags: ['jmux.b', 'kx.i0', 'self.a'] },
    { name: 'op', ends: ['f.o1', 'ctl.op'] },
    { name: 'M', ends: ['ram.dout', 'alu.b', 'mux1.b'] },
    { name: 'sum', ends: ['alu.s', 'mux1.a'] },
    { name: 'sum|M', ends: ['mux1.y', 'mux2.a'] },
    { name: 'k', ends: ['kx.out', 'mux2.b'] },
    { name: 'zero3', ends: ['k0.y', 'kx.i1'] },
    { name: 'A next', ends: ['mux2.y', 'acc.d'] },
    { name: 'A', ends: ['acc.q', 'outr.d', 'zero.a', 'alu.a', 'ram.din'], tags: ['alu.a', 'ram.din'] },
    { name: 'Z', ends: ['zero.z', 'ctl.z'], tags: true },
    { name: 'OUT', ends: ['outr.q', 'out'] },
    { name: 'eq', ends: ['self.eq', 'hlt.a'] },
    { name: 'halt', ends: ['hlt.y', 'halt'], tags: true },
    ctlNet('la', 'acc.en'), ctlNet('am', 'mux1.s'), ctlNet('ak', 'mux2.s'), ctlNet('sub', 'alu.sub'),
    ctlNet('we', 'ram.we'), ctlNet('jump', 'jmux.s'), ctlNet('out', 'outr.en'), ctlNet('jmp', 'hlt.b'),
  ];
  const d = define({
    id: `acc8_${R0.id.slice('acc8_rom_'.length)}`, name: 'First computer (8-bit accumulator)', category: 'cpu',
    summary: 'Eight instructions, one per clock: a 5-bit PC reads a 32 × 8 ROM; the word\'s top 3 bits pick the instruction, its low 5 bits the RAM address, jump target or constant. A holds the one number being worked on; the adder adds or subtracts M[x]; OUT shows A when told to. halt = 1 on a jump to itself.',
    ports: ACC_PORTS,
    symbol: { kind: 'box', label: 'COMPUTER' },
    netlist: () => ({ pins: { clk: [0, Y + 24], out: [R, P('outr', 'q')[1]], halt: [R, Y + 24] }, instances, nets }),
  });
  machines.set(R0.id, d);
  return d;
}

// Built at load (the chapter's multiplication), so the layout and routing checks cover the whole computer.
export const ACC8_MUL = accMachine(accAssemble(ACC_PROGRAMS.mul));
