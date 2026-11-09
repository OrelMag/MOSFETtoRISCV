// Directed programs for the virtual-memory CPU's lock-step tests (tests/vm-cpu.test.ts). Each boots from reset in M, builds
// its page tables with ordinary stores, drops to S or U with mret and exercises one family of behaviours; the hardware and
// the golden model must agree after every retirement. No program pokes the model: everything is set up by instructions.
//
// Memory map used by all of them (data memory 2^12 words = four 4 KiB pages at physical 0, wrapping above; code in the ROM):
//   PA 0x0000 root table · 0x1000 leaf table · 0x2000 user page A · 0x3000 user page B
//   VA 0x4000 + x  user code (PA x, the ROM)        VA 0x5000 + x  supervisor code (the same ROM words)
//   VA 0x1000  page A, read/write, U               VA 0x2000  page B, read-only, U
//   VA 0x6000  page A again, S only (no U)         VA 0x7000  page B, execute-only, U

export const V = 1, R = 2, W = 4, X = 8, U = 16, A = 64, D = 128;
export const pte = (pa: number, flags: number): number => (((pa >>> 12) * 1024) + flags) >>> 0;
export const ROOT = 0, LEAF = 0x1000, PAGE_A = 0x2000, PAGE_B = 0x3000;
const word = (pa: number, v: number) => `li t0, ${pa}\n  li t1, ${v >>> 0}\n  sw t1, 0(t0)`;
/** Stores that write page-table entries. */
export const poke = (entries: [number, number][]) => entries.map(([pa, v]) => `  ${word(pa, v)}`).join('\n');
/** A load / store of the word at a virtual address (the assembler's offsets are 12 bits). */
const ld = (reg: string, va: number, op = 'lw') => `  li t2, ${va}\n  ${op} ${reg}, 0(t2)`;
const st = (reg: string, va: number, op = 'sw') => `  li t2, ${va}\n  ${op} ${reg}, 0(t2)`;
const jmp = (va: number) => `  la t2, retlab
  li t3, ${va}
  add t2, t2, t3
  jalr ra, 0(t2)`;

/** The leaf-table entries every program starts with. */
export const BASE_LEAF: [number, number][] = [
  [LEAF + 4 * 0, pte(0, V | R | X | A)],
  [LEAF + 4 * 1, pte(PAGE_A, V | R | W | U | A | D)],
  [LEAF + 4 * 2, pte(PAGE_B, V | R | U | A | D)],
  [LEAF + 4 * 4, pte(0, V | R | X | U | A)],
  [LEAF + 4 * 5, pte(0, V | R | X | A)],
  [LEAF + 4 * 6, pte(PAGE_A, V | R | W | A | D)],
  [LEAF + 4 * 7, pte(PAGE_B, V | X | U | A)],
];

/**
 * The trap handler (in M, at `handler`): ecall with a7 = 93 ends the program, an ecall with a7 = 7 jumps to a6 (a way back
 * into M code); a fetch fault returns through ra; every other trap skips the instruction, a timer interrupt is acknowledged.
 */
export const HANDLER = `handler:
  li t6, 93
  beq a7, t6, done
  li t6, 7
  bne a7, t6, notseven
  csrr t5, mcause
  li t6, 8
  blt t5, t6, notseven
  li t6, 11
  bgt t5, t6, notseven
  li t6, 0xfff
  and a6, a6, t6
  jr a6
notseven:
  csrr t5, mcause
  bltz t5, irqtrap
  li t6, 12
  beq t5, t6, viara
  li t6, 1
  beq t5, t6, viara
  csrr t5, mepc
  addi t5, t5, 4
  csrw mepc, t5
  mret
viara:
  csrw mepc, ra
  mret
irqtrap:
  li t5, -1
  li t6, 0x80000014
  sw t5, 0(t6)
  mret
done:
  j done`;

/** Enter mode `mpp` (0 U, 1 S) at a code label as run at virtual address base + label, with these mstatus bits besides MPP. */
const enterAt = (mpp: number, label: string, base: number, extra = 0) =>
  `  la t0, ${label}\n  li t1, ${base}\n  add t0, t0, t1\n  csrw mepc, t0\n  li t0, ${(mpp << 11) | extra}\n  csrw mstatus, t0\n  mret`;
export const enterU = (label: string, extra = 0) => enterAt(0, label, 0x4000, extra);
export const enterS = (label: string, extra = 0) => enterAt(1, label, 0x5000, extra);
/** The M-mode code that an ecall with a7 = 7 returns to. */
const toM = (label: string) => `  la a6, ${label}\n  li a7, 7\n  ecall`;

export interface Prog { name: string; source: string; max: number; note: string; dmemK?: number; check?: (r: { causes: Record<number, number>; irqs: number[]; ops: Record<string, number[]>; walks: number; byPriv: number[] }) => string }

/** The boot: handler, mtvec, tables, satp, sfence. */
function boot(extraLeaf: [number, number][] = [], extraRoot: [number, number][] = [], tail = ''): string {
  return `  j boot
${HANDLER}
boot:
  la t0, handler
  csrw mtvec, t0
${poke([[ROOT, pte(LEAF, V)], ...BASE_LEAF, ...extraLeaf, ...extraRoot])}
  li t0, 0x80000000
  csrw satp, t0
  sfence.vma zero, zero
${tail}`;
}

/** 1. U and S access, TLB fills and hits, ecalls from every mode, SUM and MXR changed from S. */
const basic: Prog = {
  name: 'basic: user and supervisor access, ecalls from U, S and M', max: 3000, note: 'TLB fill, hit, ecall causes 8 / 9 / 11, read-only and unmapped pages, SUM, MXR',
  source: boot([], [], `${enterU('user')}
user:
  li a0, 0x1000
  li a1, 0x11223344
  sw a1, 0(a0)
  lw a2, 0(a0)
  sb a1, 5(a0)
  lh a3, 4(a0)
${ld('a4', 0x2000)}
${st('a1', 0x2000)}
${ld('a5', 0x3000)}
  lw a6, 0(zero)
${ld('t3', 0x1004)}
  lbu t3, 7(a0)
  li a7, 1
  ecall
${toM('tosuper')}
tosuper:
${enterS('sup')}
sup:
${ld('a2', 0x1000)}
${ld('a3', 0x6000)}
${st('a3', 0x6004)}
${ld('a5', 0x2000)}
  li t0, 0x40000
  csrs sstatus, t0
${ld('a5', 0x2000)}
${st('a5', 0x2008)}
${ld('a6', 0x7000)}
  li t0, 0x80000
  csrs sstatus, t0
${ld('a6', 0x7000)}
  csrc sstatus, t0
${ld('a6', 0x7004)}
  li a7, 1
  ecall
${toM('tom')}
tom:
  li a7, 1
  ecall
  li a7, 93
  ecall`),
};

/** 2. Every fault cause the walker and the permission check raise, from U. */
const faults: Prog = {
  name: 'faults: every page-fault and access-fault cause', max: 8000, note: 'causes 12 13 15 1 5 7 4 6 2, mtval = VA, walks that stop at each rule',
  source: boot(
    [
      [LEAF + 4 * 8, 0], // invalid
      [LEAF + 4 * 9, pte(PAGE_A, V | W | U | A | D)], // W without R
      [LEAF + 4 * 10, pte(PAGE_A, V | R | W | U | D)], // A = 0
      [LEAF + 4 * 11, pte(PAGE_A, V | R | W | U | A)], // D = 0
      [LEAF + 4 * 12, pte(PAGE_A, V)], // a pointer at level 0
      [LEAF + 4 * 13, ((0x100000 * 1024) | V | R | W | U | A | D) >>> 0], // beyond 2^32
      [LEAF + 4 * 14, (0x80000 * 1024 + (V | R | W | U | A | D)) >>> 0], // physical 0x8000_0000: the I/O window
      [LEAF + 4 * 15, pte(PAGE_A, V | X | U | A)], // execute-only (fetch ok, load fault)
      [LEAF + 4 * 16, pte(0, V | R | X | U | A | W)], // writable code (the ROM alias)
    ],
    [
      [ROOT + 4 * 1, pte(LEAF, V | A)], // a pointer with A set
      [ROOT + 4 * 2, pte(0x1000, V | R | W | U | A | D)], // a superpage with a misaligned PPN
      [ROOT + 4 * 3, pte(0x400000, V | R | W | U | A | D)], // an aligned superpage (physical 4 MiB: wraps to 0)
      [ROOT + 4 * 4, (0x100000 * 1024 + V) >>> 0], // a pointer to a table beyond 2^32
      [ROOT + 4 * 5, (0x80000 * 1024 + V) >>> 0], // a pointer to a table in I/O space
      [ROOT + 4 * 6, 0],
      [ROOT + 4 * 7, pte(LEAF, V | D)], // a pointer with D set
    ],
    `${enterU('user')}
user:
  li s1, 0x5a5a5a5a
${[0x7000, 0x8000, 0x9000, 0xa000, 0xb000, 0xc000, 0xd000, 0xe010, 0xe000, 0xf000, 0x10000, 0x11000, 0x400000, 0x800040, 0xc01000, 0xc02000, 0x1000000, 0x1400000, 0x1800000, 0x1c00000, 0x2000000, 0x80000]
    .map((a) => `${ld('a0', a)}\n${st('s1', a + 4)}`).join('\n')}
${ld('a0', 0x1001)}
${st('s1', 0x1002)}
${ld('a0', 0x2001)}
${st('s1', 0x3003, 'sh')}
${ld('a0', 0x3003)}
${ld('a0', 0x8003)}
${st('s1', 0xa002, 'sh')}
${st('s1', 0xa003, 'sw')}
  csrr a1, mstatus
  csrr a1, sstatus
  csrw satp, zero
  csrr a1, cycle
  mret
  sret
  sfence.vma zero, zero
  wfi
  .word 0
${[0x1000, 0xf000, 0x7000, 0x8000, 0, 0x6000, 0xd000, 0x400000, 0x800000, 0x1000000, 0x1400000, 0x2000000, 0x10000000, 0x11000, 0x9000, 0xa000, 0xb000, 0xc000, 0xe000].map((a) => jmp(a)).join('\n')}
  la t2, retlab
  li t3, 0x10000
  add t2, t2, t3
  jalr ra, 0(t2)
  la t2, retlab
  li t3, 0x4000
  add t2, t2, t3
  jalr ra, 0(t2)
  li a7, 93
  ecall
retlab:
  ret`,
  ),
};

/** 3. A superpage, remapping with sfence.vma, a satp switch between two roots, a data access through the I/O window. */
const remap: Prog = {
  name: 'remap: sfence.vma, satp switch, superpage, I/O through a mapping', max: 8000, dmemK: 13, note: 'a changed PTE is seen after sfence.vma; a new root after the satp write; physical 0x8000_0010 read from U',
  source: boot(
    [
      [LEAF + 4 * 14, (0x80000 * 1024 + (V | R | W | U | A | D)) >>> 0],
      [LEAF + 4 * 8, pte(PAGE_A, V | R | W | U | A | D)],
    ],
    [[ROOT + 4 * 1, pte(0x400000, V | R | W | U | A | D)], [ROOT + 4 * 3, pte(0x800000, V | R | X | U | A | D)]],
    `  ${word(PAGE_A + 0x10, 0xaaaa0001)}
  ${word(PAGE_B + 0x10, 0xbbbb0002)}
  ${word(PAGE_A + 0x14, 0xaaaa0003)}
${enterU('user')}
user:
${ld('a0', 0x8010)}
${ld('a1', 0x8014)}
${toM('m1')}
m1:
  ${word(LEAF + 4 * 8, pte(PAGE_B, V | R | W | U | A | D))}
  sfence.vma zero, zero
${enterU('u2')}
u2:
${ld('a2', 0x8010)}
${st('a2', 0x8014)}
${ld('a3', 0x8014)}
${ld('a4', 0xe010)}
${ld('a5', 0xe014)}
${ld('a6', 0xc00010)}
${ld('t2', 0xc00014)}
${st('a6', 0xc00018)}
${ld('t3', 0x400010)}
${ld('a7', 0x1000)}
${toM('m2')}
m2:
  ${word(0x2020, 0)}
  ${word(0x2000, pte(LEAF, V))}
  ${word(0x2004, pte(0x400000, V | R | W | U | A | D))}
  ${word(0x2008, pte(0, V | R | X | U | A))}
  li t0, 0x80000002
  csrw satp, t0
${enterU('u3')}
u3:
${ld('t3', 0x400000)}
${ld('t4', 0x400004)}
${toM('m3')}
m3:
  ${word(PAGE_A, 0x1111aaaa)}
  ${word(PAGE_B, 0x2222bbbb)}
  ${word(0x4000, pte(0x5000, V))}
  ${word(0x5000 + 4 * 4, pte(0, V | R | X | U | A))}
  ${word(0x5000 + 4 * 1, pte(PAGE_B, V | R | W | U | A | D))}
  ${word(0x5000 + 4 * 2, pte(PAGE_A, V | R | U | A | D))}
  li t0, 0x80000004
  csrw satp, t0
${enterU('u5')}
u5:
${ld('a1', 0x1000)}
${ld('a2', 0x2000)}
${toM('m4')}
m4:
  li t0, 0x80000000
  csrw satp, t0
  sfence.vma zero, zero
${enterU('u4')}
u4:
${ld('a2', 0x8014)}
  li a7, 93
  ecall`,
  ),
};

/** The handler of the interrupt tests: counts interrupts in s11 and acknowledges the timer; ecall 7 jumps to a6, 93 ends. */
const IRQ_HANDLER = `handler:
  csrr t5, mcause
  bltz t5, irq
  li t6, 93
  beq a7, t6, done
  li t6, 7
  bne a7, t6, skip
  li t6, 0xfff
  and a6, a6, t6
  jr a6
skip:
  csrr t5, mepc
  addi t5, t5, 4
  csrw mepc, t5
  mret
irq:
  addi s11, s11, 1
  li t5, -1
  li t6, 0x80000014
  sw t5, 0(t6)
  mret
done:
  j done`;
const arm = (delta: number) => `  li t0, 0x80000010\n  lw t1, 0(t0)\n  addi t1, t1, ${delta}\n  sw t1, 4(t0)`;

/** 4. Timer interrupts across modes (the Spike oracle does not generate them). */
const interrupts: Prog = {
  name: 'interrupts: timer interrupts taken from U and S with MIE = 0, ignored in M with MIE = 0, mret back', max: 8000,
  note: 'M: pending but not taken until MIE; U and S: taken at once whatever MIE says; mret returns to the interrupted mode',
  source: `  j boot
${IRQ_HANDLER}
boot:
  la t0, handler
  csrw mtvec, t0
${poke([[ROOT, pte(LEAF, V)], ...BASE_LEAF])}
  li t0, 0x80000000
  csrw satp, t0
  sfence.vma zero, zero
  li t0, 0x80
  csrw mie, t0
${arm(40)}
  li t3, 30
mspin:
  addi t3, t3, -1
  bnez t3, mspin
  csrsi mstatus, 8
  nop
  nop
  csrci mstatus, 8
${arm(50)}
${enterU('uspin')}
uspin:
  addi s0, s0, 1
  li t2, 2
  blt s11, t2, uspin
${toM('phase3')}
phase3:
${arm(40)}
${enterS('sspin', 2 | 0x20)}
sspin:
  addi s1, s1, 1
  li t2, 3
  blt s11, t2, sspin
  li a7, 1
  ecall
${toM('phase4')}
phase4:
  csrsi mstatus, 8
${arm(25)}
  li t3, 10
  csrw mscratch, t3
${enterU('ufin', 8)}
ufin:
  addi s2, s2, 1
  li t2, 4
  blt s11, t2, ufin
  li a7, 93
  ecall`,
};

/** 5. sret in S and its legality (the Spike oracle does not generate it in S). */
const sret: Prog = {
  name: 'sret: S to S, S to U, SPP / SIE / SPIE updates, illegal in U, legal in M', max: 4000,
  note: 'sret returns to SPP, SPP := U, SIE := SPIE, SPIE := 1; sepc and sstatus read back after each',
  source: boot([], [], `${enterS('s1')}
s1:
  la t0, s2
  csrw sepc, t0
  li t0, 0x120
  csrs sstatus, t0
  csrr a0, sstatus
  sret
  li a7, 99
  ecall
s2:
  csrr a1, sstatus
  csrr a2, sepc
  la t0, s3
  csrw sepc, t0
  li t0, 0x100
  csrs sstatus, t0
  li t0, 0x2
  csrc sstatus, t0
  li t0, 0x20
  csrc sstatus, t0
  csrr a3, sstatus
  sret
s3:
  csrr a4, sstatus
  la t0, u1
  li t1, -0x1000
  add t0, t0, t1
  csrw sepc, t0
  li t0, 0x20
  csrs sstatus, t0
  csrr a5, sstatus
  sret
u1:
  csrr a6, sstatus
  sret
  csrr a6, sepc
  ecall
${toM('m1')}
m1:
  la t0, s5
  li t1, 0x5000
  add t0, t0, t1
  csrw sepc, t0
  li t0, 0x100
  csrs sstatus, t0
  csrr s2, sstatus
  csrr s3, mstatus
  sret
s5:
  csrr a0, sstatus
  csrr a1, mstatus
${toM('m3')}
m3:
  la t0, u1b
  li t1, 0x4000
  add t0, t0, t1
  csrw sepc, t0
  sret
u1b:
  li a7, 93
  ecall`),
};

/** 6. satp and sstatus written from S, sfence.vma, accesses under the new table (the Spike oracle does not generate them). */
const satpS: Prog = {
  name: 'satp and sstatus written from S, sfence.vma, then accesses under the new table', max: 6000, dmemK: 13,
  note: 'two roots map VA 0x1000 to different pages; S switches between them, to bare and back; SUM / MXR / SPP written from S',
  source: `  j boot
${HANDLER}
boot:
  la t0, handler
  csrw mtvec, t0
${poke([
    [0x0000, pte(0x1000, V)], [0x2000, pte(0x3000, V)],
    ...[0, 1, 2, 4, 5, 6, 7].map((i): [number, number] => [0x1000 + 4 * i, BASE_LEAF.find(([a]) => a === LEAF + 4 * i)![1]]),
    ...[0, 2, 4, 5, 6, 7].map((i): [number, number] => [0x3000 + 4 * i, BASE_LEAF.find(([a]) => a === LEAF + 4 * i)![1]]),
    [0x1000 + 4 * 1, pte(0x4000, V | R | W | U | A | D)], [0x1000 + 4 * 6, pte(0x4000, V | R | W | A | D)],
    [0x3000 + 4 * 1, pte(0x5000, V | R | W | U | A | D)], [0x3000 + 4 * 6, pte(0x5000, V | R | W | A | D)],
    [0x4000, 0x11110000], [0x4004, 0x11110004], [0x5000, 0x22220000], [0x5004, 0x22220004],
  ])}
  li t0, 0x80000000
  csrw satp, t0
  sfence.vma zero, zero
${enterS('sup')}
sup:
  li s0, 0x1000
  lw a0, 0(s0)
  lw a1, 4(s0)
  li t0, 0x80000002
  csrw satp, t0
  sfence.vma zero, zero
  lw a2, 0(s0)
  lw a3, 4(s0)
  sw a3, 8(s0)
  li t0, 0x6000
  lw a4, 0(t0)
  li t0, 0x80000000
  csrw satp, t0
  lw a2, 0(s0)
  lw a3, 8(s0)
  csrw satp, zero
  csrr a5, satp
  lw a6, 4(zero)
  li t0, 0x80000002
  csrw satp, t0
  sfence.vma s0, zero
  lw a2, 0(s0)
  li t0, 0x40000
  csrw sstatus, t0
  csrr a5, sstatus
  li t0, 0x2000
  lw a6, 0(t0)
  li t0, 0x80000
  csrw sstatus, t0
  csrr a5, sstatus
  li t0, 0x7000
  lw a6, 0(t0)
  li t0, 0x2000
  lw a6, 0(t0)
  li t0, 0xc0000
  csrw sstatus, t0
  csrr a5, sstatus
  lw a6, 0(t0)
  li t0, 0x7000
  lw a6, 0(t0)
  li t0, 0x100
  csrs sstatus, t0
  csrr a5, sstatus
  csrr a5, mstatus
  li t0, 0xffffffff
  csrw sstatus, t0
  csrr a5, sstatus
  csrr a5, mstatus
  csrw sstatus, zero
  csrr a5, mstatus
  csrr a5, satp
  li t0, 0x7fffffff
  csrw satp, t0
  csrr a5, satp
  sfence.vma zero, zero
  csrr s9, satp
  li t0, 0x80000002
  csrw satp, t0
  sfence.vma zero, zero
  li a7, 93
  ecall`,
};

/** 7. The CSR and system-instruction privilege matrix. */
const CSR_NAMES = ['mstatus', 'sstatus', 'misa', 'mie', 'mtvec', 'mscratch', 'mepc', 'mcause', 'mtval', 'mip', 'mcycle', 'cycle', 'mhartid', 'mvendorid', 'marchid', 'mimpid', 'mstatush', 'satp', 'stvec',
  'sscratch', 'sepc', 'scause', 'stval', 'sie', 'sip', 'medeleg', 'mideleg', 'mcounteren', 'scounteren', '0x7c0', '0x1ff', '0x3ff', '0x105', '0xdff', '0xc01', '0xf15'];
const matrix = (skip: string[]) => CSR_NAMES.filter((n) => !skip.includes(n)).map((n) =>
  `  csrr a0, ${n}\n  csrrw a1, ${n}, a2\n  csrrs a3, ${n}, zero\n  csrrc a4, ${n}, a2\n  csrrsi a5, ${n}, 3\n  csrrwi a6, ${n}, 5\n  csrrs a0, ${n}, a2`).join('\n');

const csrs: Prog = {
  name: 'CSRs: access by level, read-only, WARL, S views of mstatus', max: 9000,
  note: 'every CSR from M, S and U; csrrs with x0 on a read-only CSR; mstatus.MPP = 2 reads U; sstatus masks; wfi, sfence.vma, mret, sret by level',
  source: boot([], [], `  li t0, 0x1800
  csrs mstatus, t0
  li a2, 0x5a5a5a5a
  csrr a0, mstatus
  li t0, 0x1000
  csrw mstatus, t0
  csrr a0, mstatus
  li t0, 0x800
  csrw mstatus, t0
  csrr a0, mstatus
  csrw mepc, t0
  li t0, 0x2000
  csrw mstatus, t0
  csrr a0, sstatus
  csrr a0, mstatus
  wfi
  sfence.vma zero, zero
${matrix(['mtvec', 'mepc'])}
  csrw mscratch, zero
  li t0, 0x6000
  csrw mstatus, t0
  csrr a0, sstatus
${enterS('s1')}
s1:
  li a2, 0x5a5a5a5a
${matrix(['sepc'])}
  wfi
  sfence.vma zero, zero
  sfence.vma s0, a2
  mret
${toM('back')}
back:
  li t0, 0x80000000
  csrw satp, t0
${enterU('u1')}
u1:
  li a2, 0x5a5a5a5a
${matrix([])}
  wfi
  sfence.vma zero, zero
  mret
  sret
  li a7, 93
  ecall`),
};

export const PROGS: Prog[] = [basic, faults, remap, interrupts, sret, satpS, csrs];

/** 8. The external interrupt pin pulsed while walks are under way (tests/vm-cpu.test.ts raises it from the step count). */
export const IRQ_PIN: Prog = {
  name: 'irq pin: external interrupts between walks', max: 20000,
  note: 'MEIE set, the pin pulses for one step every few instructions; taken from U between and during walks, never inside one',
  source: boot([], [], `  li t0, 0x800
  csrw mie, t0
${enterU('uloop')}
uloop:
  li s0, 0x1000
  lw a0, 0(s0)
  li s2, 0x2000
  lw a1, 0(s2)
  sw a0, 4(s0)
  li s3, 0x7000
  lw a2, 0(s3)
  li s4, 0x8000
  lw a3, 0(s4)
  addi s1, s1, 1
  li t2, 80
  blt s1, t2, uloop
  li a7, 93
  ecall`),
};
