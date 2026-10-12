// Level 3: memory from feedback (primer ch. 5, hdl/seq.sv).

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { define, merger, ones, splitter } from './define';
import { MUX2, NOT } from './gates';
import { NAND } from './transistors';
import { incrementer } from './combinational';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef =>
  ({ name, width: 1, dir, side, clock });

function memo<A extends unknown[]>(f: (...a: A) => ComponentDef): (...a: A) => ComponentDef {
  const cache = new Map<string, ComponentDef>();
  return (...a: A) => {
    const k = JSON.stringify(a);
    let d = cache.get(k);
    if (!d) cache.set(k, (d = f(...a)));
    return d;
  };
}

/** Cross-coupled NANDs. Inputs are active-low: pull s_n low to set, r_n low to reset. */
export const SR_LATCH: ComponentDef = define({
  id: 'sr_latch', name: 'SR latch', category: 'sequential',
  summary: 'Two NANDs feeding each other. With both inputs at 1 it holds whatever it was last told: one bit of memory.',
  ports: [bit('s_n', 'in'), bit('r_n', 'in'), bit('q', 'out'), bit('q_n', 'out')],
  symbol: { kind: 'box', label: 'SR latch' },
  powerOn: { q: 0, q_n: 1 },
  netlist: () => ({
    pins: { s_n: [1, 2], r_n: [1, 12], q: [16, 3], q_n: [16, 11] },
    instances: [
      { name: 'g1', def: NAND, at: [6, 1] },
      { name: 'g2', def: NAND, at: [6, 9] },
    ],
    nets: [
      { name: 's_n', ends: ['s_n', 'g1.a'] },
      { name: 'r_n', ends: ['r_n', 'g2.b'] },
      { name: 'q', ends: ['g1.y', 'q', 'g2.a'], via: { 'g2.a': [[11, 6], [4, 6], [4, 10]] } },
      { name: 'q_n', ends: ['g2.y', 'q_n', 'g1.b'], via: { 'g1.b': [[12, 8], [3, 8], [3, 4]] } },
    ],
  }),
  notes: `With <code>s_n = r_n = 1</code> each NAND simply inverts the other's output, so the pair
    has two stable states. Pulling <code>s_n</code> low forces <code>q = 1</code>; pulling
    <code>r_n</code> low forces <code>q = 0</code>. Pulling both low is "forbidden": both outputs go to 1,
    and releasing them together leaves a race.`,
  hdl: {
    verilog: `module sr_latch (input logic s_n, r_n, output logic q, q_n);
  nand2 g1 (.a(s_n), .b(q_n), .y(q));
  nand2 g2 (.a(q),   .b(r_n), .y(q_n));
endmodule`,
  },
});

/** Gated D latch: transparent while e = 1, holds while e = 0. */
export const D_LATCH: ComponentDef = define({
  id: 'd_latch', name: 'D latch', category: 'sequential',
  summary: 'While the enable is 1 the output follows D (transparent); when it drops to 0 the last value is held.',
  ports: [bit('d', 'in'), bit('e', 'in'), bit('q', 'out'), bit('q_n', 'out')],
  symbol: { kind: 'box', label: 'D latch' },
  netlist: () => ({
    pins: { d: [1, 3], e: [1, 8], q: [32, 4], q_n: [32, 6] },
    instances: [
      { name: 'inv', def: NOT, at: [3, 10] },
      { name: 'g1', def: NAND, at: [8, 2] },
      { name: 'g2', def: NAND, at: [8, 10] },
      { name: 'sr', def: SR_LATCH, at: [16, 2] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'g1.a', 'inv.a'] },
      { name: 'e', ends: ['e', 'g1.b', 'g2.b'], trunk: 7 },
      { name: 'd_n', ends: ['inv.y', 'g2.a'] },
      { name: 's_n', ends: ['g1.y', 'sr.s_n'] },
      { name: 'r_n', ends: ['g2.y', 'sr.r_n'] },
      { name: 'q', ends: ['sr.q', 'q'] },
      { name: 'q_n', ends: ['sr.q_n', 'q_n'] },
    ],
  }),
  hdl: {
    verilog: `module d_latch (input logic d, e, output logic q, q_n);
  logic d_n, s_n, r_n;
  not_n    inv (.a(d), .y(d_n));
  nand2    g1  (.a(d),   .b(e), .y(s_n));
  nand2    g2  (.a(d_n), .b(e), .y(r_n));
  sr_latch sr  (.s_n, .r_n, .q, .q_n);
endmodule`,
  },
});

/** Positive-edge master–slave D flip-flop: two latches enabled on opposite clock phases. */
export const DFF: ComponentDef = define({
  id: 'dff', name: 'D flip-flop', category: 'sequential',
  summary: 'Samples D at the rising clock edge and holds it for a whole cycle. Two D latches, master and slave, open on opposite clock phases.',
  ports: [bit('d', 'in'), bit('clk', 'in', 'left', true), bit('q', 'out')],
  symbol: { kind: 'box', label: 'DFF' },
  ff: { d: 'd', q: 'q', clk: 'clk' },
  netlist: () => ({
    pins: { d: [1, 3], clk: [1, 10], q: [38, 3] },
    instances: [
      { name: 'inv', def: NOT, at: [3, 9] },
      { name: 'master', def: D_LATCH, at: [9, 1] },
      { name: 'slave', def: D_LATCH, at: [23, 1] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'master.d'] },
      { name: 'clk', ends: ['clk', 'inv.a', 'slave.e'], via: { 'slave.e': [[2, 12], [21, 12], [21, 5]] } },
      { name: 'clk_n', ends: ['inv.y', 'master.e'] },
      { name: 'm', ends: ['master.q', 'slave.d'] },
      { name: 'q', ends: ['slave.q', 'q'] },
    ],
  }),
  notes: `While <code>clk = 0</code> the master is transparent and follows D, and the slave holds.
    At the rising edge the master closes, capturing D, and the slave opens and passes it on. D can
    never race straight through, because the two latches are never open at the same time.`,
  hdl: {
    verilog: `module dff_ms (input logic d, clk, output logic q);
  logic clk_n, m;
  not_n   inv    (.a(clk), .y(clk_n));
  d_latch master (.d(d), .e(clk_n), .q(m), .q_n());
  d_latch slave  (.d(m), .e(clk),   .q(q), .q_n());
endmodule

// Behaviourally, every synthesis tool understands:
//   always_ff @(posedge clk) q <= d;`,
  },
});

/** D flip-flop with load enable: a MUX feeds back q when en = 0. */
export const DFFE: ComponentDef = define({
  id: 'dffe', name: 'D flip-flop with enable', category: 'sequential',
  summary: 'Loads D on the clock edge only when en = 1; otherwise a multiplexer feeds the old value back in.',
  ports: [bit('d', 'in'), bit('en', 'in'), bit('clk', 'in', 'bottom', true), bit('q', 'out')],
  symbol: { kind: 'box', label: 'DFFE' },
  ff: { d: 'd', q: 'q', clk: 'clk', en: 'en' },
  netlist: () => ({
    pins: { d: [1, 5], en: [1, 8], clk: [1, 11], q: [25, 5] },
    instances: [
      { name: 'mux', def: MUX2, at: [5, 1] },
      { name: 'ff', def: DFF, at: [13, 2] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'mux.b'] },
      { name: 'en', ends: ['en', 'mux.s'] },
      { name: 'clk', ends: ['clk', 'ff.clk'], trunk: 11 },
      { name: 'next', ends: ['mux.y', 'ff.d'] },
      { name: 'q', ends: ['ff.q', 'q', 'mux.a'], via: { 'mux.a': [[22, 0], [3, 0], [3, 3]] } },
    ],
  }),
  hdl: {
    verilog: `module dffe (input logic d, en, clk, output logic q);
  logic next;
  mux2_n mux (.a(q), .b(d), .s(en), .y(next));
  dff_ms ff  (.d(next), .clk, .q);
endmodule`,
  },
});

/** n-bit register with load enable. */
export const register = memo((n: number): ComponentDef => {
  const P = 8, X = 10, Y0 = 3;
  const g = symbolGeom(DFFE);
  const instances: InstanceDef[] = [
    { name: 'sd', def: splitter(ones(n), P), at: [6, Y0 + g.ports.d.pos[1] - P / 2] },
    { name: 'mq', def: merger(ones(n), P), at: [X + g.w + 3, Y0 + g.ports.q.pos[1] - P / 2] },
  ];
  const nets: NetDef[] = [
    { name: 'd', ends: ['d', 'sd.in'] },
    { name: 'q', ends: ['mq.out', 'q'] },
  ];
  const en = ['en'], clk = ['clk'];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `ff${i}`, def: DFFE, at: [X, Y0 + P * i] });
    nets.push({ name: `d${i}`, ends: [`sd.o${i}`, `ff${i}.d`] });
    nets.push({ name: `q${i}`, ends: [`ff${i}.q`, `mq.i${i}`] });
    en.push(`ff${i}.en`);
    clk.push(`ff${i}.clk`);
  }
  const bottom = Y0 + P * n;
  nets.push({ name: 'en', ends: en, trunk: 8.5 });
  nets.push({ name: 'clk', ends: clk, trunk: X + g.w + 1.5 });
  const mid = (P * n) / 2;
  return define({
    id: `reg${n}`, name: `${n}-bit register`, category: 'sequential',
    summary: `${n} enable flip-flops sharing one clock and one enable: stores a ${n}-bit word.`,
    ports: [{ name: 'd', width: n, dir: 'in' }, bit('en', 'in'), bit('clk', 'in', 'bottom', true), { name: 'q', width: n, dir: 'out' }],
    symbol: { kind: 'box', label: `REG${n}` },
    netlist: () => ({
      pins: {
        d: [1, Y0 + g.ports.d.pos[1] - P / 2 + mid], en: [1, bottom + 1], clk: [1, bottom + 3],
        q: [X + g.w + 8, Y0 + g.ports.q.pos[1] - P / 2 + mid],
      },
      instances, nets,
    }),
    hdl: {
      verilog: `module register #(parameter int W = ${n}) (input logic [W-1:0] d, input logic en, clk,
                                         output logic [W-1:0] q);
  always_ff @(posedge clk) if (en) q <= d;
endmodule`,
    },
  });
});

/** n-bit counter: a register whose input is its own output plus one. */
export const counter = memo((n: number): ComponentDef => {
  const R = register(n), I = incrementer(n);
  const rg = symbolGeom(R), ig = symbolGeom(I);
  const rAt: [number, number] = [8, 2];
  const iAt: [number, number] = [8 + Math.round((rg.w - ig.w) / 2), 2 + rg.h + 5];
  const qy = rAt[1] + rg.ports.q.pos[1];
  const iy = iAt[1] + ig.ports.a.pos[1];
  const yy = iAt[1] + ig.ports.y.pos[1];
  return define({
    id: `counter${n}`, name: `${n}-bit counter`, category: 'sequential',
    summary: 'Counts clock edges while enabled. The register feeds an incrementer whose output loops back to the register\'s input.',
    ports: [bit('en', 'in'), bit('clk', 'in', 'bottom', true), { name: 'q', width: n, dir: 'out' }],
    symbol: { kind: 'box', label: `CNT${n}` },
    netlist: () => ({
      pins: { en: [1, rAt[1] + rg.ports.en.pos[1]], clk: [1, iAt[1] + ig.h + 3], q: [rAt[0] + rg.w + 10, qy] },
      instances: [
        { name: 'reg', def: R, at: rAt },
        { name: 'inc', def: I, at: iAt, flip: true },
      ],
      nets: [
        { name: 'q', ends: ['reg.q', 'q', 'inc.a'], via: { 'inc.a': [[rAt[0] + rg.w + 4, iy]] } },
        { name: 'next', ends: ['inc.y', 'reg.d'], via: { 'reg.d': [[4, yy], [4, rAt[1] + rg.ports.d.pos[1]]] } },
        { name: 'en', ends: ['en', 'reg.en'] },
        { name: 'clk', ends: ['clk', 'reg.clk'], via: { 'reg.clk': [[rAt[0] + rg.w + 6, iAt[1] + ig.h + 3], [rAt[0] + rg.w + 6, rAt[1] + rg.h + 2], [rAt[0] + rg.ports.clk.pos[0], rAt[1] + rg.h + 2]] } },
      ],
    }),
  });
});
