# Chapter plan: Vectors (RVV), the bridge from cores to lanes

Status: PLAN + MOCKUP for the author's approval. Nothing is built. Mockup: `E:/mockups/rvv/index.html` (three steps,
light and dark; screenshots `light.png`, `dark.png`, `phone-light.png`, `phone-dark.png` beside it).

Numbers are marked **measured** (computed today on main by `stats()`) or **estimated** (to be measured once built,
and then pinned by tests like every other number on the site).

## Why this chapter, and what it must not repeat

At the moment the book goes from many cores (`multicore`), via silicon, straight into `lanes`. The lanes chapter
teaches one decoder with four ALUs, a register file per lane, `csrr tid`, the leader, and a memory port that serves
one lane per cycle. `simt` teaches the active mask and split / join, `warps` latency hiding, and `feed` coalescing,
banks and tiles.

What no chapter teaches today, and what this one covers:

1. **Three contracts for data parallelism.**
   - SIMD puts the width in the opcode (SSE / AVX / Neon: recompile for a wider machine, write a tail loop).
   - A vector machine puts the width in a register (`vl`, set by `vsetvli`: one binary for any vector length).
   - SIMT hides the width behind threads (the next chapter).
2. **Strip-mining.** `vsetvli` hands back how many elements this pass takes, so the loop needs no tail.
3. **SEW and LMUL.** The same 32 registers seen as elements of 8 / 16 / 32 bits, grouped 1, 2, 4 or 8 at a time.
4. **Lanes that take turns (Cray's idea).**
   - With fewer lanes than elements, one instruction takes `vl ÷ lanes` beats.
   - The lane core is purely spatial (one element per lane per instruction). The vector unit is spatial and temporal.
5. **A unit-stride load is a line a beat.**
   - Four word-interleaved banks serve four consecutive words without a conflict, by construction.
   - The lane core's port serves one lane per cycle.
6. **A mask you can see.** `v0` is written by a compare and read by `v0.t`. The program, or the compiler, decides,
   where SIMT's mask is implicit.
7. **Chaining.** A dependent instruction starts on element group 0 while its producer is still on group 1.
8. **The bridge.**
   - Measured, the vector unit and the lane core are almost the same silicon: four 32-bit register-file slices and four ALUs.
   - The difference is the contract and the control: `vl`, `vtype`, a beat counter and `v0` here; `tid`, a leader and a
     split / join stack there.
   - "Give each lane the scalar program instead of a vector instruction" is the next chapter's first sentence.

## Placement and builds

- **id** `vectors`, title **Vectors**, level **Throughput**.
  - Placed directly before `lanes` in `chapters/order.ts`, whatever lands between `silicon` and `lanes` meanwhile
    (fpga, verify, sidechan).
  - All references use `numOf`.
- **builds:** `['regfile', 'cpu', 'multicore']`.
  - `cache` is not needed: the vector unit's memory is a plain banked memory.
- **Edits to other chapters** (small, listed so whoever owns them knows):
  - `lanes`:
    - `builds` gains `'vectors'`;
    - "Latency or throughput" keeps its framing but its first paragraph points back ("the vector unit of chapter
      ${numOf('vectors')} did this with one instruction per vector; here every lane gets the scalar program");
    - "Lanes against cores" gains the vector unit as a third bar (measured).
  - `simt`: "The active mask" gains one sentence: "the same mask as `v0.t`, made implicit: the hardware sets it from
    the branch".
  - `docs/ROADMAP.md`: a line for the chapter.

## Goals (step 0)

- Write a loop once with `vsetvli` that runs on any vector length, and say what SIMD's fixed width costs.
- Read SEW and LMUL as a regrouping of thirty-two registers.
- Watch a four-lane vector unit in gates take a long vector in turns, load a line a beat and mask elements with `v0`.
- Price vectors against cores and lanes on the same kernel.

## Steps (11 + recap; under PARTS_MIN, so no parts)

| # | Title | Kind | What it shows |
|---|---|---|---|
| 0 | Same operation, many numbers | widget, quiz | The lanes chapter's kernel `y = 3·x + y` on the scalar CPU, run on the golden model: instructions per element by role (work, address, loop). (Counts measured when built.) The three contracts as a table. |
| 1 | Fixed width and its tail | widget | Packed SIMD in a 128-bit register: the main loop, the tail loop, the rebuild for a 256-bit machine. A slider for n shows the tail's share. No new hardware. |
| 2 | The length in a register | widget, reach | **Mockup step A.** `vsetvli t0, a0, e32, m1`: the strip-mining loop. Sliders for n, VLEN and LMUL show each pass's `vl`. The same words run on VLEN 128 / 256 / 512 (ISS runs at three VLENs: one binary, three pass counts). Reach: choose LMUL so n = 100 takes 4 passes on VLEN 128. |
| 3 | Thirty-two registers, regrouped | widget, quiz | **Mockup step B.** The register file as 32 rows of VLEN bits, cut into four lane slices. SEW splits a row into elements, LMUL groups rows (v8–v15 as one register at m8), and `v0` is shown as mask bits. Illegal groupings (v3 at m2) are refused with a reason. |
| 4 | A vector unit in gates | scene | **Mockup step C.** The single-cycle CPU with the vector unit beside it (four lanes, VLEN 128). `vadd.vv` at m4 takes 4 beats; the beat counter and the element group are lit lane by lane. Tour: decode, set `vl`, beat 0 … 3, retire. Cost bar: CPU, + vector unit, lane core (see Cost). |
| 5 | A line a beat | scene, quiz | `vle32.v` over four word-interleaved banks: four consecutive words are always four different banks, so there is no conflict, ever. Compared with the lane core's port (one lane a cycle, measured). A strided `vlse32` with stride 4 hits one bank 4 times (ISS + timing model; a forward pointer to `feed` for banks in depth). |
| 6 | A mask you can see | scene, reach | `vmslt.vx v0, v8, a1`, then `vadd.vv v16, v16, v8, v0.t`, then `vmerge.vvm`: masked-off elements keep their value (`mu`). The write enables per element are lit. Reach: clamp a vector at a threshold with one compare and one merge. |
| 7 | Adding up a vector | scene | `vredsum.vs`: within a beat a tree across the four lanes (2 adder levels), across beats an accumulator, then `vmv.x.s` back to a scalar register. Cycles against the scalar loop (measured). |
| 8 | Chaining | widget | The timing model (not gates): `vle32` → `vadd` → `vse32` at m8 without and with chaining (Cray-1, 1976). Timelines per element group and the cycles saved (computed). The price: a per-group ready bit and a forwarding path per lane (estimated in a layer). `deep: true`. |
| 9 | Vectors, lanes, cores | widget, quiz | One kernel, four machines: the scalar CPU, `multiCore(…, 4)`, CPU + vector unit, `laneCore(…, 4)`. Cycles (run on the gates) and NANDs (measured), and NANDs × cycles. The bridge paragraph to `lanes`. |
| 10 | Real vector machines | prose + layers | Cray-1 (64-element registers, chaining), the Fujitsu A64FX's SVE, RVV cores (Ara, the SiFive X280), and AVX-512's frequency licence. Each tied to what the step it echoes showed. |
| — | Recap | recap | `keep` 4 lines, `check` 3 quizzes (what `vsetvli` returns; how many beats `vadd` takes at m4 on 4 lanes, VLEN 128; why unit stride never conflicts on word-interleaved banks). |

Layers (`more`): RVV's tail / mask policies (ta / tu, ma / mu, and why our hardware implements agnostic as undisturbed,
which is legal); `vstart` and interrupts in the middle of a vector instruction (ours never traps mid-instruction: we
say so); fault-only-first loads (`vle32ff`, strlen); Zve32x versus V (below); how compilers auto-vectorize; and the
pitfall of writing LMUL m8 everywhere (register pressure: 4 register groups left).

## The ISA we implement, and its name

- **The full V extension (the application profile) is not what we build.** It requires Zve64d (64-bit elements, F and
  D) and VLEN ≥ 128 (Zvl128b).
- **What we build is Zve32x + Zvl128b**, an integer subset on RV32IM:
  - our CPUs have no D;
  - Zve32x means ELEN = 32, integer only, SEW 8 / 16 / 32.
- The chapter says "RVV" for the specification and "Zve32x" where the precise name matters (in a layer, and in the
  Spike configuration).
- **Instructions (about 30):**
  - setup: `vsetvli`, `vsetivli`, `vsetvl`;
  - unit-stride loads and stores: `vle8/16/32.v`, `vse8/16/32.v`, and strided `vlse32.v` / `vsse32.v` (the
    golden model only, unless decision 5 says otherwise);
  - arithmetic: `vadd`, `vsub`, `vrsub`, `vand`, `vor`, `vxor`, `vsll`, `vsrl`, `vsra`, `vminu`, `vmin`, `vmaxu`,
    `vmax`, in .vv / .vx / .vi forms;
  - compares: `vmseq`, `vmsne`, `vmsltu`, `vmslt`, `vmsleu`, `vmsle`, `vmsgtu`, `vmsgt`;
  - moves and merges: `vmerge.vvm` / `.vxm` / `.vim`, `vmv.v.v` / `.v.x` / `.v.i`, `vmv.x.s`, `vmv.s.x`;
  - other: `vid.v`, `vredsum.vs`, `vmul.vv` / `.vx` (golden model only, see decision 4);
  - masking with `v0.t` throughout.
- **CSRs:** `vl` (0xC20), `vtype` (0xC21), `vlenb` (0xC22), `vstart` (0x008, always 0 on ours); `mstatus.VS`.

## Golden model, assembler, Spike

- **`riscv/rvv.ts` (new, DOM-free).**
  - `VState { vlen, vl, vtype, regs: Uint8Array(32 · vlen / 8) }`.
  - `vsetvl` rules (vill on an unsupported vtype; VLMAX = LMUL · VLEN / SEW, vl = min(AVL, VLMAX)).
  - One `execV(word, x, mem, vs)` per instruction.
  - Element access by SEW, so e8 / e16 / e32 are all exact.
- **`ISS({ v: { vlen } })`** follows the pattern of `ISS({ c })`. `StepInfo` gains `vwrite?` (register group, old
  and new bytes) for the trace and the narration. `save()` / `restore()` include the vector state.
- **Decoding.** `isa.ts` `decode` / `disasm` gain OP-V (0x57), plus vector loads and stores on LOAD-FP / STORE-FP
  (0x07 / 0x27).
  - Those share the major opcodes with `flw` / `fsw`; they are told apart by the width field (0 / 5 / 6 / 7 against 2).
  - So the F CPUs and the V CPUs must agree, and a test decodes all 2^32 words of those two opcodes' width patterns
    (sampled) against both.
- **Assembler.** `asm.ts` gains the mnemonics, `v0.t`, and vtype immediates written `e32, m4, tu, mu`. The
  compose builder is left for later.
- **Spike oracle** (`tests/verify/spike.ts`, a new config, CI only):
  - **Config:** `{ id: 'zve', name: 'RV32IM + Zve32x, VLEN 128', isa: { m: true, v: true }, spike: 'rv32im_zicsr_zve32x_zvl128b' }`.
  - **To check in stage 1** at the pinned revision `SPIKE_REV 5a760667`: that `--isa` takes `zve32x_zvl128b` (newer
    Spike dropped `--varch=vlen:128,elen:32` in favour of the ISA string), and the exact form of the vector lines
    in the `--log-commits` output.
  - **Boot stub:** sets `mstatus.VS` (`li t0, 0x200; csrs mstatus, t0`), as the F config sets FS.
  - **`parseSpikeLog` / `compareWithSpike`:** parse vector register writes and compare them, plus `vl` and `vtype`
    after every `vset*`.
  - **Policy:** generated programs use `tu, mu` throughout (undisturbed: the same bytes on every conforming
    implementation).
  - **Programs:** directed programs first (every instruction at every SEW and LMUL, masked and unmasked, AVL 0,
    AVL > VLMAX, the vill cases), then `randprog32({ v: true })`: a fifth of the units vector instructions, with
    addresses kept in the window as now.
- An optional later step: the chipsalliance riscv-vector-tests suite, if it builds for Zve32x without a toolchain on
  our side. It is listed, not planned.

## Gates

`lib/vector.ts` (new), the scalar CPU untouched unless asked:

- **`vecLane(i)`:**
  - a VRF slice, `regfile(5, 32, false)`: each lane holds a 32-bit slice of all 32 registers, which is how Ara and
    Hwacha cut theirs;
  - `alu(32)` with the min / max / compare extension (a magComparator, already in `coding.ts`);
  - a write enable per element (mask and tail undisturbed means "do not write", so no third read port);
  - the reduction adder's input.
- **`VEC_CTL`:**
  - `vl` and `vtype` registers, a beat counter (0 … LMUL − 1), the element index of each lane in this beat
    (4·beat + i), the tail test (index ≥ vl), and the busy / retire handshake.
  - The scalar core stalls while the unit runs: `retire` is low, as for the divider.
- **`VEC_DECODE`:** OP-V and vector memory into lane operations; `vill` for anything outside the subset.
- **`V0_SHADOW`:** a copy of `v0` (128 flip-flops) updated on every write to v0, so the mask needs no extra read port
  (decision 6).
- **`vecMemory(k)`:**
  - four word-interleaved banks (bigRam / ram banks as `bankedMemory` builds them), so a line is served a beat;
  - the scalar port shares bank 0 … 3 by the low address bits.
- **`singleCycleCpu(program, { vector: { lanes: 4, vlen: 128 } })`:** a new option; without it the same object, gate
  for gate.
  - Instance names: `vu`, `vu.lane0` … `lane3`, `vu.ctl`, `vu.dec`, `vu.v0`, `vm` (the memory). `cosim.ts` reads the
    vector registers back from the four slices.
- **Tests:**
  - lock-step against `ISS({ v })` after every retire: directed programs plus 32 random programs per SEW / LMUL mix;
  - every scalar riscv-test still passes;
  - a `tests/verify/cpus.ts` row `sc-v`;
  - the cycle engine builds it (no gated clock);
  - the layout and route checks on every new netlist.

## Cost (measured today unless marked)

| Block | NANDs | |
|---|---|---|
| Single-cycle RV32I CPU, program ROM left out | 48 434 | measured |
| `regfile(5, 32, false)`: one lane's VRF slice | 23 621 | measured |
| `regfile(5, 32, false, 3)`: the same with a third read port | 27 589 | measured (avoided: decision 6) |
| `alu(32)` | 2 610 | measured |
| `MUL32` | 13 859 | measured (decision 4) |
| Four VRF slices + four ALUs | 104 924 | measured parts |
| v0 shadow, beat counter, vl / vtype, decode, bank muxes | ≈ 5 000 | **estimated** |
| **CPU + vector unit** | **≈ 158 000** | **estimated** |
| `laneCore(…, 4)` (ROM left out) | 140 979 | measured; 92 545 over the scalar CPU |
| `simtControl(4)` + `simtDecode(4)` | 3 630 + 544 | measured: the lane core's control, to compare with VEC_CTL |

The register-file slices are most of both machines (about 86 % of the vector unit, estimated). That is the chapter's point: the same silicon, a different contract.

## Codex and campaign

- **Codex entries (6):**
  - `simdvector` (SIMD, vector, SIMT: three contracts);
  - `vlen` (vector length and `vsetvli`);
  - `stripmine` (strip-mining);
  - `lmul` (register grouping);
  - `vmask` (vector mask);
  - `chaining`.
- Each entry gets an idea / example / mistakes / compare page (codexmore), two Check yourself quizzes, and a
  `taught.ts` row for `vectors`.
- **Campaign:**
  - no level now: `VEC_AWAITING_LEVELS`, as for side channels;
  - a later RV16 act 9 level could be a "vector add on 4 lanes", but act 9 already teaches lanes; not recommended.
- **Program puzzle (optional, later):** `p_vsum` on the sandbox RV32 puzzle computer with the vector core
  (cycles × NANDs against the scalar reference).
- **Sandbox:** `rv32iv_core` as a port core is a later option (decision 8).

## Decisions (each with a recommendation)

1. **Placement.** **Recommended: directly before `lanes`**, the first Throughput chapter. The alternative, right after
   `multicore`, would split multicore from silicon, which closes the CPU track.
2. **VLEN.** **Recommended: 128** (the Zvl128b minimum, so one slice per lane is a 32-entry register file). 256 would
   double the VRF, to about 190 000 NANDs for the VRF alone (estimated from `regfile(6, 32)` = 47 622 measured, × 4).
3. **Lanes.** **Recommended: 4**, as the lane core, so the comparison is like for like.
4. **Multiplier in gates.** **Recommended: none.**
   - Four `MUL32` would be 55 436 NANDs (measured), more than half the unit.
   - `vmul` stays in the golden model and the widgets.
   - The kernel is the lanes chapter's `y = 3·x + y` (`vsll` + `vadd`), so step 9 compares like with like.
   - The alternative is one shared multiplier over four beats (+13 859 measured, plus control).
5. **Strided access in gates.** **Recommended: the golden model and the timing model only.** Banks in depth belong to
   `feed`. The alternative, `vlse32` in gates with a bank-conflict stall, adds an address generator per lane.
6. **Mask read port.** **Recommended: the `v0` shadow** (128 flip-flops) and per-element write enables. The
   alternative is a third read port on every slice: +15 872 NANDs (measured: (27 589 − 23 621) × 4).
7. **Chaining.** **Recommended: a timing model and widget (step 8), not gates.** Chaining in gates needs a decoupled
   vector queue and per-group ready bits; it is estimated at +20–30 % of the control and doubles the stage work. The
   step says honestly that our gate-level unit does not chain.
8. **SEW in gates.**
   - **Recommended: e32 only in gates.** The golden model and Spike cover e8 / e16 / e32, and the gate-level unit
     sets `vill` for e8 / e16, said in a layer as a deliberate subset of Zve32x. This makes the gates non-conforming,
     so the chapter and the codex say so.
   - The alternative, byte-sliced ALUs (SIMD within a lane), is estimated at +30 % ALU.
9. **Python.** **Recommended: no auto-vectorization** in the chapter-15 compiler. A layer explains what a compiler
   does instead.
10. **Sandbox core.** **Recommended: later**, as `rv32iv_core` once the chapter is in.

## Stages (each a tip to the Coordinator, gated)

1. **Golden model** (`rvv.ts`, ISS, `isa.ts` / `asm.ts`): directed tests, the Spike config and log parsing, and the
   random generator. About 1 agent-day.
2. **Gates** (`lib/vector.ts`, the CPU option, cosim, verify row, layout). About 1.5 agent-days.
3. **The chapter** (steps 0–10, widgets: SIMD tail, strip-mine, VRF grouping, chaining timeline, the four-machine
   comparison; the timing model `riscv/vecmodel.ts`), the codex, the edits to `lanes` / `simt`, and the manifest.
   About 1.5 agent-days.

Bundle: `rvv.ts` loads with the ISS (estimated 6–8 KB min), and the widgets in the chapter's own chunk. If the ISS
growth matters for first-paint CPU scenes, `rvv.ts` can be loaded only when `v` is set (checked against
tests/firstload.test.ts either way: the ISS is not on the first-load path).

Phone: the mockup scales its drawings down at 390 px (text too small). The built widgets must reflow instead (passes as a column of rows, the register file as one lane at a time with a lane picker, the unit stacked) and are checked by the smoke's phone routes.
