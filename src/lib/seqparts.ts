// More sequential building blocks: asynchronous reset, T and JK flip-flops, an up/down counter, a
// universal shift register, a linear-feedback shift register, ring and Johnson counters, and a ripple
// clock divider. All built from the latches and flip-flops of sequential.ts.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { addSub, busMux2, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { counter, DFF, register } from './sequential';
import { NAND, TIE1 } from './transistors';
import { xorN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

// ---- asynchronous reset -------------------------------------------------------------------------------

/** 3-input NAND from 2-input ones: NAND(NOT NAND(a, b), c). */
export const NAND3: ComponentDef = define({
  id: 'nand3', name: '3-input NAND', category: 'gate',
  summary: 'y = NOT (a AND b AND c), from three 2-input NANDs (in CMOS it would be one gate of six transistors).',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('c', 'in'), bit('y', 'out')],
  symbol: { kind: 'box', label: 'NAND3' },
  spec: ([a, b, c]) => [a && b && c ? 0 : 1],
  netlist: () => ({
    pins: { a: [0, 2], b: [0, 4], c: [0, 9], y: [20, 6] },
    instances: [{ name: 'n1', def: NAND, at: [3, 1] }, { name: 'inv', def: NAND, at: [9, 1] }, { name: 'n2', def: NAND, at: [15, 4] }],
    nets: [
      { ends: ['a', 'n1.a'] }, { ends: ['b', 'n1.b'] },
      { name: 'ab_n', ends: ['n1.y', 'inv.a', 'inv.b'] },
      { name: 'ab', ends: ['inv.y', 'n2.a'] },
      { ends: ['c', 'n2.b'] }, { name: 'y', ends: ['n2.y', 'y'] },
    ],
  }),
  hdl: { verilog: 'assign y = ~(a & b & c);' },
});

/** Gated D latch with an asynchronous active-low reset: rst_n = 0 forces q = 0 whatever d and e do. */
export const D_LATCH_R: ComponentDef = define({
  id: 'd_latch_r', name: 'D latch with reset', category: 'sequential',
  summary: 'The D latch with a third input on two of its NANDs. rst_n = 0 blocks the set side and forces the reset side: q = 0 immediately, enable or not.',
  ports: [bit('d', 'in'), bit('e', 'in'), bit('rst_n', 'in'), bit('q', 'out'), bit('q_n', 'out')],
  symbol: { kind: 'box', label: 'D latch R' },
  powerOn: { q: 0, q_n: 1 },
  netlist: () => ({
    pins: { d: [0, 3], e: [0, 9], rst_n: [0, 20], q: [52, 4], q_n: [52, 14] },
    instances: [
      { name: 'inv', def: NOT, at: [4, 12] },
      { name: 'g1', def: NAND3, at: [10, 1], label: 'set side' },
      { name: 'g2', def: NAND, at: [12, 12] },
      { name: 'q1', def: NAND, at: [36, 2] },
      { name: 'q2', def: NAND3, at: [32, 11] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'g1.a', 'inv.a'], trunk: 2 },
      { name: 'e', ends: ['e', 'g1.b', 'g2.b'], trunk: 7 },
      { name: 'rst_n', ends: ['rst_n', 'g1.c', 'q2.c'], trunk: 9, tags: ['g1.c', 'q2.c'] },
      { name: 'd_n', ends: ['inv.y', 'g2.a'] },
      { name: 's_n', ends: ['g1.y', 'q1.a'] },
      { name: 'r_n', ends: ['g2.y', 'q2.b'] },
      { name: 'q', ends: ['q1.y', 'q', 'q2.a'], tags: ['q2.a'] },
      { name: 'q_n', ends: ['q2.y', 'q_n', 'q1.b'], tags: ['q1.b'] },
    ],
  }),
  hdl: {
    verilog: `assign s_n = ~(d & e & rst_n);
assign r_n = ~(~d & e);
assign q   = ~(s_n & q_n);
assign q_n = ~(q & r_n & rst_n);`,
  },
});

/** Master–slave D flip-flop with asynchronous active-low reset. */
export const DFF_R: ComponentDef = define({
  id: 'dff_r', name: 'D flip-flop with async reset', category: 'sequential',
  summary: 'Two resettable latches. rst_n = 0 clears both at once, without waiting for a clock edge: the way a whole chip is put into a known state at power-on.',
  ports: [bit('d', 'in'), bit('clk', 'in', 'left', true), bit('rst_n', 'in'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'DFF R' },
  netlist: () => {
    const g = symbolGeom(D_LATCH_R), x2 = 10 + g.w + 8;
    return {
      pins: { d: [0, 1 + g.ports.d.pos[1]], clk: [0, 1 + g.ports.e.pos[1]], rst_n: [0, 1 + g.h + 4], q: [x2 + g.w + 6, 1 + g.ports.q.pos[1]] },
      instances: [
        { name: 'inv', def: NOT, at: [4, g.ports.e.pos[1]] },
        { name: 'master', def: D_LATCH_R, at: [10, 1] },
        { name: 'slave', def: D_LATCH_R, at: [x2, 1] },
      ],
      nets: [
        { name: 'd', ends: ['d', 'master.d'] },
        { name: 'clk', ends: ['clk', 'inv.a', 'slave.e'], tags: ['slave.e'] },
        { name: 'clk_n', ends: ['inv.y', 'master.e'] },
        { name: 'rst_n', ends: ['rst_n', 'master.rst_n', 'slave.rst_n'] },
        { name: 'm', ends: ['master.q', 'slave.d'] },
        { name: 'q', ends: ['slave.q', 'q'] },
      ],
    };
  },
  hdl: { verilog: 'always_ff @(posedge clk or negedge rst_n)\n  if (!rst_n) q <= 1\'b0;\n  else        q <= d;' },
});

/** T flip-flop: toggles on each rising edge while t = 1. */
export const TFF: ComponentDef = define({
  id: 'tff', name: 'T flip-flop', category: 'sequential',
  summary: 'd = t XOR q: with t = 1 every rising edge flips q, with t = 0 it holds. A divide-by-two when t is tied high.',
  ports: [bit('t', 'in'), bit('clk', 'in', 'left', true), bit('rst_n', 'in'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'TFF' },
  netlist: () => {
    const g = symbolGeom(DFF_R);
    return {
      pins: { t: [0, 3], clk: [0, 3 + g.ports.clk.pos[1]], rst_n: [0, 3 + g.ports.rst_n.pos[1]], q: [14 + g.w + 8, 3 + g.ports.q.pos[1]] },
      instances: [{ name: 'x', def: XOR, at: [5, 1] }, { name: 'ff', def: DFF_R, at: [14, 3] }],
      nets: [
        { name: 't', ends: ['t', 'x.a'] },
        { name: 'next', ends: ['x.y', 'ff.d'] },
        { name: 'clk', ends: ['clk', 'ff.clk'] }, { name: 'rst_n', ends: ['rst_n', 'ff.rst_n'] },
        { name: 'q', ends: ['ff.q', 'q', 'x.b'], tags: ['x.b'] },
      ],
    };
  },
  hdl: { verilog: 'always_ff @(posedge clk or negedge rst_n)\n  if (!rst_n) q <= 0; else if (t) q <= ~q;' },
});

/** JK flip-flop: j sets, k resets, both toggle. */
export const JKFF: ComponentDef = define({
  id: 'jkff', name: 'JK flip-flop', category: 'sequential',
  summary: 'd = j·¬q + ¬k·q. j = 1 sets, k = 1 resets, both = 1 toggles, both = 0 holds: the SR latch\'s forbidden input given a meaning.',
  ports: [bit('j', 'in'), bit('k', 'in'), bit('clk', 'in', 'left', true), bit('rst_n', 'in'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'JKFF' },
  netlist: () => {
    const g = symbolGeom(DFF_R), xf = 30;
    return {
      pins: { j: [0, 2], k: [0, 9], clk: [0, 6 + g.ports.clk.pos[1]], rst_n: [0, 6 + g.ports.rst_n.pos[1]], q: [xf + g.w + 8, 6 + g.ports.q.pos[1]] },
      instances: [
        { name: 'nq', def: NOT, at: [6, 4] },
        { name: 'nk', def: NOT, at: [6, 8] },
        { name: 'set', def: AND, at: [12, 1] },
        { name: 'keep', def: AND, at: [12, 8] },
        { name: 'o', def: OR, at: [20, 4] },
        { name: 'ff', def: DFF_R, at: [xf, 6] },
      ],
      nets: [
        { name: 'j', ends: ['j', 'set.a'] }, { name: 'k', ends: ['k', 'nk.a'] },
        { name: '¬q', ends: ['nq.y', 'set.b'] }, { name: '¬k', ends: ['nk.y', 'keep.a'] },
        { ends: ['set.y', 'o.a'] }, { ends: ['keep.y', 'o.b'] },
        { name: 'next', ends: ['o.y', 'ff.d'] },
        { name: 'clk', ends: ['clk', 'ff.clk'] }, { name: 'rst_n', ends: ['rst_n', 'ff.rst_n'] },
        { name: 'q', ends: ['ff.q', 'q', 'nq.a', 'keep.b'], tags: ['nq.a', 'keep.b'] },
      ],
    };
  },
  hdl: { verilog: 'always_ff @(posedge clk or negedge rst_n)\n  if (!rst_n) q <= 0;\n  else case ({j, k}) 2\'b01: q <= 0; 2\'b10: q <= 1; 2\'b11: q <= ~q; default: ; endcase' },
});

// ---- counters ---------------------------------------------------------------------------------------------

/** n-bit up/down counter with parallel load: q ← load ? d : q ± 1 (when en or load). */
export function upDownCounter(n: number): ComponentDef {
  return memo(`updown${n}`, () => {
    const b = new Builder(16, 12);
    b.pins('up', 'en', 'load', 'd', 'clk');
    const down = b.op1(NOT, ['up'], 'down?');
    const one = b.op1(constWord(n, 1), []);
    const go = b.op1(OR, ['en', 'load'], 'change?');
    b.next();
    const q = 'reg.q';
    const add = b.op(addSub(n), [q, one, down], 'q ± 1');
    b.next();
    const nx = b.op1(busMux2(n), [`${add}.s`, 'd', 'load'], 'load?');
    b.next();
    const reg = b.op(register(n), [nx, go, 'clk'], 'count', 'reg');
    b.name(`${reg}.q`, 'q', true);
    b.next();
    b.wire(`${reg}.q`, 'q');
    const R = b.right;
    return define({
      id: `updown${n}`, name: `${n}-bit up/down counter`, category: 'sequential',
      summary: 'One adder/subtractor adds or subtracts 1 (sub = NOT up); a multiplexer chooses a parallel load instead. Counting down from 0 wraps to all ones.',
      ports: [bit('up', 'in'), bit('en', 'in'), bit('load', 'in'), bus('d', n, 'in'), bit('clk', 'in', 'bottom', true), bus('q', n, 'out')],
      symbol: { kind: 'box', label: `UP/DN${n}` },
      netlist: () => ({ pins: { up: [0, 2], en: [0, 6], load: [0, 10], d: [0, 14], clk: [0, 18], q: [R, 6] }, instances: b.instances, nets: b.nets() }),
      hdl: { verilog: 'always_ff @(posedge clk)\n  if (load)    q <= d;\n  else if (en) q <= up ? q + 1 : q - 1;' },
    });
  });
}

/**
 * Universal shift register (the 74194): mode 0 holds, 1 shifts right (towards bit 0; sr enters at the
 * top), 2 shifts left (sl enters at bit 0), 3 loads d in parallel. Serial in, parallel out and the reverse
 * are just ways of using it.
 */
export function shiftRegister(n: number): ComponentDef {
  return memo(`shreg${n}`, () => {
    const MX = muxTree(2, 1), mg = symbolGeom(MX), dg = symbolGeom(DFF);
    const P = Math.max(mg.h, dg.h) + 6, xs = 6, xm = 16, xf = xm + mg.w + 8, xo = xf + dg.w + 8;
    const yq = 2 + mg.ports.y.pos[1] - dg.ports.d.pos[1] + dg.ports.q.pos[1]; // flip-flop q of row 0
    const instances: InstanceDef[] = [
      { name: 'sd', def: splitter(ones(n), P), at: [xs, 2 + mg.ports.d3.pos[1] - P / 2] },
      { name: 'mq', def: merger(ones(n), P), at: [xo, yq - P / 2] },
    ];
    const nets: NetDef[] = [{ name: 'd', ends: ['d', 'sd.in'] }, { name: 'q', ends: ['mq.out', 'q'] }];
    const mode = ['mode'], clk = ['clk'];
    const qEnds: string[][] = Array.from({ length: n }, (_, i) => [`ff${i}.q`, `mq.i${i}`, `m${i}.d0`]);
    const srEnds = ['sr'], slEnds = ['sl'];
    for (let i = 0; i < n; i++) {
      const y = 2 + P * i;
      instances.push({ name: `m${i}`, def: MX, at: [xm, y], label: `bit ${i}` });
      instances.push({ name: `ff${i}`, def: DFF, at: [xf, y + mg.ports.y.pos[1] - dg.ports.d.pos[1]] });
      nets.push({ ends: [`sd.o${i}`, `m${i}.d3`] }, { name: `n${i}`, ends: [`m${i}.y`, `ff${i}.d`] });
      // shift right: bit i takes bit i + 1 (the top takes sr); shift left: bit i takes bit i − 1 (bit 0 takes sl)
      (i === n - 1 ? srEnds : qEnds[i + 1]).push(`m${i}.d1`);
      (i === 0 ? slEnds : qEnds[i - 1]).push(`m${i}.d2`);
      mode.push(`m${i}.s`);
      clk.push(`ff${i}.clk`);
    }
    qEnds.forEach((e, i) => nets.push({ name: `q${i}`, ends: e, tags: e.slice(2) }));
    nets.push({ name: 'sr', ends: srEnds, tags: srEnds.slice(1) }, { name: 'sl', ends: slEnds, tags: slEnds.slice(1) });
    nets.push({ name: 'mode', ends: mode, tags: mode.slice(1) }, { name: 'clk', ends: clk, tags: clk.slice(1) });
    const H = 2 + P * n;
    return define({
      id: `shreg${n}`, name: `${n}-bit universal shift register`, category: 'sequential',
      summary: `${n} flip-flops, each fed by a 4:1 multiplexer: hold, take the left neighbour, take the right neighbour, or load. mode 1: serial in at the top (sr), out at q[0]. mode 2: in at the bottom (sl), out at q[${n - 1}]. mode 3: parallel load.`,
      ports: [bus('mode', 2, 'in'), bit('sr', 'in'), bit('sl', 'in'), bus('d', n, 'in'), bit('clk', 'in', 'bottom', true), bus('q', n, 'out')],
      symbol: { kind: 'box', label: `SHIFT${n}` },
      netlist: () => ({ pins: { mode: [0, H + 2], sr: [0, H + 6], sl: [0, H + 10], d: [0, 2 + mg.ports.d3.pos[1] + (P * (n - 1)) / 2], clk: [0, H + 14], q: [xo + 8, yq + (P * (n - 1)) / 2] }, instances, nets }),
      hdl: {
        verilog: `always_ff @(posedge clk)
  case (mode)
    2'd1: q <= {sr, q[N-1:1]};      // shift right
    2'd2: q <= {q[N-2:0], sl};      // shift left
    2'd3: q <= d;                   // load
    default: ;                      // hold
  endcase`,
      },
    });
  });
}

/** Feedback taps (bit numbers, 1-based as in x^n + … + 1) of maximal-length LFSRs. */
export const LFSR_TAPS: Record<number, number[]> = { 3: [3, 2], 4: [4, 3], 5: [5, 3], 6: [6, 5], 7: [7, 6], 8: [8, 6, 5, 4], 16: [16, 15, 13, 4] };

/** Software model of lfsr(n): the next state. */
export const lfsrNext = (q: number, n: number) => {
  const fb = LFSR_TAPS[n].reduce((x, t) => x ^ ((q >> (t - 1)) & 1), 0);
  return ((q << 1) | fb) & (2 ** n - 1);
};

/**
 * Fibonacci linear-feedback shift register: shift left, and the new bit 0 is the XOR of the tap bits.
 * With maximal taps it visits all 2^n − 1 non-zero states before repeating. load copies seed in.
 */
export function lfsr(n: number): ComponentDef {
  const taps = LFSR_TAPS[n];
  if (!taps) throw new Error(`no LFSR taps for ${n} bits`);
  return memo(`lfsr${n}`, () => {
    const REG = register(n), MX = busMux2(n), FB = taps.length === 2 ? XOR : xorN(taps.length);
    const rg = symbolGeom(REG), mg = symbolGeom(MX), fg = symbolGeom(FB);
    const xm = 14, xr = xm + mg.w + 10, xs = xr + rg.w + 8, xf = xs + 8, y0 = 4;
    const instances: InstanceDef[] = [
      { name: 'mx', def: MX, at: [xm, y0], label: 'load seed?' },
      { name: 'reg', def: REG, at: [xr, y0] },
      { name: 'one', def: TIE1, at: [xr - 6, y0 + rg.h + 2] },
      { name: 'sq', def: splitter([n - 1, 1]), at: [xs, y0 + rg.ports.q.pos[1] - 1] },
      { name: 'taps', def: splitter(ones(n)), at: [xs, y0 + rg.h + 8] },
      { name: 'fb', def: FB, at: [xf, y0 + rg.h + 8 + n - fg.h / 2], label: `taps ${taps.join(', ')}` },
      { name: 'nx', def: merger([1, n - 1]), at: [xf + fg.w + 6, y0 + rg.ports.q.pos[1] - 1] },
    ];
    const fIns = FB.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    const nets: NetDef[] = [
      { name: 'seed', ends: ['seed', 'mx.b'] }, { name: 'load', ends: ['load', 'mx.s'] },
      { name: 'clk', ends: ['clk', 'reg.clk'] }, { ends: ['one.y', 'reg.en'] },
      { name: 'd', ends: ['mx.y', 'reg.d'] },
      { name: 'q', ends: ['reg.q', 'sq.in', 'taps.in', 'q'], tags: ['taps.in', 'q'] },
      { name: 'low', ends: ['sq.o0', 'nx.i1'] },
      { name: 'feedback', ends: ['fb.y', 'nx.i0'], tags: true },
      { name: 'next', ends: ['nx.out', 'mx.a'], tags: true },
    ];
    taps.forEach((t, i) => nets.push({ name: `q${t - 1}`, ends: [`taps.o${t - 1}`, `fb.${fIns[i]}`] }));
    const R = xf + fg.w + 14;
    return define({
      id: `lfsr${n}`, name: `${n}-bit LFSR`, category: 'sequential',
      summary: `Shift left; the bit shifted in is the XOR of bits ${taps.map((t) => t - 1).join(', ')} (the polynomial x^${taps[0]}${taps.slice(1).map((t) => ` + x^${t}`).join('')} + 1). ${2 ** n - 1} states before it repeats, from ${taps.length - 1} XOR gate${taps.length > 2 ? 's' : ''}: test patterns, scramblers, CRCs and cheap pseudo-random numbers. All zeros is a trap it never leaves.`,
      ports: [bit('load', 'in'), bus('seed', n, 'in'), bit('clk', 'in', 'bottom', true), bus('q', n, 'out')],
      symbol: { kind: 'box', label: `LFSR${n}` },
      netlist: () => ({ pins: { seed: [0, y0 + mg.ports.b.pos[1]], load: [0, y0 + mg.h + 4], clk: [0, y0 + rg.h + 12], q: [R, y0 + rg.ports.q.pos[1] - 6] }, instances, nets }),
      hdl: { verilog: `always_ff @(posedge clk)\n  q <= load ? seed : {q[N-2:0], ${taps.map((t) => `q[${t - 1}]`).join(' ^ ')}};` },
    });
  });
}

/** Software model of randomSource(n): the next state (the shifted-in bit is the XNOR of the taps). */
export const xnorLfsrNext = (q: number, n: number) => lfsrNext(q, n) ^ 1;

/**
 * A free-running pseudo-random source: an XNOR LFSR clocked every cycle. XNOR instead of XOR moves
 * the stuck state from all zeros to all ones, so it runs from the zero a power-on gives it, with no
 * seed to load; same taps, same 2^n − 1 states (each the complement of the XOR register's).
 */
export function randomSource(n: number): ComponentDef {
  const taps = LFSR_TAPS[n];
  if (!taps) throw new Error(`no LFSR taps for ${n} bits`);
  return memo(`random${n}`, () => {
    const REG = register(n), FB = taps.length === 2 ? XOR : xorN(taps.length);
    const rg = symbolGeom(REG), fg = symbolGeom(FB);
    const xr = 8, xs = xr + rg.w + 8, xf = xs + 8, y0 = 4, yq = y0 + rg.ports.q.pos[1];
    const yf = y0 + rg.h + 8 + n - fg.h / 2, xi = xf + fg.w + 3, xn = xi + 3 + 5;
    const instances: InstanceDef[] = [
      { name: 'reg', def: REG, at: [xr, y0] },
      { name: 'one', def: TIE1, at: [xr - 6, y0 + rg.h + 2] },
      { name: 'sq', def: splitter([n - 1, 1]), at: [xs, yq - 1] },
      { name: 'taps', def: splitter(ones(n)), at: [xs, y0 + rg.h + 8] },
      { name: 'fb', def: FB, at: [xf, yf], label: `taps ${taps.join(', ')}` },
      { name: 'inv', def: NOT, at: [xi, yf + fg.ports.y.pos[1] - 1] },
      { name: 'nx', def: merger([1, n - 1]), at: [xn, yq - 1] },
    ];
    const fIns = FB.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    const nets: NetDef[] = [
      { name: 'clk', ends: ['clk', 'reg.clk'] }, { ends: ['one.y', 'reg.en'] },
      { name: 'q', ends: ['reg.q', 'sq.in', 'taps.in', 'q'], tags: ['taps.in', 'q'] },
      { name: 'low', ends: ['sq.o0', 'nx.i1'] },
      { name: 'xor', ends: ['fb.y', 'inv.a'] },
      { name: 'shift_in', ends: ['inv.y', 'nx.i0'], tags: true },
      { name: 'next', ends: ['nx.out', 'reg.d'], tags: true },
    ];
    taps.forEach((t, i) => nets.push({ name: `q${t - 1}`, ends: [`taps.o${t - 1}`, `fb.${fIns[i]}`] }));
    const R = xn + 10;
    return define({
      id: `random${n}`, name: `${n}-bit random source`, category: 'sequential',
      summary: `Pseudo-random numbers, a new one every clock edge: an XNOR linear-feedback shift register (taps ${taps.map((t) => t - 1).join(', ')}). `
        + `It runs from the all-zeros power-on state with no seed and repeats after ${2 ** n - 1} numbers; all ones is the one state it never reaches. Deterministic, so a run can be replayed.`,
      ports: [bit('clk', 'in', 'bottom', true), bus('q', n, 'out')],
      symbol: { kind: 'box', label: `RND${n}` },
      netlist: () => ({ pins: { clk: [0, y0 + rg.h + 12], q: [R, yq - 6] }, instances, nets }),
      hdl: { verilog: `always_ff @(posedge clk)\n  q <= {q[N-2:0], ~(${taps.map((t) => `q[${t - 1}]`).join(' ^ ')})};` },
    });
  });
}

/** A cycle counter: a counter enabled for good, so q is the number of clock edges since power-on (mod 2^n). */
export function cycleCounter(n: number): ComponentDef {
  return memo(`cycles${n}`, () => {
    const C = counter(n), cg = symbolGeom(C), tg = symbolGeom(TIE1);
    const at: [number, number] = [10, 2];
    const ye = at[1] + cg.ports.en.pos[1];
    return define({
      id: `cycles${n}`, name: `${n}-bit cycle counter`, category: 'sequential',
      summary: `The number of clock edges since power-on, wrapping at 2^${n}: a counter whose enable is tied to 1. Time for a program, a timeout, a benchmark.`,
      ports: [bit('clk', 'in', 'bottom', true), bus('q', n, 'out')],
      symbol: { kind: 'box', label: `CYC${n}` },
      netlist: () => ({
        pins: { clk: [0, at[1] + cg.h + 3], q: [at[0] + cg.w + 6, at[1] + cg.ports.q.pos[1]] },
        instances: [{ name: 'one', def: TIE1, at: [2, ye - tg.ports.y.pos[1]] }, { name: 'cnt', def: C, at }],
        nets: [
          { ends: ['one.y', 'cnt.en'] },
          { name: 'clk', ends: ['clk', 'cnt.clk'] },
          { name: 'q', ends: ['cnt.q', 'q'] },
        ],
      }),
      hdl: { verilog: 'always_ff @(posedge clk)\n  q <= q + 1;' },
    });
  });
}

/**
 * Ring counter (one hot bit circulating) or Johnson counter (the inverted top bit fed back: 2n states,
 * each decoded by one 2-input gate). init loads the start state (0…01 for a ring, 0 for Johnson).
 */
export function ringCounter(n: number, johnson = false): ComponentDef {
  const id = `${johnson ? 'johnson' : 'ring'}${n}`;
  return memo(id, () => {
    const REG = register(n), MX = busMux2(n), rg = symbolGeom(REG), mg = symbolGeom(MX);
    const xm = 14, xr = xm + mg.w + 10, xs = xr + rg.w + 8, xn = xs + 12, y0 = 4;
    const instances: InstanceDef[] = [
      { name: 'k', def: constWord(n, johnson ? 0 : 1), at: [2, y0 + mg.ports.b.pos[1] - 1] },
      { name: 'mx', def: MX, at: [xm, y0], label: 'init?' },
      { name: 'reg', def: REG, at: [xr, y0] },
      { name: 'one', def: TIE1, at: [xr - 6, y0 + rg.h + 2] },
      { name: 'sq', def: splitter([n - 1, 1], 4), at: [xs, y0 + rg.ports.q.pos[1] - 2] },
      { name: 'nx', def: merger([1, n - 1], 4), at: [xn + 8, y0 + rg.ports.q.pos[1] - 2] },
    ];
    const nets: NetDef[] = [
      { ends: ['k.y', 'mx.b'] }, { name: 'init', ends: ['init', 'mx.s'] },
      { name: 'clk', ends: ['clk', 'reg.clk'] }, { ends: ['one.y', 'reg.en'] },
      { name: 'd', ends: ['mx.y', 'reg.d'] },
      { name: 'q', ends: ['reg.q', 'sq.in', 'q'], tags: ['q'] },
      { name: 'low', ends: ['sq.o0', 'nx.i1'] },
      { name: 'next', ends: ['nx.out', 'mx.a'], tags: true },
    ];
    if (johnson) {
      instances.push({ name: 'inv', def: NOT, at: [xn, y0 + rg.ports.q.pos[1] + 1] });
      nets.push({ name: 'top', ends: ['sq.o1', 'inv.a'] }, { name: '¬top', ends: ['inv.y', 'nx.i0'] });
    } else nets.push({ name: 'top', ends: ['sq.o1', 'nx.i0'] });
    const R = xn + 18;
    return define({
      id, name: `${n}-bit ${johnson ? 'Johnson' : 'ring'} counter`, category: 'sequential',
      summary: johnson
        ? `A shift register whose inverted top bit re-enters at the bottom: 0000 → 0001 → 0011 → … → 1111 → 1110 → …, ${2 * n} states from ${n} flip-flops, and any state is recognised by one 2-input gate. Only one bit changes per step.`
        : `A shift register whose top bit re-enters at the bottom: one 1 circulates through ${n} states. No decoder needed (the outputs are already one-hot), at the cost of ${n} flip-flops for ${n} states.`,
      ports: [bit('init', 'in'), bit('clk', 'in', 'bottom', true), bus('q', n, 'out')],
      symbol: { kind: 'box', label: johnson ? `JOHNSON${n}` : `RING${n}` },
      netlist: () => ({ pins: { init: [0, y0 + mg.h + 4], clk: [0, y0 + rg.h + 8], q: [R, y0 + rg.ports.q.pos[1] - 6] }, instances, nets }),
      hdl: { verilog: `always_ff @(posedge clk)\n  q <= init ? ${johnson ? "'0" : "1"} : {q[N-2:0], ${johnson ? '~' : ''}q[N-1]};` },
    });
  });
}

/**
 * Ripple clock divider: k T flip-flops with t = 1, each clocked by the previous one's output. Output i
 * runs at f / 2^(i+1). Cheap, but each stage adds its own delay: the outputs do not change together.
 */
export function clockDivider(k: number): ComponentDef {
  return memo(`clkdiv${k}`, () => {
    const g = symbolGeom(TFF), dx = g.w + 10;
    const instances: InstanceDef[] = [{ name: 'one', def: TIE1, at: [2, -2] }];
    const nets: NetDef[] = [];
    const tEnds = ['one.y'], rEnds = ['rst_n'];
    let clk = 'clk';
    const outs: string[] = [];
    for (let i = 0; i < k; i++) {
      const nm = `t${i}`;
      instances.push({ name: nm, def: TFF, at: [8 + dx * i, 4], label: `÷${2 ** (i + 1)}` });
      tEnds.push(`${nm}.t`);
      rEnds.push(`${nm}.rst_n`);
      nets.push({ name: i === 0 ? 'clk' : `f/${2 ** i}`, ends: [clk, `${nm}.clk`] });
      clk = `${nm}.q`;
      outs.push(clk);
    }
    instances.push({ name: 'mq', def: merger(ones(k)), at: [8 + dx * k, 4 + g.h + 6] });
    outs.forEach((o, i) => {
      const e = nets.find((nt) => nt.ends[0] === o);
      if (e) { e.ends.push(`mq.i${i}`); e.tags = [`mq.i${i}`]; } else nets.push({ name: `f/${2 ** (i + 1)}`, ends: [o, `mq.i${i}`] });
    });
    nets.push({ name: '1', ends: tEnds, tags: tEnds.slice(1) }, { name: 'rst_n', ends: rEnds, tags: rEnds.slice(1) }, { name: 'q', ends: ['mq.out', 'q'] });
    const R = 8 + dx * k + 8;
    return define({
      id: `clkdiv${k}`, name: `÷${2 ** k} ripple clock divider`, category: 'sequential',
      summary: `${k} toggle flip-flops in a chain, each clocked by the one before: output i is the clock divided by 2^(i+1). As a counter it counts down and its bits settle one stage after another (ripple), so its value is briefly wrong after every edge; synchronous counters share one clock instead.`,
      ports: [bit('clk', 'in', 'left', true), bit('rst_n', 'in'), bus('q', k, 'out')],
      symbol: { kind: 'box', label: `÷${2 ** k}` },
      netlist: () => ({ pins: { clk: [0, 4 + g.ports.clk.pos[1]], rst_n: [0, 4 + g.h + 4], q: [R, 4 + g.h + 6 + k] }, instances, nets }),
      hdl: { verilog: `// stage i toggles on the rising edge of stage i−1's output
always_ff @(posedge clk or negedge rst_n) if (!rst_n) q[0] <= 0; else q[0] <= ~q[0];
for (genvar i = 1; i < K; i++)
  always_ff @(posedge q[i-1] or negedge rst_n) if (!rst_n) q[i] <= 0; else q[i] <= ~q[i];` },
    });
  });
}
