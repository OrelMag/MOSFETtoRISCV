// Level 1: logic gates built from NAND only (primer §2.4, hdl/gates.sv).

import type { ComponentDef } from '../sim/types';
import { define } from './define';
import { NAND } from './transistors';

const bit = (name: string, dir: 'in' | 'out') => ({ name, width: 1, dir });

export const NOT: ComponentDef = define({
  id: 'not', name: 'NOT', category: 'gate',
  summary: 'Inverter: a NAND with both inputs tied together. NAND(a, a) = NOT a.',
  ports: [bit('a', 'in'), bit('y', 'out')],
  symbol: { kind: 'not' },
  spec: ([a]) => [a ? 0 : 1],
  netlist: () => ({
    pins: { a: [1, 3], y: [11, 3] },
    instances: [{ name: 'g1', def: NAND, at: [4, 1] }],
    nets: [
      { name: 'a', ends: ['a', 'g1.a', 'g1.b'] },
      { name: 'y', ends: ['g1.y', 'y'] },
    ],
  }),
  hdl: {
    verilog: `module not_n (input logic a, output logic y);
  nand2 g1 (.a(a), .b(a), .y(y));
endmodule`,
  },
});

export const AND: ComponentDef = define({
  id: 'and', name: 'AND', category: 'gate',
  summary: 'NAND followed by NOT: two NANDs.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'and' },
  spec: ([a, b]) => [a & b],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 4], y: [17, 3] },
    instances: [
      { name: 'g1', def: NAND, at: [4, 1] },
      { name: 'g2', def: NAND, at: [11, 1] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'g1.a'] },
      { name: 'b', ends: ['b', 'g1.b'] },
      { name: 'n', ends: ['g1.y', 'g2.a', 'g2.b'] },
      { name: 'y', ends: ['g2.y', 'y'] },
    ],
  }),
  hdl: {
    verilog: `module and_n (input logic a, b, output logic y);
  logic n;
  nand2 g1 (.a(a), .b(b), .y(n));
  nand2 g2 (.a(n), .b(n), .y(y));
endmodule`,
  },
});

export const OR: ComponentDef = define({
  id: 'or', name: 'OR', category: 'gate',
  summary: "De Morgan: a + b = NOT(NOT a · NOT b). Invert both inputs, then NAND. Three NANDs.",
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'or' },
  spec: ([a, b]) => [a | b],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 8], y: [19, 5] },
    instances: [
      { name: 'g1', def: NAND, at: [4, 0] },
      { name: 'g2', def: NAND, at: [4, 6] },
      { name: 'g3', def: NAND, at: [12, 3] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'g1.a', 'g1.b'] },
      { name: 'b', ends: ['b', 'g2.a', 'g2.b'] },
      { name: 'na', ends: ['g1.y', 'g3.a'] },
      { name: 'nb', ends: ['g2.y', 'g3.b'] },
      { name: 'y', ends: ['g3.y', 'y'] },
    ],
  }),
  hdl: {
    verilog: `module or_n (input logic a, b, output logic y);
  logic na, nb;
  nand2 g1 (.a(a),  .b(a),  .y(na));
  nand2 g2 (.a(b),  .b(b),  .y(nb));
  nand2 g3 (.a(na), .b(nb), .y(y));
endmodule`,
  },
});

export const NOR: ComponentDef = define({
  id: 'nor', name: 'NOR', category: 'gate',
  summary: 'OR followed by NOT. Built from the gates above, so it is a box of boxes (4 NANDs).',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'nor' },
  spec: ([a, b]) => [a | b ? 0 : 1],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 4], y: [16, 3] },
    instances: [
      { name: 'or1', def: OR, at: [4, 1] },
      { name: 'not1', def: NOT, at: [10, 2] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'or1.a'] },
      { name: 'b', ends: ['b', 'or1.b'] },
      { name: 'o', ends: ['or1.y', 'not1.a'] },
      { name: 'y', ends: ['not1.y', 'y'] },
    ],
  }),
  hdl: {
    verilog: `module nor_n (input logic a, b, output logic y);
  logic o;
  or_n  or1  (.a(a), .b(b), .y(o));
  not_n not1 (.a(o), .y(y));
endmodule`,
  },
});

export const XOR: ComponentDef = define({
  id: 'xor', name: 'XOR', category: 'gate',
  summary: 'Exclusive OR: 1 when the inputs differ. The classic four-NAND circuit shares the first NAND.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'xor' },
  spec: ([a, b]) => [a ^ b],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 11], y: [27, 7] },
    instances: [
      { name: 'g1', def: NAND, at: [6, 4] },
      { name: 'g2', def: NAND, at: [13, 1] },
      { name: 'g3', def: NAND, at: [13, 8] },
      { name: 'g4', def: NAND, at: [20, 5] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'g2.a', 'g1.a'], trunk: 3 },
      { name: 'b', ends: ['b', 'g3.b', 'g1.b'], trunk: 4 },
      { name: 'm', ends: ['g1.y', 'g2.b', 'g3.a'] },
      { name: 'p', ends: ['g2.y', 'g4.a'] },
      { name: 'q', ends: ['g3.y', 'g4.b'] },
      { name: 'y', ends: ['g4.y', 'y'] },
    ],
  }),
  hdl: {
    verilog: `module xor_n (input logic a, b, output logic y);
  logic m, p, q;
  nand2 g1 (.a(a), .b(b), .y(m));
  nand2 g2 (.a(a), .b(m), .y(p));
  nand2 g3 (.a(b), .b(m), .y(q));
  nand2 g4 (.a(p), .b(q), .y(y));
endmodule`,
  },
});

export const XNOR: ComponentDef = define({
  id: 'xnor', name: 'XNOR', category: 'gate',
  summary: 'Equality of two bits: XOR followed by NOT.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('y', 'out')],
  symbol: { kind: 'xnor' },
  spec: ([a, b]) => [a ^ b ? 0 : 1],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 4], y: [16, 3] },
    instances: [
      { name: 'x1', def: XOR, at: [4, 1] },
      { name: 'not1', def: NOT, at: [10, 2] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'x1.a'] },
      { name: 'b', ends: ['b', 'x1.b'] },
      { name: 'x', ends: ['x1.y', 'not1.a'] },
      { name: 'y', ends: ['not1.y', 'y'] },
    ],
  }),
  hdl: {
    verilog: `module xnor_n (input logic a, b, output logic y);
  logic x;
  xor_n x1 (.a(a), .b(b), .y(x));
  not_n not1 (.a(x), .y(y));
endmodule`,
  },
});

export const MUX2: ComponentDef = define({
  id: 'mux2', name: '2:1 Multiplexer', category: 'routing',
  summary: 'A digital switch: y = s ? b : a. Four NANDs.',
  ports: [bit('a', 'in'), bit('b', 'in'), { name: 's', width: 1, dir: 'in', side: 'bottom' }, bit('y', 'out')],
  symbol: { kind: 'mux' },
  spec: ([a, b, s]) => [s ? b : a],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 8], s: [1, 14], y: [26, 6] },
    instances: [
      { name: 'g1', def: NAND, at: [5, 12] },
      { name: 'g2', def: NAND, at: [12, 1] },
      { name: 'g3', def: NAND, at: [12, 7] },
      { name: 'g4', def: NAND, at: [19, 4] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'g2.a'] },
      { name: 'b', ends: ['b', 'g3.a'] },
      { name: 's', ends: ['s', 'g1.a', 'g1.b', 'g3.b'], trunk: 3 },
      { name: 'ns', ends: ['g1.y', 'g2.b'], trunk: 10.5 },
      { name: 'p', ends: ['g2.y', 'g4.a'] },
      { name: 'q', ends: ['g3.y', 'g4.b'] },
      { name: 'y', ends: ['g4.y', 'y'] },
    ],
  }),
  hdl: {
    verilog: `// y = s ? b : a
module mux2_n (input logic a, b, s, output logic y);
  logic ns, p, q;
  nand2 g1 (.a(s), .b(s),  .y(ns));
  nand2 g2 (.a(a), .b(ns), .y(p));
  nand2 g3 (.a(b), .b(s),  .y(q));
  nand2 g4 (.a(p), .b(q),  .y(y));
endmodule`,
  },
});
