// Codex entries for the FPGA chapter (chapters/ch-fpga.ts). Same shape as codex.ts, appended to CODEX there; the fuller
// texts are codexmorefpga.ts, the questions codexcheckfpga.ts. Every number is the chapter's own (src/fpga/facts.ts, from the
// library and fpgacosts.json), pinned by tests/fpga-chapter.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_FPGA: CodexEntry[] = [
  E('lut', 'Look-up table (LUT)', 'component', 'A k-input look-up table is a memory of 2<sup>k</sup> bits read by its inputs: the inputs are the address and the bit stored there is the output, so it computes any function of k inputs. A LUT4 is 16 configuration bits and a 16:1 multiplexer of fifteen 2:1 muxes, 60 NANDs. Configured 0x8000 it is a four-input AND, 0x6666 the XOR of its two low inputs. Its cost does not depend on the function, only on k: a LUT6 is 64 bits and 252 NANDs.', ['fpga', 'mux', 'logiccell']),
  E('fpga', 'FPGA', 'concept', 'A field-programmable gate array: look-up tables, flip-flops, block RAMs and routing switches whose function is set by configuration bits loaded at power-on. Our RISC-V computer on a GW1NR-9 takes 5271 of its 8640 LUTs, 1178 flip-flops and 10 of 26 block RAMs, and its slowest register-to-register path allows 24.4 MHz. A new bitstream makes it another circuit the same day; the price is area and speed against a custom chip.', ['lut', 'bitstream', 'bram', 'stdcell']),
  E('bitstream', 'Configuration bitstream', 'concept', 'The bits that turn an FPGA into a circuit: every LUT\'s table, every routing switch, each cell\'s mode, the block RAMs\' contents. The GW1NR-9\'s is written in frames of 2904 bits: 712 frames for the fabric, 2 067 648 bits, of which the LUT tables are only 138 240 (7 %); the rest sets the routing, the modes and the clocks. Our computer\'s adds 512 frames for its memories\' contents, the program among them.', ['fpga', 'lut', 'switchbox']),
  E('bram', 'Block RAM', 'component', 'A real memory array among an FPGA\'s cells, read through a register on a clock edge: the GW1NR-9 has 26 of 16 Kbit. Our 4K × 32 RAM takes 8 of them; in flip-flops its 131 072 bits would be 20 times all the chip has. A memory read on several ports in the same cycle does not fit one: the register file, two reads and a write, stays in 992 flip-flops and 1999 LUTs.', ['sram', 'regfile', 'fpga']),
  E('logiccell', 'Logic cell', 'component', 'What sits around an FPGA\'s LUT: a flip-flop on its output, so a register costs no extra cell, and a dedicated carry chain, a multiplexer that passes the carry to the next cell without a LUT or the routing. In adder mode the LUT makes the propagate p = a XOR b, the sum is p XOR cin, and the carry out is cin when p = 1, else a. The tools use the chain only where they see an adder: our NAND adders were mapped gate by gate, and the 24 carry cells our computer uses are the board\'s clock divider.', ['lut', 'ripple', 'dff']),
  E('switchbox', 'Switch box', 'component', 'Where an FPGA\'s routing tracks meet: a pass switch between pairs of tracks, each a transmission gate (an NMOS and a PMOS, on together) held by one configuration bit. A connection is a path of tracks through closed switches, and each adds resistance while every open one still loads the track. On our computer\'s slowest path routing took 23.7 ns of 40.9, logic 13.1: on an FPGA the wires set the clock.', ['fpga', 'bitstream', 'criticalpath']),
];

/** Entries no campaign level teaches yet: the test that wants every entry in a level skips them (tests/campaign.test.ts). */
export const FPGA_AWAITING_LEVELS: ReadonlySet<string> = new Set(CODEX_FPGA.map((e) => e.id).filter((id) => id !== 'lut'));

/** Other names the entries go by in the prose (glossary.ts ALIASES). */
export const ALIASES_FPGA: Record<string, string[]> = {
  fpga: ['field-programmable gate array'], bitstream: ['bitstream'], bram: ['BSRAM'], switchbox: ['routing switch'],
};
