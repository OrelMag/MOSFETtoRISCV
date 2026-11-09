import { systemCpu } from '../lib/system';
import { mmu, pcheck, tlb, walker } from '../lib/vm';
import { withoutParts } from '../lib/tech';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import { stats } from '../sim/stats';
import { groupDigits } from '../sim/numfmt';
import { runVmModel } from '../riscv/vmrun';
import { SUPER_CYCLES, VM_DMEM_K, VM_GUARD, VM_IMEM_K, VM_PAGER, VM_WALK, WALK_CYCLES } from '../riscv/vmprograms';
import { cpuScene } from '../widgets/cpupanel';
import { costWidget, placement, pteWidget, spacesWidget, vaWidget, walkWidget } from '../widgets/vmem';
import type { Scene } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

const nd = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const n = groupDigits;

/** The numbers the prose quotes, all counted or measured here (tests/content-vmem.test.ts pins them). */
export interface VmFigures {
  tlbI: number; tlbD: number; walker: number; mmu: number; permitI: number; permitD: number;
  /** The system CPU of chapters 19–20 and its virtual-memory variant, program ROM left out. */
  base: number; vm: number;
  basePeriod: number; vmPeriod: number;
  /** The virtual-memory CPU as the scenes build it (256-word program ROM, 4 096-word data memory): its clock period. */
  scenePeriod: number;
  /** Delays the instruction side's and the data side's translation add on the critical path. */
  fetchLookup: number; dataLookup: number;
}
let figs: VmFigures | undefined;
export function vmFigures(): VmFigures {
  if (figs) return figs;
  const b = systemCpu([], {}), v = systemCpu([], { vm: true });
  const core = (d: typeof b) => stats(withoutParts(d, ['imem'])).nands;
  const tb = analyzeTiming(flatten(b, { mode: 'gate' }))!, tv = analyzeTiming(flatten(v, { mode: 'gate' }))!;
  const ts = analyzeTiming(flatten(systemCpu([], { vm: true, imemK: VM_IMEM_K, dmemK: VM_DMEM_K }), { mode: 'gate' }))!;
  const at = (r: typeof tv, inst: string, nth = 0) => r.stages.filter((s) => s.inst === inst)[nth]?.arrival ?? 0;
  figs = {
    tlbI: nd(tlb('i')), tlbD: nd(tlb('d')), walker: nd(walker()), mmu: nd(mmu()), permitI: nd(pcheck('i')), permitD: nd(pcheck('d')),
    base: core(b), vm: core(v), basePeriod: tb.period, vmPeriod: tv.period, scenePeriod: ts.period,
    fetchLookup: at(tv, 'mmu', 0) - at(tv, 'pc'), dataLookup: at(tv, 'mmu', 1) - at(tv, 'alu'),
  };
  return figs;
}
const F = vmFigures();

// the three programs, run on the golden model with the TLB model's walks (riscv/vmrun.ts; the gates agree: tests/vm-chapter.test.ts)
const RUN = { walk: runVmModel(VM_WALK), pager: runVmModel(VM_PAGER), guard: runVmModel(VM_GUARD) };
const hex = (v: number) => '0x' + (v >>> 0).toString(16).toUpperCase();
/** The scene: the virtual-memory CPU running a chapter program, the stage opened on `path` with `highlight` lit there. */
const vmScene = (source: string, path: string[], highlight: string[]): Scene => ({ ...cpuScene({ vm: true, source, highlight }), path, autoClock: false, noRemix: true });

const P = placement('base', true), Q = placement('paging', true);

export const chVmem: Chapter = {
  id: 'vmem', num: numOf('vmem'), title: 'Virtual memory', level: 'System',
  blurb: 'Every program gets addresses of its own: Sv32 page tables, a walker in gates, TLBs, and the page fault that maps a page on demand.',
  goals: [
    'explain why two programs cannot share one address space, and what a page table gives each program of its own',
    'translate an address by hand through Sv32\'s two levels of page table, bit by bit, from satp to the physical address',
    'say what a TLB remembers, and what a miss costs in cycles on the gates',
    'follow a page fault: the trap, mtval, a handler that maps the page, the retry',
  ],
  builds: ['traps', 'cache'],
  recap: {
    keep: [
      'A program is compiled for addresses of its own. Translation makes them true: the hardware turns every virtual address into a physical one on every fetch, load and store, so two programs can both use address 0 and never meet.',
      'Sv32 cuts a 32-bit address into VPN[1] (10 bits), VPN[0] (10 bits) and a 12-bit offset. Each table is 1 024 entries of 4 bytes, one page; the offset passes through unchanged. The walk is two reads, root then second table, before the access itself.',
      'A page-table entry is a physical page number and flags: V R W X U G A D. R, W, X and U decide who may do what; A and D must be set by software on this hardware, or the access faults.',
      `The walker is a four-state machine on the data-memory port that stalls the CPU: ${WALK_CYCLES} cycles to a 4 KiB leaf, ${SUPER_CYCLES} to a 4 MiB superpage or an empty root entry. The result goes into a TLB, so the next access to the page costs nothing.`,
      `The TLB is a small content-addressable memory keyed by the virtual page number: ${n(F.tlbI)} NANDs for the instruction side and ${n(F.tlbD)} for the data side at 4 entries. sfence.vma, or a write to satp, forgets every entry; forgetting it after editing a page table is the classic bug.`,
      'A page fault is a trap (cause 12 fetch, 13 load, 15 store) with mtval = the faulting virtual address and mepc = the instruction. A handler that maps the page and executes sfence.vma and mret makes the instruction run again, this time to completion.',
    ],
    practise: [],
    check: [
      {
        question: 'A user program loads from virtual address 0x0000_5004 and the translation succeeds. Which part of that address is copied unchanged into the physical address?',
        options: ['The low 12 bits, 0x004', 'The top 10 bits, VPN[1]', 'The middle 10 bits, VPN[0]', 'Nothing: the whole address is replaced'],
        answer: 0,
        explain: 'Pages are 4 KiB, so the low 12 bits are the byte inside the page. The page tables replace only the 20-bit page number above them (VPN[1] and VPN[0] pick table entries, the entry supplies the physical page number).',
        why: ['', 'VPN[1] is an index into the root table; its job is over once the entry is read.', 'VPN[0] is an index into the second table; it too only selects an entry (except in a 4 MiB superpage, where it joins the offset).', 'The offset has no reason to change: the physical page is the same size, so the byte keeps its place inside it.'],
      },
      {
        question: `A program walks a 16-page array one word per page, round and round, with 4 TLB entries replaced in turn. What happens to the miss rate when the TLB grows to 8 entries?`,
        options: ['It stays at 100 % until the TLB has 16 entries', 'It halves', 'It falls to the cold misses only', 'It does not change: a miss costs the same however large the TLB'],
        answer: 0,
        explain: 'Round-robin replacement over a cyclic stream throws out exactly the page needed furthest ahead, so any TLB smaller than the working set misses every access; 8 entries are still smaller than 16 pages. Only when the working set fits does the miss rate fall to the first-touch misses.',
        why: ['', 'Nothing halves: a cyclic pattern that does not fit misses on every access, whatever the size short of the working set.', 'That happens only when the entries hold all 16 pages.', 'The cost of one miss is the same (a walk), but how often it happens is exactly what the size changes, once it covers the working set.'],
      },
      {
        question: 'The handler of a page fault writes a new page-table entry and returns with mret, but leaves out sfence.vma. On this hardware, what can go wrong?',
        options: ['Nothing: a walk that finds no valid entry fills no TLB entry, so no stale one exists for that page', 'The new mapping is ignored forever', 'The CPU stalls', 'The walker writes the entry back wrongly'],
        answer: 0,
        explain: 'The walk that faulted filled no entry (a walk that finds no valid entry leaves both TLBs as they were), so the retry walks again and finds the new entry. The omission bites when an entry already in the page table is changed or removed: a TLB may still hold the old translation until sfence.vma. A handler should still issue it, because the specification does not promise what a TLB caches.',
        why: ['', 'It is not ignored: the next walk reads the new entry from memory.', 'A stall lasts only as long as a walk (a few cycles).', 'The walker is read-only; it never writes a page table (software sets A and D).'],
      },
    ],
  },
  steps: [
    {
      title: 'Two programs, one memory',
      body: `
        <p>A program is built for an address space: its code at one address, its data at another, a stack at the top. Two programs built that
        way both start at address 0. Put them in one memory and the second one's first store lands on the first one's data. The programs did
        nothing wrong; the machine gave them the same addresses.</p>
        <p>The oldest fix is a <strong>base register</strong>: every address the program issues is added to a number the machine holds for it, so
        program B's address 0 is physical 0x4000. It works, and it protects: a limit register refuses addresses beyond the program's size. It
        costs one adder in the address path. What it cannot do is move a program in pieces. Each program must sit in one contiguous run of memory,
        and after programs have come and gone the free space is scattered: in the widget, three frames are free but not three in a row, so a third
        program does not fit though there is room.</p>
        <p><strong>Paging</strong> removes the restriction by translating in small, equal blocks. Memory is cut into <em>frames</em> of 4 KiB; a
        program's address space into <em>pages</em> of the same size; a <strong>page table</strong> says which frame holds each page. A program
        needing three pages takes any three free frames, and its addresses stay in a row, because the table, not the memory, keeps them in
        order. That is virtual memory: addresses the program uses (<em>virtual</em>), addresses the memory chips see (<em>physical</em>), and
        a table between them that the operating system fills in and the hardware reads on every access.</p>
        <p>The rest of the chapter builds that table-reading hardware on the system CPU of chapter ${numOf('traps')}, in gates: a walker that reads
        the table, two small caches of its answers, and the page fault when an address has no frame. Chapter ${numOf('cache')}'s caches already
        hid the speed of memory; this hides where it is.</p>`,
      widget: spacesWidget,
      challenge: {
        kind: 'quiz',
        question: 'Three frames are free, but not next to each other. A base register and a paged table are each asked to place a program of three pages. What happens?',
        options: ['The base register cannot (it needs one contiguous run); the page table can', 'Both succeed', 'Both fail', 'The page table cannot: the pages of a program must be contiguous in the frames'],
        answer: 0,
        explain: `With a base register a program is one block of consecutive addresses, so it needs consecutive frames. A page table maps each page separately: ${P.note} ${Q.note}`,
        why: ['', 'The base register adds one number to every address, so the program must be contiguous in memory: the scattered frames are no use to it.', 'The table does not need the frames to be adjacent; it maps each page on its own.', 'It is the table that frees the frames from being in a row: consecutive virtual pages may sit in unrelated frames.'],
      },
    },
    {
      title: 'Pages: a number and an offset',
      body: `
        <p>The table needs a key. Sv32, RISC-V's scheme for 32-bit machines, cuts the 32-bit virtual address in two: the low <strong>12 bits</strong> are
        the <em>offset</em>, the byte's place inside a 4 KiB page, and the other <strong>20</strong> are the <em>virtual page number</em>. The offset is
        never translated; the page number is.</p>
        <p>A flat table with one entry per page number would have ${n(2 ** 20)} entries of 4 bytes, ${(2 ** 20 * 4) / 2 ** 20} MiB for every program, almost all of it
        for pages the program never touches. Sv32 splits the page number again, 10 bits and 10 bits: <strong>VPN[1]</strong>
        indexes a <em>root table</em>, <strong>VPN[0]</strong> a <em>second table</em> that the root entry points to. Each table has ${1 << 10} entries of 4 bytes,
        ${(1 << 10) * 4} bytes: exactly one page, so tables are allocated and moved like any other page. A program using a few
        pages needs one root table and a second table or two, a few pages of tables instead of ${(2 ** 20 * 4) / 4096}.</p>
        <p>Physical addresses are 34 bits in Sv32 (a 22-bit physical page number and the 12-bit offset), two more than the processor's registers. The scenes' data memory is four frames,
        so the extra bits only show in the page-table entries.</p>
        <div class="try">Flip bits in the widget, or type an address: the three coloured fields are what the next steps read.</div>`,
      widget: vaWidget,
      challenge: {
        kind: 'quiz',
        question: 'How many bytes of page table does a program need if it uses a single page, at virtual address 0x0000_1000?',
        options: ['Two tables of 4 096 bytes: a root table and one second table', 'One table of 4 096 bytes', '4 MiB, the flat table', '8 bytes: two entries'],
        answer: 0,
        explain: `The root table must exist (its address is in satp) and so must the second table its entry points to, even if only one entry in each is used: 2 × ${(1 << 10) * 4} bytes. A flat table would be ${(2 ** 20 * 4) / 2 ** 20} MiB.`,
        why: ['', 'One table can hold the root entry, but the leaf entry that names the frame lives in a second table.', 'That is the cost of not splitting the page number; the second level exists to avoid it.', 'The entries are 4 bytes each, but they live in whole tables of 1 024 entries; a table is allocated as a page.'],
      },
    },
    {
      title: 'The page-table entry',
      body: `
        <p>A table entry is one 32-bit word: a <strong>physical page number</strong> in bits 31:10 (22 bits, so 4 KiB frames anywhere in 16 GiB), two bits left
        to software, and eight flag bits. Everything the hardware needs to decide an access sits in them:</p>
        <ul>
          <li><strong>V</strong>, valid. Zero means the entry is empty; any walk that reaches it faults.</li>
          <li><strong>R W X</strong>: read, write, execute. With all three zero the entry is not a page but a <em>pointer</em> to the next table, which is how a root entry
          points at a second table. W without R is reserved and faults.</li>
          <li><strong>U</strong>: a user page. User mode may touch only U pages; supervisor mode may not fetch from one and, unless a status bit allows it, may not
          load from one either. That is the wall between the programs and the operating system.</li>
          <li><strong>G</strong>, global: for translations shared by every address space. This hardware ignores it.</li>
          <li><strong>A</strong> and <strong>D</strong>, accessed and dirty. A machine may set them in hardware; this one does not. Software sets A when it maps a page; D when a
          store should be allowed, so a store to a page with D = 0 faults, and a handler can note that the page changed. The walker only ever reads memory.</li>
        </ul>
        <p>The table in the widget is the rule the golden model applies, for each mode and each kind of access; hover a cell for the first rule that says no. Try
        <em>Not yet touched</em>: a page with A = 0 is mapped but refused until software marks it, a standard trick for finding which pages a program uses.</p>`,
      widget: pteWidget,
      challenge: {
        kind: 'quiz',
        question: 'A page-table entry has V, R, X, A set and U clear. Which access succeeds?',
        options: ['A supervisor-mode fetch', 'A user-mode fetch', 'A supervisor-mode store', 'A user-mode load'],
        answer: 0,
        explain: 'U = 0 makes it a supervisor page, so user mode is refused whatever R, W, X say; X = 1 allows the fetch. W is 0, so no store; and a user load would be refused by U.',
        why: ['', 'U = 0: the page belongs to supervisor mode, and user mode faults on it.', 'W = 0: nothing may store to this page.', 'U = 0 again: user mode may use only pages with U = 1.'],
      },
    },
    {
      title: 'The Sv32 walk: two reads before the real one',
      body: `
        <p>The processor holds the address of the root table in the <strong>satp</strong> register (a mode bit and a 22-bit physical page number), and the operating system
        changes it to change address spaces. For one access the hardware does this:</p>
        <ol>
          <li>Read the word at root + VPN[1] × 4. If it is a pointer (R = W = X = 0), take its page number as the second table's address.</li>
          <li>Read the word at second table + VPN[0] × 4. If it is a valid leaf and the flags allow the access, its page number is the frame.</li>
          <li>The physical address is the frame's page number, then the offset, unchanged.</li>
        </ol>
        <p>So an access costs <em>two</em> memory reads before the one the program asked for. A leaf found in the first read ends the walk early: it maps a
        <strong>4 MiB superpage</strong>, where VPN[0] is not a table index but just ten more offset bits, and the walk costs one read less (${SUPER_CYCLES} cycles on the gates
        against ${WALK_CYCLES}). Any rule broken on the way, an empty entry, a forbidden access, a page number past what the memory can hold, ends in a <strong>page fault</strong>
        and the walk produces no address.</p>
        <p>Every value in the widget is the golden model's own <code>walk()</code> on a page table built in its memory, the function the gates are checked against after every
        instruction. Step through the five addresses: the first is an ordinary user page; the others stop early, one by one, in the ways the next steps need.</p>`,
      widget: walkWidget,
      challenge: {
        kind: 'quiz',
        question: 'A load goes through Sv32 with nothing cached. How many memory reads does it make in all, to a normal 4 KiB page?',
        options: ['3: root entry, second-table entry, the data', '1', '2', '4'],
        answer: 0,
        explain: 'Two page-table reads and then the access itself. That tripling of memory traffic, on every fetch and every load and store, is why a cache of translations exists (step 6).',
        why: ['', 'One read would need a single flat table; Sv32 has two levels.', 'Two are the page-table reads; the access the program asked for is a third.', 'There are only two levels of table, so two walk reads plus the access.'],
      },
    },
    {
      title: 'The walker in gates',
      body: `
        <p>The walker is a small state machine that does the reading: <span data-show="wk">idle</span>; <em>level 1</em>, where it reads the root entry; <em>level 0</em>, the second
        table's; and <em>fault</em>. It sits on the data memory's own port: while it walks, the address the memory sees is the table entry's, not the program's
        (the MMU multiplexes them), and the word that comes back is checked by the same gates that apply the rules of step 3.</p>
        <p>Nothing about this machine knows how to wait, so the CPU is told to: while the walker is busy, <code>stall</code> holds the program counter, blocks every register and memory write and
        keeps the timer from counting. A walk to a 4 KiB leaf holds the CPU for ${WALK_CYCLES} cycles: the cycle the miss is seen, the root read, the second-table read. In the scene, press <em>Run</em> or <em>Step</em>: the
        cycle count runs on while the instruction count waits, and the panel says <em>stalled</em>. The first walk comes when user code starts, at the very first fetch.</p>
        <p>The walker is ${n(F.walker)} NANDs: a few flip-flops for the state and the pointer to the next table, and the rule checks. It is the cheap part. The expensive part is
        what remembers the answer.</p>
        <div class="try">Run the program for a few cycles and watch the walker's state flip-flops (open it with the mouse): each walk visits level 1, level 0, then idle.</div>`,
      scene: () => vmScene(VM_WALK, ['mmu'], ['wk']),
      lit: 'The walker',
      challenge: {
        kind: 'quiz',
        question: `The CPU runs a program from a cold start in user mode. The first instruction has to be fetched. How many cycles pass before it executes?`,
        options: [`${WALK_CYCLES} cycles of walk, then the instruction`, 'None: the fetch hits the TLB', '1: the walker reads the page table once', `${WALK_CYCLES + 1}: the walk, then one more to retry`],
        answer: 0,
        explain: `The TLBs start empty, so the first fetch misses; the walker takes ${WALK_CYCLES} cycles and fills the entry, and the instruction executes in the cycle it retries (the stall is the walk itself).`,
        why: ['', 'A cold TLB holds nothing; the first access to any page misses.', 'A 4 KiB leaf needs both the root and the second-table read (the miss cycle starts the walk).', 'The retry is the instruction\'s own cycle, not an extra one: the CPU executes it in the first cycle after the stall.'],
      },
    },
    {
      title: 'The TLB: remembering translations',
      body: `
        <p>A walk is ${WALK_CYCLES} cycles on top of an instruction that otherwise takes one; paid on every fetch and every load and store, the machine would run at a fraction of its speed.
        Programs come back to the same pages constantly (a loop fetches the same few instructions, a stack the same few words), so the answer to a walk is kept: a
        <strong>translation lookaside buffer</strong>, the TLB. This one is a tiny cache with four entries, each holding a virtual page number, the physical page number and the flags that matter.</p>
        <p>It is chapter ${numOf('memory')}'s content-addressable memory: all four entries compare their stored page number with the one asked for at the same time (a 20-bit comparator each), and a priority encoder
        picks the one that matched; no clock and no search. There are two of them, <span data-show="itlb">one for the instruction fetch</span> and <span data-show="dtlb">one for loads and stores</span>, because
        both happen in the same cycle. At ${n(F.tlbI)} and ${n(F.tlbD)} NANDs they are ${n(F.tlbI + F.tlbD)} of the ${n(F.mmu)} NANDs of the whole MMU (TLBs, permission checks and walker): the memory of translations is the cost, the logic that fills it is not.</p>
        <p>A <em>hit</em> costs nothing extra in cycles: the lookup is combinational and the physical address is out in the same cycle (it does add gate delays to the clock, see step 9). A <em>miss</em> starts the walker, whose
        result is written into the entry a round-robin pointer names, replacing in turn. The panel shows both TLBs live with the entry that matches the current address lit green, and counts walks against translated accesses.</p>
        <p>A TLB can be wrong in only one way: when the page table changes behind its back. <code>sfence.vma</code> is the instruction that says so; this hardware answers it, and any write to satp, by forgetting every entry.</p>`,
      scene: () => vmScene(VM_WALK, ['mmu'], ['itlb', 'dtlb']),
      lit: 'The two TLBs',
      challenge: {
        kind: 'quiz',
        question: `The chapter's program reads frame B and updates frame A three times in a loop. On the gates it makes ${RUN.walk.imiss + RUN.walk.dmiss} walks in ${RUN.walk.accesses} translated accesses. Why so few?`,
        options: ['Each of its three pages (code, A and B) is walked once; every later access hits', 'The walker is very fast', 'Most of the accesses are to untranslated memory', 'The TLB holds the whole page table'],
        answer: 0,
        explain: `Three pages are in use, one in the instruction TLB and two in the data TLB, and each misses only the first time it is touched. Every other access, ${RUN.walk.accesses - RUN.walk.imiss - RUN.walk.dmiss} of ${RUN.walk.accesses}, hits.`,
        why: ['', 'Walks are as slow as they were; there are only a few of them.', 'Every access here is translated (Sv32 is on in user mode); that is what the counter counts.', 'The TLB holds four translations, not the table: it can hold only a few pages at a time.'],
      },
    },
    {
      title: 'Page faults: mapping on demand',
      body: `
        <p>A walk that ends in a fault produces no address. The instruction does not complete: the CPU takes a <strong>trap</strong> (chapter ${numOf('traps')}) with cause 12, 13 or 15 for
        a fetch, load or store, <code>mepc</code> pointing at the instruction, and <code>mtval</code> holding the <em>virtual address</em> that failed. That is all a handler needs: it is a
        precise exception, so after the handler returns with <code>mret</code> the same instruction runs again as if nothing had happened.</p>
        <p>That makes the fault a tool and not only an error. The scene's program touches two pages at 0x8000 and 0x9000 that have no page-table entry. The handler
        (<span data-show="csr trap">in machine mode, untranslated</span>) reads <code>mtval</code>, takes the page number from it, writes a page-table entry
        pointing at the next free frame with V R W U A D set, executes <code>sfence.vma</code> and returns. The store runs again and succeeds. The program never knew; the cost was the failed walk (${WALK_CYCLES} cycles),
        the trap, ${RUN.pager.traps[0].handlerSteps} instructions of handler, and the walks that the flush forces afterwards: the run makes ${RUN.pager.imiss + RUN.pager.dmiss} walks for the three pages it uses (code and the two new ones), where the previous scene, with its three pages already mapped, makes ${RUN.walk.imiss + RUN.walk.dmiss}.</p>
        <p>This is <strong>demand paging</strong>: nothing is mapped until the first touch. A real system adds a disk: the handler reads the page in from there, the program waits for milliseconds instead of cycles,
        and when frames run short the handler takes one from another page and writes its contents out first.</p>
        <p>Two details of this hardware. All traps go to machine mode, with the page table's owner running untranslated, so a handler never faults itself. And a walk that finds no valid entry fills nothing in the TLB: the
        retry walks again and finds the new entry. (A page that exists but is forbidden is different: its entry is cached, and the permission check refuses it from there.)</p>`,
      scene: () => vmScene(VM_PAGER, [], ['csr', 'trap', 'mmu']),
      lit: 'The CSRs, the trap unit and the MMU',
      challenge: {
        kind: 'quiz',
        question: 'After a page fault, what must the handler leave in mepc so that the program continues correctly once the page is mapped?',
        options: ['Nothing: mepc already holds the faulting instruction, which must run again', 'mepc + 4: skip the instruction', 'The faulting address from mtval', 'The address of the next free frame'],
        answer: 0,
        explain: 'A fault is the one kind of trap that should be retried: mepc is the instruction that did not complete, and mret goes back to it. Adding 4, as for an ecall, would skip the store the program is waiting for.',
        why: ['', 'Skipping the instruction is right for a system call and wrong here: the store would never happen.', 'mtval is a data address, not a place to resume at; mepc already points at the instruction.', 'The frame address is what the handler writes into the page table, not into mepc.'],
      },
    },
    {
      title: 'Protection: U, R, W and X',
      body: `
        <p>A translation that only moves addresses would let a program write wherever it likes. The flags take that back: the permission check
        (<span data-show="mmu">${n(F.permitI)} NANDs for fetches and ${n(F.permitD)} for loads and stores</span>) runs on every access, hit or miss, from the entry the TLB
        or the walker delivers. Its rules are the table of step 3, in gates.</p>
        <p>The scene's program runs in user mode and does four things. It loads from the read-only page (allowed), stores to it (a store page fault: cause 15, <code>mtval</code> =
        ${hex(RUN.guard.traps[0].tval)}), loads from a page marked supervisor-only (a load page fault: cause 13, ${hex(RUN.guard.traps[1].tval)}), and stores to its own page (allowed). The handler
        prints <strong>${RUN.guard.output[0]}</strong> for the first and <strong>${RUN.guard.output[1]}</strong> for the second, skips the instruction, and the program ends with <strong>${RUN.guard.output.slice(2)}</strong>: output
        <code>${RUN.guard.output}</code>.</p>
        <p>What this gives the operating system of the next chapter is the wall: every program runs in user mode with a table that maps only its own pages, and the
        kernel's pages have U = 0. A user program cannot name a page it has no entry for, and cannot use one of the kernel's. The check costs gates, no cycles; the cycles are in the walks.</p>`,
      scene: () => vmScene(VM_GUARD, [], ['csr', 'trap', 'mmu']),
      lit: 'The CSRs, the trap unit and the MMU',
      challenge: {
        kind: 'quiz',
        question: 'A user program stores to a page whose entry has V, R, U, A and D set, but W clear. What happens?',
        options: ['A store page fault, cause 15, mtval = the address', 'The store succeeds: D = 1 means dirty, so writing is allowed', 'A load page fault, cause 13', 'An illegal-instruction trap'],
        answer: 0,
        explain: 'The store needs W; without it the check fails and the access is a page fault whose cause says store (15). D is only a record kept for software, and the instruction itself is legal.',
        why: ['', 'D (dirty) does not grant anything; it must be set for a store that W already allows.', 'Cause 13 is for loads. A store that fails the check is cause 15.', 'The instruction is perfectly legal; it is the page that refuses the access.'],
      },
    },
    {
      title: 'What it costs',
      body: `
        <p>The system CPU of chapters ${numOf('io')}–${numOf('traps')} is ${n(F.base)} NANDs without its program ROM and takes ${F.basePeriod} NAND delays to a clock (counted with its 128-word program ROM and 32-word data memory, as in those chapters). With the privilege levels, the supervisor
        registers, two TLBs and the walker (the machine of this chapter's scenes, built from those same units) it is ${n(F.vm)} NANDs, <strong>${n(F.vm - F.base)} more</strong> (${Math.round((100 * (F.vm - F.base)) / F.base)} %), and the period
        is ${F.vmPeriod}. The MMU alone is ${n(F.mmu)} NANDs of that: ${n(F.tlbI)} and ${n(F.tlbD)} for the TLBs, ${n(F.walker)} for the walker, the rest the permission checks. The clock grows because the
        translation sits in series with everything: the fetch address goes through the instruction TLB before the program memory (${F.fetchLookup} delays on the longest path), and a load or store's address through the data TLB and
        its permission check on the way to the memory (${F.dataLookup} more). The scenes of this chapter need room for page tables, so they use a 256-word program ROM and a 4 096-word data memory, and with those larger memories the longest path is ${F.scenePeriod} delays; the NAND counts here are for the small memory.</p>
        <p>These figures are this book's single-cycle CPU, counted from its own gates; the virtual-memory CPU is not in the Benchmarks tab or the sandbox, so there is no table of
        other machines to set it against, and none is claimed here.</p>
        <p>What the TLB buys depends on the program. The benchmark programs below touch one page of code and one of data, so with any TLB the cost is two cold misses and nothing else.
        Real programs have a working set: a loop over an array, a pointer chase, a column of a matrix. The widget runs a stream of page numbers through the same replacement rule as the gates (round-robin, held equal
        to the CPU's stalls by tests) and counts the walks at ${WALK_CYCLES} cycles each. A stream that goes round more pages than there are entries misses on <em>every</em> access: replacing in turn throws out the page that was loaded longest ago, which in a cycle is the one needed next.
        The cliff is sharp, and it sits at the working set. Doubling the entries roughly doubles the TLB's NANDs, so the right size is the smallest that covers the programs that matter. Real machines add a second, larger TLB behind the first,
        and use <em>large pages</em>: one 4 MiB entry stands for 1 024 small ones (this hardware has the walk for them but splits them on the way in, one 4 KiB page per entry).</p>`,
      widget: costWidget,
      challenge: {
        kind: 'quiz',
        question: 'A program walks a working set of 8 pages one access per page, round and round. The data TLB has 4 entries. What does doubling it to 8 do?',
        options: ['The miss rate drops from every access to the first touches only', 'It halves the miss rate', 'Nothing: replacement matters more than size', 'It doubles the number of walks'],
        answer: 0,
        explain: 'With 4 entries and 8 pages in a cycle, round-robin evicts each page just before it is needed again: every access misses. At 8 entries the whole set fits and only the first touches miss. Capacity misses go away at a cliff, not gradually.',
        why: ['', 'It is not gradual: the miss rate stays at 100 % until the size reaches the working set, then collapses.', 'Replacement matters here (round-robin is the worst case for a cycle) but the size decides: with room for every page nothing is evicted.', 'More entries can only keep more pages: the walks drop.'],
      },
    },
  ],
};
