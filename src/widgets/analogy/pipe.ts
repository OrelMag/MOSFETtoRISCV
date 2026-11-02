// DOM-free models of the pipeline figures (handoff, emptyplate, fork). The numbers come from the site's own gate-level
// pipelinedCpu: tests/analogyfigs-f.test.ts runs it and pins every schedule below to the cycle each instruction
// reaches W there.

export const PIPE_STAGES = ['F', 'D', 'E', 'M', 'W'] as const;
const E = 2;

export type Kind = 'alu' | 'load' | 'other';
/** `dep`: the distance to the instruction whose result this one reads (0: none; 1: the one right before). */
export interface Op { name: string; kind: Kind; dep?: number }

export interface Cell {
  instr: number;
  stage: number;
  cycle: number;
  /** A stalled instruction repeats its cell in D (or F) while it waits. */
  held?: boolean;
  /** Fetched on the wrong road: flushed before it changes anything. */
  ghost?: boolean;
}
export interface Handoff { from: { stage: number; cycle: number }; to: { stage: number; cycle: number } }
export interface Sched {
  ops: Op[];
  cells: Cell[];
  /** Cycle each instruction is in W (the cycle after which its result is in the register file). */
  wCycle: number[];
  /** Empty slots behind a stall: the bubbles. */
  bubbles: { stage: number; cycle: number }[];
  cycles: number;
  /** cycles − (instructions + 4): the cost of the hazards. */
  stalls: number;
  hands: Handoff[];
}

/**
 * Cycles an instruction must trail the one it reads in E. With forwarding an ALU result is taken from M into E, one
 * cycle behind (lag 1), and a load's word exists only at the end of M (lag 2). Without it the value is read from the
 * register file, which has it while the producer is in W, the cycle the reader is in D (the W → D bypass): lag 3.
 */
export const eLag = (producer: Kind, forwarding: boolean): number => (forwarding ? (producer === 'load' ? 2 : 1) : 3);

/** In-order five-stage schedule: each stage holds one instruction, a reader waits in D until its operand can reach E. */
export function schedule(ops: Op[], forwarding: boolean): Sched {
  const arr: number[][] = [];
  ops.forEach((op, i) => {
    const a = [0, 0, 0, 0, 0];
    const p = i - (op.dep ?? 0);
    a[0] = i === 0 ? 0 : arr[i - 1][1];
    a[1] = i === 0 ? 1 : Math.max(a[0] + 1, arr[i - 1][2]);
    a[2] = Math.max(a[1] + 1, i === 0 ? 0 : arr[i - 1][3], op.dep && p >= 0 ? arr[p][2] + eLag(ops[p].kind, forwarding) : 0);
    a[3] = a[2] + 1;
    a[4] = a[3] + 1;
    arr.push(a);
  });
  const cells: Cell[] = [];
  arr.forEach((a, i) => {
    for (let st = 0; st < 5; st++) {
      const end = st === 4 ? a[4] + 1 : a[st + 1];
      for (let c = a[st]; c < end; c++) cells.push({ instr: i, stage: st, cycle: c, held: c > a[st] || undefined });
    }
  });
  const last = arr.length - 1;
  const cycles = arr[last][4] + 1;
  const taken = new Set(cells.map((c) => `${c.stage}:${c.cycle}`));
  const bubbles: Sched['bubbles'] = [];
  for (let st = E; st < 5; st++) for (let c = arr[0][st]; c <= arr[last][st]; c++) if (!taken.has(`${st}:${c}`)) bubbles.push({ stage: st, cycle: c });
  // the extra hand: with forwarding a reader in E takes the producer's result from M; without it the reader waits in D
  // for the producer in W
  const hands: Handoff[] = [];
  ops.forEach((op, i) => {
    const p = i - (op.dep ?? 0);
    if (!op.dep || p < 0) return;
    hands.push(forwarding
      ? { from: { stage: ops[p].kind === 'load' ? 4 : 3, cycle: arr[i][2] }, to: { stage: 2, cycle: arr[i][2] } }
      : { from: { stage: 4, cycle: arr[i][2] - 1 }, to: { stage: 1, cycle: arr[i][2] - 1 } });
  });
  return { ops, cells, wCycle: arr.map((a) => a[4]), bubbles, cycles, stalls: cycles - (ops.length + 4), hands };
}

// ---- control hazards ----------------------------------------------------------------------------

/** A branch is resolved in E: the instructions fetched behind it, one in F and one in D by then, are flushed. */
export const BRANCH_STAGE = E;
export const FLUSH_PENALTY = E;

export interface Fork {
  /** Labels of the rows: the branch, then the instructions on the road actually taken. */
  rows: { name: string; ghost: boolean }[];
  cells: Cell[];
  wCycle: number[];
  cycles: number;
  /** Cycles lost against a right guess (0 or FLUSH_PENALTY). */
  lost: number;
  wrong: boolean;
}

const ROAD = { notTaken: ['a', 'b', 'c'], taken: ['x', 'y', 'z'] };

/** One branch and the three instructions of the road that is really taken (`ghost`: the guessed road's, fetched in vain). */
export function fork(guessTaken: boolean, actualTaken: boolean): Fork {
  const real = actualTaken ? ROAD.taken : ROAD.notTaken;
  const guessed = guessTaken ? ROAD.taken : ROAD.notTaken;
  const wrong = guessTaken !== actualTaken;
  const rows: Fork['rows'] = [{ name: 'br', ghost: false }];
  const cells: Cell[] = [];
  const wCycle: number[] = [];
  const line = (i: number, f: number) => { for (let st = 0; st < 5; st++) cells.push({ instr: i, stage: st, cycle: f + st }); };
  line(0, 0);
  wCycle.push(4);
  if (wrong) {
    // fetched at cycles 1 and 2, flushed at the end of cycle 2 (the branch is in E): one reached D, one only F
    guessed.slice(0, FLUSH_PENALTY).forEach((name, k) => {
      rows.push({ name, ghost: true });
      for (let st = 0; st <= FLUSH_PENALTY - 1 - k; st++) cells.push({ instr: rows.length - 1, stage: st, cycle: 1 + k + st, ghost: true });
      wCycle.push(-1);
    });
  }
  const first = wrong ? BRANCH_STAGE + 1 : 1;
  real.forEach((name, k) => {
    rows.push({ name, ghost: false });
    line(rows.length - 1, first + k);
    wCycle.push(first + k + 4);
  });
  const cycles = first + real.length - 1 + 5;
  return { rows, cells, wCycle, cycles, lost: wrong ? FLUSH_PENALTY : 0, wrong };
}
