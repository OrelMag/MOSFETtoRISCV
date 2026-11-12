# Plan: Virtual memory and A tiny operating system (roadmap Phase 23)

> **Historical (2026-11-12).** Built: see docs/ROADMAP.md, Phase 23. Kept as the record of the decisions; its future tense is
> as of the plan, and any mockup link in it is the author's private draft.

Status (2026-11-10: stage 3b, the chapter `os`, its kernel (riscv/osprograms.ts) and the compiler's `user` target are built on feat/ch-os): **APPROVED by the author on 2026-11-09, as shown, with all five decisions D1–D5 as recommended below.** Mockup:
`E:/mockups/vm-os/vm-os-mockup.html` (also https://claude.ai/artifact/YHQy2jsqAW35zjfWjUdoTh). Build order, one tip to the
Coordinator per stage: (1) golden model + Spike oracle configs (runner gate + spike.yml before landing), (2) gates as a
variant `systemCpu({ vm: true })` with chapters 19–20 unchanged, (3) the two chapters, (4) codex and campaign levels. Every
number marked as an estimate here is measured before it reaches the prose.
Two chapters that chain: the first gives every program its own addresses, the second runs two programs on one CPU. Both
extend the system CPU of chapters 19–20 (`lib/system.ts`, 88 383 NANDs with its data memory, period 126 NAND delays,
`src/bench/results.json`) and the golden model's system mode (`riscv/iss.ts`), which today know only machine mode:
`mstatus.MPP` is wired to 11, there is no `satp` and no translation.

## Decisions for the author

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Which privilege modes | **M, S and U**, every trap taken in M (`medeleg` / `mideleg` read as zero, which the spec allows) | Sv32 translates S and U accesses only when S mode exists; S then costs little more than `satp`, `sfence.vma` and `sstatus` as a view of `mstatus`. The kernel of chapter 2 runs in M (no translation for itself) and the programs in U |
| D2 | Who walks the page table | **The hardware** (Sv32 says so), a walker that stalls the CPU like a cache miss (chapter 22's pattern); A and D handled by software (a page fault when A = 0, or D = 0 on a store: allowed by the spec) | A software-refilled TLB (MIPS) is simpler in gates but is not RISC-V; the A / D rule keeps the walker read-only |
| D3 | Which CPU | **The single-cycle system CPU** (chapters 19–20), with a stall input | One instruction a cycle keeps the walk visible; the pipeline would add a second set of stall rules for little gain |
| D4 | TLBs | **Two, 4 entries each, fully associative**: chapter 10's CAM keyed by the 20-bit virtual page number | A fetch and a load / store translate in the same cycle; chapter 10 already taught the CAM |
| D5 | The OS's programs | **Assembly first, then chapter 15's Python** compiled as a user process (print and exit become `ecall`s) | Two Python programs sharing the CPU is the payoff the book has been building towards |

## Chapter A: Virtual memory (after chapter 22 'cache', so 23; the rest renumber through `numOf`)

`id: 'vmem'`, builds: `['traps', 'cache']`, level 'System'.

Goals:
- explain why two programs cannot share one address space, and what a page table gives each its own;
- walk an Sv32 translation bit by bit, from `satp` through two levels of page table to a physical address;
- see the TLB (chapter 10's CAM) make the walk rare, and price what a miss costs in cycles;
- handle a page fault: the trap, `mtval`, a handler that maps the page, the retry.

| # | Step | Scene or widget |
|---|---|---|
| 1 | Two programs, one memory: both want address 0 | widget: two programs' data colliding in physical memory, then relocated by a base register, then paged |
| 2 | Pages: an address is a page number and an offset | widget: the virtual-address explorer (32 bits split 10 / 10 / 12, hover a field) |
| 3 | The page table entry: V R W X U G A D and a physical page number | widget: PTE bits, clickable, with what each permits |
| 4 | Sv32's walk: two loads before the real one | widget: the walk animated over data memory (mockup frame A) |
| 5 | The walker in gates: a state machine that stalls the CPU | scene: the system CPU with the walker opened (states, the two memory reads, stall) |
| 6 | The TLB: a CAM that remembers translations | scene: the two TLBs on the CPU, hit / miss counters, the CPU panel (mockup frame B) |
| 7 | Page faults: map on demand | scene: a program touches an unmapped page, the handler (M mode) writes a PTE, `sfence.vma`, the retry; CPU panel in lock-step with the golden model |
| 8 | Protection: U, R, W, X | scene: a user program writes a read-only page and traps (cause 15) |
| 9 | What it costs | widget: TLB entries against miss rate and cycles per instruction on the benchmark programs (measured on the golden model, priced from the gates) |
| 10 | Recap | keep / three checks / practise |

## Chapter B: A tiny operating system (after 'vmem', so 24)

`id: 'os'`, builds: `['vmem', 'traps', 'python']`, level 'System'.

Goals:
- run a program in user mode and see what it may not do;
- make a system call: `ecall`, the trap, the kernel's answer, `mret`;
- switch from one program to another: save 31 registers, load 31, change `satp`;
- share the CPU fairly with a timer interrupt and a round-robin scheduler.

| # | Step | Scene or widget |
|---|---|---|
| 1 | What the kernel is for: one CPU, two programs | widget: the plan of memory (kernel, two processes, their page tables) |
| 2 | User mode: `mret` into U, and what traps there | scene: a user program reading `mstatus` takes an illegal-instruction trap |
| 3 | System calls: `ecall` with a number in a7 | scene: putchar / exit / yield through the kernel, console output |
| 4 | The process control block and the context switch | widget: two register files side by side, the save and restore lit instruction by instruction; the cost in cycles |
| 5 | Two programs, one CPU: the timer decides | scene on the cycle engine: two programs printing, interleaved on the console; the time-slice strip (mockup frame C) |
| 6 | Separate address spaces: `satp` per process | scene: both programs use address 0x1000 and never see each other's data |
| 7 | What sharing costs | widget: time slice against switch overhead (cycles measured on the gates) |
| 8 | Two Python programs as processes | scene: chapter 15's compiler with print and exit as `ecall`s, two programs scheduled |
| 9 | Recap | |

## New hardware and golden-model work

Golden model first (`riscv/iss.ts`, system mode), checked against **Spike** (`.github/workflows/spike.yml`, `scripts/spike-oracle.ts`:
Spike runs Sv32 and U mode, so random programs with page tables and mode switches can be compared commit by commit):
- privilege M / S / U; `mstatus.MPP` (2 bits, WARL M / S / U), `MPRV` optional (not needed), `SUM` / `MXR` read as written;
- `satp` (MODE, ASID ignored, PPN), `sfence.vma`, `sstatus` as a view of `mstatus`, `medeleg` / `mideleg` zero;
- Sv32 walk with the spec's checks (V, R / W / X combinations, U against the mode, misaligned superpage, A / D = 0 → fault);
- causes 8 (ecall from U), 12 / 13 / 15 (page faults) with `mtval` = the faulting virtual address; illegal instruction for CSR
  access above the current mode;
- `FastISS` gains the same behind a flag only if the OS chapter's programs are too slow on the golden model (unlikely: they are short).

Gates (`lib/system.ts` and a new `lib/vm.ts`):
- a privilege register (2 bits) and its update on trap / `mret`; `MPP` as a real field; CSR access checks;
- `satp` in the CSR unit; `sfence.vma` decoded (clears both TLBs);
- two 4-entry TLBs (chapter 10's `cam(2, 20)` = 1 851 NANDs each, plus 4 × 30 bits of PPN and flags);
- a walker state machine (idle, level 1, level 0, done / fault) on the data-memory port, stalling the CPU;
- the permission check (U, R, W, X against the mode and the access) → the page-fault causes.
- Rough cost (estimate, to be measured): about 11 000 NANDs (2 × ~4 200 TLB, ~1 500 walker, ~1 000 privilege and CSRs) on
  88 383, about +12 %; the period grows by the TLB lookup in series with fetch (estimate 126 → ~150 NAND delays).
- Verification: the system CPU's lock-step tests extended (tests/verify/cpus.ts gains `sys-vm`), riscv-tests' `rv32si` /
  `rv32mi` virtual-memory images if they run in our memory size, the fuzz with page tables, Spike on the ISS.

Software: the kernel (`riscv/osprograms.ts`, assembly): boot, page tables for two processes, a trap handler dispatching
ecall / timer / page fault, a round-robin scheduler, the context switch through `mscratch`. Python user processes:
`lang/compile.ts` gains a `user` target (print → `ecall 1`, exit → `ecall 93`), nothing else in the compiler changes (the
existing programs' code must stay identical, as the strings work proved with a 169-build snapshot).

## Campaign and codex hooks

- Codex entries (with chapter links and Check yourself): virtual memory, page, page table, Sv32, TLB, page fault, privilege
  mode, system call, context switch, scheduler, process. `chapters/taught.ts` rows for each.
- Campaign, act 7 (the system), optional levels after `y_final`: `y_tlb` (a 4-entry TLB from a CAM: lookup, fill, flush),
  `y_walk` (the walker state machine against a model, like act 10's benches), `p_switch` (a program puzzle: write the context
  switch; the bench checks every register of both processes), all on RV16 or RV32 as act 7 is.
- Review bank and My path pick the new questions up from the codex and recap checks as usual.

## Rough cost (sessions of one agent)

| Piece | Estimate |
|---|---|
| Golden model + Spike oracle configs | 1–2 |
| Gates: privilege, satp, TLBs, walker, checks + lock-step tests | 2–3 |
| Chapter A (10 steps, 4 widgets) | 2 |
| Kernel, user Python target, chapter B (9 steps, 2 widgets) | 2–3 |
| Codex, campaign levels, recap, manifest | 1–2 |

About two weeks of agent sessions in parallel tracks (model → gates → chapters), landing as four or five batches.
Risk: the period increase touches every number chapters 19–20 quote for the system CPU unless the VM CPU is a variant
(`systemCpu({ vm: true })`), which is the plan: chapters 19–20 keep theirs.
