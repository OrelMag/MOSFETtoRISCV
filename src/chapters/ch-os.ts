import { compilePy } from '../lang/compile';
import { PY_PROGRAMS } from '../lang/pyprograms';
import { NREGS, ROOT_OF, SYS, counter, hello, OS_DMEM_K, OS_SLICE, PCB_SIZE, PY_DMEM_WORDS, osImage, privateWord, rogueCsr, spinner2 } from '../riscv/osprograms';
import { captureSwitch, overheadAt, planOf, runOs, tripsOf } from '../riscv/osrun';
import { WALK_CYCLES } from '../riscv/vmprograms';
import { groupDigits } from '../sim/numfmt';
import { OVERHEAD_STEPS, PANEL_SLICES, overheadTable, planWidget, osScene, sliceWidget, SLICES, switchWidget } from '../widgets/os';
import type { Scene } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

const n = groupDigits;
const exitNow = `  li a7, 93\n  ecall\n`;
const writeOnce = (v: number) => `  li a0, ${v}\n  li a7, 2\n  ecall\n${exitNow}`;
const yieldOnce = `  li a7, 3\n  ecall\n${exitNow}`;

/** The numbers the prose quotes, all measured on the golden model running the kernel (tests/content-os.test.ts pins them and holds the model to the gates). */
export interface OsFigures {
  kernelWords: number; kernelBytes: number;
  /** One switch from process A to process B, the timer's: instructions in each phase, in all, and the clock cycles from the interrupt to B's first instruction. */
  saveInstr: number; chooseInstr: number; restoreInstr: number; switchInstr: number; switchCycles: number; switchStall: number;
  /** Cycles from the trap to the mret, for each kind of trip into the kernel. */
  putchar: number; write1: number; write5: number; writeMax: number; yieldTrip: number; exitTrip: number; tickStays: number; tickSwitches: number; stayWalks: number;
  /** Page-table walks a process pays after the kernel gave it the CPU, and the instructions it then runs before the next interrupt. */
  refillWalks: number; sliceUser: number;
  /** Boot: instructions before the first user instruction. */
  bootInstr: number;
  /** Sharing's price at the default slice, in percent of cycles, and the same at the table's shortest and longest slices. */
  slice: number; overhead: number; overheadShort: number; overheadLong: number; overheadAt: number[];
  /** The plan: frames used of the data memory. */
  frames: number; usedFrames: number;
  /** Two Python programs as processes. */
  py: { a: string; b: string; steps: number; cycles: number; switches: number; outA: number; outB: number; calls: number };
}

const PY_A = 'fibloop', PY_B = 'squares';
const pySource = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!.source;
export const pyProcess = (id: string): string => {
  const c = compilePy(pySource(id), { dmemWords: PY_DMEM_WORDS, user: true });
  if (c.error) throw new Error(`os chapter: ${id}: ${c.error.message}`);
  return c.asm;
};

let figs: OsFigures | undefined;
export function osFigures(): OsFigures {
  if (figs) return figs;
  const pair = osImage([counter(1, 6), counter(10, 6)]);
  const sw = captureSwitch(pair);
  const count = (p: string) => sw.filter((f) => f.phase === p).length;
  const first = (src: string, k: number | 'timer', other = exitNow) => tripsOf(runOs(osImage([src, other])), k)[0];
  const stays = tripsOf(runOs(osImage([spinner2, exitNow]), 3000), 'timer').find((t) => t.from === t.to)!;
  const timer = tripsOf(runOs(pair), 'timer')[0];
  const run = runOs(osImage([pyProcess(PY_A), pyProcess(PY_B)]), 400000);
  const over = overheadTable();
  const bootInstr = runOs(pair, 400).who.findIndex((w) => w < 2);
  const usedFrames = planOf(pair).dataFrames.filter((f) => f.owner >= 0).length;
  figs = {
    kernelWords: pair.kernelWords, kernelBytes: pair.kernelWords * 4,
    saveInstr: count('save'), chooseInstr: count('choose'), restoreInstr: count('restore'), switchInstr: sw.length, switchCycles: sw[sw.length - 1].cycles, switchStall: sw[sw.length - 1].cycles - sw.length,
    putchar: first(hello('x'), 1).kernelCycles, write1: first(writeOnce(5), 2).kernelCycles, write5: first(writeOnce(12345), 2).kernelCycles, writeMax: first(writeOnce(-2147483648), 2).kernelCycles,
    yieldTrip: first(yieldOnce, 3, counter(1, 3)).kernelCycles, exitTrip: first(exitNow, 93).kernelCycles, tickStays: stays.kernelCycles, tickSwitches: timer.kernelCycles, stayWalks: stays.userWalks,
    refillWalks: timer.userWalks, sliceUser: tripsOf(runOs(osImage([spinner2, spinner2]), 3000), 'timer')[0].userSteps,
    bootInstr,
    slice: OS_SLICE, overhead: Math.round(1000 * overheadAt(OS_SLICE, 40000, (s) => osImage([spinner2, spinner2], { slice: s })).overhead) / 10,
    overheadShort: Math.round(1000 * over[0].overhead) / 10, overheadLong: Math.round(1000 * over[over.length - 1].overhead) / 10, overheadAt: over.map((o) => Math.round(1000 * o.overhead) / 10),
    frames: 2 ** OS_DMEM_K / 1024, usedFrames,
    py: {
      a: PY_A, b: PY_B, steps: run.steps, cycles: run.cycles, switches: run.trips.filter((t) => t.from !== t.to).length,
      outA: run.byProc[0].split('\n').filter(Boolean).length, outB: run.byProc[1].split('\n').filter(Boolean).length,
      calls: run.trips.filter((t) => t.cause === 8 && t.call === 2).length,
    },
  };
  return figs;
}
const F = osFigures();

const scenes = {
  rogue: (): Scene => osScene({ procs: [rogueCsr, counter(1, 3, 20)], highlight: ['csr', 'trap'], keep: 'folded' }),
  calls: (): Scene => osScene({ procs: [hello('Hi', true), counter(10, 3, 20)], highlight: ['csr', 'trap'], keep: 'folded' }),
  share: (): Scene => osScene({ procs: [counter(1, 6), counter(10, 6)], highlight: ['csr', 'io'], keep: 'open' }),
  spaces: (): Scene => osScene({ procs: [privateWord(7), privateWord(9)], highlight: ['mmu'], keep: 'folded' }),
  python: (): Scene => osScene({ procs: [pyProcess(PY_A), pyProcess(PY_B)], highlight: ['csr', 'mmu'], keep: 'open' }),
};

export const chOs: Chapter = {
  id: 'os', num: numOf('os'), title: 'A tiny operating system', level: 'System',
  blurb: 'Two programs on one CPU: user mode, system calls, the timer, a context switch and a round-robin scheduler, in assembly on the gates of the last chapter.',
  goals: [
    'run a program in user mode and see what it may not do',
    'follow a system call: ecall, the trap, the kernel\'s answer, mret',
    `switch from one program to another: save ${NREGS} registers, load ${NREGS}, change satp, and say what it costs in cycles`,
    'share the CPU with a timer interrupt and a round-robin scheduler, and price the slice',
  ],
  builds: ['vmem', 'traps', 'python'],
  recap: {
    keep: [
      `A process is a program with an address space (a page table, a satp), a saved set of registers and a state, all in a process control block the kernel keeps. The kernel is the machine-mode program that owns the tables, the blocks and the timer: ${n(F.kernelWords)} instructions here.`,
      'User mode may not touch the machine: a machine register is an illegal instruction (cause 2), a page the table does not give it is a page fault (13 or 15), and both end the process, not the machine. Everything the process needs from outside it asks for with ecall: a number in a7, an argument in a0.',
      `A system call is a trap and a return: the CPU saves nothing but the PC, so the kernel's first job is to save the ${NREGS} registers. It cost ${F.putchar} cycles to print one character, ${F.write1} to print a one-digit number (the kernel has no divider and converts by subtraction).`,
      `A context switch saves ${NREGS} registers, picks the next ready block, writes satp, flushes the TLBs and loads ${NREGS} registers: ${F.switchCycles} cycles from the timer interrupt to the next process's first instruction, ${F.switchStall} of them the walk that fetches it.`,
      `The timer decides who runs: mtimecmp is armed one slice ahead at every switch, so a process that never gives up the CPU loses it after ${F.slice} retired instructions. Round robin is the ring of control blocks and a loop that finds the next ready one.`,
      `Sharing has a price in kernel cycles and cold TLBs: ${F.overhead} % of the cycles at a ${F.slice}-instruction slice, ${F.overheadShort} % at ${SLICES[0]} and ${F.overheadLong} % at ${n(SLICES[SLICES.length - 1])}. A long slice wastes less and makes a ready process wait longer.`,
    ],
    practise: ['p_switch'],
    check: [
      {
        question: 'A user program executes csrr t0, mstatus. What does the CPU do?',
        options: ['It takes an illegal-instruction trap (cause 2) into the kernel, which here ends the process', 'It reads mstatus, with the machine bits hidden', 'It takes a page fault on the CSR\'s address', 'It reads zero and carries on'],
        answer: 0,
        explain: 'A CSR is addressed by its number, not through memory, so no page table is consulted. The privilege rule is in the CSR instruction itself: an access to a register above the current mode is illegal, and the trap goes to the machine-mode handler.',
        why: ['', 'There is no partial read: the instruction is refused outright and writes nothing to t0.', 'CSR numbers are not addresses; the page tables only translate loads, stores and fetches.', 'Silently reading zero would let a program learn nothing and believe it knew; the machine says no with a trap.'],
      },
      {
        question: 'Two processes both store to virtual address 0x1000. What decides that they do not overwrite each other?',
        options: ['Each has its own page table, and satp points at the running process\'s root', 'The kernel copies the page at every switch', 'The assembler gives them different addresses', 'The scheduler never runs them in the same slice'],
        answer: 0,
        explain: 'The address is only a key into the running process\'s table. Two tables map the same key to different frames, and a switch changes which table the walker reads (and forgets the cached translations).',
        why: ['', 'Copying would work and would cost thousands of cycles per switch; here a switch changes one register.', 'Both were assembled for the same virtual addresses on purpose: that is the point of the map.', 'Time-slicing alone would not protect: the second process would find the first one\'s data in the same frame.'],
      },
      {
        question: 'The slice is made ten times longer. What happens to the share of cycles the kernel and the TLB refills take, and to the time a ready process waits?',
        options: ['The share falls to about a tenth; the wait grows to about ten times a slice', 'Both stay the same', 'The share falls and the wait falls', 'The share rises, because the timer fires less often'],
        answer: 0,
        explain: 'A switch costs about the same cycles whatever the slice, so with ten times fewer switches per instruction the share is about a tenth. A ready process waits for the other\'s whole slice, so the wait grows with it. Short slices are responsive and wasteful; long slices the opposite.',
        why: ['', 'The cost of a switch does not depend on the slice, but how often it is paid does.', 'The wait is the other process\'s slice, which just grew.', 'Fewer interrupts means fewer switches, so less is paid, not more.'],
      },
    ],
  },
  steps: [
    {
      title: 'One CPU, two programs: what the kernel is for',
      body: `
        <p>Chapter ${numOf('vmem')} gave every program an address space of its own, and ended with the hardware to enforce it. Nothing yet decides <em>which</em> program runs, who builds
        the page tables, or what a program does when it needs the outside world. That is the job of an <strong>operating system</strong>, and its core, the <strong>kernel</strong>: the one program that runs in
        machine mode, with every register and every frame in reach.</p>
        <p>The kernel of this chapter is small enough to read. It is ${n(F.kernelWords)} instructions of assembly (${n(F.kernelBytes)} bytes), written for the CPU of chapter ${numOf('vmem')} and checked
        on its gates, and it does three things. It <strong>protects</strong>: each program runs in user mode behind a page table the kernel built, so the only way out is a trap. It <strong>serves</strong>: a program that wants a
        character on the console or wants to stop asks with <code>ecall</code>. It <strong>shares</strong>: a timer interrupt takes the CPU from a program that does not give it up, and the kernel hands it to the next.</p>
        <p>A running program is called a <strong>process</strong>: its code, its pages, its page table, and the state the kernel keeps for it while it is not running. The widget shows the plan for two. Data memory is ${F.frames} frames of 4 KiB;
        the kernel takes the first for its variables and for the two <strong>process control blocks</strong> (PCBs) and gives each process four: a root table, a second table and two pages of its own. The tables cost as much as the data, which is the
        real price of Sv32 for a process that uses little. Both processes are built for the same virtual map: data at 0x0000 and 0x1000, the kernel's frame visible at 0x2000 but closed to user mode, code at 0x4000. The program ROM is three of its four frames: the kernel's code
        and one for each program.</p>
        <p>The tables in the widget are not drawn from this description. The page was filled by the kernel's own boot code, ${n(F.bootInstr)} instructions run on the golden model, and the widget reads the entries back from memory.</p>`,
      widget: planWidget,
      challenge: {
        kind: 'quiz',
        question: 'Both processes use virtual address 0x1000 for their data. In the plan, where do those two addresses go?',
        options: ['To different frames, because their second tables hold different entries', 'To the same frame, which the kernel swaps at every switch', 'To the kernel\'s frame, which copies the data', 'To the same frame, in turn, because the CPU runs one at a time'],
        answer: 0,
        explain: 'Entry 1 of process A\'s second table names one frame and entry 1 of B\'s names another. The CPU runs one process at a time, but their data lives side by side the whole time, so nothing is copied at a switch.',
        why: ['', 'Swapping frames would cost a page copy at every switch; the tables make it unnecessary.', 'Only the kernel\'s own frame is the kernel\'s, and user mode cannot reach it at all.', 'One CPU at a time says nothing about memory: the frames are separate however the time is divided.'],
      },
    },
    {
      title: 'User mode: what a program may not do',
      body: `
        <p>The kernel starts a process with <code>mret</code>. Chapter ${numOf('traps')} used it to leave a trap handler; here it is the door into the program. Before it, the kernel loads <code>mepc</code>
        with the program's first address, writes the process's <code>satp</code> and leaves <code>mstatus.MPP</code> at its reset value, user mode. <code>mret</code> sets the mode from MPP, jumps to <code>mepc</code>, and the next
        instruction is the process's, fetched through its page table.</p>
        <p>From there the program has two kinds of wall. The <strong>privilege</strong> wall: an instruction that touches machine state, <code>csrr t0, mstatus</code> in the scene, is an illegal instruction and traps with cause 2. The <strong>page</strong> wall: any
        load, store or fetch the page table does not allow is a page fault, 13 for a load and 15 for a store. The kernel's own frame is mapped into every process at 0x2000 with the U bit clear, to make the point: the address translates, the walk finds a valid entry, and the access is refused
        because user mode may not use a supervisor page.</p>
        <p>What the kernel does with the trap is a policy, not a hardware matter. This kernel prints the process's letter, <code>killed</code> and the cause, marks the control block gone and moves on to the next. The scene runs two processes: A prints <em>o</em> and reads mstatus,
        B counts. Run it: the console shows <em>o</em>, the message, and B's numbers, and the privilege shown in the translation panel goes from M to U and back at every trap.</p>
        <div class="try">Run to halt, then read the console: A was stopped at the instruction after "o", and B never noticed.</div>`,
      scene: scenes.rogue,
      lit: 'The CSR unit and the trap logic',
      challenge: {
        kind: 'quiz',
        question: 'The process stores a value to address 0x2000, where the kernel\'s frame is mapped with U = 0. What stops it?',
        options: ['The walk finds the entry, but user mode may not use a supervisor page: a store page fault (cause 15)', 'Nothing: the page is mapped, so the store happens', 'The assembler refuses the address', 'An illegal-instruction trap, because the store is privileged'],
        answer: 0,
        explain: 'Translation succeeded; the permission check on the entry failed. The kernel\'s frame is visible in the page table and closed to user mode, and the fault comes with mtval = 0x2000 and cause 15.',
        why: ['', 'Mapped does not mean allowed: the U bit is part of the entry, and it is clear.', 'The assembler does not know which addresses a process may use; this is decided at run time by the table.', 'A store is an ordinary instruction; what is refused is the page it names, and that is a page fault.'],
      },
    },
    {
      title: 'System calls: ecall with a number in a7',
      body: `
        <p>A process can do nothing but compute. To print, to stop, to give up the CPU it must ask. The request is one instruction: <code>ecall</code> raises a trap with cause 8 ("from user mode"), the number of the service in <code>a7</code> and its argument in <code>a0</code>. That is a convention of this kernel, not of the hardware. It offers four: ${SYS.putchar} puts the low byte of a0 on the console, ${SYS.write} writes a0 as a signed decimal number with the process's letter in front and a new line after, ${SYS.yield} yields the CPU, ${SYS.exit} exits (the number is Linux's, for RISC-V).</p>
        <p>The trap sets <code>mepc</code> to the <code>ecall</code> itself, so the kernel adds 4 before returning, or the process would ask again forever. Between the trap and the <code>mret</code> the kernel needs registers, and the process's are all live, so the first thing the handler does is
        swap <code>t0</code> with <code>mscratch</code>: the CSR holds the address of the running process's control block, and after the swap <code>t0</code> points to it and the process's <code>t0</code> sits in <code>mscratch</code>, safe. Then ${NREGS - 1} stores, one for each other register, and the kernel is free.
        Returning is the same in reverse. Every register of the process comes back as it was, except the one the call answers in.</p>
        <p>What a call costs is the number of instructions between the trap and the return, because the CPU retires one each cycle: <strong>${F.putchar} cycles</strong> for putchar, ${F.yieldTrip} for yield, and ${F.exitTrip} for exit, all dominated by saving and restoring. Writing a number costs <strong>${F.write1}</strong> cycles for a
        single digit, ${F.write5} for five, ${F.writeMax} for −2 147 483 648: the CPU has no divide here (chapter ${numOf('muldiv')} is not in this variant), so the kernel peels off each power of ten by repeated subtraction.</p>
        <div class="try">Step through the first ecall (the CPU panel lists the kernel): watch the console, mepc and mcause in the translation panel.</div>`,
      scene: scenes.calls,
      lit: 'The trap logic and the CSR unit',
      challenge: {
        kind: 'quiz',
        question: 'The kernel returns from a system call without adding 4 to the saved PC. What happens?',
        options: ['The process executes the same ecall again, over and over', 'The process skips the instruction after the ecall', 'The process is killed with an illegal instruction', 'Nothing: mret adds 4 by itself'],
        answer: 0,
        explain: 'A trap leaves mepc at the instruction that trapped (for a fault that is what lets it be retried). mret jumps to mepc as it stands; for an ecall the kernel has to move past it itself.',
        why: ['', 'Skipping happens when the kernel adds 8 or the program is longer than the kernel thinks; here the handler would land on the ecall itself.', 'The ecall is a valid instruction; nothing about running it again is illegal.', 'mret copies mepc into the PC as it is, which is exactly why the kernel adds 4 first.'],
      },
    },
    {
      title: 'The process control block and the context switch',
      body: `
        <p>The CPU has one set of ${NREGS} registers. Two processes each believe they have it. The kernel makes it true by keeping each process's registers in memory while it waits: the <strong>process control block</strong>, ${PCB_SIZE} bytes for each, with the saved PC at offset 0, register <em>n</em> at 4<em>n</em>, then the process's <code>satp</code>,
        its state (ready or gone), the number of slices it has had and the letter it prints. Taking the CPU from one process and giving it to another is a <strong>context switch</strong>, and it is these steps:</p>
        <ol>
          <li><strong>Save</strong> (${F.saveInstr} cycles, the interrupt's own included): the trap handler stores every register and the PC into the running process's block.</li>
          <li><strong>Choose</strong> (${F.chooseInstr} cycles): re-arm the timer one slice ahead, then look round the ring of blocks for the next one whose state is ready.</li>
          <li><strong>Restore</strong> (${F.restoreInstr} cycles): write the new block's <code>satp</code> and run <code>sfence.vma</code> (the cached translations belong to the old address space), put its PC in <code>mepc</code>, load its registers and <code>mret</code>.</li>
        </ol>
        <p>The widget replays one switch from the golden model, an instruction at a time: A's block on the left, the CPU in the middle, B's block on the right. Watch the stores fill A's block while the CPU's registers stay put, then the loads empty B's block into them. Counted in clock cycles: ${F.saveInstr} to save, ${F.chooseInstr} to choose, ${F.restoreInstr} to restore, one for B's first instruction, and ${F.switchStall} more in which the CPU waits for the page-table walk that fetching that instruction needs, because writing <code>satp</code> emptied the TLBs. <strong>${F.switchCycles} clock cycles</strong> from the interrupt to B's first instruction.</p>
        <p>The cost is the register count made visible. A machine with ${NREGS} registers moves ${2 * NREGS} words per switch on top of the bookkeeping. This is why real machines pay attention to how much state a switch has to move, and why a lightweight thread that shares its address space saves the <code>satp</code> write and the refill.</p>`,
      widget: switchWidget,
      more: {
        numbers: `One timer switch (golden model, the gates agree cycle for cycle): ${F.saveInstr} cycles of save, ${F.chooseInstr} of choosing, ${F.restoreInstr} of restoring, one more for B's first instruction; ${F.switchStall} stall cycles for the walk. A timer interrupt that finds nobody else to run ends with the same process: ${F.tickStays} cycles in the kernel against ${F.tickSwitches}, the scan for the next block eating most of what the satp write and the flush would have cost. The saving is after the return: nothing was flushed, so the process pays ${F.stayWalks} walks where the other kind of return pays ${F.refillWalks}.`,
        pitfall: 'Writing satp without sfence.vma, on a machine whose TLB keeps translations, lets the new process use the old one\'s mappings until the entries are replaced. This hardware flushes on a satp write as well; the specification does not promise it, so the kernel writes sfence.vma anyway.',
      },
      challenge: {
        kind: 'quiz',
        question: 'Why does the trap handler start with csrrw t0, mscratch, t0 rather than a store?',
        options: ['It needs one register to hold the control block\'s address, and every register still belongs to the process', 'mscratch is the only register a store may use', 'A store would take a page fault', 'It saves the PC and the registers in one instruction'],
        answer: 0,
        explain: 'A store needs a base register, and the first store cannot clobber any process value. Swapping t0 with the CSR leaves the process\'s t0 in mscratch and the block\'s address in t0; after the other stores the kernel reads t0 back and stores it as well.',
        why: ['', 'Stores can use any register as base; the problem is that every register is full of the process\'s data.', 'The kernel runs in machine mode with no translation, so a store to its own frame cannot fault.', 'One instruction swaps two registers; saving the whole set takes thirty-odd stores.'],
      },
    },
    {
      title: 'Two programs, one CPU: the timer decides',
      body: `
        <p>A system call is the process <em>asking</em> to enter the kernel. The kernel also needs a way in that the process cannot refuse, or a program that never calls would keep the CPU for ever. That is the timer of chapter ${numOf('traps')}: <code>mtime</code> counts, <code>mtimecmp</code> holds a limit, and when the first reaches the second a
        machine timer interrupt is taken. In user mode it is always taken (an interrupt is only held back while the CPU is in machine mode with <code>MIE</code> clear). The kernel arms it with the first process and on every switch: <code>mtimecmp = mtime + slice</code>, ${F.slice} retired instructions here. <code>mtime</code> counts retired instructions, not clock cycles, so the cycles a page walk stalls do not shorten a slice.</p>
        <p>The scene runs the whole machine. Process A counts 1, 2, 3 … in the word at 0x1000 and writes each value; process B counts 10, 20, 30 …; each spins between writes. Neither calls <code>yield</code>. The strip is built from what the gates do every clock edge: the privilege mode, the walker's stall, and the kernel's variable that names the running process. Blue is A, orange is B, grey is the kernel
        and the hatched yellow is the CPU waiting for a page walk; the console takes the colour of whichever process wrote.</p>
        <p>Run it and watch the grey between the long blocks. It is the kernel at work, and here mostly not the switches: every number a process prints is a system call of ${F.write1} cycles and more (step 3), and the programs print every few instructions. A slice gives a process about ${F.sliceUser} of its ${F.slice} instructions, since the timer is armed in the middle of the switch and the rest of the kernel's return counts against the slice. The order on the console is not written anywhere in the programs: the
        timer decided it, which also means it can differ if the slice changes. Try another slice in the panel.</p>
        <div class="try">Pick a ${PANEL_SLICES[0]}-instruction slice and run again: the numbers interleave more finely, and the grey share grows.</div>`,
      scene: scenes.share,
      lit: 'The timer and the privilege logic',
      challenge: {
        kind: 'quiz',
        question: 'Process A is in an endless loop and never calls the kernel. Why does process B still get to run?',
        options: ['The timer interrupt is taken in user mode whatever the process is doing, and the kernel switches', 'The assembler inserts a yield into every loop', `The CPU stops a program after ${F.slice} instructions by itself`, 'A page fault eventually happens and the kernel runs the other process'],
        answer: 0,
        explain: 'mtimecmp was set one slice ahead; when mtime reaches it the interrupt is pending, and with the CPU in user mode it is taken at once. The handler is the kernel\'s, and a process cannot mask it.',
        why: ['', 'Nothing in a program\'s code is inserted by the toolchain here; a loop with no calls stays a loop.', 'The CPU has no notion of a time slice: it only compares two registers and raises an interrupt line.', 'A loop that stays inside its mapped pages never faults; the interrupt is the only thing that ends it.'],
      },
    },
    {
      title: 'Separate address spaces: satp per process',
      body: `
        <p>The counters of the last step both keep their counts in the word at 0x1000, and neither ever sees the other's value. This step makes it the point. The two processes are built from the same source except for a number: each stores its identity (7 and 9) in the word at 0x1000, spins for a while so the other has time to run in between,
        then reads the word back and prints it. If the word were shared, one of them would print the other's number.</p>
        <p>What keeps them apart is one register. Every translation starts at <code>satp</code>, and the kernel writes a different one at each switch: A's points at the root table in frame ${ROOT_OF[0] >>> 12}, B's at the root table in frame ${ROOT_OF[1] >>> 12}. The same virtual address walks two different chains of tables and ends in two different frames. That is the whole mechanism, no copying and no checks in the program.
        The cost is the one the last step measured: a <code>satp</code> write forgets every cached translation, so the process that has just been given the CPU walks again for its code page and its data page, ${F.refillWalks} walks of ${WALK_CYCLES} cycles each in its first slice. Real machines tag each TLB entry with an address-space number so that a switch does not have to flush; this one has none.</p>
        <p>The processes protect each other in the other direction too. A has no entry in its table for B's frames, so there is no virtual address, however wild, with which it can read B's data. The only shared things are the kernel's frame (which user mode may not touch) and the console, which only the kernel writes.</p>`,
      scene: scenes.spaces,
      lit: 'The translation unit',
      challenge: {
        kind: 'quiz',
        question: 'Process A stores 7 at 0x1000 and spins; B stores 9 at 0x1000 and spins; then each reads 0x1000. What does A read?',
        options: ['7: its address 0x1000 is a different frame from B\'s', '9: the last store wins', 'Either, depending on the slice', 'An illegal-instruction trap: two processes wrote the same address'],
        answer: 0,
        explain: 'The two stores went to the frames of two page tables. satp was changed between them, so the walker read a different table each time. Nothing the other process does at 0x1000 reaches A\'s frame.',
        why: ['', 'That would be true if the processes shared a page table; the kernel gave each a root of its own.', 'The slice only changes when each runs, not where its data is; the result is 7 whatever the order.', 'There is no conflict to detect: the same virtual address is not the same location in two spaces.'],
      },
    },
    {
      title: 'What sharing costs',
      body: `
        <p>Everything the kernel does is cycles the processes do not get. Two kinds: the kernel's own instructions (a trap, save, choose, restore, return: ${F.tickSwitches} cycles in the kernel for a timer interrupt that switches) and the cold start of the process it hands the CPU to (the TLBs were emptied, so its first slice begins with ${F.refillWalks} walks).
        Per switch that is about ${F.switchCycles + (F.refillWalks - 1) * WALK_CYCLES} cycles.</p>
        <p>What matters is how often it is paid, and that is the slice. The table runs two processes that only compute for ${n(OVERHEAD_STEPS)} retired instructions at each slice, and counts every cycle the kernel and the walks took after the boot. At ${F.slice} instructions the machine gives away <strong>${F.overhead} %</strong> of its cycles to sharing; at ${SLICES[0]} the kernel eats ${F.overheadShort} %, at ${n(SLICES[SLICES.length - 1])} only ${F.overheadLong} %.</p>
        <p>Why not a very long slice? Because the other side of the trade is <em>latency</em>: a process that is ready waits, in the worst case, for the whole slice of the one that runs, plus the switch. For a program that reads a key and must answer in a few milliseconds that is the budget; for a long computation it does not matter at all. The slice is the one number an operating system gives up on both: it has to be long enough that the processes get done, short
        enough that the user does not notice. Real kernels run the timer at 100 to 1 000 times a second, on CPUs that execute a few billion instructions a second; the slice is millions of instructions and the overhead a fraction of a percent.</p>
        <p>Click a row to see the arithmetic for that slice.</p>`,
      widget: sliceWidget,
      more: {
        real: 'Linux on RISC-V does the same dance: save the registers, pick the next task (a red-black tree rather than a ring), write satp with an address-space number so the TLB need not be flushed, restore, sret. The scheduling tick is typically 250 Hz or 1 000 Hz; tickless kernels turn it off while one task runs alone.',
      },
      challenge: {
        kind: 'quiz',
        question: `The slice is cut from ${n(SLICES[4])} to ${SLICES[2]} instructions. Which is true?`,
        options: ['The kernel and the walks take a larger share of the cycles, and a ready process waits less', 'The kernel takes a smaller share, because each slice does less', 'Nothing changes except the interleaving on the console', 'Both the share and the wait grow'],
        answer: 0,
        explain: `${SLICES[4] / SLICES[2]} times as many switches for the same work, each costing about the same, so the overhead is several times larger (${F.overheadAt[2]} % against ${F.overheadAt[4]} % in the table); but a process waits only one ${SLICES[2]}-instruction slice (plus a switch) for its turn instead of ${n(SLICES[4])}.`,
        why: ['', 'A smaller slice does not make the switch cheaper; it makes it more frequent.', 'The overhead column of the table changes strongly; the interleaving is just the visible part.', 'The wait is the other process\'s slice; shortening it shortens the wait.'],
      },
    },
    {
      title: 'Two Python programs as processes',
      body: `
        <p>Chapter ${numOf('python')} compiled a subset of Python to RISC-V; its programs were alone on the machine, <code>print</code> stored a word into memory and the program ended in a loop. As processes they need two changes, and this chapter adds them as a <strong>target</strong> of the compiler, so that nothing else about it changes. With the target on, <code>print</code> becomes
        the write call (a7 = 2, the value in a0, with a0 and a7 saved on the stack around it because a function's variables may live there) and the end of the program becomes exit (a7 = 93). The compiler's data lives from address 0 up and its stack ends at 0x2000: the two data pages of the process, which the kernel mapped for every process already.</p>
        <p>The scene loads the compiled Fibonacci loop (${F.py.outA} numbers) as process A and the squares (${F.py.outB}) as process B. The golden model runs both in ${n(F.py.steps)} steps and ${n(F.py.cycles)} clock cycles, with ${F.py.switches} switches and ${F.py.calls} write calls, and each process's output
        is exactly what the Python interpreter of chapter ${numOf('python')} prints for it; the tests hold the model to the gates and each program to the interpreter. The console shows them interleaved by the timer.</p>
        <p>A <code>print</code> that was two instructions is now a trap, ${F.write1} to ${F.write5} cycles in the kernel, because the number has to be turned into digits and sent to a device the program cannot touch. The program has not changed; what it means has. That is what an operating system is, in one example.</p>
        <div class="try">Run to halt. Both outputs appear in full, each in its colour, and every line starts with the letter of the process that printed it.</div>`,
      scene: scenes.python,
      lit: 'The privilege logic and the translation unit',
      challenge: {
        kind: 'quiz',
        question: 'Why does the compiler\'s user target save a0 and a7 on the stack around a print?',
        options: ['A leaf function keeps its variables in a0 to a7, and the system call takes both registers for its number and argument', 'The kernel clobbers a0 and a7 on purpose', 'ecall cannot be used without a stack', 'The write call needs the stack to hold the digits'],
        answer: 0,
        explain: 'The kernel restores every register but the answer\'s, but the call convention needs a7 = 2 and a0 = the value at the time of the ecall; the compiler puts them there and has to give back what it overwrote.',
        why: ['', 'The kernel restores every register of the process; the loss is in the compiler\'s own use of them as arguments.', 'ecall needs no stack; the kernel runs on its own and saves into the control block.', 'The kernel converts the digits in registers; the process\'s stack is not involved.'],
      },
    },
  ],
};
