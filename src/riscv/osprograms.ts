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
}

/** The kernel's assembly. Its sections are labelled: the chapter's widgets and the tests count instructions between labels. */
export function kernelSource(o: KernelOptions = {}): string {
  const slice = o.slice ?? OS_SLICE;
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
  li a0, ${ROOT_OF[0]}
  li a1, ${CODE_PA[0]}
  li a2, ${PCB0}
  li a3, ${'A'.charCodeAt(0)}
  jal ra, mkproc
  li a0, ${ROOT_OF[1]}
  li a1, ${CODE_PA[1]}
  li a2, ${PCB0 + PCB_SIZE}
  li a3, ${'B'.charCodeAt(0)}
  jal ra, mkproc
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
  li t2, -1
  sw t2, 40(t0)
  j go_same
sys_putchar:
  li t2, ${CONSOLE}
  sb a0, 0(t2)
  j go_same
sys_exit:
  li t2, 2
  sw t2, ${PCB.state}(t0)
  j schedule
sys_write:
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
# ---- go_switch: another address space; go_same: back into the registers in the PCB at t0
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
${say('all done\n')}
halt:
  j halt
`;
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
