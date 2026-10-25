// Codex entries for blocks and ideas the campaign builds but had not named: the pipeline register, the clock and its
// period, reset, the floating-point adder assembled, the tri-state bus, binary to decimal. Same shape as codex.ts,
// appended to CODEX there; the fuller texts are codexmore3.ts, the questions codexcheck5.ts, the numbers pinned by
// tests/content-codexease.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_NEW3: CodexEntry[] = [
  E('preg', 'Pipeline register', 'component', 'Between two stages, everything the later ones need of an instruction, clocked together: q ← clr ? 0 : en ? d : q. en = 0 holds (a stall); clr = 1 loads zeros, a bubble (a flush), and clr wins. rv16_preg: 260 NANDs, 208 of them the 16-bit register with enable; four rows of them, F/D, D/E, E/M, M/W.', ['pipeline', 'stall', 'flush', 'register']),
  E('clock', 'Clock and period', 'concept', 'One square wave; every flip-flop samples at its rising edge. Between two edges every register-to-register path must settle: period T ≥ clk-to-q + logic + setup, here 3 + logic + 3 NAND delays. The program counter: 3 + 35 + 3 = 41.', ['dff', 'criticalpath', 'setuphold', 'skew']),
  E('reset', 'Reset and power-on', 'concept', 'Flip-flops power up 0 or 1, unknown. Reset puts in place what is read before it is written: the PC, valid bits, a state machine\'s state. Synchronous: through the d logic, at the next edge (s_pc\'s mux to 0). Asynchronous: at once, a flip-flop of 19 NANDs instead of 11.', ['dff', 'pc', 'metastability']),
  E('fpadder', 'FP adder', 'component', 'Align (swap, shift the smaller right keeping a sticky bit), add or subtract, normalize (leading-zero count, shift), round to nearest even. binary16: 3 755 NANDs, depth 163, normalize & round 2 058 of them.', ['ieee754', 'sticky', 'lzc', 'normalize', 'rounding']),
  E('tristate', 'Tri-state bus', 'component', 'Many drivers on one wire, each through a buffer that drives when enabled and lets go (Z) otherwise; a decoder enables exactly one. Two at once fight (a short), none leaves it floating. TRIBUF: 8 transistors, switch level only. Inside chips a multiplexer does the job.', ['bus', 'mux', 'decoder']),
  E('bin2dec', 'Binary to decimal', 'trick', 'Digits without a divider: subtract 10 000, 1 000, 100, 10 while you can; each count is a digit, at most 32 subtractions for 16 bits. With a multiplier: x / 10 = (x · 52 429) >> 19 for any 16-bit x. In hardware: double dabble.', ['positional', 'shiftadd']),
];
