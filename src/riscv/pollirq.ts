// Chapter 20's "Polling or interrupting": the same job both ways on the golden model. Every `period` cycles an event
// is due (mtime ≥ a deadline); the program meanwhile counts work in chunks of `chunk` instructions. Polling reads the
// clock after each chunk; the interrupt version takes a timer interrupt. Cycles, work and latency are measured by
// running the programs (system-mode ISS: one cycle per instruction), not computed from a formula.

import { assemble } from './asm';
import { ISS } from './iss';

export type Style = 'poll' | 'irq';

export function pollIrqSource(style: Style, period: number, chunk: number): string {
  const work = Array.from({ length: chunk }, () => '        addi s0, s0, 1').join('\n');
  if (style === 'poll') {
    return `        li   a0, 0x80000000
        lw   s1, 16(a0)
        addi s1, s1, ${period}
loop:
${work}
        lw   t1, 16(a0)
        bltu t1, s1, loop      # not due yet: back to work
        li   t2, '.'
        sb   t2, 0(a0)         # serve the event
        addi s1, s1, ${period}
        addi s3, s3, 1
        j    loop`;
  }
  return `        la   t0, handler
        csrw mtvec, t0
        li   a0, 0x80000000
        lw   t1, 16(a0)
        addi t1, t1, ${period}
        sw   t1, 20(a0)
        li   t0, 0x80
        csrs mie, t0
        csrsi mstatus, 8
loop:
${work}
        j    loop

handler:
        li   t2, '.'
        sb   t2, 0(a0)         # serve the event
        lw   t1, 20(a0)
        addi t1, t1, ${period}
        sw   t1, 20(a0)
        addi s3, s3, 1
        mret`;
}

export interface PollIrqRun {
  /** Cycles run. */
  cycles: number;
  /** Cycles spent on work: 1 per `addi s0` (s0 counts them). */
  work: number;
  /** Events served, and for each the cycles between the deadline and the console store that served it. */
  served: number;
  latencies: number[];
  /** Largest and mean latency. */
  worst: number;
  mean: number;
  /** Cycles not spent on work. */
  overhead: number;
  /** The first STRIP cycles: w work, o overhead (poll reads, branches, trap entry, handler). */
  strip: string;
  /** The first deadline (mtime). */
  first: number;
}
export const STRIP = 240;

/** Run one style for `cycles` cycles. The first deadline is `period` after the set-up read of mtime. */
export function runPollIrq(style: Style, period: number, chunk: number, cycles: number): PollIrqRun {
  const iss = new ISS(assemble(pollIrqSource(style, period, chunk)).words, { system: true, mmio: true } as never);
  // The first deadline: the clock as the program read it (second instruction after the li pair).
  let first = -1;
  const lat: number[] = [];
  let seen = 0;
  const workWord = assemble('addi s0, s0, 1').words[0];
  let strip = '';
  while (iss.mtime < cycles && !iss.halted) {
    const before = iss.mtime;
    if (first < 0 && iss.mtimecmp !== 0) first = iss.mtimecmp;
    if (first < 0 && style === 'poll' && iss.x[9] >= period) first = iss.x[9] >>> 0; // s1 holds the deadline
    if (strip.length < STRIP) strip += iss.imem[iss.pc >>> 2] === workWord ? 'w' : 'o';
    iss.step();
    if (iss.console.length > seen && first >= 0) {
      seen = iss.console.length;
      lat.push(before - (first + (seen - 1) * period));
    }
  }
  const work = iss.x[8] >>> 0;
  const worst = lat.length ? Math.max(...lat) : 0;
  const mean = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;
  return { cycles: iss.mtime, work, served: lat.length, latencies: lat, worst, mean, overhead: iss.mtime - work, strip, first };
}

/** The shortest event period (searched in steps of 1 from 8) at which interrupts leave more cycles for work than polling. */
const crossMemo = new Map<number, number>();
export function crossover(chunk: number, cycles = 6000): number {
  let c = crossMemo.get(chunk);
  if (c === undefined) {
    c = 8;
    while (c < 2000 && runPollIrq('irq', c, chunk, cycles).work <= runPollIrq('poll', c, chunk, cycles).work) c += c < 40 ? 1 : 10;
    crossMemo.set(chunk, c);
  }
  return c;
}
