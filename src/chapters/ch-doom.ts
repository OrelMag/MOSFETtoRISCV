// Appendix B: real software on our ISA. Doom (doomgeneric, compiled for RV32IM: ports/doom/) on the
// Doom computer's memory map (doom/machine.ts), run by the fast interpreter (riscv/fastiss.ts).

import { groupDigits } from '../sim/numfmt';
import { doomPlay } from '../widgets/doom';
import { doomGatesScene } from '../widgets/doomgates';
import { doomMemoryMap, doomNeeds, doomProgram } from '../widgets/doominfo';
import { RESULTS } from '../bench/summary';
import type { Chapter } from './types';
import { numOf } from './order';

/** A demo frame's median cycles (scripts/doom/bench.ts). */
const FRAME_CYCLES = 1.9e6;
/** The RV32IM system CPU's static-timing period (src/bench/results.json: NAND delays × ps per NAND), ns, and a frame on silicon, ms. */
const SYS_M = RESULTS.cpus.find((c) => c.id === 'sys-m');
const SYS_NS = ((SYS_M?.period ?? NaN) * RESULTS.psPerNand) / 1000;
const FRAME_MS = Math.round((FRAME_CYCLES * SYS_NS) / 1e6);
/** The gate-level system CPU's speed in this page (cycles a second, as the Play panel quotes it), and the nominal clock. */
const GATE_CPS = 2400, NOMINAL_HZ = 40e6;

export const chAppendixDoom: Chapter = {
  // numbered after Appendix A, whatever the journey's length (chapters before it get renumbered)
  id: 'appendix-doom', num: numOf('appendix-doom'), appendix: 'B', title: 'Doom on our RISC-V', level: 'Software',
  blurb: 'A real C program, Doom, compiled for the RV32IM our system CPU implements: playable, profiled live, and stepped one instruction at a time.',
  goals: [
    'say why RV32IM is enough for Doom, and what a computer must add around the CPU before it runs',
    'follow a C program into our ROM: compiler flags, the C library\'s machine functions, code in ROM and data in RAM',
    'decode an address of the Doom computer from its top four bits',
    'compare the cost of one frame on the interpreter, on the gate-level simulation and on silicon',
  ],
  builds: ['io', 'traps', 'muldiv'],
  recap: {
    keep: [
      'Doom does its geometry in 16.16 fixed point, so integer multiply and divide are enough: RV32IM, the ISA of the system CPU, runs it unchanged. What was missing was a computer: 8 MiB of RAM, a 320 × 200 frame buffer, a key queue and the WAD.',
      'GCC (<code>-march=rv32im -mabi=ilp32 -O2</code>) and newlib give 57 889 instruction words. Our CPUs are Harvard machines, so only code goes in the ROM; constants, tables and jump tables go in RAM.',
      'The top four address bits choose the memory: RAM at 0, the WAD (read only) at <code>0x1000_0000</code>, devices from <code>0x8000_0000</code>, the frame buffer from <code>0xC000_0000</code>. A load of <code>KEY</code> removes the event it returns, so the data port gains a read strobe.',
      'Game time is <code>mtime</code>, which counts clock cycles, at a nominal 40 MHz: a slower machine plays slower, never differently.',
      `A frame is about 1.9 M cycles: 48 ms at 40 MHz, about 13 minutes on the gate-level CPU in this page, about ${FRAME_MS} ms for the same gates on silicon at their ${SYS_NS.toFixed(1)} ns period.`,
    ],
    practise: ['c_computer', 'o_mcore'],
    check: [
      {
        question: 'Why does Doom run on our RV32IM, which has no floating-point unit?',
        options: ['Its geometry is 16.16 fixed point: integer multiply and divide are all it needs', 'The fast interpreter adds the float instructions the gates lack', 'Doom draws flat sprites only, with no geometry to compute'],
        answer: 0,
        explain: 'Doom was written for a 386 PC, which had no floating-point unit of its own, so its renderer works in 16.16 fixed point. The compiler targets <code>-march=rv32im</code>: integer, multiply and divide.',
        why: ['', 'The interpreter has the same semantics as the instruction-set simulator, and the same image runs on the gates, which have no float unit.', 'Doom renders walls and floors in perspective; it computes that geometry in fixed point, with integer multiplies and divides.'],
      },
      {
        question: 'A store goes to address <code>0xC000_0140</code>. Which memory takes it?',
        options: ['The frame buffer', 'The RAM', 'The devices', 'None: the region is read only'],
        answer: 0,
        explain: 'addr[31:28] = 0xC: the frame buffer\'s region, from <code>0xC000_0000</code>. The memory map raises that memory\'s write enable and no other.',
        why: ['', 'The RAM is at 0: a top nibble of 0xC is far above it.', 'The devices start at <code>0x8000_0000</code>, below the frame buffer\'s region at <code>0xC000_0000</code>.', 'The read-only region is the WAD at <code>0x1000_0000</code> (top nibble 1).'],
      },
      {
        question: 'A machine runs our Doom image at 4 MHz instead of 40. What happens?',
        options: ['The game plays ten times slower, tic for tic the same', 'The game keeps real time and drops frames', 'The game runs at full speed: the timer counts real time'],
        answer: 0,
        explain: 'Doom paces its 35 tics a second by <code>mtime</code>, which counts clock cycles and assumes 40 MHz. At 4 MHz each tic takes ten times longer in wall time and computes the same thing.',
        why: ['', 'Doom has no other clock here: <code>mtime</code> counts cycles, so the program cannot tell that it is late.', '<code>mtime</code> counts clock cycles, not seconds: at 4 MHz it advances ten times slower.'],
      },
    ],
  },
  steps: [
    {
      title: 'What a game asks of a computer',
      body: `
        <p>Every program so far was written for our CPUs: a few hundred instructions of assembly, a few dozen words of
        memory. Doom (id Software, 1993; the source released in 1997) is the other kind: about 65 000 lines of C written for
        a 386 PC, with no idea what runs it. Can our ISA run it unchanged?</p>
        <p>The ISA is enough. Doom does its geometry in 16.16 fixed point, so integer multiply and divide are all it
        needs: RV32IM, which the system CPU of <a href="#/c/io/0">chapters ${numOf('io')}, ${numOf('traps')} and ${numOf('muldiv')}</a> implements. What it lacks is a computer around it:
        megabytes of memory where we have kilobytes, a 256-colour screen, a keyboard that reports releases, and a file
        to read the levels from. The table measures what is needed against what we had.</p>
        <p>The rest of this appendix builds that computer twice: as a fast interpreter of our ISA, to play it, and in
        gates, to check it.</p>
        <p>Separating the two questions is the useful move. "Can the CPU execute this program?" is a question about the ISA: which instructions the compiler emits and which
        semantics they need. "Can the computer run it?" is a question about everything outside the CPU: how much memory, how pixels leave, where the data comes from. A CPU
        that answers the first can be wrapped to answer the second without changing a gate of its own.</p>`,
      more: {
        derive: `<p>Why fixed point needs only M. A 16.16 multiply is (a × b) >> 16: the product of two 32-bit values is 64 bits, of which the middle 32 are wanted. RV32M gives the low half with <code>mul</code> and the high half with <code>mulh</code>
          (signed), and a shift and an OR join them, so a fixed-point multiply is a handful of instructions. Divide is a 64-bit C division of the value shifted left 16 (RV32's <code>div</code> takes only a 32-bit dividend), so the compiler calls libgcc's <code>__divdi3</code>, a software routine built on <code>divu</code>, <code>remu</code> and <code>mul</code>. No floating-point unit is involved anywhere, because the 386 the game was written for had none either.</p>`,
        real: `<p>Doom has run on nearly everything with a CPU and a frame buffer: calculators, printers, cameras, oscilloscopes. What it needs is not performance (it ran on a 386 at 33 MHz) but a few megabytes,
          a way to draw 320 × 200 pixels and some input. The porting layer, six functions in doomgeneric, is the real interface between a game and a machine.</p>`,
        pitfall: `<p>Reading "runs Doom" as a statement about the CPU's speed or features. The ISA decides whether the code can execute at all; the memory map decides whether it can start; the clock decides how fast it plays.
          The mistakes this chapter avoids are all of the second kind: forgetting that the WAD must be mapped somewhere, or that a key read must remove the key.</p>`,
        numbers: `<table class="mini"><tr><th>what Doom needs</th><th>size</th></tr>
          <tr><td>screen (palette indices)</td><td>${groupDigits(320 * 200)} bytes (320 × 200)</td></tr>
          <tr><td>RAM</td><td>${2 ** 23 / 2 ** 20} MiB</td></tr>
          <tr><td>WAD region</td><td>${(2 ** 23 * 4) / 2 ** 20} MiB (2<sup>23</sup> words)</td></tr></table>`,
      },
      widget: () => doomNeeds(),
    },
    {
      title: 'From C to our ROM',
      body: `
        <p>The compiler is GNU GCC with <code>-march=rv32im -mabi=ilp32 -O2</code>: no compressed instructions (our
        decoder reads 32-bit words), no floating point, no atomics. The C library is newlib; the dozen and more functions it asks
        of the machine (<code>_write</code>, <code>_sbrk</code>, <code>_open</code> …) are written for this one: a write
        is stores to the console, the heap grows up from the end of the data, and the only file that opens is the WAD
        (Doom's data file: levels, graphics, sounds).</p>
        <p>The source is <a href="https://github.com/ozkl/doomgeneric" target="_blank" rel="noopener">doomgeneric</a>, which
        leaves six functions to the platform: initialize, draw a frame, read a key, read the time, sleep, set the window title. Five small patches make
        Doom draw into our frame buffer and read the WAD in place. Our CPUs are Harvard machines, so the linker puts
        only code in the ROM and everything Doom reads (constants, tables, jump tables) in RAM.</p>
        <p>The census is of the image itself: a third of the words load or store, one in eleven branches, one in eight
        jumps or calls; multiplies and divides are under one in a hundred. The
        innermost loop of the renderer is <code>R_DrawColumn</code>: one texel fetched, looked up in the light table and
        stored per pixel, down the column.</p>
        <p>Why this matters for hardware: the instruction mix is the specification of the CPU the program wants. A third of the words touching memory says the load and store path is the one to make fast;
        jumps and calls at one in eight (branches one in eleven) say the front end matters; multiplies and divides below one in a hundred say a slow multiplier (34 cycles for a divide here) costs little.
        This census counts words in the image, not instructions executed, and a designer wants the second: FixedMul is six words called from 133 places. The Play step's live instruction mix is the number to read before choosing what to spend transistors on.</p>`,
      more: {
        derive: `<p>The image is 57 889 words, ${groupDigits(57889 * 4)} bytes, or ${Math.round(57889 * 4 / 1024)} KiB of code. It does not fit in anything we have drawn: the program ROM of the earlier CPUs held tens of words. The ROM tree here is built from the
          same banks, 2<sup>16</sup> words of them.</p>`,
        real: `<p>Embedded builds put code in flash and run it in place (execute in place, as NOR flash allows), constants in the same flash, and only variables in RAM. Doom's tables are initialized data, so a Harvard design like ours
          copies them from the image into RAM at start; a von Neumann machine need not. The linker script is what decides which section lands where, and it is the file a port spends most of its effort on.</p>`,
        pitfall: `<p>Assuming <code>-O2</code> code looks like what you wrote. Loops are unrolled, inlined and strength-reduced (a multiply by a constant becomes shifts and adds), so an instruction census is a census of what the compiler
          emitted, not of the source. Compare the source of <code>R_DrawColumn</code> with its disassembly before drawing conclusions about the renderer.</p>`,
        numbers: `<table class="mini"><tr><th>instruction class</th><th>share of the image</th></tr>
          <tr><td>load or store</td><td>about a third</td></tr><tr><td>branch</td><td>one in eleven (${(100 / 11).toFixed(0)} %)</td></tr>
          <tr><td>jump or call</td><td>one in eight (${(100 / 8).toFixed(0)} %)</td></tr><tr><td>multiply or divide</td><td>under 1 %</td></tr></table>`,
      },
      widget: () => doomProgram(),
    },
    {
      title: 'The machine',
      body: `
        <p>The computer the program runs on is the system CPU with a memory map: RAM at 0, the WAD at
        <code>0x1000_0000</code>, devices from <code>0x8000_0000</code>, the frame buffer from <code>0xC000_0000</code>.
        The top four address bits choose; a load reads through one 4:1 multiplexer, a store's write enable goes to one
        memory, and the WAD has none: it is read only.</p>
        <p>Three device registers are new. <code>KEY</code> is a queue: a load returns the oldest key event and removes
        it, so the CPU's data port gains a read strobe. <code>FLIP</code> marks a finished frame (the screen shows the
        frame buffer as it was then). <code>WADLEN</code> tells the program how much of the WAD region is file.</p>
        <p>The timer stays inside the core: mtime counts every clock cycle (34 for a divide), and the program reads it
        for its 35 game tics a second at a nominal 40 MHz. A slower machine plays slower, never differently.</p>
        <p>The design rule behind all of it is memory-mapped I/O: a device is an address, and the CPU needs no instruction beyond load and store to use it. That is also what makes the machine
        testable. Every register can be read from a program, every effect of a store is a change in one named memory, and the same map describes the interpreter and the gates.</p>`,
      more: {
        derive: `<p>Decoding: the top nibble addr[31:28] gives 16 regions, of which four are used here. A store's write enable is the AND of the CPU's write strobe and one decoded region line, so exactly one memory sees it;
          a load goes through a 4:1 multiplexer selected by the same nibble. The 8 MiB of RAM is 2<sup>23</sup> bytes of the 2<sup>28</sup> bytes its region could address: 1/32 of it, so the region's upper address bits do not matter to a program that stays inside the RAM.</p>`,
        real: `<p>Every SoC has a memory map like this one: boot ROM, SRAM, DRAM, peripheral blocks, each at a base address, documented in a table that the firmware author knows by heart. Real maps add a distinction we do not need:
          device regions are mapped uncacheable and strongly ordered, so that the hardware cannot reorder or merge accesses to them (the RISC-V physical memory attributes).</p>`,
        pitfall: `<p>A read that removes something. A load from <code>KEY</code> returns the oldest event and pops it, so it must happen exactly once per instruction. A CPU that retries a load, a debugger that
          dumps memory, or a cache that reads a whole line would eat key events. That is the reason for the read strobe, and for keeping <code>KEY</code> out of any cache.</p>`,
        numbers: `<table class="mini"><tr><th>addr[31:28]</th><th>region</th></tr>
          <tr><td>0x0</td><td>RAM, 8 MiB</td></tr><tr><td>0x1</td><td>WAD (read only)</td></tr><tr><td>0x8</td><td>devices: console, KEY, FLIP, WADLEN</td></tr><tr><td>0xC</td><td>frame buffer and palette</td></tr></table>`,
      },
      widget: () => doomMemoryMap(),
    },
    {
      title: 'Play',
      body: `
        <p>This is Doom (1993): the C source of <a href="https://github.com/ozkl/doomgeneric" target="_blank" rel="noopener">doomgeneric</a>
        compiled by GCC with <code>-march=rv32im</code> into 57 889 instruction words, the ISA of the system CPU of <a href="#/c/io/0">chapters ${numOf('io')}, ${numOf('traps')} and ${numOf('muldiv')}</a>.
        No float instructions: the geometry is fixed point, and the few floats elsewhere (a timedemo's fps, config values) go through the compiler's software routines. No compressed instructions, machine mode only.</p>
        <p>The program sees a small computer: 8 MiB of RAM, the game data (a WAD file) mapped read-only at
        <code>0x1000_0000</code>, a 320 × 200 frame buffer of palette indices at <code>0xC000_0000</code>, and three I/O
        registers next to the system CPU's: <code>KEY</code> (a read takes one key event), <code>FLIP</code> (a frame is
        done) and <code>WADLEN</code>. Doom's renderer stores its columns and spans straight into the frame buffer.</p>
        <p>It runs on a fast interpreter of our ISA, not on the gates.</p>
        <p><strong>Cost.</strong> A frame of the demo takes 1.0–3.0 M cycles (median 1.9 M): 48 ms at 40 MHz. The
        interpreter manages about 90 M instructions a second. The gate-level system CPU in this page manages about
        2400 cycles a second: one frame would take about 13 minutes. The same gates on silicon, at their static-timing
        period of ${SYS_M?.period} NAND delays (${SYS_NS.toFixed(1)} ns at ${RESULTS.psPerNand} ps a NAND), would draw it in about ${FRAME_MS} ms.</p>
        <p>The three numbers are three different questions. The interpreter answers "what does the program do?", fast enough to play. The gates answer "what do these circuits do?", slowly enough to watch.
        Silicon answers "how fast could this design go?", and that last figure comes from the same static timing that priced every CPU in the workbench, not from running anything.</p>
        <div class="try">Start the game, then <b>Pause</b> on a wall and press <b>To next pixel</b> a few times:
        each press stops just after an <code>sb</code> into the frame buffer (the listing's line above the PC), and the
        zoom shows the column growing downward.
        <b>Back</b> undoes any step.</div>`,
      more: {
        derive: `<p>A frame is ${(FRAME_CYCLES / 1e6).toFixed(1)} M cycles. At the nominal ${NOMINAL_HZ / 1e6} MHz that is ${((FRAME_CYCLES / NOMINAL_HZ) * 1000).toFixed(0)} ms, ${(NOMINAL_HZ / FRAME_CYCLES).toFixed(0)} frames a second, against the game's 35 tics a second: the
          renderer, not the game logic, is the limit, and Doom skips drawing when it is behind. On the gates, at ${groupDigits(GATE_CPS)} cycles a second, a frame takes ${(FRAME_CYCLES / GATE_CPS / 60).toFixed(0)} minutes: ${groupDigits(Math.round(NOMINAL_HZ / GATE_CPS))} times slower than
          real time at 40 MHz. The interpreter reaches about 90 M instructions a second by decoding each instruction word once into a table and executing it with one switch. It has the exact semantics
          (memories, traps, cycle counts) of the instruction-set simulator our CPUs are checked against, and is checked against it in lock step on the official riscv-tests, random programs, and Doom's first 1.5 million instructions.</p>`,
        real: `<p>This is also how real chips are brought up. Before silicon exists the design runs in an instruction-set simulator (fast, to write software) and in a Verilog simulator or an FPGA (slow or expensive, to check the gates);
          the two are kept in lock step the way this page keeps them. Booting a full operating system on the RTL is the test that finds the bugs the unit tests missed.</p>`,
        pitfall: `<p>Trusting the frame rate of the panel as the machine's speed. The interpreter's speed is the browser's; what the program sees is <code>mtime</code>, which counts the machine's cycles. If the page runs slowly the game
          lags in wall time but not in game time, and a demo recorded on a fast machine replays identically on a slow one. Only a change to the program or to the model's cycle counts changes the game.</p>`,
        numbers: `<table class="mini"><tr><th>platform</th><th>speed</th><th>one frame (${(FRAME_CYCLES / 1e6).toFixed(1)} M cycles)</th></tr>
          <tr><td>nominal 40 MHz</td><td>${NOMINAL_HZ / 1e6} M cycles/s</td><td>${((FRAME_CYCLES / NOMINAL_HZ) * 1000).toFixed(0)} ms</td></tr>
          <tr><td>our gates on silicon</td><td>${(1e3 / SYS_NS).toFixed(0)} M cycles/s</td><td>about ${FRAME_MS} ms</td></tr>
          <tr><td>gates in this page</td><td>${groupDigits(GATE_CPS)} cycles/s</td><td>${(FRAME_CYCLES / GATE_CPS / 60).toFixed(0)} min</td></tr></table>`,
      },
      widget: () => doomPlay(),
    },
    {
      title: 'Hand it to the gates',
      body: `
        <p>The same program on the circuit: <span data-show="u">the RV32IM system core</span> of
        <a href="#/c/io/0">chapters ${numOf('io')}, ${numOf('traps')} and ${numOf('muldiv')}</a> with its memories outside it (the instruction ROM on
        <span data-show="pin:pcOut pin:instr"><code>pcOut → instr</code></span>,
        <span data-show="pin:memAddr pin:memWData pin:memRData pin:memBE pin:memRE">data and I/O on one port with byte
        enables and a read strobe</span>), and around it the Doom computer's memory map in gates: a region decoder on <code>addr[31:28]</code>,
        8 MiB of RAM and a 128 KiB frame buffer as byte banks, the WAD as a ROM tree of 2<sup>23</sup> words, and the
        devices (console, <code>KEY</code> popping its queue on the read strobe, <code>FLIP</code>, <code>WADLEN</code>).
        Every box opens, down to NANDs.</p>
        <p>Start the game in the panel, play a little, then <b>Pause</b> and <b>Run on the gates</b>. The interpreter's
        state goes into the circuit: each register, the PC, the CSRs (control and status registers) and the timer bit by bit into both latches of their
        flip-flops; the RAM, the frame buffer and the key queue into their memories. Then the circuit is clocked while the
        interpreter steps beside it, and after every instruction the PC and all 31 registers are compared; at the end of
        the window all 8 MiB of RAM and the frame buffer too.</p>
        <p><strong>Cost.</strong> The gates run a few thousand cycles a second in this page (the panel measures it): one
        frame of about 1.9 million cycles takes minutes to hours. The pixels they draw glow yellow: a few columns of a wall
        per thousand cycles.</p>
        <p>The comparison is exhaustive in one sense and sampled in another: every instruction in the window is checked against the golden model, in every register, but only a window of the game is
        run, not the whole thing. That is how verification of a large design usually goes: random and directed programs for coverage, and a real workload as the integration test. Doom is a good workload because it
        exercises the multiplier and divider, byte and halfword stores, branches in every direction, and the memory map all at once.</p>`,
      more: {
        derive: `<p>Handing over the state is the delicate part: the interpreter's registers, PC, CSRs and timer must be written into the circuit's flip-flops <em>bit by bit, into both latches of each</em> (master and slave), or the first edge would
          shift an inconsistent state into the slave. The memories are poked directly; the key queue likewise. After that the circuit is clocked, and the compare after each retired instruction is
          a PC and 31 registers, 32 values, with memory differences looked for at the end of the window.</p>`,
        real: `<p>The same flow is used on real designs, at larger scale: run a workload on a fast model, snapshot at an interesting point, load the snapshot into a slow detailed model (RTL simulation, or an FPGA emulator) and
          compare from there. It lets a billion-cycle boot be skipped and only the interesting million be simulated at gate detail.</p>`,
        pitfall: `<p>Reading a matching window as a proof about the whole game. Equality over thousands of instructions says the gates agree with the model on those instructions, and on the paths they exercised. A rarely used
          instruction, a cache-line or page boundary or an interrupt in a particular cycle can sit outside any window. That is why the CPU is also checked on the riscv-tests, fuzzed against random programs and run against Spike.</p>`,
      },
      scene: () => doomGatesScene(),
    },
  ],
};
