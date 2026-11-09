// What this repository checks its CPUs with, and what that found (docs/VERIFICATION.md, as data for the chapter "How do
// you know it works?"). tests/verify-chapter.test.ts holds FOUND equal to that document's "What this found" table.

export interface CheckLayer {
  name: string;
  /** Who says what the right answer is. */
  oracle: string;
  /** Where it runs here. */
  where: string;
  /** What it is good at finding. */
  finds: string;
  /** What it cannot find. */
  misses: string;
}

export const LAYERS: CheckLayer[] = [
  {
    name: 'Directed programs in lock step', oracle: 'our golden model (riscv/iss.ts), instruction by instruction', where: 'every chapter\'s CPU panel; npm test',
    finds: 'the first instruction whose result differs, on programs someone wrote', misses: 'what no program exercises; a misreading of the specification the model shares',
  },
  {
    name: 'riscv-tests', oracle: 'the tests themselves (self-checking, written by others)', where: 'every CPU in npm test',
    finds: 'one instruction at a time against hand-picked values, including the model\'s own mistakes', misses: 'combinations: two instructions interacting in a pipeline',
  },
  {
    name: 'Random programs', oracle: 'our golden model, final state', where: 'every CPU, seeds 1–32 in npm test, more every night',
    finds: 'interactions nobody thought to write: hazards, stalls, flushes in odd orders', misses: 'what the generator never draws; the model\'s own misreadings',
  },
  {
    name: 'Coverage', oracle: 'none: it counts', where: 'npm test (no gaps allowed)',
    finds: 'what the tests never reached', misses: 'whether what was reached was checked in every combination that matters',
  },
  {
    name: 'Spike', oracle: 'the RISC-V reference simulator, commit by commit', where: 'CI, on every change to the instruction-set model',
    finds: 'mistakes in our golden model, which every other layer trusts', misses: 'anything about the gates (Spike checks the model only)',
  },
  {
    name: 'Synthesized netlists', oracle: 'our gate-level simulation', where: 'CI before every deploy (Yosys)',
    finds: 'Verilog export mistakes: the exported design must equal ours, every output every cycle', misses: 'whether our design is right in the first place',
  },
];

export interface Found {
  where: string;
  bug: string;
  foundBy: string;
  fix: string;
}

/** docs/VERIFICATION.md, "What this found", in order. */
export const FOUND: Found[] = [
  { where: 'Golden model', bug: 'slli / srli / srai with instr[25] set (the RV64 shamt[5]) executed instead of trapping; the system CPU\'s decoder was right', foundBy: 'rv32mi shamt', fix: 'decode compares the whole funct7' },
  { where: 'Golden model and system CPU', bug: 'mvendorid, marchid, mimpid trapped; they are mandatory (may read 0)', foundBy: 'rv32mi mcsr', fix: 'three read-only zero CSRs in both' },
  { where: 'Pipelined RV32IM', bug: 'div / rem with forwarded operands of changing sign gave the wrong sign: the divider latched the magnitudes at start but fixed the sign from the live operands at the end', foundBy: 'rv32um div, rem', fix: 'signs latched with the magnitudes' },
  { where: 'Pipelined RV32IF', bug: 'a taken branch in E while D waited on an FP interlock lost its target: the stall held the PC that the branch had to load', foundBy: 'random programs (5 of 256 seeds)', fix: 'PC enable = not stalled, or taken' },
  { where: 'I-cache generator', bug: 'the instruction cache assumed a 64-word ROM, so a larger program aliased in its tags', foundBy: 'riscv-tests (larger images)', fix: 'sized from the ROM' },
  { where: 'Golden model and system CPU', bug: 'mstatush (RV32\'s upper half of mstatus) missing: accessing it trapped as illegal', foundBy: 'Spike, whose mret writes it', fix: 'read-only zero CSR in both' },
];
