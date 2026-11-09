// The virtual-memory chapter's programs (DOM-free), for the system CPU's vm variant and the golden model's vm mode. Each boots in
// machine mode, builds its page tables with ordinary stores, turns Sv32 on, drops to user mode with mret and runs a few lines of
// user code; every trap comes back to the machine-mode handler (decision D1 of docs/PLAN-VM-OS.md), which runs untranslated.
//
// Memory map, data memory 2^12 words (four 4 KiB frames, physical addresses wrap above):
//   PA 0x0000 root table   0x1000 leaf table   0x2000 frame A   0x3000 frame B
//   VA 0x4000 + x   user code (PA x: the program ROM)      VA 0x1000   frame A, read / write, user
//   VA 0x2000   frame B, read-only, user                    VA 0x3000   frame A again, supervisor only (U = 0)
// tests/vm-chapter.test.ts runs every program on the gates in lock step with the model and pins what they print.

export const VM_V = 1, VM_R = 2, VM_W = 4, VM_X = 8, VM_U = 16, VM_A = 64, VM_D = 128;
/** A page-table entry pointing at the 4 KiB frame at physical address pa. */
export const vmPte = (pa: number, flags: number): number => (((pa >>> 12) * 1024) + flags) >>> 0;
export const VM_ROOT = 0, VM_LEAF = 0x1000, VM_FRAME_A = 0x2000, VM_FRAME_B = 0x3000;
/** Code is mapped at this virtual address: the instruction at ROM address x runs as 0x4000 + x. */
export const VM_CODE = 0x4000;
/** Cycles the walker holds the CPU for a walk to a 4 KiB leaf and to a 4 MiB superpage (tests/content-vmem.test.ts measures them on the gates). */
export const WALK_CYCLES = 3, SUPER_CYCLES = 2;
export const VM_IMEM_K = 8, VM_DMEM_K = 12;

const store = (pa: number, v: number) => `  li t0, ${pa}\n  li t1, ${v >>> 0}\n  sw t1, 0(t0)`;
const entries = (e: [number, number][]) => e.map(([pa, v]) => store(pa, v)).join('\n');

/** The leaf-table entries of the first programs: VA 0x0000 supervisor code, 0x1000 frame A (rw, U), 0x2000 frame B (r, U), 0x3000 frame A (S only), 0x4000 user code. */
const LEAF_BASE: [number, number][] = [
  [VM_LEAF + 0, vmPte(0, VM_V | VM_R | VM_X | VM_A)],
  [VM_LEAF + 4, vmPte(VM_FRAME_A, VM_V | VM_R | VM_W | VM_U | VM_A | VM_D)],
  [VM_LEAF + 8, vmPte(VM_FRAME_B, VM_V | VM_R | VM_U | VM_A | VM_D)],
  [VM_LEAF + 12, vmPte(VM_FRAME_A, VM_V | VM_R | VM_W | VM_A | VM_D)],
  [VM_LEAF + 16, vmPte(0, VM_V | VM_R | VM_X | VM_U | VM_A)],
];

const CONSOLE = '0x80000000';

/** The boot: handler address, the two table levels, satp, then the user code. `leaf` replaces the entries of LEAF_BASE. */
function boot(handler: string, leaf: [number, number][], entry: string, scratch = 0): string {
  return `  j boot
${handler}
boot:
  la t0, handler
  csrw mtvec, t0
  li t0, ${scratch}
  csrw mscratch, t0
${entries([[VM_ROOT, vmPte(VM_LEAF, VM_V)], ...leaf])}
  li t0, 0x80000000
  csrw satp, t0
  sfence.vma zero, zero
  la t0, ${entry}
  li t1, ${VM_CODE}
  add t0, t0, t1
  csrw mepc, t0
  csrw mstatus, zero
  mret`;
}

/** ecall 93 ends the program (the handler spins), ecall 1 prints a0; anything else goes to `other`. */
const SYSCALLS = `  csrr t0, mcause
  li t1, 8
  bne t0, t1, other
  li t1, 93
  beq a7, t1, done
  li t1, 1
  bne a7, t1, done
  li t0, ${CONSOLE}
  sb a0, 0(t0)
  csrr t0, mepc
  addi t0, t0, 4
  csrw mepc, t0
  mret`;

/** 1. A user program reads and writes two pages; the first touch of each is a walk, the rest are TLB hits. */
export const VM_WALK = boot(
  `handler:
${SYSCALLS}
other:
done:
  j done`,
  LEAF_BASE,
  'user',
) + `
user:
  li a0, 0x1000
  li a1, 0x2000
  li s0, 3
loop:
  lw a2, 0(a1)
  lw a3, 0(a0)
  add a3, a3, a2
  addi a3, a3, 1
  sw a3, 0(a0)
  addi s0, s0, -1
  bnez s0, loop
  li a0, 79
  li a7, 1
  ecall
  li a0, 75
  ecall
  li a7, 93
  ecall`;

/** 2. Demand paging: pages 8 and 9 of the address space start empty; the handler maps a frame on the first touch and the access runs again. */
const PAGER = `handler:
  csrr t0, mcause
  li t1, 13
  beq t0, t1, fault
  li t1, 15
  beq t0, t1, fault
${SYSCALLS.split('\n').slice(1).join('\n')}
other:
done:
  j done
fault:
  csrr t0, mtval
  srli t0, t0, 12
  andi t0, t0, 0x3ff
  slli t0, t0, 2
  li t1, ${VM_LEAF}
  add t0, t0, t1
  csrr t2, mscratch
  srli t3, t2, 2
  ori t3, t3, ${VM_V | VM_R | VM_W | VM_U | VM_A | VM_D}
  sw t3, 0(t0)
  li t1, 0x1000
  add t2, t2, t1
  csrw mscratch, t2
  sfence.vma zero, zero
  mret`;

export const VM_PAGER = boot(PAGER, [LEAF_BASE[0], LEAF_BASE[4]], 'user', VM_FRAME_A) + `
user:
  li a0, 0x8000
  li a1, 0x9000
  li a2, 11
  sw a2, 0(a0)
  li a3, 22
  sw a3, 0(a1)
  lw a4, 0(a0)
  lw a5, 0(a1)
  add a6, a4, a5
  sw a6, 4(a0)
  li a0, 79
  li a7, 1
  ecall
  li a0, 75
  ecall
  li a7, 93
  ecall`;

/** 3. Protection: a store to a read-only page and a load from a supervisor page; the handler names the access and skips it. */
const GUARD = `handler:
  csrr t0, mcause
  li t1, 15
  beq t0, t1, wfault
  li t1, 13
  beq t0, t1, rfault
${SYSCALLS.split('\n').slice(1).join('\n')}
other:
done:
  j done
wfault:
  li t2, 87
  j report
rfault:
  li t2, 82
report:
  li t0, ${CONSOLE}
  sb t2, 0(t0)
  csrr t0, mepc
  addi t0, t0, 4
  csrw mepc, t0
  mret`;

export const VM_GUARD = boot(GUARD, LEAF_BASE, 'user') + `
user:
  li a0, 0x2000
  lw a1, 0(a0)
  li a2, 5
  sw a2, 0(a0)
  li a0, 0x3000
  lw a3, 0(a0)
  li a0, 0x1000
  sw a2, 0(a0)
  li a0, 79
  li a7, 1
  ecall
  li a0, 75
  ecall
  li a7, 93
  ecall`;

export interface VmProgram { id: 'walk' | 'pager' | 'guard'; name: string; source: string; note: string }
export const VM_PROGRAMS: VmProgram[] = [
  { id: 'walk', name: 'Two pages, three rounds', source: VM_WALK, note: 'user code reads frame B and updates frame A three times, then prints OK' },
  { id: 'pager', name: 'Demand paging', source: VM_PAGER, note: 'two unmapped pages: each first touch faults, the handler maps a frame and the access runs again' },
  { id: 'guard', name: 'Protection', source: VM_GUARD, note: 'a store to a read-only page and a load from a supervisor page fault; the handler prints W and R' },
];
