// The tiny operating system of chapter 'os' (DOM-free): a kernel in assembly for the system CPU's vm variant and the golden model's vm mode,
// and the user programs it runs. The kernel boots in machine mode, builds the page tables of two processes, and from then on lives in
// its trap handler: system calls, the timer interrupt, faults. It runs untranslated (decision D1 of docs/PLAN-VM-OS.md: every trap is taken in M).
//
// Physical memory. Data memory is 2^14 words (16 frames of 4 KiB), the instruction ROM 2^12 words (4 frames):
//   data  0x0000 kernel frame: variables, the process control blocks      0x1000 root table A   0x2000 leaf table A
//         0x3000 process A, page 0 (VA 0x0000)                             0x4000 process A, page 1 (VA 0x1000)
//         0x5000 .. 0x8000: the same five frames for process B
//   ROM   0x0000 the kernel's code     0x1000 process A's code     0x2000 process B's code
// Every process sees the same virtual map: VA 0x0000 and 0x1000 its two data pages (read / write, user), VA 0x2000 the kernel's frame
// (read / write but U = 0: the wall), VA 0x4000 its code (read / execute, user). Everything else is unmapped: a fault.
//
// Kernel variables (frame 0): word 0 the running process's PCB address, word 3 (0x0C) the number of switches. A PCB is 256 bytes at 0x100 + 0x100·i:
//   +0 mepc (the process's PC)   +4·n register xn (n = 1 .. 31; +20, x5, is filled in last)   +128 satp   +132 state (0 free, 1 ready, 2 gone)
//   +136 slices run              +140 the tag character the write call prints before a number
// System calls (a7 = number, the answer or the argument in a0; every register but a0 comes back as it was): 1 putchar (the low byte of a0),
// 2 write (a0 as a signed decimal, tag first, new line after), 3 yield, 93 exit. Anything else answers -1.
// The scheduler is round robin over the ready PCBs, a slice of `slice` retired instructions (mtime counts those, not walk stalls).
// tests/os-kernel.test.ts runs it on the golden model and on the gates in lock step; tests/content-os.test.ts pins every number the chapter quotes.

import { assemble } from './asm';
import { VM_A, VM_D, VM_R, VM_U, VM_V, VM_W, VM_X } from './vmprograms';

export const OS_IMEM_K = 12, OS_DMEM_K = 14;
/** The registers a switch moves each way: x1 .. x31. */
export const NREGS = 31;
export const CONSOLE = '0x80000000';
export const PCB0 = 0x100, PCB_SIZE = 0x100, NPROC = 2;
export const PCB = { satp: 128, state: 132, slices: 136, tag: 140 } as const;
/** Where each process's frames are: its root table; the leaf table, page 0 and page 1 follow. */
export const ROOT_OF = [0x1000, 0x5000];
export const CODE_PA = [0x1000, 0x2000];
export const VA = { data0: 0x0000, data1: 0x1000, kernel: 0x2000, code: 0x4000 } as const;
export const SYS = { putchar: 1, write: 2, yield: 3, exit: 93 } as const;
/** Default slice (retired instructions). */
export const OS_SLICE = 600;
const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];

const PTE_USER_RW = VM_V | VM_R | VM_W | VM_U | VM_A | VM_D;
const PTE_KERNEL_RW = VM_V | VM_R | VM_W | VM_A | VM_D;
const PTE_USER_RX = VM_V | VM_R | VM_X | VM_U | VM_A;

/** One character out of the console register: li, sb. */
const say = (text: string, reg = 't6', tmp = 't2') => [...text].map((c) => `  li ${tmp}, ${c.charCodeAt(0)}\n  sb ${tmp}, 0(${reg})`).join('\n');

/** Print the unsigned value in t1 in decimal (no leading zeros) to the console held in t6: subtract each power of ten as often as it fits. */
function decimal(tag: string): string {
  const out: string[] = ['  li t5, 0'];
  for (let k = 9; k >= 0; k--) {
    const p = 10 ** k;
    out.push(`  li t3, ${p}`, '  li t4, 0', `${tag}d${k}:`, `  bltu t1, t3, ${tag}e${k}`, '  sub t1, t1, t3', '  addi t4, t4, 1', `  j ${tag}d${k}`, `${tag}e${k}:`);
    if (k === 0) out.push('  li t5, 1');
    else out.push('  or t5, t5, t4', `  beqz t5, ${tag}n${k}`);
    out.push('  addi t4, t4, 48', '  sb t4, 0(t6)');
    if (k > 0) out.push(`${tag}n${k}:`);
  }
  return out.join('\n');
}

export interface KernelOptions {
  /** Time slice in retired instructions. */
  slice?: number;
  /**
   * Chapter 'threads': only process A is made at boot; it may start a second thread in its own address space (spawn), and the kernel
   * offers locks, condition variables, semaphores and join (THREAD_SYS). A thread that must wait is parked (state 3) and the scheduler
   * skips it; a switch between two threads of one address space keeps satp and the TLBs. When no thread is ready and one waits for ever,
   * the kernel says "deadlock" and stops. Off, the kernel is the os chapter's, instruction for instruction.
   */
  threads?: boolean;
  /**
   * Chapter 'linking': the words of an ELF executable on the "disk", a data frame (DISK_PA) the boot fills with stores before any process
   * runs (it stands in for a disk: this CPU's data side cannot read the ROM). A process may then call exec (EXEC_SYS in a7): the kernel
   * reads the program headers off the disk and replaces the caller's program with the file's. A segment with X runs in place: its page is
   * mapped (R X U) onto the ROM frame its p_paddr names, since instruction fetch reaches only the ROM; any other segment's bytes are copied
   * from the disk into the frame the caller's table maps at its p_vaddr, and the rest up to p_memsz zeroed (.bss). Then the entry point,
   * a fresh stack (sp = EXEC_SP) and sfence.vma, and the caller returns into the new program. Off, the kernel is unchanged.
   */
  disk?: number[];
  /** With disk: ROM words placed at EXEC_ROM by osImage (the executable's text, where its p_paddr says). */
  rom?: number[];
}

/** Chapter 'linking': exec's number (Linux's execve on RISC-V), the disk frame, the ROM frame text runs from, the new program's stack top. */
export const EXEC_SYS = 221, DISK_PA = 0x9000, EXEC_ROM = 0x3000, EXEC_SP = 0x1000;

/** Chapter 'threads': the system calls added to SYS (a7), their arguments in a0, a1, a2; the answer, if any, in a0. */
export const THREAD_SYS = {
  /** spawn: a0 = the new thread's first instruction, a1 = its stack pointer, a2 = where it returns to (an exit). a0 = 0, or -1 if the slot is taken. */
  spawn: 10,
  /** join: wait until the other thread has exited. */
  join: 11,
  /** lock / unlock / trylock: a0 = lock 0..3. trylock answers 1 (taken) or 0 (held by someone, not waited for). */
  lock: 12, unlock: 13, trylock: 14,
  /** wait: a0 = condition 0..3, a1 = the lock held: let the lock go and wait for a signal; the lock is held again on return. signal: a0 = condition. */
  wait: 15, signal: 16,
  /** Semaphores 0..3: down (wait while 0, then take one), up (give one back, or wake the thread that waits), init (a1 = the count). */
  down: 17, up: 18, seminit: 19,
} as const;
/** Kernel variables of the threads kernel (frame 0): the lock owners (a PCB address, 0 = free) and the semaphores' counts, four of each. */
export const LOCKS = 0x40, SEMS = 0x50;
/** PCB fields of the threads kernel: what a waiting thread waits for (WAIT_* | id) and, for a condition, the lock it holds again after the signal. */
export const PCB_T = { waitOn: 144, relock: 148 } as const;
export const WAIT = { lock: 0x100, cond: 0x200, sem: 0x300, join: 0x400 } as const;
/** States in a PCB: free, ready, gone, and (threads) waiting. */
export const STATE = { free: 0, ready: 1, gone: 2, waiting: 3 } as const;

// ---- the threads kernel's pieces (chapter 'threads'). In each, t0 is the caller's PCB; `other` puts the other thread's PCB in t1.
const OTHER = 2 * PCB0 + PCB_SIZE;
const other = `  li t2, ${OTHER}\n  sub t1, t2, t0`;
/** a0 & 3, times 4, in t3: the offset of lock / semaphore a0 in its table. */
const slot = (reg = 'a0') => `  andi t3, ${reg}, 3\n  slli t3, t3, 2`;
/** Make the PCB at t1 ready again (it waits for nothing any more). */
const wake = `  sw zero, ${PCB_T.waitOn}(t1)\n  li t2, ${STATE.ready}\n  sw t2, ${PCB.state}(t1)`;
/** Let lock t3 / 4 go: straight to the other thread if it waits for it (the lock is handed over, it wakes), else free. */
const release = (tag: string) => `  lw t2, ${PCB_T.waitOn}(t1)
  srli t4, t3, 2
  ori t4, t4, ${WAIT.lock}
  bne t2, t4, ${tag}_free
  sw t1, ${LOCKS}(t3)
${wake}
  j ${tag}_done
${tag}_free:
  sw zero, ${LOCKS}(t3)
${tag}_done:`;

const threadBoot = () => `  li t1, ${'B'.charCodeAt(0)}
  li t2, ${PCB0 + PCB_SIZE}
  sw t1, ${PCB.tag}(t2)`;

const threadDispatch = () => Object.entries(THREAD_SYS).map(([name, n]) => `  li t2, ${n}\n  beq a7, t2, sys_${name}`).join('\n') + '\n';

/** In sys_exit, before the scheduler runs: a thread that joins this one wakes. */
const threadExit = () => `${other}
  lw t2, ${PCB_T.waitOn}(t1)
  li t3, ${WAIT.join}
  bne t2, t3, ex_done
${wake}
ex_done:
`;

const threadCalls = () => `# ---- the threads calls
sys_spawn:
${other}
  lw t2, ${PCB.state}(t1)
  beqz t2, sp_free
  li t3, ${STATE.gone}
  beq t2, t3, sp_free
  li t2, -1
  sw t2, 40(t0)
  j go_same
sp_free:
  li t3, 4
sp_copy:
  add t4, t0, t3
  lw t2, 0(t4)
  add t4, t1, t3
  sw t2, 0(t4)
  addi t3, t3, 4
  li t5, ${4 * (NREGS + 1)}
  bltu t3, t5, sp_copy
  lw t2, ${PCB.satp}(t0)
  sw t2, ${PCB.satp}(t1)
  sw a0, 0(t1)
  sw a2, 4(t1)
  sw a1, 8(t1)
  sw zero, 40(t1)
  sw zero, ${PCB.slices}(t1)
${wake}
  sw zero, 40(t0)
  j go_same
sys_join:
${other}
  lw t2, ${PCB.state}(t1)
  li t3, ${STATE.ready}
  beq t2, t3, jn_wait
  li t3, ${STATE.waiting}
  bne t2, t3, go_same
jn_wait:
  li t2, ${WAIT.join}
# park: wait for t2 (WAIT_* | id); the scheduler skips this PCB until someone wakes it
park:
  sw t2, ${PCB_T.waitOn}(t0)
  li t2, ${STATE.waiting}
  sw t2, ${PCB.state}(t0)
  j schedule
sys_lock:
${slot()}
  lw t2, ${LOCKS}(t3)
  beqz t2, lk_take
  andi t2, a0, 3
  ori t2, t2, ${WAIT.lock}
  j park
lk_take:
  sw t0, ${LOCKS}(t3)
  j go_same
sys_trylock:
${slot()}
  lw t2, ${LOCKS}(t3)
  li t4, 0
  bnez t2, tl_answer
  sw t0, ${LOCKS}(t3)
  li t4, 1
tl_answer:
  sw t4, 40(t0)
  j go_same
sys_unlock:
${other}
${slot()}
${release('ul')}
  j go_same
sys_wait:
${other}
${slot('a1')}
${release('wt')}
  andi t2, a1, 3
  sw t2, ${PCB_T.relock}(t0)
  andi t2, a0, 3
  ori t2, t2, ${WAIT.cond}
  j park
sys_signal:
${other}
  lw t2, ${PCB_T.waitOn}(t1)
  andi t4, a0, 3
  ori t4, t4, ${WAIT.cond}
  bne t2, t4, go_same
  lw t3, ${PCB_T.relock}(t1)
  slli t3, t3, 2
  lw t2, ${LOCKS}(t3)
  beqz t2, sg_give
  srli t4, t3, 2
  ori t4, t4, ${WAIT.lock}
  sw t4, ${PCB_T.waitOn}(t1)
  j go_same
sg_give:
  sw t1, ${LOCKS}(t3)
${wake}
  j go_same
sys_down:
${slot()}
  lw t2, ${SEMS}(t3)
  beqz t2, dn_wait
  addi t2, t2, -1
  sw t2, ${SEMS}(t3)
  j go_same
dn_wait:
  andi t2, a0, 3
  ori t2, t2, ${WAIT.sem}
  j park
sys_up:
${other}
  andi t3, a0, 3
  ori t4, t3, ${WAIT.sem}
  lw t2, ${PCB_T.waitOn}(t1)
  bne t2, t4, up_count
${wake}
  j go_same
up_count:
  slli t3, t3, 2
  lw t2, ${SEMS}(t3)
  addi t2, t2, 1
  sw t2, ${SEMS}(t3)
  j go_same
sys_seminit:
${slot()}
  sw a1, ${SEMS}(t3)
  j go_same
`;

/** At all_done (nobody ready): a thread still waiting will never run again. */
// ---- chapter 'linking''s exec: the disk filled at boot, and the system call that loads an ELF file from it

/** Boot: the file's words into the disk frame, a store per word that is not zero (the frame starts at zero). */
const diskFill = (words: number[]): string => {
  if (4 * words.length > 0x1000) throw new Error(`the disk is one frame: the file is ${4 * words.length} bytes`);
  const out = [`# ---- the disk: ${words.length} words of an ELF file (a stand-in for a disk; the data side cannot read the ROM)`, `  li t2, ${DISK_PA}`];
  words.forEach((w, i) => {
    if (!w) return;
    if (i === 512) out.push(`  li t2, ${DISK_PA + 2048}`);
    out.push(`  li t1, ${w | 0}`, `  sw t1, ${4 * i - (i >= 512 ? 2048 : 0)}(t2)`);
  });
  return out.join('\n');
};

/** The entry of the caller's leaf table for the virtual address in s4 (t3 = its address). The leaf table is the frame after the root (mkproc). */
const leafEntry = `  srli t3, s4, 12
  andi t3, t3, 0x3ff
  slli t3, t3, 2
  add t3, t3, s3`;

const execCall = (): string => `# ---- exec: load the ELF file on the disk into the calling process (a0 = 0 on success; -1: not an ELF file)
sys_exec:
  li s0, ${DISK_PA}
  lw t1, 0(s0)
  li t2, 0x464c457f
  bne t1, t2, ex_bad
  lw s1, 28(s0)
  add s1, s1, s0
  lhu s2, 44(s0)
  lw t1, ${PCB.satp}(t0)
  slli t1, t1, 12
  li t2, 0x1000
  add s3, t1, t2
ex_seg:
  beqz s2, ex_go
  lw t1, 0(s1)
  li t2, 1
  bne t1, t2, ex_next
  lw s4, 8(s1)
  lw t1, 24(s1)
  andi t2, t1, 1
  beqz t2, ex_data
# text runs in place: its page maps onto the ROM frame at p_paddr, readable and executable, never writable
  lw t2, 12(s1)
  srli t2, t2, 12
  slli t2, t2, 10
  ori t2, t2, ${PTE_USER_RX}
${leafEntry}
  sw t2, 0(t3)
  j ex_next
# data: copied from the disk into the frame the caller's table maps at p_vaddr, then zeros up to p_memsz (.bss)
ex_data:
${leafEntry}
  lw t2, 0(t3)
  srli t2, t2, 10
  slli t2, t2, 12
  slli t3, s4, 20
  srli t3, t3, 20
  add t2, t2, t3
  lw t3, 4(s1)
  add t3, t3, s0
  lw t4, 16(s1)
  lw t5, 20(s1)
  li t6, 0
ex_copy:
  bgeu t6, t4, ex_zero
  lw a0, 0(t3)
  sw a0, 0(t2)
  addi t3, t3, 4
  addi t2, t2, 4
  addi t6, t6, 4
  j ex_copy
ex_zero:
  bgeu t6, t5, ex_next
  sw zero, 0(t2)
  addi t2, t2, 4
  addi t6, t6, 4
  j ex_zero
ex_next:
  addi s1, s1, 32
  addi s2, s2, -1
  j ex_seg
# the new program: its entry, a fresh stack, a0 = 0; the old translations are gone
ex_go:
  lw t1, 24(s0)
  sw t1, 0(t0)
  li t1, ${EXEC_SP}
  sw t1, 8(t0)
  sw zero, 40(t0)
  sfence.vma zero, zero
  j go_same
ex_bad:
  li t2, -1
  sw t2, 40(t0)
  j go_same
`;

const threadStuck = () => `  li t1, ${PCB0}
  li t3, ${STATE.waiting}
dl_look:
  lw t2, ${PCB.state}(t1)
  beq t2, t3, deadlock
  addi t1, t1, ${PCB_SIZE}
  li t2, ${PCB0 + NPROC * PCB_SIZE}
  bltu t1, t2, dl_look
`;

/** The kernel's assembly. Its sections are labelled: the chapter's widgets and the tests count instructions between labels. */
export function kernelSource(o: KernelOptions = {}): string {
  const slice = o.slice ?? OS_SLICE, T = !!o.threads, D = !!o.disk;
  const saveRegs = ABI.map((r, i) => [r, i] as const).filter(([r, i]) => i > 0 && r !== 't0');
  const save = saveRegs.map(([r, i]) => `  sw ${r}, ${4 * i}(t0)`).join('\n');
  const load = saveRegs.map(([r, i]) => `  lw ${r}, ${4 * i}(t0)`).join('\n');
  return `# ---- the kernel: boot, then the trap handler
  j boot
# ---- mkproc: a0 = root table, a1 = code frame in the ROM, a2 = PCB, a3 = tag. Fills the PCB and the five frames' page tables.
mkproc:
  li t2, 0x1000
  add t0, a0, t2
  srli t1, t0, 2
  ori t1, t1, ${VM_V}
  sw t1, 0(a0)
  li t2, 0x2000
  add t1, a0, t2
  srli t1, t1, 2
  ori t1, t1, ${PTE_USER_RW}
  sw t1, 0(t0)
  li t2, 0x3000
  add t1, a0, t2
  srli t1, t1, 2
  ori t1, t1, ${PTE_USER_RW}
  sw t1, 4(t0)
  li t1, ${PTE_KERNEL_RW}
  sw t1, 8(t0)
  srli t1, a1, 2
  ori t1, t1, ${PTE_USER_RX}
  sw t1, 16(t0)
  li t1, ${VA.code}
  sw t1, 0(a2)
  srli t1, a0, 12
  li t2, 0x80000000
  or t1, t1, t2
  sw t1, ${PCB.satp}(a2)
  li t1, 1
  sw t1, ${PCB.state}(a2)
  sw a3, ${PCB.tag}(a2)
  ret
boot:
  la t0, trap
  csrw mtvec, t0
${D ? `${diskFill(o.disk!)}\n` : ''}  li a0, ${ROOT_OF[0]}
  li a1, ${CODE_PA[0]}
  li a2, ${PCB0}
  li a3, ${'A'.charCodeAt(0)}
  jal ra, mkproc
${T ? threadBoot() : `  li a0, ${ROOT_OF[1]}
  li a1, ${CODE_PA[1]}
  li a2, ${PCB0 + PCB_SIZE}
  li a3, ${'B'.charCodeAt(0)}
  jal ra, mkproc`}
  li t0, ${PCB0}
  sw t0, 0(zero)
  li t6, ${CONSOLE}
  lw t1, 16(t6)
  li t2, ${slice}
  add t1, t1, t2
  sw t1, 20(t6)
  li t1, 0x80
  csrs mie, t1
  csrw mstatus, zero
  j go_switch
# ---- trap: every register into the PCB (mscratch holds its address while a process runs)
trap:
  csrrw t0, mscratch, t0
${save}
  csrr t1, mscratch
  sw t1, 20(t0)
  csrw mscratch, t0
  csrr t1, mepc
  sw t1, 0(t0)
trap_saved:
  csrr t1, mcause
  bltz t1, schedule
  li t2, 8
  bne t1, t2, fault
# ---- a system call: step over the ecall, then dispatch on a7
  lw t1, 0(t0)
  addi t1, t1, 4
  sw t1, 0(t0)
  li t2, ${SYS.putchar}
  beq a7, t2, sys_putchar
  li t2, ${SYS.write}
  beq a7, t2, sys_write
  li t2, ${SYS.yield}
  beq a7, t2, schedule
  li t2, ${SYS.exit}
  beq a7, t2, sys_exit
${T ? threadDispatch() : ''}${D ? `  li t2, ${EXEC_SYS}
  beq a7, t2, sys_exec
` : ''}  li t2, -1
  sw t2, 40(t0)
  j go_same
sys_putchar:
  li t2, ${CONSOLE}
  sb a0, 0(t2)
  j go_same
sys_exit:
  li t2, 2
  sw t2, ${PCB.state}(t0)
${T ? threadExit() : ''}  j schedule
${T ? threadCalls() : ''}${D ? execCall() : ''}sys_write:
  li t6, ${CONSOLE}
  lw t2, ${PCB.tag}(t0)
  sb t2, 0(t6)
${say(' ')}
  mv t1, a0
  bgez t1, wr_digits
${say('-')}
  neg t1, t1
wr_digits:
${decimal('wr_')}
${say('\n')}
  j go_same
# ---- a fault in the process (illegal instruction, page fault): say so and take it off the ready list
fault:
  li t6, ${CONSOLE}
${say('!')}
  lw t2, ${PCB.tag}(t0)
  sb t2, 0(t6)
${say(' killed, cause ')}
  li t2, 10
  blt t1, t2, ft_one
${say('1')}
  addi t1, t1, -10
ft_one:
  addi t1, t1, 48
  sb t1, 0(t6)
${say('\n')}
  li t2, 2
  sw t2, ${PCB.state}(t0)
# ---- the scheduler: a fresh slice for whoever runs next, then the next ready PCB in the ring, this one included
schedule:
  li t6, ${CONSOLE}
  lw t1, 16(t6)
  li t2, ${slice}
  add t1, t1, t2
  sw t1, 20(t6)
  mv t1, t0
  li t3, 1
sc_next:
  addi t1, t1, ${PCB_SIZE}
  li t2, ${PCB0 + NPROC * PCB_SIZE}
  bltu t1, t2, sc_look
  li t1, ${PCB0}
sc_look:
  lw t2, ${PCB.state}(t1)
  beq t2, t3, sc_found
  bne t1, t0, sc_next
  j all_done
sc_found:
  lw t2, ${PCB.slices}(t1)
  addi t2, t2, 1
  sw t2, ${PCB.slices}(t1)
  beq t1, t0, go_same
  lw t2, 12(zero)
  addi t2, t2, 1
  sw t2, 12(zero)
  mv t0, t1
  sw t0, 0(zero)
${T ? `# a thread of the same address space: satp and the TLBs stay
  csrr t2, satp
  lw t1, ${PCB.satp}(t0)
  beq t1, t2, go_same
` : ''}# ---- go_switch: another address space; go_same: back into the registers in the PCB at t0
go_switch:
  lw t1, ${PCB.satp}(t0)
  csrw satp, t1
  sfence.vma zero, zero
go_same:
  csrw mscratch, t0
  lw t1, 0(t0)
  csrw mepc, t1
${load}
  lw t0, 20(t0)
  mret
all_done:
${T ? threadStuck() : ''}${say('all done\n')}
halt:
  j halt
${T ? `deadlock:\n${say('deadlock\n')}\n  j halt\n` : ''}`;
}

/** Rename every label defined in an assembly text (and its uses) with a prefix, so several programs share one source. */
export function prefixLabels(asm: string, prefix: string): string {
  const labels = new Set<string>();
  for (const l of asm.split('\n')) { const m = /^\s*([A-Za-z_.][\w.$]*):/.exec(l); if (m) labels.add(m[1]); }
  return asm.split('\n').map((line) => {
    const hash = line.indexOf('#');
    const code = hash < 0 ? line : line.slice(0, hash), tail = hash < 0 ? '' : line.slice(hash);
    return code.replace(/[A-Za-z_.][\w.$]*/g, (w, off: number) => {
      if (!labels.has(w)) return w;
      // the first word of a line that is a mnemonic never collides with a label; a quote'd character is left alone
      void off;
      return prefix + w;
    }) + tail;
  }).join('\n');
}

export interface OsImage {
  /** One assembly source: kernel, then each process at its frame of the ROM. */
  source: string;
  words: number[];
  /** Words of the kernel's code and of each process's. */
  kernelWords: number;
  procWords: number[];
  /** The kernel's labels (ROM byte addresses). */
  labels: Map<string, number>;
}

const padWords = (n: number) => (n <= 0 ? '' : Array.from({ length: Math.ceil(n / 64) }, (_, i) => `  .word ${Array(Math.min(64, n - 64 * i)).fill(0).join(', ')}`).join('\n'));

/** The ROM image: the kernel at 0, process i at ROM byte address CODE_PA[i]. A process is assembly written for VA 0x4000 (position independent: relative jumps only). */
export function osImage(procs: string[], o: KernelOptions = {}): OsImage {
  if (procs.length > NPROC) throw new Error(`the kernel has ${NPROC} process slots`);
  const kernel = kernelSource(o);
  let source = kernel;
  const kernelWords = assemble(kernel).words.length;
  if (kernelWords > CODE_PA[0] / 4) throw new Error(`the kernel is ${kernelWords} words, its frame holds ${CODE_PA[0] / 4}`);
  const procWords: number[] = [];
  procs.forEach((p, i) => {
    const have = assemble(source).words.length;
    source += `\n${padWords(CODE_PA[i] / 4 - have)}\n# ---- process ${String.fromCharCode(65 + i)}, ROM ${CODE_PA[i].toString(16)}\n${prefixLabels(p, `p${i}_`)}\n`;
    procWords.push(assemble(source).words.length - CODE_PA[i] / 4);
  });
  // an absent process gets a program that exits at once, so its slot is never a hole
  for (let i = procs.length; i < NPROC; i++) {
    source += `\n${padWords(CODE_PA[i] / 4 - assemble(source).words.length)}\n  li a7, ${SYS.exit}\n  ecall\n`;
  }
  // chapter 'linking': the executable's text, in the ROM frame its p_paddr names (exec maps it there; it is never copied)
  if (o.rom?.length) {
    const have = assemble(source).words.length;
    if (have > EXEC_ROM / 4) throw new Error(`the processes reach ROM word ${have}: the executable's frame starts at ${EXEC_ROM / 4}`);
    if (EXEC_ROM / 4 + o.rom.length > 2 ** OS_IMEM_K) throw new Error(`the executable's text is ${o.rom.length} words: the ROM ends at ${2 ** OS_IMEM_K}`);
    source += `\n${padWords(EXEC_ROM / 4 - have)}\n# ---- the executable's text, ROM ${EXEC_ROM.toString(16)}\n${o.rom.map((w) => `  .word ${w >>> 0}`).join('\n')}\n`;
  }
  const a = assemble(source);
  if (a.errors.length) throw new Error(`os image: line ${a.errors[0].line}: ${a.errors[0].message}`);
  return { source, words: a.words, kernelWords, procWords, labels: assemble(kernel).labels };
}

// ---- user programs

const spinner = (n: number, label: string) => `  li t1, ${n}\n${label}:\n  addi t1, t1, -1\n  bnez t1, ${label}`;

/**
 * Counts in its own word at VA 0x1000: adds `step` to it, writes the new value, spins for `delay` instructions' worth of loop, `n` times, then exits.
 * Two copies with different steps run on the same address and never see each other.
 */
export const counter = (step: number, n: number, delay = 120): string => `  li s0, ${VA.data1}
  li s1, ${n}
loop:
  lw t0, 0(s0)
  addi t0, t0, ${step}
  sw t0, 0(s0)
  mv a0, t0
  li a7, ${SYS.write}
  ecall
${spinner(delay, 'spin')}
  addi s1, s1, -1
  bnez s1, loop
  li a7, ${SYS.exit}
  ecall
`;

/** Prints a word with putchar, a character a call, `n` times; yields between rounds when `yields`. */
export const hello = (text: string, yields = false): string => `${[...text].map((c) => `  li a0, ${c.charCodeAt(0)}\n  li a7, ${SYS.putchar}\n  ecall${yields ? `\n  li a7, ${SYS.yield}\n  ecall` : ''}`).join('\n')}
  li a7, ${SYS.exit}
  ecall
`;

/** Says 'ok' and then reads a machine-mode register: the CPU refuses (illegal instruction) and the kernel ends the process. */
export const rogueCsr = `  li a0, 111
  li a7, ${SYS.putchar}
  ecall
  csrr t0, mstatus
  li a0, 88
  li a7, ${SYS.putchar}
  ecall
  li a7, ${SYS.exit}
  ecall
`;

/** Stores into the kernel's frame, mapped for the supervisor only (U = 0): a store page fault. */
export const rogueStore = `  li a0, 111
  li a7, ${SYS.putchar}
  ecall
  li t0, ${VA.kernel}
  li t1, 7
  sw t1, 0(t0)
  li a0, 88
  li a7, ${SYS.putchar}
  ecall
  li a7, ${SYS.exit}
  ecall
`;

/** Loads from a page that was never mapped: a load page fault. */
export const rogueLoad = `  li t0, 0x3000
  lw t1, 0(t0)
  li a7, ${SYS.exit}
  ecall
`;

/** Writes 1, 2, ... n into the word at 0x1000 and then prints the sum of what it reads back: shows that the word is its own. */
export const privateWord = (id: number): string => `  li s0, ${VA.data1}
  li s1, ${id}
  sw s1, 0(s0)
${spinner(400, 'wait')}
  lw a0, 0(s0)
  li a7, ${SYS.write}
  ecall
  li a7, ${SYS.exit}
  ecall
`;

export interface OsDemo { id: string; name: string; note: string; procs: string[]; slice?: number }
export const OS_DEMOS: OsDemo[] = [
  { id: 'rogue', name: 'A process that reaches too far', note: 'process A reads mstatus and is stopped; process B counts on', procs: [rogueCsr, counter(1, 3)] },
  { id: 'calls', name: 'System calls', note: 'putchar, write and yield', procs: [hello('Hi', true), counter(10, 3, 20)] },
  { id: 'share', name: 'Two counters', note: 'both count in the word at 0x1000; the timer takes the CPU back', procs: [counter(1, 5), counter(10, 5)] },
  { id: 'wall', name: 'The wall', note: 'process A stores into the kernel\'s frame, process B reads an unmapped page', procs: [rogueStore, rogueLoad] },
];

/** A Python-subset program as a process (src/lang compilePy with the user target): its data starts at VA 0 and its stack ends at 0x2000, both in the process's own two pages. */
export const PY_DMEM_WORDS = 2048;

/** Two processes that only compute (and touch their word at 0x1000), for measuring what a slice costs. */
export const spinner2 = `  li s0, ${VA.data1}
loop:
  lw t0, 0(s0)
  addi t0, t0, 1
  sw t0, 0(s0)
  j loop
`;
