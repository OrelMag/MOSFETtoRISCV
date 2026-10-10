# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**MOSFET → RISC-V**: an educational static website that walks a learner from a single
transistor to a multi-core RISC-V processor laid out on silicon. Each level is built only
from the levels below it, and every component on screen is a **transparent box**: the
learner can open any instance and keep drilling down to MOSFETs.

**Audience: engineers.** Prose is dense and precise (encodings, timing, cost, trade-offs); no
hand-holding. **Challenges are optional** and every one has a "Show answer" (reach challenges
also "Do it for me" via `solve`).

It is *not* primarily a logic simulator. The simulator exists so that every value, gate
count and delay on screen is computed rather than drawn. The product is the narrative
journey. See `docs/ROADMAP.md` for the plan and phase status.

Inspirations: Turing Complete (progression and challenges), Sebastian Lague's Digital
Logic Sim (visual style, packaging circuits into chips), nand2tetris, Harris & Harris.
`References/` holds an earlier primer (PDF) and its SystemVerilog sources
(`nand2cpu_sources.zip`), which are the canonical reference for structure and for HDL
snippets (e.g. the 9-NAND full adder, master–slave DFF, RV32I single-cycle and pipeline).

## Commands

```bash
npm install          # once
npm run dev          # Vite dev server
npm test             # Vitest (simulation + library correctness), must stay green
npm run typecheck    # tsc --noEmit (strict)
npm run build        # typecheck + hwstats.json (npm run stats, ~20 s) + production build into dist/ (relative base)
npm run preview      # serve dist/
npm run desktop      # build + desktop/ (Electron, own package): portable Windows .exe in desktop/release/
```

`desktop/`: main.cjs serves the staged site (stage.mjs: dist/ without source maps, Google Fonts swapped for
local @fontsource copies) on a private `app://mosfet` origin; data next to the .exe (PORTABLE_EXECUTABLE_DIR);
fuses off (runAsNode: VS Code sets ELECTRON_RUN_AS_NODE, so run `electron .` there with it unset). Share links
made in the program point at the public site (editor/files.ts `SITE_URL`). `.github/workflows/desktop.yml`
(manual or `v*` tag) publishes the release `desktop-latest`.

CI (`.github/workflows/deploy.yml`) runs tests + build and deploys `dist/` to GitHub Pages
on every push to `main`. The deploy also waits on `verify-hdl`: `scripts/verify-export.ts all`
(Yosys synthesizes the exported dual-core, its netlist is simulated against ours on every multi-core
program). Run it locally (`npx vite-node scripts/verify-export.ts all`, needs `pip install yowasp-yosys`)
before merging a change to the exporters or the dual-core.

## Stack and conventions

- Vite + TypeScript (strict, `verbatimModuleSyntax`: use `import type` for types). No UI
  framework: plain DOM + SVG with small helpers in `src/ui/dom.ts`. Keep the bundle small.
- Hash routing (`#/c/<chapter>/<step>`, `#/workbench/<componentId>`, `#/workbench/stats`, `#/sandbox/<chipId>`, `#/campaign[/n/<node> | /intro | /codex[/<id>]]`,
  `#/sandbox/s/<payload>` for a share link) so the site works on
  any static host or sub-path.
- Theme: CSS custom properties in `src/styles/`; `data-theme="light|dark"` on `<html>`, or
  absent for auto (`prefers-color-scheme`). Always define new colours for both themes.
- Match the surrounding code: terse, typed, comments explain *why*.

## Architecture

```
src/sim/       simulation core (no DOM)
  types.ts       ComponentDef / PortDef / Netlist / NetDef: the single source of truth; Behavior: init(mode),
                 seq (edge-triggered state: timing / logicDepth see storage), carry (heal on an edit), inside (seed
                 an opened leaf's structure: InsideSeed.state / .bits); hdl.synth (vexport's body for a part)
  geometry.ts    symbol sizes and port positions (grid units) shared by authors, router, renderer
  flatten.ts     hierarchy → flat 1-bit nets + leaves, keeping a HierNode tree mapping every
                 level's ports/wires to flat nets (this is what makes every box transparent);
                 powerOn hints may be dotted paths into children ('w3.ff0.ff.slave.sr.q')
  gatesim.ts     event-driven 3-valued (0/1/X) simulator, unit NAND delay, transport delay,
                 relaxation for power-on and oscillation resolution; runUntil(t) for a
                 fixed-period clock (an edge does not wait for the logic to settle); onTrace +
                 watch() report every change of watched nets at its exact time
  switchsim.ts   switch-level MOSFET solver (0/1/X/Z, shorts, floating nodes); `strength` levels:
                 rails/inputs > transistors (strength 4..2, ratioed logic) > resistors (prim 'res',
                 strength 1: pull-ups lose to any transistor; two opposing → X) > stored charge
                 (`cap` nets and prim 'cap' capacitors keep their value when undriven)
  fpref.ts       exact reference float arithmetic for any format (BigInt, RNE), float32 helpers
  coherence.ts   MSI / MESI snooping model (per block, no capacity)
  pnr.ts         problemOf(def), Layout (annealing placer), route / routeAll (two-layer Lee router)
  techmap.ts     techMap(def): inverter recognition and double-inversion removal
  cachemodel.ts  behavioural cache model (size/line/ways/replacement/write policy, 3C classes)
  carry.ts       matchNets(next, prev): flat nets of a rebuilt design ↔ the old one, through the
                 hierarchy; GateSim / SwitchSim.carry(prev) use it so state survives an edit
  harness.ts     simulate(def), evalOnce, forEachInput: for tests, truth tables, workbench;
                 reachesTransistors(def) (would a gate-level flatten hit a transistor?)
  stats.ts       transistor / NAND counts, logic depth
  dead.ts        deadInstances(netlist, ports): parts no path leads from to an output (tested over every netlist
                 and reference answer; the sandbox lint warns about them)
  settle.ts      outputSettle(def, vectors): simulated input-to-last-output-change delay (sees false paths)
  timing.ts      static timing: register-to-register critical path, per-capture-stage periods (a `seq` leaf:
                 inputs captured, comb inputs → outputs launched at clk-to-q)
  verilog.ts     structural Verilog generated from any netlist (identifiers sanitized, alias
                 boxes from their bit map)
  svexport.ts    exportHdl(def, 'structure' | 'synth', testbench?): whole hierarchy in one file,
                 self-checking testbench from our simulation (checked against Yosys when installed)
  vexport.ts     synthesizable Verilog-2005 (flip-flops as processes, `hdl.synth` bodies) for Yosys / OpenROAD
  vcd.ts         toVcd(): Value Change Dump of recorded traces
src/lib/       the component library (registered in `registry` via define())
  transistors.ts NMOS, PMOS, rails, CMOS inverter/NOR, NAND (prim + 4-transistor netlist), tie cells
  switchparts.ts RES, CAP (prims), PULLUP / PULLDOWN (resistor + rail), TGATE (transmission gate),
                 TRIINV (clocked CMOS) and TRIBUF (tri-state: y is Z while en = 0), INV_PSEUDO (pseudo-NMOS)
  gates.ts       NOT, AND, OR, NOR, XOR, XNOR, MUX2 from NAND
  combinational.ts adders (HA, FA 13- and 9-NAND, rca(n), addSub(n), incrementer(n)), andN,
                 decoder(n, en, pitch), busMux2(w), muxTree(k, w, pitch)
  sequential.ts  SR latch, D latch, DFF (master–slave), DFFE, register(n), counter(n)
  seqparts.ts    NAND3, D_LATCH_R / DFF_R (async reset), TFF, JKFF, upDownCounter(n), shiftRegister(n) (74194-style),
                 lfsr(n) (LFSR_TAPS, lfsrNext), randomSource(n) (XNOR LFSR, xnorLfsrNext), cycleCounter(n),
                 ringCounter(n, johnson), clockDivider(k)
  storage.ts     romArray(preset), minimize() (Quine–McCluskey), pla(preset), fifo(k, w), stack(k, w), cam(k, w),
                 regfileMP(k, w, reads, writes)
  memory.ts      ram(k, w): decoder + registers + mux tree, user-scalable
  bigmem.ts      large memories (2^7 … 2^16 words): bigRam(k, w) = one stateful behavioural leaf (RamState: words +
                 X flags, sampled while clk is low, written at the rising edge) over a lazy hierarchy of ≤ 16 banks
                 per level down to ramBank(w) (ram(6, w) as a lookup; opened, its latches are seeded), bankState;
                 bigRamWithInit (initial words in the leaf's power-on state); romLevels (banks of 2^8-word ROMs,
                 shared by content hash, wordsHash); ramLeafState / ramWords for readers; kWords labels
  alu.ts         constWord, zext, wiring boxes, bitwise, orN, isZero, barrel shifter, alu(n)
  regfile.ts     regfile(k, w) with x0 = 0, two read ports fed by one bundled word bus
  cpu.ts         single-cycle RV32I: rom (preferBehavior), dataMemory, IMM_GEN, OPCODE_DECODER,
                 CONTROL, NEXT_PC, PLUS4(_FAST), singleCycleCpu(program, { adder })
  fastadd.ts     gp / gray / black prefix cells, CLA4, koggeStone(n), addSubFast(n)
  wide.ts        bitwise(op, n), orN(n) (shared by alu.ts and fastadd.ts to avoid an import cycle)
  usage.ts       usedIn(def) (parents with instance counts, the chapters' CPUs included), copiesIn(top, def),
                 referenceCpus(): the inspector's "Where it is used"
  hwstats.ts     hwTargets / measure / hwStats (scripts/hwstats.ts → public/hwstats.json at build), hwStatsLive:
                 the workbench's Statistics tab (ui/pages/hwstats.ts, its own chunk; benchtabs.ts: the tabs)
  pipeline.ts    equal, nonZero, clearableRegister, pipeline registers (fields on fixed rows),
                 hazardUnit(lookAhead), BRANCH_CMP, BTB (16 × 62-bit), SAT_COUNTER, MISPREDICT,
                 pipelinedCpu(program, { adder, balanced, predictor, dcache, m }) (a cache miss in M freezes every stage;
                 m: multiply split E/M, behaving like a load for hazards; divide stalls F/D/E)
  lsu.ts         STORE_ALIGN, LOAD_EXTRACT, bankedMemory(k) (byte / halfword access)
  system.ts      SYS_DECODE (illegal-instruction detection), CSR_UNIT, TRAP_UNIT, IO_UNIT,
                 systemCpu(program, { m }): the complete RV32I(M) + Zicsr + M-mode traps / interrupts + MMIO;
                 with m the CPU gains a `retire` output (low while a divide stalls it)
  cells.ts       NMOS_STRONG / PMOS_WEAK, SRAM_CELL (6T), SRAM_COLUMN, DRAM_CELL (switch level)
  arrays.ts      WRITE_DRIVER, SENSE_AMP (latch type), sramColumn(R), sramArray(R, C): switch-level SRAM with periphery
  cache.ts       cachedMemory(k, ib) (direct-mapped write-through cache + main memory, stall on
                 miss), wayLookup2; singleCycleCpu(…, { dcache }) uses it (adds `retire`, `dhit`)
  cache2.ts      cacheWay(ib, t), MISS_CTRL, wbCache(k, ib, ways) (write-back, write-allocate, LRU), iCache(rom, ib);
                 singleCycleCpu(…, { dcache: 'wb' | 'wb2', icache }); riscv/cosim.ts cacheLines() + coherent cpuState().dmem
  multicycle.ts  MC_STATES (the state table), MC_FSM (hardwired), MC_MICRO (microcode), microword(),
                 multicycleCpu(program, { control: 'fsm' | 'micro' }) with `retire`, `fetch`, `state` outputs
  fpu.ts         parametric IEEE 754 units (format {E, M}): lzc, shiftLeft, shiftRightSticky, fpUnpack,
                 normRound (shared RNE rounding), fpAdd, fpMul, fpFromInt, fpCompare, FPU32, FP_DECODE;
                 singleCycleCpu(…, { fpu }) adds the f register file (regfile(5, 32, false))
  mpdecode.ts    MP_DECODE (atomics, csrr mhartid), ARBITER2 (round-robin)
  multicore.ts   dualCore(program): two singleCycleCpu(…, { shared }) cores + arbiter + shared memory
  builder.ts     Builder: column-by-column netlist builder for blocks read by drilling in (fpu, fppipe, coding, divide)
  coding.ts      magComparator(n, signed), priorityEncoder(n), encoder(n), demux(k, w), popcount(n), absValue(n),
                 parity(n), hammingEnc/Dec(k) (SEC-DED, with TS reference models), eccChannel(k)
  divide.ts      nrDivStep / nrArrayDiv / nrSeqDivider (non-restoring), iterCtrl(n) (load / step / done control),
                 SRT_SELECT, srtStep, srtNorm, srtFinish, srtDivider(n) (radix-2 SRT, carry-save remainder)
  srt4.ts        srt4Thresholds() (computed), SRT4_SELECT (carry-save comparisons), srt4Term, srt4Step, srt4Finish,
                 srt4Divider(n) (radix 4, n/2 + 3 cycles); iterCtrl(n) handles any step count
  pipem.ts       MUL_E / MUL_M (Booth tree in E, 64-bit Kogge–Stone in M), DIV_E (radix-4 SRT, stall until done)
  multiply.ts    seqMul(n) (shift and add), boothRow / boothPP / boothReduce / boothTree / boothMul(n) (radix-4 Booth,
                 sign-constant trick), pipeMul(n) (3-stage pipelined Booth)
  adders.ts      carrySelect(n, k), carrySkip(n, k), BCD_DIGIT, bcdAdder(d)
  muldiv.ts      ppRow, arrayMul(n), compressor()/csa(n) (3:2 rows with word offsets), treeMul(n, signed,
                 outW) (Wallace + KS), MUL32, BOOTH_ENC, divStep, arrayDiv, seqDivider(n), condNegate, MDU
src/riscv/     isa.ts (tables, decode, disasm, CSR names), asm.ts (two-pass assembler, CSR
               instructions), iss.ts (golden model; `system: true` adds MMIO, CSRs, traps,
               interrupts; `m: true` makes M legal in system mode, divides advance mtime by 34), programs.ts / sysprograms.ts / mprograms.ts / pmprograms.ts / cprograms.ts / fprograms.ts (samples), multi.ts (MultiISS: N harts, shared memory, same arbitration), mcprograms.ts, cosim.ts (CPU state;
               `retiring()` = step the ISS this cycle?)
src/view/      SVG schematic renderer (route.ts: orthogonal routing + hops over crossings),
               inspector (info with "Where it is used", truth table, Verilog + download), analyzer.ts (the Timing panel:
               lanes from onTrace, cursors, VCD), stage.ts (probe mode, clock period, slow-motion
               fronts, the Image menu), image.ts (a drawn circuit as a standalone SVG: computed styles
               inlined, current theme; PNG at 2×; saveFile; exportSchematic for a stage's level, loaded on
               demand; the sandbox's File menu uses it too)
src/widgets/   bespoke explainers (MOSFET cross-section, number explorer, memory grid, ...);
               insthw.ts maps an instruction to the units it uses (and pipeline stage units)
src/chapters/  narrative content: chapters → steps → scene / widget / challenge
src/lib/rv16/  the campaign's RV16 hardware, every block built only from parts its level's requirements unlock:
               logic.ts (acts 1–3), cpu.ts (immediates, control, branch, next PC, single-cycle cores),
               pipe.ts (pipeline register, forwarding, hazard, rv16Pipe with fwd / stall / flush / sys),
               system.ts (illegal detector, CSR file, system decode, cores with traps and interrupts),
               md.ts (MUL16: unsigned array + sign corrections, DIV16: signs around the iterative divider; rv16Core(…, md)),
               multi.ts (RV16_MULTI: one-hot F/E/M/W multicycle core, RV16_CACHE: direct-mapped, write-through);
               rv16Pipe({ predict }) adds static prediction in F
src/riscv/rv16/ isa16.ts (fields, encode / decode / disasm), asm16.ts, iss16.ts (golden model: MMIO, CSRs, traps,
               interrupts; halts on jal x0, 0), randprog.ts (seeded random programs for fuzzing cores)
src/editor/    the Sandbox (#/sandbox[/<chipId>], a DLS-style editor; page in ui/pages/sandbox.ts, its own chunk;
               #/sandbox/s/<payload> opens a share link: a banner, imported only on the user's click).
               DOM-free (tested in Node):
  model.ts       Workspace / ChipDoc (pins, parts, wires = interior corners (`straight`: a simple connection, segments
                 at any angle, settings.simpleWires for new ones), pointers = named net labels, comments:
                 free text drawn under the circuit, never compiled and left out of the compile cache key)
  compile.ts     compileChip(doc) → ComponentDef + diags, netOfWire / netOfEnd / netOfLabel, connKey
  parts.ts       partDef(ref): library ids, user chips, splitters, constants, displays (LED / LED bank, 7-segment,
                 hex, value, buzzer: buzzerHz; and the halt part), keys and the keyboard (external sources: behaviour-only
                 leaves, isExternal; keyPart(bind), KEYBOARD, normalizeKey / keyLabel / keyCode / codeGlyph), ROM, RAM
                 (both up to 2^16 words: wordRom → romTree ≤ 2^8, else romLevels; RAM > 2^6: bigRam);
                 audio.ts plays the buzzers
  library.ts     UserLibrary: Merkle-cached compile of every chip, cycle checks, renamePort, removeChip
  ops.ts         pure edits (add / move / delete / flip / set*, copy / paste, namePart: rename where the name is
                 drawn); wires stay orthogonal (a straight wire's breakpoints stay put); dragWire (a corner or
                 segment grabbed: geom.ts grabOn; or a new corner: `{ bend }`, carried by the cursor after the right-click menu's
                 "Add a bend here"), removeBend, setStraight, clearBends
  history.ts     History<T>: undo / redo, transactions (a drag = one step), replace (not undone)
  store.ts       localStorage, sanitizer, JSON export / import (importChips: never overwrites, renames on
                 conflict, recognizes its own earlier renames); share.ts: share-link encoding
  files.ts       shareRoute / shareUrl, download names, import summaries, duplicateChip / deleteChip
  derive.ts      circuitMode, deriveBehavior (a combinational transistor chip → gate-level brick;
                 refused when an output can float: Z is not X on a shared bus)
  program.ts     ROM program text (asm / rv16 / hex) → words
  memory.ts      romImage (problems on source lines), romListing / romIndex (the row the circuit reads),
                 asm ↔ hex conversion, ROM_SAMPLES; readRam (live words; a large RAM's from its leaf state),
                 ramWithInit (initial contents as dotted power-on hints into the flip-flops' latches; > 2^6 words:
                 bigRamWithInit)
  examples.ts    EXAMPLES (fetch loop, counter + font ROM on a 7-segment digit, shared bus, wired-AND / OR),
                 addExample: new chip, opened
  geom.ts        snapping (ports on grid points), hit testing, pointer flags, junction groups, WireDraft
  session.ts     tab stack, new chips, input values kept across undo (keepVolatile)
  runtime.ts     EditorSim: rebuild on connectivity change only (debounced, carry state), cycle / gate run;
                 edgeHooks (before / after every rising edge, gate mode: after once quiet), runCycles;
                 halt parts at any depth stop Run / runCycles after the step where they read 1; key / keyboard
                 leaves at any depth driven through Sim.poke (setKey: held keys survive rebuilds and resets; typeKey;
                 a keyboard drops its oldest key when `ack` reads 1 just before a rising edge, or once settled
                 without a clock)
  palette.ts     registerPaletteGroup + the palette panel (purist filter)
  chips.ts       relations (used by / uses), pinOrder, renamePin (keeps parents wired), guessFf, nextDrive (inout)
  challenges.ts  build challenges: BuildChallenge (ports, table / sequence check, allowed parts, par),
                 startChallenge (u_ch_<id> with the pins placed), checkChallenge (BitSim / GateSim / SwitchSim;
                 failing vectors, restriction violations on the compiled hierarchy, score incl. static-timing
                 period for clocked chips), Allowed also `{ lib }` (the campaign: NAND + listed parts), importAnswer,
                 solveChallenge; challengeset.ts: CHALLENGES and their reference answers (chip documents
                 drawn with a small kit, each answer built from the answers of the rungs below);
                 CheckResult.failed: indices of the failing cases; tableRows / seqStart / seqStep: the
                 cases Check runs, shared with the test player
  testrun.ts     testSet(ch) (Check's cases, made on demand), TestReplay: a case played on the editor's own
                 simulation (EditorSim.notify / reapply), never the document; sequences step back from
                 checkpoints every 32 steps; a table replay starts from X (as Check's fresh simulation);
                 begin() / end() save and give back the simulation's state
  remix.ts       "Open in Sandbox": remixDef / remixIntoStorage (a shown def → a new chip; parts a reload could
                 not find by id come along as ROM / constant parts or chips); loaded on demand by the stage
  hops.ts        HopCache: wire hops recomputed for the moved wires and those crossing them only
  flowdir.ts     wireFlows: which way each drawn wire carries its signal (from part outputs / chip inputs,
                 cut at branch points; distance from the driver, sink or junction at the far end), for flowing bits
  probes.ts      ProbeTarget (wires / pin / pointer name) → flat nets of each new build (resolveProbe)
  sta.ts         chipTiming: static timing of a chip, critical path mapped to its parts / wires / pins
  lint.ts        lintChip: two nets drawn on one line, pointers without a twin, inputs left open (openInputs),
                 parts driving nothing that reaches an output (deadParts)
  cpu.ts         ChipDoc.cpu (rom, pc / retire as NetRef: pin / pointer / wire / part port, regs, fregs,
                 dmem, pipeline, iss options); part fields are paths into user chips ('imem.rom', partAt,
                 nestedRoms: detection takes the workspace's chips); detectCpu (the chapters' instance and
                 pin names: imem, rf, dm, frf, fcsr, pcOut / pcF, retire, validW, switches / irq /
                 consoleData / consoleValid / leds), resolveCpu (settings over detection), readers
                 (readRegs / readMem find w<i> registers via storageOf, banks, cache lines; memStoreOf also finds a
                 large RAM's leaf state), pipelineSlots,
                 CpuMonitor: the ISS in lock-step on EditorSim.edgeHooks (registers, PC, fcsr, memory
                 after stores or at a pipeline's halt, console, LEDs), first mismatch, Run to halt
  cpu16.ts       detectRv16 (an RV16 ROM + a part with the core pins), Rv16Monitor: Iss16 in lock-step through the
                 core's write and store ports in program order (the campaign bench, live; RAM wrap, drain, next write)
  multicpu.ts    detectMulti (two or more placed CPU chips + a shared memory), MultiMonitor: MultiISS in
                 lock-step (which cores retired, each core's registers and PC, shared memory)
               DOM:
  editor.ts      Editor: workspace + history + library + sim + panels; registerToolbarAction, slots
  view.ts        EditorView: one SVG element per object updated in place, live values, overlays
  tools.ts       the mouse / keyboard state machine (place, select, drag, band, free-hand wires, pointers, rename
                 in place: F2 / a click on a selected name / editInline)
  ctxmenu.ts     plugin: the right-click menu (selection actions with their shortcuts, or the canvas's own)
  iobar.ts       plugin: the chip's pins as a bar above the run bar (the workbench's switches and lamps, I/O toggle);
                 each control acts as a click on the pin
  keys.ts        plugin: document keys → key parts (a bound key is taken from the shortcuts while the chip is open)
                 and keyboard parts (while running, or with the Type toolbar toggle); released on blur
  props.ts       properties of the selection or the chip, diagnostics; registerPropsSection
  fileui.ts      File menu (export / import / share link / Verilog / images / chip manager), share banner,
                 drag-and-drop import, autosave indicator, backup notice; installFiles(ed) per page
  memui.ts       Memory palette group, ROM / RAM property sections (live listing, RAM grid, initial
                 contents), the program editor dialog, Examples ▸; values polled per frame while shown; long
                 lists build only the rows in view (vlist.ts: virtualRows), a large RAM's grid has Go to
  package.ts     "Package as chip…" dialog (name, hue, notes, symbol preview, pin order; Save & new circuit)
  inside.ts      lookInside(ed, path): read-only live schematic over the canvas on EditorSim's simulator (ViewCtx)
  challengeui.ts "Challenges" list drawer (solved ticks via settings), the strip under the canvas while a
                 challenge chip is open (brief, Check, Show answer, Do it for me), purist palette while restricted;
                 a failing Check opens the test player on the first failing case; a core level lists its
                 programs, each watchable on a bench (campaign/bench.ts)
  testplayer.ts  the test player (Turing Complete style): step, scrub, play at a rate stopping at a failure,
                 jump between failures, a window of cases with the live row; an edit while paused replays the
                 case on the rebuilt circuit; Run / Step / a clock / Reset or an input set by hand ends it
  inspect.ts     the Inspector in a drawer for the chip or a part; chipprops.ts: chip / part property sections
  dock.ts        the right-hand dock: drawers (Inspector, CPU, challenges) share it, tabs when several;
                 sets --dock-space on the overlay so look inside stops at its edge
  analysis.ts    plugin: probe mode (P) + LogicAnalyzer in slots.bottom, Timing props section with
                 the critical path drawn on the chip, lint as a diag source, open-input marks
  cpuui.ts       plugin: the CPU panel (docked drawer: status, listing with the PC and pipeline stages, a
                 click marks the instruction's parts (insthw names) and colours its field wires
                 (instrMarks → wires by net), field breakdown (widgets/instrfields), pipeline diagram
                 (widgets/pipegrid), the system CPU's I/O, registers, fcsr, memory, retired; Run to halt,
                 Step, Slow (instructions per second), Reset, Edit program; the multi-core view),
                 opened by itself for a complete CPU; CPU props section
src/campaign/  the campaign (#/campaign, its own chunk; plan and status in docs/CAMPAIGN.md). DOM-free:
  types.ts       CampaignNode (act, kind lesson / drill / build / program / core, requires, why, tips, codex,
                 unlocks: library ids or `prefix*` later levels may place, anatomy blocks, base challenge, par, soon)
  nodes.ts       ACTS and NODES: the tree, act 0 (transistors) to act 8 (side quests)
  graph.ts       ancestors, topo, ruleFor(id) (NAND + unlocks of the requirements' closure: fixed per level),
                 statusOf (locked / available / started / solved / skipped; Unlock all), nextAvailable
  levels.ts      levelChallenge(node): the base BuildChallenge with the campaign rule and par, id cp_<node>,
                 chip u_ch_cp_<node>; nodeOfChip; startCandidates / startFrom (a core level begun as a copy of an
                 earlier core level's chip, plus the new pins)
  grade.ts       measured(score), stars (★ pass, ★★ ≤ 1.5 × par, ★★★ ≤ par on every graded metric), better
  progress.ts    Progress (own storage key, injected KV): status, best, stars, tips, seen; codexUnlocked;
                 exportCampaign / importCampaign (progress + level chips' closure, merged, never overwriting)
  codex.ts       CODEX entries (component / law / tool / trick / concept); lessons.ts lesson HTML
  anatomy.ts     the target CPU as blocks (intro diagram), blockNodes; layout.ts the map's placement
  drills.ts      generated questions with exact checkers (numbers, Boolean parser, exact K-map minimum, RV16
                 encoding, binary16); puzzles.ts RV16 program puzzles on the golden model (size, cycles)
  build1/5/6/7/8/9.ts, buildh.ts, buildfp.ts  the levels new to the campaign by act: BuildChallenges whose reference
                 answers are library blocks drawn as chips (docFromDef; build9 / buildfp also draw sub-units as chips of
                 their own); a side quest gives its reference's parts (givesOf); buildfp: the FP ladder (unpack, rounding
                 decision, sticky shifter, leading-zero counter, normalize & round, compare, int → float), whose blocks
                 (FP_BLOCK) are never given, only unlocked by the rung that built them (fpGives)
  bench.ts       addBench: a failing core test as a computer chip around the learner's core (RV16 ROM, 64-word
                 RAM, LEDs, IRQ line), opened with the CPU drawer; failingTest names it from a failure line
  datasheet.ts   a codex component entry's datasheets: the unlocked library parts' pins, cost, depth, truth table
  corecheck.ts   the CPU core bench (coreCheck carries its CoreSpec: coreSpecOf): instr / drdata served
                 combinationally, register-write and store traces
                 compared with iss16 in order, cycle budget, irq from stores to 0xFFF9, 32 BitSim lanes (GateSim
                 fallback), corePeriod (static timing with 8-delay memories); coretests.ts the programs by stage
               DOM: ui/svgs.ts (map and anatomy SVG); the page is ui/pages/campaign.ts. Levels are played in the
               sandbox: challengeui.ts recognizes u_ch_cp_* chips (breadcrumb, tips, stars, Next), records passes in
               the campaign's progress, and fills the palette's "Unlocked parts" group from the level's rule
src/ui/        app shell, router, theme, settings, progress; chapternav.ts (DOM-free: every chapter / step as a
               searchable entry, searchNav ranking), quicknav.ts (chapter menu on the top bar and the chapter title,
               Ctrl/⌘ K or `/` search palette; `/` is left to the sandbox there)
tests/         Vitest: every component with a `spec` is checked exhaustively (≤ 12 input
               bits) or randomly against its structure; sequential behaviour tests
```

### Key ideas (read before changing the core)

1. **One description per component.** A `ComponentDef` has ports, a symbol, and either a
   primitive (`prim`), a lazy `netlist()`, and/or a `behavior`. The netlist carries layout
   (instance `at`, pin positions, optional `trunk` / `via` routing hints). Simulation,
   drawing, statistics and Verilog are all derived from it, so they cannot drift apart.
2. **NAND is the brick.** At gate level the only real primitive is `prim: 'nand'`. NAND's
   own netlist is its 4-transistor CMOS circuit (`level: 'switch'`), which is shown when
   the learner opens a NAND (solved by `SwitchSim`, driven by the parent's values).
   The one exception is an *external source* (`isExternal`: a behaviour with no structure and no
   primitive, the sandbox's key and keyboard parts): it stands for the world outside, so it is a
   leaf of every simulation whose state the editor sets through `Sim.poke`, costs nothing and is
   a comment in Verilog.
3. **Bit-level nets.** Buses are bundles of 1-bit flat nets. Splitters and mergers are
   `prim: 'alias'`: pure wiring, merged by union-find in the flattener, with zero cost.
4. **Mixed-level simulation.** `preferBehavior: true` keeps a component (the instruction ROM) as a
   behavioural leaf; opening it starts a lock-step sub-simulation of its structure (a stateful
   leaf, a large RAM, seeds that structure from its state: `Behavior.inside`, ViewCtx.sync). The
   flattener also accepts an `expand` policy for more cuts (needed for pipelined / multi-core
   designs). Tests must prove behaviour ≡ structure; the CPU is co-simulated against the ISS
   after every instruction (`tests/cpu.test.ts`).
5. **Timing is real.** Every NAND has a delay of 1. `GateSim.step()` advances one time
   instant, so the UI can animate propagation (watch the carry ripple). Transport delay
   shows glitches. Perfectly symmetric races (an SR latch with both inputs released at
   once) are resolved by `relax()` (Gauss–Seidel), modelling metastability resolution;
   `sim.unstable` reports it.
6. **Power-on.** `reset('zero')` applies `powerOn` hints (e.g. SR latch q = 0), relaxes,
   then forces any remaining X storage loops. `'x'` keeps them unknown (educational), and
   `'random'` models real silicon.

### Authoring components

- Use `define({...})` so the component appears in the library and gets tested.
- Give every combinational component a `spec` (packed inputs → packed outputs). Tests
  pick it up automatically from the registry or from `tests/library.test.ts`.
- Generators (`rca(n)`, `ram(k, w)`, ...) must be memoized (one parameter set → one object).
  To show one in the workbench, add a `Family` in `src/lib/resolve.ts` (`key(p)` must return the
  id `make(p)` builds; `tests/library.test.ts` checks it, and `tests/layout.test.ts` label-checks the default).
- Layout in grid units (1 unit = 10 px). Port positions come from `geometry.ts`; check
  them there before placing instances. Gate shapes: inputs at y = 1, 3 (+top), output at
  mid-height, width 4. Box pins are spaced `symbol.pitch` (default 2). Use splitter and
  merger `pitch` and box `pitch` to line rows up so wires stay straight; use `trunk` (x of
  the vertical trunk for horizontal drivers, y for vertical ones) and `via` (corner points)
  to untangle feedback paths.
- No two nets may share a line (`tests/route.test.ts` checks every registered netlist). The
  router moves a colliding trunk in half-grid steps (`trunk` is a preference) and reroutes a
  path that still collides around symbols (A*); `via` paths are never moved, so make sure
  your vias don't run along another net.
- No symbol may sit on another, and no label may hide one (`tests/layout.test.ts`: `symbolOverlaps`,
  `labelOverlaps` over every registered netlist and the CPU tops).
- Prefer hierarchy (a box of boxes) over flat netlists: it is the whole point of the site.
- Large top-level schematics: draw the main data path, and use **net labels** (`tags` on a
  NetDef) for control signals and long feedback paths, like a real schematic. Place
  instances so that ports line up (see `alignY` in cpu.ts) and data wires stay straight.
- Hand-written SystemVerilog goes in `hdl.verilog` (behavioural or structural, matching the
  primer's style). Structural Verilog is also generated automatically.

### CPU scenes

`cpuScene({ source, pipeline?, system?, m?, dcache?, multicycle?, adder?, timing? })` (widgets/cpupanel.ts) builds a CPU scene
with the CPU panel (listing, registers, memory, golden-model lock-step) and optionally the
pipeline diagram and the static-timing panel. Panels observe clock edges through
`stage.edgeHooks` (before / after every rising edge), so they stay correct during fast runs.
The pipeline's golden model steps when a valid instruction is in W (`retiring()`).
Clicking a listing line highlights the instruction's hardware (insthw.ts) in focus mode
(`stage.highlight(names, true)` fades the rest); "in ROM" calls `stage.reveal(['imem'], 'c<i>')`.
**Slow mode** (CPU panel) ticks at a learner-set rate (`settings.traceRate`, or `speed` for gates) at one of
three levels: `gate` (`stage.startEdge()` / `edgeStep()`: a rising edge one gate delay at a time, via
`src/sim/edge.ts`, which `Stage.cycle` also uses), `cycle` (`pulse(flowMs)`) or `instr` (run to the next
retirement). The highlight then follows execution, and the trace logs `stepEffect(iss.step())` (riscv/trace.ts).
While `stage.inEdge`, panels must not compare the hardware with the golden model (it steps after the edge).
**Back** (CPU panel and the stage's bottom bar) undoes a step, a clock cycle, an input change or a whole Run to
halt: the stage's controls call `stage.checkpoint()` before acting (an unchanged state is not saved twice), panels
call it before an action made of several (a run, an instruction); `Sim.saveState()` / `restoreState()` copy the
whole simulation (values, inputs, time, pending events), and a panel with its own state (golden model via
`ISS.save()` / `MultiISS.save()`, trace, counters, console) registers a `stage.historyHooks` entry. The analyzer
`rewind`s to the restored time. History is cleared on load and Reset.
The pipeline diagram reads `pipeSnap` (riscv/cosim.ts) and draws with `widgets/pipegrid.ts`, shared with
the sandbox's CPU drawer (editor/cpuui.ts), which mirrors these panels for any CPU opened in the sandbox:
keep the two in step when a panel gains a feature.

### Viewing aids (all derived, none stored in the netlists)

- Wire palettes: `data-palette` on `<html>` (styles/palettes.css, `light-dark()` tokens). Use
  `--w0 --w1 --wx --wz --bus --bus1` and the shape tokens (`--wire-w0` …), never raw colours.
  Probe colours are `--probe-0..7` (class `p0..p7` sets `--pc`).
- Colour per net (settings.netColors, `data-netcolors="on"`, off by default): view/nethue.ts gives each net a hue from
  `netKey` (its name, else its sorted ends), then `spreadHues` moves those within 60° of a net drawn next to them (from
  the routed paths in SchematicView, the wires' polylines in EditorView: recomputed per build and wire shape); drawn elements carry it as inline `--nh` (value classes are rewritten on
  every repaint) and palettes.css rebuilds `--w0 --w1 --bus --bus1 …` from it. A new per-net element must get
  `setNetHue` too.
- Module colours: library boxes and muxes are tinted by `CATEGORY_HUE[def.category]` (view/symbols.ts,
  class `.sym.cat`, the same `--chip-h` styling as a user chip's hue); `data-modules="plain"` on
  `<html>` (settings.modules) turns it off. `data-wide` (settings.wide, the stage bar's panes button)
  hides the chapter / workbench side panes.
- Camera: `fitted` stays true until the learner zooms or pans; a canvas resize (the bottom bar rewraps
  during a run) refits only a fitted view, else `resized()` keeps the scale and top-left corner.
- Hops, tap bit ranges, net selection and probe flags are computed in the view from the
  routed nets; nothing to author.
- Flowing bits (`settings.wireFlow`, a switch in the wire-colour menu; `data-wireflow="off"` on
  `<html>` hides it): a 1-bit wire carrying a 1 shows pellets (view/flow.ts: a dash pattern on an
  overlay path `.wire-flow`, CSS-animated); a bus carrying a non-zero word shows its value riding
  along as tags (view/flowtokens.ts: one rAF loop, positions from polylines, `.bus-label.riding` steps
  aside); nothing flows on 0 / X / Z. Both take their phase from one clock and lanes carry their
  distance from the driver (`laneTails` for a schematic net's paths, editor/flowdir.ts for the
  sandbox's wires), so a value reaching a junction carries on along every branch; tags fade only at
  the driver and at a sink. Both SchematicView and EditorView draw it; wire classes are untouched.
- Slow motion draws each change as a front over one gate
  delay (`SchematicView.flowMs`); the simulation's timing is unchanged.
- The Timing panel only records nets of the scene's own simulation (`ctx.sim === stage.sim`);
  sub-simulations (an opened NAND, the ROM) cannot be probed. `Scene.analyzer` opens it.

### Sandbox editor

- Every change goes through `Editor.edit()` (one undo step), `begin()` / `commit()` (a drag: one
  step) or `volatile()` (open tabs, input values: saved, never undone); `refresh()` then updates
  the library, view, simulation and panels. During a drag only the drawing follows.
- The simulator is rebuilt only when `simKey` (connectivity + part definitions) changes; input
  values are stripped before compiling, so toggling an input recompiles nothing.
- Later phases plug in through `registerPaletteGroup`, `registerPropsSection`,
  `registerToolbarAction` (`active` for toggles), `registerEditorPlugin` (per-editor state, with a
  cleanup), `registerDiagSource` (extra diagnostics, e.g. lint), `Editor.onSimChange`,
  `Tools.onPress` (a mode that takes clicks first) and `editor.slots` (`overlay` over the canvas,
  `bottom` above the run bar, `top` in the tab bar). `editor.saveState` / `onSave()` report autosave
  (saved / saving / error). `editor.paintHooks` run after every repaint (live views over the
  simulation: look inside, inspector). `editor.sim.edgeHooks` observe rising clock edges (before /
  after, whatever drives them: Run, Step, a click on a clock, `runCycles`); the CPU panel's golden
  model steps there. `editor.sim` is per chip: a plugin keyed on it must follow tab switches. Drawers
  go in the right-hand dock (`dockPane` / `undockPane`, dock.ts), not straight into `slots.overlay`:
  they share the edge as tabs and look inside stays clear of them. Feature modules and plugins register themselves when
  ui/pages/sandbox.ts imports them (not editor.ts: they import it).
- Pins are 1 to `MAX_WIDTH` (1024) bits, and values are exact at any width: `PinDoc.value` is a
  `PinValue`, a number while exact (< 2^53) else lowercase `'0x…'` text, one spelling per value
  (`pinValue(bigint)`, `pinBig`; the store canonicalizes). EditorSim drives inputs bit by bit
  (`Sim.setInputBits`, `pinBits`); labels and tooltips format bit arrays (`formatBits`, BigInt
  decimal past 53 bits; `describeBits`), the bit editor (`editNumber`) and the analyzer / VCD
  use BigInt. Never route a pin value through a JS number (`pack`, `2 **`, `%`): it rounds past
  53 bits. Constants (≤ 53), RAM words (≤ 32) and derived behaviours (outputs ≤ 53) stay numeric.
- Double-click a placed user chip: `editChip` (tab breadcrumb, Back); any other part: `lookInside`.
  A bidirectional pin's `value` is what the user drives onto it (absent: Z), switch level only.
- Shared buses: at switch level any number of outputs may drive one net (the solver resolves value /
  Z / pulled value / X). `PortDef.tri` marks outputs that can let go (TRIBUF, pull-ups, a user chip
  whose output nothing inside drives hard); two outputs that always drive on one net get a
  contention warning. Tri-state cells have no behaviour, so any chip using them is switch level.
- Performance: a drag refits only wires on moved objects (ops.ts `refit`), the view recomputes
  polylines / hops / dots only for what moved, a transistor chip's derived model and flip-flop
  check are cached by a structural key (compile.ts), and the last four chips keep their
  simulation across tab switches. `npx vite-node scripts/sandbox-perf.ts` measures the
  DOM-free costs on a CPU and a 64-bit Kogge–Stone adder opened in the sandbox.
- Probes and the timing panel are gate level only (the switch-level solver has no time); lanes
  name what was drawn and survive rebuilds (`LogicAnalyzer.rebind` keeps the recording).
- Keys are handled on `document` while the page is mounted and ignored while typing in a field.

### Writing chapters

A chapter is a list of steps. Each step has narrative HTML and either a `scene` (a root
component, initial inputs, optional drill path, highlights, probes) or a `widget`, plus an
optional `challenge`. Keep the prose short, concrete and honest. Introduce a component
as a black box only after its inside has been shown. Say what each thing *costs*.

## Major changes: mockup first

Before building a major change (a new screen or page, a new visual mode, restructured navigation, a new act
or chapter structure, a 3D or other new view), show the author a mockup (an image or a static HTML page) and
get approval. Small fixes and additions inside an existing screen don't need one.

## Git workflow

- **Never work directly on `main`.** Every change or feature goes on its own branch, cut
  from an up-to-date `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
- **Commit and push often**: one logical change per commit, pushed to `origin` as you go
  (`git push -u origin <branch>` the first time). Don't let work pile up locally.
- Commit messages: short imperative subject (≤ 72 chars), body explaining *why* when it
  isn't obvious. Stage files explicitly; never commit `dist/`, `node_modules/` or secrets.
- **Ask the user before merging into `main`.** Merging deploys the site (see CI above), so
  it is never done on Claude's own initiative. Summarize what the branch changes when asking.
- Before merging, on the branch:
  1. Bring it up to date with `main` (`git fetch && git merge origin/main`, or rebase if
     the branch is unpushed/private) and resolve conflicts.
  2. Run the full gate: `npm test`, `npm run typecheck`, `npm run build`. All must pass;
     report failures instead of merging.
  3. For visual changes, check `npm run dev` in light and dark themes.
- **Merge with `--no-ff`** so every feature stays a visible merge commit, from the branch's worktree
  (never the shared checkout): `git checkout --detach origin/main && git merge --no-ff <branch>`, then
  `git push origin HEAD:main`. A rejected push means main moved: fetch, merge again, re-gate. `/ship`
  (`.claude/skills/ship`) runs the whole sequence, deploy watch included.
- If the user's approval is terse ("go ahead", "3"), restate in one line what you are about to do first.
- **Never delete branches on GitHub (`origin`).** They are kept as history. Deleting the
  local copy after a successful merge and push is fine.
- Never force-push `main`, never rewrite its history, never skip hooks (`--no-verify`).
- `.claude/hooks/guard.mjs` enforces these (and the shared-checkout rules below) on every shell command;
  `.claude/hooks/typecheck.mjs` typechecks the repos a turn edited before it ends. A command the user
  explicitly asked for may end with `# user-approved` to pass the guard.

### Parallel sessions

Several Claude sessions (and their subagents) work in this repo at once.

- The main checkout (`E:\MOSFET to RISCV`) is **shared**: never switch branches, reset, stash, clean,
  rebase or commit there, and leave uncommitted changes you did not make alone (report them).
- Every task gets its own worktree: `git worktree add -b <branch> E:/MOSFET-<topic> origin/main`, then
  link `node_modules` as a junction (PowerShell `New-Item -ItemType Junction -Path <wt>\node_modules
  -Target 'E:\MOSFET to RISCV\node_modules'`). To remove one, delete the junction first
  (`cmd /c rmdir <wt>\node_modules`), never `rm -rf` it: that wipes the shared `node_modules`.
- Each session serves on its own free port (check it first): prefer `vite preview --port <n> --strictPort`
  of a build over `vite dev`, which writes to the shared `node_modules/.vite`.
- Use ListAgents / SendMessage to coordinate with a session whose branch or worktree you would touch.

### Windows environment

- Git Bash mangles `/`-leading and `#` arguments: set `MSYS_NO_PATHCONV=1` for hash URLs (screenshots).
- `node_modules` has no `.bin`, so `npm run typecheck` / `npx` fail from Git Bash: run
  `node node_modules/typescript/bin/tsc --noEmit -p .`, `node node_modules/vitest/vitest.mjs run`,
  `node node_modules/vite/bin/vite.js build | preview`, `node node_modules/vite-node/vite-node.mjs <script>`.
- Python is not installed. Write multi-line content with the Write / Edit tools, not quoted heredocs.
- `gh` is at `C:\Program Files\GitHub CLI` (add it to PATH in Git Bash).

## Testing expectations

- `npm test` and `npm run typecheck` must pass before committing.
- New component → spec or behaviour test. New simulator feature → unit test.
- A reported bug → first a failing test that reproduces it (a truth table, a sequence, a layout /
  overlap check in `tests/layout.test.ts` or `tests/route.test.ts`), then the fix; prefer fixing the
  shared renderer / router over a per-component patch.
- Visual changes: run `npm run dev` and look at it, in both light and dark themes.
