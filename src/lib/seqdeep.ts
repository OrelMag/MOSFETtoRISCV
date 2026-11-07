// Chapter 8's deeper steps: the 74-series edge-triggered flip-flop (six gates, one of them a 3-input NAND) and a
// pair of flip-flops whose second clock arrives late (clock skew), the circuit that breaks a shift register.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { define } from './define';
import { NOT } from './gates';
import { NAND3 } from './seqparts';
import { DFF } from './sequential';
import { NAND } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });

/**
 * The positive-edge D flip-flop of the 7474: three cross-coupled pairs of gates, n1 / n2 / n3 / n4 the "front end"
 * that decides, q / q_n the output latch. Five 2-input NANDs and one 3-input NAND (three more NANDs on our brick).
 * Wired as in the TTL data sheet:
 *   n1 = ¬(n4 · n2)   n2 = ¬(n1 · clk)   n3 = ¬(n2 · clk · n4)   n4 = ¬(n3 · d)   q = ¬(n2 · q_n)   q_n = ¬(q · n3)
 */
export const DFF_EDGE6: ComponentDef = define({
  id: 'dff_edge6', name: 'D flip-flop (six gates)', category: 'sequential',
  summary: 'The 7474 edge-triggered flip-flop: six NAND gates, no inverter and no master / slave pair. Samples d at the rising edge of clk.',
  ports: [bit('d', 'in'), bit('clk', 'in', 'left', true), bit('q', 'out'), bit('q_n', 'out')],
  symbol: { kind: 'box', label: 'DFF 6' },
  ff: { d: 'd', q: 'q', clk: 'clk' },
  powerOn: { q: 0, q_n: 1 },
  netlist: () => {
    const b = new Builder(20, 12, 4);
    b.pins('d', 'clk');
    const n4 = b.add(NAND, 'n4', 'n4');
    const n1 = b.add(NAND, 'n1', 'n1');
    b.next();
    const n3 = b.add(NAND3, 'n3', 'n3');
    const n2 = b.add(NAND, 'n2', 'n2');
    b.next();
    const q = b.add(NAND, 'q', 'gq');
    const qn = b.add(NAND, 'q̄', 'gqn');
    b.wire('n3.y', `${n4}.a`); b.wire('d', `${n4}.b`);
    b.wire(`${n4}.y`, `${n1}.a`); b.wire('n2.y', `${n1}.b`);
    b.wire(`${n1}.y`, `${n2}.a`); b.wire('clk', `${n2}.b`);
    b.wire(`${n2}.y`, `${n3}.a`); b.wire('clk', `${n3}.b`); b.wire(`${n4}.y`, `${n3}.c`);
    b.wire(`${n2}.y`, `${q}.a`); b.wire(`${qn}.y`, `${q}.b`);
    b.wire(`${q}.y`, `${qn}.a`); b.wire(`${n3}.y`, `${qn}.b`);
    b.wire(`${q}.y`, 'q'); b.wire(`${qn}.y`, 'q_n');
    for (const [drv, nm] of [['n1.y', 'n1'], ['n2.y', 'n2'], ['n3.y', 'n3'], ['n4.y', 'n4'], ['gq.y', 'q'], ['gqn.y', 'q_n']]) b.name(drv, nm, true);
    return { pins: { d: [1, 5], clk: [1, 14], q: [b.right + 2, 4], q_n: [b.right + 2, 12] }, instances: b.instances, nets: b.nets() };
  },
  hdl: {
    verilog: `module dff_edge6 (input logic d, clk, output logic q, q_n);
  logic n1, n2, n3, n4;
  assign n1 = ~(n4 & n2);
  assign n2 = ~(n1 & clk);
  assign n3 = ~(n2 & clk & n4);
  assign n4 = ~(n3 & d);
  assign q   = ~(n2 & q_n);
  assign q_n = ~(q & n3);
endmodule`,
  },
});

/** One buffer of the clock tree: two inverters, two gate delays. */
function bufferOf(): ComponentDef {
  return define({
    id: 'clkbuf2', name: 'Clock buffer', category: 'gate',
    summary: 'Two inverters in a row: the signal arrives two NAND delays later and unchanged. What a clock tree is made of.',
    ports: [bit('a', 'in'), bit('y', 'out')],
    symbol: { kind: 'box', label: 'BUF' },
    spec: ([a]) => [a],
    netlist: () => ({
      pins: { a: [0, 2], y: [14, 2] },
      instances: [{ name: 'i1', def: NOT, at: [2, 1] }, { name: 'i2', def: NOT, at: [8, 1] }],
      nets: [{ ends: ['a', 'i1.a'] }, { ends: ['i1.y', 'i2.a'] }, { ends: ['i2.y', 'y'] }],
    }),
  });
}
export const CLK_BUF = bufferOf();

const skewCache = new Map<number, ComponentDef>();
/**
 * Two flip-flops in a shift register, q1 → d of the second, with the second one's clock arriving through k buffers
 * (2k gate delays late). Nothing sits between q1 and d2, so the path is clk-to-q alone: the hold check at its barest.
 */
export function skewPair(k: number): ComponentDef {
  let d = skewCache.get(k);
  if (d) return d;
  // Drawn by hand: q1 leaves over the top to its pin (it also feeds the second flip-flop straight on), the clock runs
  // under the first flip-flop into the buffers and on to the second. Builder would make both pointers (several sinks /
  // driven by a pin), two units from their partners.
  const X2 = Math.max(22, 12 + 8 * k + 2), R = X2 + 14;
  const instances: InstanceDef[] = [{ name: 'ff1', def: DFF, at: [6, 1], label: 'ff1' }];
  for (let i = 0; i < k; i++) instances.push({ name: `cb${i}`, def: CLK_BUF, at: [8 + 8 * i, 8], label: `buffer ${i + 1}` });
  instances.push({ name: 'ff2', def: DFF, at: [X2, 2], label: 'ff2' }); // its d level with ff1's q
  const clk2 = k ? `cb${k - 1}.y` : 'clk';
  const nets: NetDef[] = [
    { name: 'd', ends: ['d', 'ff1.d'] },
    { name: 'q1', ends: ['ff1.q', 'ff2.d', 'q1'], via: { q1: [[16, 4], [16, -2]] } },
    { name: 'q2', ends: ['ff2.q', 'q2'] },
    k ? { name: 'clk', ends: ['clk', 'ff1.clk', 'cb0.a'], via: { 'ff1.clk': [[4, 10], [4, 5]] } }
      : { name: 'clk', ends: ['clk', 'ff1.clk', 'ff2.clk'], via: { 'ff1.clk': [[4, 10], [4, 5]], 'ff2.clk': [[X2 - 2, 10], [X2 - 2, 6]] } },
    ...Array.from({ length: Math.max(0, k - 1) }, (_, i): NetDef => ({ ends: [`cb${i}.y`, `cb${i + 1}.a`] })),
    ...(k ? [{ name: 'clk2', ends: [clk2, 'ff2.clk'], via: { 'ff2.clk': [[X2 - 2, 10], [X2 - 2, 6]] } } as NetDef] : []),
  ];
  d = define({
    id: `skewpair${k}`, name: `Two flip-flops, clock ${2 * k} delays late`, category: 'sequential',
    summary: `Flip-flop 1 feeds flip-flop 2 directly; flip-flop 2 is clocked through ${k} buffer${k === 1 ? '' : 's'} (${2 * k} NAND delays later).`,
    ports: [bit('d', 'in'), bit('clk', 'in', 'left', true), bit('q1', 'out'), bit('q2', 'out')],
    symbol: { kind: 'box', label: 'SKEW' },
    netlist: () => ({ pins: { d: [0, 3], clk: [0, 10], q1: [R, -2], q2: [R, 5] }, instances, nets }),
  });
  skewCache.set(k, d);
  return d;
}
