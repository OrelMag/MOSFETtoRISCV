// Check yourself for the virtual-memory and operating-system entries (codexvm.ts): two questions each, the answer first
// (quizBox shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKVM: Record<string, Quiz[]> = {
  page: [
    {
      question: 'Pages are 4 KiB. A virtual address is translated; which bits of the physical address come from the virtual address unchanged?',
      options: ['The low 12 bits, the offset', 'The high 20 bits, the page number', 'The low 10 bits', 'None: the whole address is replaced'],
      answer: 0,
      explain: '4 KiB is 2^12 bytes, so 12 bits tell the bytes of a page apart. The page and the frame are the same size, so the byte keeps its place; only the page number is looked up.',
      why: ['', 'The page number is what translation replaces.', 'Ten bits is the size of one level\'s index in Sv32, not of the offset.', 'Then two bytes of one page could land in different frames.'],
    },
    {
      question: 'Why is memory mapped in pages and not byte by byte?',
      options: ['A table with an entry per byte would be as large as memory; one entry per 4 KiB page is 1/4096 of that', 'Because bytes cannot be addressed separately', 'Because the CPU can only read 4 KiB at a time', 'Because a page is the size of a cache line'],
      answer: 0,
      explain: 'Mapping costs an entry per unit. A page makes the table small enough to keep in memory and a cache of it (the TLB) small enough to be fast, and one entry still covers thousands of accesses.',
      why: ['', 'Bytes are addressed separately; paging is about the cost of the map.', 'The CPU reads words; a page is a unit of mapping, not of transfer.', 'A cache line is tens of bytes; a page is thousands.'],
    },
  ],
  pagetable: [
    {
      question: 'In a page-table entry V = 1, and R, W and X are all 0. What is it?',
      options: ['A pointer to the next level\'s table, if it is not at the last level', 'A page that may be read but not written', 'An invalid entry', 'A page nobody may use'],
      answer: 0,
      explain: 'R, W and X all zero is the encoding of "this does not map a page, it points to a table". The same bits at the last level are a fault, because a table can go no deeper.',
      why: ['', 'Reading needs R = 1.', 'V = 1 says the entry is valid; what is invalid is the combination at the last level.', 'A page nobody may use would be a leaf with its flags clear: the hardware reads that as a pointer.'],
    },
    {
      question: 'Why does Sv32 use two levels of 1 024 entries and not one table of 2^20?',
      options: ['A process uses little of its address space: unused 4 MiB regions need no second-level table at all', 'Two reads are faster than one', 'A single table would not fit the 32-bit address', 'The TLB needs two levels'],
      answer: 0,
      explain: 'One flat table is 4 MiB per process, nearly all of it empty. In the tree, a first-level entry that is invalid costs nothing below it, and each table is exactly one page.',
      why: ['', 'Two reads are slower; the TLB is what makes it fast.', 'The address splits into two 10-bit parts and a 12-bit offset either way; the question is the table\'s size.', 'The TLB caches whole translations and knows nothing of the levels.'],
    },
  ],
  sv32: [
    {
      question: 'What is the physical address of 0x0040_3A10 when its page maps to frame 0x80007?',
      options: ['0x8000_7A10', '0x8000_7000', '0x0040_3000', '0x8000_73A1'],
      answer: 0,
      explain: 'The frame times 4 096 is 0x8000_7000, and the offset, the low 12 bits 0xA10 of the virtual address, is added unchanged.',
      why: ['', 'That is the start of the frame: the offset was dropped.', 'That is the virtual page\'s start: the frame was not used.', 'The offset is 12 bits (three hex digits), 0xA10, not 0x3A1.'],
    },
    {
      question: 'How many memory reads does an Sv32 translation take on a TLB miss, when the leaf is at the second level?',
      options: ['Two, one entry from each table', 'One', 'Three', 'None: the TLB is read'],
      answer: 0,
      explain: 'The root entry gives the second table, and its entry gives the frame. Then the access itself follows, which is why a miss triples the cost of an access without a TLB.',
      why: ['', 'One read would find the leaf only if it were at the first level, a 4 MiB superpage.', 'The access follows the translation but is not part of it.', 'A miss, by definition, is when the TLB has no answer.'],
    },
  ],
  tlb: [
    {
      question: 'A program loops over five pages in turn. The TLB has four entries, replaced in turn. How often does it hit?',
      options: ['Never: each entry is replaced just before its page is needed again', 'Four times in five', 'Once in five', 'Always, after the first pass'],
      answer: 0,
      explain: 'Round robin over a cycle longer than the TLB throws out exactly the page needed furthest ahead, so every access misses. With four pages instead of five, only the first four would.',
      why: ['', 'That would be a hit rate if five pages fitted in four entries; they do not.', 'A hit needs the page to be still there, and each was replaced four fills ago.', 'After the first pass the pages would have to fit; five do not fit in four.'],
    },
    {
      question: 'The kernel changes a page-table entry that is already in the TLB and does nothing else. What happens?',
      options: ['The TLB keeps the old translation until it is flushed (sfence.vma, or a write to satp here)', 'The new entry is used at once', 'The CPU stalls', 'The TLB reads the page table every cycle'],
      answer: 0,
      explain: 'The TLB is a copy. It is not watching memory, so it goes on answering with what it was filled with. Flushing is the software\'s half of the contract.',
      why: ['', 'Only a walk reads the table, and a hit starts no walk.', 'Nothing stalls: the stale hit is as fast as any hit, which is why it is a bug that shows rarely.', 'It would not be a cache then; it would be the walk.'],
    },
  ],
  pagefault: [
    {
      question: 'A store takes a page fault. What is in mtval, and what in mepc?',
      options: ['mtval is the faulting virtual address; mepc is the store instruction', 'mtval is the store\'s instruction; mepc the address', 'Both are the address', 'Both are the instruction\'s address'],
      answer: 0,
      explain: 'The handler needs both: the address, to decide which page to map, in mtval; and where to resume, the instruction itself, in mepc. After mapping, mret re-runs the store.',
      why: ['', 'The two are swapped.', 'mepc is where to return, not what was accessed.', 'The address of the data is the thing the handler cannot find without mtval.'],
    },
    {
      question: 'A handler maps the missing page and returns with mret. Where does execution continue?',
      options: ['At the instruction that faulted, which now succeeds', 'At the next instruction', 'At the start of the program', 'At the handler again, always'],
      answer: 0,
      explain: 'A page fault is an exception, not an interrupt that follows an instruction: mepc names the faulting instruction itself, so mret retries it. Mapped now, it completes.',
      why: ['', 'That would skip the store (or load) and lose it.', 'Nothing in mret goes to the start; it returns to mepc.', 'It would loop only if the handler had not fixed the mapping.'],
    },
  ],
  privmode: [
    {
      question: 'A user program executes csrr t0, mstatus. What happens?',
      options: ['An illegal-instruction trap into the kernel', 'It reads mstatus', 'It reads zero', 'A page fault'],
      answer: 0,
      explain: 'A CSR above the current mode is refused by the instruction itself. The trap goes to machine mode, and the kernel decides what to do with the process.',
      why: ['', 'Then any program could read (and with csrw, change) the machine\'s state.', 'Silently returning zero would let a program believe it knew.', 'CSRs are numbers, not addresses; no page table is consulted.'],
    },
    {
      question: 'How does a program get into U mode in the first place?',
      options: ['The kernel sets mstatus.MPP to U and executes mret', 'A program writes the privilege register', 'The CPU starts in U mode', 'By ecall'],
      answer: 0,
      explain: 'The mode is only set by a trap (up to M) and by mret (to MPP). So the kernel arranges the state it wants and returns into the program, which cannot undo it.',
      why: ['', 'The register cannot be written by instructions; if it could, protection would be a request.', 'The CPU starts in the most privileged mode, M.', 'ecall goes up, to the kernel, not down.'],
    },
  ],
  syscall: [
    {
      question: 'Which register carries the system call number in the chapter\'s kernel?',
      options: ['a7', 'a0', 'ra', 'sp'],
      answer: 0,
      explain: 'The number goes in a7 and the argument in a0, the RISC-V convention the kernel follows: 1 prints a character, 2 a number, 3 yields, 93 ends the process.',
      why: ['', 'a0 carries the first argument and gets the result.', 'ra holds the return address of a call; ecall has no use for it.', 'sp is the stack pointer and must come back as it was.'],
    },
    {
      question: 'Why does a system call cost more than a function call?',
      options: ['It is a trap and a return, and the kernel first saves the registers, since the CPU saved only the PC', 'It needs a bigger instruction', 'It copies the whole program', 'It disables the cache'],
      answer: 0,
      explain: 'A trap saves nothing but the PC, so the kernel stores the registers it will use before doing anything, loads them back and returns with mret: tens to hundreds of cycles against a few for a call.',
      why: ['', 'ecall is one 32-bit instruction like any other.', 'Nothing of the program is copied: the kernel reads it through its arguments.', 'The caches stay as they are.'],
    },
  ],
  process: [
    {
      question: 'Two processes both store to virtual address 0x1000. Why do they not overwrite each other?',
      options: ['Each has its own page table, and satp points at the running process\'s', 'The kernel copies the page at each switch', 'The assembler gave them different addresses', 'The scheduler never runs them together'],
      answer: 0,
      explain: 'The address is a key into the running process\'s table. Two tables map one key to two frames, and a switch changes the table (and forgets the cached translations).',
      why: ['', 'Copying would work and cost thousands of cycles; a switch changes one register.', 'The same addresses are the point.', 'Taking turns alone would leave both in the same frame.'],
    },
    {
      question: 'A process is not running. Where is it?',
      options: ['In memory: its control block holds the registers and PC, and its frames hold its data', 'In the CPU\'s registers', 'In the TLB', 'In the timer'],
      answer: 0,
      explain: 'A switch saves everything the CPU held into the block, so nothing of the process is in the CPU. The block and its page tables and frames are all that is left of it between slices.',
      why: ['', 'The registers belong to whichever process runs.', 'The TLB holds translations, and the switch forgets them.', 'The timer only counts.'],
    },
  ],
  ctxswitch: [
    {
      question: 'The timer interrupt arrives. Why can the handler not simply start with sw ra, 0(t0)?',
      options: ['It has no register that is free: every one still holds the interrupted process\'s value, t0 included', 'sw cannot be used in a handler', 'The stack pointer is invalid', 'mepc must be saved first'],
      answer: 0,
      explain: 'A register used as a base address is overwritten, and its old value is lost. A swap with mscratch (csrrw) is the way in: one instruction both gives the handler a pointer and parks the process\'s value.',
      why: ['', 'Stores are fine in a handler.', 'The stack may not even be valid, which is why the block is addressed by a pointer.', 'mepc is saved with the rest; it is not the first problem.'],
    },
    {
      question: 'Which of these must a context switch change to run the next process?',
      options: ['The registers, the resume address (mepc) and, with paging, satp', 'Only the program counter', 'Only satp', 'The kernel\'s code'],
      answer: 0,
      explain: 'The state of the process is its registers and PC, and its address space is named by satp. Everything else (the kernel, the frames) stays where it is.',
      why: ['', 'The registers would then hold the old process\'s values.', 'Without the registers the next process would run on the wrong data.', 'The kernel is shared and unchanged.'],
    },
  ],
  scheduler: [
    {
      question: 'The slice is ten times longer. What happens?',
      options: ['The share of cycles lost to switching falls to about a tenth, and a ready process waits about ten times longer', 'Both stay the same', 'Both fall', 'The share rises'],
      answer: 0,
      explain: 'A switch costs about the same whatever the slice, and it happens a tenth as often. A ready process waits for the others\' whole slices, so its wait grows with them.',
      why: ['', 'How often a switch is paid for is exactly what the slice changes.', 'The wait grows with the slice.', 'Fewer interrupts mean fewer switches.'],
    },
    {
      question: 'A process loops forever and never gives up the CPU. What stops it from taking all of it?',
      options: ['The timer interrupt: the kernel arms it at every switch, and the handler takes the CPU away', 'Nothing', 'It yields by itself', 'The assembler'],
      answer: 0,
      explain: 'Preemption: the process does not have to cooperate, because the interrupt comes from outside the program and the kernel runs at the end of every slice.',
      why: ['', 'Without a timer, a program that never yields would own the machine.', 'It never does; that is the premise.', 'The assembler has no part in running a program.'],
    },
  ],
};
