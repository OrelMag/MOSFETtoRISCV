// The fuller texts of the entries added with the codex's reading order (codexnew.ts, after the GPU's memory): the
// pipeline register, the clock and its period, reset, the floating-point adder assembled, the tri-state bus and binary
// to decimal. Every number is measured (tests/content-codexease.test.ts pins them). No DOM.

import type { CodexMore } from './codexmore';

export const MORE3: Record<string, CodexMore> = {
  preg: {
    idea: 'A pipeline cuts the single-cycle datapath into stages and puts a register across every cut: five stages, four boundaries, F/D, D/E, E/M and M/W. Each carries forward everything the later stages need of its instruction: the fields, the immediate, the control signals, the PC where a branch needs it. On every edge each instruction moves one stage on, and each stage works on its own instruction.<br>Two inputs let the hazard unit steer the flow. <b>en</b> = 0 holds the register: the stage keeps its instruction (a stall). <b>clr</b> = 1 loads zeros: all-zero control bits write no register, store nothing and branch nowhere, so the stage holds a bubble (a flush, or the empty slot behind a stall). When both arrive, clr wins: a flush must not be lost to a stall. rv16_preg builds it from the 16-bit register with enable, a bus mux that picks 0 when clr = 1, and an OR so that clr also loads.',
    example: { title: 'rv16_preg, part by part', body: '<pre>16-bit register with enable   208\nbus mux: d or 0 (clr)          49\nOR: load when en or clr         3\npipeline register             260 NANDs, period 8</pre>The mux and the OR add a quarter to the register and nothing to the period: the clear rides on the enable path the register had anyway.' },
    mistakes: [
      'Clearing only the opcode field and leaving the write enables on: the bubble still writes its rd or stores. Clear the control bits that act.',
      'Stalling every stage: only the stages behind the hazard hold; the one after it must take a bubble, or the instruction ahead waits for itself.',
      'Giving en priority over clr: a flush that arrives during a stall is lost, and the wrong-path instruction runs.',
    ],
    lib: 'rv16_preg',
    compare: ['rv16_reg16'],
    chapters: [{ chapter: 'pipeline', step: 1, label: 'Pipeline registers' }, { chapter: 'pipeline', step: 3, label: 'The load-use stall' }],
  },
  clock: {
    idea: 'A synchronous design changes state only at the rising edge of one square wave, the clock: every flip-flop samples its input there and holds its output until the next. Between two edges every path from a register\'s output through logic to a register\'s input must settle, so the <b>period</b> T has to cover the longest such path: T ≥ clk-to-q + logic + setup. The site counts in NAND delays: a flip-flop\'s output 3 delays after the edge, its input 3 delays before the next one, whatever lies between as the static timing finds it.<br>The frequency is 1 / T, and every design here reports its period: the longest register-to-register path, which the Timing panel draws. Two ways make it shorter: less logic on the path (a faster adder) or a register in the middle of it (a pipeline stage). A faster clock also costs power, every node that toggles switching more often (P = αCV²f).',
    example: { title: 'The program counter\'s period', body: '<pre>clk-to-q (the PC register)     3\nincrementer and muxes        35\nsetup (back into it)          3\nperiod                       41 NAND delays\nat 25 ps a NAND delay   1.025 ns: about 976 MHz</pre>25 ps is the site\'s illustrative figure for a loaded NAND2 in a 28 nm-class process.' },
    mistakes: [
      'Adding up the depths of every block: the period is the longest single path from one register to the next, not the sum of the parts.',
      'Forgetting clk-to-q and setup: a register that feeds itself through 2 delays of logic (rv16_reg16, its enable mux) still needs 3 + 2 + 3 = 8.',
      'Slowing the clock to fix a hold violation: hold is a race right after one edge, whatever the period (Setup and hold).',
    ],
    lib: 'rv16_pc',
    chapters: [{ chapter: 'latches', step: 3, label: 'The flip-flop: act only on the edge' }, { chapter: 'fastadd', step: 7, label: 'Static timing on our CPU' }, { chapter: 'fastadd', step: 8, label: 'Overclock it' }],
  },
  reset: {
    idea: 'A flip-flop powers up holding a 0 or a 1, nobody knows which. Most of a processor does not care: a register is written before it is read. What is read first must start known: the PC (0 here), valid bits, a state machine\'s state. <b>Reset</b> puts those in place. <b>Synchronous</b> reset goes through the d logic and takes effect at the next edge: s_pc\'s second bus mux selects 0 while rst = 1. <b>Asynchronous</b> reset forces the latches inside the flip-flop at once, with no clock: the library\'s flip-flop with async reset is 19 NANDs against 11.<br>The simulator shows the difference: Reset with power-on X leaves every unreset flip-flop unknown, and the X spreads as far as the logic lets it; zero applies the parts\' power-on hints; random is what silicon does. The RV16 cores take rst: an edge with rst high retires nothing.',
    example: { title: 'A 16-bit PC, reset two ways', body: '<pre>synchronous    one bus mux in front: 0 or the next PC     49 NANDs\nasynchronous   16 × (19 − 11): flip-flops with reset      128 NANDs</pre>The synchronous form also keeps the reset on the clock: it acts at an edge, like everything else.' },
    mistakes: [
      'Resetting every register: datapath registers are written before they are read, and each reset costs a mux or a bigger flip-flop. Reset what is read first.',
      'Releasing an asynchronous reset at any moment: if it lets go near an edge some flip-flops leave reset a cycle before others, or go metastable. Synchronize the release.',
      'Trusting zeros at power-on: silicon powers up at random; zero here is only the parts\' power-on hints.',
    ],
    lib: 'dff_r',
    compare: ['dff'],
    chapters: [{ chapter: 'registers', step: 3, label: 'Asynchronous reset' }, { chapter: 'registers', step: 2, label: 'A counter' }],
  },
  fpadder: {
    idea: 'Adding two floats takes four steps, each a block of the side quests. <b>Align</b>: swap so that |a| ≥ |b|, then shift b\'s significand right by the exponent difference; the bits shifted out are not dropped but ORed into a sticky bit. <b>Add</b> the significands, or subtract them when the signs differ. <b>Normalize</b>: a carry out shifts right by one; a subtraction of close numbers leaves leading zeros, which the leading-zero counter finds and a left shift removes. <b>Round</b> to nearest, ties to even, from the guard and sticky bits, and adjust the exponent; past the largest exponent the result is ∞.<br>Special cases sit beside the path: NaN in, or ∞ − ∞, gives the canonical NaN; x − x gives +0 (−0 when rounding down). The library\'s binary16 adder (fpAdd) is 3 755 NANDs and 163 delays deep, more than half of it the normalize-and-round block, which the multiplier and the int-to-float converter share.',
    example: { title: 'Two sums in binary16', body: '<pre>1.5 + 0.375      exponents 0 and −2: shift 1.1 right by 2 → 0.011\n                 1.100 + 0.011 = 1.111 = 1.875 (0x3F80): no normalizing\n1.0 − 0.99951171875 (0x3BFF)\n                 1.0000000000 − 0.11111111111 = 2^−11\n                 a left shift of 11, exact: 0x1000</pre>The second is cancellation: no rounding at all, but the widest normalization the adder ever does.' },
    mistakes: [
      'Shifting b right without a sticky bit: the bits shifted out decide ties under round to nearest even.',
      'Rounding before normalizing: the guard bit is the one below the result\'s last bit, and it moves with the shift.',
      'Leaving out the cancellation path: subtracting close numbers needs the left shift, and x − x must give +0, not −0.',
    ],
    chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }, { chapter: 'float', step: 4, label: 'Round to nearest, ties to even' }],
  },
  tristate: {
    idea: 'One wire, many sources: each drives it through a <b>tri-state buffer</b>, which passes its input while enabled and lets go (Z, high impedance) otherwise, and a decoder enables exactly one. However many sources, one wire per bit and no multiplexer tree. Boards and early computers were built this way, and it survives at chip pins: a memory\'s data bus, open-drain lines such as I²C.<br>Inside chips the multiplexer won. Two enables overlapping for a moment let two drivers fight, a short from supply to ground through both; none enabled leaves the wire floating until a pull-up or a keeper holds it; static timing, scan test and FPGA fabrics want one driver per net. Here the buffer (TRIBUF, 8 transistors) has no gate-level model, so a chip using it simulates at switch level, and the solver names any short it finds.',
    example: { title: 'Four sources on a 1-bit wire', body: '<pre>tri-state     4 TRIBUFs = 32 transistors, enables from a 2→4 decoder\nmultiplexer   3 two-input muxes = 12 NANDs = 48 transistors, 2 select bits</pre>' },
    mistakes: [
      'Changing the select so that the new driver turns on before the old one lets go: for a moment both drive, a crowbar current.',
      'Reading a bus nobody drives: it floats; a pull-up or a bus keeper gives it a level.',
      'Using tri-states inside a chip where a mux would do: no gate-level model, harder to time and to test.',
    ],
    lib: 'tribuf',
    chapters: [{ chapter: 'routing', step: 3, label: 'Switching whole buses' }],
  },
  bin2dec: {
    idea: 'Inside, a number is binary; to print it, it needs decimal digits. Without a divider, subtract powers of ten: count how many times 10 000 goes into x, then 1 000, 100 and 10; each count is a digit and what is left is the last. A 16-bit number takes at most 32 subtractions, every digit an ASCII \'0\' plus its count. That is p_print, on RV16, which has no divide.<br>With a multiplier, divide by multiplying: x / 10 = (x · 52 429) >> 19 for every 16-bit x, the remainder x − 10·q; compilers do this for every division by a constant. In hardware the classic is <b>double dabble</b>: shift the binary number into BCD digits a bit at a time, adding 3 to any digit of 5 or more before each shift, 16 shifts for 16 bits.',
    example: { title: '1 234 and 59 999', body: '<pre>1 234    10 000 × 0, 1 000 × 1, 100 × 2, 10 × 3, left 4   → "1234", 6 subtractions\n59 999   5 + 9 + 9 + 9 subtractions, left 9               → 32, the most for 16 bits</pre>' },
    mistakes: [
      'Comparing signed: 40 000 is −25 536 as a signed 16-bit number, so a signed compare finds it below 10 000. Use sltu.',
      'Skipping every zero digit: only leading zeros go; 105 keeps its 0, and 0 itself prints one digit.',
      'Using x · 52 429 >> 19 on wider numbers: it is exact for every 16-bit x (and on to 262 148), first wrong at 262 149.',
    ],
    chapters: [{ chapter: 'adders', step: 8, label: 'Decimal: the BCD adder' }],
  },
};
