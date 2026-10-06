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
npm run build        # typecheck + production build into dist/ (relative base, deploy anywhere)
npm run preview      # serve dist/
```

CI (`.github/workflows/deploy.yml`) runs tests + build and deploys `dist/` to GitHub Pages
on every push to `main`.

## Stack and conventions

- Vite + TypeScript (strict, `verbatimModuleSyntax`: use `import type` for types). No UI
  framework: plain DOM + SVG with small helpers in `src/ui/dom.ts`. Keep the bundle small.
- Hash routing (`#/c/<chapter>/<step>`, `#/workbench/<componentId>`) so the site works on
  any static host or sub-path.
- Theme: CSS custom properties in `src/styles/`; `data-theme="light|dark"` on `<html>`, or
  absent for auto (`prefers-color-scheme`). Always define new colours for both themes.
- Match the surrounding code: terse, typed, comments explain *why*.

## Architecture

```
src/sim/       simulation core (no DOM)
  types.ts       ComponentDef / PortDef / Netlist / NetDef: the single source of truth
  geometry.ts    symbol sizes and port positions (grid units) shared by authors, router, renderer
  flatten.ts     hierarchy → flat 1-bit nets + leaves, keeping a HierNode tree mapping every
                 level's ports/wires to flat nets (this is what makes every box transparent)
  gatesim.ts     event-driven 3-valued (0/1/X) simulator, unit NAND delay, transport delay,
                 relaxation for power-on and oscillation resolution; runUntil(t) for a
                 fixed-period clock (an edge does not wait for the logic to settle); onTrace +
                 watch() report every change of watched nets at its exact time
  switchsim.ts   switch-level MOSFET solver (0/1/X/Z, shorts, floating nodes); transistor
                 `strength` (ratioed logic) and `cap` nets that keep their charge
  fpref.ts       exact reference float arithmetic for any format (BigInt, RNE), float32 helpers
  coherence.ts   MSI / MESI snooping model (per block, no capacity)
  pnr.ts         problemOf(def), Layout (annealing placer), route / routeAll (two-layer Lee router)
  techmap.ts     techMap(def): inverter recognition and double-inversion removal
  cachemodel.ts  behavioural cache model (size/line/ways/replacement/write policy, 3C classes)
  harness.ts     simulate(def), evalOnce, forEachInput: for tests, truth tables, workbench
  stats.ts       transistor / NAND counts, logic depth
  timing.ts      static timing: register-to-register critical path, per-capture-stage periods
  verilog.ts     structural Verilog generated from any netlist (identifiers sanitized, alias
                 boxes from their bit map)
  svexport.ts    exportHdl(def, 'structure' | 'synth', testbench?): whole hierarchy in one file,
                 self-checking testbench from our simulation (checked against Yosys when installed)
  vexport.ts     synthesizable Verilog-2005 (flip-flops as processes) for Yosys / OpenROAD
  vcd.ts         toVcd(): Value Change Dump of recorded traces
src/lib/       the component library (registered in `registry` via define())
  transistors.ts NMOS, PMOS, rails, CMOS inverter/NOR, NAND (prim + 4-transistor netlist), tie cells
  gates.ts       NOT, AND, OR, NOR, XOR, XNOR, MUX2 from NAND
  combinational.ts adders (HA, FA 13- and 9-NAND, rca(n), addSub(n), incrementer(n)), andN,
                 decoder(n, en, pitch), busMux2(w), muxTree(k, w, pitch)
  sequential.ts  SR latch, D latch, DFF (master–slave), DFFE, register(n), counter(n)
  memory.ts      ram(k, w): decoder + registers + mux tree, user-scalable
  alu.ts         constWord, zext, wiring boxes, bitwise, orN, isZero, barrel shifter, alu(n)
  regfile.ts     regfile(k, w) with x0 = 0, two read ports fed by one bundled word bus
  cpu.ts         single-cycle RV32I: rom (preferBehavior), dataMemory, IMM_GEN, OPCODE_DECODER,
                 CONTROL, NEXT_PC, PLUS4(_FAST), singleCycleCpu(program, { adder })
  fastadd.ts     gp / gray / black prefix cells, CLA4, koggeStone(n), addSubFast(n)
  wide.ts        bitwise(op, n), orN(n) (shared by alu.ts and fastadd.ts to avoid an import cycle)
  pipeline.ts    equal, nonZero, clearableRegister, pipeline registers (fields on fixed rows),
                 hazardUnit(lookAhead), BRANCH_CMP, BTB (16 × 62-bit), SAT_COUNTER, MISPREDICT,
                 pipelinedCpu(program, { adder, balanced, predictor })
  lsu.ts         STORE_ALIGN, LOAD_EXTRACT, bankedMemory(k) (byte / halfword access)
  system.ts      SYS_DECODE (illegal-instruction detection), CSR_UNIT, TRAP_UNIT, IO_UNIT,
                 systemCpu(program, { m }): the complete RV32I(M) + Zicsr + M-mode traps / interrupts + MMIO;
                 with m the CPU gains a `retire` output (low while a divide stalls it)
  cells.ts       NMOS_STRONG / PMOS_WEAK, SRAM_CELL (6T), SRAM_COLUMN, DRAM_CELL (switch level)
  cache.ts       cachedMemory(k, ib) (direct-mapped write-through cache + main memory, stall on
                 miss), wayLookup2; singleCycleCpu(…, { dcache }) uses it (adds `retire`, `dhit`)
  multicycle.ts  MC_STATES (the state table), MC_FSM (hardwired), MC_MICRO (microcode), microword(),
                 multicycleCpu(program, { control: 'fsm' | 'micro' }) with `retire`, `fetch`, `state` outputs
  fpu.ts         parametric IEEE 754 units (format {E, M}): lzc, shiftLeft, shiftRightSticky, fpUnpack,
                 normRound (shared RNE rounding), fpAdd, fpMul, fpFromInt, fpCompare, FPU32, FP_DECODE;
                 singleCycleCpu(…, { fpu }) adds the f register file (regfile(5, 32, false))
  mpdecode.ts    MP_DECODE (atomics, csrr mhartid), ARBITER2 (round-robin)
  multicore.ts   dualCore(program): two singleCycleCpu(…, { shared }) cores + arbiter + shared memory
  muldiv.ts      ppRow, arrayMul(n), compressor()/csa(n) (3:2 rows with word offsets), treeMul(n, signed,
                 outW) (Wallace + KS), MUL32, BOOTH_ENC, divStep, arrayDiv, seqDivider(n), condNegate, MDU
src/riscv/     isa.ts (tables, decode, disasm, CSR names), asm.ts (two-pass assembler, CSR
               instructions), iss.ts (golden model; `system: true` adds MMIO, CSRs, traps,
               interrupts; `m: true` makes M legal in system mode, divides advance mtime by 34), programs.ts / sysprograms.ts / mprograms.ts / cprograms.ts / fprograms.ts (samples), multi.ts (MultiISS: N harts, shared memory, same arbitration), mcprograms.ts, cosim.ts (CPU state;
               `retiring()` = step the ISS this cycle?)
src/view/      SVG schematic renderer (route.ts: orthogonal routing + hops over crossings),
               inspector (info, truth table, Verilog + download), analyzer.ts (the Timing panel:
               lanes from onTrace, cursors, VCD), stage.ts (probe mode, clock period, slow-motion
               fronts)
src/widgets/   bespoke explainers (MOSFET cross-section, number explorer, memory grid, ...);
               insthw.ts maps an instruction to the units it uses (and pipeline stage units)
src/chapters/  narrative content: chapters → steps → scene / widget / challenge
src/ui/        app shell, router, theme, settings, progress
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
3. **Bit-level nets.** Buses are bundles of 1-bit flat nets. Splitters and mergers are
   `prim: 'alias'`: pure wiring, merged by union-find in the flattener, with zero cost.
4. **Mixed-level simulation.** `preferBehavior: true` keeps a component (the instruction ROM) as a
   behavioural leaf; opening it starts a lock-step sub-simulation of its structure. The
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
- Layout in grid units (1 unit = 10 px). Port positions come from `geometry.ts`; check
  them there before placing instances. Gate shapes: inputs at y = 1, 3 (+top), output at
  mid-height, width 4. Box pins are spaced `symbol.pitch` (default 2). Use splitter and
  merger `pitch` and box `pitch` to line rows up so wires stay straight; use `trunk` (x of
  the vertical trunk for horizontal drivers, y for vertical ones) and `via` (corner points)
  to untangle feedback paths.
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

### Viewing aids (all derived, none stored in the netlists)

- Wire palettes: `data-palette` on `<html>` (styles/palettes.css, `light-dark()` tokens). Use
  `--w0 --w1 --wx --wz --bus --bus1` and the shape tokens (`--wire-w0` …), never raw colours.
  Probe colours are `--probe-0..7` (class `p0..p7` sets `--pc`).
- Hops, tap bit ranges, net selection and probe flags are computed in the view from the
  routed nets; nothing to author. Slow motion draws each change as a front over one gate
  delay (`SchematicView.flowMs`); the simulation's timing is unchanged.
- The Timing panel only records nets of the scene's own simulation (`ctx.sim === stage.sim`);
  sub-simulations (an opened NAND, the ROM) cannot be probed. `Scene.analyzer` opens it.

### Writing chapters

A chapter is a list of steps. Each step has narrative HTML and either a `scene` (a root
component, initial inputs, optional drill path, highlights, probes) or a `widget`, plus an
optional `challenge`. Keep the prose short, concrete and honest. Introduce a component
as a black box only after its inside has been shown. Say what each thing *costs*.

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
- **Merge with `--no-ff`** so every feature stays a visible merge commit:
  `git checkout main && git pull && git merge --no-ff <branch>`, then push `main`.
- **Never delete branches on GitHub (`origin`).** They are kept as history. Deleting the
  local copy after a successful merge and push is fine.
- Never force-push `main`, never rewrite its history, never skip hooks (`--no-verify`).

## Testing expectations

- `npm test` and `npm run typecheck` must pass before committing.
- New component → spec or behaviour test. New simulator feature → unit test.
- Visual changes: run `npm run dev` and look at it, in both light and dark themes.
