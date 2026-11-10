# Plan: Appendix E, the Manchester Baby (SSEM, 1948)

Status: **APPROVED by the author on 2026-11-10, with decisions E1–E7 as recommended.** Mockup:
`E:/mockups/baby/baby-mockup.html` (https://claude.ai/artifact/2nBW9rww1zXjRqfx4dZny1). Id `appendix-baby`, after
`appendix-runner` and before the AGC (Appendix F).

## Decisions

| # | Decision |
|---|---|
| E1 | A word-wide machine in gates; the 1948 bit-serial subtractor as a step of its own beside it |
| E2 | The store is a Williams tube (charge, leak, regeneration); CI / PI and A are registers labelled as the tubes they were |
| E3 | Leak counted in beats, not wall-clock time; inside a spot, SwitchSim's charge and leak (the DRAM chapter's) |
| E4 | Kilburn's routine run to the end on the gates in lock step with the golden model; a progress bar; a "1948 speed" option |
| E5 | Digit 0 on the left, as the display tube and the notebook; a toggle for our order |
| E6 | Both notations: the notebook's ("−24 to C") beside the replica's (LDN 24) |
| E7 | The sandbox example and a Custom ISA table as a later stage |

## Stages (a tip each)

1. Golden model (`src/ssem/`: isa, asm, iss, programs) and the machine in gates (`lib/baby.ts`), lock step, sourced timing. ✅
2. The appendix: steps, the main scene with the Baby panel (store face, beats, listing, golden model), run to the end.
3. Inside the tube: a spot at switch level with leak and the regenerator; the serial subtractor; the CRT model with a pick-up plate.
4. Sandbox example, Custom ISA table, CPU drawer.

## Numbers and where they come from

- Kilburn's amended routine on 2^18: 2 097 154 instructions, answer 131 072 in line 27 (measured; Napper: "about 2.1 million").
  Store accesses 3 801 090 counting a fetch and an operand for every function but CMP and STP (Napper: "about 3½ million").
- Gates: 22 697 NANDs (1024-digit store included), four beats an instruction, 8 388 616 beats for the run, about 37 000 beats/s on
  the cycle engine in Node (measured): about 4 minutes.
- Digit period 8.5 µs (Kilburn, report of December 1947, §5.4); a beat of 36 digits = 306 µs; 1.224 ms an instruction.
  Burton's replica manual assumes 10 µs digits (1.44 ms). Reported run time: 52 minutes.
- Charge held "of the order of 0.2 seconds", regenerated "at a frequency greater than 5 cycles/second" (Kilburn 1947,
  summary): 654 beats. The store is refreshed every 16 instructions (Digital60, "Refreshing process"): 64 beats, 19.6 ms.

## Sources

- G. C. Tootill, notebook, "Kilburn Highest Factor Routine (amended)", 18 July 1948 (Computer50, mark1/firstprog.html).
- C. P. Burton, The Manchester University Small-Scale Experimental Machine Programmer's Reference Manual, Issue 2, 1997.
- T. Kilburn, A Storage System for use with Binary Digital Computing Machines, report, December 1947 (Computer50).
- B. Napper, The Baby, Computer50 (1998–99); and in Rojas and Hashagen (eds.), The First Computers, MIT Press, 2000.
- S. H. Lavington, A History of Manchester Computers, 2nd ed., BCS, 1998.
- F. C. Williams, T. Kilburn, G. C. Tootill, "Universal high-speed digital computers: a small-scale experimental machine",
  Proc. IEE 98 (II), 1951.
- Digital60, The Williams-Kilburn Tube: Refreshing process (University of Manchester).
