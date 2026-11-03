// What a lesson node adds to its text (DOM-free data): library figures (the codex's live schematic of a part) and
// questions (Check yourself, kept in the review queue as `lesson:<body>:<k>`). Keyed by the node's `body`.

import type { Quiz } from '../chapters/types';

export interface LessonFigure {
  /** A registered library part id (resolveComponent). */
  lib: string;
  caption: string;
}

export interface LessonExtra {
  figures: LessonFigure[];
  check: Quiz[];
}

export const LESSON_EXTRAS: Record<string, LessonExtra> = {
  mem: {
    figures: [
      { lib: 'ram4x4', caption: 'A 4-word RAM of 4-bit words, simulated: a decoder on the write port, flip-flops with an enable, one read mux per bit. Click an input; the lesson\'s 64-word RAM is this drawing 16 times deeper and 4 times wider.' },
    ],
    check: [
      { question: 'A 64-word RAM of 16-bit words costs 20 166 NANDs built from flip-flops. About how many NANDs per stored bit?', options: ['About 4', 'About 13', 'About 20', 'About 80'], answer: 2,
        why: ['A NAND stores nothing alone; a bit needs a feedback pair and its gating.', 'That is your own cell (9-NAND flip-flop and enable mux) alone; the decoder and the read muxes come on top.', '', 'That is the transistor count (4 per NAND), not the NAND count.'],
        explain: '20 166 / (64 × 16) = 19.7. Fifteen go to the library\'s flip-flop and its enable mux, the rest to the write decoder and the read multiplexer tree. That is why real memories are arrays of 6- or 1-transistor cells.' },
      { question: 'Why does a single-cycle core need two memories, instruction and data (Harvard)?', options: ['Instructions are wider than data', 'It fetches an instruction and accesses data in the same cycle', 'ROM cannot be written', 'To keep the program safe'], answer: 1,
        why: ['Width is not the reason; one array could hold both.', '', 'True, but a load or store needs the data port even if the program were in RAM.', 'Protection is a side effect, not the cost the design avoids.'],
        explain: 'One port cannot serve the fetch and a load or store in one cycle, so there are two: the PC addresses one, the ALU result the other.' },
    ],
  },
  isa: {
    figures: [
      { lib: 'rv16_imm', caption: 'RV16\'s immediate generator, simulated: the 16-bit word in, the immediate of each format out. Fields never move, so each output bit is a wire from one instruction bit, a copy of the sign, or ground. Set the word to a branch and a jal and compare.' },
    ],
    check: [
      { question: '<code>li a0, 100</code>: how many words does it take?', options: ['1: addi rd, x0, 100', '2: lui + addi', '3', 'It cannot be written'], answer: 1,
        why: ['imm6 reaches only −32 … 31, so 100 does not fit in an addi.', '', 'seqz takes three because there is no sltiu; li needs at most two.', 'Every 16-bit value can be built with lui and addi.'],
        explain: '100 does not fit imm6 and is not a multiple of 64, so li is lui (128) + addi (−28): two words. The addi must fit −32 … 31, so the lui rounds to the nearest multiple of 64; a multiple of 64 would need the lui alone.' },
      { question: 'A branch target is 100 words away. Which can reach it?', options: ['beq: imm6', 'jal: imm9', 'Both', 'Neither'], answer: 1,
        why: ['imm6 reaches −32 … 31 words.', '', 'beq stops at 31.', 'jal reaches −256 … 255.'],
        explain: 'jal has 9 immediate bits (the whole rd-less J format), a branch only 6. Farther than 31 words, a conditional branch hops over a jal: the opposite branch around an unconditional jump.' },
    ],
  },
  datapath: {
    figures: [
      { lib: 'rv16_ctl', caption: 'The control unit, simulated: the op field and funct3 in, every steering signal out. Pick an op and read the row of the table above: this block is that table.' },
    ],
    check: [
      { question: 'Which instruction sets the clock period of the single-cycle core, and why?', options: ['add: the ALU is the longest block', 'lw: the path runs through the ALU and then the data memory', 'jal: the next-PC adder', 'sw: it writes memory'], answer: 1,
        why: ['An add stops after the ALU and the register write.', '', 'jal skips the ALU and the data memory.', 'A store also uses the ALU and the memory, but nothing is written back to a register after it.'],
        explain: 'A load is the only instruction that goes PC → ROM → control → register file → ALU → data memory → result mux → register file. Everything else waits for it.' },
      { question: 'Why must the control unit clear rwe for <code>sw</code>?', options: ['The memory is busy', 'Its bits 6:4 carry imm[2:0] but sit where rd would be', 'sw writes x0', 'The ALU result is not ready'], answer: 1,
        why: ['The data memory is a separate port.', '', 'sw has no destination register at all.', 'The address is ready by the end of the cycle like any other result.'],
        explain: 'S and B keep rs1 and rs2 where R puts them and spend the rd bits on the low immediate. Decoded as an rd field they would name a register to overwrite, so control gates the write by op.' },
    ],
  },
  pipe: {
    figures: [
      { lib: 'rv16_fwd', caption: 'The forwarding unit, simulated: the source registers of the instruction in E against the destinations in M and W. A match selects the newer result before it reaches the register file.' },
      { lib: 'rv16_haz', caption: 'The hazard unit, simulated: a load in E whose destination the next instruction reads stalls the front of the pipeline for one cycle.' },
    ],
    check: [
      { question: 'Forwarding removes the nops between a producer and its user, but a load followed by its user still stalls one cycle. Why?', options: ['The register file is slow', 'The loaded word exists only after M, one stage too late for the next instruction\'s E', 'Loads write two registers', 'The forwarding unit does not look at loads'], answer: 1,
        why: ['The register file is not on this path; forwarding bypasses it.', '', 'A load writes one register.', 'It looks at every destination; the data is simply not there yet.'],
        explain: 'An ALU result exists at the end of E and can be forwarded from M; a load\'s word comes out of the data memory in M, so the dependent instruction is one cycle early at best and must wait.' },
      { question: 'Why does a taken branch cost two cycles in this pipeline?', options: ['The target adder is slow', 'It resolves in E, after two younger words were fetched on the guess "not taken"', 'The register file must be read twice', 'The branch comparator needs two cycles'], answer: 1,
        why: ['The target is computed in the same stage as the decision.', '', 'The reads are done in D.', 'The comparator finishes inside E.'],
        explain: 'Fetch is two stages ahead of E, so two wrong-path instructions are in flight when the branch is taken; flushing them is the two lost cycles. Earlier resolution or prediction removes them.' },
    ],
  },
  traps: {
    figures: [
      { lib: 'rv16_csr', caption: 'The CSR file, simulated: mtvec, mepc, mcause, mstatus, mie and mscratch, and mip\'s view of the line, behind one read mux. A trap writes mepc, mcause and mstatus on its own at the edge; csr instructions write the registers.' },
    ],
    check: [
      { question: 'An <code>ecall</code> handler must add 1 to mepc before <code>mret</code>. Why, and why not for an interrupt?', options: ['mepc holds the ecall itself; an interrupt\'s mepc is the instruction that has not run', 'mepc is one behind the PC always', 'ecall is two words long', 'Interrupts reset mepc'], answer: 0,
        why: ['', 'It points at the interrupted or faulting instruction, not behind.', 'Every RV16 instruction is one word.', 'Nothing resets it; the trap writes it.'],
        explain: 'An exception reports the instruction that caused it, so returning there repeats the ecall forever. An interrupt arrives between two instructions: mepc is the next one, and mret resumes exactly there.' },
      { question: 'In what order should software enable interrupts?', options: ['MIE, then mie, then mtvec', 'mtvec, then mie, then MIE last', 'mie, then MIE, then mtvec', 'Any order'], answer: 1,
        why: ['An interrupt could arrive with mtvec still 0, jumping to nothing.', '', 'MIE before mtvec has the same hole.', 'The first interrupt after MIE goes to mtvec, so it must exist by then.'],
        explain: 'The global enable last: by the time anything can interrupt, the handler address is set and the sources are chosen.' },
    ],
  },
};
