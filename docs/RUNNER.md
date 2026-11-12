# Appendix D: a game with no program (Bit Runner)

An original video game in counters and gates: no CPU, no ROM, one clock. Approved 2026-11-03 with its mockup
(a private draft). It began as a request to implement Atari's Pong schematic; a check
found no Atari release or permission, and a recreation of a specific game is not something we build. So the game, its
rules and its circuit are new, and the chapter says so. Keep it that way: no ball, bats or net, and nothing transcribed
from an arcade schematic.

## The game

You are one bit. Walls scroll towards you; each has a gate, amber or cyan, and a gate passes only a bit of its own
colour. Three lives. Score ≥ 10: walls twice as fast. ≥ 20 and ≥ 40: narrower gates.

## The circuit

`src/lib/bitrunner.ts` (eight modules of 74xx chips from `lib/ttl.ts`), `src/runner/model.ts` the reference, register by
register, `src/runner/crt.ts` a monitor that knows only sync and video.

- **Raster**: 72 × 52 = 3 744 clocks a frame, 64 × 48 on screen. Our own monitor: a real TV would need 1.13 MHz.
- **No position registers.** The wall counter has period 36 (half a line) and slips by loading 29 instead of 28, once a
  slip frame. The player's counter has a frame's period in lines; up and down load one count either side of 12.
- **Collision** is an AND of video signals at one clock, with an XNOR for the colour.
- **All synchronous, CLR pins off**, so the cycle engine runs it. The cycle engine treats a NAND of constants as constant
  (a 74LS173's CLR is tied off through its inverter).
- **Sheet** (in bitrunner.ts) takes logic and maps it onto NAND packages (74LS00, 10, 20, 04, 86), sharing equal terms.

Cost: 97 chips, 2 648 NANDs (`RB_COST`, pinned by `tests/bitrunner.test.ts`). The mockup estimated ≤ 2 500 and about 35 chips.

## The view

`widgets/runner.ts` (Screen panel: monitor, buttons, the model in lock step on the video pins), `widgets/runnerlayout.ts`:
23 boards of one chip row each, a grid with channels (`BreadboardLayout.channels`), one column on a narrower canvas.

Speed, measured in headless Chrome with software rendering (2026-11-03): 30 frames/s at game speed (the cap), about 77 flat
out. The screen paints every frame, the stage every 200 ms: a whole-stage refresh costs far more than the gates.

`view/bbwires.ts` draws every board's jumpers from the netlist (every scene with `Scene.breadboard`, Appendix C too).
Without channels a net is a tree of arcs; with channels each board's pins join locally and a net crossing boards runs as a
harness in the channels.

## Later, if wanted

A Sandbox example, an FPGA export, and giving Appendix C's boards channels as well (its bus strip needs thought).
