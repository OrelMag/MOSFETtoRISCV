// A breadboard layout of the 4-bit CPU (lib/cpu4.ts CPU4_BCD), the test fixture for the breadboard view: its blocks
// as boards, their registers as chips with LEDs, the accumulator's output as the bus strip. Not a chapter: the SAP-1
// (Appendix C) has the real one.

import { type BbChip, type BreadboardLayout, ledsOf } from '../../src/view/bblayout';

/** A register(4) as a 74LS173-style 16-pin chip (the pin card's map; the 173's M / N / G2 / CLR are not modelled). */
const reg173 = (path: string[], ref: string, role: string): BbChip => ({
  path, part: '74LS173', dip: 16, ref, role,
  pins: {
    1: 'NC', 2: 'NC', 3: { port: 'q', bit: 0, name: '1Q' }, 4: { port: 'q', bit: 1, name: '2Q' }, 5: { port: 'q', bit: 2, name: '3Q' },
    6: { port: 'q', bit: 3, name: '4Q' }, 7: { port: 'clk', name: 'CLK' }, 8: 'GND', 9: { port: 'en', name: 'G1' }, 10: 'NC',
    11: { port: 'd', bit: 3, name: '4D' }, 12: { port: 'd', bit: 2, name: '3D' }, 13: { port: 'd', bit: 1, name: '2D' },
    14: { port: 'd', bit: 0, name: '1D' }, 15: 'NC', 16: 'VCC',
  },
});

const L = 0, R = 80, W = 64;

export const CPU4_BB: BreadboardLayout = {
  note: 'The 4-bit CPU as boards: a test fixture',
  buses: [{ id: 'a', title: 'A', at: [W + 3, 0], size: [10, 104], path: ['acc'], port: 'a' }],
  boards: [
    {
      title: 'Clock', at: [L, 0], size: [W, 16],
      chips: [{ part: 'NE555', dip: 8, ref: 'U1', role: 'The astable the stage\'s clock stands in for.' }],
      leds: [{ net: { path: [], port: 'clk' }, color: 'blue', label: 'CLK' }],
    },
    {
      title: 'PC & stack', at: [L, 18], size: [W, 18], module: ['pcs'],
      chips: [
        { path: ['pcs', 'pc'], part: '74LS273', dip: 20, ref: 'U2', role: 'The program counter: loads the next PC at every rising edge.' },
        { path: ['pcs', 's1'], part: '74LS273', dip: 20, ref: 'U3', role: 'Return address 1.' },
        { path: ['pcs', 's2'], part: '74LS273', dip: 20, ref: 'U4', role: 'Return address 2.' },
      ],
      leds: ledsOf(['pcs'], 'pc', 8, 'green'),
    },
    {
      title: 'Decode', at: [L, 38], size: [W, 18], module: ['dec'],
      chips: [{ path: ['dec'], part: 'DECODE', dip: 40, ref: 'U5', role: 'The control table in gates.' }],
      leds: (['awe', 'rwe', 'cwe', 'push', 'pop', 'srcwe', 'wrr'] as const).map((p) => ({ net: { path: ['dec'], port: p }, color: 'blue' as const, label: p.toUpperCase() })),
    },
    {
      title: 'Registers', at: [L, 58], size: [W, 18], module: ['regs'], bus: 'a',
      chips: [
        reg173(['regs', 'r0'], 'U6', 'Index register R0.'),
        reg173(['regs', 'r1'], 'U7', 'Index register R1.'),
        reg173(['regs', 'r2'], 'U8', 'Index register R2.'),
        reg173(['regs', 'r3'], 'U9', 'Index register R3.'),
      ],
      leds: [...ledsOf(['regs', 'r0'], 'q', 4, 'red'), ...ledsOf(['regs', 'r1'], 'q', 4, 'yellow').map((l, i) => (i ? l : { ...l, gap: true }))],
      drives: { path: ['dec'], port: 'rwe', label: 'RWE · writes a register' },
    },
    {
      title: 'Accumulator', at: [R, 0], size: [W, 18], module: ['acc'], bus: 'a',
      chips: [
        reg173(['acc', 'a'], 'U10', 'The accumulator A.'),
        { path: ['acc', 'cy'], part: '74LS74', dip: 14, ref: 'U11', role: 'The carry flip-flop.' },
      ],
      switches: [0, 1, 2, 3].map((i) => ({ port: 'sw', bit: 3 - i })),
      leds: [...ledsOf(['acc'], 'a', 4, 'red'), { net: { path: ['acc'], port: 'cy' }, color: 'green', label: 'CY', gap: true }],
      loads: { path: ['dec'], port: 'awe', label: 'AWE · loads at the next edge' },
    },
    {
      title: 'ALU', at: [R, 20], size: [W, 18], module: ['alu'], bus: 'a',
      chips: [{ path: ['alu'], part: '74LS181', dip: 24, ref: 'U12', role: 'The 4-bit ALU.' }],
      leds: [...ledsOf(['alu'], 'y', 4, 'red'), { net: { path: ['alu'], port: 'cout' }, color: 'green', label: 'C', gap: true }],
    },
    {
      title: 'Output', at: [R, 40], size: [W, 20], module: ['io'],
      chips: [0, 1, 2, 3].map((i) => ({ path: ['io', `port${i}`], part: '74LS173', dip: 16, ref: `U${13 + i}`, role: `Output port ${i}.` })),
      leds: ledsOf([], 'leds', 4, 'yellow'),
      digits: [3, 2, 1, 0].map((i) => ({ path: [], port: `d${i}`, hex: true })),
    },
    {
      title: 'Halt', at: [R, 62], size: [W, 12],
      chips: [],
      switches: [{ port: 'test', label: 'TEST' }],
      leds: [{ net: { path: [], port: 'halt' }, color: 'red', label: 'HLT' }],
    },
  ],
};
