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
npm run smoke        # every route of dist/ in headless Chrome, fails on any runtime error (~3 min)
npm run desktop      # build + desktop/ (Electron, own package): portable Windows .exe in desktop/release/
```

`desktop/`: main.cjs serves the staged site (stage.mjs: dist/ without source maps, Google Fonts swapped for
local @fontsource copies) on a private `app://mosfet` origin; data next to the .exe (PORTABLE_EXECUTABLE_DIR);
fuses off (runAsNode: VS Code sets ELECTRON_RUN_AS_NODE, so run `electron .` there with it unset). Share links
made in the program point at the public site (editor/files.ts `SITE_URL`). `.github/workflows/desktop.yml`
(after every successful deploy of main, from the deployed commit; manual; or a `v*` tag) publishes the release `desktop-latest`.

`scripts/smoke.ts` (no dependency: launches Chrome itself, `CHROME` env else the usual paths, and speaks the DevTools
Protocol over Node's WebSocket) serves dist/ with `vite preview` (or `--url <site>`) and opens every route generated
from the code (chapter steps in both themes, each workbench family's default, campaign map / intro / codex / every
level, sandbox and its examples seeded in localStorage) as a fresh load in parallel tabs (`--tabs n`), each in its own
browser context; it fails on exceptions, console / browser errors, failed requests (`OPTIONAL`: layout/ and Google Fonts),
"could not load" panels, editor error toasts / diagnostics, an empty main view, and horizontal overflow at 1280 px and on
a 390 px phone (a few pages), and a sandbox toolbar label cut or scrolled out of view (also at 1440 and 1920 px), the open tab under Open… / New chip, and on every
route a stage bar's button past its edge, the open level's name cut on a one-row stage bar (view/stage.ts fitBar: labels off, then
buttons into More, then a row for the hierarchy) or the run row cut (fitControls: icons only, then wrapped within its row). `--only <substring>`, `--headful`, `--dwell <ms>` (wait after settling, default 600).

CI (`.github/workflows/deploy.yml`) runs tests beside build + smoke (one job) and deploys `dist/` to GitHub Pages
on every push to `main`. The deploy also waits on `verify-hdl`: `scripts/verify-export.ts <design>`, one parallel job per design (multi, sys, sys-m, core-m: the system core with ports on tests/syscorebench.ts, the layout flow's design)
(Yosys synthesizes the exported dual-core and the RV32I / RV32IM system CPUs, each netlist is simulated against ours,
every output every cycle, on their programs with irq pulses and switch changes). Run it locally (`npx vite-node scripts/verify-export.ts all`, needs `pip install yowasp-yosys`)
before merging a change to the exporters, the dual-core or the system CPU (one design: `verify-export.ts sys-m`).
It also waits on `fpga`: `scripts/fpga-export.ts counter7 computer` (the sandbox's FPGA export of those examples, through
editor/fpga.ts as the File menu runs it, then Yosys `synth_gowin` on the design with its Tang Nano 9K board top; files in layout/fpga/).
`.github/workflows/spike.yml` (every push touching `src/riscv/`, fpref.ts or the oracle; nightly on new seeds) runs
the golden model against Spike, commit by commit (`scripts/spike-oracle.ts`, docs/VERIFICATION.md); a change to the
ISS should leave it green before merging (its failure artifact keeps the program, ELF and Spike's log).
`.github/workflows/layout.yml` (pushes touching scripts/layout/, export-layout.ts, vexport.ts) runs OpenROAD-flow-scripts on sky130
per design (`export-layout.ts dual | sys`: Verilog, config, source.json with our NAND counts per block and static timing), ~35 min
each; main and manual runs publish the release layout-latest (dual-core at its root, system core under sys/), which the deploy unpacks
into dist/layout/ (widgets/chiplayout.ts).

## Stack and conventions

- Vite + TypeScript (strict, `verbatimModuleSyntax`: use `import type` for types). No UI
  framework: plain DOM + SVG with small helpers in `src/ui/dom.ts`. Keep the bundle small.
- Hash routing (`#/c/<chapter>/<step>[/<inst>…]`, `#/workbench/<componentId>[/<inst>…]` — the optional segments are the
  part opened on the stage, one history entry per level, `~` for the top when the scene opens deeper (ui/drillpath.ts) — `#/workbench/stats`, `#/workbench/bench`, `#/sandbox/<chipId>`, `#/campaign[/n/<node> | /play/<node> | /intro | /codex[/<id>]]`,
  `#/sandbox/s/<payload>` for a share link) so the site works on
  any static host or sub-path.
- Theme: CSS custom properties in `src/styles/`; `data-theme="light|dark"` on `<html>`, or
  absent for auto (`prefers-color-scheme`). Always define new colours for both themes.
- Match the surrounding code: terse, typed, comments explain *why*.
- Accessibility: a control drawn in SVG is a `g` with role="button", tabindex 0, an aria-label and Enter / Space
  (never inside role="img": the campaign map and the anatomy are role="group"); `--muted` is the faintest text
  colour that passes WCAG AA (4.5:1) on --bg / --surface / --surface-2, so do not go lighter for small text. Touch:
  `@media (pointer: coarse)` blocks at the end of app.css and editor.css grow buttons, rows and icon buttons to
  40 px; a new small control gets a rule there. A menu or drawer closed with Esc gives the focus back to its opener.

## Architecture

```
src/sim/       simulation core (no DOM)
  types.ts       ComponentDef / PortDef / Netlist / NetDef: the single source of truth; Behavior: init(mode),
                 seq (edge-triggered state: timing / logicDepth see storage), carry (heal on an edit), inside (seed
                 an opened leaf's structure: InsideSeed.state / .bits); hdl.synth (vexport's body for a part)
  geometry.ts    symbol sizes and port positions (grid units) shared by authors, router, renderer; orientGeom / instPort:
                 an instance mirrored (flip) then turned (rot, quarter turns clockwise; `at` = the turned box's top-left);
                 orientedBox: a turned box as a box of its own (drawn upright, symbol.turned: top / bottom names across);
                 centredAt: a part's corner keeping its ports on the grid
  flatten.ts     hierarchy → flat 1-bit nets + leaves, keeping a HierNode tree mapping every
                 level's ports/wires to flat nets (this is what makes every box transparent);
                 powerOn hints may be dotted paths into children ('w3.ff0.ff.slave.sr.q'); one array per net, shared by the ports
                 on it and the leaves reading it (never mutate one), HierNode.path computed from the parents (memory: ch 33's
                 413 501 leaves)
  gatesim.ts     event-driven 3-valued (0/1/X) simulator, unit NAND delay, transport delay,
                 relaxation for power-on and oscillation resolution; runUntil(t) for a
                 fixed-period clock (an edge does not wait for the logic to settle); onTrace +
                 watch() report every change of watched nets at its exact time; hot loops on typed arrays
                 (tests/ref/gatesim-ref.ts: the old object version, gatesim-fast.test.ts: same events, same times);
                 adopt(src, changed, dirty): take over another engine's settled state of the same design;
                 countToggles(): per-net 0 ↔ 1 transitions in `toggles` (glitches included), for power.ts
  clusters.ts    findClusters(design): storage by structure, no `ff` mark needed (rounds: loops among free NANDs,
                 gates on short loops (≤ 6) seed clusters, which take in private gates that follow a pin or add no
                 input, latch pairs join, deepest instance first); chainRoot/Delay/Parity: nets that follow a pin
                 through k inverters (a pin, its inverse)
  ffmacro.ts     FfTable(spec): a cluster as a state machine of settled net vectors, from unit-delay simulation of
                 it alone; Profile: timed inputs (groups following one pin, delay, parity; the clock's group),
                 data inputs (change ≥ `early` delays after the pins), constants; good(id) / why(id) check by
                 simulation that it is exact from a state (every pin change combination, data at every delay from
                 early, pairs in any order, pulses; outputs never follow data with the pins steady); partner(id): the
                 clock-toggle pair it sits in while nothing changes; FfTable.of(def): an `ff` def alone (tests)
  cyclesim.ts    CycleSim.build(design) (or a reason): clusters as FfTable lookups (tables shared by structure and
                 profile across builds; stable ones skipped at edges, internals read from the table), the rest
                 levelized (a `seq` behaviour ordered by its comb inputs); settle = phase 1 (clusters following a
                 changed pin, behaviours reading one or poked, on pre-edge values) then one levelized sweep; false,
                 nothing changed, `refusal` says why, for an X clock, a transition no table vouches for, or a pin
                 changing with an inverted clock on a path shorter than it (hazards). Refused at build: a clock
                 port no pin drives (gated, ripple: clockDivider), a seq clock not a pin, a behaviour on a
                 clock-derived signal, loops through behaviours, storage with > 5 inputs
  dualsim.ts     DualSim: GateSim + CycleSim behind one Sim (preferFast: the sandbox's cycle mode; prepare() builds
                 the cycle engine outside a frame budget); GateSim for step / runUntil / onTrace, power-on and
                 carry, a settle the cycle engine refuses; the state handed over both ways; whyNot: why it is not on
                 the cycle engine now (tests/cyclesim*.test.ts, cyclekit.ts)
  switchsim.ts   switch-level MOSFET solver (0/1/X/Z, shorts, floating nodes); `strength` levels:
                 shorted / hasShort / shorts() (a crowbar: sure transistor paths to a 1 and a 0 source; per group the
                 transistors to each source) and shortText ("VDD shorted to GND through p1, n1"): the views' `short`
                 class (--wshort), the sandbox's diagnostics, the checks' failures; weakOf / hasWeak / leaky (weak
                 levels: WEAK_H a 1 only NMOS pass, WEAK_L a 0 only PMOS pass, VT_VOLTS; weakLevel / weakTag "H · 0.80 V";
                 the bit stands, an NMOS gated by H passing a 1 → X; drawn `vl weak`, checks fail a weak output);
                 rails/inputs > transistors (strength 4..2, ratioed logic) > resistors (prim 'res',
                 strength 1: pull-ups lose to any transistor; two opposing → X) > bias resistors (strength 0) > stored charge
                 (`cap` nets and prim 'cap' capacitors keep their value when undriven); charge levels (DRAM):
                 `level(net)` a fraction of VDD, floating charge nets joined by switches share Σ C·V / Σ C (C from
                 NetDef.cap), a level reads as a bit only near a rail (LEVEL_HI / LO, else X); prim 'vhalf' a source
                 at ½; prim 'sense' (en, a, b) latches the higher line when en rises (X below `offset`), flips when a
                 stronger driver forces a line; `leak(cycles)` drains nets with NetDef.leak (half-life in cycles);
                 opened as the root, a sense prim flattens to the transistors it is drawn with; prim 'fgmos' (g, d, s, vp,
                 pgm, ers: flash) an NMOS whose threshold is stored charge (fgCharge / setFgCharge): conducts at g = 1 while
                 the charge is below FG_READ, always at vp = 1 (pass voltage); a rising pgm with g = 1 and the drain at 0
                 adds FG_STEP, a rising ers empties it (settle applies the edges, then settles again); prim 'relay' (a, b
                 the coil, then c / no / nc per pole: prologue P1): the coil a resistor between its ends (an undriven line it
                 feeds reads 0), the contacts strength-4 switches on the armature (relayOp: B0 released, B1 operated, BX);
                 armatures move only at a relay step (relayStep: every relay takes its coil's state at once), so time counts
                 relay steps, step() takes one, settle() takes them until quiet (RELAY_SETTLE_MAX, then unstable: an
                 oscillator); relayState / relayEnergized for the view; kept by saveState, carry; the stage plays relay
                 steps like gate delays (relayTime: Step, animate, "settled in n relay steps"); prim 'triode' (g, p, k) and
                 'diode' (a, k) (prologue P2): one-way elements, each two sources of its own set every iteration from the far
                 terminal (the cathode's 0 onto the plate, the plate's 1 onto the cathode; the triode only while its grid is
                 1, a maybe at X), as strong as the path behind that value (vLv[2·net + value], kept across solves, saveState,
                 carry: a cross-coupled pair keeps its bit); levels nothing sits on are skipped
  nmossim.ts     NmosSim: event-driven switch-level engine for large NMOS circuits (Appendix A's 6502): a change
                 recomputes the channel-connected groups it reaches (rails and driven inputs end a group); GND / an
                 input 0 beats VDD / 1 (a short is counted), any of those beats a pull-up (prim 'dep' or 'res' to a
                 rail), else the charge of the largest-capacitance node (NetDef.cap: a number = relative capacitance);
                 two-valued; an oscillation leaves its nodes pending for the next settle (stuck, unstable)
  bitsim.ts      two-valued bit-parallel simulator for benches: 32 lanes per NAND word op; behaviours broadcast
                 from lane 0 unless setLaneBehavior evaluates one per lane (each lane its own program ROM)
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
  techcount.ts   fanInfo / fanHistogram / fanSum: NAND inputs reading each 1-bit net, per definition (memoized, never
                 flat: only port counts and joined port bits travel up; equal to the flattened count, tests/tech.test.ts)
  dead.ts        deadInstances(netlist, ports): parts no path leads from to an output (tested over every netlist
                 and reference answer; the sandbox lint warns about them)
  settle.ts      outputSettle(def, vectors): simulated input-to-last-output-change delay (sees false paths)
  power.ts       dynamic power estimate: netCaps (C per net from fan-out: FF_INPUT / FF_DRIVER / FF_WIRE, illustrative
                 28 nm-class), ½ C V² per toggle, PowerMeter over a GateSim (reset / mark after settles: settled vs glitch
                 toggles; breakdown(node): switched C by the child driving each net, the clock and inputs at the root),
                 measurePower(def) on seeded random vectors / clock cycles, vectorPower, fmtEnergy / fmtPower, POWER_NOTE
  timing.ts      static timing: register-to-register critical path, per-capture-stage periods (a `seq` leaf:
                 inputs captured, comb inputs → outputs launched at clk-to-q); { delay: 'load' } times by delay.ts;
                 timingGraph: the graph it walks (boundaries, drivers, delays, arrival on demand), shared with slack.ts
  slack.ts       slackOf(design, model): every leaf's and flip-flop's longest path through it (arrival + the longest path on
                 to a capture), input → output without flip-flops; slackAt(s, path): slack per instance of a drill level;
                 slackBand / SLACK_BANDS, slackHeat (band + tooltip): the Timing panels' heatmap (view/delayui.ts heatToggle /
                 heatLegend; Stage.heat / SchematicView.heat set data-slack on instances, app.css --slack-0…4)
  netcap.ts      FF_INPUT / FF_DRIVER / FF_WIRE, netCaps, driverOf (shared by power.ts and delay.ts; power re-exports them)
  delay.ts       load-dependent delay (Phase 19): logical effort per NAND (d = p + g·h), DelayModel 'unit' | 'load'
                 (buffer chain where it pays) | 'drawn' (none); netLoads (outputs load one input), inputArrivals (inputs
                 driven by a minimum NAND), leafDelays, heavyNets, PS_PER_UNIT, DELAY_NOTE; logicDepth(def, model);
                 view/delayui.ts the Timing panels' Unit / Load switch (settings.loadDelay the default) and the slack heatmap's toggle and key
  verilog.ts     structural Verilog generated from any netlist (identifiers sanitized, alias
                 boxes from their bit map)
  svexport.ts    exportHdl(def, 'structure' | 'synth', testbench?): whole hierarchy in one file,
                 self-checking testbench from our simulation (checked against Yosys when installed)
  vexport.ts     synthesizable Verilog-2005 (flip-flops as processes, `hdl.synth` bodies) for Yosys / OpenROAD;
                 externalPorts (+ ioPart): sandbox I/O parts (isExternal, displays) punched up as ports x_<path>_<port>
                 of every module above them; ExportResult.ports: the top's ports (TopPort, `external`: where from)
  vcd.ts         toVcd(): Value Change Dump of recorded traces
  fsmread.ts     readFsm(sim, spec): a circuit explored from reset (every input combination, breadth first; a state =
                 every net's value, so nothing needs naming), its states paired with the spec's; readbackSpec draws it
                 over the target (wrong arcs red, expected dashed); fsmStateOf / fsmInputsOf for the live panels
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
                 ringCounter(n, johnson), clockDivider(k), timer(period) (TIMER_PERIODS; a workbench family and the
                 palette's Timer: wraps every period edges, irq held until ack)
  storage.ts     romArray(preset), minimize() (Quine–McCluskey), pla(preset), fifo(k, w), stack(k, w), cam(k, w),
                 regfileMP(k, w, reads, writes)
  isadecoder.ts  isaDecoder(doc): a Custom ISA table's decoder in gates (not registered: built per table, opened by the
                 Design tab through remixDef): complement rails where a pattern needs a 0, one AND per instruction over its
                 fixed bits, the NOT of each more specific overlapping pattern, valid = OR; matchNames; its NANDs equal
                 isa/design.ts's estimate + the OR (tests/isa-decoder.test.ts, also every output against match())
  memory.ts      ram(k, w): decoder + registers + mux tree, user-scalable
  portmem.ts     portMemory(k, w, n, init): a read and a write port per lane (highest port wins a word), ≤ 2^6 words
                 lanePortMemory (gates, any width), up to 2^10 bigPortMemory: one leaf (PortRamState, a RamState + what
                 each port sampled) over banks of portBank (lanePortMemory(6, …) as a lookup, seeded latches when opened)
  bigmem.ts      large memories (2^7 … 2^16 words): bigRam(k, w) = one stateful behavioural leaf (RamState: words +
                 X flags, sampled while clk is low, written at the rising edge) over a lazy hierarchy of ≤ 16 banks
                 per level down to ramBank(w) (ram(6, w) as a lookup; opened, its latches are seeded), bankState;
                 bigRamWithInit (initial words in the leaf's power-on state); romLevels (banks of 2^8-word ROMs,
                 shared by content hash, wordsHash); ramLeafState / ramWords for readers; kWords labels
  alu.ts         constWord, zext, wiring boxes, bitwise, orN, isZero, barrel shifter, alu(n)
  regfile.ts     regfile(k, w) with x0 = 0, two read ports fed by one bundled word bus; regfile2w(k, w): 4 read, 2 write
                 ports (writeSelect per register: port 1, the younger instruction, wins), w<i> names like regfile
  cpu.ts         single-cycle RV32I: rom (preferBehavior), dataMemory, IMM_GEN, OPCODE_DECODER,
                 CONTROL, NEXT_PC, PLUS4(_FAST), singleCycleCpu(program, { adder, custom }); opcodeDecoder(extra) /
                 control(custom): the generators (OPCODE_DECODER / CONTROL are the no-customs case): a custom row is
                 one more class and an OR input per signal it asserts (riscv/custom.ts signalsOf)
  fastadd.ts     gp / gray / black prefix cells, CLA4, prefixAdder (one drawing for any prefix network): koggeStone(n),
                 brentKung(n), sklansky(n) (ksLevels / bkLevels / skLevels, prefixInfo), addSubFast(n)
  wide.ts        bitwise(op, n), orN(n) (shared by alu.ts and fastadd.ts to avoid an import cycle)
  usage.ts       usedIn(def) (parents with instance counts, the chapters' CPUs included), copiesIn(top, def),
                 referenceCpus(): the inspector's "Where it is used"
  hwstats.ts     hwTargets / measure / hwStats (scripts/hwstats.ts → public/hwstats.json at build), hwStatsLive:
                 the workbench's Statistics tab (ui/pages/hwstats.ts, its own chunk; benchtabs.ts: the tabs)
  pipeline.ts    equal, nonZero, clearableRegister, pipeline registers (fields on fixed rows),
                 hazardUnit(lookAhead), BRANCH_CMP, BTB (16 × 62-bit), SAT_COUNTER, MISPREDICT,
                 pipelinedCpu(program, { adder, balanced, predictor, dcache, m }) (a cache miss in M freezes every stage;
                 m: multiply split E/M, behaving like a load for hazards; divide stalls F/D/E); btbOf(1 | 2): the BTB with
                 one or two fetch read ports (BTB = btbOf(1), unchanged)
  pipe2w.ts      chapter 25's dual-issue in-order RV32IM pipeline: dualPipeCpu(program, { imemK, dmemK }) (pipe-2w): rom2 (two
                 ROM reads, pc and pc + 4; not registered, like rom), PREDECODE (calls / returns from the word), FETCH_PRED (the
                 pair's next PC: return stack, BTB, pc + 8; slot 1 only when slot 0 is not predicted taken), ISSUE_CLASS,
                 PAIR_CHECK (slot 1 issues unless it needs lane 0's memory / multiplier / divider, is a second control
                 instruction, follows a divide or reads slot 0's result: then hold and shift), HAZARD2 (look-ahead forwarding
                 from both lanes' M and W, the younger first: 1 W0, 2 W1, 3 M0, 4 M1; W bypass; load-use stall), CONTROL_2W
                 (instance pctl: redirect, stalls, shift, every enable / clear), UPDATE_2W, COMMIT_RAS; lane 0 keeps the
                 single pipeline's instance names (ctl, byA, clr0, …), lane 1 adds a 1 (FD1, DE1, alu1, …); retire = the
                 count, pcW0 the oldest; tests/pipe2w.test.ts (lock step), verify-wide.test.ts
  ras.ts         the return-address stack: ras(n, w) (speculative + committed copies of {valid, address} entries,
                 restore from the committed copy's next state; the model's rules: rasNext), rasStack(n, w); ras2(n, w) (two
                 operations a cycle per copy, in order: rasOp chained; top1 / any1 after slot 0's: the out-of-order core's)
  ooo.ts         chapter 25's out-of-order core's units, each following riscv/ooomodel.ts's rules (tests/ooounits.test.ts
                 checks them against the model's data structures, cycle by cycle): btbCommit (looked up for both fetch slots,
                 trained at commit by up to two in order, BTB_TRAIN: the model's rules, not the pipelines'), issueQueue(P)
                 (iqEntry: operands ready or tagged, woken by either result bus and passed on the same cycle, a load's store
                 mask; AGE8 / SELECT8: per port the oldest candidate whose result bus is free; lowest free entries), RAT
                 (RAT_ROW recognizes its own register; slot 1 sees slot 0's destination; unmap at commit only if still named),
                 reorderBuffer(D, V) (head + count, two allocations / bus writes / commits, operands by tag), STORE_QUEUE
                 (forwarding from the youngest older store to the word: before the tail the load saw), dataMemory2(k) (a read
                 and a write address). Rows on shared wires (rowArray): the sandbox round trip of a block drawn with hundreds
                 of labels takes minutes
  ooocore.ts     chapter 25's out-of-order core: oooCpu(program, { imemK, dmemK }) (`ooo`), equal to riscv/ooomodel.ts's
                 OOO_CORE every cycle (tests/ooocore.test.ts: commits and each port's pick per cycle, the golden model after
                 every commit, on targeted programs, the benchmarks and random programs). Fetch (rom2, FETCH_OOO: the model's
                 prediction, ras2, btbCommit; the fetch register refilled when dispatch empties it), dispatch (OOO_CLASS: the
                 model's classify, so a wrong path through unknown words waits on nothing the model would not; DISPATCH_CTL,
                 BIND: the counts before the picks, every comparison made early; OPERAND: register file / ROB / bus / wait;
                 KNOWN: jal / lui done at decode), the issue queue, two ports (EXEC; loads with store-queue forwarding; the
                 Booth multiplier over E1 / E2; DIV_UNIT: divE(true), aborted by a flush), a result bus per port, commit
                 (COMMIT_CTL: two a cycle, one store, flush on a committed misprediction). Instances: pc (fetch PC), imem,
                 rf (regfile2w), dm (dataMemory2), rob, iq, rat, sq, btb, ras, div, cm, dc, bind, e1_0 / e1_1, e2_0 / e2_1;
                 outputs retire (count), pcW0, pcF (the oldest not committed), halted
  lsu.ts         STORE_ALIGN, LOAD_EXTRACT, bankedMemory(k) (byte / halfword access)
  system.ts      SYS_DECODE (illegal-instruction detection), CSR_UNIT, TRAP_UNIT, IO_UNIT,
                 systemCpu(program, { m }): the complete RV32I(M) + Zicsr + M-mode traps / interrupts + MMIO;
                 with m the CPU gains a `retire` output (low while a divide stalls it); { bus } (not with m): busMemUnit
                 in place of the data memory, the AXI master ports at the CPU's pins, retire
  cells.ts       NMOS_STRONG / PMOS_WEAK, SRAM_CELL (6T), SRAM_COLUMN, DRAM_CELL (switch level)
  arrays.ts      WRITE_DRIVER, SENSE_AMP (latch type), sramColumn(R), sramArray(R, C): switch-level SRAM with periphery
  dramctrl.ts    chapter 35: dramCtrl(cfg) (CtrlModel in gates, tests/dramctrl.test.ts compares every output every cycle),
                 dramDevice(cfg, init?) (DeviceModel as a seq behaviour leaf, no input → output path), dramSystem(cfg) (both,
                 the chapter's scene); wbCache(k, ib, ways, dram) puts them behind the write-back cache (a miss: write-back
                 request, then fill, until done); singleCycleCpu / pipelinedCpu({ dram }); CPUs sc-wb2-dram, sc-wb2-dramc,
                 pipe-wb2-dram (tests/verify/cpus.ts; BitSim lanes give a seq leaf a state each: run.ts laneLeaves; their
                 benchmark rows are offChip: kept out of the cost comparisons)
  axi.ts         chapter 37's bus (AXI-lite-shaped: AW + W together, B, AR, R; valid / ready; one transaction at a time):
                 AXI_PORT (a load / store → a transaction, done), axiBus(M, codes) (arbiterN round robin, decode on the top
                 nibble, the last slave the default; grant and slave held to the response), axiRam(k, wait) (four bigRam byte
                 lanes, wait states), AXI_DEFAULT, DMA_ENGINE (registers src / dst / len / ctrl as a slave, a copying master,
                 irq), axiFlash(image) (a FlashDevice leaf: page buffer, a page read on a miss), busBench(image, k, wait),
                 busMemUnit(imemK) (the system CPU's memory over the bus: boot ROM below 4·2^imemK, the rest fetched into an
                 instruction register, NOP meanwhile; stall; irqOk from a flip-flop (an access under way), not the request: that loop kept the
                 cycle engine away; bus side bus_*); axiDram(c) (BUS_DRAM: dramCtrl + dramDevice(c, init, mask) behind an
                 adapter: a line per access, a store's other bytes masked by dm), axiScreen(n) (the RAM slave as an n × n RGB332
                 frame buffer), axiReadPort (read-to-take channels: +8i data, the read takes it with ack one cycle later, from
                 a flip-flop: a clockless keyboard part then makes no loop for the cycle engine; +8i + 4 status): AXI_KEYS and
                 AXI_IO_PORT (keyboard + timer), KEY_QUEUE (the keyboard: an external seq leaf, filled through Sim.poke, the
                 sandbox keyboard part's pins), AXI_PIXEL (a store sets one pixel of a screen part), axiFlashWindow(k) (the
                 flash's page timing in gates over a ROM part: addr out, data in), bundled(def, groups) (a link as a request
                 bus REQ_BITS and a response bus RSP_BITS); BUS_PARTS registered; AXI_CARDS (a card reader's slave: +0 status
                 ready / empty, +4 the card's word, the read takes it: next from a flip-flop one cycle later)
  soc.ts         busComputer(program, flashImage, { imemK, ramK, ramWait, dram, screen, keys }) (systemCpu({ bus }) and
                 DMA_ENGINE as masters; RAM at 0, flash 0x1000_0000, DRAM 0x2…, DMA 0x4…, screen 0x5…, keyboard 0x6…
                 (instance kbd); DMA irq → CPU irq; socDevices(o): BusModel's devices), chapterComputer / CHAPTER_COMPUTER
                 (bus/programs.ts: a boot ROM that DMA-copies a program from flash to RAM 0x400 and jumps), SYSTEM_COMPUTER
                 (every slave; SYSTEM_SOURCE: keys to the console, a line in DRAM, blocks on the screen); busCore(imemK) (the
                 bus CPU with its boot ROM outside: romData in), SANDBOX_PARTS (bundled parts on SANDBOX_MAP, chapter 37's map
                 with the I/O port at 0x6…) for Examples ▸ System on a bus; { cards: Deck, cardFeed }: AXI_CARDS at 0x7… (instance
                 cardport) and the deck's reader leaf (cards/reader.ts deckReader, instance cards); asmDeck(name, src) (a program as
                 object cards, each printed with its source line), CARD_DECK, cardComputer(deck, feed) / CARD_COMPUTER (the card boot
                 ROM, no flash: chapter 37's "Booting from cards")
  relays.ts      prologue P1's relays at switch level: relay(n) (1–6 poles, ids relay, relay2 …), RELAY_NOT / NAND / XOR,
                 RELAY_FA (the carry through contacts on two rails, ci / nci: a contact cannot invert), relayAdder(n) (one
                 relay step for any width), RELAY_LATCH (self-holding), RELAY_BUZZER (a coil through its own break contact);
                 outputs end on a load (a pull-down standing for the next coil) so a part alone reads 0, not Z; RELAY_CLOCK
                 (the buzzer and a ÷2 from two relays: t' = k ? ¬t : t, the campaign's r_clock)
  tubes.ts       prologue P2's tubes at switch level: TRIODE (a 6SN7 section), DIODE (id vdiode, a 6AL5 section), B_PLUS
                 (+250 V) / V_NEG (−150 V) rails, RES_DIV (a divider's top leg, strength 2: between the plate resistor and
                 the tube, so a ratioed plate decides its grid) and RES_BIAS (its bottom leg, strength 0); TRIODE_SWITCH,
                 TUBE_INV, TUBE_NOR, TUBE_NAND (diode AND + triode: the brick), CATHODE_FOLLOWER, ECCLES_JORDAN (cross-coupled
                 pair, set / reset through steering diodes), TUBE_FA (the nine-NAND full adder in tube NANDs); every input
                 behind a 625 kΩ / 375 kΩ divider (labels; the voltages are phys/triode.ts's); TUBE_BUF (two inverters drawn
                 flat, the campaign's v_inv)
  tech.ts        the technology setting (Phase 14c): price(def, 'cmos' | 'relay' | 'tube', steps) through the NAND brick
                 (relays: a coil per NAND output + relayExtra per net's fan-out; tubes: ½ 6SN7 + a 6AL5 per NAND, followers
                 past PLATE_FANOUT), or a native relay / tube part by its own devices; constants from phys/relay.ts /
                 triode.ts, the Z3 and ENIAC (tests hold them equal); cabinets (racks / panels), withoutParts (a CPU without
                 its program ROM), fmt* and TECH_NOTE; techsteps.ts designSteps(def): depth, period or relay steps
                 (SwitchSim); view/techtable.ts the table (inspector, sandbox chip properties, chapter 3's techcompare widget)
  flash.ts       chapter 36's flash at switch level: FG_CELL (prim 'fgmos'), vtOf / V_READ, norArray(R, C) (cells between
                 bit lines and a source line held high while programming), nandBlock(S, N) (strings with string / ground
                 selects, the other rows at the pass voltage); per column a pull-up, an output inverter and a NOR-gated
                 strong write driver (din 0 pulls the bit line low: program; 1 inhibits)
  dram.ts        chapter 34's DRAM at switch level: VHALF (prim 'vhalf'), DRAM_SA (prim 'sense', drawn with 8 transistors),
                 DRAM_BIT (1T1C, a leaking CELL_C capacitor, bl two-way), dramColumn(R) (precharge / equalize to VDD/2, a
                 reference bit line of BITLINE_C, column select, the amplifier), dramArray(R, C) (row / column decoders, write
                 driver, output inverter; protocol: precharge, activate, sense, read / write, close), DRAM4X4, DRAM8X8;
                 BITLINE_CAP (a bit line's 100 fF as a part, for the campaign's column: sandbox wires carry no value)
  cache.ts       cachedMemory(k, ib) (direct-mapped write-through cache + main memory, stall on
                 miss), wayLookup2; singleCycleCpu(…, { dcache }) uses it (adds `retire`, `dhit`)
  cache2.ts      cacheWay(ib, t), MISS_CTRL, wbCache(k, ib, ways) (write-back, write-allocate, LRU), iCache(rom, ib);
                 singleCycleCpu(…, { dcache: 'wb' | 'wb2', icache }); riscv/cosim.ts cacheLines() + coherent cpuState().dmem
  multicycle.ts  MC_STATES (the state table), MC_FSM (hardwired), MC_MICRO (microcode), microword(),
                 multicycleCpu(program, { control: 'fsm' | 'micro' }) with `retire`, `fetch`, `state` outputs;
                 mcTransitions (MC_FSM's AND gates t<k>), MC_FSM_SPEC (the controller as a state machine)
  fsm.ts         FsmSpec: states (code, at, Moore out), arcs (when, Mealy out, parts lit on hover, drawing hints),
                 fsmNext / fsmOut / fsmArc; fsms.ts: library id → spec (mc_fsm, mc_micro, rv16_det101: DET101_FSM);
                 tests/fsm.test.ts reads every one back from its circuit (the picture cannot drift)
  fpu.ts         parametric IEEE 754 units (format {E, M}): lzc, shiftLeft, shiftRightSticky, fpUnpack,
                 normRound (shared RNE rounding), fpAdd, fpMul, fpFromInt, fpCompare, FPU32, FP_DECODE;
                 singleCycleCpu(…, { fpu }) adds the f register file (regfile(5, 32, false))
  mpdecode.ts    MP_DECODE (atomics, csrr mhartid), ARBITER2 (round-robin), arbiterN(n) (2–8 ways, the same policy:
                 one-hot pointer, masked + unmasked priority chains)
  multicore.ts   dualCore(program): two singleCycleCpu(…, { shared }) cores + arbiter + shared memory (the chapter's,
                 the Yosys / OpenROAD flow's); multiCore(program, n, { dmemK, imemK }): 2, 4 or 8 cores, arbiterN,
                 encoder + mux trees on the port; sharedMemory(k): dataMemory up to 2^6 words, else a bigRam
  cpu4.ts        the 4-bit CPU (Examples ▸ 4-bit CPU): CPU4_PC (PC + 3-level stack), CPU4_DECODE (control4: the control
                 table, its spec), CPU4_REGS (16 × 4 in pairs), CPU4_ALU (alu4), CPU4_ACC, CPU4_IO (SRC + five ports), rom4(words)
                 (256 × 16, the sandbox ROM part's geometry), cpu4(words) (the computer; CPU4_STATE: paths of its registers)
  lanes.ts       the GPU chapters' lane core: laneCore(program, n, { dmemK, imemK }) (2 / 4 / 8 lanes: the single-cycle front
                 end, n laneUnit(n) boxes = registers + ALU + result mux, hand-placed in two bands), lowestOne(n) (the leader /
                 the next lane to serve), onehotMux(n, w), simtDecode(n) (custom-0 ops, lane CSRs 0xCC0–0xCC4), simtControl(n)
                 (inverted mask + 4-entry shift-register split / join stack, stackEntryWidth), memSequencer(n) (one lane per cycle)
  warps.ts       chapter 30's warp core: warpCore(program, { warps, lanes, latency, dmemK, data }): warpSlot (PC, simtControl, run
                 bit, SCOREBOARD: a pending bit per register), SB_CHECK (hazardSpec: the next instruction uses a pending register),
                 arbiterN over the ready warps, warpLane (a register bank per warp; a returning load writes its warp's bank, so
                 that warp sits out the cycle), memPipe (L − 1 request registers before lanePortMemory: a port per lane, initial
                 words as power-on hints), warpDecode (wspawn, CSRs warp / nwarps). Chapter 31: warpCore(…, { lsu, smemK,
                 sharedLatency, globalEvery, mul }): a memory instruction holds the issue port one cycle per access (registers
                 heldW / left; its warp moves on after the last), atBar (bar: popcount of the waiting bits + 1 against rs2),
                 EXT_DECODE (amoadd.w shown to CONTROL as lw, its immediate zeroed; bar; mul), sbCheck(amo), warpLane(…, mul).
                 Chapter 33: warpCore(…, { host }): launch (warp 0 again at PC 0, every lane on: a dispatch) and a spare read port
                 into the data memory (xa → xq; lanePortMemory / memPipe xport). A one-warp core keeps its unused wspawn decode
                 (chapter 30 quotes a warp as nands(2) − nands(1)). lanePortMemory is hand-placed (decoders, words in columns of
                 32 rows, read trees; labels between): the registry-wide schematic tests never build one, tests/route-bigmem.test.ts
                 checks the chapters' sizes. The top level is hand-placed (warpCoreDrawing: four bands, a row per warp / decode
                 and wspawn / lanes, leader and next PC / memory, lsu's access, done and barrier rows; Placer places by name and
                 skips parts a variant lacks; wires within a block, labels between, unique net names); tests/warplayout.test.ts
                 checks its variants (the registry-wide schematic tests never build the warp core's top level)
  warpmem.ts     chapter 31's memory: serveLanes / accessesOf (the access rule, also the timing model's), accessUnit(n)
                 (leader's 16-byte line; per bank the lowest lane picks the row; amoadd.w the leader alone), quadMemory(k,
                 banked) (4 columns: one row = a line, or a row per bank), lsuMemory (the pipeline: shared accesses enter
                 Ls − 1 stages from the end, slotBusy; globalBusy: a global access in the last B − 1 stages; old + data for
                 amoadd.w; the highest served lane wins a word)
  raster.ts      chapter 32's graphics hardware (reference: gfx/raster.ts, cycle for cycle): edgeStep(n, tile) (E and the band
                 start R, one add/sub; tile test E + off), RAST_SETUP (A, B, bias, steps, tile offsets, bounding box in tiles;
                 eight products on one 10 × 10 Booth multiplier: area, then each edge at the first tile), RAST_WALK (phase s:
                 idle, S1–S8, TEST, 16 pixels; bands of 4 × 4 tiles, column serpentine; waits in S8 for `ready`),
                 rasterizer(depth) (+ Z_SETUP: Booth, 30-bit divider, Horner; a 32-bit depth stepper, Z_CLAMP; clr walks the
                 screen), BLEND332, ROP (depth buffer, test, blend, clear), pixelBuffer (4 byte banks of bigRam), frameBuffers
                 (front / back by address muxes), SCAN_OUT (a word a cycle, vsync, flip at vsync or at once), displayTop, GPU30,
                 GPU30Z (the scenes' tops)
  gfxpipe.ts     chapter 33: CMD_UNIT (one flip-flop a state, CU_STATES / cuState: launch the kernel on the next frame and
                 clear, read the count, per triangle its word and three vertices on the core's spare port, go, wait; swap, wait
                 for the flip and the kernel, the other vertex buffer), gpu31(mesh) (one-warp core with mul and host port,
                 the command unit, rasterizer(true), ROP, frameBuffers, SCAN_OUT; same instance names as GPU30Z). Step 5:
                 gpu31(mesh, { clear: 'word' }): CLEAR_UNIT (a 10-bit word counter, instance 'clear'), cmdUnit(true) (cstart /
                 cbusy, the rasterizer only draws), ROP_W (raster.ts: depth in four banks zbuf0…3, cwe writes a word: wall),
                 frameBuffers(…, wide) (an `all` input per frame); ch 32's parts and ids unchanged; PIPE_COSTS.word / *_w frames
  builder.ts     Builder: column-by-column netlist builder for blocks read by drilling in (fpu, fppipe, coding, divide)
  coding.ts      magComparator(n, signed), priorityEncoder(n), encoder(n), demux(k, w), popcount(n), absValue(n),
                 parity(n), hammingEnc/Dec(k) (SEC-DED, with TS reference models), eccChannel(k)
  divide.ts      nrDivStep / nrArrayDiv / nrSeqDivider (non-restoring), iterCtrl(n) (load / step / done control),
                 SRT_SELECT, srtStep, srtNorm, srtFinish, srtDivider(n) (radix-2 SRT, carry-save remainder)
  srt4.ts        srt4Thresholds() (computed), SRT4_SELECT (carry-save comparisons), srt4Term, srt4Step, srt4Finish,
                 srt4Divider(n) (radix 4, n/2 + 3 cycles); iterCtrl(n) handles any step count
  pipem.ts       MUL_E / MUL_M (Booth tree in E, 64-bit Kogge–Stone in M), DIV_E (radix-4 SRT, stall until done); divE(abort)
                 (with an abort input: iterCtrl(n, abort) / srt4Divider(n, abort); DIV_E = divE(false), unchanged)
  multiply.ts    seqMul(n) (shift and add), boothRow / boothPP / boothReduce / boothTree / boothMul(n) (radix-4 Booth,
                 sign-constant trick), pipeMul(n) (3-stage pipelined Booth)
  adders.ts      carrySelect(n, k), carrySkip(n, k), BCD_DIGIT, bcdAdder(d)
  muldiv.ts      ppRow, arrayMul(n), compressor()/csa(n) (3:2 rows with word offsets), treeMul(n, signed,
                 outW) (Wallace + KS), MUL32, BOOTH_ENC, divStep, arrayDiv, seqDivider(n), condNegate, MDU
src/bench/     results.json (scripts/benchmarks.ts --write, checked in; each run's switched C from a GateSim rerun:
               tests/verify/bench.ts benchEnergy), summary.ts (DOM-free: times, energies, geometric means over
               the four RV32I programs, the cost / speed front, each CPU's family and chapter): the workbench's Benchmarks
               tab (ui/pages/benchmarks.ts, its own chunk)
src/riscv/     isa.ts (tables, decode, disasm, CSR names), asm.ts (two-pass assembler, CSR
               instructions; assemble(src, custom)), custom.ts (CustomRow: a custom instruction as a slot, a format and a row
               of control signals; problemsOf, signalsOf, meaning, execCustom / aluCtlOf as the hardware's ALU decoder;
               decode / disasm / ISS({ custom }) take the rows; sanitizeRows, rowsKey), compose.ts (the instruction builder's model: a spec + operands both ways, slotsOf in assembly
               order with bank / range, encodeParts / partsOf (null: bits it would not set), retarget, textOf (a target by label),
               parseLine, PALETTE; every instruction round-trips through asm.ts: tests/compose.test.ts; RV32_COMPOSE: its
               builder adapter, isa/composekit.ts), fastiss.ts (FastISS: the golden model's semantics, every ROM word predecoded by decode() into
               typed arrays, one switch, ~90 MIPS on Doom; RAM inline, other regions through overridable load / store / ioRead /
               ioWrite; no F; tests/fastiss.test.ts: lock step over riscv-tests and random programs), iss.ts (golden model; `system: true` adds MMIO, CSRs, traps,
               interrupts; `mmio: true` only the console / LEDs / switches, decoded exactly, other I/O dropped; `m: true` makes M legal in system mode, divides advance mtime by 34), programs.ts / sysprograms.ts / mprograms.ts / pmprograms.ts / cprograms.ts / fprograms.ts / ioprograms.ts (samples; ioprograms: the sandbox computer's), multi.ts (MultiISS: N harts, shared memory, same arbitration), ilp.ts (chapter 25: classify(word) → class /
               sources / rd / call / ret, traceOf (the golden model's run), dataflow (the limit: each instruction when its operands
               are ready; criticalPath)), ooomodel.ts (OooModel / OOO_CORE: the out-of-order core's rules cycle by cycle, the
               header is the spec the gate-level core follows; CycleInfo per cycle: committed / issued (Uop.port) / dispatched /
               fetched / flushed; wrong-path instructions run until the flush; the golden model steps at fetch on the correct path;
               tests/ooomodel.test.ts), scoreboard.ts (CDC 6600), oooprograms.ts (the chapter's loops), simt.ts
               (SimtISS: a warp of n lanes, one PC, leader, mask, split / join stack, one cycle per active lane for memory),
               simtprograms.ts (the lane kernels, each with its result computed in TypeScript), warps.ts (WarpISS: W SimtISS warps over one
               memory, wspawn, bar (one barrier), shared memory at 0x1000 (simt.ts LaneISS), mul only with multipliers; steps the warp the
               hardware issued), warptiming.ts (the warp core's cycles from the golden model and the scheduler's rules, lsu: accesses per
               line / bank, the held issue port, shared slots, globalEvery; checked against the gates), warpprograms.ts (kernels with their
               input in memory; lsu / shared / mul / threads flags), mcprograms.ts, cosim.ts (CPU state;
               `retireCount()` = how many times to step the ISS this cycle (validW / a 1-bit retire, or a wider retire
               output: the count, oldest first, for a CPU that retires several; none: 1), `retiring()` = count > 0,
               `retirePc()` (pcW0, else pcW: the oldest retiring); dmemWords), ooosnap.ts (the out-of-order core's state read
               from its registers: fetch register, ROB head first, issue queue oldest first with the tags each operand waits for,
               rename table, store queue; oooIssued: each port's pick; isOooCore, sandbox copies (u_rob16…) included;
               tests/ooosnap.test.ts: equal to the model every cycle), randprog32.ts (seeded random RV32 programs per ISA),
               benchprograms.ts (the benchmark set: fib, sort, matmul (+ mul), CRC-32, a float kernel; each with
               its result computed in TypeScript)
src/view/      SVG schematic renderer (route.ts: orthogonal routing + hops over crossings; untangle's A* reroutes stop after
               UNTANGLE_POPS states per schematic, leaving overlaps rather than freezing the page: scripts/route-perf.ts times one),
               layout.ts (the learner's layout on the stage, per component id in localStorage: parts dragged to whole grid
               units, several at once (shift-click, shift-drag a box; Esc lets go), wires following live on a level that
               routes under LIVE_ROUTE_MS, else on drop; a wire's segment dragged sideways in half units (dragSegment: the
               net's whole run on that line moves, a stub stays on a pin; a finger moves only the selected wire), kept as
               the learner's corners (LayoutEdit.via → NetDef.via, over the author's; RoutedNet.ends names each path's
               sink; dropped when a part they touch moves; "Reroute" lets go); pointers (NetDef.tags) unravelled into wires one by one or all,
               and wires drawn as pointers (tags: true, named for the driver; a net too short for them is taken back with
               a note); undo / redo per component for the visit (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y); applyLayout keeps the
               nets and their order, so the simulation, probes and marks are untouched; a moved part's nets drop its
               trunk / via; the right-click menu and the stage's Layout button; Open in Sandbox takes the arrangement),
               crumbvals.ts (the breadcrumb's live values, stage and look inside: each level the output carrying the one
               below, `bit [7] = 1` where the level above's bus was sliced),
               inspector (info with "Where it is used", "Power": powerpanel.ts, live from the stage's PowerMeter or
               measurePower on random inputs, and "In relays and tubes": techtable.ts; truth table, Verilog + download), analyzer.ts (the Timing panel:
               lanes from onTrace, cursors, VCD), stage.ts (probe mode, clock period, slow-motion
               fronts, the Image menu), image.ts (a drawn circuit as a standalone SVG: computed styles
               inlined, current theme; PNG at 2×; saveFile; exportSchematic for a stage's level, loaded on
               demand; the sandbox's File menu uses it too)
src/dram/      timing.ts: DDR4-3200 in our cycles (CLOCK_NS = the single-cycle CPU's period: TIMING 4 / 4 / 4, tRAS 9, burst 4,
               tREFI 1 974, tRFC 89), bankRow (rows interleaved over banks, optional XOR hash), accessCycles, RowBuffers
               (open / closed page, one request at a time): the reference the memory chapters and their controller share;
               controller.ts: DeviceModel (banks, row buffers, every timing rule checked: err + why, data X; more than 8 refreshes
               late loses the data; read(a) by CPU address) and CtrlModel (cycle-exact: one 4-word line request at a time,
               held until done; IDLE / WPRE / WACT / BURST / CLOSE / WCLOSE / WREF1 / WREF2, one wait counter, refresh first;
               open / closed page, XOR bank hash; transfer / idle drive both); workload.ts: a program's line requests through
               the CPUs' 2-way write-back cache model, price() on the models (equal to the gate-level CPUs to the cycle);
               schedule.ts: FCFS against FR-FCFS over a queue (chapter 35's last step)
src/bus/       model.ts: BusMemory / BusModel (the computer's map for the golden model: RAM, flash, DMA registers whose
               copy is instant, and with BusDevices a DRAM, a screen, a key queue; ISS({ bus }) fetches beyond its ROM and loads / stores through it); programs.ts: chapter
               36's boot ROM and payload
               Card reader: BusDevices.cards { items, feed } → CardModel, the one time-dependent device: whoever steps the ISS sets
               BusModel.now (rising edges so far, at the retiring edge); a read sees the reader CARD_LAG (2) edges earlier and a DATA
               read takes the card 2 edges after that, so lock-step stays exact at any feed. programs.ts CARD_BOOT_SOURCE (poll
               STATUS, copy the deck to 0x400, jump: the 1401's Load key), CARD_PAYLOAD_SOURCE, CARD_BASE, CARD_FEED (8 edges);
               cardboot.ts cardBootTime(items, feed): the boot's cycles from the golden model (boot ROM: 1 cycle, a load / store 2),
               pinned against the gates by tests/buscards.test.ts
src/flash/     model.ts: FlashDevice (program 1 → 0 once per erase, block erase, FLASH_TIMES 64 / 512 / 4096 cycles, wear-out
               after `endurance` erases, factory bad blocks) and Ftl (page map, writes out of place, greedy garbage collection
               when free blocks are down to the reserve, dynamic wear levelling, bad blocks skipped, write amplification);
               randomWrites (seeded, optional hot set)
src/widgets/   bespoke explainers (MOSFET cross-section, number explorer, memory grid, ...); python.ts: chapter 15's (pyLinked:
               Python / assembly / ROM words linked by line, the fields; pyCost: cycles per line on the golden model; pyScene:
               the gate-level CPU (PY_IMEM_K / PY_DMEM_K via cpuScene's imemK / dmemK) with the Python panel bottom-left
               through cpuScene's extraPanels: the line from the PC, its cycles and toggles from edgeHooks, variables from
               the compiler's homes, output, the stack labelled by the stores; Step line, Back via historyHooks; the editor
               in codeedit's 'py' language); ooo.ts: chapter 25's explorers
               (dataflow schedule, in-order against out-of-order timelines, the scoreboard, the reorder-buffer explorer, the
               speculation table; measuredWidget: the four CPUs from results.json and width × window on the model; styles/ooo.css); bus.ts: chapter 37's panels
               (busBenchScene: reads / writes / a DMA copy on the bus bench, a per-cycle trace of handshakes and grants;
               busComputerScene: the computer booting from flash, console, LEDs, memory map); flash.ts: chapter 36's flash panel
               (flashScene: the NOR / NAND array read, programmed pulse by pulse with verify, erased; thresholds per cell and
               an Id–Vg plot), ftlWidget (4 blocks × 4 pages), wearWidget (write amplification, erase counts, wear-out); dram.ts: chapter 34's DRAM panel
               (dramScene: the 4 × 4 array driven through its protocol, every cell's charge, bit-line ΔV, the latched row,
               cycles since each row's restore, Wait = SwitchSim.leak; dramState for challenges); dramtiming.ts: the row
               buffer over request streams and DDR4's timings at any clock; dramctrl.ts: chapter 35's controller panel
               (memCtrlScene: line requests, command timeline, open rows, refresh counter); dramwork.ts: the workloads priced
               by policy / banks / mapping, and the FR-FCFS queue; cell3d.ts: chapter 27's
               standard cells in 3D (orbit camera, painter's order over boxes);
               lanes.ts / warps.ts: chapters 28–31 (the Warp panels: mask grid, stack, issue timeline, scoreboards; on chapter 31's
               core each access, the barrier, shared memory by bank, a kernel switcher; lanes against cores; the occupancy widget,
               from riscv/warptiming.ts); feed.ts: chapter 31's access widget (the gate-level access unit on a stride / offset)
               and the tiling chart (plain against tiled matmul over globalEvery);
               framemem.ts: chapters 32–33's memory view inside the screen panels (FrameMemory: thumbnails of the screen, both frames
               with FRONT / BACK, the depth buffer, one shown large; the back frame's pixels not written since the flip dimmed, fresh
               draws glowing, from the write port fb.we / fb.wa watched at every edge; who writes it now: rasterizer phase and
               tile, ROP counts, extra rows (ch 33: command unit, warp core), scan-out row; filmstrip of the frame rebuilt;
               frameOf / depthOf read the memory leaves); screen.ts: chapter 32 (the screen panel: what the gate-level scan-out sent, or the back frame from the memory
               leaves with the walk's tile; Run on a 12 ms frame budget or a cycles/s cap, Draw, Swap, vsync wait, draw scripts;
               the edge-function explorer; ScanCapture: what the scan-out sent, backFrame; draws fed from inside the cycle loop, one
               starting the cycle busy falls; DrawLink: another panel plays draws and gets the frame shown); drawpad.ts: chapter 32's
               last step (GPU30Z on the cycle engine, its pins hidden; the drawing pad: triangle / polygon / brush, 16 RGB332
               colours, opacity, undo, kept in localStorage; Send through DrawLink, the screen checked against drawingPicture; both
               panels slim to 240 px on a narrow stage); gfxpipe.ts: chapter 33 (pipelineScene:
               gpu31 on the cycle engine; the panel: screen, frames per second, the last frame's timeline from FrameRecorder, the
               vertex kernel in lock-step with WarpISS (launch()), every frame against framePicture; costWidget: PIPE_COSTS);
               composer.ts: the instruction builder over any ComposeIsa (instrComposer({ isa }): palette, asm / hex input,
               clickable bits for any word width, the immediate's wiring as bands per run + one sign bracket, operand cards,
               decode chain, one bit away (isa.loose), and for RV32 the major-opcode map and a data path; Fields | Switches: the
               front panel (toggles + lamps by field), opts.deposit's button: chapter 13's memory run on the ISS, the program
               editor's next line)
               sketch lit from instrUse); chapter 13's explorer and editor/romcompose.ts host it.
               insthw.ts maps an instruction to the units it uses (and pipeline stage units; laneUse(word, core, at): the lane /
               warp cores' instances, tests/insthw.test.ts: every kernel instruction, every warp count; oooUse(word, port): the
               out-of-order core's, by the port it went to); ooopanel.ts: chapter 25's Out of order panel (oooView: Reorder
               buffer / Queues from ooosnap, Timeline from the model; OooFollower: the model stepped at every edge beside the gates,
               commits and port picks compared, replayed after a Reset or Back; the sandbox's CPU drawer shows the same view);
               slowctl.ts: what the CPU
               panel and the Warp panels share: slowControls (Slow / Back / Step, gate · cycle · instr levels, the rate; `retired()`
               from an edge hook ends an instr step), markInstr / clearInstr / showInstrUse (the units lit, the field wires
               coloured), frameRun (a Run to halt in a 12 ms frame budget, the cycle engine prepared first); fsmpanel.ts: a live state
               diagram (view/fsmdiagram.ts) over a scene (current state, last / next arc, trail, ribbon; arc hover lights
               its gates), used by controllerPanel's Diagram view and chapter 9's state machine; the codex draws fsmOf(lib)
               and the campaign's state-machine level reads the learner's circuit back (editor/fsmui.ts, BuildChallenge.fsm)
src/chapters/  narrative content: chapters → steps → scene / widget / challenge; a prologue chapter (num 0, `prologue: 'P1'`,
               between the map and chapter 1, in brass: styles/prologue.css) and an appendix chapter (`appendix: 'A'`) show
               their label instead of a number (chapterNo)
src/lib/rv16/  the campaign's RV16 hardware, every block built only from parts its level's requirements unlock:
               logic.ts (acts 1–3), cpu.ts (immediates, control, branch, next PC, single-cycle cores),
               pipe.ts (pipeline register, forwarding, hazard, rv16Pipe with fwd / stall / flush / sys),
               system.ts (illegal detector, CSR file, system decode, cores with traps and interrupts),
               md.ts (MUL16: unsigned array + sign corrections, DIV16: signs around the iterative divider; rv16Core(…, md)),
               multi.ts (RV16_MULTI: one-hot F/E/M/W multicycle core, RV16_CACHE: direct-mapped, write-through);
               rv16Pipe({ predict }) adds static prediction in F; lanes16.ts (act 9: LANES16 four ALUs, VRF16 four register
               files, MASK16 active mask + leader + write enables, LANEDEC16, STACK16 split / join stack and StackModel,
               rv16Lanes(simt): the 4-lane SIMD / SIMT cores, LANE_PORTS: a memory port and a write port per lane);
               warps16.ts (COAL16 coalescer + coalesce16; RV16_WARPS: two warps taking turns over a memory one cycle late,
               WARP_PORTS: + warp and a load write port lwe / lwa / lwd<i>; a warp with no lanes issues nothing; rv16Warps(raster):
               RV16_FRAME, the same core with the rasterizer as a device (registers at 0xFFF0 … 0xFFF6 on lane 0's port, a hold
               while it is busy for a device store or a screen load), FRAME_PORTS: + fa / fd / fwe); raster16.ts (act 9 graphics,
               reference gfx/raster16.ts: EDGE16 stepper with a double command, TILE16 walk, RASTER16: set-up by adders and
               shift-and-add on the steppers, cull from the E sum); mem16.ts (act 10: DRAM_COL2 the switch-level column,
               BANK16 open page + RAS-only refresh, CTRL16 a two-bank DDR-style controller, BUS16 two masters / three
               slaves with a held round-robin grant, DMA16 a copying bus master, FLASH_STORE16 a log-structured page store
               with garbage collection; bankOf / ctrlOf / busOf / dmaOf / flashOf with a fault for the tests)
src/riscv/rv16/ isa16.ts (fields, encode / decode / disasm), asm16.ts, iss16.ts (golden model: MMIO, CSRs, traps,
               interrupts; halts on jal x0, 0; SIMT words are illegal; `dma`: the boot puzzle's DMA engine (DMA_DEV16
               registers at 0xFFF0 … 0xFFF3, a word every 4 cycles, the interrupt line when done) and flash at 0x8000 …
               0xBFFF, read-only, 8 stall cycles a load: steps then count cycles; `screen`: the io bench's 32 × 32 RGB565
               screen, stores to SCREEN16_IO (isa16.ts: 0xF000 + 32·y + x) paint `screen`, not the data memory, loads there
               read the data memory; nextLoad(): the address the next step loads from), pong16.ts (PONG16: Pong on the io
               bench, state in RAM words 0–8 (PONG16_RAM), five points a game: PONG16_WIN), simt16.ts (Simt16: a warp of RV16 lanes over one
               memory: mask, leader, split / join stack, tmc, csrr rd, tid; utilization / idle), warps16.ts (Warps16: W warps over
               one memory taking turns, warp 0 first, wasted turns counted; bar waits for the other warp or its end (mask 0);
               stepWarp(w) for other issue orders; raster: lane 0's stores to 0xFFF0 … 0xFFF6 draw at once into 0xF000, draws
               listed), randprog.ts (seeded random
               programs for fuzzing cores)
src/isa/       Custom ISA: table.ts (IsaDoc: instructions as mnemonic + operand letters + bit pattern, operand kinds reg / enum
               / imm / addr; IsaTable: assemble, disasm (most specific pattern), fields, words, problems; sanitizeIsa),
               presets.ts (ISA4_PRESET: the 4-bit ISA as a table, equal to asm4 / disasm4 on every word), isa.ts (Isa:
               one shape over RV32, RV16, cpu4 and tables; isaOf(lang, table); used by program puzzles too);
               composekit.ts (ComposeIsa: what the instruction builder needs: slots, encode / decode / loose, fields, the
               immediate's wiring, text by label, a line parsed in context, program), compose.ts (tableCompose(doc): a table's
               rows as instructions, split operands wired; CPU4_COMPOSE; composeIsaOf(lang, table)); riscv/rv16/compose16.ts
               RV16's (each format's fields written out); tests/compose-isa.test.ts: every adapter against its own assembler
src/m6502/     Appendix A's 6502 (DOM-free): isa.ts (151 documented opcodes, modes, disasm), asm.ts (two-pass
               assembler, ';' comments, $hex %bin, *= .org .byte .word .text .fill), iss.ts (Cpu6502: cycle-exact, every
               bus cycle incl. dummy accesses, IRQ / NMI / RESET as the NMOS chip; save / restore), programs.ts (samples;
               IO6502: output port $F001, IRQ acknowledge $F002), ucode.ts (our microarchitecture: per opcode and cycle the
               control signals; t = 1 is the next fetch, finishing the previous instruction), rtl.ts (Rtl6502: the
               register-transfer model of our design, phase by phase), pla.ts (the decode PLA minimized from the table,
               undocumented opcodes as don't-cares), chip.ts (Chip6502: the transistor-level chip on NmosSim with a memory
               on its pins, cycle by cycle; registers read by name), verify.ts (lockstep with the ISS; StepRunner: a
               SingleStepTests case set up by a loader program). Tests: tests/m6502-*.test.ts (the SingleStepTests sample
               is checked in: tests/m6502/; scripts/m6502/fetch-tests.mjs caches the full suite and Klaus's binary, used
               when present); scripts/m6502/soak.ts (every sample case, interrupts, Klaus for N cycles, on the transistors);
               sbprograms.ts (the sandbox 6502 computer's map MAP6502 and its ROM samples)
src/lib/m6502/ the chip at transistor level (lib/nmos.ts: DEP, NINV, nnor(n), nnand(n)): cells.ts (naoi(expr) complex
               gates, PULL2 bus driver, DLAT dynamic latch, SCELL refreshed storage), ckt.ts / logic.ts (blocks written
               as logic, laid out on a grid with every net a label; bus pins as named bits), chip.ts (the blocks:
               clock, decode PLA, control lines, timing, interrupts, IR, registers, ALU, PC, address / data latches,
               flags, buses; controlUnit() above datapath() on m6502()'s hand-drawn top level). Its rules: a storage node
               loads in one phase and refreshes in the other, whatever φ2 needs from the PLA is latched in φ1, a pass
               transistor only takes a driven node (never a stored charge), state across cycles is master–slave with
               its next value computed in φ1. demo.ts: MS_BIT, BUS_LINE (the chapter's first steps). core.ts: the sandbox's
               part m6502_core: the ISS behind synchronous pins (a bus cycle per clock: a / rw / sync / dout just after a
               rising edge, din / resb / irqb / nmib taken just before the next; dout = the last byte written, held, so no
               output follows din and a memory map around it is no loop: the cycle engine runs it), its structure the
               chip behind pin glue (pinsBlock); opened, the chip is set up at the last instruction boundary by a loader
               program and replays the cycles since (InsideSeed.sim)
src/lang/      chapter 15's Python subset → RV32I (DOM-free): ast.ts (the tree, PyError with its line, wrap: ints are 32-bit),
               parse.ts (tokenize: INDENT / DEDENT as CPython's tokenizer, brackets join lines; recursive descent), scope.ts
               (analyze: functions, fixed global lists, globals, each function's locals by Python's rule, `shared` = globals a
               function touches, arity, a top-level call before its def), interp.ts (runPy: the reference interpreter, the
               golden model; pyDivMod floors, x // 0 = -1 and x % 0 = x as RISC-V's divide), codegen.ts (CodeGen: t0–t6 an
               expression stack, variables in s registers (a leaf function's in a0–a7), shared globals and lists in data
               memory from 0, then the output (gp, print stores there), sp from the top; comparisons straight into
               branches, constant folding, shifts / masks / shift-adds for constants, rt.mul / rt.divmod otherwise; every
               line keeps its Python line), compile.ts (compilePy → asm, words, layout, pyOfPc / pcsOfPy; outputOf),
               pyprograms.ts (the samples, with what they print), randpy.ts (seeded random programs: tests/pylang.test.ts
               compiles and interprets them, PY_FUZZ=n for a sweep)
src/isa4/      the 4-bit CPU's ISA: isa4.ts (the 4004's opcode map in 16-bit words: decode4 / disasm4 / fields4; words the
               table does not name run as NOP), asm4.ts, iss4.ts (golden model; halts on a JUN to itself), programs4.ts
src/cards/      punched cards (DOM-free): hollerith.ts (the IBM 029 code: punchOf / charOf, a column = 12-bit mask, bit 0 row 12
               … bit 11 row 9), card.ts (Card: 80 column masks + print; Deck; textCard, objectCard: a word in row 9 of columns
               1–32, its source and hex printed, a sequence number in 73–80; wordOf, seqOf, programDeck, sortDeck, dropDeck,
               deckToJson / deckFromJson: .deck.json), reader.ts (the card reader: an external leaf, word or column mode, feed
               delay; cardReader / deckReader memoized by what it reads, readerLeaves, readerProgress, loadedReader for
               Sim.poke), program.ts (programCards: a program as object cards, each word with its source line, a
               pseudo-instruction's later words their disassembly; deckProgram: a deck as hex or .word lines with each card's
               print a comment; widerCards, deckBits: shared by the sandbox's ROMs and the chapters' CPU panel);
               widgets/carddraw.ts draws a card to scale (cardView, click to punch); card.ts also has the card sorter
               (sorterPass: a pass on one column into pockets 0–9 + rejects, sorterColumns, sortOnSorter: the radix sort);
               prologue P3 is chapters/ch-cards.ts with widgets/cards.ts (loomWidget, censusWidget, cardEditorWidget,
               deckWidget with the sorter, readerPanel: the card at the reader's station on a scene)
src/hdl/       HDL in (DOM-free): yosysjson.ts (importYosysJson: Yosys's write_json → ChipDocs, one per module, instances as
               placed chips; every fine-grained cell as library parts, parseFf: the $_DFF* / $_SDFF* / $_DLATCH* family from
               dff / dffe / dff_r / d_latch(_r) and gates (a set = a reset of the inverted value); place(): columns by logic
               depth (loops cut at storage), rows from the drivers, wires between neighbouring columns routed here as `via`
               (a trunk each, ordered so no wire runs along another: driver row = sink row is the only constraint), the rest
               pointers named after the signals; HdlImport.drawn: the placed netlists, for layout tests), yosys.ts (Yosys 0.68 in
               WebAssembly, @yowasp/yosys pinned: vite.config.ts serves / copies node_modules/@yowasp/yosys/gen as yosys/, loaded
               on the first synthesis (CDN fallback); synthesize(files, { top, gates }): read_verilog -sv -noblackbox, hierarchy,
               synth, abc -g <GATE_SETS>, write_json; parseYosysLog → line diagnostics; setYosysLoader for Node: tests/hdlkit.ts
               runs the npm package, which needs --experimental-wasm-exnref (v8.setFlagsFromString) under Node 22)
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
                 (both up to 2^16 words: wordRom → romTree ≤ 2^8, else romLevels; RAM > 2^6: bigRam; RAM ports 2–8:
                 portMemory, ≤ 2^10 words),
                 consoles / switch banks / screens (ioparts.ts), puzzle ports (puzzleparts.ts); audio.ts plays the buzzers
  puzzleparts.ts PUZZLE IN (data / ready; read at a rising clk edge takes a word; reads past the end counted) and
                 PUZZLE OUT (data at a rising clk edge with we = 1, with the edge): external parts like the console,
                 their streams in the leaves' state; puzzleLeaves; on a puzzle chip the CPU drawer's monitors sit out
                 (PUZZLE_NO_GOLDEN: no golden model has the input stream)
  ioparts.ts     console (data / we / clk: prints at rising edges, \n \b \f, 500 lines of scrollback in the leaf's state;
                 ConsoleScroll: a face scrolled by the wheel stays on its text, follows it again at the bottom),
                 switch bank (1–32 toggles: an external source; holdSwitches: positions survive Reset), screen (8–128 px
                 square, mono / RGB111 / CGA 16 / RGB332 / RGB565; write: x / y / color / we into its own frame buffer;
                 rows: row := data, the bus cut into ≤ 32-bit chunks for its picture leaf (packed behaviour inputs are
                 exact to 53 bits only); pixels: a pure view of a px bus; optional vsync; X writes ignored and counted);
                 most significant field first; visual settings in the def but not its id (a resize carries the state);
                 ioNodes / ioState find them at any depth; colorRgb, pixelsOf, paintScreen (dots, grid, X pattern)
  cardparts.ts   the card reader part ({ reader: ReaderRef }: mode, bits, feed, name, cards as the deck file's holes with
                 trailing blank columns dropped + print): readerRefDef (cards/reader.ts deckReader), sanitizeReaderRef,
                 deckRef / refDeck, sampleReaderRef (the palette's HELLO deck), readerRefOf (remix: a reader leaf as a part)
  deckio.ts      a ROM's program as a deck (romDeck: object cards, w bits) and back (romWithDeck: hex words with the cards'
                 sources as comments, the ROM grown to hold them; refused when a card's word is wider than the ROM)
  face.ts        a packaged chip's appearance (ChipDoc.face: box size, pins by id on any side at any offset, displays by
                 part path, at / scale): resolveFace (automatic size and pins for what is left out, the box grown to hold
                 everything), applyFace (as PortDef.side, symbol w / h / portPos, keepOut: the label avoids displays),
                 faceItems (the chip's displays / I/O parts and what its placed chips show), faceOf(def) (the shown
                 displays, a WeakMap set by compile.ts), the face editor's edits (movePin swaps, pinToSide, resizeFace,
                 toggleDisplay, placeDisplay, autoLayout), faceHit / nodeAt / shownNets for a placed chip
  library.ts     UserLibrary: Merkle-cached compile of every chip, cycle checks, renamePort, removeChip
  ops.ts         pure edits (add / move / delete / flip / rotateParts (R: about the part's middle) / set*, copy / paste, namePart: rename where the name is
                 drawn); wires stay orthogonal (a straight wire's breakpoints stay put); dragWire (a corner or
                 segment grabbed: geom.ts grabOn; or a new corner: `{ bend }`, carried by the cursor after the right-click menu's
                 "Add a bend here"), removeBend, setStraight, clearBends
  history.ts     History<T>: undo / redo, transactions (a drag = one step), replace (not undone)
  store.ts       localStorage (loadWorkspace / saveWorkspace take a project's key), sanitizer, JSON export / import
                 (importChips: never overwrites, renames on conflict, recognizes its own earlier renames; a file names
                 its chips' folders, a whole project's also favorites and ISAs: readExport, workspaceFromExport);
                 share.ts: share-link encoding
  folders.ts     Workspace.folders: one level of folders for My chips (a chip in at most one; kept out of the chip
                 documents, so filing recompiles nothing); move / rename / remove, folderGroups, mergeFolders on import
  projects.ts    separate workspaces: the index (KEY:projects: names, chip counts, save times), the first project
                 'main' on the old KEY (the campaign keeps its level chips there), others on KEY:p:<id>; keys the
                 index lost are listed again
  files.ts       shareRoute / shareUrl, download names, import summaries, duplicateChip / deleteChip
  derive.ts      circuitMode, deriveBehavior (a combinational transistor chip → gate-level brick;
                 refused when an output can float: Z is not X on a shared bus)
  program.ts     ROM program text (asm / rv16 / cpu4 / 6502 / hex, or 'isa' with the ROM's own table) → words; 6502:
                 bytes folded into the ROM's 2^k (byte A → word A mod 2^k; a collision is an error), lines with `at` (the CPU
                 address) and `op` (an instruction's first byte)
  memory.ts      romImage (problems on source lines), romListing / romIndex (the row the circuit reads),
                 asm ↔ hex conversion, ROM_SAMPLES; readRam (live words; a large RAM's from its leaf state),
                 ramWithInit (initial contents as dotted power-on hints into the flip-flops' latches; > 2^6 words:
                 bigRamWithInit)
  hdl.ts         Verilog chips (ChipDoc.hdl: module, src on the group's top chip or `of` its id, stale): newVerilogChip,
                 setSource, resynthesize / applyNetlist (ids kept by module, the top module on the home chip; a vanished
                 module deleted, or detached when another chip places it), detachGroup, importNetlist (Yosys JSON → drawn
                 chips), isGenerated + bodyKey (Editor.edit refuses changes to a generated body), verilogModules
  hdlui.ts       plugin: the Verilog pane in slots.left (textarea over a highlighted pre, synthesized 1 s after typing or Ctrl/⌘
                 Enter: text + drawing one undo step; a stale chip shown or placed below is synthesized once per text, as a
                 volatile change), the canvas banner (Detach, Hide text), the 'hdl' props section (top, gates, modules),
                 registerFileImporter for .v / .sv and Yosys JSON, registerNewChipKind (New chip ▾ Verilog chip);
                 examplehdl.ts: Examples ▸ The same adder in Verilog
  examples.ts    EXAMPLES (fetch loop, counter + font ROM on a 7-segment digit, console, screen, the computer, shared bus,
                 wired-AND / OR, RV16 Pong: campaign/bench.ts pongChip), addExample: new chip (and an example's
                 `subchips`, fresh ids), opened. The computer
                 (computerChip, ~60 × 64 units: readable at fit with the CPU drawer): rv32i_core (lib/resolve.ts
                 pattern), a 1K ROM (riscv/ioprograms.ts), a Memory chip (memoryChip: decoder, 4K × 32 RAM, the
                 devices' buses x / y / byte), a 64 × 64 RGB332 screen at 0xC000_0000 + 256·y + 4·x on the top level,
                 a Devices chip (devicesChip: console / LEDs / switches at the ISS's IO addresses), a halt part on
                 `j .`; word accesses only (no lb / sb). The 4-bit CPU (example4.ts): docFromDef's drawing of lib/cpu4's computer,
                 each block a user chip, the ROM a cpu4 ROM part, the pins swapped for a TEST key, switches, hex digits, LEDs, halt.
                 The 6502 computer (example6502.ts): the part, a 4K ROM in 6502 assembly, memory6502Chip (decoder, 2K RAM,
                 read muxes), the Devices chip, a halt detector (the last SYNC address = this one); drawn with Sheet (pointer
                 taps two units out from a port; a user chip's box as compile.ts makes it: Example.build gets the sub-chips).
                 System on a bus (examplebus.ts, Sheet): SANDBOX_PARTS, a boot ROM part, the flash's contents a word-addressed
                 ROM part (bus/programs.ts SANDBOX_SOURCE), screen, keyboard and timer parts, every connection a pointer pair;
                 detectCpu leaves a sysbuscore part alone (its memory and interrupts are behind the bus: no drawer)
                 Boot from cards (examplecards.ts, Sheet): rv32i_core, a boot ROM part (CARDS_LOADER_SOURCE) below pc bit 12, a
                 two-port 64-word RAM above it (port 0 data, port 1 fetch), the card reader part at 0xC000_0000 (STATUS +0, DATA +4:
                 a load from DATA raises next) holding asmCards' deck of CARDS_PAYLOAD_SOURCE, a console at 0x8000_0000, a halt
                 part on `j .`; the CPU drawer's golden model sits out (cardparts.ts CARDS_NO_GOLDEN, simHasCardReader). The reader leaf
                 is a `seq` behaviour (outputs from its state alone), so the cycle engine runs the loop through amoadd's memWData
  geom.ts        snapping (ports on grid points), hit testing (a pin's knob before any port: a tap toggles it, a drag
                 from its half facing the stub wires (knobPortSide), from the far side moves; a part's port reaches only
                 PORT_INSIDE into its body), portHandles (dots on the selected / hovered), openOutputs (outputs no wire
                 reaches: drawn neutral, not X), pointer flags, junction groups, WireDraft
  session.ts     tab stack, new chips, input values kept across undo (keepVolatile)
  runtime.ts     EditorSim: rebuild on connectivity change only (debounced, carry state), cycle / gate run;
                 edgeHooks (before / after every rising edge, gate mode: after once quiet), runCycles;
                 halt parts at any depth stop Run / runCycles after the step where they read 1; key / keyboard
                 leaves at any depth driven through Sim.poke (setKey: held keys survive rebuilds and resets; typeKey;
                 a keyboard drops its oldest key when `ack` reads 1 just before a rising edge, or once settled
                 without a clock); pokeLeaf (a switch flipped, a console / screen cleared); gate level is a DualSim
                 (cycle mode on the cycle engine, `engine`: which runs); FrameBudget: Run's per-frame simulation
                 time adapts to keep ~60 fps ([2, 14] ms; an explicit budgetMs is fixed; the CPU drawer's Run to halt too);
                 autoStart: settings.autoClock starts a clocked chip at AUTO_HZ (2) once, unless Run / Pause / Step / a
                 clock click / a mode change came first (autoTried; a clock added to a chip that had none resets it); never
                 with a keyboard part (it would take the shortcuts). Cycle-mode Run steps half periods: the clock is seen high
                 for the first half of each (Pause completes the cycle)
  palette.ts     registerPaletteGroup + the palette panel (purist filter); a group's `folders` (My chips): sections
                 in folder order, empty ones too, renamed in place (double-click), drop targets for a dragged chip
  chips.ts       relations (used by / uses), pinOrder, renamePin (keeps parents wired), guessFf, nextDrive (inout)
  challenges.ts  build challenges: BuildChallenge (ports, table / sequence check, allowed parts, par),
                 startChallenge (u_ch_<id> with the pins placed), checkChallenge (BitSim / GateSim / SwitchSim;
                 failing vectors, restriction violations on the compiled hierarchy, score incl. static-timing
                 period for clocked chips), Allowed also `{ lib }` (the campaign: NAND + listed parts), importAnswer,
                 solveChallenge; challengeset.ts: CHALLENGES and their reference answers (chip documents
                 drawn with a small kit, each answer built from the answers of the rungs below);
                 CheckResult.failed: indices of the failing cases; tableRows / seqStart / seqStep: the
                 cases Check runs, shared with the test player. LibRule.strict: only the listed parts, switch-level ones
                 included (act P: relays and loads, or tubes and resistors; no MOSFET, no NAND); Score.relays / tubes (stats)
                 and steps (relay steps per input change, SwitchSim time; a bench may price relays itself: CustomRun.relays);
                 BuildChallenge.rules: structural problems beyond the parts (act P's tube grids read through a divider)
  testrun.ts     testSet(ch) (Check's cases, made on demand), TestReplay: a case played on the editor's own
                 simulation (EditorSim.notify / reapply), never the document; sequences step back from
                 checkpoints every 32 steps; a table replay starts from X (as Check's fresh simulation);
                 begin() / end() save and give back the simulation's state
  remix.ts       "Open in Sandbox": remixDef / remixIntoStorage (a shown def → a new chip; parts a reload could
                 not find by id come along as ROM / constant parts or chips); loaded on demand by the stage
  unravel.ts     unravelPointer(s) (a pointer name → wires from the driver: square shapes, else A* on the half grid;
                 never on another net), collapseWire(s) (a wire tree → one pointer per end), pointersOf(sel), suggestName
  hops.ts        HopCache: wire hops recomputed for the moved wires and those crossing them only
  toolbarfit.ts  shedActions: which toolbar actions move into the More menu on a narrow top bar (SHED_ORDER, least
                 used first; editor.ts fitActions measures beside the open tab / Open… / New chip, or on a row of its own
                 below 1000 px); below 760 px the palette is a drawer behind a Parts button (a tap arms a part)
  wirehue.ts     net colours: `hue` on wires and pointers, userHues (the colour most of a net's pieces carry),
                 colourNets (a whole net), hueOfNets, WIRE_HUES; hueswatch.ts: the swatch row (menu, properties)
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
                 consoleData / consoleValid / leds; a placed port core (rv32i_core, *_core) → regs '<part>.rf', its
                 RAM may sit one chip down ('mem.ram'); a console or switch-bank part → iss.mmio), resolveCpu (settings over detection), readers
                 (readRegs / readMem find w<i> registers via storageOf, banks, cache lines; memStoreOf also finds a
                 large RAM's leaf state), pipelineSlots,
                 CpuMonitor: the ISS in lock-step on EditorSim.edgeHooks (registers, PC, fcsr, memory
                 after stores or at a pipeline's halt, console, LEDs; without the pins: a console part's text, a switch
                 bank's positions, an LED bank named leds, here or one chip down), first mismatch, Run to halt
  cpu16.ts       detectRv16 (an RV16 ROM + a part with the core pins), Rv16Monitor: Iss16 in lock-step through the
                 core's write and store ports in program order (the campaign bench, live; RAM wrap, drain, next write);
                 a switch bank part (desc.switches): the model waits at a load from SWITCHES for the core's write and takes
                 its value when the bank held it in the last 16 edges (a pipeline reads it cycles earlier); a screen part
                 (desc.screen): Iss16's screen option, `screen` = the picture the matched stores painted; an edge with the
                 core's rst high counts nothing
  lanemon.ts     detectLanes16 (an RV16 ROM + a lane core: 2 / 4 / 8 lanes, warp + load port, fa / fd / fwe), LaneMonitor:
                 Simt16 / Warps16 in lock-step as lanecheck / warpcheck check (per-thread queues, the load port as the
                 previous cycle's warp's, pixel writes in draw order; the model runs ahead to the next write); the CPU
                 drawer's lane view (every thread's registers, the issuing warp on the listing)
  isaops.ts      custom ISAs in a workspace: ws.isas the tables, each ROM on one holds a copy (romRef.isa); isaList, copyIsa,
                 putIsa (an edit reaches every ROM that holds it), deleteIsa; isaui.ts the ISA editor dialog (File ▸ Instruction sets…);
                 isadesign.ts its Design tab (patterns painted on a bit grid, a drag = one undo step; the analysis is
                 isa/design.ts: clashes, shadows, the opcode map's window and cells, coverage, a plain decoder's NANDs / depth)
  m6502mon.ts    detect6502 (a placed m6502_core, a ROM in 6502 assembly, a RAM of bytes, here or one chip down),
                 M6502Monitor: follows the part (it is the cycle-exact model: nothing compared): the bus read before each
                 edge, an instruction from one SYNC to the next (its bytes, stores, cycles; IRQ / NMI sequences), halted on
                 a jump to itself; the CPU drawer's 6502 view (listing at CPU addresses, A X Y S P PC, the bus, the RAM)
  cpu4mon.ts     detectCpu4 (a ROM in 4-bit assembly, or on a custom table: followed, not checked), Cpu4Monitor: Iss4 stepped at every rising edge with the TEST / switch
                 values the hardware sampled, every register compared (CPU4_STATE paths; elsewhere: followed, not checked);
                 cpu4Use: the blocks an instruction uses (the drawer's marks)
  multicpu.ts    detectMulti (two or more placed CPU chips + a shared memory), MultiMonitor: MultiISS in
                 lock-step (which cores retired, each core's registers and PC, shared memory)
               DOM:
  editor.ts      Editor: workspace + history + library + sim + panels; registerToolbarAction, slots
  view.ts        EditorView: one SVG element per object updated in place, live values, overlays
  tools.ts       the mouse / keyboard state machine (place, select, drag, band, free-hand wires, pointers, rename
                 in place: F2 / a click on a selected name / editInline); a finger gets a larger port radius and its
                 press on a pin's port presses the pin (tap toggles, drag wires); a second tap on a wire's start lets
                 it go. On a touch screen Fit and the empty canvas use at least camera.ts TOUCH_PX per unit (touchZoom)
  ctxmenu.ts     plugin: the right-click menu (selection actions with their shortcuts, or the canvas's own);
                 pointerui.ts: its unravel / collapse actions and their dialogs
  iobar.ts       plugin: the chip's pins as a bar above the run bar (the workbench's switches and lamps, I/O toggle);
                 each control acts as a click on the pin; then the switch banks and keys inside placed chips, by path
                 (ionested.ts, DOM-free: nestedControls once per simulation, flipBank; past 3 banks "+n more")
  searchactions.ts plugin: the editor's toolbar actions, run / pause and New chip in the search (`>`)
  keys.ts        plugin: document keys → key parts (a bound key is taken from the shortcuts while the chip is open)
                 and keyboard parts (while running, or with the Type toolbar toggle); released on blur
  props.ts       properties of the selection or the chip, diagnostics; registerPropsSection
  fileui.ts      File menu (export / import / share link / Verilog / images / chip manager: grouped by folder,
                 rows dragged onto folders), share banner, drag-and-drop import, autosave indicator, backup notice;
                 installFiles(ed) per page; Export Verilog for FPGA… (fpga.ts / zip.ts loaded on demand: the report in a
                 dialog, the files as one stored .zip)
  fpga.ts        DOM-free FPGA export: fpgaExport(def, base) → files (design .v through vexport with external ports and
                 powerOnZero, <base>_board.v: 27 MHz ÷ 2^DIV_LOG2 clock, power-on reset, boardPlan's buttons / LEDs /
                 header pins, tangnano9k.cst labelled an example, README.txt) + issues (latchLoops: NAND SCCs outside
                 processes, named by the smallest instance holding them; ff chips with extra pins; initial contents;
                 asynchronous-read memories; pins with no board pin); zip.ts zipFiles (stored, CRC-32)
  projectui.ts   the project switcher above the palette's search (New, Duplicate, Rename, Export, Import a file as a
                 new project, Delete); the page (ui/pages/sandbox.ts) rebuilds the editor on another project, and a
                 campaign level's chip (u_ch_cp_*) always opens in the first project
  memui.ts       Memory palette group, ROM / RAM property sections (live listing, RAM grid, initial
                 contents), the program editor dialog, Examples ▸; values polled per frame while shown; long
                 lists build only the rows in view (vlist.ts: virtualRows), a large RAM's grid has Go to
  romcompose.ts  the instruction builder in a ROM's program editor, any language but hex / 6502 (Ctrl+Space / Build
                 instruction): the caret's line, its address and labels from isa.program; Replace keeps label, indentation
                 and comment (# ; //: withCode), Insert below, Deposit next (a line below, then the next); openAt(n)
  romtiles.ts    the program editor's Tiles view (Text | Tiles): isa/tiles.ts programTiles (kinds, reads / writes from
                 dest slots, target line, the nearest writer above of each read) drawn as tiles with gutter arrows; a click
                 builds the line, a drag moves it (moveLine, CodeEditor.replaceAll: one undo step); the code editor stays
                 in the page off screen (ce-away) so edits keep their native undo
  package.ts     "Package as chip…" dialog (name, hue, notes; the face editor: pins dragged along / across edges, corner
                 resize, displays ticked, moved and scaled, live; Save & new circuit)
  dispface.ts    the displays' SVG faces (drawDisplay / paintDisplay) and a placed chip's face displays (drawFace /
                 paintFace: from below its node), for the canvas, the face editor and look inside
  inside.ts      lookInside(ed, path): read-only live schematic over the canvas on EditorSim's simulator (ViewCtx);
                 consoles, screens and switch banks get their live faces there (ioface.ts decorateInside; switches flip)
  ioface.ts      the I/O parts' SVG faces (canvas and look inside; the wheel over a console with scrollback scrolls it,
                 "↑ n lines" while up, Ctrl + wheel zooms); ScreenCanvas: the picture as a canvas bitmap in a
                 foreignObject, repainted when the frame buffer's version moves (image.ts exports it as an <image>)
  ioui.ts        plugin: console / switch / screen property sections (live text, counters, Clear, Save PNG) and the
                 Screens drawer: every console, screen and switch bank in the hierarchy by path, live; opens by itself
                 for a nested console or screen (unless closed for that chip), behind a drawer already shown
                 (dockPane's `front` false); its console scrolls natively and follows only at the bottom
  cardui.ts      plugin: the card reader's property section (mode, bits, feed; the deck listed, the selected card drawn by
                 widgets/carddraw.ts and punched by hand, the read station followed live; load / save / punch from a ROM /
                 type a source card / drop / sort / delete / clear, each one undo step); deck files (pickDeck, saveDeck,
                 loadDeckIntoRom, saveRomDeck: memui.ts's ROM section and program editor), dropDeckFile (fileui.ts: a
                 .deck.json on the canvas goes into the selected ROM or reader, else a new reader)
  challengeui.ts "Challenges" list drawer (solved ticks via settings), the strip under the canvas while a
                 challenge chip is open (brief, Check, Show answer, Do it for me), purist palette while restricted;
                 a failing Check opens the test player on the first failing case; a core level lists its
                 programs, each watchable on a bench (campaign/bench.ts)
  testplayer.ts  the test player (Turing Complete style): step, scrub, play at a rate stopping at a failure,
                 jump between failures, a window of cases with the live row; an edit while paused replays the
                 case on the rebuilt circuit; Run / Step / a clock / Reset or an input set by hand ends it
  puzzleui.ts    plugin: the Puzzles drawer, the start dialog (puzzles/start.ts candidates), and while a puzzle chip
                 (u_pz_<id>) is open the strip: brief, tests (a click plays one: puzzles/replay.ts), Check, score
                 against par, the cycles / NANDs chart, Show answer, Do it for me; PUZZLE IN gets the selected test's
                 words whenever the circuit powers on (autoload)
  inspect.ts     the Inspector in a drawer for the chip or a part; chipprops.ts: chip / part property sections
  dock.ts        the right-hand dock: drawers (Inspector, CPU, Screens, challenges) share it, tabs when several;
                 sets --dock-space on the overlay so look inside stops at its edge and Fit (Editor.fitView) leaves room
                 for it (a still-fitted view refits when a drawer opens or closes)
  analysis.ts    plugin: probe mode (P) + LogicAnalyzer in slots.bottom, Timing props section with
                 the critical path drawn on the chip, lint as a diag source, open-input marks; records only while
                 the panel is open (its trace listener puts DualSim on GateSim)
  owninstr.ts    Custom instructions… (the CPU drawer's Custom…, a ROM's program editor): up to three rows on an
                 rv32i_core, their problems, data path, signals and generated golden-model code, the control unit's cost
                 measured; Apply (one undo step): the core part becomes { core: { custom } }, the ROM ref gets a copy
  cpuui.ts       plugin: the CPU panel (docked drawer: status, listing with the PC and pipeline stages, a
                 click marks the instruction's parts (insthw names) and colours its field wires
                 (instrMarks → wires by net), field breakdown (widgets/instrfields), pipeline diagram
                 (widgets/pipegrid), the system CPU's I/O, registers, fcsr, memory, retired; Run to halt,
                 Step, Slow (instructions per second), Reset, Edit program; the multi-core view),
                 opened by itself for a complete CPU; CPU props section
src/phys/      lumped physics models behind the prologue's close-ups (DOM-free): relay.ts (a 24 V telephone relay: saturating
               flux, gap-dependent reluctance, armature and blade with a compliant, bouncing contact, quench resistor; relaySim,
               relayStatic (pull-in / drop-out), relaySummary; RELAY_STEP_MS: the settled time, the relay step's length
               (tests/phys-relay.test.ts holds it to the model), RELAY_COIL_POWER); triode.ts (a 6SN7 section: space-charge
               law fitted to the datasheet, Richardson emission over a 6 s heater warm-up, plateVoltage with divider loads,
               gateLevels(fanout, top, bottom, bias): a chain's margins, sectionPower / nandBrickPower, TUBE_STEP_US (an
               estimate), ENIAC's numbers; tests/phys-triode.test.ts)
src/gl/        the hand-written WebGL2 renderer (its own lazy chunk, no library): instanced meshes (boxMesh, cylinderMesh; 18
               floats per instance: position, scale, quaternion, RGBA, emissive + specular), transparent batches, frames
               on demand, OrbitCamera + orbit controls, context loss recovery; createRenderer returns null without WebGL2.
               widgets/relay3d.ts (relayCloseup: a placeholder, then imports relay3dview.ts: the relay in 3D on
               phys/relay.ts, sliders, plots, an SVG fallback without WebGL2); widgets/triode3d.ts (triodeCloseup, the same
               way: triode3dview.ts on phys/triode.ts); widgets/tubedivider.ts (P2's divider explorer: ratio, bias, fan-out)
src/gfx/       raster16.ts: the campaign's (7-bit vertices, 32 × 32, RGB565; Edge16 / Walk16 models, rasterize16 with the
               19-cycle set-up, draw16, rgb565); raster.ts: the rasterizer's reference model (setup, rasterize: pixel writes
               with their cycles, zPlane / zAt / zStore, blend332, RefFrame: a framebuffer and depth buffer drawn as the
               hardware does; Z_WALK_START, CLEAR_CYCLES); tessellate.ts: chapter 32's drawing pad as triangles (polygonTriangles: ear
               clipping, a fan when it crosses itself; strokeTriangles: RDP-thinned path, mitred strip, square caps; frontFace),
               drawingOps (a clear, then each shape one depth plane nearer than the last, depth test on: a shape blends once where its
               own triangles overlap), drawingCost (cycles from the reference: clear, triangles, set-up), drawingPicture;
               pipeline.ts: chapter 33's reference (frameOps / framePicture: frame f of a mesh), FrameRecorder (a frame's spans per
               unit and its cycles by phase, from one sample a cycle), PIPE_COSTS (measured, pinned by tests/gfxpipe.test.ts).
               The kernels and meshes are riscv/gfxprograms.ts (16.16 rotation with mul, vertex buffers f mod 2, the memory map;
               SOFT_CLEAR / SOFT_TRIANGLE: the same frame in software on four warps)
src/doom/      Appendix B's Doom computer (DOM-free): machine.ts (the memory map: 8 MiB RAM, the WAD read only at 0x1000_0000,
               I/O registers 3 WADLEN / 6 KEY (a read pops an event) / 7 FLIP beside the system CPU's, a 320 × 200 indexed
               frame buffer at 0xC000_0000 + palette at 0xC001_0000; DoomDevices shared by FastDoom (riscv/fastiss.ts) and
               GoldenDoom (the golden model, lock-step checks); CLOCK_KHZ 40 000: game time from mtime), image.ts (doom.img:
               'RVIM' header, ROM words, initial RAM words; symbolAt over doom.syms.json). The program: ports/doom/ (doomgeneric,
               GPL-2, vendored with its patches listed in its README, platform layer, link.ld), built by scripts/doom/build.mjs
               (pinned xPack riscv-none-elf-gcc, rv32im; checked in: public/doom/doom.img + doom.syms.json, so npm test needs
               no compiler); Freedoom (BSD) is never checked in: scripts/doom/fetch-wad.mjs (pinned URL + sha256) into .cache/doom/;
               scripts/doom/run-raw.mjs a strict stand-alone runner (NULL-page / WAD stores, PNG frames), scripts/doom/bench.ts
               cycles per frame (tests/doom.test.ts: boot to the title, 1.5 M instructions against the golden model);
               player.ts (DoomPlayer: advance(wallMs, budgetMs) toward wall-clock time at CLOCK_KHZ in SAMPLE-instruction chunks,
               the PC after each a sample: profile by function, instruction mix; recent PCs; paused: step / stepN / toNextPixel /
               toFrameEnd (FastISS.yieldNow from FastDoom.yieldOnPixel / yieldOnFlip), back(): a journal per step, snapshots for
               larger operations), keys.ts (KeyboardEvent.code → doomkeys.h). widgets/doom.ts: Appendix B's Play step (chapters/
               ch-doom.ts): fetches doom.img + syms on open, the WAD only on Play (public/doom/freedoom1.wad: fetch-wad.mjs --public,
               run by the deploy / desktop builds; or the learner's own file); keys only while the screen has focus.
               The gate window (step 2, widgets/doomgates.ts): lib/doompc.ts doomComputer(text, wadWords, wadLength) =
               systemCore({ m: true }) (system.ts: the system CPU with its ROM on pcOut → instr and data on a port memAddr /
               memWData / memBE / memWE / memRE / memRData; only mtime / mtimecmp inside) + doomProgramRom (romLevels 2^16) +
               bankedBigRam(21) RAM + wadRom (romLevels 2^23, statsOf: cost counted from the words, romLevelsStats) +
               bankedBigRam(15) frame buffer + doomDevices (KEY_QUEUE: an external leaf popped by the read strobe) + DOOM_MAP;
               doom/gates.ts loadGates (registers / PC / CSRs / timer forced into both latches of each flip-flop, memories and the
               key queue poked; a DualSim through its GateSim, then the cycle engine), runWindow (lock step with FastDoom, PC and
               registers per retirement), memoryDiff (tests/doomgates.test.ts). The scene starts as the core on a bench and reloads
               with the whole computer once a game starts (a module-level session); Scene.noRemix hides Open in Sandbox
src/campaign/  the campaign (#/campaign, its own chunk; plan and status in docs/CAMPAIGN.md). DOM-free:
  types.ts       CampaignNode (act, kind lesson / drill / build / program / core, requires, why, tips, codex,
                 unlocks: library ids or `prefix*` later levels may place, anatomy blocks, base challenge, par, soon)
  nodes.ts       ACTS and NODES: the tree, act 0 (transistors) to act 10 (memory), and act P (num 11, `label`, listed after
                 act 0: ACTS is in map order, so look acts up by number: actName / actTitle)
  graph.ts       ancestors, topo, ruleFor(id) (NAND + unlocks of the requirements' closure: fixed per level),
                 statusOf (locked / available / started / solved / skipped; Unlock all), nextAvailable
  levels.ts      levelChallenge(node): the base BuildChallenge with the campaign rule and par, id cp_<node>,
                 chip u_ch_cp_<node>; nodeOfChip; startCandidates / startFrom (a core level begun as a copy of an
                 earlier core level's chip, plus the new pins)
  grade.ts       measured(score), stars (★ pass, ★★ ≤ 1.5 × par, ★★★ ≤ par on every graded metric), better
  cardlabel.ts   KIND_LABEL, STATUS_LABEL, levelCardLabel (a map card's accessible name: "Build: CMOS inverter, locked")
  progress.ts    Progress (own storage key, injected KV): status, best, stars, tips, seen; codexUnlocked;
                 exportCampaign / importCampaign (progress + level chips' closure, merged, never overwriting)
  codex.ts       CODEX entries (component / law / tool / trick / concept); lessons.ts lesson HTML
  anatomy.ts     the target CPU as blocks (intro diagram), blockNodes; layout.ts the map's placement (OPTIONAL_ACTS: P, 8, 9,
                 10 fold to a header line, foldedActs: until a level in them is opened, or as settings.actOpen left them)
  drills.ts      generated questions with exact checkers (numbers, Boolean parser, exact K-map minimum, RV16
                 encoding, binary16); puzzles.ts RV16 program puzzles on the golden model (size, cycles)
  buildr.ts      act P (before the transistor, act 11 labelled "Act P", optional, beside act 0): relay levels (NAND, XOR,
                 4-bit adder with the carry through contacts, self-holding relay, buzzer clock: a custom bench stepping
                 relays) and tube levels (two inverters in a row, Eccles–Jordan) under RELAY_RULE / TUBE_RULE (strict);
                 gridProblems: every triode grid behind a divider. Graded in relays, relay steps, tube sections
  build1/5/6/7/8/9.ts, buildh.ts, buildfp.ts  the levels new to the campaign by act: BuildChallenges whose reference
                 answers are library blocks drawn as chips (docFromDef; build9 / buildfp also draw sub-units as chips of
                 their own); a side quest gives its reference's parts (givesOf); buildfp: the FP ladder (unpack, rounding
                 decision, sticky shifter, leading-zero counter, normalize & round, compare, int → float), whose blocks
                 (FP_BLOCK) are never given, only unlocked by the rung that built them (fpGives)
  bench.ts       addBench: a failing core test as a computer chip around the learner's core (RV16 ROM, 64-word
                 RAM, LEDs, IRQ line, a power-on reset for the first cycle), opened with the CPU drawer; failingTest names
                 it from a failure line; benchChip(…, { io }): plus a 32 × 32 RGB565 screen at 0xF000 (daddr[15:10] =
                 111100, write-only) and eight switches at SWITCHES (0xFFFA); addPongBench (Pong around a
                 learner's core: the challenge strip's "Play Pong on your core" on a passing CoreSpec.rv16i level),
                 pongChip (around the reference rv16_cpu: Examples ▸ RV16: Pong);
                 addLaneBench: the same for a lane core (act 9): a power-on reset for the first cycle, a lane address chip
                 per lane (data 0x000–0x3FF; raster: the screen 0xF000), a RAM part with a port per lane (ports: n),
                 warps: a register after each read (a cycle late), raster: the screen memory with a fifth port for fa / fd /
                 fwe and a 32 × 32 RGB565 screen of the rasterizer's writes
  datasheet.ts   a codex component entry's datasheets: the unlocked library parts' pins, cost, depth, truth table
                 (datasheetOf(id): one part)
  cases.ts       level cases ("why we are building it": problem, without, cost, alternatives as library ids measured
                 live, counts) in cases0.ts (acts 0–3) / cases1.ts (acts 4–10) / casesP.ts (act P); measure.ts libCost
                 (also relays, tube sections and steps through lib/tech.ts price: a relay level's alternatives), finalCpu (the last
                 required core's reference, compiled once), copiesInFinal(node) for the after-pass card
  codexmore.ts   the fuller codex (idea, example, mistakes, lib figure, compare, anatomy, chapters) in codexmore0.ts
                 (components, laws, tools) / codexmore1.ts (tricks, concepts) / codexmoreP.ts (act P); loaded on demand
                 with codexcheck.ts (Check yourself: two Quizzes per entry in codexcheck0–3.ts, tests/codex-guide.test.ts)
  codexlinks.ts  how entries connect: CODEX_ORDER, buildsOn / leadsTo (from the level graph), seeAlso (related both ways),
                 neighbours; ui/codexfigs.ts: figures from the site's widgets for entries without a part (number explorer,
                 instruction fields, adder comparison, the gate-level RV32I pipeline run a few cycles); the codex page
                 searches titles and summaries, filters by kind; a locked entry shows its summary
  glossary.ts    codex terms in prose (titles, parenthetical names, aliases, plurals; acronyms as written)
  walk.ts        walkOf(node): the reference answer as steps (authored in walks.ts / walks1–7.ts for every build and core
                 level, a test checks it; else generated in dataflow order, like parts grouped), partialDoc(walk, k),
                 stepMetrics (cost, depth, rows right per output); a step's `ask` (one per walk) is answered before its
                 parts show (predict first). buildalong.ts: Build along's check (parts by kind and place, nets by the
                 ports they join) and snap; nudges.ts: the first rung of the hint ladder (tipsOf: nudge, then tips)
  corecheck.ts   the CPU core bench (coreCheck carries its CoreSpec: coreSpecOf): instr / drdata served
                 combinationally, register-write and store traces
                 compared with iss16 in order, cycle budget, irq from stores to 0xFFF9, 32 BitSim lanes (GateSim
                 fallback), corePeriod (static timing with 8-delay memories); coretests.ts the programs by stage;
                 lanecheck.ts the lane bench (CoreSpec.lanes: four memory ports, each lane's writes and stores against
                 Simt16, lanes in order within a cycle; lanePeriod), lanetests.ts its programs (warpTests: + two-warp ones);
                 warpcheck.ts the two-warp bench (drdata from the previous cycle's address, issue port = this warp, load
                 port = last cycle's, against Warps16; warpPeriod: synchronous data memories; CoreSpec.raster: pixel writes
                 fa / fd / fwe in order against the golden model's draws, applied to the screen); rastercheck.ts k_raster's
                 bench (64 triangles on BitSim lanes, writes in walk order, cycles graded); buildk.ts act 9's levels;
                 puzzles.ts kernels on two warps (`warps`) also run with warp 1 ahead (a missing bar fails)
  buildm.ts      act 10's levels (memory, Phase 16e): m_sense (a DRAM column at switch level: senseSeq, chapter 34's
                 protocol), m_bank, m_ctrl, m_bus (busSeq: a sequence from a model of the bus and its bench), m_dma,
                 m_flash; memcheck.ts their benches: the device on the bench as a JS model that names the first rule
                 broken (ArrayModel: 16 × 16 words, ACT / RW / PRE, rows leak after BANK.RET; Dram16Model: two banks,
                 DRAM16 timings, REF; DmaLane: a memory with wait states, the copy script, the handshake rule;
                 Flash16Model: 4 × 4 pages + a spare-area tag, program once, erase a block), request traces (Requester:
                 held until busy = 0 / ready) on BitSim lanes; p_boot (puzzles.ts `dma`) runs on iss16's DMA engine
               DOM: ui/svgs.ts (map and anatomy SVG), ui/levelinfo.ts (criteria, grading table), ui/codexentry.ts (a codex
               entry in full, live schematic), ui/glossaryui.ts (markTerms: hover cards); the page is ui/pages/campaign.ts.
               Levels are played on the level screen (ui/pages/level.ts, #/campaign/play/<node>, the editor's chunk): an
               Editor in level mode (EditorOptions.level: the level's chip and its sub-chips as tabs, listed toolbar
               actions, purist palette led by "Unlocked parts", properties over the canvas while selected or pinned) and
               installChallenges(ed, LevelScreenHooks) (the strip shows Check, the result, the test player; the page
               shows the after-pass card); ui/pages/levelwalk.ts the walkthrough on a scratch chip u_walk_<node>. The
               sandbox still opens a level's chip u_ch_cp_<node> with the full strip (breadcrumb, tips, stars, Next,
               Level screen); both record passes in the campaign's progress
src/puzzles/   program puzzles (the sandbox's Puzzles drawer; roadmap Phase 12). DOM-free:
  puzzles.ts     PUZZLES: tasks as word streams (tests, cycle limit, pseudocode), ISA-agnostic; inputOn / outputFrom: a
                 word through a narrower port in pieces, most significant first
  computers.ts   ready-wired puzzle computers (4-bit CPU, RV16, RV32I: ROM, RAM, halt detector, both ports; their I/O
                 conventions) built with Builder and drawn by docFromDef; an RV16 one around a learner's campaign core;
                 copyForPuzzle (a learner's chip with the ports placed, unwired)
  run.ts         Check: every test on a fresh EditorSim (cycle engine) from power-on until a halt part reads 1;
                 judge (words, reads past the end, the limit); hardwareNands (program ROMs left out), programWords
  refs4/16/32.ts reference programs; refdata.json their measurements (scripts/puzzles.ts --write; tests/puzzles.test.ts
                 checks both); measure.ts; grade.ts stars against the reference points (★★ none both cheaper and
                 faster, ★★★ cycles × NANDs below all), PuzzleProgress (own key); start.ts the choices and the puzzle chip;
                 replay.ts the player (a test on the editor's own simulation, checkpoints for stepping back)
src/ui/        app shell, router, theme, settings, progress; chapternav.ts (DOM-free: every chapter / step as a
               searchable entry, searchNav ranking; NavItem / rankItems for every kind of search row), quicknav.ts
               (chapter menu on the top bar and the chapter title; the search box: Ctrl/⌘ K or `/`, groups, scope chips
               on Tab, `>` actions, a footer naming ↵ / Shift ↵; focusStage, the skip link's target); searchsources.ts
               (DOM-free: registerSearchSource, registerActions, recent picks, searchGroups), searchbuiltin.ts (chapters,
               workbench, the app's and the stage's actions; campaign levels and codex from searchcampaign.ts, a chunk
               loaded on the first keystroke: locked ones listed, marked, brief only); keys.ts (the key table KEYS
               every help sheet is drawn from, matches: event.key, else event.code on a non-Latin layout, brackets by
               code; the single-key switch settings.singleKeys, WCAG 2.1.4; bindKeys / installKeys: Ctrl K in the
               window's capture phase, other global keys in its bubble phase after the page's own listeners);
               keyhelp.ts (the `?` sheets: Keys on this page, the sandbox's); quiz.ts: quizBox (chapters, recaps, codex,
               walkthrough), options in a fixed shuffle per question (shuffleOrder: authors write the answer first), a
               pick scrolls its explanation into view; stagenotes.ts: over a chapter's canvas the step's challenge goal (a
               click shows its card), green and announced (aria-live) once solved, toasts when a Try box ticks (words:
               feedback.ts, DOM-free); reveal() scrolls into view, smooth unless reduced motion
tests/         Vitest: every component with a `spec` is checked exhaustively (≤ 12 input
               bits) or randomly against its structure; sequential behaviour tests
tests/verify/  CPU verification (docs/VERIFICATION.md): cpus.ts (every RV32 CPU variant: build, ISA, env,
               notApplicable), images.ts (official riscv-tests images in riscv-tests/*.json, built by
               scripts/riscv-tests/build.mjs; the data loader; tohost verdicts), run.ts (golden model, lane
               batches on BitSim), fuzz.ts (random programs, final state, lock-step replay of a failure),
               coverage.ts (instructions, traps, hardware events per lane), suite.ts (verify-*.test.ts),
               bench.ts (the benchmark set per lane: cycles to the golden model's instruction count, cache
               misses / stall cycles from the stall nets, final state checked; measureCpu: NANDs without the
               program ROM, period); spike.ts (the golden model against Spike: oracleCase links a random
               program (dataBase, timer: false) as an ELF (elf.ts, no toolchain) with boot / exit stubs, parseSpikeLog,
               compareWithSpike commit by commit; issAsSpikeLog: the plumbing's self-test); scripts/rvtests.ts
               (matrix), fuzz32.ts (any seed range), spike-oracle.ts (configs, seeds, --spike, --self, --out; CI only:
               no Spike on Windows), coverage.ts (tables;
               --write updates the doc), benchmarks.ts (every CPU, ~6 min; --write saves src/bench/results.json,
               checked in: tests/benchmarks.test.ts fails when a program changed since, and re-measures `sc`)
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
  `labelOverlaps` over every registered netlist and the CPU tops; `boxTextOverlaps` over every registered box:
  view/boxtext.ts places a box's port names and label, lifting the label clear of a bottom clock's name).
- Prefer hierarchy (a box of boxes) over flat netlists: it is the whole point of the site.
- Large top-level schematics: draw the main data path, and use **net labels** (`tags` on a
  NetDef) for control signals and long feedback paths, like a real schematic. Place
  instances so that ports line up (see `alignY` in cpu.ts) and data wires stay straight.
- Hand-written SystemVerilog goes in `hdl.verilog` (behavioural or structural, matching the
  primer's style). Structural Verilog is also generated automatically.

### CPU scenes

`cpuScene({ source, pipeline?, system?, m?, dcache?, multicycle?, adder?, timing?, wide?, ooo? })` (widgets/cpupanel.ts) builds a CPU scene
with the CPU panel (listing, registers, memory, golden-model lock-step) and optionally the
pipeline diagram and the static-timing panel; `ooo`: the out-of-order core on the cycle engine with the Out of order panel
(widgets/ooopanel.ts; the two panels share the selected instruction through an OooLink). Panels observe clock edges through
`stage.edgeHooks` (before / after every rising edge), so they stay correct during fast runs.
The pipeline's golden model steps when a valid instruction is in W (`retiring()`); a CPU that retires several a cycle
gives their count on `retire` and the golden model steps that many times before the state is compared (`retireCount()`:
the CPU panel, the sandbox's CpuMonitor, fuzz replay, benchmark lanes and energy runs).
Clicking a listing line highlights the instruction's hardware (insthw.ts) in focus mode
(`stage.highlight(names, true)` fades the rest); "in ROM" calls `stage.reveal(['imem'], 'c<i>')`.
**Slow mode** (CPU panel) ticks at a learner-set rate (`settings.traceRate`, or `speed` for gates) at one of
three levels: `gate` (`stage.startEdge()` / `edgeStep()`: a rising edge one gate delay at a time, via
`src/sim/edge.ts`, which `Stage.cycle` also uses), `cycle` (`pulse(flowMs)`) or `instr` (run to the next
retirement). The highlight then follows execution, and the trace logs `stepEffect(iss.step())` (riscv/trace.ts).
While `stage.inEdge`, panels must not compare the hardware with the golden model (it steps after the edge).
The Warp panels (widgets/lanes.ts, warps.ts) have the same listing marks (laneUse) and Slow mode; on the warp core the
instr level is an issue, and the highlight follows the issuing warp onto its active (or served) lanes.
**Back** (CPU panel and the stage's bottom bar) undoes a step, a clock cycle, an input change or a whole Run to
halt: the stage's controls call `stage.checkpoint()` before acting (an unchanged state is not saved twice), panels
call it before an action made of several (a run, an instruction); `Sim.saveState()` / `restoreState()` copy the
whole simulation (values, inputs, time, pending events), and a panel with its own state (golden model via
`ISS.save()` / `MultiISS.save()`, trace, counters, console) registers a `stage.historyHooks` entry. The analyzer
`rewind`s to the restored time. History is cleared on load and Reset.
The pipeline diagram reads `pipeSnap` (riscv/cosim.ts) and draws with `widgets/pipegrid.ts`, shared with
the sandbox's CPU drawer (editor/cpuui.ts), which mirrors these panels for any CPU opened in the sandbox:
keep the two in step when a panel gains a feature. Both show the energy per instruction (a PowerMeter on the GateSim,
restarted on Reset and Back; the sandbox only in gate mode, the cycle engine counts no toggles).

### Viewing aids (all derived, none stored in the netlists)

- Wire palettes: `data-palette` on `<html>` (styles/palettes.css, `light-dark()` tokens). Use
  `--w0 --w1 --wx --wz --bus --bus1` and the shape tokens (`--wire-w0` …), never raw colours.
  Probe colours are `--probe-0..7` (class `p0..p7` sets `--pc`).
- Colour per net (settings.netColors, `data-netcolors="on"`; on by default with the vivid look): view/nethue.ts gives each net a hue from
  `netKey` (its name, else its sorted ends), then `spreadHues` moves those within 60° of a net drawn next to them (from
  the routed paths in SchematicView, the wires' polylines in EditorView: recomputed per build and wire shape); drawn elements carry it as inline `--nh` (value classes are rewritten on
  every repaint) and palettes.css rebuilds `--w0 --w1 --bus --bus1 …` from it. A new per-net element must get
  `setNetHue` too. A colour the user picked for a net (sandbox, editor/wirehue.ts) travels as `USER_HUE + hue`
  through the same paths; setNetHue then also sets `--net-user`, which shows it with the switch off.
- Vivid look (settings.vivid, `data-look="vivid"`, styles/vivid.css): filled bright bodies, wires scaled by `--wire-k`
  (use `calc(var(--wire-w1) * var(--wire-k, 1))` for a new wire width). Its dark board (`data-board="dark"`) adds
  `svg.schematic` to the dark token blocks (theme.css, editor.css, ioparts.css): a new dark token block needs it too.
  Cartoon parts (settings.cartoon, `data-parts="cartoon"`, with vivid): drawSymbol always adds `.sym-shadow`,
  `.sym-gloss` and a box's `.sym-icon` (boxtext.ts iconSpot: a corner no text covers), hidden unless cartoon.
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
- `Scene.engine: 'nmos'` runs a transistor-level scene on NmosSim (Appendix A's 6502; widgets/m6502.ts: the scene and
  its panel, which is the memory on the chip's pins and checks every bus cycle against the ISS; m6502isa.ts the opcode
  matrix, m6502ledger.ts the transistor ledger). A chapter with `appendix: 'A'` is shown by its letter after the
  journey (map divider, menu group, header; chapterNo()).
- `Scene.engine: 'cycle'` runs a scene on DualSim with the cycle engine preferred (chapter 33: 413 501 leaves): settled
  values only, so the timing and probe buttons are hidden (the analyzer's trace listener would pin it to GateSim) and
  the inspector has no power estimate; stepping and slow-motion edges still go through GateSim. Chapters 28–31's lane and
  warp core scenes too (laneCoreScene / warpCoreScene; `engine: 'gate'` keeps GateSim; tests/gpu-cycle.test.ts).

### Sandbox editor

- Every change goes through `Editor.edit()` (one undo step), `begin()` / `commit()` (a drag: one
  step) or `volatile()` (open tabs, input values: saved, never undone); `refresh()` then updates
  the library, view, simulation and panels. During a drag only the drawing follows.
- The simulator is rebuilt only when `simKey` (connectivity + part definitions) changes; input
  values are stripped before compiling, so toggling an input recompiles nothing.
- Later phases plug in through `registerPaletteGroup`, `registerPropsSection`,
  `registerToolbarAction` (`active` for toggles, `menu`: its name in More), `registerEditorPlugin` (per-editor state, with a
  cleanup), `registerDiagSource` (extra diagnostics, e.g. lint), `Editor.onSimChange`,
  `Tools.onPress` (a mode that takes clicks first) and `editor.slots` (`overlay` over the canvas,
  `bottom` above the run bar, `top` in the tab bar, `left` beside the canvas: the Verilog pane), `registerFileImporter`
  (fileui.ts: more file kinds for Import and drag-and-drop), `registerNewChipKind` (New chip ▾). `editor.saveState` / `onSave()` report autosave
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
  DOM-free costs on a CPU and a 64-bit Kogge–Stone adder opened in the sandbox; `scripts/sim-perf.ts` the
  cycles/s of the CPUs on GateSim and the cycle engine (`--ref`: against the old GateSim).
- Run in cycle mode uses the cycle engine (DualSim): no gate time (the run bar hides `t`), the same values after
  every settle; gate mode, probes / the open timing panel and stepping use GateSim. Storage is found by its structure
  (library flip-flops, ones drawn from NANDs, latches, async resets, clocks through inverters) and big memories are
  `seq` behaviours; gated or ripple clocks fall back to GateSim (`DualSim.whyNot` says why).
  The CPU drawer redraws at most every 100 ms while the clock runs.
- Probes and the timing panel are gate level only (the switch-level solver has no time); lanes
  name what was drawn and survive rebuilds (`LogicAnalyzer.rebind` keeps the recording).
- Keys are handled on `document` while the page is mounted and ignored while typing in a field.

### Writing chapters

A chapter is a list of steps. Each step has narrative HTML and either a `scene` (a root
component, initial inputs, optional drill path, highlights, probes) or a `widget`, plus an
optional `challenge`. Keep the prose short, concrete and honest. Introduce a component
as a black box only after its inside has been shown. A clocked scene starts running on load (settings.autoClock,
2 Hz; Pulse / Step / Back / a hand-clocked edge pause it): give it `autoClock: false` when its exercise counts Pulses
from the first state. Say what each thing *costs*.

The guide around the prose (ui/pages/chapter.ts, looks.ts; tests/chapter-guide.test.ts checks every name and id):
- `goals` (3–4, "In this chapter you will …") and `builds` (earlier chapter ids) open the first step; `recap` (`keep`,
  `check`: three Quizzes, `practise`: level ids) is a step of its own after the last (`#/c/<id>/<steps.length>`), with
  the codex entries that link the chapter (campaign/chapterlinks.ts, loaded on demand).
- Name a part in the text with `<span data-show="hz fwdA">…</span>`: hover lights it on the stage, a click pins it
  (`pin:a` a pin, `dp.alu` opens dp). A highlighted scene gets a "Lit on the circuit" line from the instances' labels
  (`Step.lit` overrides it, `''` hides it).
- A quiz's `why` (one per option) says why a wrong pick is wrong; a reach challenge's `hints` come before Show answer;
  `Step.tries` ticks the body's `.try` boxes in order once a condition holds. Folded asides: `<details class="deeper">`.
- Checks (challenges and recap questions, chapters/checks.ts) fill the step dots and the chapter menu's counts.

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
- A test that runs for many seconds (a CPU over thousands of cycles, a large sandbox round trip) yields now and then
  (tests/yieldtick.ts: `await tick()`, `stepped(generator)`): one that holds its worker past vitest's 60 s RPC timeout
  fails the whole run on CI although every test passed.
