// The FPGA chapter's measured numbers (scripts/fpga-pnr.ts → fpgacosts.json, checked in): what Yosys and nextpnr made
// of the sandbox's FPGA export of each example on the Tang Nano 9K, beside our own estimates. DOM-free.

import type { FpgaFile } from '../editor/fpga';

export interface Use { used: number; available: number }

export interface FpgaExample {
  /** The export's files hashed: tests/fpgacosts.test.ts fails when the export changed and the numbers were not measured again. */
  exportHash: string;
  /** After place and route. */
  device: { lut4: Use; alu: Use; dff: Use; bsram: Use };
  /** LUTs as Yosys left them (LUT1–LUT4 cells), after packing (ALU cells take LUT slots too), after routing (device.lut4); passthrough: the routed ones the
   *  placer inserted in front of a flip-flop whose D input does not come from the LUT beside it in its slice (named *_passthrough_lut). */
  lut4Stages: { synth: number; packed: number; routed: number; passthrough: number };
  /** By block (dut.<block> and dut.<block>.<part>, by the names Yosys keeps; board: the board top's glue), largest first. */
  blocks: { name: string; luts: number; ffs: number; bsram: number }[];
  /** Post-route maximum frequency per clock, MHz (clk: the design's, divided from the board's; mem_clk: the board's 27 MHz). */
  fmax: Record<string, number>;
  /** The design clock's critical path, ns, split by kind; luts: the LUTs on it. */
  critical: { clock: string; ns: number; skew: number; clkToQ: number; logic: number; routing: number; setup: number; luts: number };
  /** Our estimates: NANDs (mapped + kept as storage loops), lutMap's LUT4 count and levels, the static period in NAND delays. */
  ours: { nands: number; lutMapLuts: number; lutLevels: number; period: number | null };
}

export interface FpgaCosts {
  board: string;
  device: string;
  tools: { yosys: string; nextpnr: string };
  examples: Record<string, FpgaExample>;
}

/** FNV-1a over the export's file names and texts. */
export function exportHash(files: readonly FpgaFile[]): string {
  let h = 0x811c9dc5;
  for (const f of files) for (const s of [f.name, '\0', f.text, '\0']) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
