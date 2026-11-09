// The FPGA chapter's parts (docs/PLAN-FPGA.md): a look-up table is a memory (2^k configuration bits) read by a mux tree
// whose select is the LUT's k inputs; the logic cell around it adds a carry chain and a flip-flop; a routing switch is
// a transmission gate held on by one configuration bit. Configuration bits are input pins here (a scene sets them, or
// a mapped netlist ties them): an FPGA loads them from its bitstream at power-on.

import { Builder } from './builder';
import { muxTree } from './combinational';
import { define, ones, splitter } from './define';
import { MUX2, XOR } from './gates';
import { DFF } from './sequential';
import { TGATE } from './switchparts';
import { INV_CMOS } from './transistors';
import type { ComponentDef, PortDef } from '../sim/types';

const luts = new Map<number, ComponentDef>();
const bus = (name: string, width: number, dir: 'in' | 'out' | 'inout', clock = false): PortDef => ({ name, width, dir, ...(clock ? { clock } : {}) });

/**
 * A k-input look-up table: y = cfg[i]. The 2^k configuration bits are the truth table, input i (bit 0 = input 0) the
 * address. Inside: a splitter and muxTree(k, 1), 2^k − 1 two-input multiplexers in k levels.
 */
export function lut(k: number): ComponentDef {
  if (!Number.isInteger(k) || k < 1 || k > 6) throw new Error(`lut(${k}): 1 … 6 inputs`);
  const known = luts.get(k);
  if (known) return known;
  const N = 2 ** k;
  const b = new Builder(10, 12, 4);
  b.pins('i', 'cfg');
  const s = b.op(splitter(ones(N), 2), ['cfg'], 'configuration');
  b.next();
  const m = b.op(muxTree(k, 1), [...Array.from({ length: N }, (_, j) => `${s}.o${j}`), 'i'], `${N}:1 mux`);
  b.wire(`${m}.y`, 'y');
  const R = b.right;
  const d = define({
    id: `lut${k}`, name: `${k}-input look-up table`, category: 'routing',
    summary: `Any function of ${k} inputs: ${N} configuration bits hold its truth table, and the inputs, as the select of a ${N}:1 multiplexer, pick one. The FPGA's logic cell: what it computes is data, not wiring.`,
    ports: [bus('i', k, 'in'), bus('cfg', N, 'in'), bus('y', 1, 'out')],
    symbol: { kind: 'box', label: `LUT${k}` },
    // packed inputs are exact to 53 bits: a 6-input LUT's 64 configuration bits are not, so it has no spec (its tests simulate)
    ...(k <= 5 ? { spec: ([i, cfg]: number[]) => [Math.floor(cfg / 2 ** i) % 2] } : {}),
    netlist: () => ({ pins: { cfg: [0, 4], i: [0, Math.max(10, b.height - 2)], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
  luts.set(k, d);
  return d;
}

export const LUT2 = lut(2), LUT4 = lut(4);

/**
 * The logic cell: a LUT4, a carry chain and a flip-flop. arith = 0: f = the LUT; arith = 1: the LUT computes the
 * propagate p (a ⊕ b for an adder on i0, i1), f = p ⊕ cin, cout = p ? cin : i0 (where a = b, the carry is a). reg
 * picks the flip-flop's output (f taken at the rising clk edge) or f itself.
 */
export const SLICE: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins('i', 'cfg', 'cin', 'arith', 'reg', 'clk');
  const p = b.name(b.op1(LUT4, ['i', 'cfg'], 'LUT4'), 'p', true);
  const ii = b.op(splitter([1, 3], 2), ['i'], 'i0');
  b.next();
  const sum = b.op1(XOR, [p, 'cin'], 'p ⊕ cin');
  const cout = b.op1(MUX2, [`${ii}.o0`, 'cin', p], 'carry');
  b.next();
  const f = b.name(b.op1(MUX2, [p, sum, 'arith'], 'arith?'), 'f', true);
  b.next();
  const q = b.op1(DFF, [f, 'clk'], 'flip-flop');
  b.next();
  b.wire(b.op1(MUX2, [f, q, 'reg'], 'registered?'), 'y');
  b.wire(cout, 'cout');
  const R = b.right;
  return define({
    id: 'fpga_slice', name: 'FPGA logic cell (LUT4, carry, flip-flop)', category: 'routing',
    summary: 'A LUT4 with a carry chain and a flip-flop beside it: in arithmetic mode the LUT makes the propagate signal and the chain the carry, one cell per bit; a registered output costs no second cell.',
    ports: [bus('i', 4, 'in'), bus('cfg', 16, 'in'), bus('cin', 1, 'in'), bus('arith', 1, 'in'), bus('reg', 1, 'in'), bus('clk', 1, 'in', true), bus('y', 1, 'out'), bus('cout', 1, 'out')],
    symbol: { kind: 'box', label: 'SLICE' },
    netlist: () => ({
      pins: { i: [0, 4], cfg: [0, 8], cin: [0, 12], arith: [0, 16], reg: [0, 20], clk: [0, 24], y: [R, 6], cout: [R, 12] },
      instances: b.instances, nets: b.nets(),
    }),
  });
})();

/**
 * A routing switch at switch level: a transmission gate between two wires, on while its configuration bit is 1 (an
 * inverter makes the PMOS's gate). Four transistors and one stored bit per point where two tracks may meet.
 */
export const ROUTE_SWITCH: ComponentDef = (() => {
  return define({
    id: 'route_switch', name: 'Routing switch', category: 'routing',
    summary: 'Two FPGA wires joined while one configuration bit is 1: a transmission gate (two transistors) and an inverter for its PMOS gate. An FPGA has hundreds of thousands of them, which is where most of its area and delay go.',
    ports: [bus('a', 1, 'inout'), bus('b', 1, 'inout'), bus('cfg', 1, 'in')],
    symbol: { kind: 'box', label: 'SW' },
    netlist: () => ({
      level: 'switch',
      pins: { cfg: [0, 12], a: [0, 4], b: [36, 4] },
      instances: [
        { name: 'inv', def: INV_CMOS, at: [6, 10], label: 'cfg̅' },
        { name: 'tg', def: TGATE, at: [14, 0] },
      ],
      nets: [
        { name: 'a', ends: ['a', 'tg.a'] },
        { name: 'b', ends: ['tg.b', 'b'] },
        { name: 'cfg', ends: ['cfg', 'inv.a', 'tg.en'] },
        { name: 'cfg_n', ends: ['inv.y', 'tg.en_n'] },
      ],
    }),
  });
})();
