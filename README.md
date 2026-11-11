# From Switch to CPU: a RISC-V processor and beyond

An interactive journey from a single MOSFET to a multi-core RISC-V processor laid out on
silicon, and on to a GPU, a memory system, how computers talk from the telegraph to the data centre,
digital signal processing up to a software radio, Doom and a breadboard computer, as a static website.
**[Open it →](https://switchtocpu.com/)** · by Orel Magidish

![Drilling from a 4-bit adder into a full adder, into one NAND, down to its four transistors](docs/images/drill.gif)

Every level is built only from the level below it, and **every box is transparent**: double-click
any part to look inside, all the way down to the MOSFETs. Wire values are computed live by an
event-driven gate-level simulator (one delay unit per NAND, so glitches and races are visible) and
a switch-level transistor solver. Transistor counts, gate counts and critical paths are measured
from the circuits themselves, every CPU is co-simulated against a RISC-V golden model, and the
dual-core and the RV32IM system core are exported as Verilog and taken through Yosys and OpenROAD to
sky130 layouts, whose reports stand beside the site's own area and timing estimates. Verilog goes
both ways: any circuit exports as Verilog, and Verilog written in the sandbox is synthesized by Yosys
in the page into chips that open down to the transistors like everything else.

The default look draws **working gates**: every NAND shows its four CMOS transistors inside its outline,
switching on and off with the live values, so even a CPU-sized drawing still says what each gate is made of.
The View options menu turns it off, and sets the palette, wire thickness, grid, labels and flowing bits.

Four ways in: the **[journey](https://switchtocpu.com/#/c/map/0)** (<!--n:journey-->89<!--/n--> chapters,
<!--n:onramps-->2<!--/n--> on-ramps for newcomers, <!--n:prologue-->3<!--/n--> prologue chapters and <!--n:appendices-->6<!--/n--> appendices), the **[campaign](https://switchtocpu.com/#/campaign)**
(<!--n:levels-->179<!--/n--> levels: build it to unlock it, or fix it), the **[workbench](https://switchtocpu.com/#/workbench/rca4)**
(any component on its own, with statistics, benchmarks and the out-of-order lab) and the
**[sandbox](https://switchtocpu.com/#/sandbox)** (your own circuits, up to whole computers).

## The journey

**<!--n:journey-->89<!--/n--> chapters.** The first <!--n:ch.vectors-->35<!--/n--> run from the MOSFET, the CMOS inverter and NAND, through gates, binary numbers,
adders, multiplexers, latches, registers and memory arrays (a core plane among them), to the ALU, the register file, RV32I
assembly and a single-cycle CPU. Then Python compiled to RV32I by the site's own compiler and run on
those gates, faster adders, pipelining (hazards, forwarding, branch prediction), bytes and
memory-mapped I/O, traps and interrupts, multiply / divide, caches, virtual memory (Sv32 page tables,
a hardware walker that stalls the CPU, two TLBs on chapter <!--n:ch.memory-->10<!--/n-->'s CAM, page faults, M / S / U modes, all in gates
beside the golden model), a tiny operating system (a kernel in assembly with system calls, a timer-driven
round-robin scheduler and a context switch, two programs and then two Python programs sharing one gate-level
CPU in address spaces of their own, every switch counted in cycles), multicycle and microcoded control (and System/360: one instruction set, many machines),
floating point (RV32F), the C extension (an expander in gates in front of the decoder) and RV64 (the
same core at 64 bits, the W instructions, what width costs block by block), a gate-level out-of-order
core (renaming, a reorder buffer, speculation) and a lab to reshape it (width, ports, window sizes, on
the benchmarks, your assembly or your Python, each commit slot accounted for, the window sizes priced
from the gates), many cores (atomics, coherence), place and route on
silicon, the same design on an FPGA (look-up tables, our computer on a Tang Nano 9K), how it is known to work (lock step,
fuzzing, stuck-at faults, scan chains, self-test), side channels (a timing leak, Spectre on our out-of-order model and
what each defence costs) and power (every toggle measured, glitches, a clock gate that cannot glitch on our CPU, leakage from the
circuit's own state, the minimum-energy point) and vectors (RVV: one loop written with `vsetvli` for any
vector length, SEW and LMUL, a four-lane vector unit in gates that takes a long vector in beats, masks,
reductions, chaining, the same kernel priced on vectors, lanes and cores). Four tracks follow: a **GPU** (a lane core,
SIMT warps with divergence, latency hiding, coalescing and banked shared memory, a rasterizer with
depth and blending, and a graphics pipeline whose vertex kernel runs on the warp core), **memory in
depth** (a DRAM at switch level, a DDR-style controller, flash with its translation layer, a bus with
DMA that boots a computer from flash), **communication**, and **signal processing**.

**Communication** (chapters <!--n:comm.first-->46<!--/n--> to <!--n:comm.last-->73<!--/n-->, with an on-ramp, Sending a message) starts from why moving a bit
is harder than computing one, on a telegraph line and a dial exchange of relays. Then the wire: RC,
reflections and termination, metastability and clock crossing, a UART, SPI and I²C. Then the channel:
Fourier, noise and Shannon's limit, modems, FFTs and OFDM, SerDes with clock recovery and the eye, fibre.
Getting it right: CRC, Viterbi, a Reed-Solomon decoder in gates, LDPC against its computed threshold,
PCIe and USB. Networks: an Ethernet MAC, a learning switch, a NIC with a driver, a router's fast path,
TCP, with a network stack written in Python, compiled by the site's compiler
and run on the gates, so that a ping crosses two CPUs and a switch in 12 million NANDs. Keeping it
secret runs from an Enigma M4 in 3D and in gates, through the Bombe, to AES and SHA-256 in gates and a TLS 1.3 handshake run by our CPU. The
path of one page across an invented internet (BGP, DNS, traceroute), radio, Wi-Fi with its timing in
gates, cellular and the data centre close it, and **The expert's bench** ends it: given a symptom, find
the cause, from real faults injected into these models. Where gates would teach nothing (radio, glass,
cellular, queues, the data centre) the chapter says it runs a model, and labels what is assumed.

**Signal processing** (chapters <!--n:dsp.first-->74<!--/n--> to <!--n:dsp.last-->89<!--/n-->, <!--n:dsp.count-->16<!--/n--> of them, after the expert's bench) asks what a computer does with a
sample once it has one. Numbers that fit (saturation instead of wrap, guard bits, Q formats), the
z-plane, measuring a spectrum (an FFT written in Python and run on the gates, then on the DSP core), FIR design to a mask, IIR and the stability feedback costs, changing the
rate for a fraction of the price, and CORDIC, rotation by shifts. Then the machine: a MAC added to the
RV32 as four instructions on custom-2 and measured on the CPU panel, a DSP core with two memories, address
generators and a loop with no branch, converters (compare and compare again, a ladder on the way back, then one bit
and feedback: sigma-delta in gates), and filters that learn (an echo canceller and an equalizer, a tap in gates). Speech (μ-law
and ADPCM, a 2.4 kb/s vocoder), music (an MDCT codec spending its bits where noise would be heard) and
pictures (the DCT, why a JPEG looks blocky) apply it, and **A software radio** closes the level: four
stations in one band, a mixer in gates, a decimating chain and a discriminator, a dial to turn. Filters,
the MAC and the converter loop are in gates, checked against reference models; the vectors for the
filters, spectra and codecs come from scipy at pinned versions, regenerated in CI. Audio, speech and the
radio's band are models, and each chapter says what is assumed.

A **Basics** chapter (a circuit, two levels, counting in binary, truth tables, programs, how to read a schematic here) starts the journey for anyone who needs it,
and no term is used before the chapter that teaches it (a test holds that at zero). Before chapter 1,
an optional **prologue** builds the same logic from relays, from vacuum tubes and from punched cards.
After chapter <!--n:journey-->89<!--/n-->, <!--n:appendices-->6<!--/n--> **appendices**: the MOS 6502 rebuilt at transistor level, Doom compiled for the
site's RV32IM, Ben Eater's SAP-1 breadboard computer, its 74xx chips built from our gates, drawn on
breadboards and run in lock step with a golden model, Bit Runner, an original game in 74xx counters and gates with no CPU,
and the Manchester Baby of 1948 in gates, its store a Williams tube that leaks unless regenerated, running Kilburn's
highest-factor routine to the end, and the Apollo Guidance Computer from its one gate, a three-input RTL NOR, up: a
one's-complement adder whose end-around carry ring must be cleared, core rope read and rewoven, and its instruction set
on a golden model checked against Virtual AGC's yaAGC.

Each chapter opens with the problem before the mechanism and with its goals, and closes with a recap
and Check yourself questions; challenges are optional, each with a revealable answer. Around the prose:
**Why?** on any wire traces where its value came from and what each part is for, **Break a part**
shows what fails without it, guided tours, cost ledgers and layers (the short version, then deeper),
narration, <!--n:analogies-->26<!--/n--> analogies (each folded under its step with a figure from the chapter's own model and
where it breaks down), <!--n:readings-->6<!--/n--> passages of the RISC-V manual to read with questions, and a live
**memory view** of every RAM and register file in a scene. Notes and bookmarks on any step feed a
review queue; one backup file carries all progress; the site installs as an app and works offline.

<table>
<tr>
<td width="50%"><img src="docs/images/relay3d.png" alt="A telephone relay in 3D beside its coil current and armature travel"><br><sub><b>P1</b>: a relay in 3D on a physical model: pull-in, contact bounce, the 8 ms step a relay computer runs at.</sub></td>
<td width="50%"><img src="docs/images/triode3d.png" alt="A 6SN7 triode section in 3D with its plate curve"><br><sub><b>P2</b>: a 6SN7 triode warming up, its grid deciding the plate current; tube gates follow.</sub></td>
</tr>
<tr>
<td><img src="docs/images/mosfet.png" alt="MOSFET cross-section: the channel forms past the threshold voltage"><br><sub><b>Ch. <!--n:ch.mosfet-->1<!--/n--></b>: the MOSFET. Raise the gate past the threshold and the channel forms.</sub></td>
<td><img src="docs/images/nand.png" alt="The CMOS NAND gate at switch level"><br><sub><b>Ch. <!--n:ch.nand-->3<!--/n--></b>: the NAND, solved at switch level. Every gate above it is built from this one.</sub></td>
</tr>
<tr>
<td><img src="docs/images/ripple.gif" alt="The carry rippling through an 8-bit adder"><br><sub><b>Ch. <!--n:ch.adders-->6<!--/n--></b>: toggle <code>cin</code> on 0xFF + 0 and watch the carry ripple, one gate delay at a time.</sub></td>
<td><img src="docs/images/cpu.png" alt="The single-cycle RV32I CPU running Fibonacci"><br><sub><b>Ch. <!--n:ch.cpu-->14<!--/n--></b>: a single-cycle RV32I CPU running Fibonacci, every instruction checked against the golden model.</sub></td>
</tr>
<tr>
<td><img src="docs/images/python.png" alt="A Python loop running on the gate-level CPU, line by line"><br><sub><b>Ch. <!--n:ch.python-->15<!--/n--></b>: Python on the gates: the line running, its instructions, cycles and wire toggles, the variables read from the registers.</sub></td>
<td><img src="docs/images/pipeline.gif" alt="A five-stage pipeline stepping cycle by cycle"><br><sub><b>Ch. <!--n:ch.pipeline-->17<!--/n--></b>: a gate-level five-stage pipeline, its diagram marking forwarding, stalls and flushes.</sub></td>
</tr>
<tr>
<td><img src="docs/images/cache.png" alt="The cache explorer on a column-major matrix sum"><br><sub><b>Ch. <!--n:ch.cache-->22<!--/n--></b>: caches on real address traces: size, line, ways, replacement, write policy, 3C misses.</sub></td>
<td><img src="docs/images/ooo.png" alt="The out-of-order core running bubble sort with its reorder buffer and rename table"><br><sub><b>Ch. <!--n:ch.ooo-->28<!--/n--></b>: a 359k-NAND out-of-order core; its reorder buffer, issue queue and rename table read from the gates.</sub></td>
</tr>
<tr>
<td><img src="docs/images/drawpad.png" alt="A drawing of a house sent to the gate-level GPU and shown on its screen"><br><sub><b>Ch. <!--n:ch.pixels-->40<!--/n--></b>: draw a picture, cut it into triangles and send it to a 2.7M-NAND rasterizer; the screen is checked pixel for pixel.</sub></td>
<td><img src="docs/images/dram.png" alt="A 4 × 4 DRAM array at switch level with each cell's charge"><br><sub><b>Ch. <!--n:ch.dram-->42<!--/n--></b>: a DRAM read in slow motion: charge sharing on the bit line, the sense amplifier, leakage and refresh.</sub></td>
</tr>
<tr>
<td><img src="docs/images/ping.png" alt="Two computers and a switch in gates, with a ping and the frames at the switch listed"><br><sub><b>Ch. <!--n:ch.network-->63<!--/n--></b>: a ping on the gates: two CPUs running a stack compiled from Python, a NIC and a switch, 12 million NANDs. The frames are listed as they pass, and Save capture writes a <code>.pcap</code>.</sub></td>
<td><img src="docs/images/eye.png" alt="An eye diagram with sliders for rate, bandwidth and noise, and the error rate computed"><br><sub><b>Ch. <!--n:ch.serial-->56<!--/n--></b>: the eye of a fast serial link: rate, band and noise on sliders, with eye height, error rate and the fastest rate computed.</sub></td>
</tr>
<tr>
<td><img src="docs/images/enigma.png" alt="The naval Enigma M4 in 3D, lid open, with its parts labelled"><br><sub><b>Ch. <!--n:ch.secret-->67<!--/n--></b>: an Enigma M4 in 3D that deciphers a real 1942 message on its own wheels, beside the same machine in gates.</sub></td>
<td><img src="docs/images/wifi.png" alt="Three Wi-Fi stations in gates with the frames of two hidden stations overlapping"><br><sub><b>Ch. <!--n:ch.wifi-->70<!--/n--></b>: the hidden terminal: three stations in gates, each in lock step with its model, on the standard's own timings. Tick RTS / CTS and watch what it buys.</sub></td>
</tr>
<tr>
<td><img src="docs/images/path.png" alt="A table of every hop of one packet with its light, bits, queue and engine delays"><br><sub><b>Ch. <!--n:ch.path-->68<!--/n--></b>: one packet, all the way: every hop's delay computed, on an invented network. In the backbone light is everything; on the access line, bits and queues.</sub></td>
<td><img src="docs/images/bench.png" alt="A fault case: a report, a link budget, the access point's counters and a sniffer's list, and four causes to choose from"><br><sub><b>Ch. <!--n:ch.bench-->73<!--/n--></b>: the expert's bench: a report and the evidence, from a fault really switched on in the book's models. Capstone 4 draws eight at random, with nothing said until the end.</sub></td>
</tr>
<tr>
<td><img src="docs/images/sdr.png" alt="The software radio: four stations in one band, the dial turned to one of them, its spectrum before and after the channel filter"><br><sub><b>Ch. <!--n:ch.sdr-->89<!--/n--></b>: a software radio: four stations in one band, a mixer and decimating chain in gates, a dial to turn.</sub></td>
<td><img src="docs/images/cap_tune.png" alt="The Tune it capstone: a receive chain built from the software radio's blocks, with each block's settings and its cost in NANDs and multiplies"><br><sub><b>Capstone</b>: Tune it. A band you have not seen and a weak station: build the chain, and the message must decode on bands held back.</sub></td>
</tr>
<tr>
<td><img src="docs/images/warps.png" alt="The warp core drawn as blocks: the lanes side by side, the issue logic above and the memory below"><br><sub><b>Ch. <!--n:ch.warps-->38<!--/n--></b>: the warp core drawn as blocks: lanes, issue and scoreboard, and the memory, each one opens down to gates.</sub></td>
<td><img src="docs/images/control.png" alt="The CPU's control unit drawn as blocks: the opcode decoder and the signal groups it drives"><br><sub><b>Ch. <!--n:ch.alu-->11<!--/n--></b>: the control unit as blocks: the opcode decoder and the signals it asserts, each box a circuit you can open.</sub></td>
</tr>
<tr>
<td><img src="docs/images/m6502.png" alt="The 6502 at transistor level running a program, its bus cycles listed"><br><sub><b>Appendix A</b>: a 4,513-transistor NMOS 6502, every bus cycle in lock-step with a cycle-exact model.</sub></td>
<td><img src="docs/images/doom.png" alt="Doom running on the site's RV32IM with a live profile and instruction mix"><br><sub><b>Appendix B</b>: Doom compiled for RV32IM, with a live profile and instruction mix, and what each frame would cost on the gates.</sub></td>
</tr>
<tr>
<td><img src="docs/images/baby.png" alt="The Manchester Baby in gates, its Williams-tube store shown as dots and dashes beside the datapath"><br><sub><b>Appendix E</b>: the Manchester Baby of 1948 in gates, its Williams-tube store leaking unless regenerated, in lock step with its model.</sub></td>
<td><img src="docs/images/agc.png" alt="A core-rope module of the Apollo Guidance Computer in 3D, sense wires threaded through or around the cores"><br><sub><b>Appendix F</b>: the Apollo Guidance Computer's core rope in 3D: a program woven into wire, read core by core.</sub></td>
</tr>
<tr>
<td><img src="docs/images/workinggates.png" alt="An XOR from four NAND gates, each drawn with its live CMOS transistors inside"><br><sub><b>Ch. <!--n:ch.gates-->4<!--/n--></b>: working gates, the default look: each NAND drawn as its live transistors inside its outline.</sub></td>
<td><img src="docs/images/pdp8.png" alt="The PDP-8 in gates in the sandbox, with its front panel lamps and switches in the CPU drawer"><br><sub><b>Sandbox</b>: Examples ▸ PDP-8 in gates, its 1965 front panel of lamps and switches in the CPU drawer, a teleprinter on the bus.</sub></td>
</tr>
</table>

Every CPU has a **CPU panel**: the program with the current instruction (click a line to light up
the hardware it uses), registers, memory, Run to halt / Step / Slow (one gate delay, cycle or
instruction at a time), Back to undo, and a lock-step comparison with the golden model. The
pipelines add a pipeline diagram, the out-of-order core its reorder buffer, the GPU its warps and
frames.

## Campaign

![The campaign map with the first acts under way](docs/images/campaign.png)

A tree of **<!--n:levels-->179<!--/n--> levels in <!--n:acts-->15<!--/n--> acts**, in the spirit of *Turing Complete*, from a NAND made of
transistors to a pipelined, interrupt-capable 16-bit RISC-V-like CPU (RV16), with optional acts:
before the transistor (relays, tubes, cards), arithmetic units (floating point, multiply, divide), a GPU
(four lanes, the active mask, a reconvergence stack, two warps, a rasterizer) and memory (a DRAM column,
a controller, a bus with DMA, a flash store), links (a repeater, a UART, CRC, a clock recovery loop, a
MAC, a switch, a forwarding path, a driver, a host) and signals (<!--n:dsp.levels-->8<!--/n--> levels: a saturating adder, a MAC with guard
bits, a circular address, a biquad, Goertzel for one tone, a CIC decimator, a CORDIC stage, a sigma-delta loop). Each level is built only from parts earlier levels
unlocked, checked by a full test set and graded against par (NANDs, transistors, depth, clock period;
every level you build or solve has one). Later chapters add optional levels where they teach a block: a
clock gate, a look-up table and a drill programming it, and, after the system CPU, a TLB, the page-table walker
and a context switch written as a program puzzle. The order follows use: a level comes just before the first one that needs it,
and its why reads as a thread (the problem, what it costs, where it goes next and which later levels
reuse it), closing each act with what is now within reach. **My path** maps skills from the codex,
reads mastery from what you have already done, and places you (Where are you starting?, test-outs);
**capstones** close each tier without a walkthrough (an adding machine, an RV16 core that plays Pong,
a pipelined core, and a design brief: the cheapest core that runs the benchmarks, placed on a cost /
speed chart against three references). Communication has <!--n:capstones.comm-->4<!--/n--> of its own, on a card of their own: a serial
console from its register sheet, a link that closes on the book's channel and code models, a switch from
its rules, and finding the fault. Signal processing has <!--n:capstones.dsp-->3<!--/n--> the same way: a filter built to a mask and
judged on its gates, an echo canceller that must learn its path, and **Tune it**, a software-radio
chain you build from the chapter's blocks and that must decode a message from bands you have not seen.
**Verilog twins** (<!--n:twins-->7<!--/n--> levels) are written as text,
synthesized by Yosys in the page and graded by the level's own check. There are <!--n:bughunts-->13<!--/n--> optional **bug hunts**
start from a colleague's faulty drawing of a block you built (a miswire, crossed pins, a missing
connection, a clocking fault, a forwarding term that is never true, ...): Check shows the symptom, and
the fix is graded in edits (parts added, removed or swapped and pins moved; moving parts is free). The
last is timing closure: a right block that misses its clock period.

![A level passed at par: the learner's adder against two alternatives, and its copies in the finished CPU](docs/images/level.png)

Each level plays on a screen of its own: the brief, why the CPU needs the block (its measured cost
against the alternatives and its copies in the finished CPU), the level's parts only, a hint ladder
from a nudge to the full walkthrough, and Build along (the next step's parts as outlines, the
learner's wiring checked against the reference). Number and Boolean drills (generated, with exact
checkers), assembly puzzles on the golden model and a codex of <!--n:codex-->388<!--/n--> entries sit alongside: each with a
live figure, a worked example, Check yourself questions and links to what it builds on and leads to,
searchable by alias, read beside the level without leaving it, and shown as hover definitions in the
chapters, with an index of every analogy. Practice questions (predict, what breaks) and drills come back
in the review until they stick. Plan and status in
[docs/CAMPAIGN.md](docs/CAMPAIGN.md).

## Sandbox

![A 4-bit counter on a 7-segment display, built in the sandbox](docs/images/sandbox.gif)

A circuit editor in the spirit of Sebastian Lague's *Digital Logic Sim*, built on the same
simulator, so whatever you build is a real component of the site. The full guide is
[docs/SANDBOX.md](docs/SANDBOX.md).

- Place parts from the whole library (a Basics group first, search by alias, or only NAND and
  transistors in *purist* mode), draw wires freehand with corners and branches, and connect distant
  nets with **pointers** (named net labels). A problems pill lists what is wrong with the circuit,
  each with how to fix it.
- Watch values live, per clock cycle or one gate delay at a time; probe wires into a timing
  diagram (VCD export), and read a chip's static timing with its critical path drawn on it, in
  NAND delays or by load (logical effort: a gate driving many inputs is slower), with the heaviest
  nets listed; the Load-dependent delay setting runs the simulation itself on the loaded delays.
- **Package** a circuit as a chip (name, colour, pin order), use it in other circuits, nest chips
  to any depth and edit them later: every user of the chip is rebuilt. A face editor puts pins on
  any side and the chip's displays, screens and switches on its box; chips go in folders, circuits
  in separate projects, favourites on keys 1–9.
- **Wire colours**: right-click a wire for a colour for its whole net (or Auto, one hue per net); the View options menu sets the palette, thickness, flowing bits and working gates (each NAND's live transistors inside it).
- **Look inside** any placed part, live, down to the transistors; **Open in Sandbox** turns any
  schematic from the chapters or the workbench, CPUs included, into an editable copy.
- Switch-level parts beyond the MOSFET: resistors, pull-ups / pull-downs, capacitors, transmission
  gates and tri-state drivers, so shared buses, wired-AND / wired-OR and pseudo-NMOS logic work.
- Recreate **every level** of the journey: chips built from transistors are solved at switch
  level and become gate-level bricks; latches, flip-flops (recognised by their structure), RAM with
  initial contents, and a **program ROM** written in RISC-V, RV16, 4-bit, 6502 or DSP-core assembly, or hex.
- I/O: LEDs and LED banks, 7-segment and hex displays, a buzzer, keys bound to your keyboard, a
  keyboard with a key queue, a pixel screen, a console, switch banks, a timer, a card reader with
  decks punched from a ROM, a halt part, random sources and cycle counters; comments on the canvas.
- The **CPU panel** for any chip that is a processor, yours included, with the golden model in
  lock-step (single-cycle and pipelined RV32I and RV32IC, RV32IV with its vector unit, RV64I / RV64IM, several
  cores, the out-of-order core, the 6502, the 4-bit CPU, the SAP-1, the PDP-8, the Manchester Baby, the DSP core),
  and a **Memory** drawer showing every memory live, core planes included.
- **Your own instruction**: a custom RV32 instruction as a row of control signals, on the single-cycle
  or the pipelined core (hazards from its signals), checked against generated golden-model code.
- **Programs on your own CPU**: a custom instruction set written as a table gives its own
  assembler and disassembler; <!--n:puzzles-->14<!--/n--> program puzzles run on the gates of a ready-made CPU or your own,
  scored on cycles, NANDs and program size. **Puzzle devices** (Crossing, Maze robot, Vending machine) put a
  small world behind named pins: your circuit, or a program on a ready-wired RV32I computer, drives it, its
  rules are checked every clock, and stars count NANDs against a reference circuit, or cycles × NANDs against a
  reference program.
- **Verilog chips**: write a module as text and Yosys, running in the page (WebAssembly, nothing
  uploaded), draws it from the library's gates beside the text a second after you stop typing;
  every module becomes a chip that opens down to NANDs and transistors. `.v` / `.sv` files and
  Yosys JSON netlists import the same way, and File ▸ Export Verilog goes the other way: exported
  and imported back, a chip (a whole RV32I CPU among the tests) simulates equal to the original.
  Every component also has a **VHDL** view (the inspector's HDL tab, a .vhd download), checked
  by GHDL in CI.
- **Truth-table and state-machine chips** (New chip ▾): fill a table (or paint a Karnaugh map) and get
  it minimized and built as NAND–NAND, AND–OR, a PLA or a ROM, each priced; draw a state diagram and get
  it encoded binary, Gray or one-hot around flip-flops, read back from the circuit against the diagram;
  give it registers, and states carry register transfers (`a := a − b`) and arcs tests (`a < b`), built
  as that controller over a datapath of library registers, adders and comparators (GCD to start from).
- **Digital and Logisim circuits import**: a `.dig` project or a Logisim-evolution `.circ` becomes
  chips in a folder, the file's drawing kept, each part mapped to ours (with a table of what became
  what), and **Lay out by logic depth** is offered where it reads better than the file's drawing;
  File ▸ Export for Digital writes a chip back as `.dig`. **Test tables** on any chip, in Digital's
  test syntax: a Tests pane runs them after every edit, fills outputs from the circuit, and opens a
  failing row in the test player; the imported files' own tests come along. Faults switched on in a
  chip apply in Check, the Tests pane and the puzzles alike.
- **File ▸ Memory map**: address regions (RAM, ROM, screen, console, keys) placed by window, overlaps
  and gaps named, the decoder generated as a chip, a C header and linker script written, applied as one
  undo step. **Microcode…**: the multicycle CPU's microprogram painted as a grid, checked against the
  golden model.
- Wide pins up to 1024 bits, exact; autosave, chip files, share links, Verilog and image export, and
  **File ▸ Export Verilog for FPGA**: a board top for a Sipeed Tang Nano 9K (clock divider, reset,
  buttons and LEDs) with its pin constraints.
- <!--n:challenges-->21<!--/n--> optional **build challenges**, from a CMOS inverter to an instruction fetch unit, with a test
  player that steps through the failing cases.

![The sandbox's wire-colour menu: right-click a wire of the 4-bit counter to colour its whole net](docs/images/wirecolours.png)

![Examples ▸ Computer: an RV32I core, its program ROM, the memory side, a 64 × 64 screen and the devices, after Run to halt](docs/images/computer.png)

The sandbox builds **whole computers**. RAM and ROM parts go up to 64K words: one behavioural leaf
at run time over a real hierarchy of banks you can open down to the latches. A cycle engine runs
them: storage, found by its structure (library flip-flops or ones drawn from NANDs, latches,
resets), becomes verified tables and the rest is levelized, and every net equals the event-driven
simulator's after every settle. `scripts/sim-perf.ts` measures the cycles per second of the CPUs on both engines. **Examples ▸** has <!--n:examples-->29<!--/n--> ready-made circuits, among them:

- **Computer**: the RV32I core, a program ROM in assembly, a memory chip, a 64 × 64 screen and a
  devices chip with the console, LEDs and switches. It greets you, paints a picture and halts, with
  the golden model checking every instruction (above). A second version runs the **pipelined** RV32I
  core on the same pins, with the pipeline diagram; **RV32C**, **RV64** and **RVV** (saxpy on a four-lane
  vector unit) examples run those cores, and the **DSP core** examples run its benchmark kernels (a FIR filter among them).
  The pipelined core also comes with C, and with M or a data cache, as parts of its own.
- **4-bit CPU** (4004-inspired, 3 357 NANDs), **6502 computer** (the transistor-level 6502 as a
  part, a ROM in 6502 assembly), **System on a bus** (CPU and DMA masters, RAM, flash, screen,
  keyboard, timer behind an AXI-lite-style bus) and **Boot from cards** (a loader reading a punched
  deck into RAM, then running it), the **SAP-1** with its switches, bus LEDs and output digits, the
  **PDP-8** (its 1965 front panel on the model, and the PDP-8 in gates) and the **Manchester Baby** (1948). **RV16: Pong** puts the campaign's RV16 core on a bench with a
  screen and switches; a passed core level offers the same game on your own core.

## Measured, not drawn

Every number on screen comes from the circuit it describes:

| Design | NAND gates | Transistors | |
|---|---:|---:|---|
| NAND | 1 | 4 | |
| Full adder (9-NAND) | 9 | 36 | 6 gate delays |
| 8-bit ripple-carry adder | 72 | 288 | 20 gate delays |
| Single-cycle RV32I | 68,339 | | period 158 NAND delays |
| Single-cycle RV32IC (compressed instructions) | 69,794 | | period 201: the expander sits in front of decode |
| Single-cycle RV64IM | 172,285 | | period 150; the same generator at 32 bits: 73,384, period 124 |
| Five-stage pipelined RV32I | 80,798 | | forwarding, load-use stall, branch flush; period 145 |
| Pipelined RV32IM, balanced, with a predictor | 141,655 | | period 79 |
| Dual-issue pipelined RV32IM | 193,768 | | period 80 |
| Out-of-order RV32IM (2-wide, ROB 16) | 359,262 | | period 93 |
| Dual-core with shared memory (both harts) | 104,293 | | period 119; the flow's build (smaller memory, ROMs outside): 84,388 NANDs, period 96, 0.71 × 0.71 mm in sky130 |
| Graphics pipeline (warp core, rasterizer, two frames) | 3,061,392 | 12,245,568 | the cube spins in the page |
| MOS 6502 (our NMOS design) | | 4,513 | the real chip: 3,510 + ~1,018 loads |

The CPUs' counts are the Benchmarks tab's (the RV64 row: chapter <!--n:ch.widths-->27<!--/n-->'s, measured the same way): the 64-word data memory included, the program ROM left out.

The chapters compare implementations on these numbers: ripple, carry-lookahead, Brent–Kung,
Sklansky, Kogge–Stone, carry-select and carry-skip adders (static depth against simulated delay,
false paths included, and in unit against load-dependent delay, where a prefix tree's fan-out stops
being free);
array, Wallace-tree and Booth multipliers; restoring, non-restoring and SRT dividers; single-cycle,
multicycle (hardwired and microcoded), pipelined, dual-issue and out-of-order CPUs on clock period ×
CPI. The workbench's Benchmarks tab runs one program set on all <!--n:cpus-->29<!--/n--> gate-level CPUs (cycles, period,
time, NANDs, misses, energy), and dynamic power is estimated from the circuit too: the gate simulator
counts every net's toggles, glitches included, so the inspector splits a part's energy among its
blocks and the CPU panel shows the energy per instruction as the program runs. Every component can
also be priced in relays and tubes.

<table>
<tr>
<td width="50%"><img src="docs/images/silicon.jpg" alt="The dual-core placed and routed in SkyWater 130 nm, coloured by block"><br><sub><b>Ch. <!--n:ch.silicon-->30<!--/n--></b>: the dual-core after Yosys and OpenROAD on sky130: 14.8k standard cells, coloured by block.</sub></td>
<td width="50%"><img src="docs/images/hall.png" alt="The single-cycle RV32I as 78 racks of relays, a person for scale"><br><sub><b>Ch. <!--n:ch.silicon-->30<!--/n--></b>: the same RV32I as 55,699 relays, about 70 racks' worth (1.27 s an instruction), or 75,779 tubes, its program read from punched cards.</sub></td>
</tr>
</table>

## How it is checked

- **Components**: every combinational component carries a specification and is tested against its
  structure, exhaustively up to 12 input bits and on random vectors above; behavioural models
  (used to keep large designs fast) are proven equal to the structure they stand for.
- **CPUs**: each of the <!--n:cpus-->29<!--/n--> (single-cycle, multicycle, pipelined, dual-issue, out-of-order, with caches
  and a DRAM controller, system, M, F, C, dual-core) is co-simulated against the instruction-set
  simulator in `src/riscv/`, which steps in lock-step and compares registers, PC and memory at every
  retirement. Independently of that model, every RV32 CPU passes the official
  [riscv-tests](https://github.com/riscv-software-src/riscv-tests) its ISA covers at gate level
  (rv32ui, rv32um, rv32uf, rv32ua, rv32uc, rv32mi), runs seeded random programs against the golden model, and
  must reach every instruction and hardware event it has (forwarding paths, stalls, mispredictions,
  cache misses, traps). The out-of-order core also matches a cycle-exact model of its rules every
  cycle. Chapter <!--n:ch.widths-->27<!--/n-->'s single-cycle core runs in lock-step with the golden model at both widths, and
  the RV64 golden model passes rv64ui and rv64um. The vector extension is held to
  [riscv-vector-tests](https://github.com/chipsalliance/riscv-vector-tests) for our Zve32x subset:
  1,339 tests (1.43 M checks, all 80 instructions) on the golden model, and the vector core at gate
  level on the copies its e32 lanes can run. Matrix, coverage and the bugs this found:
  [docs/VERIFICATION.md](docs/VERIFICATION.md). The campaign's RV16 cores are fuzzed too.
- **The golden model itself**: [Spike](https://github.com/riscv-software-src/riscv-isa-sim) runs in CI
  on random programs for eight ISA variants (seven RV32, the C extension among them, and RV64IM), its
  commit log compared with ours instruction by instruction: 8,000 programs on every change to the ISS,
  new seeds each night.
- **The 6502**: the cycle-exact model passes all 1.51 M SingleStepTests cases and Klaus Dormann's
  functional test; the transistor-level chip matches it on every bus cycle of both.
- **The Apollo Guidance Computer**: Appendix F's golden model runs in lock step with yaAGC (Virtual
  AGC's emulator, fetched and compiled in CI, never kept here) on directed and seeded random programs,
  registers, erasable memory and memory cycles after every instruction; answers spoiled on purpose
  must fail.
- **Drawings**: every registered schematic is checked for nets sharing a line, overlapping symbols
  and hidden labels.
- **HDL**: generated SystemVerilog comes with a self-checking testbench drawn from our own
  simulation; `scripts/verify-export.ts` synthesizes the dual-core and the RV32I / RV32IM system CPUs
  with Yosys, simulates each gate netlist and compares every output cycle by cycle with the site's
  simulation under the same inputs (irq pulses, switches). The deploy waits on it. Import is checked
  the same way: both of our exporters' Verilog, through Yosys and back into chips, matches the
  original every output every cycle (library parts and the single-cycle CPU), and all 74 of Yosys's
  flip-flop and latch cells match its own definitions. The FPGA export goes through Yosys's
  `synth_gowin` before every deploy. The VHDL export is analysed and elaborated by GHDL in CI, and
  the combinational designs are simulated against ours.
- **Silicon**: `.github/workflows/layout.yml` runs the exported dual-core and the RV32IM system
  core (its memories outside its ports) through OpenROAD-flow-scripts on SkyWater 130 nm (synthesis,
  floorplan, placement, clock tree, routing); the GDS, tiles and reports are published into the site
  (chapter <!--n:ch.silicon-->30<!--/n-->), each beside our estimate of the same design: area per block from the NAND count,
  the critical path in NAND delays against OpenSTA's after routing, and then path by path: our unit
  and load estimates for every endpoint against OpenSTA's report.
- **Captures**: `.github/workflows/tshark.yml` has tshark read what Save capture writes, each chapter's
  frames from the gates and the chapters' own: every field and protocol against what the bytes claim, every
  checksum good, nothing malformed. Captures broken on purpose must be caught.
- **Signal processing**: the filters, windows, spectra and codec transforms are held to scipy / numpy vectors checked in with the
  versions that made them, and `.github/workflows/dsp-oracle.yml` regenerates them at those versions and compares; the gate-level units (MAC, DSP core
  blocks, CORDIC, CIC, sigma-delta, the adaptive tap) have tests against bit-exact models, and the capstone benches are tested against
  designs broken on purpose. What each chapter's facts rest on: [docs/DSP-SOURCES.md](docs/DSP-SOURCES.md).
- **Cryptography**: AES and SHA-256 in gates against test vectors taken from the standards' own documents, and TLS 1.3 against RFC 8448's recorded handshake.
- **Faults and benches**: every case on the expert's bench is tested with its fault on and off, on several
  seeds: the symptom must come with the fault and go without it. The capstone benches read only the pins,
  and each is tested against broken designs; the switch's also against a second switch of quite another design.
- **Every page**: `npm run smoke` opens every route of the built site in headless Chrome (both
  themes, a phone width for a few) and fails on any error; the deploy runs it.

## Scope and limitations

This is a teaching instrument for engineers, not a sign-off tool. What it models, exactly:

- **Transistors are switches.** The switch-level solver resolves 0 / 1 / X / Z with drive
  strengths (rails, transistors, resistors) and stored charge on capacitive nodes (charge sharing
  for DRAM, a stored threshold for flash). There is no I–V curve, sizing or analog transient: it is
  not SPICE. The relay and the triode have lumped physical models of their own, behind the prologue.
- **Timing is in NAND delays.** By default every NAND costs one unit, whatever it drives; static
  timing finds the longest register-to-register path in those units. A load mode weighs each gate by
  logical effort (d = p + g·h, its fan-out capacitance from the power estimate's per-input and
  per-branch values), in static timing and, with the **Load-dependent delay** setting, in the gate simulator too: it then
  times each NAND by its load in tenths of a unit, so glitches and races follow the loads, in the sandbox
  and the workbench (chapter scenes stay on one unit per NAND unless a step asks for loads). Clock
  rates in MHz assume an **illustrative 25 ps per NAND** (a loaded NAND2 in a 28 nm-class process),
  not timing characterized from a cell library: no slew, wire RC, skew or corners. The sky130 run's
  own reports are the real numbers.
- **Two kinds of place and route.** The placer (simulated annealing) and router (two-layer Lee) in
  `src/sim/pnr.ts` are teaching models run on small netlists; the full layout comes from OpenROAD.
- **Power is an estimate.** Dynamic energy is ½ C V² per toggle, with the toggles counted by the
  gate simulator (glitches included) and C from each net's fan-out: illustrative 28 nm-class values
  per NAND input, driver and wire branch, not extracted from a layout. No leakage, no short-circuit
  current, no clock buffers; behavioural memories count only at their outputs.
- **Power-on is a model.** Storage loops are resolved to a deterministic (or chosen random) state
  so a design can settle; real power-up depends on mismatch, noise and ramp.
- **The CPUs are teaching microarchitectures**: a cache miss freezes the whole pipeline, the
  plain dual-core's atomics are atomic because a round-robin arbiter serializes every access (chapter <!--n:ch.multicore-->29<!--/n-->'s coherent dual-core has private caches and MSI snooping), and the
  out-of-order core is built in gates only 2-wide (ROB 8–32, issue queue 4–16, store queue 2–8; the
  site's is ROB 16, issue queue 8): the lab's other shapes run on its cycle-exact model, timed but not
  priced.
  The ISA is RV32 (I, M, F, C, Zicsr, the atomics; lr.w / sc.w on the coherent dual-core; a Zve32x vector
  subset on one single-cycle core, its gate-level lanes e32 only), and RV64I / M on chapter <!--n:ch.widths-->27<!--/n-->'s
  single-cycle core and its golden model; RV64 is not in the pipelines.
- **Radio, glass, cellular, queues and the data centre are models**, labelled as such in their chapters, with
  their assumptions stated; the internet of chapter <!--n:ch.path-->68<!--/n--> is invented, with lengths and rates of the usual size. The
  capture check reads the book's frames only, not a learner's design. The switch capstone has been passed by a
  second design generated by code, not yet by a person drawing it: its brief gives our estimate of the work.
- **Signal processing is bit-exact where it is built and a model where it is not.** The converters' analog side, the speech, music and picture
  signals, and the radio's band (stations, noise, fading) are generated by models, and each chapter says what is assumed; the codecs are
  teaching ones (a vocoder at 2.4 kb/s, an MDCT codec with a masking model labelled simplified), not standards-conformant bitstreams, whereas μ-law
  follows G.711 and the ADPCM is IMA's.
- **Doom runs on an interpreter of our ISA** (checked against the golden model), not on the gates:
  a frame would take about 13 minutes on the gate-level CPU in the page. Appendix B's last step
  hands the running game to the gates for a window of cycles.

## What's next

Feature work is closed; the full plan and status is in [docs/ROADMAP.md](docs/ROADMAP.md). What is left:

- **Microcode**: a Verilog export of an edited controller, the hardwired controller as a grid, a new
  instruction in microcode.
- **The out-of-order core's top level** drawn with fewer pointers (parked).
- **FPGA**: small ROMs (≤ 256 words) and RAMs (≤ 64 words) into block RAM; they stay in LUTs today.
- **Static timing**: a constant's arrival and, where a design is placed, wire length: two causes of the spread against OpenSTA.
- **VHDL in**, through GHDL, once it runs in WebAssembly (VHDL out is done).
- **The core bench's IN device**, so "Open on a bench" works for the RV16 program levels that read input.
- **Puzzle devices**: a CPU route (a program driving the device) and grading on cycles × NANDs, as the
  stream puzzles are.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulator, library, CPUs and editor correctness
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck, statistics, static site in dist/ (works from any path or host)
npm run smoke      # every route of dist/ in headless Chrome
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`: the tests run beside the build and its smoke
test, the Yosys checks (exported hardware, FPGA export) run when the change touches what they cover, and the deploy waits on all of
them (enable Pages once under *Settings → Pages → Source: GitHub Actions*). A branch can run the full gate on a runner with
`gh workflow run gate.yml --ref <branch>`. Doom's game data (Freedoom) is
not in the repository: the deploy fetches it, and locally `node scripts/doom/fetch-wad.mjs --public`
does.

**Offline, as a Windows program.** `npm run desktop` builds `desktop/release/MOSFET-to-RISCV-<version>-portable.exe`:
one file, nothing to install, no network (fonts included). It is the built site inside Electron
(`desktop/`, a package of its own so the site's install stays small), served from inside the
executable. Progress and sandbox chips live in a `MOSFET-to-RISCV-data` folder next to the `.exe`,
so a copy on a USB stick carries them along. The *Desktop program* workflow (after every deploy, by hand, or on a `v*` tag) builds it on GitHub and publishes it as the release `desktop-latest`. The `.exe` is unsigned:
SmartScreen asks once (*More info → Run anyway*).

## How it is built

Vite + TypeScript, no UI framework: plain DOM and SVG, and a small hand-written WebGL2 renderer for
the 3D views.

- `src/sim/`: hierarchy flattener, event-driven 0/1/X gate simulator, cycle engine, switch-level
  and NMOS solvers, bit-parallel test simulator, statistics, static timing, power, Verilog export
- `src/lib/`: the component library, from transistors, relays and tubes to CPUs, GPUs and memory
  systems, each defined as a netlist of smaller components
- `src/riscv/`, `src/lang/`: ISA tables, assembler, the golden model and a fast interpreter; the
  Python-subset compiler
- `src/view/`: SVG schematics with drill-down, inspector (info, truth table, HDL: Verilog and VHDL, power), timing panel
- `src/widgets/`, `src/gl/`, `src/phys/`: the explainers, the 3D views and the physical models behind them
- `src/editor/`: the sandbox (document model, compiler to components, user-chip library, editor UI)
- `src/hdl/`: HDL in: Yosys in WebAssembly, and its JSON netlist turned into placed, routed chips
- `src/campaign/`, `src/learn/`, `src/puzzles/`: the campaign (levels, grading, drills, walkthroughs,
  codex), My path (skills, mastery, placement, capstones) and the program puzzles
- `src/comm/`, `src/net/`, `src/crypto/`: communication's reference models, from line codes and frames to TCP, an
  invented internet and the fault cases
- `src/m6502/`, `src/doom/`, `src/sap/`, `src/gfx/`, `src/dram/`, `src/flash/`, `src/bus/`, `src/cards/`, `src/runner/`: the
  appendices' and tracks' reference models
- `src/chapters/`: the narrative
- `CLAUDE.md`: architecture and conventions in detail; `docs/ROADMAP.md`: plan and status

## License

[MIT](LICENSE). Doom's source (doomgeneric, `ports/doom/`) is GPL-2; Freedoom's data is BSD and
fetched at build time.

Inspired by *Turing Complete*, Sebastian Lague's *Digital Logic Sim*, *nand2tetris*, and Harris &
Harris. The structure and HDL follow the companion primer in `References/`.
