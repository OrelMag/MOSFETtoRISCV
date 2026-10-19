// Check yourself questions for codexnew.ts's entries (see codexcheck.ts), group 4. Answers first: the quiz shuffles
// the options (ui/quiz.ts shuffleOrder). No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK4: Record<string, Quiz[]> = {
  coherence: [
    {
      question: 'Two cores under MESI. Core 0 reads a line no cache holds, then writes it. How many bus transactions does the write itself need?',
      options: ['None: the read left the line Exclusive, and E → M is silent', 'One upgrade, to invalidate the other copies', 'One BusRdX, to fetch the line again', 'Two: an invalidation and a write-back'],
      answer: 0,
      explain: 'No other cache answered the read, so MESI filled the line in Exclusive. A write to an Exclusive line moves it to Modified without telling anyone: there is no other copy to invalidate. Under MSI the same write would broadcast an upgrade.',
      why: ['', 'That is MSI, where the read leaves the line Shared. MESI\'s Exclusive state records that no one else has it.', 'The line is already in the cache and valid; a BusRdX is for a write miss.', 'Nothing is dirty anywhere else and no other copy exists: neither is needed.'],
    },
    {
      question: 'x and y are separate variables in one 64-byte line. Core 0 writes only x, core 1 only y, in turn, 6 writes in all. What happens?',
      options: ['Every write takes the line from the other cache: 6 transactions, 5 invalidations (false sharing)', 'Nothing special: different variables never interact', 'The writes to one of them are lost', 'The hardware splits the line in two'],
      answer: 0,
      explain: 'Coherence tracks lines, not variables. Each write needs the line Modified, so it invalidates the other core\'s copy (which supplies the dirty data). Padding x and y onto separate lines leaves 2 transactions, each core\'s first write.',
      why: ['', 'They share a line, and ownership is per line: each write needs the whole line exclusive.', 'Coherence keeps both writes; false sharing costs traffic and time, never correctness.', 'Caches have no notion of variables inside a line; only software (padding, alignment) can separate them.'],
    },
  ],
  atomics: [
    {
      question: 'Two cores each run <code>lw t0, 0(a0); addi t0, t0, 1; sw t0, 0(a0)</code> twenty times on one counter. Every single access is atomic. Why can the result be less than 40?',
      options: ['A core can load between the other\'s load and store, so both store the same incremented value', 'The memory drops one of two simultaneous stores', 'addi is not atomic', 'The cores read stale values from their caches'],
      answer: 0,
      explain: 'Atomic accesses do not make an atomic sequence. In chapter 25 core 1 runs one cycle behind and always loads before core 0 has stored: the counter ends at 20. amoadd.w does the read, the add and the write in one access, and gives 40.',
      why: ['', 'An access that loses arbitration waits a cycle; none is dropped.', 'addi works on a register; only the memory accesses are shared.', 'Chapter 25\'s dual-core has no caches at all, and the race happens anyway.'],
    },
    {
      question: 'In an LR/SC loop, <code>sc.w t1, t0, (a0)</code> leaves t1 = 1. What happened, and what should the code do?',
      options: ['The store did not happen (the reservation was lost): branch back and redo the lr.w', 'The store succeeded and t1 is the old value', 'A trap: sc.w without lr.w is illegal', 'The store succeeded twice'],
      answer: 0,
      explain: 'sc.w writes 0 to rd on success and a non-zero value on failure, typically because another hart wrote the reserved word in between. The loop retries from lr.w with the fresh value.',
      why: ['', 'Success writes 0 to rd; the old value is what lr.w returned.', 'A failing sc.w is a normal outcome, not an exception.', 'sc.w stores at most once, and here it did not store at all.'],
    },
  ],
  ordering: [
    {
      question: 'x = y = 0. Hart 0: <code>sw 1 → x; lw r0 ← y</code>. Hart 1: <code>sw 1 → y; lw r1 ← x</code>. Which result does sequential consistency forbid but RVWMO allow?',
      options: ['r0 = 0 and r1 = 0', 'r0 = 1 and r1 = 1', 'r0 = 0 and r1 = 1', 'None: they allow the same results'],
      answer: 0,
      explain: 'Under SC whichever store comes first in the global order precedes both loads, so at least one load sees 1. With store buffers both stores can wait while both loads read memory: 0 and 0. A fence rw,rw (or fence w,r) between store and load forbids it.',
      why: ['', 'Both stores before both loads is a valid interleaving under SC too.', 'Hart 0 runs both of its instructions, then hart 1 runs both: r0 = 0, r1 = 1, a valid SC interleaving.', 'The store-buffer outcome is exactly the difference between the two models.'],
    },
    {
      question: 'A lock is released with a plain <code>sw zero, lock</code> on a weakly ordered RISC-V core. What can go wrong, and what fixes it?',
      options: ['The lock store can become visible before the critical section\'s stores; put fence rw,w before it (or use amoswap.w.rl)', 'Nothing: a store of zero is always ordered', 'The store is not atomic; use two stores', 'The lock word must be read first'],
      answer: 0,
      explain: 'Release semantics: nothing before the release may become visible after it. Without it another hart can take the lock and still read the old data. On chapter 25\'s sequentially consistent dual-core this cannot happen, which is why such bugs hide.',
      why: ['', 'The value is irrelevant; RVWMO may reorder it with earlier stores to other addresses.', 'An aligned word store is already atomic; the problem is order, not atomicity.', 'Reading the lock orders nothing about the earlier stores.'],
    },
  ],
  amdahl: [
    {
      question: '90 % of a program parallelizes perfectly. What speed-up does it get on 8 cores?',
      options: ['About 4.7×', '8×', '7.2×', '10×'],
      answer: 0,
      explain: '1 / (0.1 + 0.9 / 8) = 1 / 0.2125 = 4.7. The serial 10 % stays; 10× is the limit on infinitely many cores.',
      why: ['', 'That speeds up the whole program, including the serial 10 %.', 'That is 0.9 × 8: speeding up the parallel part does not scale the total that way.', 'That is the limit as the core count goes to infinity.'],
    },
    {
      question: 'A program is 95 % parallel. What is the most speed-up any number of cores can give it?',
      options: ['20×', '95×', 'No limit: add cores', '19×'],
      answer: 0,
      explain: 'As n grows, (1 − p) + p / n falls to 1 − p = 0.05, so the speed-up approaches 1 / 0.05 = 20×. The serial 5 % sets the ceiling, however many cores run the rest.',
      why: ['', 'That reads the parallel fraction as a speed-up; it only says how much of the time can shrink.', 'The serial 5 % runs at one core\'s speed whatever n is: the time never falls below it.', 'That is 0.95 / 0.05; the speed-up is the whole time over the serial time, 1 / 0.05.'],
    },
  ],
  amat: [
    {
      question: 'L1: 4-cycle hit, 5 % misses. L2: 12-cycle hit, 20 % local misses. DRAM: 250 cycles. What is the AMAT?',
      options: ['7.1 cycles', '4.6 cycles', '16.5 cycles', '266 cycles'],
      answer: 0,
      explain: 'L2: 12 + 0.2 × 250 = 62. L1: 4 + 0.05 × 62 = 7.1. The penalty of each level is the AMAT of the next.',
      why: ['', 'That charges an L1 miss only the L2 hit time and forgets the 20 % that go on to DRAM.', 'That sends every L1 miss straight to DRAM, as if there were no L2.', 'That adds the three latencies, as if every access went all the way to DRAM.'],
    },
    {
      question: 'A single-cycle CPU runs 188 instructions with 32 loads; 4 loads miss and each miss stalls 8 cycles. What is its CPI?',
      options: ['About 1.17', '1.0', 'About 2.36', '2.0'],
      answer: 0,
      explain: '4 × 8 = 32 stall cycles: (188 + 32) / 188 = 1.17, chapter 21\'s "Sum an array twice". Stall cycles per instruction = loads per instruction × miss rate × penalty = (32/188) × (4/32) × 8.',
      why: ['', 'Misses stall the CPU: the stall cycles add to one cycle per instruction.', 'That charges 8 cycles to all 32 loads: (188 + 256) / 188. Only 4 of them miss.', 'That would be one stall cycle per instruction; there are 32 in 188.'],
    },
  ],
  threecs: [
    {
      question: 'A loop sweeps a 512-byte array again and again through a 256-byte fully associative cache with LRU. After the first pass, what are its misses?',
      options: ['Capacity misses', 'Conflict misses', 'Compulsory misses', 'Coherence misses'],
      answer: 0,
      explain: 'The working set is twice the cache; under LRU a sequential sweep evicts every line before it comes round again. A fully associative cache has no conflicts, and the compulsory misses all happened in the first pass.',
      why: ['', 'A conflict needs one set to overflow while others have room; a fully associative cache is one set.', 'Compulsory misses are each line\'s first touch, all in the first pass.', 'There is only one core and no invalidations.'],
    },
    {
      question: 'Which change removes conflict misses but not capacity misses?',
      options: ['More ways at the same size', 'A larger cache', 'Longer lines', 'Prefetching the next line'],
      answer: 0,
      explain: 'Associativity redistributes lines among sets; it adds no room. A larger cache cuts capacity (and conflict) misses; longer lines and prefetching target compulsory misses.',
      why: ['', 'A larger cache adds room, so it cuts capacity misses too.', 'Longer lines cut compulsory misses (spatial locality), and with fewer lines they can add conflicts.', 'Prefetching brings lines in before their first use: it targets compulsory misses.'],
    },
  ],
  assoc: [
    {
      question: 'A 256-byte cache with 16-byte lines goes from direct-mapped to 4-way at the same size. What happens to the index?',
      options: ['16 sets become 4: the index shrinks from 4 bits to 2 and the tag grows by 2', 'It stays 4 bits; each set just holds 4 lines', 'It grows to 6 bits', 'There is no index any more'],
      answer: 0,
      explain: '256 / 16 = 16 lines. Direct-mapped: 16 sets, 4 index bits. 4-way: 4 sets of 4 lines, 2 index bits, and the 2 bits the index lost join the tag.',
      why: ['', 'Same capacity, four lines per set: there are only a quarter as many sets to index.', 'More ways mean fewer sets, never more.', 'Only a fully associative cache (one set) has no index.'],
    },
    {
      question: 'How many bits of replacement state does exact LRU need per set at 2 ways, and how many does tree pseudo-LRU use at 8?',
      options: ['1 and 7', '2 and 8', '1 and 24', '0 and 3'],
      answer: 0,
      explain: 'Two ways: one bit names the way used less recently. Exact LRU at 8 ways needs log₂(8!) ≈ 16 bits and an update on every hit; tree pseudo-LRU keeps one bit per node of a binary tree over the ways, n − 1 = 7.',
      why: ['', 'One bit already names one of two ways, and a tree over 8 ways has 7 nodes.', '24 bits is 8 ways × 3-bit ages, an exact scheme that pseudo-LRU avoids.', 'A direct-mapped cache needs none; any choice between ways needs state.'],
    },
  ],
  writepolicy: [
    {
      question: 'A loop makes 48 stores to 16 words, all hits after the first pass. How many words reach main memory during the run, write-through against write-back?',
      options: ['48 against 0', '16 against 48', '48 against 48', '0 against 16'],
      answer: 0,
      explain: 'Write-through sends every store on. Write-back keeps them in dirty lines; memory sees each line once, when it is evicted (16 words if all four lines leave), not during the run.',
      why: ['', 'That swaps the policies: write-through is the one that writes on every store.', 'The write-back cache absorbs the stores in its dirty lines.', 'Write-through writes immediately, by definition.'],
    },
    {
      question: 'A write buffer is added in front of memory. A load reads a word that was just stored and is still in the buffer. What must the hardware do?',
      options: ['Return the buffered value (or wait for the buffer to drain)', 'Read memory: the buffer only holds writes', 'Drop the buffered store', 'Nothing: write buffers make this impossible'],
      answer: 0,
      explain: 'The buffer holds the newest value. A load that bypassed it would read the stale word from memory: a read-after-write hazard through memory. Hardware forwards from the buffer or stalls until it has drained.',
      why: ['', 'Memory still holds the old value until the buffer drains: the load would read stale data.', 'Dropping it loses the store.', 'Buffering is exactly what creates the window in which memory is stale.'],
    },
  ],
  vm: [
    {
      question: 'Sv32 with 4 KiB pages: how many memory reads does a translation take when the TLB misses?',
      options: ['Two: one entry from each level of the page table', 'One', 'Four, one per byte of the address', 'None: the TLB computes it'],
      answer: 0,
      explain: 'Sv32 splits the virtual page number into two 10-bit halves: the first indexes the root table (found through satp), the second the table it points to. Then the access itself follows.',
      why: ['', 'One read would need a single table with 2²⁰ entries; Sv32 has two levels.', 'The levels follow the page-number split (10 + 10 bits), not bytes.', 'A TLB caches translations; on a miss it must walk the table.'],
    },
    {
      question: 'Why do many L1 caches index with page-offset bits only, limiting them to page size × ways (4 KiB × 8 = 32 KiB)?',
      options: ['So the set can be read while the TLB translates: offset bits are the same in virtual and physical addresses', 'Because physical addresses are shorter', 'To avoid needing tags', 'Because the TLB holds the data'],
      answer: 0,
      explain: 'Virtually indexed, physically tagged: the offset needs no translation, so indexing and translation overlap and the physical tag is compared at the end. Index bits above the offset would let one physical line sit in two sets (aliases).',
      why: ['', 'Sv32\'s physical addresses are longer (34 bits), not shorter.', 'The physical tag is still compared; only the index avoids translated bits.', 'The TLB holds translations, never data.'],
    },
  ],
  sram: [
    {
      question: 'Why must a 6T cell\'s pull-down transistors be stronger than its access transistors?',
      options: ['So a read, with both bit lines precharged high, cannot lift the 0 node enough to flip the cell', 'So a write can flip the cell', 'To make the cell smaller', 'So the bit lines need no precharge'],
      answer: 0,
      explain: 'During a read the access transistor connects the 0 node to a high bit line. The stronger pull-down keeps that node near 0, below the other inverter\'s threshold. Writes rely on the other ratio: access stronger than the weak pull-up.',
      why: ['', 'A write works through the access transistor overpowering the weak pull-up; the pull-down ratio protects reads.', 'Stronger transistors are wider, so it costs area.', 'Precharge is what makes the read work; sizing does not remove it.'],
    },
    {
      question: 'In chapter 21 a 4 × 4 SRAM array is 320 transistors, of which 96 are cells. Why do real 32 KB arrays reach over 90 % cells?',
      options: ['Decoders, precharge, write drivers and sense amplifiers are shared per row or column, so they grow far slower than the cells', 'Real cells are larger', 'Real arrays have no periphery', 'Larger arrays use 4T cells'],
      answer: 0,
      explain: 'Cells grow with rows × columns, the periphery with rows + columns. At 8 × 8 the cells are already 43 % (384 of 892).',
      why: ['', 'Real cells are much smaller than drawn here; the share changes because the periphery amortizes.', 'Every array needs decoders and sense amplifiers.', 'The cell stays 6T; only the periphery\'s share shrinks.'],
    },
  ],
  ecc: [
    {
      question: 'How many check bits does SEC-DED add to 64 data bits?',
      options: ['8', '7', '6', '64'],
      answer: 0,
      explain: 'Hamming needs 2^r ≥ k + r + 1: r = 7 for k = 64 (128 ≥ 72). One more overall parity bit tells one error from two: 8, the 72-bit ECC word.',
      why: ['', '7 corrects one error but cannot tell two from one; the overall parity bit makes it 8.', '2⁶ = 64 is less than 64 + 6 + 1: six bits cannot name every position.', 'That is duplication, which detects but cannot even correct one error.'],
    },
    {
      question: 'In an SEC-DED word two bits flip. What does the decoder see?',
      options: ['A non-zero syndrome with even overall parity: it reports a double error and corrects nothing', 'An odd parity and the position of one bit, which it flips', 'A zero syndrome: nothing wrong', 'It corrects both'],
      answer: 0,
      explain: 'Two flips leave the overall parity even, which a single error never does, while their positions XOR to a non-zero syndrome. Three flips can look like one and be miscorrected.',
      why: ['', 'Odd overall parity means an odd number of flips: one, as far as SEC-DED knows.', 'Two different positions never XOR to zero.', 'SEC-DED corrects one error and only detects two.'],
    },
  ],
  rowhammer: [
    {
      question: 'Why does refreshing every row within 64 ms not protect against row hammer?',
      options: ['Activating a neighbouring row drains a victim faster than leakage, and a row can be activated about 1.4 million times in 64 ms', 'Refresh skips rows that are being read', 'Row hammer writes the victim row directly', 'Refresh only covers rows that hold 1s'],
      answer: 0,
      explain: 'Refresh is sized for leakage. Each activation of an aggressor disturbs its neighbours; at tRC = 45.75 ns (DDR4-3200) one row can be activated about 1.4 million times per window, ten times the 139 000 that flipped DDR3 bits in 2014.',
      why: ['', 'Refresh covers every row on schedule; the problem is what happens between refreshes.', 'The attacker never writes the victim: the flips come from activating its neighbours.', 'Refresh restores every cell, 0s and 1s alike (and real arrays mix true and anti-cells).'],
    },
    {
      question: 'Which defence counts a row\'s activations and refreshes its neighbours early?',
      options: ['Target row refresh (DDR4) and refresh management (DDR5)', 'SEC-DED ECC', 'A write-back cache', 'Closed-page policy'],
      answer: 0,
      explain: 'TRR (inside DDR4 devices) and DDR5\'s refresh management track heavily activated rows and refresh their victims before they flip. ECC only corrects what has already flipped, and only one bit a word.',
      why: ['', 'ECC corrects a flip after it happens, one bit per word; it counts nothing.', 'An attacker flushes or evicts the line, so every access still reaches DRAM.', 'Closing the row after each access means every access activates it: if anything, that helps the attacker.'],
    },
  ],
  rv32i: [
    {
      question: 'Memory holds 0x12AB5678 at address 0. What does <code>lb x5, 2(x0)</code> load?',
      options: ['0xFFFFFFAB', '0x000000AB', '0x00000056', '0xFFFFFF56'],
      answer: 0,
      explain: 'Little-endian: byte 0 is 0x78, byte 2 is 0xAB. lb sign-extends, and 0xAB has its top bit set: −85. lbu would give 0x000000AB.',
      why: ['', 'That is lbu, which zero-extends.', '0x56 is byte 1; little-endian puts the least significant byte at the lowest address.', '0x56 is byte 1, not byte 2; and its top bit is 0, so lb would not fill the upper bits with 1s.'],
    },
    {
      question: 'At pc = 0x0000_1000, what does <code>auipc t0, 0x12345</code> leave in t0?',
      options: ['0x1234_6000', '0x1234_5000', '0x0001_2345', '0x1234_5000 + 4'],
      answer: 0,
      explain: 'auipc adds the immediate, shifted left by 12, to the PC of the auipc itself: 0x1234_5000 + 0x1000 = 0x1234_6000. That is lui\'s result plus the PC, the basis of position-independent addresses.',
      why: ['', 'That is lui, which ignores the PC.', 'The 20-bit immediate goes into the upper bits, shifted left by 12.', 'auipc uses its own PC, not pc + 4.'],
    },
  ],
  stdcell: [
    {
      question: 'Why do all cells of a standard-cell library share one height?',
      options: ['So they abut in rows that share the VDD and GND rails, whatever their widths', 'Because every cell has the same number of transistors', 'So the router needs only one metal layer', 'Because the foundry charges per row'],
      answer: 0,
      explain: 'A fixed height with rails at the top and bottom lets any cells sit side by side in a row, rails connecting by abutment; the width varies with the function and drive strength.',
      why: ['', 'Cells differ widely, from an inverter to a flip-flop; only the height is fixed.', 'Routing uses several layers whatever the cell height.', 'The height is a layout rule, not a pricing one.'],
    },
    {
      question: 'Placement shortened the total wire length, yet routing now fails on some nets. What is the likely cause?',
      options: ['Congestion: too many nets compete for the tracks in one region', 'Shorter wires are harder to route', 'The cells overlap', 'Routing needs a random placement'],
      answer: 0,
      explain: 'Wire length is an estimate summed over the chip. A placement can be short overall and still pack nets into a region with too few tracks. Real placers estimate congestion and spread cells to leave room.',
      why: ['', 'Shorter nets are easier one by one; the trouble is how many share one region.', 'A legal placement has no overlaps; legalization ensures it.', 'A random placement is far worse: long crossing nets congest everything.'],
    },
  ],
  skew: [
    {
      question: 'The capture flip-flop\'s clock arrives 2 delays later than the launch flip-flop\'s. What does that do?',
      options: ['Relaxes setup by 2 and tightens hold by 2', 'Tightens setup by 2 and relaxes hold by 2', 'Tightens both by 2', 'Nothing, if the period is long enough'],
      answer: 0,
      explain: 'The data has 2 more delays to arrive before the capturing edge: T ≥ clk-to-q + logic + setup − 2. But the capture flip-flop also needs its old input held 2 longer: clk-to-q + shortest logic ≥ hold + 2.',
      why: ['', 'That is a capture clock arriving early.', 'Only skew of unknown sign is budgeted against both checks.', 'Hold does not involve the period: a hold violation fails at every frequency.'],
    },
    {
      question: 'Why does an H-tree distribute the clock with little skew?',
      options: ['Every path from the root to a leaf has the same length', 'It uses thicker wires', 'It clocks each flip-flop separately', 'It runs at half the frequency'],
      answer: 0,
      explain: 'Each level splits into four equal branches, so all leaves are the same distance from the source. A single spine from one edge reaches near and far flip-flops at different times.',
      why: ['', 'Wire width changes delay per length, not the mismatch between paths.', 'It is one net branching to all of them; equal branch lengths are the point.', 'The tree does not change the frequency.'],
    },
  ],
  power: [
    {
      question: 'A NAND output drives two NAND inputs (C = 2.1 fF in the site\'s model). What energy does one 0 → 1 transition cost at 0.9 V?',
      options: ['About 0.85 fJ (½·C·V²)', 'About 1.7 fJ (C·V²)', 'About 1.9 fJ (C·V)', 'Nothing: CMOS has no static current'],
      answer: 0,
      explain: 'A full swing 0 → 1 → 0 draws C·V² from the supply; each transition costs half: 0.5 × 2.1 fF × 0.81 V² ≈ 0.85 fJ.',
      why: ['', 'C·V² is the cost of a full cycle, two transitions.', 'C·V is the charge moved, not the energy.', 'No static current, but every transition moves charge, and that is the dynamic power.'],
    },
    {
      question: 'A block is clock-gated: its clock stopped, its supply on. Which power does it still draw?',
      options: ['Leakage', 'Dynamic power at the same rate', 'None', 'Only short-circuit current'],
      answer: 0,
      explain: 'Stopping the clock stops the transitions, so the dynamic power goes. Off transistors still leak; only power gating (cutting the supply) removes that, at the cost of the block\'s state.',
      why: ['', 'Nothing toggles once the clock stops: the α in α·C·V²·f is zero.', 'Leakage flows whenever the supply is on.', 'Short-circuit current flows only during transitions, which stopped.'],
    },
  ],
  metastability: [
    {
      question: 'Why does a synchronizer use two flip-flops in series rather than one?',
      options: ['The first may go metastable; the second samples it a whole cycle later, when it has almost surely settled', 'Two flip-flops sample twice as often', 'The second one inverts the signal back', 'One flip-flop cannot hold an asynchronous signal at all'],
      answer: 0,
      explain: 'The chance of still being undecided falls as e^(−t/τ). Giving the first stage a whole cycle to settle before anyone reads it multiplies the mean time between failures by e^(T/τ): from milliseconds to millions of years with typical values.',
      why: ['', 'Both are clocked by the same edge rate; the second adds time to settle, not samples.', 'Neither inverts; it is d to q to d to q.', 'One flip-flop samples it fine most of the time; the problem is the rare sample inside the setup / hold window.'],
    },
    {
      question: 'An 8-bit counter value crosses to another clock domain through one two-flip-flop synchronizer per bit. What can go wrong?',
      options: ['Bits that change together can resolve in different cycles, so the receiver sees a value that never existed', 'Nothing: each bit is synchronized', 'The counter stops', 'Only the top bit is affected'],
      answer: 0,
      explain: 'From 0111 1111 to 1000 0000 every bit changes; each synchronizer may catch the old or the new value. Cross with a handshake, or Gray-code the value so only one bit changes per step (asynchronous FIFOs do this).',
      why: ['', 'Each bit is safe alone; together they need not agree on the cycle.', 'The source counter is unaffected; the receiver reads wrong values.', 'Any bit that changes can resolve late.'],
    },
  ],
  carryselect: [
    {
      question: 'A 32-bit carry-select adder in 4-bit blocks is 680 NANDs, depth 32; a ripple adder is 288 NANDs, depth 68. Where does the extra area go?',
      options: ['Every block (after the first) is built twice, for carry-in 0 and 1, plus a multiplexer per sum bit', 'Into a prefix tree', 'Into longer wires', 'Into a carry-lookahead unit per block'],
      answer: 0,
      explain: 'Both answers are computed while the carry is on its way, then a multiplexer chooses: the carry crosses one multiplexer per block instead of four full adders.',
      why: ['', 'That is Kogge–Stone (878 NANDs, depth 18), a different structure.', 'NAND counts measure gates, not wire.', 'The blocks here ripple inside; the speed comes from selecting, not looking ahead.'],
    },
    {
      question: 'Static timing reports 83 delays for the 32-bit carry-skip adder, yet simulated it settles in about 31. Why?',
      options: ['Its worst path (ripple through every block and then its multiplexer) can never carry the last change: a false path', 'The simulator skips gates', 'Static timing counts each gate twice', 'Carry-skip is asynchronous'],
      answer: 0,
      explain: 'When a block would ripple all the way through, every bit propagates, and then its multiplexer has already chosen the skip. Static timing cannot know that; designers declare such paths false.',
      why: ['', 'The simulator runs every gate with its delay; it just never sees that path sensitized.', 'Every gate on a path counts once; the error is a whole path that no input exercises.', 'It is ordinary combinational logic.'],
    },
  ],
  carrysave: [
    {
      question: 'A carry-save adder takes x = 5, y = 6, z = 7 and returns s = 4, c = 7. What is x + y + z?',
      options: ['18 (s + 2c)', '11 (s + c)', '25', 'Unknown until the carries ripple'],
      answer: 0,
      explain: 'Each carry bit belongs to the column above, so c has weight 2: 4 + 14 = 18. Nothing is lost, only postponed into a separate word.',
      why: ['', 'That adds the carry word at the wrong weight.', 'That counts c twice on top of the inputs: s + 2c already is the whole sum.', 'The value is fully determined; only a final carry-propagate add turns two words into one.'],
    },
    {
      question: 'Why is a Wallace tree multiplier\'s depth proportional to log n rather than n?',
      options: ['Each layer of 3:2 compressors cuts the rows by a third, in one full-adder delay whatever the width', 'It uses a faster full adder', 'It produces fewer partial products', 'It skips the final adder'],
      answer: 0,
      explain: 'n rows become 2 after about log₁.₅(n / 2) layers (32 rows: 8 layers), each one full-adder delay because nothing ripples sideways. One carry-propagate adder finishes.',
      why: ['', 'Same full adders as the array; only the arrangement differs.', 'That is Booth recoding; a Wallace tree sums all n rows.', 'A fast carry-propagate adder still adds the last two words.'],
    },
  ],
  booth: [
    {
      question: 'Radix-4 Booth: the bit group (b<sub>2i+1</sub>, b<sub>2i</sub>, b<sub>2i−1</sub>) = (1, 0, 0). Which digit, and which row?',
      options: ['−2: the row is −2a', '+4: the row is 4a', '+2: the row is 2a', '−1: the row is −a'],
      answer: 0,
      explain: 'd = −2·b<sub>2i+1</sub> + b<sub>2i</sub> + b<sub>2i−1</sub> = −2. The row is a shifted left once and negated (inverted, with a +1 added into the tree).',
      why: ['', 'Digits stay within −2 … +2; the top bit of the group has weight −2.', 'The top bit carries negative weight in the recoding.', '−1 is (1, 0, 1) or (1, 1, 0).'],
    },
    {
      question: 'At 8 × 8 the Booth multiplier is 1 062 NANDs against 972 for the Baugh–Wooley tree. Why does halving the rows not pay at that width?',
      options: ['Each row bit becomes a select and an XOR instead of one AND, and the encoders sit in front: that costs more than four rows save', 'Booth needs more rows at 8 bits', 'The final adder doubles in width', 'Booth only works for unsigned operands'],
      answer: 0,
      explain: 'The saving grows with the number of rows. At 32 bits Booth wins: 12 658 NANDs against 13 293, and fewer rows also mean less wiring and power.',
      why: ['', 'It has 4 rows (plus correction bits) against 8.', 'The product width is 16 bits either way.', 'Booth handles two\'s complement naturally; that is one of its attractions.'],
    },
  ],
  fma: [
    {
      question: 'Why must an FMA keep all 2M + 2 bits of the product instead of rounding it with a sticky bit, as an adder does with its smaller operand?',
      options: ['When c nearly cancels the product, its low bits become the leading bits of the result', 'The multiplier cannot round', 'The exponent needs the low bits', 'A sticky bit is enough; keeping them is only for speed'],
      answer: 0,
      explain: 'With c ≈ −a·b the subtraction cancels the leading bits, and what remains is the product\'s low bits, which must be exact. The adder can use sticky because its operands are already rounded to M + 1 bits.',
      why: ['', 'A multiplier could round its output; the question is whether the low bits are still needed.', 'The exponent comes from the operands\' exponents.', 'A sticky bit only records that something was dropped; after cancellation the dropped bits are the answer.'],
    },
    {
      question: 'In E4M3, x = 1.125. fmul x, x gives 1.25 and fsub 1.25 − 1.25 gives 0. What does fma(x, x, −1.25) give?',
      options: ['2⁻⁶, exactly', '0', '1.25', '−0'],
      answer: 0,
      explain: 'x² = 1.265625 exactly; fma keeps it unrounded and subtracts 1.25: 0.015625 = 2⁻⁶, representable, so no flags. One rounding instead of two.',
      why: ['', 'That is fmul then fsub, which rounded x² to 1.25 first.', 'That forgets the subtraction.', 'An exact zero would need x² = 1.25 exactly, and it is not.'],
    },
  ],
  scoreboard: [
    {
      question: 'With 8-cycle loads, <code>lw t5</code> issues in cycle 10 and the independent <code>lw a1</code> in cycle 11. When can <code>add a0, t5, a1</code> right after them issue at the earliest?',
      options: ['Cycle 19', 'Cycle 12', 'Cycle 18', 'Cycle 26'],
      answer: 0,
      explain: 'a1 is written back at the end of cycle 18 (issued in 11, back at the end of 11 + 7), so a reader issues in 19. Both loads were in flight at once; waiting for each in turn would mean 26.',
      why: ['', 'Both registers are still pending in cycle 12.', 't5 is ready by 18, but a1 is written back only at the end of 18.', 'That waits for the first load before issuing the second; they are independent.'],
    },
    {
      question: 'Why does the warp core\'s scoreboard check also look at a load\'s rd?',
      options: ['A second load to a pending register could be overtaken by the first one returning later (WAW)', 'To read the old value', 'Because rd is the address', 'It does not need to'],
      answer: 0,
      explain: 'Pending rd means a value is still on its way to that register. Letting another write to it go ahead risks the older value landing last. The check reads the pending bits of rs1, rs2 and rd, gated by whether the opcode uses each.',
      why: ['', 'A load does not read its rd.', 'The address comes from rs1 plus the offset.', 'Without it an older load could overwrite a newer result.'],
    },
  ],
  occupancy: [
    {
      question: 'A multiprocessor has 65 536 registers. A kernel needs 64 registers per thread. How many threads fit, by registers alone?',
      options: ['1 024', '2 048', '512', '65 536'],
      answer: 0,
      explain: '65 536 / 64 = 1 024 threads, 32 warps of 32: half what fits at 32 registers a thread.',
      why: ['', 'That is at 32 registers a thread.', 'That would be 128 registers a thread.', 'That counts registers, not threads.'],
    },
    {
      question: 'Chapter 29\'s saxpy takes 266 cycles on one warp, 192 on two and 172 on four. Why would an eighth warp gain almost nothing?',
      options: ['Four warps already fill every issue slot; more warps only add registers and gates', 'The memory cannot take more requests', 'The scheduler supports four warps at most', 'Each warp runs the whole array'],
      answer: 0,
      explain: 'At four warps 172 instructions issue in 172 cycles: no slot is left empty for another warp to fill. Each resident warp costs a slot and a register bank per lane (the second one 110 715 NANDs).',
      why: ['', 'One request enters the memory pipeline every cycle; it is slow, not busy.', 'The limit here is the empty issue slots, not the scheduler.', 'The warps divide the elements by thread id.'],
    },
  ],
  zbuffer: [
    {
      question: 'Depth test on (strictly nearer passes). A pixel arrives with exactly the depth already stored. What happens?',
      options: ['It is not written: equal is not nearer', 'It is written: it is not farther', 'The colours are averaged', 'The depth buffer is cleared'],
      answer: 0,
      explain: 'Chapter 31\'s comparator is "less than": the first triangle drawn at that depth keeps the pixel. Real APIs let the program choose less, less-or-equal and others.',
      why: ['', 'That would be a less-or-equal test.', 'Blending is a separate step applied to a pixel that passed.', 'The buffer is cleared once per frame, not by a test.'],
    },
    {
      question: 'A translucent triangle is drawn first (depth write on), then an opaque one behind it. What goes wrong where they overlap?',
      options: ['The opaque pixels fail the depth test, and the translucent ones were blended over the old background', 'Nothing: the depth test sorts it out', 'The opaque one covers the translucent one', 'The overlap is blended twice'],
      answer: 0,
      explain: 'The translucent pixels wrote their depth, so the surface behind is rejected, and the blend had already mixed with whatever was in the frame. Hence opaque first, translucent back to front.',
      why: ['', 'The depth test picks a surviving pixel; it cannot redo a blend.', 'It is behind, so the depth test rejects it there.', 'The opaque pixels are rejected: there is no second blend.'],
    },
  ],
  doublebuffer: [
    {
      question: 'Swap is pressed mid-frame with "wait for vsync" off. What does the screen show?',
      options: ['The top of one picture and the bottom of the other: tearing', 'A black frame', 'The old picture until a copy finishes', 'The frame from two swaps back'],
      answer: 0,
      explain: 'The scan-out keeps reading word by word; the swap moves its address multiplexers at once, so the rest of the frame comes from the other buffer.',
      why: ['', 'The scan-out never stops sending pixels.', 'Nothing is copied: the swap takes effect at once.', 'A swap shows the frame just drawn.'],
    },
    {
      question: 'Frames flip only at vsync, every 1 024 cycles. Drawing a frame takes 1 100 cycles. How often does a new picture appear?',
      options: ['Every 2 048 cycles', 'Every 1 100 cycles', 'Every 1 024 cycles', 'Every 2 124 cycles'],
      answer: 0,
      explain: 'The frame misses the first vsync by 76 cycles and flips at the second: frame times snap to whole scan-outs. Triple buffering lets drawing start the next frame instead of waiting.',
      why: ['', 'The flip waits for a vsync; it cannot happen when drawing ends.', 'Drawing is slower than one scan-out, so it misses the first vsync.', 'Flips come only at vsync boundaries, multiples of 1 024.'],
    },
  ],
};
