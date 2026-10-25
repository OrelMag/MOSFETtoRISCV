// The thread (thread.ts), acts 6–8 (pipelining, the system, arithmetic): where each level's part ends up,
// how the next levels use it, and the mistakes made building it (see thread0.ts for the shape). The
// floating-point units and the shift-and-add multiplier name no anatomy block: RV16 has no F registers and
// its core multiplies on the array, so they stand alone. No DOM.

import type { NodeThread } from './thread';

export const THREAD2: Record<string, NodeThread> = {
  // ---- Act 6 ----------------------------------------------------------------------------------
  o_mc: {
    uses: ['ctl'],
    pitfalls: [
      'Writing rd or loading the PC before W: a PC moved early fetches the next word while this instruction is still being run.',
      'Decoding from <code>instr</code> after F instead of from the instruction register: the ROM output follows the PC, not the instruction being run.',
      'Sending every instruction through M: correct, but a cycle more per instruction that neither loads nor stores, and the cycles are graded.',
    ],
  },
  pi_lesson: {
    uses: ['p1', 'p2', 'p3', 'p4', 'fwd', 'haz'],
    usedFor: {
      pi_core0: 'the five stages and the registers between them, with no hazard handled yet',
      pi_fwd: 'the first hazard it names: a result needed before it is written back',
    },
    pitfalls: [
      'Expecting five times the speed: the period falls only to the slowest stage, E, and CPI rises above 1. With ripple adders the pipeline loses to Core IV.',
      'Counting cycles alone, or the period alone: the graded time is period × cycles.',
    ],
  },
  pi_reg: {
    usedFor: { pi_core0: 'twelve of them between the five stages, for every field an instruction carries' },
    pitfalls: [
      'clr left out of the load enable: with en = 0, a flush during a stall keeps the old value instead of a bubble.',
      'Holding by gating the clock: hold by reloading the register\'s own value (en = 0), never by stopping clk.',
      'A bubble whose control bits are not all zero still writes a register or stores.',
    ],
  },
  pi_core0: {
    uses: ['p1', 'p2', 'p3', 'p4'],
    usedFor: { pi_core1: 'the stages it keeps, with two forwarding muxes added in front of E' },
    pitfalls: [
      'The register file clocked on the rising edge: an instruction three behind its producer then reads the old value. Write it at the falling edge (¬clk).',
      'rd taken from the instruction in D at write-back: W must use the rd that travelled with its own instruction.',
      'Reporting a register write before W, or a store before M: the bench compares in program order.',
    ],
  },
  pi_fwd: {
    usedFor: { pi_core1: 'steers the two operand muxes in front of E' },
    pitfalls: [
      'W chosen over M when both match: M holds the newer write, so it must win.',
      'Forwarding a write to x0: x0 reads 0 whatever was "written" to it.',
      'A match without the stage\'s rwe: stores and branches carry immediate bits where rd would be.',
    ],
  },
  pi_core1: {
    uses: ['fwd', 'alu'],
    usedFor: {
      pi_haz: 'is the pipeline whose last nop, the one after a load, the hazard unit removes',
      pi_core2: 'the forwarding pipeline it adds the stall to',
    },
    pitfalls: [
      'Forwarding only rs1: stores read rs2 as their data, and from Pipeline IV on branches compare it.',
      'Forwarding a load\'s value from M: in M the load is only now reading memory; its word can come from W only.',
      'Forwarding into D instead of E: the operands latched into D/E are stale by the time E uses them.',
    ],
  },
  pi_haz: {
    usedFor: { pi_core2: 'raises stall: the PC and F/D hold, D/E takes a bubble' },
    pitfalls: [
      'Comparing against the instruction in E instead of D: once the user is in E it is one cycle too late to hold it.',
      'Stalling for any instruction in E, not only a load: correct, but a cycle lost after every instruction.',
      'Forgetting rd ≠ x0: a load into x0 makes a needless stall (allowed, but it costs a cycle).',
    ],
  },
  pi_core2: {
    uses: ['haz', 'p1', 'p2'],
    usedFor: { pi_core3: 'the pipeline whose PC mux and D/E clear the branch flush shares' },
    pitfalls: [
      'Clearing F/D instead of D/E: the waiting instruction must stay in D, and the bubble goes into E.',
      'Holding the PC with an enable it does not have: put a 2:1 mux in front that reloads pc.',
      'No forward from W the cycle after the stall: the user then reads the register file before the load has written it.',
    ],
  },
  pi_core3: {
    uses: ['npc', 'br', 'p1', 'p2'],
    usedFor: {
      y_ptrap: 'the pipeline Pipeline V adds precise exceptions to, trapping in E where branches resolve',
      o_bpred: 'the pipeline the guess in F goes into; E\'s redirect then fires only on a wrong guess',
    },
    pitfalls: [
      'Flushing F/D only: the word in D was fetched on the wrong path too.',
      'jal and jalr forgotten: they redirect like a taken branch and write pc + 1, which must be forwarded from M like any result.',
      'Comparing branch operands as read in D: a branch in E needs forwarded operands, like the ALU.',
    ],
  },
  o_bpred: {
    uses: ['npc', 'p1'],
    pitfalls: [
      'The guess winning over the stall: while the front holds, the PC must not jump to the predicted target.',
      'No correction for a predicted branch that falls through: E must redirect back to pc + 1, not only to the target.',
      'Predicting forward branches taken: those are mostly the skips of an if, and a wrong guess costs the same two cycles as no guess.',
    ],
  },

  // ---- Act 7 ----------------------------------------------------------------------------------
  y_lesson: {
    uses: ['csr'],
    usedFor: {
      y_csr: 'the registers it names: mtvec, mepc, mcause, mstatus, mie',
      p_handler: 'the protocol: enable in order, acknowledge, mret',
    },
    pitfalls: [
      'mepc + 1 on every return: right after an ecall, wrong after an interrupt, whose mepc is the instruction not yet run.',
      'MIE set before mtvec: an interrupt then jumps to wherever mtvec happened to point.',
    ],
  },
  y_csr: {
    usedFor: { y_trap: 'holds mepc, mcause and mtvec for every trap and answers the CSR instructions' },
    pitfalls: [
      'A software write winning over a trap in the same cycle: the trapped instruction must not have run.',
      'mret leaving MPIE as it was: it is set to 1 when MPIE moves back into MIE.',
      'An enable on mstatus: its MIE and MPIE bits change on traps and mret too, so it computes its next value every cycle.',
    ],
  },
  y_trap: {
    uses: ['csr', 'npc', 'ctl'],
    usedFor: {
      y_irq: 'the trap path the interrupt takes, unchanged: one more reason to trap',
      y_ptrap: 'the same CSR file, decoder and causes, moved into the pipeline\'s E',
    },
    pitfalls: [
      'The trapping instruction still writes its register or stores: a trap replaces the instruction, it does not follow it.',
      'mepc ← pc + 1: an exception saves the faulting instruction itself; the handler decides whether to skip it.',
      'A CSR instruction writing the new CSR value to rd: rd gets the old one.',
    ],
  },
  y_irq: {
    uses: ['csr', 'mmio'],
    usedFor: { y_final: 'the interrupt the finale takes in the pipeline, with the same cause and condition' },
    pitfalls: [
      'Running the instruction at pc and then trapping: an interrupt is taken before it, and mepc names it.',
      'Ignoring MEIE or MIE: intr = MIE · MEIE · irq, never irq alone.',
      'Letting an exception beat the interrupt in the same cycle: the interrupt wins.',
    ],
  },
  p_handler: {
    uses: ['mmio', 'csr'],
    usedFor: { y_final: 'is the shape of the finale\'s interrupt-driven test: push, serve, acknowledge, pop, mret' },
    pitfalls: [
      'No acknowledge before mret: irq is still high when MIE comes back, and the interrupt is taken again at once.',
      'Setting MIE before mtvec and mie: the first interrupt jumps to an address that holds no handler.',
      'Saving nothing: main\'s t0 changes under it, at an instruction nobody can predict.',
    ],
  },
  y_ptrap: {
    uses: ['csr', 'p2', 'p3'],
    usedFor: { y_final: 'the precise trap in E that the interrupt joins' },
    pitfalls: [
      'A bubble taken for an illegal instruction: its all-zero word is a SYSTEM encoding. Carry a valid bit.',
      'Trapping in D or M: in D an older branch may still flush it; in M it has already changed something.',
      'Stopping the instructions in M and W too: older instructions must complete, only younger ones are flushed.',
    ],
  },
  y_final: {
    uses: ['csr', 'mmio'],
    pitfalls: [
      'Taking the interrupt on a bubble: its D/E slot was cleared, so mepc would name an address the program never was at.',
      'mcause 11 instead of 0x800B: without bit 15 the handler takes the interrupt for an ecall.',
      'An exception beating the interrupt in E: the interrupt wins, and the exception is met again after mret.',
    ],
  },

  // ---- Act 8 ----------------------------------------------------------------------------------
  o_lesson: {
    pitfalls: [
      'Judging a unit by its own depth: in a single-cycle core the multiplier\'s path sets every instruction\'s period.',
      'Fewest NANDs is not cheapest: a looping unit trades them for cycles, and the core levels grade both.',
    ],
  },
  o_mulseq: {
    pitfalls: [
      'Dropping the adder\'s carry out: it is the new top bit after the shift.',
      'Shifting before the add: the add goes to the upper half first, then the whole register shifts.',
      'Counting 16 cycles: loading takes one and done another, 18 in all.',
    ],
  },
  o_mularr: {
    uses: ['alu', 'wb'],
    usedFor: {
      o_mcore: 'the 16 × 16 version sits beside the ALU, its result on the write-back path',
      o_fpmul: 'the significand product, 11 × 11 bits (given there as a tree)',
    },
    pitfalls: [
      'Dropping each row\'s carry out: it is the next row\'s top bit.',
      'Shifting row k by k − 1: row k is a AND b[k] at weight 2^k.',
    ],
  },
  o_mcore: {
    uses: ['alu', 'wb'],
    usedFor: { o_dcore: 'the MD decode and the write-back mux the divide joins' },
    pitfalls: [
      'A signed multiplier for mulh: one unsigned array and two corrections serve all four products.',
      'Correcting mulhsu for b < 0: b is unsigned there; only a\'s sign corrects.',
      'MD\'s write not ORed into rwe: the product is computed and never written.',
    ],
  },
  o_div: {
    uses: ['alu', 'wb'],
    usedFor: { o_dcore: 'the unsigned divider the core starts and waits for' },
    pitfalls: [
      'Subtracting before the next dividend bit is shifted in.',
      'A special case for b = 0: the hardware already gives q = 0xFFFF and r = a, as RISC-V wants.',
      'Keeping a negative difference: then the old remainder stays, and the quotient bit is 0.',
    ],
  },
  o_dcore: {
    uses: ['alu', 'wb', 'pc'],
    pitfalls: [
      'Writing rd while holding: the result is only valid with done.',
      'Negating the quotient for b = 0: −1 must stay all ones.',
      'Restarting the divider every held cycle: start once, then hold until done.',
    ],
  },
  n_float: {
    usedFor: {
      o_fpunpack: 'the three fields it decodes, the hidden bit and the special values',
      o_fpround: 'the 11 kept bits, and what the dropped ones decide',
      o_fpsticky: 'alignment: the operand with the smaller exponent shifted right',
      o_fplzc: 'normalization: the leading 1 back at the top',
    },
    pitfalls: [
      'Forgetting the bias: the field is e + 15, not e.',
      'A hidden 1 for exponent field 0: subnormals have none and count as exponent 1.',
      'Reading field 31 as a number: it is ∞ or NaN.',
    ],
  },
  o_fpunpack: {
    usedFor: {
      o_fpadd: 'two of them, one per operand',
      o_fpcmp: 'two, for the classes: zero and NaN',
    },
    pitfalls: [
      'A subnormal\'s exponent taken as 0: it is 1, without the hidden bit.',
      'inf and NaN not told apart: both have field 31, the fraction decides.',
    ],
  },
  o_fpround: {
    usedFor: { o_fpnorm: 'the round-up and toInf decision after the shift' },
    pitfalls: [
      'Ties rounded up: to nearest even rounds a tie (g = 1, s = 0) up only when lsb = 1.',
      'Directed modes without the sign: rounding down a negative result moves it away from zero.',
    ],
  },
  o_fpsticky: {
    usedFor: { o_fpnorm: 'a 15-bit one shifts right for results below the smallest normal' },
    pitfalls: [
      'A level ORing its bits when it does not shift: they are still in the word.',
      'Sticky dropped: a sum just above halfway then rounds like a tie.',
    ],
  },
  o_fplzc: {
    usedFor: { o_fpnorm: 'the left shift that puts the leading 1 back on top' },
    pitfalls: [
      'Combining halves without v: the upper count only counts when the upper half has a 1.',
      'An all-zero input: the count is the width, and v = 0 must say so.',
    ],
  },
  o_fpnorm: {
    usedFor: {
      o_fpadd: 'its last stage, 2 058 of the adder\'s 3 732 NANDs',
      o_fpcvt: 'the 16-bit version: the integer is the significand',
    },
    pitfalls: [
      'Shifting left past exponent 1: the result must stop as a subnormal.',
      'Rounding 1.11…1 up without bumping the exponent: the carry makes a new top bit.',
      'Overflow left to wrap: a field of 31 or more is ∞ or 0x7BFF, as toInf says.',
    ],
  },
  o_fpadd: {
    usedFor: { o_fpmul: 'its special cases and the normalize & round unit, wider' },
    pitfalls: [
      'Aligning without the swap: shift the operand with the smaller magnitude, not always b.',
      'x − x rounded to −0: it is +0, except −0 when rounding down.',
      'No room above the significands: an add can carry into a new top bit.',
    ],
  },
  o_fpmul: {
    pitfalls: [
      'Adding both biases: e = ea + eb − 15.',
      '0 × ∞ not NaN: it is invalid, the canonical NaN.',
      'Skipping the one-place shift when the product\'s top bit is 1.',
    ],
  },
  o_fpcmp: {
    pitfalls: [
      'Two negatives compared like positives: their order flips.',
      '−0 < +0: the zeros are equal.',
      'NaN equal to itself: every comparison with a NaN is false.',
    ],
  },
  o_fpcvt: {
    pitfalls: [
      'Converting the signed pattern directly: take the magnitude first, then put the sign back.',
      'Exponent 15 without the bias: hand normalize & round 15 + 15.',
    ],
  },
};
