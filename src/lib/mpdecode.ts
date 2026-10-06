// Small pieces for the multi-core processor (kept free of cpu.ts imports to avoid a module cycle):
// the decoder for atomics and csrr mhartid, and the round-robin memory arbiter.

import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { andN, busMux2, equal } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, XOR } from './gates';
import { DFF } from './sequential';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

/**
 * Recognises amoswap.w / amoadd.w and csrr rd, mhartid. An atomic is handed to the integer control
 * unit disguised as lw (it reads memory and writes rd); its address is rs1 itself (no offset).
 */
export const MP_DECODE: ComponentDef = define({
  id: 'mpdec', name: 'Atomic & hart-id decoder', category: 'cpu',
  summary: 'amoswap.w / amoadd.w: opcode 0101111 (funct5 picks the operation). csrr rd, mhartid: SYSTEM, funct3 = 2, CSR 0xF14, rs1 = 0. Atomics look like lw to the integer control unit.',
  ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), bus('rs1', 5, 'in'), bus('rs2', 5, 'in'),
    bit('isAMO', 'out'), bit('amoAdd', 'out'), bit('isHart', 'out'), bus('opInt', 7, 'out')],
  symbol: { kind: 'box', label: 'AMO / HART' },
  netlist: () => ({
    pins: { op: [0, 4], funct3: [0, 10], funct7: [0, 14], rs1: [0, 18], rs2: [0, 22], isAMO: [62, 4], amoAdd: [62, 10], isHart: [62, 16], opInt: [62, 22] },
    instances: [
      { name: 'kA', def: constWord(7, 0b0101111), at: [4, 0] }, { name: 'eA', def: equal(7), at: [16, 0], label: 'AMO?' },
      { name: 'kS', def: constWord(7, 0b1110011), at: [4, 46] }, { name: 'eS', def: equal(7), at: [16, 46], label: 'SYSTEM?' },
      { name: 'k3', def: constWord(3, 2), at: [4, 92] }, { name: 'e3', def: equal(3), at: [16, 92], label: 'csrrs?' },
      { name: 'imm', def: merger([5, 7]), at: [8, 112] },
      { name: 'kC', def: constWord(12, 0xf14), at: [4, 120] }, { name: 'eC', def: equal(12), at: [16, 116], label: 'mhartid?' },
      { name: 'z1', def: isZero(5), at: [16, 196], label: 'rs1 = 0' },
      { name: 'f5', def: splitter([2, 5]), at: [8, 210] }, { name: 'z5', def: isZero(5), at: [16, 210], label: 'funct5 = 0' },
      { name: 'hart', def: andN(4), at: [46, 100] },
      { name: 'add', def: AND, at: [46, 210] },
      { name: 'kL', def: constWord(7, 0b0000011), at: [36, 30] }, { name: 'om', def: busMux2(7), at: [48, 20], label: 'as lw' },
    ],
    nets: [
      { name: 'op', ends: ['op', 'eA.a', 'eS.a', 'om.a'], tags: ['eS.a', 'om.a'] },
      { ends: ['kA.y', 'eA.b'] }, { ends: ['kS.y', 'eS.b'] }, { ends: ['k3.y', 'e3.b'] }, { ends: ['kC.y', 'eC.b'] }, { ends: ['kL.y', 'om.b'] },
      { name: 'funct3', ends: ['funct3', 'e3.a'] },
      { name: 'rs2', ends: ['rs2', 'imm.i0'] },
      { name: 'funct7', ends: ['funct7', 'imm.i1', 'f5.in'], tags: ['f5.in'] },
      { name: 'csr', ends: ['imm.out', 'eC.a'] },
      { name: 'rs1', ends: ['rs1', 'z1.a'], tags: ['z1.a'] },
      { name: 'funct5', ends: ['f5.o1', 'z5.a'] },
      { name: 'isAMO', ends: ['eA.eq', 'om.s', 'add.a', 'isAMO'], tags: true },
      { name: 'sys', ends: ['eS.eq', 'hart.i0'], tags: true }, { name: 'f3is2', ends: ['e3.eq', 'hart.i1'], tags: true },
      { name: 'isMhartid', ends: ['eC.eq', 'hart.i2'], tags: true }, { name: 'rs1zero', ends: ['z1.z', 'hart.i3'], tags: true },
      { name: 'isHart', ends: ['hart.y', 'isHart'] },
      { name: 'swap0', ends: ['z5.z', 'add.b'] },
      { name: 'amoAdd', ends: ['add.y', 'amoAdd'] },
      { name: 'opInt', ends: ['om.y', 'opInt'] },
    ],
  }),
});

/**
 * Two-way round-robin arbiter: if only one core asks for the memory port it gets it; if both ask,
 * the one holding priority wins and priority passes to the other. No core can starve.
 */
export const ARBITER2: ComponentDef = define({
  id: 'arb2', name: 'Round-robin arbiter (2 ways)', category: 'sequential',
  summary: 'g0 = r0 AND NOT (r1 AND p); g1 = r1 AND NOT (r0 AND NOT p). On every conflict the priority bit p flips, so the loser of this round wins the next.',
  ports: [bit('r0', 'in'), bit('r1', 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bit('g0', 'out'), bit('g1', 'out'), bit('p', 'out')],
  symbol: { kind: 'box', label: 'ARBITER' },
  netlist: () => ({
    pins: { r0: [0, 4], r1: [0, 14], clk: [0, 26], g0: [54, 4], g1: [54, 14], p: [54, 24] },
    instances: [
      { name: 'np', def: NOT, at: [12, 20] },
      { name: 'b0', def: AND, at: [20, 8] }, { name: 'n0', def: NOT, at: [28, 9] }, { name: 'g0', def: AND, at: [36, 3] },
      { name: 'b1', def: AND, at: [20, 15] }, { name: 'n1', def: NOT, at: [28, 16] }, { name: 'g1', def: AND, at: [36, 13] },
      { name: 'both', def: AND, at: [20, 26] }, { name: 'x', def: XOR, at: [28, 26] }, { name: 'ff', def: DFF, at: [36, 24], label: 'priority' },
    ],
    nets: [
      { name: 'r0', ends: ['r0', 'g0.a', 'b1.a', 'both.a'], trunk: 6 },
      { name: 'r1', ends: ['r1', 'b0.a', 'g1.a', 'both.b'], trunk: 8 },
      { name: 'p', ends: ['ff.q', 'b0.b', 'np.a', 'x.b', 'p'], tags: ['b0.b', 'np.a', 'x.b'] },
      { name: '¬p', ends: ['np.y', 'b1.b'] },
      { ends: ['b0.y', 'n0.a'] }, { ends: ['n0.y', 'g0.b'] }, { ends: ['b1.y', 'n1.a'] }, { ends: ['n1.y', 'g1.b'] },
      { name: 'conflict', ends: ['both.y', 'x.a'] }, { name: 'pNext', ends: ['x.y', 'ff.d'] },
      { name: 'clk', ends: ['clk', 'ff.clk'] },
      { name: 'g0', ends: ['g0.y', 'g0'] }, { name: 'g1', ends: ['g1.y', 'g1'] },
    ],
  }),
});
