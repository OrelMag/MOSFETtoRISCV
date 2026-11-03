// Chapters 19 and 20, deepened: what an I/O register is (and the clock as one), polling against interrupts measured on
// the golden model, nested interrupts, the vectored trap target, and an interrupt controller that latches a request.
// Stand-alone circuits (lib/intc.ts) sit beside the system CPU, which is unchanged.

import { INTC4, IntcModel, TRAP_UNIT, VECTOR_TARGET, vectorTargetOf } from '../lib';
import { assemble } from '../riscv/asm';
import { cpuState } from '../riscv/cosim';
import { ISS } from '../riscv/iss';
import { crossover, runPollIrq } from '../riscv/pollirq';
import { SYSTEM_PROGRAMS } from '../riscv/sysprograms';
import { stats } from '../sim/stats';
import { cpuScene } from '../widgets/cpupanel';
import { pollIrqWidget } from '../widgets/pollirq';
import type { Stage } from '../view/stage';
import type { Step } from './types';

const sys = (id: string) => SYSTEM_PROGRAMS.find((p) => p.id === id)!.source;
const nd = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const reg = (st: Stage, i: number): number => { try { return st.sim ? cpuState(st.sim).x[i] : -1; } catch { return -1; } };
const hex = (n: number, w = 8) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

/** What a store of a given size does to an I/O register, and what a load returns, run on the golden model. */
export function ioProbe(store: 'sb' | 'sh' | 'sw', value: number, offset: number): { leds: number; cmp: number; console: string } {
  const iss = new ISS(assemble(`        li   a0, 0x80000000
        li   t0, ${value}
        ${store}   t0, ${offset}(a0)
        j    done
done:   j    done`).words, { system: true, mmio: true } as never);
  for (let i = 0; i < 8; i++) iss.step();
  return { leds: iss.leds, cmp: iss.mtimecmp >>> 0, console: iss.console };
}

/** The pending bit's timeline for one pulse on source 1 while a handler runs (cycles 0..8, interrupts masked): when it is served. */
export function latchedPulse(): { bareServed: boolean; servedAt: number; pendingFrom: number } {
  const m = new IntcModel(4);
  let servedAt = -1, pendingFrom = -1;
  for (let c = 0; c < 20; c++) {
    const src = c === 3 ? 2 : 0;
    const handlerDone = c >= 9;
    const top = m.top(15);
    const claim = handlerDone && top.v && servedAt < 0 ? 1 : 0;
    if (claim) servedAt = c;
    m.edge(src, 15, claim);
    if (m.pend && pendingFrom < 0) pendingFrom = c + 1;
  }
  return { bareServed: false, servedAt, pendingFrom };
}

const SB_CMP = ioProbe('sb', 0x2a, 20), SH_CMP = ioProbe('sh', 0x1234, 20), SW_CMP = ioProbe('sw', 0x1234, 20);
const SB_LED_OFF = ioProbe('sb', 0xab, 5);
const NAND_VEC = nd(VECTOR_TARGET), NAND_INTC = nd(INTC4);
const LP = latchedPulse();

// ---- chapter 19 ---------------------------------------------------------------------------------------------

export const IO_MORE: Step[] = [
  {
    title: 'Reading the clock',
    body: `
      <p>The simplest input that changes by itself is the <span data-show="io">clock register</span>: <code>mtime</code>, at <code>0x8000_0010</code>, counts one per cycle.
      Reading it is a plain <code>lw</code>; nothing about the read changes it. A program that needs "do this in 40 cycles" can <strong>poll</strong>:
      read the clock, compare with a deadline, branch back, again and again. This one prints a dot every 40 cycles and does nothing else.</p>
      <p>The deadline is the previous deadline plus 40, not "now plus 40", so the dots do not drift. The loop is <code>lw</code> and <code>bltu</code>, two cycles, so the
      clock is looked at every second cycle: the read that first sees <code>mtime ≥ deadline</code> is 0 or 1 cycles late, and the dot reaches the console 3 or 4 cycles after the
      deadline (3 here: the compare falls through, <code>li</code>, then the store). Polling quantises time to the length of the loop that does it, and during
      the 40 cycles the core can do nothing else. <a href="#/c/traps/0">Chapter 20</a> measures what that costs against <span data-ahead="interrupts">an interrupt (the hardware jumps to a software handler when a device asks)</span>.</p>
      <div class="try">Run the clock and watch mtime in the I/O panel, the loop at pc 12 and 16, and the dot.</div>`,
    scene: () => cpuScene({ source: sys('poll'), system: true, highlight: ['io'] }),
    tour: {
      beats: [
        { title: 'Set up', reset: true, cycles: 3, show: ['io'], expect: { pcOut: 12, consoleValid: 0 },
          say: '<p>The first deadline is the clock as read at cycle 2, plus 40: 41. The loop starts at pc {v:pcOut}.</p>' },
        { title: 'Spin', cycles: 2, show: ['io'], expect: { pcOut: 12 },
          say: '<p>Read the clock, compare, branch back: two cycles, pc {v:pcOut} again. The register has no side effect, so reading it as often as you like costs only cycles.</p>' },
        { title: 'Due', cycles: 38, show: ['io'], expect: { pcOut: 20, consoleValid: 0 },
          say: '<p>The read at cycle 42 returns 41: the compare no longer branches back. pc = {v:pcOut}, the <code>li</code> of the character.</p>' },
        { title: 'The dot', cycles: 1, show: ['io'], expect: { pcOut: 24, consoleValid: 1, consoleData: 46 },
          say: '<p>The store reaches the console: consoleData = {v:consoleData}. mtime is 44: three cycles after the deadline, none of them used for anything else.</p>' },
      ],
    },
    more: {
      derive: `<p>With a loop of L cycles between reads, the first read at or after the deadline is 0 … L − 1 cycles late (here L = 2). Add the instructions between the read and the store (compare, <code>li</code>, the store) and the latency is a fixed part plus up to L − 1: the cost of polling is paid twice, once as the cycles spent looking, once as the delay.</p>`,
      pitfall: `<p>Comparing with <code>==</code> instead of ≥ misses the deadline when a read lands one cycle past it, and waits for the 32-bit counter to wrap (2³² cycles: 43 s at 100 MHz). Timers are compared with an unsigned ≥, or by the difference <code>mtime − start</code>.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'The wait loop is <code>lw</code> + <code>bltu</code>, two cycles per round. The deadline passes at an arbitrary cycle. How late can the <code>lw</code> that sees it be?',
      options: ['Up to 40 cycles', '0 or 1 cycles', 'Always exactly 2 cycles', 'Never: reading is instantaneous'], answer: 1,
      why: ['40 is the period of the dots, not of the reads.', '', 'Two cycles is the spacing of the reads, not the lateness: a read can land exactly on the deadline.', 'The read happens at a cycle like any instruction; between two reads the clock moves on by two.'],
      explain: 'The reads are two cycles apart, so one of any two consecutive cycles holds a read: the one that first sees the deadline is at most one cycle past it. The store comes three instructions later whatever the phase.',
    },
  },
  {
    title: 'Registers with side effects',
    body: `
      <p>An I/O address looks like memory and is not. Each register is a wire into a device, and the <span data-show="io">I/O unit</span> here decodes <em>only</em> the word:
      it has no byte enables. A store of any size puts the lane-replicated data on the bus (chapter 19's store unit), and the register takes it whole.
      <code>sb</code> of 0x2A to <code>mtimecmp</code> (0x8000_0014) writes ${hex(SB_CMP.cmp)}; <code>sh</code> of 0x1234 writes ${hex(SH_CMP.cmp)}; <code>sw</code> of 0x1234 writes ${hex(SW_CMP.cmp)}.
      An <code>sb</code> of 0xAB to the LED register at offset 1 still lights the LEDs with ${hex(SB_LED_OFF.leds, 2)}. Software that wants a byte-sized field in a wider register has to read the word, merge and write it back.</p>
      <table class="mini"><tr><th>register</th><th>load</th><th>store</th><th>side effect</th></tr>
        <tr><td>console 0x0</td><td>0</td><td>prints the low byte</td><td>the store <em>is</em> the action: nothing is kept</td></tr>
        <tr><td>LEDs 0x4</td><td>last value</td><td>8 bits kept</td><td>none: a plain register</td></tr>
        <tr><td>switches 0x8</td><td>the pins</td><td>ignored</td><td>none, but the value moves by itself</td></tr>
        <tr><td>mtime 0x10</td><td>the count</td><td>ignored</td><td>none</td></tr>
        <tr><td>mtimecmp 0x14</td><td>last value</td><td>32 bits kept</td><td>a store can end the timer request (mtip falls)</td></tr></table>
      <p>Memory promises that a load returns the last store and that doing either twice is the same as once. A device register promises neither: a store to the console prints every time, so
      repeating it is not idempotent; a status register changes between two loads; and some registers act on a <em>read</em>: a UART's receive register pops the byte, a keyboard queue
      drops its oldest key (the sandbox's keyboard part and chapter 38's key slave work this way), and a request controller's <em>claim</em> register (chapter 20) returns the
      pending source and clears it. So I/O cannot sit behind <span data-ahead="cache">a cache (a small fast copy of recent memory, chapter 22)</span>, loads and stores to it must not be reordered or merged, and a compiler is told so with <code>volatile</code>.
      A pipeline that speculates must not issue such a load early: the chapters' cores only touch I/O at the end of the pipeline for that reason.</p>`,
    scene: () => cpuScene({ source: sys('bytes'), system: true, highlight: ['io'] }),
    more: {
      derive: `<p>Why replication: the memory side has four byte lanes and a store of size s at offset o raises the byte enables of the lanes it covers; the I/O unit is one 32-bit word behind a decoder, so it takes lane 0 of the replicated word for an 8-bit register and the whole word otherwise. A byte store to LEDs (8 bits) and to mtimecmp (32) therefore differ in what is kept: ${hex(SB_CMP.cmp)} against ${hex(SB_LED_OFF.leds, 2)}.</p>`,
      real: `<p>RISC-V platforms specify access widths per device in the memory map and mark the region <em>strongly ordered, non-idempotent</em> (PMAs); the PMP and the page tables carry the same bits. A device that needs a byte write declares it, or its register is wider and the driver does read-modify-write.</p>`,
      pitfall: `<p>A debugger that "shows memory" by reading every word of the I/O range changes the machine: it pops the keyboard queue and claims interrupts. Probes of device registers are explicit.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'A handler runs <code>li t0, 0x1234</code> then <code>sh t0, 20(a0)</code> with a0 = 0x8000_0000 (mtimecmp). What does mtimecmp hold afterwards?',
      options: [hex(SH_CMP.cmp), '0x00001234', '0x12340000', 'It is unchanged: halfword stores to I/O are ignored'], answer: 0,
      why: ['', 'That would need the unit to merge the half into the old word with byte enables; this one has none.', 'The upper half is not selected by the address: the replicated data fills both halves.', 'The unit does not look at the size at all.'],
      explain: `The store unit replicates the halfword into both halves of the bus word and the register, which takes the whole word, loads ${hex(SH_CMP.cmp)}. Measured on the golden model: sb 0x2A gives ${hex(SB_CMP.cmp)}, sh 0x1234 gives ${hex(SH_CMP.cmp)}, sw gives ${hex(SW_CMP.cmp)}.`,
    },
  },
];

// ---- chapter 20 ---------------------------------------------------------------------------------------------

const X6 = crossover(6), X2 = crossover(2), X14 = crossover(14), X30 = crossover(30);
const P40 = runPollIrq('poll', 40, 6, 6000), I40 = runPollIrq('irq', 40, 6, 6000);
const P2000 = runPollIrq('poll', 2000, 6, 6000), I2000 = runPollIrq('irq', 2000, 6, 6000);
const pc = (r: { work: number; cycles: number }) => (100 * r.work / r.cycles).toFixed(1) + ' %';

export const TRAPS_MORE: Step[] = [
  {
    title: 'Polling or interrupting',
    body: `
      <p>Two ways to react to an event that is due every <em>T</em> cycles. <strong>Polling</strong>: the program does a chunk of work, reads <code>mtime</code> and compares, over and over.
      <strong>Interrupt</strong>: the program only works; the timer traps in when the deadline passes. Both programs below are real (assembled, run on the golden model, one cycle per instruction); the work is
      <em>w</em> instructions of <code>addi s0, s0, 1</code>, and the numbers are counted from the run, not estimated.</p>
      <p>Polling costs 2 cycles (<code>lw</code>, <code>bltu</code>) every <em>w</em> + 2, whether or not anything is due: at <em>w</em> = 6 at most ${(600 / 8).toFixed(1)} % of the cycles are work, and
      ${pc(P2000)} measured at T = 2000. The interrupt loop wastes 1 cycle in <em>w</em> + 1 on its jump, so ${pc(I2000)} at T = 2000 (6/7 = 85.7 % at best), but each event costs a
      trap entry, the handler and <code>mret</code>: about ${(I40.overhead / I40.served).toFixed(0)} cycles of overhead per event at T = 40 including the loop's jumps. Interrupts win once events are rarer than
      every ${X6} cycles (<em>w</em> = 6); that threshold grows with the chunk, ${X2} at <em>w</em> = 2, ${X14} at 14, ${X30} at 30, because a longer chunk makes each poll cheaper per cycle of work.</p>
      <p>The other axis is latency. The polling program reacts at its next read: up to ${P40.worst} cycles after the deadline here (a chunk, a read, a compare), and a chunk of a million instructions
      would mean a million. The interrupt is taken at the next instruction boundary: ${I40.worst} cycles from the deadline to the handler's store, whatever the main program is doing. So polling wins
      for rare, tolerant events on a core with nothing else to do; interrupts win on latency, and on work done in between.</p>
      <div class="try">Drag the period down to the point where the two work columns cross, then raise the chunk and watch the crossing move.</div>`,
    widget: pollIrqWidget,
    more: {
      derive: `<p>Over T cycles polling spends 2T/(<em>w</em> + 2) reading the clock; the interrupt version spends T/(<em>w</em> + 1) on its loop jump plus a net <em>H</em> per event: the trap entry and 7 handler instructions against the 5 instructions of the polling version's own service code, about 3 cycles. They are equal at T ≈ <em>H</em>(<em>w</em> + 1)(<em>w</em> + 2)/<em>w</em>: ${X2} at <em>w</em> = 2, ${X6} at 6, ${X14} at 14, ${X30} at 30 as measured (H between 3.0 and 3.5).</p>`,
      real: `<p>On a deeper core the interrupt costs more (a pipeline flush, saved registers: tens to hundreds of cycles) and so does a missed poll's branch; the crossing moves right. Hybrids are common: an interrupt wakes a thread that then polls a fast device in a burst (Linux NAPI for network cards).</p>`,
      pitfall: `<p>Counting only the handler. The interrupt version also pays the register save and restore the handler needs on a real program, and cache misses on the cold handler code: the first execution after a long pause costs far more than the steady-state loop measured here.</p>`,
    },
    challenge: {
      kind: 'quiz', question: `With 6 instructions of work between polls, events every 20 cycles: which version leaves more cycles for work? (The crossing is at ${X6}.)`,
      options: ['Polling: the interrupt overhead per event is larger than the polls it saves', 'The interrupt version: polling is always wasteful', 'They tie', 'Neither: both miss events'], answer: 0,
      why: ['', 'Only while events are rarer than the crossing: every interrupt costs a trap, a handler and an mret.', 'They tie only at the crossing.', 'Both serve every event here; only latency and work differ.'],
      explain: `At T = 20 the handler runs so often that its overhead exceeds the cost of the polls it replaces: ${runPollIrq('irq', 20, 6, 6000).work} cycles of work against ${runPollIrq('poll', 20, 6, 6000).work} for polling, in 6000 cycles. Latency still favours the interrupt (${I40.worst} against ${P40.worst}).`,
    },
  },
  {
    title: 'Nested interrupts',
    body: `
      <p>A trap clears MIE, so a handler cannot be interrupted: the longest handler sets the response time of every other interrupt. The fix is in software. This timer handler takes ~90 cycles of "slow work"; it
      first saves what the next trap would destroy, lets only the more urgent interrupt in, and sets MIE again:</p>
      <ol>
        <li><code>csrr s2, mepc</code>: a nested trap writes mepc (and mcause); without the copy the outer handler could never return.</li>
        <li><code>csrw mie</code> with the external bit only: priority is whatever the handler leaves enabled in <span data-show="csr">mie</span>. Timer ticks cannot nest in themselves.</li>
        <li><code>csrsi mstatus, 8</code>: MIE = 1. From here the IRQ button is taken inside the handler (the nested handler adds the press to s4, and to s5 when it arrived inside the slow handler).</li>
        <li>Before leaving: <code>csrci mstatus, 8</code>, restore mie and mepc, <code>mret</code>. With MIE set during the restore, an interrupt between restoring mepc and mret would overwrite it.</li>
      </ol>
      <p>The hardware saves nothing for the inner trap: its MPIE ← MIE puts the outer handler's "interrupts on" into the one MPIE bit, and the inner <code>mret</code> restores it, so two levels work and the stack of
      saved states is the handler's job. The nested handler uses t1, t3, t4 only; the outer finished with them. A deeper nest has to save more. Cores with many levels (RISC-V CLIC, Arm NVIC) do this stacking and the priority comparison in hardware.</p>
      <div class="try">Run to the slow handler (about 55 cycles after reset) and press IRQ while it spins at pc 108 and 112. s5 counts presses taken inside it.</div>`,
    scene: () => cpuScene({ source: sys('nested'), system: true, highlight: ['csr', 'trap'] }),
    tour: {
      beats: [
        { title: 'Set up', reset: true, cycles: 10, show: ['csr'], expect: { pcOut: 40 },
          say: '<p>mtvec, the first deadline, mie = timer + external (0x880), MIE on. The loop counts in s0.</p>' },
        { title: 'The timer interrupt', cycles: 35, show: ['csr', 'trap'], expect: { pcOut: 52 },
          say: '<p>Taken at the next boundary: pc = {v:pcOut}, MIE cleared, mepc is the loop instruction. One handler address serves both causes: it reads mcause and branches.</p>' },
        { title: 'Open the door', cycles: 15, show: ['csr'], expect: { pcOut: 112 },
          say: '<p>The handler has copied mepc to s2, moved mtimecmp 200 on, written mie = 0x800 and set MIE. It is now in the slow loop (pc {v:pcOut}), and MIE is 1.</p>' },
        { title: 'The button', set: { irq: 1 }, cycles: 1, show: ['csr', 'trap'], expect: { pcOut: 52 },
          say: '<p>irq = {v:irq}: external, enabled in mie, MIE = 1: a second trap, inside the first. mepc now holds the slow loop (112), MIE and MPIE were pushed again. pc = {v:pcOut}.</p>' },
        { title: 'The inner handler', set: { irq: 0 }, cycles: 10, show: ['io'], expect: { pcOut: 112, leds: 255 },
          say: '<p>Dispatch on mcause, toggle the LEDs ({v:leds}), count the press, <code>mret</code>: back in the slow loop at pc {v:pcOut}. The outer handler never noticed.</p>' },
        { title: 'The outer finishes', cycles: 67, show: ['csr'], expect: { pcOut: 48, leds: 255 },
          say: '<p>The slow loop ends, MIE off, mie and mepc restored from s2, <code>mret</code>: pc = {v:pcOut}, the main loop where the tick found it. Timer ticks, presses and nested presses are in s1, s4 and s5.</p>' },
      ],
    },
    more: {
      derive: `<p>Depth 2 costs the outer handler 5 instructions of ceremony before the slow work and 5 after (save mepc, load mie, write mie, set a flag, set MIE; clear MIE, restore mie, restore mepc, count, mret), and an urgent interrupt waits at most ~4 instructions (the time to reach <code>csrsi</code>) instead of the whole handler. A press that lands while MIE is 0 is not lost if the line is held; the one-cycle button here must land in the window, which is why the next step adds a request latch.</p>`,
      pitfall: `<p>Forgetting to save mepc: the nested trap overwrites it and the outer <code>mret</code> returns into the inner handler's interrupted instruction, so the main loop is skipped or repeated, silently. The same for mcause if the outer handler reads it after the window opens.</p>`,
    },
    challenge: {
      kind: 'reach', goal: 'Get the IRQ button taken inside the slow timer handler (s5 = 1).',
      check: (st) => reg(st, 21) >= 1,
      hints: ['The window is the slow loop: from about cycle 55 to 138 after reset, at pc 108 and 112.', 'Pulse to the slow loop, then press IRQ (one cycle) in the I/O panel.'],
      answer: 'Run ~60 cycles after reset, until the pc alternates between 108 and 112, press IRQ for one cycle, then let it finish: s4 = 1 and s5 = 1.',
      solve: (st) => { st.powerCycle(); st.runCycles(60); st.setInputs({ irq: 1 }); st.runCycles(1); st.setInputs({ irq: 0 }); st.runCycles(100); },
    },
  },
  {
    title: 'Vectored traps',
    body: `
      <p>With <code>mtvec</code> MODE = 0 every trap lands on BASE and the handler's first job is to read mcause and branch, as the nested handler just did (4 instructions, 4 cycles before the real work).
      MODE = 1 does the dispatch in hardware: <strong>an interrupt with code <em>n</em> jumps to BASE + 4<em>n</em></strong>, exceptions still to BASE. BASE then holds a table of one-instruction slots, typically <code>j handler_n</code>.</p>
      <p>The <span data-show="vec">vector logic</span> is small because BASE is aligned: for 16 causes the table is 64 bytes, so BASE[5:2] is zero and the offset is ORed in, not added. It is an AND of mtvec[0]
      and mcause[31] (an interrupt in vectored mode), four ANDs that gate mcause[3:0] with it, four ORs into BASE[5:2], and the rest of BASE passes through: ${NAND_VEC} NANDs, one gate delay for the AND and two for the OR. For the timer
      (mcause 0x8000_0007, code 7) with mtvec = 0x1001 the target is ${hex(vectorTargetOf(0x1001, 0x80000007), 4)}; for the external interrupt (code 11) ${hex(vectorTargetOf(0x1001, 0x8000000b), 4)}; an ecall (cause 11, no interrupt bit) goes to ${hex(vectorTargetOf(0x1001, 11), 4)}.</p>
      <p>The system CPU of chapters 19 and 20 keeps MODE wired to 0 and its trap unit is unchanged; this block is what a vectored core adds in front of the PC multiplexer, and it is checked against the formula for random mtvec and mcause.</p>
      <div class="try">Set mtvec = 0x1001 and mcause = 0x8000000B: the target reads 0x102C. Clear mtvec bit 0 and it falls back to 0x1000.</div>`,
    scene: () => ({ root: VECTOR_TARGET, inputs: { mtvec: 0x1001, cause: 0x80000007 } }),
    tries: [(st) => st.getInput('cause') === 0x8000000b && st.getInput('mtvec') === 0x1001],
    more: {
      derive: `<p>target = BASE | (MODE ∧ int ? code << 2 : 0). The OR equals the sum only because BASE[5:2] = 0, which is the architectural alignment rule for vectored tables; a table placed unaligned would add, with a 4-bit incrementer's worth of carry. Saved per interrupt: the load of mcause, the compare and the branch, ~4 cycles of 1-cycle instructions; on a deep pipeline the mispredicted indirect jump of a software dispatch costs more.</p>`,
      real: `<p>Rocket and CVA6 implement vectored mtvec; Ibex does for interrupts only, with a 32-entry table at BASE + 4<em>n</em>. Embedded Arm cores always use a table, one word per exception number, loaded by the hardware.</p>`,
      pitfall: `<p>The vector table slots are 4 bytes, so each is one <code>j</code> (±1 MiB) or a compressed jump; a handler that is further away needs a trampoline. And mcause for a synchronous exception has bit 31 clear: an ecall never indexes the table.</p>`,
    },
    challenge: {
      kind: 'quiz', question: `mtvec = 0x2001 (BASE 0x2000, MODE 1). The machine external interrupt (mcause 0x8000000B) arrives. Where does the PC go?`,
      options: [hex(vectorTargetOf(0x2001, 0x8000000b), 4), '0x2000', '0x2002', '0x2001'], answer: 0,
      why: ['', 'That is the direct-mode target, or an exception in vectored mode.', 'MODE is bit 0 and the offset is 4 × the code, not code.', 'The MODE bit is not part of the address: BASE = mtvec & ~3.'],
      explain: `Interrupt code 11, vectored: BASE + 4 · 11 = ${hex(vectorTargetOf(0x2001, 0x8000000b), 4)}.`,
    },
  },
  {
    title: 'A request that waits',
    body: `
      <p>The button of the last steps is a <em>bare line</em>: mip.MEIP is the wire itself, so a press that comes while MIE = 0 and ends before the handler returns is lost. A real device keeps its request up until
      software clears it, and for sources that only pulse (an edge from a pin, a one-cycle strobe) the controller must remember. That is the job of an <strong>interrupt controller</strong> (RISC-V's PLIC is the
      model): one <span data-show="pend0 pend1 pend2 pend3">pending flip-flop per source</span>, set when its request is seen at a clock edge and held; an <span data-show="req0 req1 req2 req3">enable mask</span>;
      a <span data-show="pri">priority encoder</span> that offers the highest enabled pending source on <code>irq</code> and <code>id</code>; and a <strong>claim</strong> that clears the bit it names, so a source is
      served once per request (the PLIC returns the id from a load of its claim register, which is exactly the side-effect read of chapter 19).</p>
      <p>${NAND_INTC} NANDs for 4 sources, against ${nd(TRAP_UNIT)} for the whole trap unit. One pulse on source 1 at cycle 3 while a handler runs with interrupts masked until cycle 9: the bare line loses it; here the pending bit
      is set at cycle ${LP.pendingFrom} and the request is claimed at cycle ${LP.servedAt}, ${LP.servedAt - 3} cycles after the pulse, exactly once. Two sources pending at once are served highest index first. A source still high when its bit is claimed
      sets it again at the next edge: level sources must be cleared at the device first, as with any interrupt.</p>
      <p>This controller is not wired into the system CPU: that would need a claim register in the I/O unit and a trap-taken output, i.e. a new CPU. Here it is a block of its own, drawn and simulated at gate level; its model is
      checked against it every cycle.</p>
      <div class="try">Pulse source 1 for one cycle (set src = 0010, Pulse, set it back to 0): pend keeps bit 1 and irq stays high until claim = 1.</div>`,
    scene: () => ({ root: INTC4, inputs: { src: 0, en: 15, claim: 0 }, autoClock: false, highlight: ['pri', 'dec'] }),
    tour: {
      beats: [
        { title: 'A pulse', reset: true, set: { src: 2, en: 15, claim: 0 }, cycles: 1, show: ['pend1', 'pri'], expect: { pend: 2, irq: 1, id: 1 },
          say: '<p>Source 1 is high at a rising edge: its pending flip-flop sets. pend = {b:pend}, irq = {v:irq}, id = {v:id}.</p>' },
        { title: 'The line drops', set: { src: 0 }, cycles: 2, show: ['pend1'], expect: { pend: 2, irq: 1 },
          say: '<p>The source is gone and the request stays: the hold path (pending ∧ ¬claimed) feeds the flip-flop back. A bare line would read 0 now.</p>' },
        { title: 'A higher source', set: { src: 4 }, cycles: 1, show: ['pend2', 'pri'], expect: { pend: 6, id: 2 },
          say: '<p>Source 2 arrives; both are pending, and the priority encoder offers the higher: id = {v:id}.</p>' },
        { title: 'Claim', set: { src: 0, claim: 1 }, cycles: 1, show: ['dec', 'go'], expect: { pend: 2, id: 1 },
          say: '<p>claim ∧ irq enables the decoder on id 2: only that source\'s hold is cut. pend = {b:pend}; source 1 is next, id = {v:id}.</p>' },
        { title: 'Claim again', cycles: 1, show: ['dec'], expect: { pend: 0, irq: 0 },
          say: '<p>The second claim empties the controller: irq = {v:irq}.</p>' },
        { title: 'Masked', set: { claim: 0, src: 8, en: 7 }, cycles: 1, show: ['req3'], expect: { pend: 8, irq: 0 },
          say: '<p>Source 3 is pending but not enabled: irq = {v:irq}. The request waits until the mask opens, and is not lost.</p>' },
      ],
    },
    more: {
      derive: `<p>pend<sub>i</sub>' = src<sub>i</sub> ∨ (pend<sub>i</sub> ∧ ¬(claim ∧ irq ∧ id = i)); irq = ∨ (pend<sub>i</sub> ∧ en<sub>i</sub>); id = the highest such i. A request seen at an edge is held, so the latency from a pulse to irq is one edge. A pulse shorter than a clock period between two edges is missed by this synchronous version; a latch on the asynchronous input (an SR latch set by the pin) catches it, at the price of a clock-domain crossing to handle.</p>`,
      real: `<p>The PLIC adds per-source priorities (a threshold per hart: only requests above it interrupt), a claim/complete register pair, and one pending bit per source read by software. The CLIC and Arm's GIC add preemption levels, so nesting needs no software mie juggling.</p>`,
      pitfall: `<p>Claim without clearing the device. For a level source (a UART with data in its FIFO) the line is still high at the next edge, the bit is set again and the handler runs forever. Clear the source in the device, then complete.</p>`,
    },
    challenge: {
      kind: 'reach', goal: 'Make the controller hold a request after the source has dropped: pend bit 1 set with src = 0.',
      check: (st) => (st.value('pend') & 2) !== 0 && st.getInput('src') === 0,
      hints: ['Set src bit 1, Pulse once (the edge must see it), then set src back to 0.'],
      answer: 'src = 0010, one Pulse, src = 0000: pend = 0010 and irq stays 1 until claim = 1 is pulsed.',
      solve: (st) => { st.setInputs({ src: 2, en: 15, claim: 0 }); st.pulse(); st.setInputs({ src: 0 }); },
    },
  },
];
