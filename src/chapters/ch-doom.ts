// Appendix B: real software on our ISA. Doom (doomgeneric, compiled for RV32IM: ports/doom/) on the
// Doom computer's memory map (doom/machine.ts), run by the fast interpreter (riscv/fastiss.ts).

import { doomPlay } from '../widgets/doom';
import { doomGatesScene } from '../widgets/doomgates';
import { chAppendix6502 } from './ch-6502';
import type { Chapter } from './types';

export const chAppendixDoom: Chapter = {
  // numbered after Appendix A, whatever the journey's length (chapters before it get renumbered)
  id: 'appendix-doom', num: chAppendix6502.num + 1, appendix: 'B', title: 'Doom on our RISC-V', level: 'Software',
  blurb: 'A real C program, Doom, compiled for the RV32IM our system CPU implements: playable, profiled live, and stepped one instruction at a time.',
  steps: [
    {
      title: 'Play',
      body: `
        <p>This is Doom (1993): the C source of <a href="https://github.com/ozkl/doomgeneric" target="_blank" rel="noopener">doomgeneric</a>
        compiled by GCC with <code>-march=rv32im</code> into 57,889 instruction words, the ISA of the system CPU of chapters 18–20.
        No floats (Doom is fixed point), no compressed instructions, machine mode only.</p>
        <p>The program sees a small computer: 8 MiB of RAM, the game data (a WAD file) mapped read-only at
        <code>0x1000_0000</code>, a 320 × 200 frame buffer of palette indices at <code>0xC000_0000</code>, and three I/O
        registers next to the system CPU's: <code>KEY</code> (a read takes one key event), <code>FLIP</code> (a frame is
        done) and <code>WADLEN</code>. Doom's renderer stores its columns and spans straight into the frame buffer.</p>
        <p>It runs on a fast interpreter of our ISA, not on the gates: each instruction word is decoded once into a
        table, then executed by one switch. It has the golden model's exact semantics (memories, traps, cycle counts),
        checked in lock step on the official riscv-tests, random programs, and Doom's first 1.5 million instructions.
        Game time is <code>mtime</code> at a nominal 40 MHz, so a slower computer plays slower, never differently.</p>
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
        <p>The same program on the circuit: the RV32IM system core of chapters 18–20 with its memories outside it
        (the instruction ROM on <code>pcOut → instr</code>, data and I/O on one port with byte enables and a read
        strobe), and around it the Doom computer's memory map in gates: a region decoder on <code>addr[31:28]</code>,
        8 MiB of RAM and a 128 KiB frame buffer as byte banks, the WAD as a ROM tree of 2<sup>23</sup> words, and the
        devices (console, <code>KEY</code> popping its queue on the read strobe, <code>FLIP</code>, <code>WADLEN</code>).
        Every box opens, down to NANDs.</p>
        <p>Start the game in the panel, play a little, then <b>Pause</b> and <b>Run on the gates</b>. The interpreter's
        state goes into the circuit: each register, the PC, the CSRs and the timer bit by bit into both latches of their
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
