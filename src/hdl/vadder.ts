// The Verilog adder of chapter "Faster adders"' last step: the source, and the NAND netlist Yosys made from it, checked in
// (vadder.net.json) so the step draws without fetching Yosys's 78 MB. tests/vadder.test.ts runs Yosys and holds the file equal
// to its output; `vite-node scripts/vadder-netlist.ts` rewrites it. Each `(* keep *)` wire is one line of the recipe, and the
// wires are what srcmap.ts maps gates back to: the same adder as `assign {co, s} = a + b + ci;` has one line to blame.

export const VADDER_TOP = 'add4';

export const VADDER_SOURCE = `// A 4-bit adder, one line per step of the generate / propagate recipe.
module add4(
  input  [3:0] a, b,
  input        ci,
  output [3:0] s,
  output       co
);
  (* keep *) wire [3:0] p = a ^ b;
  (* keep *) wire [3:0] g = a & b;
  (* keep *) wire c1 = g[0] | (p[0] & ci);
  (* keep *) wire c2 = g[1] | (p[1] & c1);
  (* keep *) wire c3 = g[2] | (p[2] & c2);
  (* keep *) wire c4 = g[3] | (p[3] & c3);
  (* keep *) wire [3:0] sum = p ^ {c3, c2, c1, ci};
  assign {co, s} = {c4, sum};
endmodule
`;
