// Codex entries for the chapter "How do you know it works?" (verification and manufacturing test) and the LFSR it builds
// on. Same shape as codex.ts, appended to CODEX there; the fuller texts are codexmore10.ts, the questions codexcheck12.ts,
// the numbers pinned by tests/content-codexverify.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_VERIFY: CodexEntry[] = [
  E('golden', 'Golden model', 'tool', 'An instruction-set simulator written from the specification, sharing no code with the gates: the oracle every CPU here runs beside. In lock step it executes each instruction as the hardware retires it and compares the PC, every register and the stored memory word, so the first mismatch names the instruction. A forwarding fault shows at the add that needed it: 7 in the gates, 14 in the model.', ['singlecycle', 'pipeline', 'forwarding']),
  E('selfcheck', 'Self-checking test', 'tool', 'A program that knows its own answers: each case computes a result and compares it with the value the specification gives, and reports the first case that differs. The riscv-tests write (case << 1) | 1 to tohost on a failure and 1 when all pass, so one image judges the golden model and every CPU. With alu.slt stuck at 0, 2 of the 32 fail, slt and slti, both at case 4.', ['golden', 'rv32i', 'alu']),
  E('fuzzing', 'Random testing', 'tool', 'Programs nobody wrote, drawn at random and weighted towards the places instructions meet (a source that was just a destination, a branch after a load), each run to its halt on the golden model and on the gates and the final states compared. The FP pipeline with its old PC-enable bug planted back fails 3 of the first 64 seeds; delta debugging shrinks seed 3 from 111 instructions to 4.', ['golden', 'hazards', 'pipeline']),
  E('coverage', 'Verification coverage', 'concept', 'What a test suite exercised, counted: here the RV32I instructions the golden model ran and the pipeline events the hazard unit produced. The Primer sample makes all 7 events but uses 13 of 31 instructions; 32 random programs reach all 31. Coverage finds gaps and cannot prove there are none: the FP pipeline\'s bug survived full coverage.', ['fuzzing', 'selfcheck', 'hazards']),
  E('stuckat', 'Stuck-at fault', 'concept', 'The defect model of manufacturing test: one net reads 0, or 1, whatever drives it, standing for shorts, opens and dead transistors alike. Counting every input bit and every NAND output, the 9-NAND full adder has 12 nets and 24 faults, the 4-bit ripple adder 90. A tester sees only the pins, so a fault counts as caught when some vector changes an output.', ['fulladder', 'stdcell', 'faultcov']),
  E('faultcov', 'Fault coverage', 'law', 'The share of modelled faults a set of test vectors catches. 3 vectors catch all 24 of the full adder\'s faults (greedy picks 4); 3 of the ripple adder\'s 512 catch all 90. Random vectors catch 40, 60, 76, 88, 90 after 1, 2, 4, 8, 16: quick at first, then a tail of faults each shown by few vectors.', ['stuckat', 'atpg']),
  E('atpg', 'Test pattern generation (ATPG)', 'tool', 'Finding a vector for one fault by reasoning back from it: activate (drive the net to the opposite of its stuck value), propagate (open a path to an output: a NAND\'s other inputs at 1), justify (set inputs that give those values), backtrack on a conflict. When every choice fails the fault is untestable: 1 of the consensus circuit\'s 20, on its redundant term.', ['stuckat', 'faultcov', 'fulladder']),
  E('scan', 'Scan chain', 'component', 'A multiplexer in front of every flip-flop: with se = 1 the flip-flops chain q to the next one\'s input, one shift register from a scan-in pin to scan-out. Shift a state in, clock once, shift the answer out, and the logic between flip-flops is tested as combinational logic. A scan flip-flop is 15 NANDs against 11; on the pipelined CPU, 2 676 flip-flops and 10 704 NANDs more, 15.5 %.', ['dff', 'mux', 'register', 'stuckat']),
  E('lfsr', 'LFSR', 'component', 'A shift register whose new bit is the XOR of a few of its bits, the taps. With the taps of a primitive polynomial it visits every non-zero state, 2ⁿ − 1 of them, in an order that looks random: 4 bits and taps 4, 3 give 15 states from one XOR. All zeros is stuck for ever. It makes test patterns, scrambles serial links and computes CRCs.', ['register', 'xor', 'counter', 'crc']),
  E('bist', 'BIST', 'trick', 'Built-in self-test: an LFSR on the chip generates patterns and a signature register (an LFSR with the answers XORed into its state) folds the answers into one word, compared once at the end. A 9-bit LFSR and a 5-bit MISR test the 4-bit adder in 32 clocks; 1 of its 90 faults escapes, its wrong sums folding into the good signature. Memories run March tests instead.', ['lfsr', 'scan', 'faultcov', 'sram']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_VERIFY: Record<string, string> = {
  golden: 'cpu', lfsr: 'registers',
  selfcheck: 'verify', fuzzing: 'verify', coverage: 'verify', stuckat: 'verify', faultcov: 'verify', atpg: 'verify', scan: 'verify', bist: 'verify',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_VERIFY: Record<string, string[]> = {
  golden: ['golden models'],
  selfcheck: ['self-checking'],
  fuzzing: ['fuzzing', 'delta debugging'],
  coverage: ['cross coverage'],
  stuckat: ['stuck-at', 'stuck-at faults', 'stuck-at fault model'],
  faultcov: ['fault coverage'],
  atpg: ['ATPG', 'automatic test pattern generation'],
  scan: ['scan chains', 'full scan'],
  lfsr: ['LFSRs', 'linear-feedback shift register'],
  bist: ['MISR', 'signature register'],
};

/** Ids no campaign level teaches (campaign.test.ts skips them): t_tests lists stuckat, faultcov and atpg; t_scan lists scan. */
export const VERIFY_AWAITING_LEVELS: ReadonlySet<string> = new Set(['golden', 'selfcheck', 'fuzzing', 'coverage', 'lfsr', 'bist']);
