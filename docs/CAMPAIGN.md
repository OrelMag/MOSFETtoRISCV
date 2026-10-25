# Campaign mode — plan and status

The campaign (`#/campaign`) is a guided path through the site's material. It is a tree of levels.
In each level you build one component from the ones before it, starting with a NAND made of
transistors. The last required level is a pipelined, interrupt-capable 16-bit RISC-V-like
processor. Each level comes with:

- why the component is needed, meaning where it sits in the CPU
- tips that build up step by step, and entries in a codex that unlocks as you go
- a complete test set, which is the level's success criterion
- a grade based on how well the design is optimized
- a reference solution

You may skip any level, and then our solution stands in for yours.

The chapters stay open and unordered. The soft locks apply only in the campaign, and
**Unlock all** removes them.

Status legend: ✅ done · 🚧 in progress · ⏳ planned

---

## 1. Requirements (from the feature request) → where they are met

| # | Requirement | Where | Status |
|---|---|---|---|
| R1 | Campaign mode: build a NAND from transistors, then build up to a CPU | Acts 0–7 (§5) | ✅ |
| R2 | A pipelined CPU "with all the goodies": hazards, forwarding, flushes, interrupts, traps | Acts 6–7 | ✅ |
| R3 | The campaign is a **tree**; each node is a component built on its predecessors | `src/campaign/nodes.ts` (`requires`), map page | ✅ |
| R4 | Number systems | drills `n_bin`, `n_twos`, `n_float` (binary16) | ✅ |
| R5 | Assembly | Act 4 (ISA lesson, encode drill, 7 program puzzles with an editor and a stepper); `p_handler` in Act 7 | ✅ |
| R6 | Tips and tricks (Boolean logic, …) | per-node progressive `tips`, codex "trick" entries, `l_bool` (lesson + drill), K-map drill | ✅ |
| R7 | A complete test set per level (success criteria shown before you start) | `BuildChallenge.check` / puzzle tests / core harness; node panel lists them | ✅ |
| R8 | Simplified 16-bit CPU similar to RISC-V | RV16 (§3): ISA, assembler, golden model, single-cycle, pipelined and trap-capable cores | ✅ |
| R9 | Guidance and complete solutions | tips + "Show solution" / "Do it for me"; every node has a reference answer | ✅ |
| R10 | Skipping a level is allowed, and our solution is used | **Skip** marks it skipped and unlocks its part | ✅ |
| R11 | Grade solutions on optimization | `grade.ts`: ★ / ★★ / ★★★ against par on NAND, depth, period, cycles, size | ✅ |
| R12 | Optional levels: multiply, divide, fast adders, FPU | ✅ fast adders, faster core, multipliers, divider, binary16 ladder (unpack, rounding decision, sticky shifter, leading-zero counter, normalize & round) to the adder / multiplier, comparator, int → float, MD in the core (multiply, stalling divide), cache, multicycle core, branch prediction | ✅ |
| R13 | A narrative (nand2tetris / *Code* / Turing Complete) explaining why each block is built | per-node `why`, act intros, the intro's anatomy diagram | ✅ |
| R14 | Each level explains why it is needed | `why` field, shown first in the node panel | ✅ |
| R15 | Codex for each element discovered, plus laws and tools (K-maps, SoP, De Morgan) | `src/campaign/codex*`, `#/campaign/codex` | ✅ |
| R16 | Start with an introduction to what a CPU looks like and why, shown schematically | `intro` node: anatomy block diagram; built blocks light up | ✅ |
| R17 | Export and import designs | campaign export (progress + chips) as well as the sandbox's own export / import | ✅ |
| R18 | Save the plan as Markdown in the repo and track each item | this file | ✅ |
| R19 | Suggest more | §8 | ✅ |
| R20 | "Unlock all" | a toggle on the map, stored in campaign progress | ✅ |

---

## 2. Design

### Levels are build challenges
A campaign build level is a `BuildChallenge` (`src/editor/challenges.ts`). It is played on its own
level screen (`#/campaign/play/<node>`; the same chip also opens in the sandbox) like the 21 existing
challenges: Start creates `u_ch_<id>` with its pins, and Check runs the tests. The engine gains the following:

- **`Allowed = { lib: globs }`**: NAND, wiring, constants, displays and any of your own chips, plus
  the library parts unlocked by the level's *requirements* (the transitive closure of `requires`,
  never your progress). There are no transistors after Act 0, so every later check runs at gate
  level and can use the bit-parallel simulator.
- **Directed vectors** for table checks (0, 0xFFFF, 0x8000, shift by 15, …) on top of the random
  vectors used beyond 16 input bits.
- **`model` checks**: a sequential part (register file, pipeline register, CSR file) driven with
  random input streams and compared every cycle with a JS model.
- **`core` checks**: a whole CPU core run against the golden model (§4).

- **Constants and wiring** (constants, zero-extension, fan-out, bit reversal) are always allowed: they cost
  nothing. A level may **give** extra parts for itself only (the fast adder's prefix cells).
- **Drills** (`src/campaign/drills.ts`): generated questions with exact checkers (numbers in any base,
  a Boolean expression parser, an exact minimum-cover K-map solver with don't-cares). A drill passes
  after its goal of correct answers; ★★★ with at most 2 mistakes (a shown answer counts as one).
  The K-map shades the cells the typed expression covers as you type.
- **Clocked levels** are long deterministic sequences from a JS model (50–110 cycles: random data,
  enables, resets, writes to x0), graded on NANDs and clock period.

### Unlocks (Turing Complete style)
When you solve or skip a level, its component appears in the palette's **Unlocked parts** group as
a library part. The library part is the same circuit as the reference solution, it opens down to
NANDs, and it keeps working after a reload. Your own chips stay usable everywhere.

### Reference solutions from one description
The campaign's hardware is defined once as hierarchical library components (`src/lib/rv16/`). Each
netlist uses only NAND, wiring, and parts unlocked by earlier levels. The level's answer is that
component turned into a sandbox chip (`docFromDef`). The 21 existing hand-drawn answers are kept.
An **integrity test** checks every node: the answer compiles, passes its own test set with no
restriction violation, and meets par. This proves the whole chain from a transistor NAND to the
pipelined CPU.

### Grading
Each level has a **par** per metric:

| Level kind | Metrics |
|---|---|
| Transistor levels | transistors |
| Combinational | NANDs, depth (NAND delays) |
| Sequential | NANDs, clock period (static timing) |
| CPU cores | NANDs, period, cycles; time = period × Σ cycles |
| Program puzzles | size (words), cycles |
| Kernel puzzles (act 9) | cycles (warp instructions), idle lanes (%) |
| Memory controllers (act 10) | NANDs, period, cycles over the request traces |
| Relay levels (act P) | relays, relay steps (the most steps one input change takes to rest) |
| Tube levels (act P) | tube sections (triodes + diodes) |

- ★ passes
- ★★ every metric ≤ 1.5 × par
- ★★★ every metric ≤ par

The best result is kept. Par is a target and is never required.

### Progress, skip, unlock all, export / import
- Progress is kept in local storage under `mosfet2riscv:campaign:v1`. It holds each node's status
  (locked / available / started / solved / skipped), best score, stars, chip id and puzzle source,
  plus the Unlock all flag and whether the intro has been seen.
- A node is **available** once every required node is solved or skipped. Optional nodes never
  block required ones.
- **Skip** marks a node skipped. Its part and codex entries unlock, and nothing is imported unless
  you ask for the solution.
- **Export** writes `{ format: 'mosfet2riscv-campaign', schema, progress, chips }`, where chips is
  the closure of your level chips.
- **Import** merges what it reads. Stars take the maximum, chips are imported without overwriting,
  and renamed ids are remapped.
- "Reset progress" on the home page clears the campaign too.

---

## 3. RV16: the campaign's processor

- 16-bit data and 16-bit instructions.
- 8 registers: x0 = 0, x1 ra, x2 sp, x3 a0, x4 a1, x5 a2, x6 t0, x7 t1.
- **Word addressed** and Harvard: instruction ROM and data memory are separate, and the PC
  advances by 1.
- Every field has a fixed position, so decoding is little more than wiring.

| bits | 15:13 | 12:10 | 9:7 | 6:4 | 3:0 |
|---|---|---|---|---|---|
| R / SYS | f3 | rs2 (csr) | rs1 | rd | op |
| I | imm[5:0] = instr[15:10] | | rs1 | rd | op |
| S / B | imm[5:3] | rs2 | rs1 | imm[2:0] | op |
| J | imm9 = instr[15:7] | | | rd | op |
| U | imm10 = {instr[15:7], instr[3]} | | | rd | op |

| op | name | fmt | semantics |
|---|---|---|---|
| 0000 | SYSTEM | SYS | f3 = 0, by rs2 field: 000 **illegal** (an all-zero word traps), 001 ecall, 010 ebreak, 011 mret, 100 wfi. f3 = 1/2/3: csrrw / csrrs / csrrc rd, csr, rs1. f3 = 4/5/6/7: split rs1, join, tmc rs1, bar on the lane cores (act 9), illegal on every scalar core |
| 0001 | OP | R | f3: add, sll, slt, sltu, xor, srl, or, and (RISC-V funct3 order) |
| 0010 | OPX | R | f3 = 0 sub, f3 = 5 sra; other f3 values are illegal |
| 0011 | MD | R | mul, mulh, mulhsu, mulhu, div, divu, rem, remu (optional M; illegal without it) |
| 0100 | ADDI | I | rd = rs1 + sext(imm6) |
| 0101 | SHI | I | imm[5:4]: 00 slli, 01 srli, 10 srai (11 illegal); shamt = imm[3:0] |
| 0110 | LW | I | rd = M[rs1 + sext(imm6)] |
| x111 | LUI | U | rd = imm10 << 6 (op[3] is imm bit 0) |
| 10cc | BEQ / BNE / BLT / BGE | B | cc: 00 eq, 01 ne, 10 lt, 11 ge (op[0] inverts); target pc + sext(imm6) |
| 1100 | JAL | J | rd = pc + 1; pc += sext(imm9) |
| 1101 | JALR | I | rd = pc + 1; pc = rs1 + sext(imm6) |
| 1110 | SW | S | M[rs1 + sext(imm6)] = rs2 |

- **ALU control** is `{op == OPX, f3}`: 4 bits for 10 operations. SHI reuses the shift codes.
- **What is left out**, and the pseudo-instructions that replace it: andi / ori / xori, sltiu,
  bltu / bgeu (`sltu` + `bnez`), auipc, byte and halfword accesses.
- **Fixed words**: `nop` = `addi x0, x0, 0` = 0x0004; `halt` = `jal x0, 0` (a jump to itself) =
  0x000C. Only `jal` to itself halts the golden model: a branch to itself is a spin (waiting for an
  interrupt).
- **Pseudo-instructions**:
  - `li` (1 word when it fits; otherwise lui + addi with %hi / %lo rounding)
  - `mv`, `not`, `neg`, `seqz`, `snez`, `sltz`, `sgtz`
  - `j`, `jr`, `call`, `ret`, `tail`
  - `beqz`, `bnez`, `bltz`, `bgez`, `blez`, `bgtz`, `bgt`, `ble`
  - `csrr`, `csrw`, `csrs`, `csrc`
  - `push`, `pop`, `halt`, `exit`
  - directives `.word`, `.data`, `.text`
- **CSRs** (3-bit index): 0 mstatus (MIE bit 3, MPIE bit 7), 1 mie (MEIE bit 11), 2 mip,
  3 mtvec, 4 mepc, 5 mcause (bit 15 = interrupt), 6 mscratch; 7 has no register (reads 0, ignores
  writes). No cycle counter: one would count cycles in the hardware and instructions in the golden model. On a lane
  core CSR 7 is `tid`, the thread number (warp · 4 + lane): a scalar core is a one-lane warp.
- **MMIO**: the top of data memory, reachable as `imm(x0)` with a negative imm.

  | Address | Register | Notes |
  |---|---|---|
  | 0xFFFF | EXIT | |
  | 0xFFFE | CONSOLE | |
  | 0xFFFD | OUT | number stream |
  | 0xFFFC | IN | golden model only |
  | 0xFFFB | LEDS | |
  | 0xFFFA | SWITCHES | |
  | 0xFFF9 | IRQ | software-raised external interrupt |
  | 0xFFF7–0xFFF8 | reserved | read 0, stores dropped (no timer: the cores take only the external line) |

Software lives in `src/riscv/rv16/`: `isa16` (tables, encode, decode, disasm), `asm16` (with
`.data` sections: data labels are data-memory addresses), `iss16` (the golden model: every step
reports its register write, store or trap; `strictInit` flags reads of unwritten registers), `simt16` (the lane
  cores' golden model: four Iss16 lanes over one memory, the active mask, the leader, the split / join stack). The code
editor highlights RV16 (`rv16asm`) from the same tables. ✅ A random-program generator for fuzzing
(`randprog.ts`: every core level runs seeded random programs, with MD instructions for the side quests).

**Program puzzles** (`src/campaign/puzzles.ts`): each test gives IN words, data memory, switches or
interrupt times and expects OUT words, console text or memory. Graded on size (words) and cycles
(mean instructions over the tests). In the level panel: an editor (source saved as typed), Run the
tests, and a stepper over one test (registers, current line, outputs).

---

## 4. Checking a CPU core

A core level asks for a chip with fixed pins:

- **in**: `clk rst instr[16] drdata[16] (irq)`
- **out**: `pc[16] daddr[16] dwdata[16] dwe rwe rwa[3] rwd[16]`

Early stages need only the pins they use. Memory is **served by the test harness**, so it is
neither part of the design nor of its score. Each cycle the harness:

1. settles the circuit, serves `instr = imem[pc]` and `drdata = dmem[daddr]`, and repeats until
   nothing changes (a loop through memory is reported);
2. samples the store port and the register-write port;
3. applies a rising clock edge and then a falling one.

**The test set** (`src/campaign/coretests.ts`): directed programs (ALU edge cases, memory, a table,
every branch condition, calls with a stack, gcd) plus seeded random programs
(`src/riscv/rv16/randprog.ts`: registers initialised first, loads / stores in words 0–31, forward
branches only): 15 programs for Core I, 19 for Core II, 28 for Core III. They run side by side as
lanes of the bit-parallel simulator (the event-driven one when the circuit has behavioural leaves).
The clock period is measured on a bench with 8-delay instruction and data memories, so the path
PC → memory → decode → … → register counts. The core levels share one pin set, so one chip can grow
from Core I to Core III.

- **Pipelines** report register writes from W and stores from M; the same comparison works because a
correct pipeline makes the same writes in the same order, only later. Interrupt tests are written so
that nothing in main depends on exactly which instruction the interrupt lands on (main spins until the
handler has run).

**Pass**: the register-write trace and the store trace are equal to the golden model's, the
  final data memory is equal, and the core finishes within the cycle budget.
- **A failure names**: the test, the write number, the instruction (disassembled) and the cycle.
- **Interrupt tests** are software-raised and independent of where exactly the core takes the
  interrupt, so a pipelined core and the golden model agree.

---

## 5. The tree

Legend: `id` ← requires · *opt* optional · (ex) an existing sandbox challenge.

✅ playable · ⏳ on the map as "coming soon" (it can be skipped so that what follows opens).

### Act 0 — Prologue: what are we building?
- ✅ `intro`: anatomy of a CPU. The block diagram, the fetch–decode–execute loop, and why each block
  exists.
- ✅ `t_inv` (ex) ← intro
- ✅ `t_nand` (ex) ← t_inv
- ✅ *opt* `t_nor` (ex) ← t_inv

### Act P — Before the transistor (roadmap Phase 14e)
Optional as a whole, beside act 0 (it needs only `intro`); act number 11 with the label "Act P", listed right after act 0
(approved with the Phase 14 mockup, recommendation 9, 2026-10-16). Builds are at switch level under a **strict rule**
(`LibRule.strict`: only the listed parts, switch-level ones included, no MOSFET and no NAND): relays (1 to 6 poles), VDD,
GND and pull-down loads; or triodes, vacuum diodes, plate / divider / bias resistors, B+, −150 V and GND. References are
prologue P1 / P2's library circuits (`src/lib/relays.ts`, `tubes.ts`) drawn as chips (`src/campaign/buildr.ts`). The
level screen prices the CMOS alternatives in the same metrics through the technology setting (`measure.ts libCost`).
On the map it is folded to its header line (like acts 8–10) until one of its levels is opened, so act 1 stays near the top;
Show / Hide is remembered per act (`layout.ts foldedActs`, `settings.actOpen`).
- ✅ drill `r_pull`: pull-in and drop-out, read off the relay model's curves ← intro. Ten kinds from phys/relay.ts
  (pull-in / drop-out / hysteresis on the pull-against-spring chart, also for relay variants; operated or released at
  V; first touch, rest, bounces and release off a run chart; coil power; the turn-off spike), units parsed (parseQty)
- ✅ `r_nand`: two break contacts in parallel from VDD, a load on y ← r_pull. 2 relays, 1 step
- ✅ `r_xor`: changeover XOR ← r_nand. 2 relays, 1 step (NAND-mapped: 4 relays, 3 steps)
- ✅ `r_adder`: 4-bit adder, the carry through contacts on two lines ← r_xor. 8 relays (a 5-pole and a 4-pole per
  bit), 1 step; the reference's full adder is a chip of its own
- ✅ `r_latch`: self-holding relay ← r_nand. 3 relays (the mockup's 1 assumed set and reset were contacts; a pin always
  drives its line, so each operates a relay of its own)
- ✅ `r_clock`: the buzzer and a ÷2 ← r_latch. A custom bench steps relays (16 with en = 1: y changes every step, q every
  second; then en = 0: both rest, q holds; then restart). 2 relays (`relay_clock`: the buzzer's second pole feeds the
  divider's coil from its own break or make contact; the mockup's 3 counted an en relay the pin makes unnecessary)
- ✅ `v_inv`: two tube inverters in a row (na = ¬a, y = a) ← intro. 2 tube sections. A rule beyond the parts
  (`BuildChallenge.rules`: `gridProblems`): every triode grid is read through a divider (never wired straight to a plate,
  an input or B+, and biased to −150 V), since the simulator's logic levels alone would accept a plate on a grid
- ✅ `v_ff`: Eccles–Jordan, set / reset through steering diodes ← v_inv. 4 tube sections (2 triodes, 2 diodes; the
  mockup said "2 triodes")
- ✅ drill `h_card`: Hollerith code both ways, a short source card, object cards (row 9 → value, value → columns,
  column 1 the most significant bit) ← intro
- ✅ `h_loader`: program on cards ← h_card, r_clock. Given: a card reader (23 object cards, feed 3 edges), a 256 × 16
  RAM and the 4-bit CPU without its ROM (`cpu4_proc`: instr in, pc out). The learner builds the loader (address counter,
  a write per card, run once the hopper is empty, the RAM's address from the counter or the pc, the CPU's clock gated by
  run) from a strict rule of NAND, NOT, AND, OR, DFF, an 8-bit counter, a 2:1 8-bit mux. The bench (GateSim) runs two
  decks (the reader's and MULTIPLY4, poked into the hopper with the feed forced to 3): run low while cards are left, the
  RAM equal to the deck when it rises, the outputs at halt equal to Iss4's. Graded in relays (lib/tech.ts price of the
  learner's logic, CPU / RAM / reader left out) and cycles to load over both decks: 233 relays, 182 cycles. A loader
  that feeds the CPU NOPs and uses its pc as the address counter beats par by far (allowed)

### Act 1 — Logic
- ✅ `l_bool`: Boolean algebra (identities, De Morgan, bubble pushing), lesson + simplification drill ← intro
- ✅ `g_not` (ex) ← t_nand
- ✅ `g_and` (ex) ← g_not
- ✅ `g_or` (ex) ← g_not
- ✅ `g_xor` (ex) ← g_and, g_or
- ✅ `g_mux` (ex) ← g_not
- ✅ `d_kmap`: K-map drill ← l_bool
- ✅ `g_sop`: a prime detector from its truth table via SoP / K-map, graded on NANDs ← d_kmap, g_and, g_or
- ✅ `g_wide`: 16-bit OR / zero detect as a tree, graded on depth ← g_and, g_or
- ✅ `g_dec`: 3→8 decoder ← g_wide
- ✅ `g_mux8`: 2:1 × 16 bus mux (unlocks the wider muxes) ← g_mux
- ✅ `g_eq16`: 16-bit equality ← g_xor, g_wide

### Act 2 — Numbers and arithmetic
- ✅ `n_bin`: binary and hex drill ← intro
- ✅ `n_twos`: two's complement, overflow drill ← n_bin
- ✅ `a_ha` (ex) ← g_xor, n_bin
- ✅ `a_fa` (ex) ← a_ha
- ✅ `a_add4` (ex) ← a_fa
- ✅ `a_add16` ← a_add4
- ✅ `a_inc16` ← a_ha
- ✅ `a_addsub16` ← a_add16, n_twos
- ✅ `a_slt` ← a_addsub16
- ✅ `a_shift16`: barrel shifter ← g_mux8, g_and
- ✅ `a_alu16` ← a_addsub16, a_slt, a_shift16, g_wide
- ✅ *opt* `o_fastadd`: parallel-prefix adder, graded on depth (the g / p cells are given) ← a_add16

### Act 3 — State and memory
- ✅ `s_sr` (ex) ← g_not
- ✅ `s_dlatch` (ex) ← s_sr
- ✅ `s_dff` (ex) ← s_dlatch
- ✅ `s_reg4` (ex) ← s_dff, g_mux
- ✅ `s_reg16` ← s_reg4
- ✅ *opt* `s_cnt4` (ex) ← s_reg4
- ✅ `s_pc`: program counter with reset and load ← s_reg16, a_inc16, g_mux8
- ✅ *opt* `s_fsm`: a "101" detector (Mealy machine) from its state table ← s_dff, d_kmap
- ✅ *opt* `m_ram` (ex) ← s_reg4, g_dec
- ✅ `m_rf`: 8 × 16 register file, x0 = 0, model check ← s_reg16, g_dec, g_mux8
- ✅ `m_mem`: ROM and RAM lesson (unlocks the memory parts) ← m_rf

### Act 4 — The instruction set and assembly
- ✅ `i_isa`: the RV16 instruction set (lesson + explorer) ← n_twos
- ✅ `i_enc`: encode / decode drill ← i_isa
- ✅ `p_add` ← i_isa
- ✅ `p_loop` ← p_add
- ✅ `p_mem` ← p_loop
- ✅ `p_call` ← p_mem
- ✅ `p_mul`: multiply in software ← p_loop
- ✅ *opt* `p_sort` ← p_mem
- ✅ *opt* `p_print`: print a number in decimal ← p_mul

### Act 5 — A single-cycle CPU
- ✅ `c_lesson`: the datapath ← i_isa, a_alu16, m_rf
- ✅ `c_imm`: immediate generator ← i_isa, g_mux8
- ✅ `c_ctl`: decoder / control unit (checked with don't-cares) ← i_enc, g_dec, d_kmap
- ✅ `c_br`: branch comparator ← g_eq16, a_slt, g_mux
- ✅ `c_npc`: next-PC logic ← a_add16, a_inc16, c_br, g_mux8
- ✅ `c_core1`: OP / OPX / ADDI / SHI / LUI ← c_lesson, c_imm, c_ctl, s_pc, m_rf, a_alu16
- ✅ `c_core2`: + LW / SW ← c_core1, m_mem
- ✅ `c_core3`: all of RV16I ← c_core2, c_npc
- ✅ `c_computer`: core + ROM + RAM + LED register with partial address decoding, checked cycle by cycle; then load your own RV16 program ← c_core3, p_loop
- ✅ *opt* `c_fast`: graded on clock period ← c_core3, o_fastadd

### Act 6 — Pipelining
- ✅ `pi_lesson` ← c_core3
- ✅ `pi_reg`: pipeline register with stall / flush ← s_reg16, g_mux8, g_or
- ✅ `pi_core0`: 5 stages, programs without hazards ← pi_lesson, pi_reg
- ✅ `pi_fwd`: forwarding unit ← g_eq16, pi_lesson
- ✅ `pi_core1`: + forwarding ← pi_core0, pi_fwd
- ✅ `pi_haz`: load-use hazard detection ← g_eq16, pi_lesson
- ✅ `pi_core2`: + load-use stall ← pi_core1, pi_haz
- ✅ `pi_core3`: + branch / jump flush ← pi_core2
- ✅ *opt* `o_bpred`: static branch prediction in F (jal and backward branches taken), graded on cycles over loop programs ← pi_core3

### Act 7 — The system: traps and interrupts
- ✅ `y_lesson` ← c_core3
- ✅ `y_csr`: CSR file (a long random sequence against a model) ← s_reg16, g_dec, g_mux8, y_lesson
- ✅ `y_trap`: CSR instructions, ecall / ebreak / illegal, mret (the illegal-instruction detector and the system decoder are given) ← c_core3, y_csr
- ✅ `y_irq`: interrupts ← y_trap
- ✅ `p_handler`: an interrupt-driven program ← y_lesson, p_call
- ✅ **`y_final`**: the pipelined RV16 with precise traps and interrupts ← pi_core3, y_irq

### Act 9 — Throughput: a GPU (roadmap Phase 15)
Optional as a whole (decided 2026-10-13): it goes past the campaign's goal, a pipelined RV16, like the side quests, and
adding levels to it never reopens a finished campaign. Its finale (finalCpu of the act 9 track) is still its last core.
- ✅ `k_lesson`: latency or throughput ← y_final
- ✅ `k_lanes`: four ALUs and their operand muxes, one control (a table on random and directed vectors) ← k_lesson
- ✅ `k_vrf`: four register files, one write enable per lane ← k_lesson
- ✅ `k_mask`: the active mask (all on at reset), the leader, the masked write enables ← k_lesson
- ✅ `k_simd`: the 4-lane SIMD core: tid, tmc, branches by the leader (the lane decoder is given) ← k_lanes, k_vrf, k_mask
- ✅ `k_stack`: the reconvergence stack (four entries; a sequence against `StackModel`) ← k_simd
- ✅ `k_simt`: the SIMT core: split / join ← k_simd, k_stack
- ✅ kernel puzzles `p_saxpy` ← k_simd and `p_reduce` ← k_simt, on the lane golden model, graded on cycles and idle
  lanes (100 % − lane utilization)
- ✅ `k_coal`: the coalescer: the leader's line (address bits 15 … 2), the lanes served, the lanes left (a table) ← k_simd
- ✅ `k_warps`: two warps taking turns every cycle over a data memory one cycle late; a second register write port for
  the returning loads; `bar` ← k_simt, k_coal
- ✅ kernel puzzle `p_hist` ← k_warps: 16 bins, 8 threads on two warps, no atomics (private counters, a bar, a combine);
  each test also runs with warp 1 ahead, so a kernel missing its bar fails
- ✅ `k_edge` ← k_simd: one edge function stepped with one adder (E and the band start R; load, right, skip, down, up,
  band, double), 963 NANDs; a sequence against `Edge16`
- ✅ `k_tile` ← k_edge: the tile walk over 4 × 4 tiles in bands, a TEST cycle per tile, a column serpentine, the
  steppers' commands, 479 NANDs; a sequence against `Walk16`
- ✅ `k_raster` ← k_tile: set-up by adders (A, B, the top-left bias, the box in tiles, the tile offsets), each E at the
  first tile by shift-and-add on its own stepper (17 cycles, no multiplier), the cull from the sum of the three E, the
  tile test; 9 188 NANDs, period 145. Its bench (`rastercheck.ts`) runs 64 triangles and compares every pixel write in
  the walk's order; the set-up's length is the learner's, graded as cycles (7 439 for the reference)
- ✅ `k_frame` ← k_raster, k_warps: the two-warp core with the rasterizer as a device (lane 0's stores to 0xFFF0 … 0xFFF6,
  the screen at 0xF000 + 32·y + x, RGB565), a warp's turn held while the rasterizer is busy if it would store to it or
  load from the screen; 41 250 NANDs, period 147. The two-warp bench with `raster`: the golden model (`Warps16` with
  `raster`) draws at once, the core's pixel writes must match it in order
- ✅ program puzzle `p_spin` ← k_frame: a square turned by Minsky's rule in 8.8 fixed point, cleared and drawn as two
  triangles each frame, on two warps (reference: 1 432 cycles, 8 % idle lanes; it also runs on the frame core's bench)
- ✅ A lane core's program (`k_simd`, `k_simt`, `k_warps`, `k_frame`) opens on a sandbox bench chip like the scalar
  cores' (`addLaneBench`): the core held in reset for its first cycle, a data memory with a port per lane (words
  0x000–0x3FF), each read a cycle late for the warp cores, and for `k_frame` the screen memory at 0xF000 (a fifth port for
  the rasterizer's writes) and a 32 × 32 screen. The CPU drawer checks it live against `Simt16` / `Warps16` as the level's
  bench does (editor/lanemon.ts); every program of the four levels runs to its end on the reference cores
  (tests/editor-lanebench.test.ts)

The lane cores' bench (`lanecheck.ts`) is the core bench with a memory port and a register write port per lane
(`daddr<i>`, `dwdata<i>`, `drdata<i>`, `dwe` bit i; `rwe` bit i, `rwd<i>`, a shared `rwa`): each lane's
writes and stores are compared in order with the lane golden model; stores of one cycle land lowest lane first.
The two-warp bench (`warpcheck.ts`) serves `drdata<i>` from the address of the cycle before (each lane's memory reads
at the clock edge, before that edge's stores) and adds `warp` and a load write port (`lwe`, `lwa`, `lwd<i>`): issue-port
writes and stores belong to the warp issuing now, load-port writes to the warp that issued the cycle before; each
thread's events are compared in order with `Warps16` (riscv/rv16/warps16.ts: the warps taking turns, warp 0 first).

### Act 10 — Memory (roadmap Phase 16e)
Optional as a whole, after `y_final`, like act 9 (decided 2026-10-16 with the Phase 16 mockup; details 2026-10-17).
The devices a level drives are on its bench (`memcheck.ts`), JS models that know their rules and name the first one
broken, rather than given parts that read X. References: `src/lib/rv16/mem16.ts`, from campaign parts only.
- ✅ `m_lesson`: where the cycles go (DRAM cells, the row buffer, refresh) ← y_final
- ✅ `m_sense`: a DRAM column of two cells at switch level ← m_lesson. Given: the cells, a bit line capacitance part
  (`blcap`, 100 fF: a sandbox wire has no capacitance value), the sense amplifier, VDD/2, the write driver; the
  learner adds precharge and equalize and wires the twin lines. The amplifier stays a primitive: SwitchSim reads a
  gate between its thresholds as X, so a cross-coupled pair drawn from MOSFETs cannot resolve 50 mV (the mockup's
  "from transistors" was changed for this). A sequence of chapter 34's protocol, every read twice (the restore);
  34 transistors
- ✅ `m_bank`: requests in, commands to a 16 × 16 word array on the bench out (ACT, RW, PRE; a read's word in the
  same cycle); rows leak unless opened every 288 cycles: RAS-only refresh by a row pointer and a timer ← m_sense.
  Eight request traces on BitSim lanes, each with its own array; 319 NANDs, period 30, 5 917 cycles
- ✅ `m_ctrl`: a two-bank DRAM chip on the bench (64 rows of 16 words per bank, chapter 35's command encoding):
  tRCD / tCAS / tRP 4, tRAS 9, tRFC 12, a REF at least every 256 cycles; one word per command, a write's data with
  its WR ← m_bank. 779 NANDs, period 36, 10 690 cycles
- ✅ `m_bus`: two masters, three slaves (0 below 0x8000, 1 from 0x8000 with 2 wait states, 2 from 0xC000 with 1),
  valid / ready on both sides, round robin with the grant held through a transfer ← m_lesson. A sequence from a
  model of the bus and the bench (`busSeq`), including a master asking while the other waits on the slow slave;
  282 NANDs, period 26
- ✅ `m_dma`: a bus master configured by writes (0 src, 1 dst, 2 len and start, 3 clear irq), a read then a write
  per word, irq and busy ← m_bus. Six memories on BitSim lanes (no wait states to six), five copies each (1, 16,
  37, 0 and 12 words, one across the end of memory): the copy, nothing else written, a request held until ready;
  1 366 NANDs, period 48, 2 079 cycles
- ✅ `m_flash`: eight logical pages over a flash chip on the bench (4 blocks of 4 one-word pages and a 4-bit spare
  area; a page programs once, a block erases whole; read / program / erase busy 2 / 6 / 20 cycles) ← m_lesson. The
  reference writes a log: a mapping table, the logical page number in the page's spare area, and a collector for the
  block after the head; five traces, each filling every page first and reading every page back at the end;
  1 049 NANDs, period 38, 7 844 cycles
- ✅ program puzzle `p_boot` ← m_dma, m_flash: RV16 keeps instructions apart from data, so what comes from flash is
  a table (the mockup's "copy itself and jump" cannot run there): sum n words from flash, where a load stalls 8
  cycles, with a DMA engine copying a word every 4 (iss16 `dma`: registers at 0xFFF0 … 0xFFF3, flash at 0x8000 …
  0xBFFF, the interrupt line when done). Reference: sum each word as soon as it has landed, 18 words, 253 cycles
  (waiting for the interrupt first: 316; loading from flash: 442)

### Act 8 — Side quests (all optional)
- ✅ `o_mulseq`: shift-and-add multiplier ← a_add16, s_reg16
- ✅ `o_mularr`: 8 × 8 array multiplier ← a_add16
- ✅ `o_mcore`: the MD opcode's multiplies in your core (a 16 × 16 array is given; signed high halves by correction) ← c_core3, o_mularr
- ✅ `o_div`: sequential divider ← a_addsub16, s_fsm
- ✅ `o_dcore`: div / divu / rem / remu, holding the PC until the iterative divider is done ← o_mcore, o_div
- ✅ `n_float`: floating-point drill (fp16: encode, decode, special values, rounding with guard / sticky bits) ← n_twos
- ✅ The binary16 adder's blocks, one rung each (buildfp.ts; each unlocks its library block, never given later):
  `o_fpunpack` (sign, exponent with subnormals as 1, significand with its hidden bit, zero / inf / NaN / sNaN) ← n_float;
  `o_fpround` (the rounding decision: up and toInf from lsb, G, S, sign and rm) ← n_float;
  `o_fpsticky` (13-bit right shifter with a sticky bit) ← n_float, a_shift16;
  `o_fplzc` (16-bit leading-zero counter, built recursively: its halves are chips) ← n_float;
  `o_fpnorm` (normalize & round: binary16 from a 15-bit significand, exponent and sticky bit, flags) ← o_fpround, o_fpsticky, o_fplzc
- ✅ `o_fpadd`, `o_fpmul`: binary16 adder and multiplier, all five rounding modes, from the rungs above (only generic parts and the 11 × 11 significand multiplier given) ← o_fpunpack, o_fpnorm / o_fpadd, o_mularr
- ✅ `o_fpcmp` (feq / flt / fle, unordered, signaling) ← o_fpunpack; `o_fpcvt` (16-bit integer → binary16) ← o_fpnorm
- ✅ `o_cache`: direct-mapped cache, 8 one-word lines, write-through; on a hit the bench serves junk for memory ← m_mem, g_eq16
- ✅ `o_mc`: multicycle CPU (one-hot FSM: F, E, M, W) ← c_core3, s_fsm

---

## 6. Codex

The codex (`#/campaign/codex`) collects what you discover. An entry unlocks when its level is
opened (lessons) or solved / skipped (components).

- ✅ **Components**: one entry per built block (cost, structure, where it is used).
- ✅ **Laws**: Boolean identities, De Morgan, absorption, consensus, duality, completeness.
- ✅ **Tools**: truth tables, SoP / PoS, K-maps (with don't-cares), Quine–McCluskey, bubble
  pushing, NAND–NAND.
- ✅ **Numbers**: positional notation, hex, two's complement, sign extension, overflow rules,
  floating point.
- ✅ **Timing**: depth, critical path, setup / hold, clock period.
- ✅ **Architecture**: ISA, encoding, calling convention, CPI and the iron law, hazards (RAW / WAR /
  WAW, structural, control), forwarding, stalls, flushes, precise traps.
- ✅ A component entry's live datasheet (pins, truth table, measured cost) from the library parts its levels unlock (`src/campaign/datasheet.ts`).

---

## 7. Implementation phases

Each phase lands as commits on the campaign branch, with tests, and updates this file.

- ✅ **0. Plan.** This document; the roadmap now says that soft locks exist in the campaign only.
- ✅ **A. Foundation.**
  - `src/campaign/` with types, graph, progress, grade, layout, anatomy and the codex.
  - In the engine: `Allowed { lib }`, the "Unlocked parts" palette group, and the sandbox strip
    showing campaign levels (stars, Back to campaign, Next level, tips).
  - The `#/campaign` page with intro, map, node panel, lessons, codex, Unlock all, and export /
    import.
  - The 21 existing challenges as nodes.
- ✅ **B. Logic and numbers.**
  - Drills (numbers, Boolean, K-map) and the K-map widget.
  - Directed vectors and `model` checks.
  - RV16 arithmetic and state blocks; Acts 1–3.
- ✅ **C. RV16 ISA.**
  - isa16, asm16, iss16 and the samples.
  - Highlighting in the code editor.
  - Program puzzles and their UI; Act 4.
- ✅ **D. Single-cycle.**
  - Measure simulation speed first and record it here.
  - Control blocks and the reference core; the core harness; Act 5.
- ✅ **H. RV16 in the sandbox.**
  - ✅ An RV16 ROM language (`lang: 'rv16'`: 16-bit words, word addressed; RV16 highlighting, listing
    and disassembly; conversion to and from hex; an RV16 sample program).
  - ✅ `c_computer`.
  - ✅ The CPU drawer for RV16 computers (`src/editor/cpu16.ts`): a chip with an RV16 ROM and a placed core
    (any part with the core pins) is checked like the core bench does, through the core's write port and
    store port in program order, so nothing inside the core needs a name and single-cycle, multicycle and
    pipelined cores all work. It shows the listing, the registers as the core wrote them, the next expected
    write and the first mismatch. (The RV32 drawer keeps its own monitor: it reads register files by name.)
  - ✅ **Debug this test in the sandbox** (`src/campaign/bench.ts`): a failing core level offers a button that
    builds the failing program into a computer around the learner's core (ROM, a 64-word RAM decoded on its
    low bits with the golden model wrapping the same way, LEDs, the IRQ line, the core held in reset for its first
    cycle as on the level's bench, so the multicycle core starts) and opens it with the drawer.
  - ✅ **Play Pong on your core**: a passing core level that runs all of RV16I (CoreSpec.rv16i: Core III, the fast
    core, Pipeline IV, branch prediction, the trap / interrupt / finale cores, multiply, divide, multicycle) offers Pong
    (`src/riscv/rv16/pong16.ts`) on the io bench: the debug bench plus a 32 × 32 RGB565 screen at 0xF000 + 32·y + x,
    eight switches at 0xFFFA (7 / 6 your paddle). Examples ▸
    RV16: Pong on the campaign core runs it on the reference single-cycle core.
  - ✅ **Start from your previous core** on the campaign page: a core level can begin as a copy of the
    nearest earlier core level's chip, with the new level's pins added.
- ✅ **E. Pipeline.** Pipeline blocks and the reference pipelined cores; Act 6.
- ✅ **F. System.** CSRs, traps and interrupts in the golden model, the harness and the
  hardware; Act 7 and the finale.
- ✅ **G. Side quests.** Shift-and-add and array multipliers, the divider, the binary16 drill, adder
  and multiplier (each gives the reference design's building blocks: side quests are about arranging
  them); the MD opcode in the core (`o_mcore`, `o_dcore`: their multiplier and divider units come with
  the reference as chips of their own), the cache, the multicycle core and branch prediction
  (`src/campaign/build9.ts`, hardware in `src/lib/rv16/md.ts` and `multi.ts`, `rv16Pipe({ predict })`).

### Budgets
- **Expected sizes**: about 5k NANDs for the single-cycle core, about 8k pipelined, and about 12k
  with traps and interrupts.
- **Core check in the browser**: ≤ 1.5 s (32 lanes × ≤ 1200 cycles).
- **Test suite**: ≤ 5 s per reference core and ≤ 60 s for the whole campaign.
- **Measured** (phases E, F): the reference pipelines are 10.5k (no hazard handling), 11.0k (forwarding),
  11.1k (load-use stall) and 11.2k NANDs (branch flush), period 65–82; the single-cycle core with traps and
  interrupts 9.0k (period 100); the finale, the pipeline with precise traps and interrupts, 15.1k NANDs,
  period 88, its 45 programs checked in about 1.5 s. Honest lesson for the learner: with a 16-bit ripple ALU
  the E stage is almost as slow as the whole single-cycle path, so pipelining pays only once the stages are
  balanced (the fast-adder side quest).
- **Measured** (phase G): the multiply core 9.1k NANDs, period 191 (the 16 × 16 array doubles it: why real
  cores pipeline the multiplier); with the stalling divider 11.7k, period 193, 18 cycles per divide; the
  multicycle core 6.2k, period 78 against 98, but 3.1× the cycles; the predicting pipeline 11.8k, period 85,
  13% fewer cycles than Pipeline IV over the prediction programs (25% on the loops); the cache 3.5k NANDs, period 36.
- **Measured** (phase D): the reference single-cycle core is 5 748 NANDs, clock period 98 NAND delays with
  8-delay memories in the path (81 with Kogge–Stone adders). The bench runs 28 programs (≈1 240 cycles in
  all) in 0.2–0.6 s on 32 bit-parallel lanes; the event-driven fallback gives identical results.
- **Today's pars** (the figures above are as first measured; §9's review tightened the references): Core III 4 720
  NANDs, period 98; Pipelines I–IV 7 062 / 7 417 / 7 531 / 9 218, period 65–78; the trap cores 7 257, period 100; the
  finale 12 038, period 81; prediction 9 789, period 80; multiply core 8 037, period 191; divide core 10 546, period
  193; multicycle 5 203, period 76; the cache 3 497, period 36.

---

## 8. More ideas (suggested, not yet scheduled)

- ✅ **Continue from your previous core**: a core stage starts from a copy of your last one.
- ✅ **Debug a failing test**: open it as a sandbox bench with probes and the timing panel.
- ✅ **Watch the tests** (Turing Complete style, `src/editor/testrun.ts`, `testplayer.ts`): after Check, the
  level's cases play one at a time on the learner's own circuit (pins, wires, displays and the I/O bar show
  the case); step, scrub, play at 1–30 per second or one per frame (stopping at a failing case), jump between
  the failures Check found, and edit while paused: the case plays again on the rebuilt circuit. A failing
  Check opens it on the first failure. Core levels list every program, each watchable on a bench.
- ✅ **Codex as a glossary**: hover definitions in the chapters and on the level screen.
- ⏳ **Achievements**: XOR in 4 NANDs, a full adder in 9, CPI < 1.2, a period below the
  reference's.
- ⏳ **A share link for campaign progress** (stars only).
- ⏳ **Bug-hunt levels**: a circuit with a planted fault, to find and fix.
- ⏳ **A timing level**: fix a setup violation, or overclock until it breaks.
- ⏳ **Where your NANDs go**: a per-component breakdown of your CPU.
- ⏳ **Boss level**: snake on an LED matrix, on your own pipelined core.
- ✅ **Custom ISA**: done in the sandbox (roadmap Phase 12; `src/isa`, File ▸ Instruction sets…): a table of mnemonics,
  operands and bit patterns gives an assembler, disassembler, field view and ROM listing. Not from isa16's tables: the
  tables are their own format (the one preset is the 4-bit CPU's ISA), and RV16 sits beside them behind one Isa shape.
  Syntax only: a table has no golden model, so the campaign does not use it.
- ✅ **A level screen of its own**, **why we are building it**, a **step-by-step solution walkthrough** in every
  level and a **fuller codex**: details in the roadmap's Phase 12, Campaign.
- ⏳ **Before the transistor**: an act with relay and tube bricks, a 3D view of the machine and punch-card
  programs (roadmap Phase 14).
- 🚧 **GPU act**: act 9's compute levels are playable (lanes, lane register file, mask, SIMD core, reconvergence
  stack, SIMT core, coalescer, two warps; saxpy, reduction and histogram kernels); the rasterizer follows (roadmap
  Phase 15).
- ✅ **Memory act**: act 10 (a DRAM column, a bank with refresh, a row-buffer controller, a two-master bus, a DMA
  engine, a flash page store and the boot puzzle; roadmap Phase 16e).

---

## 9. Reference and par review (found and done 2026-10-11)

While the level cases, the fuller codex and the walkthroughs were written, every part they cite was measured
(`stats`, `logicDepth`, static timing), and several references turned out to waste NANDs their pars then counted.
All were fixed on one branch (`fix/campaign-pars`); every par was then re-measured from its tightened reference.
`scripts/campaign-pars.ts` prints each level's reference against its par (`--write` sets the pars); the
`tests/campaign.test.ts` check that every reference meets its par is unchanged. Pars fell, so earlier stars were
earned against looser pars: progress keeps them (stars are stored, not re-graded).

**The principle**: a part a level unlocks costs what that level's reference (and par) counts, so a learner who
places unlocked parts lands on par downstream, and every later reference is built from the same parts.

**Storage at the learner's cost** (src/lib/rv16/logic.ts). The library's D latch has an inverter on d (5 NANDs: 11
per flip-flop, 15 per enable flip-flop). The levels now unlock campaign cells at the pars the learner built:
`rv16_dlatch` 4, `rv16_dff` 9, `rv16_dffe` 13, `rv16_reg4` 52, `rv16_reg16` 208 (four `rv16_reg4`) and `rv16_dreg16`
144 (sixteen flip-flops without an enable), and every rv16 block uses them. `s_reg16` 240 → 208; `m_rf` 2 627 →
2 403; `s_fsm` 32 → 28.

**Per level** (old → new par)
- [x] `g_mux8` 64 → 49: `rv16_mux16`, one inverter on s for all sixteen bits (3n + 1); unlocked by g_mux8, used for
  every 16-bit 2:1 mux in the rv16 blocks (the 4:1 and 8:1 trees followed: see After the review).
- [x] `a_inc16` 80 / 33 → 76 / 31: bit 0 is ¬a0 (`rv16_inc16`, unlocked instead of the library's).
- [x] `a_slt` 217 / 44 → 169 / 39: 16 inverters (not XORs) for ¬b, an adder whose carry alone is read, and
  lt = signs differ ? a15 : ¬cout. A carry-only chain drawn from NANDs would drop the adder's 48 sum gates too.
- [x] `s_pc` 448 / 45 → 318 / 41: flip-flops without an enable (the PC loads every cycle), the cheaper incrementer and muxes.
- [x] `pi_core0` 10 290 → 7 676, `pi_core1` 10 976 → 8 362, `pi_core2` 11 105 → 8 476: no branch comparator, next PC,
  pc pipeline registers or E/M pc + 1 in pipelines that do not branch.
- [x] `y_trap`, `y_irq` 9 004 → 7 972, `y_final` 15 050 / 88 → 13 035 / 81: mcause from five NANDs (bit 1 = 1,
  bit 15 = intr, bit 0 = intr + ¬ill, bit 3 = intr + ¬ill · ecall) instead of three muxes of constants; the F/D
  valid bit is one flip-flop with clear; ld · ¬trap + trap + mret is ld + trap + mret.
- [x] `c_core3` 5 748 → 5 236 (and the trap cores): the PC register loads next PC's pc + 1, no second incrementer.
- [x] `c_core1` 4 973 / 98 → 4 318 / 84: its own reference (`rv16_cpu_alu`) without the load path (result = ALU or
  lui's immediate) and with a 2:1 immediate mux; `c_core2` 4 604.
- [x] References with pins their challenges lack: `a_addsub16` (n) and `a_alu16` (neg, ovf, carry) are drawn without them.
- [x] Titles: g_mux8's node title is now singular like its build title; a_slt's build title is the node's
  ("Set if less than"). g_sop keeps both on purpose: the map names the technique, the level its instance.
- Downstream, from the cheaper parts alone: `c_br` 287, `c_npc` 421, `c_fast` period 76, `c_computer` 27 599,
  `pi_reg` 260, `pi_core3` 10 016 / 78, `o_bpred` 10 587 / 80, `y_csr` 1 870 / 17, `o_mcore` 8 553, `o_dcore` 11 107,
  `o_cache` 3 497, `o_mc` 5 719 / 76.

**Hardware against the golden model** (both lose what the cores did not have)
- [x] `mcycle`: dropped from both. CSR 7 has no register and no name; it reads 0 and ignores writes in `rv16_csr` and
  in `iss16`. A real counter would count cycles in the hardware and instructions in the golden model, which differ
  on a pipeline.
- [x] The timer: dropped from `iss16` (MTIME, MTIMECMP, MTIP, cause 0x8007). 0xFFF7–0xFFF8 are reserved: they read 0
  and drop stores, as the test bench already did. RV16 interrupts are the external line only.

**After the review** (done on `fix/campaign-muxes`, 2026-10-11)
- [x] **Wider bus muxes and the shifter as campaign parts.** The 4:1 and 8:1 bus muxes and the barrel shifter were
  the library's, built from 64-NAND 2:1 muxes, so a learner placing `rv16_mux16` beat every par that held one. Now
  `rv16Mux(k)` (`rv16_mux4x16` 147, `rv16_mux8x16` 343: `muxTreeOf` on `rv16_mux16`) and `rv16_shift16` (299:
  `shifterOf`) are unlocked by g_mux8 and a_shift16, and `rv16_alu16` / `rv16_alu16ks` (`aluOf` with both: 1 055 /
  1 273) by a_alu16 and o_fastadd, replacing `alu16`, `alu16ks` and `shift16` in the unlocks and in every rv16 block.
- [x] **Muxes with an idle input.** A 4:1 bus mux paid for a three-way choice wherever one input is never selected:
  Core II's and Pipelines I–III's immediate (no J format without jumps), result and M-stage muxes (no pc + 1), the
  forwarding muxes in every pipeline (fa is never 3), Pipeline IV's M result (a load forwards nothing) and system
  decode's CSR write value (csrrw and a non-CSR op both write rs1). `choose4(b, inputs, sel)` builds each as a learner
  would: `rv16_mux4x16` when all four inputs are used, two `rv16_mux16` (98) for three, one for two; its select
  splitter and first mux are named (`sel<k>`, `pick<k>`), so the authored walkthroughs keep their part ids.
- [x] Every par re-measured (`scripts/campaign-pars.ts --write`, periods and cycles unchanged): `a_shift16` 389 → 299,
  `a_alu16` 1 250 → 1 055, `m_rf` 2 403 → 2 193, `c_core1` 4 318 → 3 913, `c_core2` 4 604 → 4 011, `c_core3` 5 236 →
  4 741, `c_computer` 27 599 → 27 104, `pi_core0` 7 676 → 7 083, `pi_core1` 8 362 → 7 438, `pi_core2` 8 476 → 7 552,
  `pi_core3` 10 016 → 9 239, `o_bpred` 10 587 → 9 810, `y_csr` 1 870 → 1 765, `y_trap` / `y_irq` 7 972 → 7 278,
  `y_final` 13 035 → 12 059, `o_mcore` 8 553 → 8 058, `o_dcore` 11 107 → 10 612, `o_mc` 5 719 → 5 224; the texts that
  quote them (walkthroughs, cases, codex), the live alternatives and codex figures (RV16 parts), and the puzzles'
  RV16 computer (25 829 → 25 334 NANDs, src/puzzles/refdata.json).
- [x] **Two benches, one count.** Core III's check failed Pipeline IV (CPI 1.2 against its budget of 1) and stopped
  each lane at that tighter budget, so the 1 460 counted unfinished runs. `runCore` now runs a lane on to twice its
  budget: a slow core's cycles are counted to the end (1 495 on both benches) and its failure says how many it took.
  1 495 × 78 = 116 610 stands.
- [x] **Stars earned against the old pars**: left as earned (the author's choice). The level screen shows the stored
  best against the current par.
- [x] **c_computer's given ROM**: the reference's ROM instance is `rom`, the given part's id, so the walkthrough
  treats it as given.

- [x] **16-bit 2:1 muxes in the side quests** (`fix/sidequest-muxes`). The FP adder and multiplier's result muxes,
  int → float's 16-bit shifters (inside `fpnr5_10_16`) and the 16-bit divider (`sdiv16`, its step) held the library's
  64-NAND `mux2x16` where `rv16_mux16` is unlocked (the divider through `o_dcore`). The generators (`seqDivider`,
  `divStep`, `shiftLeft`, `shiftRightSticky`, `normRound`, `fpAdd`, `fpMul`, `fpFromInt`) take a `Mux2Kind`: the
  library's by default (ids and counts unchanged), `RV16_MUX2` (MUX16 for 16-bit words, id suffix `_rv16`) in the
  campaign. `o_div` gives and unlocks `sdiv16_rv16`, `o_fpnorm` unlocks `fpnr5_10_16_rv16`. Pars: `o_div` 1 490 →
  1 445, `o_dcore` 10 612 → 10 567, `o_fpadd` 3 785 → 3 755, `o_fpmul` 4 965 → 4 935, `o_fpcvt` 2 840 → 2 690.
  `tests/campaign.test.ts` now allows no exception. `o_mulseq` keeps the library mux: its level gives it and does not
  unlock the 49-NAND one, and nothing downstream places its multiplier.
- [x] **Content review** (`fix/content-review`, 2026-10-19): three references a learner beat by following the tips.
  `rv16_prime4` (g_sop) is 8 NANDs at depth 5, y = (a2 ? a0 : a1) · (¬a3 + a0·¬(a1·a2)), proven minimal by exhaustive
  search (the K-map's sum of products stays as `rv16_prime4_sop`, 20, for the codex figures); `rv16_dec3` (g_dec)
  predecodes, 51 → 30; k_frame's vertex registers are 7 bits as its tip says (702 fewer). The decoder sits in
  `rv16_rf`, so every core shrinks (periods and cycles unchanged): `m_rf` 2 193 → 2 172, `c_core1` 3 913 → 3 892,
  `c_core2` 4 011 → 3 990, `c_core3` 4 741 → 4 720, `c_computer` 27 104 → 27 083, Pipelines I–IV 7 083 / 7 438 /
  7 552 / 9 239 → 7 062 / 7 417 / 7 531 / 9 218, `o_bpred` 9 810 → 9 789, `y_trap` / `y_irq` 7 278 → 7 257,
  `y_final` 12 059 → 12 038, `o_mcore` 8 058 → 8 037, `o_dcore` 10 567 → 10 546, `o_mc` 5 224 → 5 203, `k_vrf`
  8 772 → 8 688, `k_simd` 15 774 → 15 669, `k_simt` 17 837 → 17 732, `k_warps` 30 163 → 29 974, `k_edge` 984 → 963,
  `k_raster` 9 251 → 9 188, `k_frame` 41 250 → 40 275; g_sop 20 → 8, g_dec 51 → 30. The quoted numbers are now read
  back from the texts by `tests/content-*.test.ts`.

**What the measurements say about the pipeline**: with the tightened parts, Pipeline IV takes 1 495 cycles × 78 =
116 610 NAND delays against Core III's 1 236 × 98 = 121 128: about 4 % faster (before, at period 82, it was 1 %
slower). Its CPI of 1.2 still eats most of the period's 20 % gain; prediction (its own test set) and earlier branch
resolution are what make it pay more. The guided chapters measure the RV32 cores and are unaffected.
