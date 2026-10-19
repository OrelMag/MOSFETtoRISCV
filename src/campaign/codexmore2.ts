// The fuller codex for codexnew.ts's entries (see codexmore.ts): what the journey teaches beyond the campaign's levels.
// NAND counts and depths were measured on the library (stats, logicDepth), cycle counts and protocol traffic on the
// chapters' circuits and models (src/sim/coherence.ts); tests/content-codexnew.test.ts pins them. Re-measure before
// changing one.

import type { CodexMore } from './codexmore';

export const MORE2: Record<string, CodexMore> = {
  // ---- many cores
  coherence: {
    idea: `Two private caches holding the same line can disagree the moment one of them is written. A coherence protocol keeps one rule per line: at any time either one cache may write it, or any number may read it, and a read returns the last value written. <b>Write-invalidate snooping</b> does it over a shared bus: every miss and every first write is broadcast, every other cache watches (snoops) and drops or hands over its copy. MSI keeps a state per line: Modified (the only copy, dirty), Shared (clean, maybe elsewhere), Invalid. A read miss broadcasts BusRd; a write to a Shared line broadcasts an upgrade that invalidates the others; a cache holding the line Modified supplies it and writes it back. MESI adds <b>Exclusive</b>: read with no other sharer, so a later write goes to Modified silently, the common case of private data. (MOESI and MESIF add an owner that forwards dirty or clean data without memory.)<br>A bus serializes every miss of every core, which stops scaling at a few dozen cores. A <b>directory</b> keeps, per line at its home memory, the state and a bit per cache that may share it; a write sends invalidations only to the sharers, point to point over any network. The price is storage: a full bit vector for 64 cores on 64-byte lines is 64 bits per 512, 12.5 %. Chapter 26's dual-core has no caches, so it needs no protocol: one port, one copy.`,
    example: {
      title: 'Two cores, MSI against MESI (chapter 26\'s model)',
      body: `<pre>"Private read-then-write": each core reads, then writes, its own block
  MSI   BusRd (I→S), BusUpgr (S→M)  ×3   6 bus transactions
  MESI  BusRd (I→E), silent E→M     ×3   3
"False sharing": x and y on one line, the cores write in turn, 6 writes
  every write BusRdX: 6 transactions, 5 invalidations, 5 write-backs
"Padded": x and y on separate lines
  2 transactions (each core's first write), then 4 hits</pre>False sharing is correct and slow: the hardware tracks lines, not variables, and only padding or alignment separates them.`,
    },
    mistakes: [
      'Thinking coherence makes a load–add–store atomic: it keeps each line consistent, but another core\'s write can still land between the load and the store.',
      'Confusing coherence with consistency: coherence is about one address; the order in which writes to <em>different</em> addresses become visible is the memory model\'s business (fences).',
      'Forgetting the other bus masters: a DMA engine writing memory leaves stale lines in a CPU cache unless the hardware snoops it or software invalidates them.',
    ],
    chapters: [
      { chapter: 'multicore', step: 6, label: 'Caches and coherence' },
      { chapter: 'cache', step: 10, label: 'Write-back: dirty lines' },
      { chapter: 'bus', step: 3, label: 'DMA' },
    ],
  },
  atomics: {
    idea: `Every single load and store is atomic; a sequence is not. Two cores incrementing a shared counter with lw / addi / sw lose updates whenever one loads between the other's load and store: chapter 26's race ends at 20 instead of 40. The fix needs the hardware's help, in one of two shapes.<br><b>AMOs</b> (atomic memory operations) do the read, the operation and the write as one indivisible access: <code>amoadd.w rd, rs2, (rs1)</code> returns the old word in rd and stores old + rs2. The address is rs1 itself, no offset. In the dual-core the arbiter grants the port for that one access, so nothing can fall in between; MP_DECODE (257 NANDs a core) recognizes amoadd.w and amoswap.w and hands them to the control unit disguised as lw. With caches, the core takes the line exclusive and holds it for the operation; or the operation is sent to the memory or the shared cache ("far atomics", how GPUs do histograms).<br><b>LR/SC</b> splits it: <code>lr.w</code> loads and reserves the word, <code>sc.w</code> stores only if no other hart wrote it since, and writes 0 to rd on success, non-zero on failure. Any read-modify-write becomes a retry loop; RISC-V guarantees progress for constrained loops (at most 16 integer instructions, no other loads or stores between). RV32A has both: 9 AMOs (swap, add, and, or, xor, min, max, minu, maxu) and lr.w / sc.w. A lock is one AMO: <code>amoswap.w</code> 1 in, and an old 0 means it is yours.`,
    example: {
      title: 'One increment, three ways',
      body: `<pre># racy: another hart can store between lw and sw
    lw   t0, 0(a0)
    addi t0, t0, 1
    sw   t0, 0(a0)

# AMO: one access
    li       t1, 1
    amoadd.w x0, t1, (a0)

# LR/SC: retry until no one wrote in between
retry:
    lr.w  t0, (a0)
    addi  t0, t0, 1
    sc.w  t1, t0, (a0)
    bnez  t1, retry</pre>Chapter 26: 40 increments with amoadd.w end at 40, every time. The amoswap.w spin lock around lw / addi / sw is correct too, at over four times the run time of the atomic add.`,
    },
    mistakes: [
      'Building a lock from plain lw and sw ("test, then set"): two cores can both see it free before either stores, exactly the race the lock was for.',
      'Spinning with the AMO itself: every attempt is a write that takes the line (or the port) from the owner. Spin on a plain load until the lock looks free, then try the swap (test-and-test-and-set), or back off.',
      'Releasing a lock with a plain store on a weakly ordered core: without release ordering (fence rw,w or amoswap.w.rl) the critical section\'s stores can become visible after the lock looks free.',
    ],
    lib: 'mpdec',
    chapters: [
      { chapter: 'multicore', step: 4, label: 'Atomic read-modify-write' },
      { chapter: 'multicore', step: 5, label: 'A spin lock' },
      { chapter: 'feed', step: 4, label: 'Atomics' },
    ],
  },
  ordering: {
    idea: `Coherence says every core agrees on the history of each address. The memory model says how accesses to <em>different</em> addresses may appear to interleave. <b>Sequential consistency</b> (Lamport, 1979): the result is as if all accesses happened in one global order that respects each program's order. Chapter 26's dual-core is SC by construction: one port, one access per cycle.<br>Real cores are not. A store sits in a <b>store buffer</b> until its line arrives, and later loads to other addresses go ahead; caches and interconnects reorder further. x86 is TSO (only a store followed by a load may be reordered); Arm and RISC-V are weaker. <b>RVWMO</b> lets most accesses to different addresses reorder and gives the programmer the means to forbid it where it matters: <code>fence pred, succ</code> orders the predecessor set (r, w; i, o for I/O) before the successor set, and the A extension's <b>aq</b> and <b>rl</b> bits make an atomic an acquire (nothing later moves before it) or a release (nothing earlier moves after it). The Ztso extension offers TSO instead.<br>Locks are where it matters: take the lock with acquire (amoswap.w.aq, or the swap then fence r,rw), give it back with release (fence rw,w then the store, or amoswap.w.rl), and the critical section's accesses stay inside.`,
    example: {
      title: 'The store-buffer litmus test',
      body: `<pre>x = y = 0
hart 0:  sw 1 → x      hart 1:  sw 1 → y
         lw r0 ← y              lw r1 ← x</pre>Under SC at least one load sees 1: whichever store is first in the global order precedes both loads. With store buffers both stores can still be waiting while both loads read memory: r0 = r1 = 0, allowed by TSO and RVWMO. A <code>fence rw,rw</code> (or fence w,r) between each store and load forbids it. On the dual-core it cannot happen, which is exactly why such bugs hide in testing.`,
    },
    mistakes: [
      'Testing concurrent code on one machine and calling it correct: a sequentially consistent or TSO machine never shows the reorderings RVWMO allows.',
      'Fencing only one side: message passing needs the writer to order data before flag (fence w,w or a release) <em>and</em> the reader to order flag before data (fence r,r or an acquire).',
      'Using fence where an AMO is needed: ordering does not make a read-modify-write atomic, and atomicity does not order the surrounding accesses.',
    ],
    chapters: [
      { chapter: 'multicore', step: 7, label: 'Memory ordering' },
      { chapter: 'multicore', step: 5, label: 'A spin lock' },
    ],
  },
  amdahl: {
    idea: `Speed up a fraction p of a program by a factor n and the time becomes (1 − p) + p / n of the original: speed-up = 1 / ((1 − p) + p / n). As n grows it approaches 1 / (1 − p), however many cores are added. Amdahl (1967) used it to argue for fast single processors; it applies to any partial speed-up, a faster multiplier as much as more cores.<br>It is why the serial part matters out of all proportion: the start-up, a lock everyone queues on, the last steps of a reduction, a kernel launch. In chapter 26 the two cores divide the array by hart id, but the race and the lock are serial points; in the lane chapters the prologue every warp runs is overhead that more lanes do not shrink. <b>Gustafson's law</b> is the other view: if the problem grows with n (more pixels, a larger matrix), the parallel part grows and the scaled speed-up is (1 − p) + p·n.`,
    example: {
      title: '90 % parallel',
      body: `<pre>cores  time (serial 0.1 + 0.9 / n)   speed-up
  1    1.000                          1.0
  2    0.550                          1.8
  4    0.325                          3.1
  8    0.2125                         4.7
 64    0.114                          8.8
  ∞    0.100                         10</pre>Eight cores at 4.7× use 59 % of the hardware; 64 cores, 14 %. Halving the serial part to 5 % lifts 8 cores to 5.9× and the limit to 20×.`,
    },
    mistakes: [
      'Quoting the speed-up of the parallel part as the program\'s: 8× on 90 % of the time is 4.7× overall.',
      'Forgetting that synchronization adds serial work: locks, barriers and the final combining step grow with the number of cores.',
      'Applying it to a problem that grows with the machine: then Gustafson\'s scaled speed-up is the honest figure.',
    ],
    chapters: [
      { chapter: 'multicore', step: 0, label: 'Why more cores?' },
      { chapter: 'lanes', step: 0, label: 'Latency or throughput' },
      { chapter: 'lanes', step: 4, label: 'Lanes against cores' },
    ],
  },

  // ---- caches
  amat: {
    idea: `The average time an access takes is the hit time, paid always, plus the miss rate times what a miss costs: AMAT = t<sub>hit</sub> + m × t<sub>miss</sub>. For a hierarchy the miss penalty of one level is the AMAT of the next, so the formula nests: AMAT = t<sub>L1</sub> + m<sub>L1</sub> × (t<sub>L2</sub> + m<sub>L2</sub> × t<sub>mem</sub>), with m<sub>L2</sub> the <em>local</em> miss rate (misses per L2 access, not per CPU access).<br>It says what to optimize: a lower miss rate, a cheaper miss, or a faster hit, whichever term is largest. It also shows why the hit time must stay tiny (it is paid on every access, so an L1 rarely exceeds 4–5 cycles) and why a second level pays even with a poor hit rate: it divides the DRAM latency by the fraction that gets through. For a CPU, stall cycles per instruction = memory accesses per instruction × miss rate × penalty, and they add to the base CPI.`,
    example: {
      title: 'Two levels, then chapter 22\'s CPU',
      body: `<pre>L2:  12 + 0.20 × 250 = 62 cycles
L1:   4 + 0.05 × 62  = 7.1 cycles
"Sum an array twice", single-cycle CPU with the direct-mapped cache:
  32 loads, 4 misses × 8 cycles = 32 stall cycles
  188 instructions in 220 cycles: CPI 1.17</pre>DRAM's 250 cycles shrink to under twice the L1 hit time once two levels of hits dilute them.`,
    },
    mistakes: [
      'Using the global L2 miss rate (L2 misses per CPU access) inside the nested formula, which expects misses per L2 access.',
      'Comparing caches by miss rate alone: a larger or more associative cache with a slower hit can lose on AMAT.',
      'Forgetting the miss penalty includes everything a miss does: here a dirty victim adds a 4-cycle write-back to the 8-cycle fill.',
    ],
    anatomy: ['dmem'],
    chapters: [
      { chapter: 'cache', step: 14, label: 'Average memory access time' },
      { chapter: 'cache', step: 9, label: 'A CPU that waits for memory' },
      { chapter: 'memctrl', step: 3, label: 'The CPU behind it' },
    ],
  },
  threecs: {
    idea: `Mark Hill's classification sorts every miss by what would have prevented it. <b>Compulsory</b> (cold): the first access to a line; it would miss in an infinite cache. <b>Capacity</b>: it would miss even in a fully associative cache of the same size, because the working set does not fit. <b>Conflict</b>: it hits in that fully associative cache but misses here, because too many lines map to one set. Measure them that way: count misses in an infinite cache, then in a fully associative one of the same size, and the rest are conflicts. (Coherence misses, from another core's invalidation, are the fourth C.)<br>Each has its own cure. Larger lines and prefetching cut compulsory misses (until lines get so few that conflicts rise); a larger cache cuts capacity misses at the price of hit time; more ways cut conflict misses. Software helps all three: loop interchange, blocking (tiling) and padding change which lines a loop touches and when.`,
    example: {
      title: 'Column by column (chapter 22\'s explorer)',
      body: `A 1 KB matrix (16 rows of 64 bytes) summed column by column through a 256-byte direct-mapped cache with 16-byte lines: every access misses. Rows i and i + 4 share a set, so each line is evicted before its next word is used: conflict misses.<br>4-way does not help (4 sets, all 16 rows of a column in one). A 1 KB cache does: 64 sets, every row its own, leaving the 64 compulsory misses of 256 accesses, 25 %. So does a fully associative 256-byte cache (one column's 16 lines fit), or swapping the loops.`,
    },
    mistakes: [
      'Calling every miss after the first pass a conflict: in a fully associative cache with LRU, a loop over twice the cache\'s size misses on every line, and those are capacity misses.',
      'Curing capacity misses with ways: associativity only redistributes lines among sets; it adds no room.',
      'Growing the line to cut compulsory misses without limit: fewer, longer lines mean more conflicts and a longer fill.',
    ],
    anatomy: ['dmem'],
    chapters: [
      { chapter: 'cache', step: 8, label: 'The three Cs and associativity' },
      { chapter: 'cache', step: 7, label: 'Exploring caches on real traces' },
    ],
  },
  assoc: {
    idea: `A direct-mapped cache gives each address exactly one line it can live in; an <b>n-way set-associative</b> cache gives it a set of n. The index picks the set, all n tags are compared with the address tag at once, and the matching way's data goes out through an n-way multiplexer. Fully associative is a single set with a comparator per line: a CAM, used for TLBs and small buffers.<br>Ways cost comparators, a wider hit multiplexer on the critical path, and <b>replacement</b> state, since a miss must choose a victim. True LRU for 2 ways is one bit per set (set on every access to name the other way); for n ways it needs log₂(n!) bits and an update on every hit, so 8-way caches use tree pseudo-LRU (n − 1 bits: each node points at the half used less recently) or random replacement. With the same capacity, n ways mean n times fewer sets, so the index loses log₂ n bits and the tag gains them. Beyond 4–8 ways the miss rate barely falls while hit time and energy keep rising.`,
    example: {
      title: '"Two arrays, one set"',
      body: `a[i] and b[i] share an index in the direct-mapped cache, so each load evicts the other: 33 misses (32 loads and the final store). The 2-way write-back cache of the same size has half the sets but two lines in each: both arrays fit, and an LRU bit per set names the victim. 9 misses (4 lines of a, 4 of b, 1 for the store), and the run takes less than half the cycles.<br>The 2-way tag compare alone (3-bit tags, 8-bit data) is two comparators and a multiplexer: 77 NANDs, 13 deep.`,
    },
    mistakes: [
      'Expecting associativity to fix a working set larger than the cache: it removes conflict misses only.',
      'Keeping the index width when adding ways at the same capacity: the sets halve, the index loses a bit, the tag gains one.',
      'Assuming replacement policy matters in a direct-mapped cache: with one candidate there is nothing to choose.',
    ],
    lib: 'way2_3_8',
    anatomy: ['dmem'],
    chapters: [
      { chapter: 'cache', step: 8, label: 'The three Cs and associativity' },
      { chapter: 'cache', step: 11, label: 'Two ways and an LRU bit' },
      { chapter: 'cache', step: 7, label: 'Exploring caches on real traces' },
    ],
  },
  writepolicy: {
    idea: `A store that hits has two choices. <b>Write-through</b>: update the line and the next level, so memory is always current and an eviction costs nothing; every store uses memory bandwidth. <b>Write-back</b>: update the line only and set its dirty bit; memory sees the line when it is evicted, once, however often it was written. A miss on a store has two choices too: <b>write-allocate</b> fetches the line and then writes it (natural with write-back), <b>no-write-allocate</b> sends the store on and fetches nothing (natural with write-through).<br>A <b>write buffer</b> sits between the cache and memory: stores go into a small FIFO and the CPU carries on while it drains, which hides write-through's cost until a burst fills it. A later load must then check the buffer (or wait for it to drain), or it reads a stale word from memory. Write-back caches dominate because memory bandwidth is the scarce resource; their price is a dirty bit per line, a slower miss when the victim is dirty, and memory that is not the up-to-date copy, the seed of the coherence problem.`,
    example: {
      title: '48 stores to 16 words (chapter 22)',
      body: `<pre>                 write-through          write-back
words to memory  48 (every store)       0 during the run (16 at eviction)
store miss       no fetch               fetch the line (write-allocate)
read miss        8 cycles               8, or 12 with a dirty victim:
                                        0–3 write back, 4–7 wait, 8–11 fill</pre>The write-back cache's memory view shows main memory still all zero after the run: the dirty lines are the only current copy.`,
    },
    mistakes: [
      'Evicting a dirty line without writing it back: the store is lost.',
      'Adding a write buffer and letting loads bypass it to memory: a load right after a store to the same word reads the old value.',
      'Assuming write-through needs no coherence: other caches still hold stale copies of the line it updated.',
    ],
    anatomy: ['dmem'],
    chapters: [
      { chapter: 'cache', step: 10, label: 'Write-back: dirty lines' },
      { chapter: 'cache', step: 6, label: 'A direct-mapped cache' },
      { chapter: 'cache', step: 14, label: 'Average memory access time' },
    ],
  },
  vm: {
    idea: `Virtual memory gives every program its own address space. Addresses split into a virtual page number and an offset; a page table, set up by the operating system, maps each page to a physical frame and says whether it may be read, written, executed or touched in user mode. A missing or forbidden page raises a <b>page fault</b>, a precise exception: the handler loads the page or kills the program, and the instruction runs again. Pages give isolation, memory larger than RAM (paging to disk), shared libraries and copy-on-write.<br>RISC-V's Sv32 (RV32): 4 KiB pages, a two-level table of 1 024 four-byte entries per level (10 + 10 + 12 address bits), the root's frame in <code>satp</code> along with an address-space id; an entry holds a 22-bit frame number and V, R, W, X, U, G, A, D bits, and the physical address grows to 34 bits. A walk costs two memory reads, so a <b>TLB</b>, a small (often fully associative) cache of translations, sits beside the L1; a TLB miss walks the table, in hardware on RISC-V. To look up the cache while translating, L1s index with page-offset bits only (virtually indexed, physically tagged), which limits an L1 to page size × ways: 4 KiB × 8 ways = 32 KiB.<br>None of the site's CPUs has an MMU: they run in machine mode on physical addresses, as small embedded cores do.`,
    example: {
      title: 'Translating 0x0040_3A10 under Sv32',
      body: `<pre>VPN[1] = bits 31:22 = 0x001    VPN[0] = bits 21:12 = 0x003
offset = bits 11:0  = 0xA10
1. read root[0x001] at satp.PPN × 4096 + 0x001 × 4  → next table
2. read that table[0x003]                           → PPN, R W X U
3. physical = PPN × 4096 + 0xA10</pre>Two reads per access without a TLB; one cycle in the common case with it. A 64-entry TLB of 4 KiB pages covers 256 KiB: a program touching more than that misses in it constantly, the case for large pages (4 MiB megapages in Sv32).`,
    },
    mistakes: [
      'Thinking a virtual address is just an offset into RAM: neighbouring virtual pages can live anywhere, or nowhere, in physical memory.',
      'Changing a page table and forgetting the TLB: the stale translation stays until <code>sfence.vma</code> flushes it.',
      'Indexing the L1 with bits above the page offset without handling aliases: two virtual addresses of one physical line can then sit in different sets.',
    ],
    chapters: [
      { chapter: 'cache', step: 5, label: 'The memory hierarchy' },
      { chapter: 'traps', step: 2, label: 'Exceptions' },
    ],
  },
  sram: {
    idea: `The six-transistor cell is an SR latch made of two CMOS inverters, each driving the other, plus two NMOS access transistors whose gates are the <b>word line</b>; they connect the two storage nodes q and q̄ to the <b>bit lines</b> bl and bl̄ that every cell of the column shares. There is no clock, no enable gate and no multiplexer: transistor <b>sizing</b> does the work, pull-down (strong) &gt; access (normal) &gt; pull-up (weak).<br>A read precharges both bit lines high, releases them and raises one word line: the side storing 0 pulls its bit line down through access and pull-down, and since the pull-down is stronger than the access transistor, the node rises too little to flip the cell. A write drives one bit line hard to 0: the access transistor overpowers the weak pull-up, the node falls, and the loop flips. In silicon the cell swings a long bit line only by about 100 mV before a sense amplifier decides; here the swing is full. The periphery (decoders, precharge, write drivers, sense amplifiers) is shared per row and column, so it amortizes as the array grows.`,
    example: {
      title: 'Bits per transistor (chapter 22)',
      body: `<pre>enable flip-flop (DFFE)   15 NANDs = 60 transistors a bit
6T cell                   6 transistors a bit
4 × 4 SRAM array          320 transistors, cells 96 (30 %)
8 × 8 SRAM array          892 transistors, cells 384 (43 %)
real 32 KB array          cells over 90 %</pre>16 bits of flip-flop registers would cost 960 transistors, three times the 4 × 4 array with its periphery.`,
    },
    mistakes: [
      'Sizing the access transistor stronger than the pull-down: a read then lifts the 0 node past the other inverter\'s threshold and flips the cell (a read disturb).',
      'Reading without precharging: the bit lines still hold whatever the last write left on them.',
      'Counting only the cells: at small sizes the periphery is most of the area, which is why register files stay flip-flops and SRAM pays only in arrays.',
    ],
    lib: 'sram6t',
    chapters: [
      { chapter: 'cache', step: 0, label: 'Six transistors per bit' },
      { chapter: 'cache', step: 1, label: 'From a column to an array' },
    ],
  },
  ecc: {
    idea: `One parity bit (an XOR tree) detects any single flipped bit and cannot say which. Hamming's idea (1950): give the code word positions 1, 2, 3, … and put check bits at the powers of two. Check bit 2<sup>j</sup> is the parity of every position whose number has bit j set. On a read the checks are recomputed; the pattern of failing checks, the <b>syndrome</b>, is the binary position of a single flipped bit (0: none), which the decoder flips back. r check bits cover k data bits when 2<sup>r</sup> ≥ k + r + 1. One more bit, the parity of the whole word, makes it <b>SEC-DED</b> (single error correct, double error detect): one error leaves the overall parity odd and the syndrome names the bit; two leave it even with a non-zero syndrome, which is reported, not corrected.<br>8 data bits need 4 + 1 extra (13 in all), 64 need 7 + 1 (72): the width of ECC DIMMs and of most server caches. The decoder sits in the read path of every access; caches often correct only on a detected error, out of the fast path. Flash needs far stronger codes (BCH, then LDPC) because its raw error rate grows with bits per cell and wear.`,
    example: {
      title: 'd = 0x01 through the 8-bit code',
      body: `<pre>positions   12 11 10 9 8 7 6 5 4 3 2 1 0
data at     d7 d6 d5 d4 . d3 d2 d1 . d0 . . .
d0 = 1 sits at position 3 = 0b011 → checks 1 and 2 become 1
overall parity (position 0) makes the count even
code word   0b0_0000_0000_1111

flip position 6:  XOR of positions holding 1 = 1⊕2⊕3⊕6 = 6,
                  parity odd → single error at 6, flipped back
flip 6 and 9:     syndrome 6⊕9 = 15, parity even → double</pre>Here: encoder 76 NANDs (9 deep), decoder 280 (19 deep); the 64-bit encoder is 928.`,
    },
    mistakes: [
      'Trusting a "corrected" word after three flips: SEC-DED can mistake three errors for one and flip a fourth bit.',
      'Leaving out the overall parity bit: a plain Hamming code "corrects" a double error into a third wrong bit.',
      'Assuming ECC replaces refresh or scrubbing: errors accumulate in words nobody reads, so memory controllers scrub them before a second flip joins the first.',
    ],
    lib: 'ecc8',
    compare: ['hamenc8', 'hamdec8'],
    chapters: [
      { chapter: 'cache', step: 4, label: 'Errors and ECC' },
    ],
  },

  rowhammer: {
    idea: `Refresh is sized for leakage alone: every row is rewritten within 64 ms because a cell keeps its charge at least that long on its own. Row hammer breaks the assumption. Each activation of a row (the <em>aggressor</em>) raises its word line and swings its bit lines; through capacitive coupling between neighbouring word lines and charge injected into the substrate, the cells of the adjacent rows (the <em>victims</em>) lose a little charge every time. Enough activations before the victims' next refresh and their weakest cells flip. Kim et al. (ISCA 2014) found it in 110 of 129 DDR3 modules, the first flips after 139 000 activations of one row within a 64 ms window; as cells shrank the threshold fell, to under 5 000 in some later DDR4 and LPDDR4 parts. Hammering both neighbours of a victim (double-sided) needs fewer per row.<br>It is a security hole, not just a reliability one: a program flips bits in memory it cannot write. Project Zero (2015) flipped page-table bits to gain kernel privileges; later attacks reached across virtual machines and through JavaScript. Defences: count activations per row and refresh a hammered row's neighbours early (DDR4's target row refresh, inside the device; DDR5's refresh management commands and per-row activation counters), refresh the whole device more often (halving the window halves the activations an attacker gets), and ECC, which corrects one flip per word but not the several a determined attack can place. Chapter 34's cells do not couple: each leaks alone.`,
    example: {
      title: 'How many activations fit in a refresh window (DDR4-3200)',
      body: `<pre>one row can be activated every tRC = tRAS + tRP = 32 + 13.75 = 45.75 ns
64 ms / 45.75 ns ≈ 1.4 million activations of one row per window
DDR3 threshold in 2014: 139 000, about a tenth of that
double-sided: two aggressors take turns, 0.7 million each</pre>An attacker has an order of magnitude to spare; refreshing twice as often only halves it.`,
    },
    mistakes: [
      'Treating it as a leakage problem that more refresh fixes: refreshing more often costs bandwidth and energy and only lowers the activations an attacker gets, it does not remove the coupling.',
      'Trusting SEC-DED to stop it: a hammered row can lose several bits in one word, and ECC then miscorrects or only detects.',
      'Assuming a cache hides it: an attacker flushes the line (clflush) or evicts it, so every access reaches DRAM and activates the row.',
    ],
    chapters: [
      { chapter: 'dram', step: 3, label: 'Leaks and refresh' },
      { chapter: 'memctrl', step: 2, label: 'Refresh' },
    ],
  },

  // ---- the real ISA
  rv32i: {
    idea: `RV32I is the base integer instruction set of RISC-V, frozen in 2019 (version 2.1), and what every journey CPU from chapter 13 on runs: 32 registers x0–x31 of 32 bits with x0 wired to 0, a 32-bit PC, and 40 instructions (lui, auipc, jal, jalr, six branches, five loads, three stores, nine immediate and ten register ALU operations, fence, ecall, ebreak). Every instruction is 32 bits in one of six formats (R, I, S, B, U, J) with rs1, rs2 and rd always in the same bits, so register reads start before decoding ends. Extensions add the rest: M (multiply, divide), A (atomics), F / D (floating point), C (16-bit encodings), Zicsr (CSRs).<br>Memory is <b>byte-addressed</b>, little-endian: the PC steps by 4, and loads and stores come in bytes (lb, lbu, sb), halfwords (lh, lhu, sh) and words. In a word-wide memory a store replicates the byte into every lane and raises one byte enable; a load picks the lane with a multiplexer and sign- or zero-extends by wiring. Branch and jump offsets count halfwords, so 16-bit C instructions can be targets. <code>lui</code> sets the upper 20 bits of a register, <code>auipc</code> adds them to the PC: with a following addi, jalr or load they reach any 32-bit address, PC-relative, so code runs wherever it is loaded.<br>RV16, the campaign's ISA, keeps the formats' spirit at 16 bits: 8 registers, word-addressed memory, the PC stepping by 1.`,
    example: {
      title: 'Bytes and upper immediates',
      body: `<pre>memory word at 0: 0x12AB5678   (byte 0 = 0x78 … byte 3 = 0x12)
lb  x5, 2(x0)   → 0xFFFFFFAB   (byte 2, top bit copied)
lbu x5, 2(x0)   → 0x000000AB
sb  to address 2 → byte enables 0100, sh to 2 → 1100

at pc 0x0000_1000:
auipc t0, 0x12345     t0 = 0x1000 + 0x12345000 = 0x12346000
li a0, 0x12345     →  lui a0, 0x12 ; addi a0, a0, 0x345</pre>`,
    },
    mistakes: [
      'Splitting a constant for lui + addi without compensating: addi sign-extends its 12 bits, so when bit 11 of the constant is 1 the upper part must be one larger (li 0x12FFF is lui 0x13, addi −1).',
      'Writing pc + 1 for the next instruction: the PC counts bytes, so it is pc + 4 (RV16\'s word-addressed PC does step by 1).',
      'Assuming a misaligned lw is just slower: RISC-V lets a core handle it or trap, and the journey\'s complete CPU traps.',
    ],
    lib: 'loadextract',
    chapters: [
      { chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' },
      { chapter: 'cpu', step: 0, label: 'The datapath' },
      { chapter: 'io', step: 0, label: 'Storing a byte' },
      { chapter: 'io', step: 2, label: 'Loading a byte' },
    ],
  },

  // ---- physical design
  stdcell: {
    idea: `A standard cell is a gate drawn once, by the foundry, at a fixed height: a VDD rail along the top, a GND rail along the bottom, PMOS in the n-well above, NMOS below, inputs and output on a pin grid. Cells of any width then abut in rows that share rails, and a chip is rows of them. A library has hundreds: inverters and buffers, NAND / NOR with 2–4 inputs, AND-OR-INVERT and OR-AND-INVERT, multiplexers, XOR, adders, latches and flip-flops, each in several drive strengths, characterized for delay and power at every load and input slope.<br>The flow that uses them: <b>synthesis</b> turns Verilog into generic logic and <b>technology mapping</b> covers it with the cheapest cells that meet timing; <b>placement</b> gives every cell a legal spot (classically simulated annealing, today analytic placement over the whole chip) minimizing wire length and leaving room to route; <b>clock tree synthesis</b> builds a balanced buffered tree; <b>routing</b> connects every net on the metal layers, one preferred direction per layer, vias between (Lee's maze router, 1961, is the ancestor). Static timing is then redone with the extracted wire parasitics, and violations fixed by resizing and buffering.<br>Every NAND on this site would be one NAND2 cell; real synthesis uses the whole library, so the same function takes fewer, more complex cells.`,
    example: {
      title: 'Chapter 27\'s numbers',
      body: `<pre>sky130 NAND2 (high density)     3.75 µm²
dual-core logic, 70 % utilization:
  SkyWater 130 nm               about 0.73 mm on a side
  28 nm                         about 0.2 mm: pad-limited
routing in the real flow        five metal layers, sky130's rules</pre>The flow's own table puts our NAND-count estimate beside the area the cells really took, block by block.`,
    },
    mistakes: [
      'Placing for wire length only: a dense, short placement can congest the routing channels until nets do not fit.',
      'Trusting timing from gate delays alone: after routing, wire RC (growing with the square of an unbuffered wire\'s length) often dominates.',
      'Equating NAND count with area: a flip-flop, a multiplexer or an XOR is one library cell, smaller than the NANDs it stands for.',
    ],
    chapters: [
      { chapter: 'silicon', step: 0, label: 'Gates become geometry' },
      { chapter: 'silicon', step: 2, label: 'A real cell library' },
      { chapter: 'silicon', step: 3, label: 'Place and route' },
      { chapter: 'silicon', step: 6, label: 'The real thing' },
    ],
  },
  skew: {
    idea: `The clock is one net reaching every flip-flop, and it never arrives everywhere at once. <b>Skew</b> is the difference in arrival between a launching and a capturing flip-flop; <b>jitter</b> is the variation of one edge from cycle to cycle. Let the capture clock arrive s later than the launch clock. The data has s longer to arrive, so setup relaxes: T ≥ t<sub>clk-q</sub> + t<sub>logic,max</sub> + t<sub>setup</sub> − s. But the capturing flip-flop also holds its old value s longer, so hold tightens: t<sub>clk-q</sub> + t<sub>logic,min</sub> ≥ t<sub>hold</sub> + s. Negative s does the opposite. Skew the tools cannot predict (variation, jitter) must be budgeted with the worse sign on both checks, so it costs period and hold margin at once.<br>A <b>clock tree</b> keeps it small: an H-tree makes every path from the root equally long, and clock tree synthesis balances real trees with buffers at each branch. It is also the busiest net on the chip, two transitions every cycle into every flip-flop, which is why clock gating (done with a latch-based cell, never a bare AND) saves so much power. Designers sometimes skew on purpose (useful skew) to lend time from a short stage to a long one.`,
    example: {
      title: 'One path, 2 delays of skew',
      body: `<pre>clk-to-q 3, setup 3, logic 20 (longest) and 1 (shortest), in NAND delays
no skew:          T ≥ 3 + 20 + 3       = 26
capture late 2:   T ≥ 3 + 20 + 3 − 2   = 24, hold needs 3 + 1 ≥ t_hold + 2
capture early 2:  T ≥ 3 + 20 + 3 + 2   = 28, hold needs 3 + 1 ≥ t_hold − 2</pre>A shift register (q straight into the next d, logic 0) is the classic hold victim: one late capture clock and the new value races through.`,
    },
    mistakes: [
      'Subtracting skew from the period unconditionally: a late capture clock helps setup and endangers hold; only uncertainty of unknown sign costs on both.',
      'Fixing a hold violation caused by skew with a slower clock: hold does not involve the period.',
      'Gating the clock with an AND: it adds skew (and glitches) to that branch; use an enable multiplexer or an integrated clock-gating cell.',
    ],
    chapters: [
      { chapter: 'silicon', step: 4, label: 'Wires and the clock' },
      { chapter: 'fastadd', step: 7, label: 'Static timing on our CPU' },
    ],
  },
  power: {
    idea: `<b>Dynamic power.</b> A CMOS gate draws current only to move charge: each 0 → 1 transition takes C·V² from the supply, half stored on the node and half lost in the pull-up, and the next 1 → 0 dissipates the stored half in the pull-down. So each transition costs ½·C·V² and the average power is P = α·C·V²·f, with α the transitions per cycle. Glitches count: a node that toggles three times before settling pays three times. Cures follow the formula: lower V (quadratic), fewer transitions (clock gating, operand isolation, glitch-free structures), less C (shorter wires, smaller fan-out), lower f where speed is not needed (dynamic voltage and frequency scaling).<br><b>Leakage.</b> An off transistor is not off: subthreshold current falls by only a decade per 60 mV or more of gate voltage below threshold at room temperature, so every threshold reduction multiplies it; gate-oxide tunnelling and junction leakage add to it. It flows whether or not anything switches, grows with temperature, and in idle blocks dominates; power gating (cutting a block's supply with header or footer switches) removes it at the cost of losing the state. Around 2005 it stopped the threshold, and so the supply voltage, from scaling down: Dennard scaling ended, clocks stopped near 3–5 GHz, and transistors went into cores instead.<br>The site estimates dynamic power from the gate simulation (src/sim/power.ts): C per net from its fan-out (0.5 fF per NAND input, 0.5 fF for the driver, 0.3 fF of wire per branch, illustrative 28 nm-class values), ½·C·V² per counted toggle, glitches included; no leakage.`,
    example: {
      title: 'One net, one toggle; two cores at lower voltage',
      body: `<pre>a NAND output driving 2 NAND inputs:
  C = 0.5 + 2 × (0.5 + 0.3) = 2.1 fF
  ½ C V² at 0.9 V = 0.5 × 2.1 fF × 0.81 V² ≈ 0.85 fJ per toggle

1 core at 4 GHz, 1.0 V      against   2 cores at 2.8 GHz, 0.8 V
P ∝ 1 × 1.0² × 4 = 4                  2 × 0.64 × 2.8 = 3.58</pre>0.9× the power for 1.4× the throughput, if the work splits over both cores: the energy per task falls to 0.64×.`,
    },
    mistakes: [
      'Charging C·V² per toggle: a full cycle 0 → 1 → 0 costs C·V², so each single transition costs half of it.',
      'Assuming an idle chip draws nothing: leakage flows with the clock stopped, which is why idle blocks are power-gated, not just clock-gated.',
      'Lowering the frequency alone to save energy: power falls, but the task takes longer and energy per task stays about the same until the voltage comes down too.',
    ],
    chapters: [
      { chapter: 'mosfet', step: 3, label: 'What one switch costs' },
      { chapter: 'inverter', step: 1, label: 'Why this is brilliant' },
      { chapter: 'multicore', step: 0, label: 'Why more cores?' },
    ],
  },
  metastability: {
    idea: `A bistable loop (two cross-coupled gates, the heart of every latch and flip-flop) has two stable states and, between them, a balance point. Sample an input that changes inside the setup / hold window, or release an SR latch's two inputs together, and the loop can start near that point; it then drifts away exponentially with the loop's time constant τ, so the chance it is still undecided after time t falls as e<sup>−t/τ</sup>, but never reaches zero. Meanwhile its output may sit between the levels, oscillate, or resolve late; the next stage can read it differently on different inputs.<br>Synchronous design avoids it by never changing d near the edge. Signals that are asynchronous to the clock (a button, an interrupt line, a reset release, data from another clock domain) cannot promise that, so they enter through a <b>synchronizer</b>: two (or three) flip-flops in series, nothing in between. The first may go metastable; the second samples it a whole cycle later, by when it has almost surely decided. The mean time between failures grows exponentially with the time allowed: MTBF = e<sup>t/τ</sup> / (T<sub>0</sub> · f<sub>clk</sub> · f<sub>data</sub>). Multi-bit values cross domains through a handshake or an asynchronous FIFO with Gray-coded pointers, never one synchronizer per bit.<br>Here the gate simulator detects a perfectly symmetric race (both inputs of a latch released in the same instant) and resolves it arbitrarily, as silicon does; it models the outcome, not the analogue time it takes.`,
    example: {
      title: 'One flip-flop or two (illustrative values)',
      body: `<pre>τ = 20 ps, T0 = 20 ps, f_clk = 1 GHz, input changes at 10 MHz
T0 · f_clk · f_data = 20e-12 × 1e9 × 1e7 = 2e5 per second
one flip-flop, 0.1 ns to settle:  e^5 / 2e5    ≈ 0.74 ms between failures
two flip-flops, ~0.95 ns:         e^47.5 / 2e5 ≈ 2 × 10^15 s, about 67 million years</pre>The second flip-flop costs 11 NANDs (the library DFF) and one cycle of latency.`,
    },
    mistakes: [
      'Synchronizing each bit of a bus separately: the bits can resolve in different cycles and the receiver sees a value that never existed.',
      'Putting logic between the two synchronizer flip-flops: it eats the settling time the second stage was there to give.',
      'Releasing an asynchronous reset straight into the flip-flops: the release is an input change that can land beside a clock edge; assert it asynchronously, release it through a synchronizer.',
    ],
    chapters: [
      { chapter: 'latches', step: 1, label: 'The forbidden input, and races' },
      { chapter: 'registers', step: 3, label: 'Asynchronous reset' },
    ],
  },

  // ---- arithmetic tricks
  carryselect: {
    idea: `A ripple adder's carry crosses every bit. Carry-select stops waiting for it: split the word into blocks, build each block twice, one assuming carry-in 0 and one 1, let both compute while the real carry is still on its way, and when it arrives a multiplexer picks the right sum and carry-out. The carry now crosses one multiplexer per block instead of rippling through it, at nearly twice the area. Blocks that grow along the word (small first, so each block's answers are ready just as its carry arrives) bring the delay to about √(2n) block steps; selecting at two levels does better still.<br><b>Carry-skip</b> spends much less: plain ripple blocks plus one test per block, "does every bit propagate?" (all a ⊕ b = 1). If so the block's carry-out equals its carry-in, and a multiplexer passes the carry-in straight on. A long carry ripples out of the first block, skips the middle ones and ripples into the last. Static timing overestimates it: the path through every block <em>and</em> its multiplexer exists in the netlist but can never carry the last change (a false path).`,
    example: {
      title: 'Four 32-bit adders, measured',
      body: `<pre>                  NANDs   static depth   settles in
ripple (rca32)      288        68             68
carry-skip, 4-bit   496        83             about 31 (false path)
carry-select, 4-bit 680        32             32
Kogge–Stone         878        18             18</pre>At 8 bits carry-select is 128 NANDs and depth 14, Kogge–Stone 150 and 14: at that width the select adder matches the prefix adder's depth for less.`,
    },
    mistakes: [
      'Using equal blocks and calling it optimal: the first block\'s carry and the last block\'s sum set the delay, so growing blocks balance it better.',
      'Believing a static timing report on carry-skip: its worst path is false; declare it or measure the settled delay.',
      'Forgetting the cost: carry-select duplicates every block\'s adder and adds a multiplexer per sum bit.',
    ],
    lib: 'csel8_4',
    compare: ['rca8', 'cskip8_4', 'ks8'],
    anatomy: ['alu'],
    chapters: [
      { chapter: 'fastadd', step: 3, label: 'Carry-select: compute both answers' },
      { chapter: 'fastadd', step: 4, label: 'Carry-skip, and a false path' },
      { chapter: 'fastadd', step: 6, label: 'Four adders, measured two ways' },
    ],
  },
  carrysave: {
    idea: `A full adder turns three bits of the same weight into a sum bit (weight 1) and a carry bit (weight 2). A row of n full adders with nothing connected between neighbours therefore turns three n-bit words into two, x + y + z = s + 2c, exactly, in one full-adder delay whatever n is: a <b>carry-save adder</b>, or 3:2 compressor. Nothing is lost; the carries are only postponed, kept as a word of their own. Only the very last addition, of the final two words, needs a carry-propagate adder.<br>That makes multi-operand addition cheap. A multiplier's n partial products go through layers of compressors, each shrinking the rows by 3 : 2, so the depth grows with log<sub>1.5</sub> n instead of n: the Wallace tree (Dadda's variant schedules the same cells with fewer half adders). A full adder is also a 3-bit counter, so the same tree counts ones (popcount). SRT dividers keep their partial remainder in carry-save form so that a step costs one compressor delay instead of a carry chain.`,
    example: {
      title: 'Three words into two, then into one',
      body: `<pre>x = 5 = 101, y = 6 = 110, z = 7 = 111
per bit: s = x ⊕ y ⊕ z, c = majority(x, y, z)
s = 100 = 4, c = 111 = 7
x + y + z = s + 2c = 4 + 14 = 18
rows in a 32 × 32 product: 32 → 22 → 15 → 10 → 7 → 5 → 4 → 3 → 2
eight compressor levels, then one fast adder</pre>csa8: 72 NANDs and 6 NAND delays deep; rca8: also 72 NANDs, but 20 deep, because its carries ripple.`,
    },
    mistakes: [
      'Adding s and c at equal weight: every carry leaves its column for the one above, so c counts twice.',
      'Testing a carry-save value for zero or sign directly: neither is known until the two words are added.',
      'Chaining carry-save adders in a line: the depth then grows with the number of operands; arrange them as a tree.',
    ],
    lib: 'csa8',
    compare: ['rca8'],
    chapters: [
      { chapter: 'muldiv', step: 3, label: 'Carry-save: add three, keep two' },
      { chapter: 'muldiv', step: 5, label: 'The Wallace tree' },
      { chapter: 'muldiv', step: 17, label: 'SRT: a redundant quotient' },
    ],
  },
  booth: {
    idea: `A multiplier's cost is mostly its partial-product rows, one per multiplier bit. <b>Radix-4 Booth recoding</b> halves them: read the multiplier b two bits at a time with one bit of overlap, (b<sub>2i+1</sub>, b<sub>2i</sub>, b<sub>2i−1</sub>) with b<sub>−1</sub> = 0, and turn each group into a digit d<sub>i</sub> = −2·b<sub>2i+1</sub> + b<sub>2i</sub> + b<sub>2i−1</sub> in {−2, −1, 0, +1, +2}, so that b = Σ d<sub>i</sub>·4<sup>i</sup>. Every digit selects an easy row: 0, a, 2a (a one-bit shift), or their negation (invert, and add the 1 as a separate bit in the tree). Two's-complement multipliers need no correction, because the top group already carries the sign's negative weight.<br>The rows still have to be sign-extended; instead, each row's sign bit is inverted and one constant row, computed in advance, corrects them all. The encoder per digit is small (14 NANDs here), but every row bit becomes a select and an XOR instead of one AND, so Booth pays only when halving the rows saves more than that: from about 32 bits, where it also means less wiring and power.`,
    example: {
      title: 'b = 100 = 0110 0100',
      body: `<pre>groups (b2i+1 b2i b2i−1), from the bottom:
  (0 0 0) →  0    weight 1
  (0 1 0) → +1    weight 4
  (1 0 0) → −2    weight 16
  (0 1 1) → +2    weight 64
0 + 4 − 32 + 128 = 100: four rows 0, 4a, −32a, 128a instead of eight

             NANDs   depth
 8 × 8 Booth  1 062    47      Baugh–Wooley tree  972    40
32 × 32 Booth 12 658   75      Baugh–Wooley tree 13 293  68</pre>`,
    },
    mistakes: [
      'Expecting Booth to win at every width: at 8 bits the encoders and wider row cells cost more than the four rows saved.',
      'Forgetting the +1 of a negative digit: inverting a gives −a − 1.',
      'Recoding without the overlap bit: groups of two independent bits need a 3a row, which is not a shift.',
    ],
    lib: 'bmul8',
    compare: ['wmul8s', 'amul8'],
    chapters: [
      { chapter: 'muldiv', step: 8, label: 'Booth recoding' },
      { chapter: 'muldiv', step: 9, label: 'Booth, worked' },
      { chapter: 'muldiv', step: 10, label: 'A Booth multiplier' },
    ],
  },
  fma: {
    idea: `A fused multiply-add computes a × b + c and rounds <em>once</em>. The product is kept exact, all 2M + 2 bits of it (48 for float32): when c nearly cancels it, the low product bits become the leading bits of the result, so a sticky bit would not do. c is aligned to the product, the two are added or subtracted (a difference can come out negative and is then negated), and the wide sum goes through the same normalize and round as every other operation.<br>One rounding instead of two makes it more accurate (x·x − p is exact, where fmul then fsub gives 0) and lets one instruction do the inner step of dot products, Horner's polynomial evaluation and Newton–Raphson iterations. IEEE 754-2008 made it a required operation. RISC-V F has four: fmadd.s (a·b + c), fmsub.s (a·b − c), fnmsub.s (−a·b + c), fnmadd.s (−a·b − c), opcodes 0x43, 0x47, 0x4B, 0x4F, in the R4 format with rs3 in bits 31:27; opcode bit 2 negates c, bit 3 the product. ∞ × 0 + c is invalid even when c is a quiet NaN. A single unit can then do everything: fadd is a × 1 + b, fmul is a × b + 0, which is how chapter 24's pipelined FPU uses one rounder for all of them.`,
    example: {
      title: 'One rounding saves a result',
      body: `<pre>E4M3, x = 1.125 = 1.001₂
x² = 1.265625 = 1.010001₂: 6 fraction bits, the format keeps 3
fmul  x, x       → 1.010₂ = 1.25
fsub  1.25 − 1.25 → 0
fma   x·x − 1.25  → 0.015625 = 2⁻⁶, exact, no flags

float32 here     NANDs    depth
fma              26 348    270   (multiply 92, align and add 91, round 106)
fmul then fadd            357   (176 + 181)</pre>In the single-cycle RV32IF the fma took the period from 274 to 368 NAND delays: a pipelined FPU gives it several cycles instead.`,
    },
    mistakes: [
      'Expecting fma to give the same bits as fmul then fadd: it rounds once, so results differ in the last place, and sometimes completely (cancellation).',
      'Rounding the product to M + 3 bits with a sticky bit before the add, as an adder does for its smaller operand: cancellation then exposes bits that were thrown away.',
      'Reading the opcode bits backwards: 0x47 (bit 2 set) is fmsub, negating c; 0x4B (bit 3 set) is fnmsub, negating the product.',
    ],
    lib: 'fpfma8_23',
    chapters: [
      { chapter: 'float', step: 11, label: 'Fused multiply-add: one rounding' },
      { chapter: 'float', step: 16, label: 'fma in the CPU' },
      { chapter: 'float', step: 17, label: 'A pipelined FPU' },
    ],
  },

  // ---- throughput
  scoreboard: {
    idea: `When an operation takes many cycles (a load from slow memory, a divide, an FP operation), stopping at the operation itself wastes every cycle in which later, independent instructions could run. A <b>scoreboard</b> keeps one pending bit per register: set when an instruction that will write the register issues, cleared in the cycle its result is written back. Before an instruction issues, the registers it reads (a true dependence, RAW) and the one it writes (WAW: it must not be overtaken by the older write) are looked up; any pending bit set, and it waits. So a thread stops at the first <em>use</em> of a load, not at the load.<br>The CDC 6600 (1964) introduced it to keep ten functional units busy; in-order cores with a non-blocking cache use one so instructions keep going past a miss; GPUs keep one per warp, so a warp that waits simply is not ready and the scheduler picks another. Register renaming (Tomasulo) goes further and removes WAW and WAR waits altogether, at much higher cost.`,
    example: {
      title: 'Two loads in flight (chapter 30, 8-cycle memory)',
      body: `<pre>cycle 10  lw t5, 0(t4)      sets pending[t5]; back at the end of 17
cycle 11  lw a1, 256(t4)    reads t4, writes a1: neither pending, issues
                            sets pending[a1]; back at the end of 18
          add a0, t5, a1    t5 clears after 17, a1 after 18
cycle 19  add issues        (26 if each load were waited out in turn)</pre>The warp core's scoreboard: a 32-bit pending register with set and clear decoders (1 418 NANDs per warp), and a check of 736 NANDs: three 32:1 multiplexers reading the pending bits of rs1, rs2 and rd, gated by whether the opcode uses each.`,
    },
    mistakes: [
      'Checking only the source registers: a second load to the same rd could then be overwritten by the first one returning late.',
      'Clearing the bit at issue instead of at write-back: the next instruction then reads the old value.',
      'Expecting a scoreboard to remove the latency: it only lets independent work fill it; with nothing independent, the thread still waits (and another warp has to fill the slots).',
    ],
    chapters: [
      { chapter: 'warps', step: 1, label: 'A scoreboard' },
      { chapter: 'cache', step: 13, label: 'A cache in the pipeline' },
    ],
  },
  occupancy: {
    idea: `A GPU hides latency with other work: while one warp waits for memory, another issues. How much latency it can hide depends on how many warps are resident, and that is limited by what each warp needs from fixed resources. <b>Occupancy</b> is the number of resident warps as a fraction of the hardware's maximum. The register file is the usual limit: on recent NVIDIA multiprocessors 65 536 32-bit registers are shared by all resident threads, so a kernel using 32 registers a thread fits 2 048 threads (64 warps), at 64 registers 1 024. Shared memory per block and the maximum blocks and threads per multiprocessor (2 048 on A100 / H100, 1 536 on recent consumer parts) limit it too.<br>More occupancy is not automatically better: past the point where every issue slot is filled, more warps buy nothing, and cutting registers to fit them forces spills to slow memory. Chapter 30 builds the trade-off in gates: each resident warp adds a slot and a register bank in every lane, so it costs area, and it pays only while issue slots are still empty.`,
    example: {
      title: 'saxpy over 64 elements, 8-cycle loads',
      body: `<pre>warps   cycles   issue slots used
  1      266       58 %   (154 instructions)
  2      192       83 %
  4      172      100 %   (172 instructions: every warp runs a prologue)</pre>The second warp costs 110 715 NANDs, 92 564 of them its registers: a fourth warp only fills the last empty slots.`,
    },
    mistakes: [
      'Maximizing occupancy for its own sake: once no issue slot is empty, more warps only add pressure on registers and caches.',
      'Ignoring register count: one more register per thread can drop a kernel below a warp boundary and cut the resident warps by a step.',
      'Counting threads per block instead of registers and shared memory per multiprocessor: whichever runs out first sets the occupancy.',
    ],
    chapters: [
      { chapter: 'warps', step: 4, label: 'Occupancy' },
      { chapter: 'warps', step: 2, label: 'Many warps resident' },
    ],
  },
  zbuffer: {
    idea: `Two triangles that cross in depth have no correct drawing order: each is in front of the other somewhere. The <b>depth buffer</b> (z-buffer, Catmull 1974) solves visibility per pixel: beside each colour it keeps the depth of the surface drawn there. A new pixel is written only if it passes the depth test against that value, and then its depth is written too. Opaque triangles can then arrive in any order and the nearest one wins at every pixel.<br>Depth is linear across a triangle in screen space, a plane like the edge functions: z = z<sub>0</sub> + Z<sub>x</sub>·Δx + Z<sub>y</sub>·Δy, so the rasterizer steps it with one add per pixel. Its slopes divide by twice the triangle's area, so the set-up needs a division. The buffer is cleared to "far" before each frame. Blending breaks the scheme: a translucent pixel mixes with what is already there, so translucent surfaces are drawn after the opaque ones, back to front. Real GPUs use 24- or 32-bit depth (reversed float z for precision), skip hidden work early (early-z, hierarchical z) and compress the buffer.`,
    example: {
      title: 'Chapter 32\'s depth unit',
      body: `<pre>per vertex      z in 8 bits, 0 nearest
per pixel       16 bits in the buffer, test "strictly less", then write
stepping        a fourth stepper beside the three edges, 12 fraction bits
set-up          four products (Booth), two 30-bit divisions (32 cycles each),
                ten shift-and-add steps: 76 cycles, 12 032 NANDs per triangle
clear           every tile of the screen, longer than drawing both triangles</pre>A pixel at exactly the stored depth fails: the first triangle drawn at that depth keeps it. Real APIs let the program pick the comparison.`,
    },
    mistakes: [
      'Drawing translucent surfaces with depth writes on before the opaque ones: the surface behind fails the test, and the blend already mixed with the wrong colour.',
      'Forgetting to clear the depth buffer each frame: last frame\'s near surfaces hide everything new.',
      'Expecting exact ties to be stable: two coplanar surfaces with rounding in their z flicker (z-fighting); offset one or test less-or-equal.',
    ],
    chapters: [
      { chapter: 'pixels', step: 3, label: 'Depth' },
      { chapter: 'pixels', step: 4, label: 'Blending' },
    ],
  },
  doublebuffer: {
    idea: `The screen is refreshed by a scan-out that reads the frame buffer at a fixed rate and can never wait. Draw into the frame it is reading and it shows half-finished pictures. <b>Double buffering</b> keeps two frames: the scan-out reads the <b>front</b> one while drawing goes into the <b>back</b> one, and a swap exchanges the roles. Nothing is copied: the swap moves the address multiplexers (or a base register) from one frame to the other.<br>When the swap happens matters. Swapping mid-scan shows the top of one picture and the bottom of the other, <b>tearing</b>; swapping only at <b>vsync</b>, after the last word of a scan-out, keeps every displayed frame whole. The price is that a frame can only end on a scan-out boundary, so frame times snap to whole multiples of the refresh period and the drawing waits for the flip; triple buffering adds a third frame so drawing can start the next one at once. The same trick decouples any producer from a consumer: chapter 33 double-buffers its vertex buffers, so the kernel computes frame f + 1 while frame f is drawn.`,
    example: {
      title: 'Chapter 32–33\'s frames',
      body: `<pre>frame           64 × 64 RGB332 = 4 KB, four byte banks
scan-out        one word (4 pixels) a cycle: 1 024 cycles a frame, vsync on the last
swap            two address multiplexers change sides; 256 NANDs with the scan-out
chapter 33      the triangle's frame: clear, triangle, then wait for vsync,
                6 144 cycles = six scan-outs exactly</pre>Untick "wait for vsync" in chapter 32 and swap mid-frame to see a tear.`,
    },
    mistakes: [
      'Copying the back frame into the front one: it costs a whole frame of memory traffic for what two multiplexers do.',
      'Swapping as soon as drawing ends: the scan-out is mid-frame, and the screen tears.',
      'Expecting a frame that takes 1.1 scan-outs to draw to show at 1.1 scan-outs: with the flip at vsync it shows after 2.',
    ],
    chapters: [
      { chapter: 'pixels', step: 0, label: 'A frame in memory' },
      { chapter: 'graphics', step: 1, label: 'The pipeline' },
    ],
  },
};
