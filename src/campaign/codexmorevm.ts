// The fuller codex texts for the virtual-memory and operating-system entries (codexvm.ts). Numbers are the chapters' own,
// measured on the gates and the kernel and pinned by tests/content-codexvm.test.ts.

import type { CodexMore } from './codexmore';

const vmem = (step: number, label: string) => ({ chapter: 'vmem', step, label });
const os = (step: number, label: string) => ({ chapter: 'os', step, label });

export const MOREVM: Record<string, CodexMore> = {
  page: {
    idea: `Memory is mapped a page at a time because mapping every byte separately would need a table as large as memory. A 4 KiB page needs a 12-bit offset; the rest of the address, the page number, is what translation replaces. So the translation unit is small enough to give each program a little of what it needs and large enough that one table entry covers thousands of accesses.<br>Both sides use the same size: a virtual page and the physical <b>frame</b> it maps to. Pages that are not mapped cost nothing, which is why a program can have an enormous address space and use a few megabytes of it.`,
    example: {
      title: 'Splitting 0x0040_3A10',
      body: `<pre>0x0040_3A10 = 0000 0000 0100 0000 0011 1010 0001 0000
page number = bits 31:12 = 0x00403    offset = bits 11:0 = 0xA10
frame 0x80007 → physical address 0x8000_7A10: the offset 0xA10 is copied</pre>The page number is the key to the page table; the offset is never looked at.`,
    },
    mistakes: [
      'Thinking neighbouring virtual pages are neighbours in memory: each maps to a frame chosen by the kernel.',
      'Mixing up the two sizes of "page": 4 KiB is the unit of mapping, not the unit of the program\'s own data.',
    ],
    chapters: [vmem(1, 'Pages: a number and an offset')],
  },
  pagetable: {
    idea: `A page table is the memory's address book for one process. The hardware only reads it; the kernel writes it. An entry holds a frame number and flags: <b>V</b> valid (else the rest is ignored), <b>R W X</b> what the program may do, <b>U</b> whether user mode may, <b>A</b> and <b>D</b> accessed and dirty. An entry with R, W and X all zero does not map a page: it points to the next table.<br>One flat table for 2<sup>20</sup> pages would be 4 MiB per process, mostly empty. Two levels of 1 024 entries make a table exactly one page long, and a second-level table is needed only for the 4 MiB of address space that has something in it.`,
    example: {
      title: 'Two levels at RV16 scale',
      body: `<pre>address  = vpn1 (4 bits) · vpn0 (4 bits) · offset (8 bits)
table    = 16 words at {PPN, 0000}
level 1  = word at {root, vpn1}    V=1, R=X=0 : a pointer, PPN = the next table
level 0  = word at {table, vpn0}   V=1, R or X : a leaf, PPN = the frame</pre>The campaign's walker (level y_walk) does exactly this, a level a cycle.`,
    },
    mistakes: [
      'Treating the table as a cache: it is the truth, and the TLB is the copy that can go stale.',
      'Forgetting the "points to a table" encoding: V = 1 with R = W = X = 0 is a pointer, and at the last level it is a fault.',
    ],
    lib: 'rv16_walker',
    chapters: [vmem(2, 'The page-table entry'), vmem(3, 'The Sv32 walk: two reads before the real one')],
  },
  sv32: {
    idea: `The VPN[1] indexes the root table found through <code>satp</code>; the entry read there is, in the common case, a pointer. VPN[0] indexes the table it points to, and that entry is the leaf. The leaf's 22-bit frame number and the 12-bit offset make the 34-bit physical address.<br>A leaf found at the first level is a <b>megapage</b> (4 MiB): its frame must be aligned, and the second 10 bits of the address pass through as part of the offset. The system CPU of the chapter splits one into the single 4 KiB page asked for before putting it in the TLB, so a TLB entry is always keyed by the whole 20-bit page number.`,
    example: {
      title: 'Translating 0x0040_3A10',
      body: `<pre>VPN[1] = bits 31:22 = 0x001    VPN[0] = bits 21:12 = 0x003    offset = 0xA10
1. read root[0x001]  at satp.PPN × 4096 + 0x001 × 4  → a pointer
2. read table[0x003]                                 → the frame and R W X U
3. physical = frame × 4096 + 0xA10</pre>`,
    },
    mistakes: [
      'Assuming a walk always takes two reads: a megapage ends at the first level, and a missing first-level entry ends it with a fault.',
      'Leaving A or D zero in a leaf on hardware that does not set them itself: this CPU treats the access as a page fault, and software must set them.',
    ],
    chapters: [vmem(3, 'The Sv32 walk: two reads before the real one'), vmem(4, 'The walker in gates')],
  },
  tlb: {
    idea: `Each entry holds a page number, the frame it maps to and the flags. A lookup compares the page number of the access with all four at once, and the one that matches (priority encoder, multiplexers) delivers frame and flags. No match is a miss, and the walker is started. Four entries replaced in turn is the cheapest rule: no age is kept.<br>A TLB is a content-addressable memory like a cache's tag array, but with no data beyond the translation. Its effect depends on the working set: a loop that touches four pages or fewer misses only on its first pass, and one that touches five in turn with four round-robin entries misses every time, because each entry is replaced just before it is needed again.`,
    example: {
      title: 'Five pages in turn, four entries',
      body: `<pre>pages 1 2 3 4 5 1 2 3 4 5 …     entries replaced 0 1 2 3 0 1 2 3 …
1 2 3 4 miss, fill entries 0-3
5 misses, replaces 1 (entry 0)      then 1 misses, replaces 2, and so on
every access misses; 4 pages would miss four times in all</pre>`,
    },
    mistakes: [
      'Filling a page that is already in the TLB: two entries then answer one key, and which one wins depends on the pointer.',
      'Changing a page table and not flushing: the TLB keeps the old translation until <code>sfence.vma</code> (here also any write to <code>satp</code>).',
      'Flushing on a fill by accident: a flush wins over a fill on the same edge.',
    ],
    lib: 'rv16_tlb',
    anatomy: [],
    chapters: [vmem(5, 'The TLB: remembering translations')],
  },
  pagefault: {
    idea: `The hardware cannot continue an access it cannot translate, so it does what it does for any exception: no register is written, nothing is stored, and the CPU traps with <code>mepc</code> = the instruction and <code>mtval</code> = the virtual address. The cause says which access: 12, 13 or 15. The handler is ordinary code in the kernel.<br>For a page the process is entitled to but that is not mapped yet, the handler allocates a frame, writes the entry, executes <code>sfence.vma</code> and returns with <code>mret</code>: the instruction runs again and now succeeds. That is demand paging. For a page the process may not touch, the handler ends the process, as a wrong address in a C program does.`,
    example: {
      title: 'A store to an unmapped page',
      body: `<pre>sw a0, 0(t0)        t0 = 0x0000_5004, no entry
trap: mcause = 15, mtval = 0x0000_5004, mepc = the sw
handler: map 0x5000 to a free frame, sfence.vma, mret
sw runs again: walk (3 cycles of stall), fill, hit</pre>`,
    },
    mistakes: [
      'Returning without fixing anything: the instruction faults again at once, forever.',
      'Reading the page from <code>mepc</code>: it holds the instruction, and the address is in <code>mtval</code>.',
      'Expecting a fault to leave a TLB entry: a walk that finds a fault fills nothing.',
    ],
    chapters: [vmem(6, 'Page faults: mapping on demand'), vmem(7, 'Protection: U, R, W and X')],
  },
  privmode: {
    idea: `Protection needs a CPU that can tell a program it trusts from one it does not. The privilege register is that distinction: in <b>M</b> mode every instruction and register is available; in <b>U</b> mode a CSR access is an illegal instruction, and with paging on, a load, store or fetch works only on a page the table gives to U. The register is changed only by a trap (to M) and by <code>mret</code> (to the mode in <code>mstatus.MPP</code>), so a program cannot raise its own rank.<br>The kernel therefore sets up the tables, writes MPP, loads the program's registers and executes <code>mret</code>: the CPU is in U mode at the first instruction of a program that cannot undo it.`,
    example: {
      title: 'What a user program may not do',
      body: `<pre>csrr t0, mstatus     U mode  → illegal instruction (cause 2)
lw   t0, 0(t1)       page without U → page fault (cause 13)
ecall                → trap to M (cause 8): the one door that is open</pre>`,
    },
    mistakes: [
      'Believing a bug in a user program can corrupt the kernel on this hardware: it can only ask for it, by ecall, and the kernel decides.',
      'Forgetting that M mode is not translated: kernel addresses are physical.',
    ],
    chapters: [os(1, 'User mode: what a program may not do'), vmem(7, 'Protection: U, R, W and X')],
  },
  syscall: {
    idea: `A system call is a deliberate trap. <code>ecall</code> in U mode raises cause 8 and jumps to the kernel's handler, which reads the number in a7 (here 1 puts a character, 2 writes a number, 3 yields, 93 exits), does the work with the arguments in a0, puts the result in a0 and returns with <code>mret</code>. For the program it looks like a function call whose body it cannot see, and it is the only one that crosses the privilege boundary.<br>The kernel treats the arguments as untrusted: an address must be checked to lie in the process's own pages before it is used.`,
    example: {
      title: 'Print a character',
      body: `<pre>li a0, 'H'
li a7, 1            call number
ecall               trap → kernel saves registers, writes the console, mret
                    next instruction runs in U again</pre>`,
    },
    mistakes: [
      'Forgetting the kernel\'s own register save: the trap saves only the PC.',
      'Trusting a pointer argument without checking that it is the caller\'s: a program could pass the kernel\'s address.',
    ],
    chapters: [os(2, 'System calls: ecall with a number in a7')],
  },
  process: {
    idea: `The program is text; the process is the program running, with everything that is its own. The kernel keeps a process control block per process: the 31 registers and the PC saved when it is not running, a page-table root (the value for <code>satp</code>), a state, and whatever the kernel needs to find it again. Everything else is shared: the CPU, the kernel's code and the memory frames.<br>Two processes can use the same virtual address and never meet, because each address is only a key into its own table. The block is all that remains of a process between two slices.`,
    example: {
      title: 'The same address in two processes',
      body: `<pre>A stores a 7 at 0x1000: its page table maps that page to frame F<sub>A</sub>
B stores a 9 at 0x1000: its page table maps it to frame F<sub>B</sub>
switch: satp ← B's root; the TLB forgets A's translations</pre>`,
    },
    mistakes: [
      'Mixing up a process with a thread: a thread shares its process\'s address space and has its own registers; this kernel has no threads.',
      'Believing the control block is the process\'s memory: it holds the state the kernel needs, and the program\'s data stay in its own frames.',
    ],
    chapters: [os(0, 'One CPU, two programs: what the kernel is for'), os(3, 'The process control block and the context switch'), os(5, 'Separate address spaces: satp per process')],
  },
  ctxswitch: {
    idea: `A switch is a trap handler that does not return where it came from. At entry the registers are the interrupted process's and the handler has none to spare, so it starts with <code>csrrw</code> on <code>mscratch</code>: the register becomes the address of the running block (the kernel keeps it there while a process runs) and the process's own value is parked in the CSR. It saves the rest through that register, takes the parked value and <code>mepc</code>, chooses the other block, loads its <code>mepc</code>, its registers, and swaps once more so the register is the process's own again. The campaign's level p_switch does it with sp. <code>mret</code> then resumes it in the middle of an instruction stream it has not seen since its last slice.<br>On the system CPU the switch also writes <code>satp</code> and so forgets the cached translations: the new process pays its first accesses in walks.`,
    example: {
      title: 'The chapter\'s kernel',
      body: `<pre>save 37 instructions   choose 23 instructions   restore 38 instructions
99 instructions in all (with mret), 102 cycles from the timer interrupt to the next process's first instruction</pre>`,
    },
    mistakes: [
      'Saving the registers after using one: the first register you touch holds the interrupted process\'s value, which is gone.',
      'Forgetting <code>mepc</code>: the new process resumes at the old one\'s address.',
      'Acknowledging the timer late: the interrupt is taken again at once after <code>mret</code>.',
    ],
    chapters: [os(3, 'The process control block and the context switch'), os(4, 'Two programs, one CPU: the timer decides')],
  },
  scheduler: {
    idea: `Round robin keeps the control blocks in a ring. At every timer interrupt the kernel looks for the next block that is ready, in ring order, and switches to it; a process that has ended is marked gone and skipped. The timer is rearmed one slice ahead at every switch, so a process that never yields still loses the CPU after its slice.<br>The slice trades two costs. Each switch costs the same, so the share of cycles spent switching falls as the slice grows; and a ready process waits for the others' whole slices, so the delay it sees grows with it.`,
    example: {
      title: 'Price of the slice',
      body: `<pre>slice (instructions)   share of the cycles lost to switching and TLB refills
600                      16 %
the shortest in the table 70.8 %      the longest 0.8 %</pre>Measured on the kernel's own switch (chapter table).`,
    },
    mistakes: [
      'Choosing the slice by how fast a switch is: the TLB refill after it is a large part of the price.',
      'Letting a process that waits for something stay in the ring: it is switched to, finds nothing, and yields at once.',
    ],
    chapters: [os(4, 'Two programs, one CPU: the timer decides'), os(6, 'What sharing costs')],
  },
};
