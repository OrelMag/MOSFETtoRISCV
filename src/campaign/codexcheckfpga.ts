// Check yourself for the FPGA chapter's codex entries (codexfpga.ts): two questions each, the answer first (quizBox
// shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKFPGA: Record<string, Quiz[]> = {
  lut: [
    {
      question: 'A LUT4 computes a OR b OR c OR d. What is its configuration?',
      options: ['0xFFFE: 1 at every address but 0', '0x8000: 1 only at address 15', '0x0001: 1 only at address 0', '0x6666'],
      answer: 0,
      explain: 'The OR is 0 only when every input is 0, address 0. Every other bit of the table is 1.',
      why: ['', 'That is the AND: 1 only when all four inputs are 1.', 'That is the NOR: 1 only when all are 0.', 'That is a XOR b, ignoring c and d.'],
    },
    {
      question: 'One LUT4 computes a AND b. Another computes the full adder\'s carry, the majority of a, b and c. Which costs more LUT hardware?',
      options: ['Neither: a LUT4 is the same 16 bits and 60 NANDs whatever it computes', 'The majority', 'The AND'],
      answer: 0,
      explain: 'A look-up table stores the function\'s truth table. Its size depends on the number of inputs, never on the gates the function would take.',
      why: ['', 'Any function of up to four inputs is 16 bits however many gates it would take.', 'The AND\'s single gate does not make its table smaller; its unused inputs just repeat the pattern.'],
    },
  ],
  fpga: [
    {
      question: 'What turns a blank FPGA into our RISC-V computer?',
      options: ['Configuration bits loaded at power-on: LUT tables, switches, memory contents', 'A program the FPGA executes instruction by instruction', 'Masks made at the factory'],
      answer: 0,
      explain: 'The bits fill the tables and close the switches; from then on it is a circuit. A custom chip is what needs masks.',
      why: ['', 'Nothing is executed: the configuration sets the hardware once.', 'Masks fix a custom chip\'s wiring forever; an FPGA\'s is set by bits.'],
    },
    {
      question: 'Our computer uses 61 % of the GW1NR-9\'s LUTs. What does a second design on the same chip need?',
      options: ['Another bitstream, loaded the same day', 'A new mask set', 'A chip with twice the LUTs'],
      answer: 0,
      explain: 'Reconfiguration is the whole point: the same chip becomes another circuit when it loads other bits.',
      why: ['', 'Masks are for custom chips.', 'It replaces the first design; it does not have to fit beside it.'],
    },
  ],
  bitstream: [
    {
      question: 'On the GW1NR-9 the LUT tables are 7 % of the fabric\'s configuration bits. What is most of the rest?',
      options: ['The routing switches, plus the cells\' modes and the clocks', 'Copies of the LUT tables', 'The program the CPU runs'],
      answer: 0,
      explain: 'Every switch at every track crossing has its bit. There are far more of them than table entries.',
      why: ['', 'Each table is stored once.', 'The program goes in the block RAMs\' frames, which the counter\'s bitstream does not have.'],
    },
    {
      question: 'Why is our computer\'s bitstream 512 frames longer than the counter\'s?',
      options: ['It also carries the block RAMs\' contents, the program among them', 'It uses more LUTs', 'It has two clocks'],
      answer: 0,
      explain: 'The fabric\'s frames are written whole for any design; the extra frames are the memories\' initial words.',
      why: ['', 'More LUTs change bits inside the same frames, not their number.', 'Clock settings are bits in the fabric\'s frames.'],
    },
  ],
  bram: [
    {
      question: 'Why does our 4K × 32 RAM take 8 block RAMs?',
      options: ['131 072 bits over 16 Kbit (16 384 bits) a block', 'One block per 512 words is the rule', 'Each block holds one byte lane'],
      answer: 0,
      explain: '4096 × 32 = 131 072 bits, and 131 072 / 16 384 = 8.',
      why: ['', 'The count follows from the bits, not from a fixed number of words.', 'The split is by capacity; four byte lanes would be four, not eight.'],
    },
    {
      question: 'Why did the register file stay in flip-flops and LUTs?',
      options: ['It is read on two ports and written on a third in the same cycle, more than a block RAM offers', 'It is too large for a block RAM', 'Block RAMs cannot hold 32-bit words'],
      answer: 0,
      explain: 'A block RAM has a fixed, small number of ports and reads through a register. Our register file needs two reads and a write each cycle and a constant x0.',
      why: ['', 'It is 992 bits, far below a block\'s 16 Kbit.', 'The RAM\'s 32-bit words fit them fine.'],
    },
  ],
  logiccell: [
    {
      question: 'In adder mode, a = 1, b = 0, cin = 1. What are the sum and the carry out?',
      options: ['sum 0, carry 1', 'sum 1, carry 0', 'sum 1, carry 1', 'sum 0, carry 0'],
      answer: 0,
      explain: 'p = a XOR b = 1, so the sum is p XOR cin = 0 and the carry passes cin through: 1. In binary 1 + 0 + 1 = 10.',
      why: ['', 'That would be 1 + 0 + 0.', 'That would be 1 + 1 + 1.', 'That would be 0 + 0 + 0.'],
    },
    {
      question: 'Our computer\'s adders are NAND netlists. Did they use the carry chain?',
      options: ['No: Yosys mapped them to LUTs gate by gate; only the board\'s clock divider used the chain', 'Yes, every adder', 'Only the program counter\'s'],
      answer: 0,
      explain: 'The tools put adders on the chain when they see a + b in the Verilog. A netlist of gates is just logic to them.',
      why: ['', 'The report shows 24 carry cells, the divider\'s counter.', 'The program counter\'s +4 is a NAND netlist too.'],
    },
  ],
  switchbox: [
    {
      question: 'Why is each routing switch in the chapter\'s model a transmission gate and not one plain NMOS?',
      options: ['An NMOS passes a weak 1; the PMOS beside it passes the 1 fully', 'An NMOS cannot be turned off', 'A transmission gate needs no configuration bit'],
      answer: 0,
      explain: 'An NMOS stops conducting as its output rises to a threshold below its gate. The PMOS conducts best exactly there.',
      why: ['', 'A 0 on its gate turns it off.', 'Each switch is still held by one bit; an inverter makes the PMOS\'s gate from it.'],
    },
    {
      question: 'On our computer\'s slowest path, routing took 23.7 ns and logic 13.1 ns. What would help the clock most?',
      options: ['Shorter connections: placing the path\'s cells closer together', 'Faster LUTs', 'Fewer flip-flops'],
      answer: 0,
      explain: 'Most of the time is in the tracks and switches between the cells, so that is where to save.',
      why: ['', 'Even free LUTs would leave most of the 40.9 ns.', 'Flip-flops are only the ends of the path.'],
    },
  ],
};
