// Clock gating (the Power chapter): a register that is not being written does not need its clock. A bare AND of clk and
// en glitches when en changes while clk is high (codex "Never gate the clock"); the integrated clock gate (ICG) puts a
// latch in front of the AND, transparent while clk is low, so en may change in the low half and is frozen through the
// high half: the AND only ever passes whole clock pulses. gatedRegister(n) has register(n)'s pins and outline, so the
// register file and the memory take it in place of register(n) without moving a wire (regfile(…, gated), ram(…, gated)).
// Each bit is then a plain DFF: the load-enable mux of every DFFE is gone, the clock gate is one per register.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { define, merger, splitter } from './define';
import { AND, NOT } from './gates';
import { D_LATCH, DFF } from './sequential';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });

/**
 * Like a flip-flop's d, the gate's en must be steady from ICG_SETUP NAND delays before a rising edge (the latch needs that
 * long to settle before it closes) to ICG_HOLD after it (the inverted clock closes it one delay late): measured on GateSim,
 * tests/power-model.test.ts.
 */
export const ICG_SETUP = 4;
export const ICG_HOLD = 1;

/** The integrated clock gate: gclk = clk AND (en latched while clk is low). */
export const ICG: ComponentDef = define({
  id: 'icg', name: 'Clock gate (ICG)', category: 'sequential',
  summary: 'Passes the clock only while en is 1, never a piece of a pulse: a latch open while clk is low holds en through the high half, and an AND lets whole pulses through.',
  ports: [bit('en', 'in'), bit('clk', 'in', 'left', true), bit('gclk', 'out')],
  symbol: { kind: 'box', label: 'ICG' },
  netlist: () => ({
    pins: { en: [1, 3], clk: [1, 9], gclk: [30, 4] },
    instances: [
      { name: 'inv', def: NOT, at: [4, 7] },
      { name: 'latch', def: D_LATCH, at: [10, 1] },
      { name: 'and', def: AND, at: [24, 2] },
    ],
    nets: [
      { name: 'en', ends: ['en', 'latch.d'] },
      { name: 'clk', ends: ['clk', 'inv.a', 'and.b'], via: { 'and.b': [[3, 9], [3, 11], [22, 11], [22, 5]] } },
      { name: 'clk_n', ends: ['inv.y', 'latch.e'], via: { 'latch.e': [[8, 8], [8, 5]] } },
      { name: 'en_l', ends: ['latch.q', 'and.a'] },
      { name: 'gclk', ends: ['and.y', 'gclk'] },
    ],
  }),
  notes: `While <code>clk = 0</code> the latch follows <code>en</code>; at the rising edge it closes, so whatever <code>en</code> does
    while the clock is high cannot reach the AND. A bare <code>clk AND en</code> would let a change of <code>en</code> in the high half cut
    a pulse short (a runt) or start one late: a false edge for every flip-flop behind it.`,
  hdl: {
    verilog: `module icg (input logic en, clk, output logic gclk);
  logic en_l;
  always_latch if (!clk) en_l = en;   // transparent while the clock is low
  assign gclk = clk & en_l;
endmodule`,
  },
});

const cache = new Map<number, ComponentDef>();

/** n-bit register clocked through an ICG: register(n)'s pins and outline, plain DFFs, no enable mux. */
export function gatedRegister(n: number): ComponentDef {
  let d = cache.get(n);
  if (d) return d;
  const P = 8, X = 10, Y0 = 3;
  const g = symbolGeom(DFF), ig = symbolGeom(ICG);
  const F0 = Y0 + ig.h + 4; // the flip-flops start under the clock gate
  const ones = Array<number>(n).fill(1);
  const instances: InstanceDef[] = [
    { name: 'cg', def: ICG, at: [X, Y0] },
    { name: 'sd', def: splitter(ones, P), at: [6, F0 + g.ports.d.pos[1] - P / 2] },
    { name: 'mq', def: merger(ones, P), at: [X + g.w + 3, F0 + g.ports.q.pos[1] - P / 2] },
  ];
  const nets: NetDef[] = [
    { name: 'd', ends: ['d', 'sd.in'] },
    { name: 'q', ends: ['mq.out', 'q'] },
    { name: 'en', ends: ['en', 'cg.en'] },
    { name: 'clk', ends: ['clk', 'cg.clk'] },
  ];
  const gclk = ['cg.gclk'];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `ff${i}`, def: DFF, at: [X, F0 + P * i] });
    nets.push({ name: `d${i}`, ends: [`sd.o${i}`, `ff${i}.d`] }, { name: `q${i}`, ends: [`ff${i}.q`, `mq.i${i}`] });
    gclk.push(`ff${i}.clk`);
  }
  nets.push({ name: 'gclk', ends: gclk, trunk: X - 2 });
  const bottom = F0 + P * n, mid = (P * n) / 2;
  d = define({
    id: `greg${n}`, name: `${n}-bit register, clock-gated`, category: 'sequential',
    summary: `${n} D flip-flops clocked through one clock gate: the clock reaches them only in cycles with en = 1, so a register that keeps its value switches nothing inside.`,
    ports: [{ name: 'd', width: n, dir: 'in' }, bit('en', 'in'), bit('clk', 'in', 'bottom', true), { name: 'q', width: n, dir: 'out' }],
    symbol: { kind: 'box', label: `REG${n}` },
    netlist: () => ({
      pins: {
        d: [1, F0 + g.ports.d.pos[1] - P / 2 + mid], en: [1, Y0 + ig.ports.en.pos[1]], clk: [1, bottom + 3],
        q: [X + g.w + 8, F0 + g.ports.q.pos[1] - P / 2 + mid],
      },
      instances, nets,
    }),
    hdl: {
      verilog: `module gated_register #(parameter int W = ${n}) (input logic [W-1:0] d, input logic en, clk,
                                               output logic [W-1:0] q);
  logic gclk;
  icg cg (.en, .clk, .gclk);
  always_ff @(posedge gclk) q <= d;
endmodule`,
    },
  });
  cache.set(n, d);
  return d;
}
