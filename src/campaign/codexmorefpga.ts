// The fuller codex texts for the FPGA chapter's entries (codexfpga.ts). Numbers are the chapter's, pinned by
// tests/fpga-chapter.test.ts.

import type { CodexMore } from './codexmore';

const at = (step: number, label: string) => ({ chapter: 'fpga', step, label });

export const MOREFPGA: Record<string, CodexMore> = {
  lut: {
    idea: `A truth table of k inputs has 2<sup>k</sup> rows. Store the output column in 2<sup>k</sup> bits and let the inputs select one: that is a <b>look-up table</b>, a tiny ROM whose contents are the function. Change the bits and it computes another function, with the same hardware and the same delay.`,
    example: {
      title: 'Programming a LUT4',
      body: `<pre>address = d c b a     (a the lowest bit)
a AND b AND c AND d   → only address 15 is 1   → 0x8000
a XOR b               → 1 where a ≠ b          → 0x6666
a OR b OR c OR d      → 1 everywhere but 0      → 0xFFFE</pre>Write the output column, bit 0 first, and read it as a 16-bit number.`,
    },
    mistakes: [
      'Counting gates inside a LUT: a LUT costs the same whatever it computes; only its number of inputs matters.',
      'Thinking bigger LUTs are always better: each extra input doubles the bits and the multiplexer (60 NANDs at k = 4, 252 at k = 6) to save fewer and fewer LUTs.',
    ],
    lib: 'lut4', compare: ['lut2', 'full_adder'],
    chapters: [at(1, 'A look-up table is a memory'), at(2, 'Any function of four inputs'), at(3, 'Covering a netlist with LUTs')],
  },
  fpga: {
    idea: `An <b>FPGA</b> is a chip of uncommitted parts: thousands of look-up tables and flip-flops, some block RAMs, and a mesh of tracks joined by switches. Configuration bits, loaded when it powers on, fill the tables and close the switches, and from then on it is a circuit like any other, every part working at once.`,
    example: {
      title: 'Our computer on a Tang Nano 9K',
      body: `<pre>LUT4          5271 of 8640   (61 %)
flip-flops    1178
block RAM       10 of 26     (RAM 8, ROM 2)
slowest path  40.9 ns → 24.4 MHz (routing 58 %)</pre>The same Verilog the sandbox exports, through Yosys and nextpnr.`,
    },
    mistakes: [
      'Calling Verilog a program the FPGA runs: nothing is executed; the bitstream sets switches once and the result is hardware.',
      'Expecting a custom chip\'s speed: the same logic in LUTs and programmable wires is several times slower and tens of times larger.',
    ],
    chapters: [at(0, 'Hardware you can rewrite'), at(6, 'Our computer on a Tang Nano 9K'), at(8, 'FPGA, custom chip or processor?')],
  },
  bitstream: {
    idea: `Everything that makes an FPGA one circuit and not another is a bit: a LUT's table entry, a routing switch, a cell's mode, a memory word's initial value. The tools write them all into one file, the <b>bitstream</b>, which the chip reads from flash at power-on. Loading another is rebuilding the hardware.`,
    example: {
      title: 'Where the bits go on the GW1NR-9',
      body: `<pre>frame                        2904 bits
fabric (the counter)          712 frames = 2 067 648 bits
  of which LUT tables        138 240 bits (7 %)
our computer                 1224 frames (+512: memory contents)</pre>Most of the bitstream is routing, not logic.`,
    },
    mistakes: [
      'Thinking the bitstream is mostly logic: the LUT tables are a small share; the switches between them are most of it.',
      'Expecting a small design to give a small bitstream: the fabric\'s frames are written whole, used or not.',
    ],
    chapters: [at(0, 'Hardware you can rewrite'), at(6, 'Our computer on a Tang Nano 9K')],
  },
  bram: {
    idea: `Memories built from LUTs and flip-flops run out fast: a flip-flop per bit, multiplexers to read them. So FPGAs carry <b>block RAMs</b>, real SRAM arrays beside the logic, a few dozen of them. They read through a register on a clock edge, so a design whose memories answer within the cycle needs a second, faster memory clock, as our export adds.`,
    example: {
      title: 'Our computer\'s memories',
      body: `<pre>RAM  4K × 32 = 131 072 bits → 8 blocks of 16 Kbit of data
ROM  1K × 32 =  32 768 bits → 2 blocks
register file 31 × 32       → 992 flip-flops, 1999 LUTs</pre>The register file is read twice and written once in a cycle: one block RAM cannot do that.`,
    },
    mistakes: [
      'Expecting every memory in the Verilog to become block RAM: too many ports, an asynchronous read or a constant word keeps it in the fabric.',
      'Forgetting the read register: a block RAM\'s data comes a clock edge after the address.',
    ],
    chapters: [at(6, 'Our computer on a Tang Nano 9K')],
  },
  logiccell: {
    idea: `A LUT alone would spend a whole cell on every register and a LUT level on every carry. So each <b>logic cell</b> pairs its LUT with a flip-flop and with a carry multiplexer wired straight to the next cell. An n-bit adder becomes n cells with the carry rippling through n multiplexers, never through the routing.`,
    example: {
      title: 'One bit of an adder in a cell',
      body: `<pre>LUT    p    = a XOR b        (cfg 0x6666)
sum    y    = p XOR cin
carry  cout = p ? cin : a</pre>a = b = 1, cin = 1: p = 0, y = 1, cout = a = 1.`,
    },
    mistakes: [
      'Expecting any adder to use the chain: the tools find it in a + b, not in a netlist of NANDs, which they map to LUTs gate by gate.',
      'Giving a register its own LUT: the flip-flop after the LUT is free; a pass-through LUT appears only when nothing else feeds it.',
    ],
    lib: 'fpga_slice',
    chapters: [at(4, 'The logic cell')],
  },
  switchbox: {
    idea: `An FPGA's wiring is made, not drawn: tracks run between the cells and a <b>switch box</b> at each crossing can join any pair through a switch held by a configuration bit (in our model a transmission gate). The router picks which to close. Every switch on a path adds resistance and every open one adds capacitance, which is why routing, not logic, sets an FPGA's clock.`,
    example: {
      title: 'Our computer\'s slowest path',
      body: `<pre>routing   23.7 ns  (58 %)
logic     13.1 ns  (8 LUT4s, 20 wide multiplexers)
skew       3.3 ns
total     40.9 ns  → 24.4 MHz</pre>`,
    },
    mistakes: [
      'Using a plain NMOS as the switch: it passes a weak 1. A transmission gate passes the 1 fully; parts that do use one NMOS drive its gate above VDD or restore the level after it.',
      'Reading LUT levels as the delay: the trip between LUTs often costs more than the LUTs.',
    ],
    chapters: [at(5, 'The wires are switches'), at(7, 'Timing: the estimate against the tool')],
  },
};
