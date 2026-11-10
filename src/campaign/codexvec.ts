// Codex entries for the Vectors chapter (chapters/ch-vectors.ts). Same shape as codex.ts; the fuller texts are codexmorevec.ts, the questions
// codexcheckvec.ts, the numbers pinned by tests/content-codexvec.test.ts (against bench/vectorcosts.json, the strip-mining loop and the chaining
// model). No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_VEC: CodexEntry[] = [
  E('vlen', 'Vector length (VLEN)', 'concept', `<b>VLEN</b> is how many bits a vector register holds: the machine's choice, never named in an instruction. <b>vl</b> is how many elements the next vector instructions work on: the program asks with <code>vsetvli rd, rs1, e32, m1</code> (“I have rs1 elements”) and the machine answers min(rs1, VLMAX), VLMAX = LMUL · VLEN / SEW, into rd and vl. Our unit: VLEN 128, so 4 elements of 32 bits a register.`, ['stripmine', 'lmul', 'simd']),
  E('stripmine', 'Strip-mining', 'trick', `A loop over n elements that takes vl of them a pass, vl given back by <code>vsetvli</code>, until none is left. The last pass is just shorter: no tail loop. Since the loop never names VLEN, one binary runs on any machine: n = 37 at m1 takes 10 passes and 124 instructions at VLEN 128, 5 passes and 64 at 256, 3 and 40 at 512.`, ['vlen', 'lmul']),
  E('lmul', 'Register grouping (LMUL)', 'concept', `LMUL joins 1, 2, 4 or 8 neighbouring vector registers into one longer register; a group's name must be a multiple of LMUL (at m4: v0, v4, v8 …). Longer groups mean fewer instructions, but fewer names (32 / LMUL) and, in our unit, a beat per register whether its elements are inside vl or not: the 16-element kernel takes 74 cycles at m1, 62 at m2, 56 at m4 and 80 at m8.`, ['vlen', 'stripmine']),
  E('vmask', 'Vector mask', 'concept', `A mask holds one bit per element in v0. A compare writes it (<code>vmslt.vx v0, v8, a1</code>); an instruction written with <code>v0.t</code> changes only the elements whose bit is 1, and <code>vmerge</code> picks one of two sources by it. A branch per element becomes a data operation: no jump and nothing to mispredict, though masked-off elements still take their slot. Our unit keeps a copy of v0's bits in 32 flip-flops (495 NANDs) rather than a third read port on every register slice.`, ['simd', 'simt']),
  E('chaining', 'Vector chaining', 'trick', `A dependent vector instruction starts on its first element group as soon as the producer has written that group, while the producer goes on with the next: the vector form of forwarding. With separate load, shift, add and store units, the six vector instructions of a y = 3·x + y loop body at m8 take 27 cycles chained, 41 overlapped without chaining and 48 one at a time (the Cray-1, 1976, chained).`, ['lmul', 'forwarding']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_VEC: Record<string, string> = {
  vlen: 'vectors', stripmine: 'vectors', lmul: 'vectors', vmask: 'vectors', chaining: 'vectors',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_VEC: Record<string, string[]> = {
  vlen: ['VLEN'],
  stripmine: ['strip-mining', 'strip-mined', 'strip-mine'],
  lmul: ['LMUL', 'register group'],
  vmask: ['vector mask'],
  chaining: ['vector chaining'],
};

/** Ids no campaign level lists yet: the Vectors chapter's. */
export const VEC_AWAITING_LEVELS: ReadonlySet<string> = new Set(Object.keys(TAUGHT_VEC));
