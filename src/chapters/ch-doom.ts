// Appendix B: real software on our ISA. Doom (doomgeneric, compiled for RV32IM: ports/doom/) on the
// Doom computer's memory map (doom/machine.ts), run by the fast interpreter (riscv/fastiss.ts).

import { doomPlay } from '../widgets/doom';
import type { Chapter } from './types';

export const chAppendixDoom: Chapter = {
  id: 'appendix-doom', num: 35, appendix: 'B', title: 'Doom on our RISC-V', level: 'Software',
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
  ],
};
