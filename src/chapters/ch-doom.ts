// Appendix B: real software on our ISA. Doom (doomgeneric, compiled for RV32IM: ports/doom/) on the
// Doom computer's memory map (doom/machine.ts), run by the fast interpreter (riscv/fastiss.ts).

import { doomPlay } from '../widgets/doom';
import { doomGatesScene } from '../widgets/doomgates';
import { doomMemoryMap, doomNeeds, doomProgram } from '../widgets/doominfo';
import { chAppendix6502 } from './ch-6502';
import type { Chapter } from './types';

export const chAppendixDoom: Chapter = {
  // numbered after Appendix A, whatever the journey's length (chapters before it get renumbered)
  id: 'appendix-doom', num: chAppendix6502.num + 1, appendix: 'B', title: 'Doom on our RISC-V', level: 'Software',
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
      'GCC (<code>-march=rv32im -mabi=ilp32 -O2</code>) and newlib give 57,889 instruction words. Our CPUs are Harvard machines, so only code goes in the ROM; constants, tables and jump tables go in RAM.',
      'The top four address bits choose the memory: RAM at 0, the WAD (read only) at <code>0x1000_0000</code>, devices from <code>0x8000_0000</code>, the frame buffer from <code>0xC000_0000</code>. A load of <code>KEY</code> removes the event it returns, so the data port gains a read strobe.',
      'Game time is <code>mtime</code>, which counts clock cycles, at a nominal 40 MHz: a slower machine plays slower, never differently.',
      'A frame is about 1.9 M cycles: 48 ms at 40 MHz, about 13 minutes on the gate-level CPU in this page, about 8 ms for the same gates on silicon at their 4 ns period.',
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
        memory. Doom (id Software, 1993; the source released in 1997) is the other kind: about 65 000 lines of C written for
        a 386 PC, with no idea what runs it. Can our ISA run it unchanged?</p>
        <p>The ISA is enough. Doom does its geometry in 16.16 fixed point, so integer multiply and divide are all it
        needs: RV32IM, which the system CPU of <a href="#/c/io/0">chapters 18–20</a> implements. What it lacks is a computer around it:
        megabytes of memory where we have kilobytes, a 256-colour screen, a keyboard that reports releases, and a file
        to read the levels from. The table measures what is needed against what we had.</p>
        <p>The rest of this appendix builds that computer twice: as a fast interpreter of our ISA, to play it, and in
        gates, to check it.</p>`,
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
        leaves four functions to the platform: draw a frame, read a key, read the time, sleep. Five small patches make
        Doom draw into our frame buffer and read the WAD in place. Our CPUs are Harvard machines, so the linker puts
        only code in the ROM and everything Doom reads (constants, tables, jump tables) in RAM.</p>
        <p>The census is of the image itself: a third of the words load or store, one in eleven branches, one in eight
        jumps or calls; multiplies and divides are under one in a hundred. The
        innermost loop of the renderer is <code>R_DrawColumn</code>: one texel fetched, looked up in the light table and
        stored per pixel, down the column.</p>`,
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
        for its 35 game tics a second at a nominal 40 MHz. A slower machine plays slower, never differently.</p>`,
      widget: () => doomMemoryMap(),
    },
    {
      title: 'Play',
      body: `
        <p>This is Doom (1993): the C source of <a href="https://github.com/ozkl/doomgeneric" target="_blank" rel="noopener">doomgeneric</a>
        compiled by GCC with <code>-march=rv32im</code> into 57,889 instruction words, the ISA of the system CPU of <a href="#/c/io/0">chapters 18–20</a>.
        No floats (Doom is fixed point), no compressed instructions, machine mode only.</p>
        <p>The program sees a small computer: 8 MiB of RAM, the game data (a WAD file) mapped read-only at
        <code>0x1000_0000</code>, a 320 × 200 frame buffer of palette indices at <code>0xC000_0000</code>, and three I/O
        registers next to the system CPU's: <code>KEY</code> (a read takes one key event), <code>FLIP</code> (a frame is
        done) and <code>WADLEN</code>. Doom's renderer stores its columns and spans straight into the frame buffer.</p>
        <p>It runs on a fast interpreter of our ISA, not on the gates.</p>
        <details class="deeper"><summary>Deeper: the interpreter</summary>
        <p>Each instruction word is decoded once into a table, then executed by one switch. It has the exact semantics
        (memories, traps, cycle counts) of the instruction-set simulator our CPUs are checked against, and is checked
        against it in lock step on the official riscv-tests, random programs, and Doom's first 1.5 million
        instructions. Game time is <code>mtime</code> at a nominal 40 MHz, so a slower computer plays slower, never
        differently.</p></details>
        <p><strong>Cost.</strong> A frame of the demo takes 1.0–3.0 M cycles (median 1.9 M): 48 ms at 40 MHz. The
        interpreter manages about 90 M instructions a second. The gate-level system CPU in this page manages about
        2,400 cycles a second: one frame would take about 13 minutes. The same gates on silicon, at their static-timing
        period of about 4 ns, would draw it in 8 ms.</p>
        <div class="try">Start the game, then <b>Pause</b> on a wall and press <b>To next pixel</b> a few times:
        each press stops just after an <code>sb</code> into the frame buffer (the listing's line above the PC), and the
        zoom shows the column growing downward.
        <b>Back</b> undoes any step.</div>`,
      widget: () => doomPlay(),
    },
    {
      title: 'Hand it to the gates',
      body: `
        <p>The same program on the circuit: <span data-show="u">the RV32IM system core</span> of
        <a href="#/c/io/0">chapters 18–20</a> with its memories outside it (the instruction ROM on
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
        per thousand cycles.</p>`,
      scene: () => doomGatesScene(),
    },
  ],
};
