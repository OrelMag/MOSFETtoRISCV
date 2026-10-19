// Examples ▸ The same adder in Verilog: the library's ripple-carry ADD4 beside a 4-bit adder written as one line of
// Verilog and drawn by Yosys (a Verilog chip, synthesized when the example opens), on the same inputs.

import { chipBox, Sheet } from './example6502';
import type { ChipDoc } from './model';

export const ADD4_SOURCE = `// The same 4-bit adder as the library's ripple-carry ADD4, as one line of
// Verilog: Yosys turns '+' into gates. Compare the two chips' NANDs
// (Inspect) and depth (Timing), then try "Gates: NAND" on the right.
module add4(
  input  [3:0] a, b,
  input        ci,
  output [3:0] s,
  output       co
);
  assign {co, s} = a + b + ci;
endmodule
`;

/** The Verilog chip, its pins in place so the example can wire it before Yosys has drawn it. */
export function add4VerilogChip(id: string, name: string): ChipDoc {
  return {
    id, name,
    pins: [
      { id: 'a', name: 'a', dir: 'in', width: 4, at: [0, 2] }, { id: 'b', name: 'b', dir: 'in', width: 4, at: [0, 4] },
      { id: 'ci', name: 'ci', dir: 'in', width: 1, at: [0, 6] },
      { id: 's', name: 's', dir: 'out', width: 4, at: [20, 2] }, { id: 'co', name: 'co', dir: 'out', width: 1, at: [20, 4] },
    ],
    parts: [], wires: [], labels: [],
    hdl: { module: 'add4', src: { file: 'add4.v', text: ADD4_SOURCE, gates: 'std' }, stale: true },
  };
}

export function sameAdderChip(id: string, name: string, sub: Record<string, string>, docs: Record<string, ChipDoc>): ChipDoc {
  const s = new Sheet();
  s.pin('a', 'in', [0, 6], 4); s.pin('b', 'in', [0, 12], 4); s.pin('ci', 'in', [0, 18]);
  s.pin('s_drawn', 'out', [48, 6], 4); s.pin('co_drawn', 'out', [48, 10]);
  s.pin('s_verilog', 'out', [48, 22], 4); s.pin('co_verilog', 'out', [48, 26]);
  s.part('drawn', { lib: 'rca4' }, [20, 4]);
  s.part('verilog', { chip: sub.add4 }, [20, 20], {}, chipBox(docs.add4));
  for (const p of ['a', 'b', 'ci']) s.tap(`pin:${p}`, p);
  s.tap('drawn.a', 'a'); s.tap('drawn.b', 'b'); s.tap('drawn.cin', 'ci');
  s.tap('verilog.a', 'a'); s.tap('verilog.b', 'b'); s.tap('verilog.ci', 'ci');
  s.tap('drawn.s', 'sum_drawn'); s.tap('pin:s_drawn', 'sum_drawn');
  s.tap('drawn.cout', 'carry_drawn'); s.tap('pin:co_drawn', 'carry_drawn');
  s.tap('verilog.s', 'sum_verilog'); s.tap('pin:s_verilog', 'sum_verilog');
  s.tap('verilog.co', 'carry_verilog'); s.tap('pin:co_verilog', 'carry_verilog');
  return s.doc(id, name, {
    notes: 'One 4-bit adder twice on the same inputs: the library\'s ripple-carry ADD4 (four full adders, drawn by hand) and '
      + `${docs.add4.name}, written as "assign {co, s} = a + b + ci;" and drawn by Yosys from the library's gates. Both give the same sums. `
      + 'Double-click either to open it; select one and Inspect for its NANDs, or open Timing for its depth. '
      + `Open ${docs.add4.name} to edit its text: a second after you stop typing, Yosys draws it again.`,
  });
}
