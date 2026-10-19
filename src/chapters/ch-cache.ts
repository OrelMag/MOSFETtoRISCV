import { DRAM_CELL, SRAM_COLUMN, cachedMemory, eccChannel, sramArray, wayLookup2 } from '../lib';
import { assemble } from '../riscv/asm';
import { CACHE_CPU_PROGRAMS } from '../riscv/cprograms';
import { cpuState } from '../riscv/cosim';
import { findNode } from '../sim/flatten';
import type { Stage } from '../view/stage';
import { cacheExplorer, dramWidget, hierarchyWidget } from '../widgets/cache';
import { cpuScene } from '../widgets/cpupanel';
import type { Chapter } from './types';

/** Value of a named net inside an instance (switch-level scenes). */
function netAt(st: Stage, path: string[], net: string): number {
  const sim = st.sim;
  if (!sim) return -1;
  const n = findNode(sim.design.root, path);
  if (!n?.nets) return -1;
  const i = n.def.netlist!().nets.findIndex((x) => x.name === net);
  return i < 0 ? -1 : sim.get(n.nets[i][0]);
}

const csrc = (id: string) => CACHE_CPU_PROGRAMS.find((p) => p.id === id)!.source;

export const chCache: Chapter = {
  id: 'cache', num: 21, title: 'Caches & the memory hierarchy', level: 'Memory',
  blurb: 'SRAM and DRAM at transistor level, direct-mapped and set-associative caches, the three Cs, and a CPU that stalls on a miss.',
  goals: [
    'read and write a 6T SRAM cell, and say why transistor sizing replaces the clock and the enable gate',
    'split an address into tag, index and offsets, and classify a miss as compulsory, capacity or conflict',
    'trace a miss through direct-mapped and 2-way, write-through and write-back caches, counting the stall cycles',
    'compute the average memory access time of a two-level hierarchy',
  ],
  builds: ['memory', 'cpu', 'pipeline'],
  recap: {
    keep: [
      'A 6T SRAM cell is two cross-coupled inverters and two access transistors: 6 transistors a bit, against 60 for a flip-flop with enable. Sizing (pull-down &gt; access &gt; pull-up) keeps a read from flipping the cell and lets a write flip it. DRAM is one transistor and one capacitor, paid for with refresh and slow, destructive reads.',
      'SEC-DED: Hamming check bits at positions 1, 2, 4, … spell the position of one flipped bit, and one more parity bit tells one error from two. 8 data bits need 5 extra, 64 need 8: the 72-bit ECC word.',
      'Address = tag | index | word offset | byte offset. A hit is valid AND stored tag = address tag. Here a miss stalls 8 cycles (4 of latency, then 4 to copy the line); a dirty victim adds 4 to write it back first.',
      'Misses are compulsory, capacity or conflict. Ways remove conflict misses at the price of comparators, a wider hit multiplexer and replacement state: "Two arrays, one set" drops from 33 misses to 9 with two ways.',
      'AMAT = hit time + miss rate × miss penalty, level by level: 4 + 0.05 × (12 + 0.2 × 250) = 7.1 cycles.',
    ],
    practise: ['o_cache'],
    check: [
      {
        question: 'The gate-level direct-mapped cache has 4 lines of 4 words. Which address bits pick the line?',
        options: ['Bits 5:4', 'Bits 3:2', 'Bits 1:0', 'Bits 7:6'],
        answer: 0,
        explain: 'Byte offset 1:0, word offset 3:2, index 5:4, tag above. 0x24 and 0x2C differ only in bits 3:2, so they share a line.',
        why: ['', 'Bits 3:2 pick the word inside the line: the word offset.', 'Bits 1:0 are the byte offset within a word.', 'Those are the tag, compared with the stored tag once the index has picked the line.'],
      },
      {
        question: 'A loop sweeps a 512-byte array again and again through a 256-byte fully associative cache with LRU replacement. After the first pass, what kind are its misses?',
        options: ['Capacity', 'Conflict', 'Compulsory'],
        answer: 0,
        explain: 'The working set is twice the cache. Under LRU a sequential sweep evicts every line before it comes round again, so every new line misses on every pass.',
        why: ['', 'A conflict miss needs one set to overflow while others have room. A fully associative cache is a single set.', 'Compulsory misses are the first touch of each line, and those all happen in the first pass.'],
      },
      {
        question: 'In the write-back cache a load misses and its victim line is dirty. How long does the CPU stall?',
        options: ['12 cycles: 4 to write the victim back, 4 of latency, 4 to fill', '8 cycles, as for any miss', '4 cycles: the write-back only', '16 cycles: the write-back waits out the latency too'],
        answer: 0,
        explain: 'The miss controller counts 0–3 to write the victim back, 4–7 to wait, 8–11 to fill. A clean victim jumps from 0 to 5: 8 cycles.',
        why: ['', 'Eight is a clean victim: the controller skips the write-back states.', 'The missing line still has to be fetched after the victim is written.', 'The victim\'s four words go out in states 0–3 with no wait of their own; only the fill waits for the memory.'],
      },
    ],
  },
  steps: [
    {
      title: 'Six transistors per bit',
      body: `
        <p>Our register file stores each bit in an enable flip-flop: 15 NANDs, <strong>60 transistors</strong>. A cache needs
        hundreds of thousands of bits, so real memories use the <span data-show="c0 c1"><strong>6T SRAM cell</strong></span>: two cross-coupled inverters (a loop
        that remembers, like the SR latch) and two access transistors controlled by the <em>word line</em>. Every cell in a column
        shares two <em>bit lines</em>, <span data-show="pin:bl pin:blb">bl and bl̄</span>.</p>
        <p>The cell has no clock, no enable gate and no multiplexer. It works because of <strong>transistor sizing</strong>, which the
        switch-level simulator now models: pull-down (strong) &gt; access (normal) &gt; pull-up (weak).</p>
        <ul>
          <li><strong>Read</strong>: <span data-show="pre0 pre1">precharge</span> both bit lines high, release them (they keep their charge), raise one word line.
          The side storing 0 discharges its bit line.</li>
          <li><strong>Write</strong>: <span data-show="d0 d1">a strong driver</span> pulls one bit line low. The access transistor overpowers the weak pull-up and the loop flips.</li>
        </ul>
        <div class="try">The cells power up unknown (X). Use the buttons, then open a cell to watch q and q̄.</div>`,
      scene: () => ({ root: SRAM_COLUMN, inputs: { pre_n: 1, w0: 0, w1: 0, wl0: 0, wl1: 0 } }),
      actions: [
        { label: 'Write 1 → cell 0', run: (st) => { st.setInputs({ pre_n: 1, wl1: 0, w0: 0, w1: 1, wl0: 1 }); st.setInputs({ wl0: 0, w1: 0 }); } },
        { label: 'Write 0 → cell 1', run: (st) => { st.setInputs({ pre_n: 1, wl0: 0, w1: 0, w0: 1, wl1: 1 }); st.setInputs({ wl1: 0, w0: 0 }); } },
        { label: 'Precharge', run: (st) => { st.setInputs({ wl0: 0, wl1: 0, w0: 0, w1: 0, pre_n: 0 }); st.setInputs({ pre_n: 1 }); } },
        { label: 'Read cell 0', run: (st) => { st.setInputs({ wl1: 0, w0: 0, w1: 0, pre_n: 0 }); st.setInputs({ pre_n: 1, wl0: 1 }); } },
        { label: 'Read cell 1', run: (st) => { st.setInputs({ wl0: 0, w0: 0, w1: 0, pre_n: 0 }); st.setInputs({ pre_n: 1, wl1: 1 }); } },
      ],
      challenge: {
        kind: 'reach', goal: 'Store 1 in cell 0 and 0 in cell 1, then read cell 0 so that bl̄ = 0.',
        check: (st) => netAt(st, ['c0'], 'q') === 1 && netAt(st, ['c1'], 'q') === 0 && st.getInput('wl0') === 1 && st.getInput('wl1') === 0 && st.value('blb') === 0 && st.value('bl') === 1,
        hints: [
          'Three actions in order: two writes, then a read. Each button plays its whole input sequence for you.',
          'A read starts from precharged bit lines; the button does that first. Cell 0 holding 1 means q̄ = 0: which bit line does it pull down?',
        ],
        answer: 'Write 1 → cell 0 (w1 pulls bl̄ low while wl0 is high), Write 0 → cell 1, then Read cell 0: precharge, release, raise wl0. The cell holds q̄ = 0, so it discharges bl̄.',
        solve: (st) => {
          st.setInputs({ pre_n: 1, wl1: 0, w0: 0, w1: 1, wl0: 1 }); st.setInputs({ wl0: 0, w1: 0 });
          st.setInputs({ w0: 1, wl1: 1 }); st.setInputs({ wl1: 0, w0: 0 });
          st.setInputs({ pre_n: 0 }); st.setInputs({ pre_n: 1, wl0: 1 });
        },
      },
    },
    {
      title: 'From a column to an array',
      body: `
        <p>A real SRAM is a grid. Each row of cells shares a <strong>word line</strong>, raised by <span data-show="dec">a row decoder</span> (the gate-level decoder
        of <a href="#/c/routing/0">chapter 7</a>, here running as its transistors); <span data-show="col0 col1 col2 col3">each column</span> shares a bit-line pair with its own precharge,
        <span data-show="col0.wd"><strong>write driver</strong></span>
        and <span data-show="col0.sa"><strong>sense amplifier</strong></span>. One access reads or writes a whole row, one bit per column.</p>
        <p>The sense amplifier is a latch: while <code>sae</code> (sense amplifier enable) = 0 it follows the bit lines (unpowered, so it never drives them); when
        <code>sae</code> rises it isolates itself and latches the value, which it holds while the bit lines are precharged for the next access.
        In silicon it also <em>amplifies</em>: it fires when the bit lines differ by ~100 mV, long before a small cell could swing a long
        bit line fully. Here the swing is full; <a href="#/c/dram/0">chapter 32</a> opens a DRAM, where it is not.</p>
        <p>Cost of this 4×4: 320 transistors, of which the cells are 96. The periphery is shared per row and per column, so it amortizes:
        at 8×8 the cells are 43 %, and in a real 32 KB array over 90 %. Sixteen bits of flip-flop registers would cost 960.</p>
        <div class="try">Use the buttons: Precharge, set <code>din</code> and <code>addr</code>, Write; then Precharge and Read.</div>`,
      scene: () => ({ root: sramArray(4, 4), inputs: { addr: 0, wl: 0, pre_n: 1, we: 0, din: 0, sae: 0 } }),
      actions: [
        { label: 'Precharge', run: (st) => { st.setInputs({ wl: 0, we: 0, sae: 0, pre_n: 0 }); st.setInputs({ pre_n: 1 }); } },
        { label: 'Write din → addr', run: (st) => { st.setInputs({ sae: 0, we: 1 }); st.setInputs({ wl: 1 }); st.setInputs({ wl: 0, we: 0 }); } },
        { label: 'Read addr', run: (st) => { st.setInputs({ we: 0, sae: 0 }); st.setInputs({ wl: 1 }); st.setInputs({ sae: 1 }); st.setInputs({ wl: 0 }); } },
      ],
      challenge: {
        kind: 'reach', goal: 'Store 0xA in word 2, then read word 2 back so that dout = 0xA.',
        check: (st) => st.value('dout') === 0xa && st.getInput('addr') === 2 && st.getInput('sae') === 1 && st.getInput('we') === 0,
        hints: [
          'Set addr and din first: the buttons use whatever they hold.',
          'A write leaves the bit lines driven to the written value. Precharge before the read, or the sense amplifiers latch what the write left behind.',
        ],
        answer: 'addr = 2, din = 0xA. Precharge, Write (we = 1, raise and drop the word line), Precharge again, Read (raise the word line, then sae). Without the precharge before the read, the bit lines still hold what the write left on them.',
        solve: (st) => {
          st.setInputs({ addr: 2, din: 0xa, wl: 0, we: 0, sae: 0, pre_n: 0 }); st.setInputs({ pre_n: 1 });
          st.setInputs({ we: 1 }); st.setInputs({ wl: 1 }); st.setInputs({ wl: 0, we: 0 });
          st.setInputs({ pre_n: 0 }); st.setInputs({ pre_n: 1 });
          st.setInputs({ wl: 1 }); st.setInputs({ sae: 1 }); st.setInputs({ wl: 0 });
        },
      },
    },
    {
      title: 'One transistor per bit: DRAM',
      body: `
        <p>Main memory goes further: <strong><span data-show="a">one transistor</span> and one capacitor</strong>. With
        <span data-show="pin:wl">the word line</span> high, <span data-show="pin:bl">the bit line</span>
        charges or discharges the capacitor. With it low, <span data-show="pin:q">the storage node</span> is isolated and keeps its charge. The simulator shows
        the stored value, not Z, because the net is capacitive.</p>
        <div class="try">Set bl = 1 with wl = 1, drop wl, then change bl: q does not follow until wl rises again.</div>`,
      scene: () => ({ root: DRAM_CELL, inputs: { wl: 1, bl: 1 } }),
      tries: [(st) => st.getInput('wl') === 0 && st.getInput('bl') === 0 && st.value('q') === 1],
      challenge: {
        kind: 'quiz', question: 'Why is DRAM so much denser than SRAM, and what does that cost?',
        options: [
          'Fewer transistors per bit; but the charge leaks (refresh), reads are destructive and slow, and it needs its own process',
          'It uses smaller transistors; there is no cost',
          'It stores two bits per cell',
          'It has no word lines',
        ],
        answer: 0,
        why: ['', 'Both are built from transistors of comparable size. The saving is in how many, and it is paid for in refresh and slow, destructive reads.', 'One capacitor holds one charge level: one bit.', 'Every DRAM row has a word line: it is what connects the cells\' capacitors to their bit lines.'],
        explain: '1T1C versus 6T, and the capacitor can be built vertically (trench or stacked). The price: refresh every ~64 ms, a sense amplifier per bit line, a destructive read followed by a restore, and a fabrication process incompatible with fast logic. That is why DRAM sits off-chip, tens of nanoseconds away.',
      },
    },
    {
      title: 'Leaks, refresh and sense amplifiers',
      body: '<p>The stored charge leaks through the off transistor and the junction, so every row must be read and rewritten periodically. A read only produces a small voltage on the bit line. <a href="#/c/dram/0">Chapter 32</a> builds the array, the precharge to VDD/2 and the sense amplifier at transistor level, with the charge sharing measured in millivolts.</p>',
      widget: dramWidget,
    },
    {
      title: 'Errors and ECC',
      body: `
        <p>A cell can also flip: a weak DRAM cell leaks early, or a particle strike dumps charge into a node. One <strong>parity</strong> bit
        (an XOR tree) detects any single flip but cannot locate it. A <strong>Hamming code</strong> adds r check bits at positions 1, 2, 4, …:
        check bit 2ʲ covers every position with bit j set. On read, the recomputed checks (the <em>syndrome</em>) spell the position of a
        single flipped bit, which the decoder flips back. One more bit of overall parity tells one error from two: <strong>SEC-DED</strong>,
        single error correct, double error detect.</p>
        <p>8 data bits need 5 extra bits (13 in all). For 64 bits it is 8 extra bits, the 72-bit words of ECC DIMMs and of most server
        caches. <span data-show="enc">Encoding</span> costs 76 NANDs here and <span data-show="dec">decoding</span> 280, which sits in the read path of every access.</p>
        <div class="try">Flip one bit (any bit of <span data-show="upset"><code>flip</code></span>): dout stays 0x5A and <code>single</code> rises. Flip two: <code>double</code> rises and the data
        can no longer be trusted.</div>`,
      scene: () => ({ root: eccChannel(8), inputs: { d: 0x5a, flip: 0 } }),
      tries: [(st) => st.value('single') === 1 && st.value('dout') === 0x5a],
      challenge: {
        kind: 'reach', goal: 'Make the decoder report an uncorrectable error (double = 1).',
        check: (st) => st.value('double') === 1,
        hints: [
          'One flip is corrected and raises single. What does the overall parity bit see when two bits flip?',
          'flip is a mask over the 13 stored bits: each 1 in it inverts one stored bit.',
        ],
        answer: 'Flip any two bits, for example flip = 0b10010. Their positions XOR to a non-zero syndrome while the overall parity is even again. With three flips the code mistakes it for a single error and "corrects" the wrong bit: SEC-DED only promises two.',
        solve: (st) => st.setInputs({ flip: 0b10010 }),
      },
    },
    {
      title: 'The memory hierarchy',
      body: `
        <p>Fast memory is small and expensive, big memory is slow. A hierarchy of caches gives the illusion of both, because programs are
        <em>local</em>: they reuse recent data (temporal locality) and use nearby addresses together (spatial locality).</p>`,
      widget: hierarchyWidget,
    },
    {
      title: 'A direct-mapped cache',
      body: `
        <p>Here is a real cache, at gate level, in front of a 64-word main memory: <strong>4 lines of 4 words</strong> (64 bytes).
        The address splits into <strong>byte offset</strong> (2 bits), <strong>word offset</strong> (2) that picks the word in the line,
        <strong>index</strong> (2) that picks the line, and <strong>tag</strong> (the rest). <span data-show="tags">The tag array</span> stores the tag and a valid
        bit for each line. A hit means valid AND stored tag = address tag: <span data-show="eq">one comparator</span>.</p>
        <p>A load that misses raises <code>stall</code> for 8 cycles. <span data-show="cnt">A 3-bit counter</span> waits out the latency of
        <span data-show="ram">main memory</span> (4 cycles), then copies
        the line into <span data-show="data">the data array</span> one word per cycle and writes the tag on the last one. Stores are <em>write-through</em> (memory is always current)
        with <em>no write-allocate</em> (a store miss does not fetch the line).</p>
        <div class="try">Address 0x24 is a load (read enable <code>re</code> = 1) and misses. Pulse the clock 8 times and watch the counter, the line fill and hit rise.</div>`,
      scene: () => ({ root: cachedMemory(6), inputs: { addr: 0x24, re: 1, we: 0, wd: 0, clk: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Get a hit for the load at 0x24, then a hit at 0x2C without any further clock pulse.',
        check: (st) => st.value('hit') === 1 && st.getInput('addr') === 0x2c && st.getInput('re') === 1,
        hints: [
          'First the miss: the cache holds stall high for a fixed number of cycles while the line comes in. Pulse until hit = 1.',
          'A line is 16 bytes. Which bytes came in with 0x24, and does 0x2C have the same index and tag?',
        ],
        answer: '8 pulses fetch the line 0x20–0x2F (spatial locality: four words for the price of one miss). Then set addr = 0x2C: same index, same tag, so it hits immediately.',
        solve: (st) => { st.runCycles(8); st.setInputs({ addr: 0x2c }); },
      },
    },
    {
      title: 'Exploring caches on real traces',
      body: `
        <p>These traces come from running each program on the instruction-set simulator (the reference model that runs a program one
        instruction at a time). Start with the matrix sums: identical work, very different
        miss rates. Row by row, each line fetched serves four consecutive words. Column by column, each access is 64 bytes past the previous one.
        With a 256-byte cache, the line is evicted before its neighbours are used.</p>
        <div class="try">Compare the two matrix sums. Then load "Vector add" at 512 bytes: direct-mapped, 2-way (three arrays per set, still thrashing), 4-way.</div>`,
      widget: () => cacheExplorer({ trace: 'colmajor' }),
      challenge: {
        kind: 'quiz', question: 'Column-major sum, 256-byte direct-mapped cache, 16-byte lines: 100 % misses. Which single change brings it down to 25 %?',
        options: ['Doubling the line size', 'Making it 4-way set-associative', 'A 1 KB cache (the whole matrix fits)', 'FIFO replacement'],
        answer: 2,
        why: ['Longer lines hold more of each row, but a 256-byte cache then has only 8 of them and one column touches 16: every line is evicted before the next column comes back for it. Still 100 %.', 'With 4 ways there are only 4 sets, and all 16 rows of a column land in the same one: 16 lines compete for 4 places.', '', 'Replacement policy only matters with more than one way. A direct-mapped cache has exactly one line it can evict.'],
        explain: 'The explorer classifies them as conflict misses. Lines are 16 bytes and the stride is 64, so row i lands in set (4i + j/4) mod 16, and rows i and i + 4 share a set. 4-way does not help: with only 4 sets, all 16 rows of a column land in the same set. A 1 KB cache has 64 sets, so every row gets its own, and only the 64 compulsory misses remain. A fully associative 256-byte cache also reaches 25 %, because the 16 lines of one column fit exactly. Or swap the loops: the compiler optimization called loop interchange.',
      },
    },
    {
      title: 'The three Cs and associativity',
      body: `
        <p>Every miss is <strong>compulsory</strong> (the first touch of a line), <strong>capacity</strong> (the working set is bigger than the cache),
        or <strong>conflict</strong> (two lines map to the same set even though there is room elsewhere). Conflict misses are the price of a
        direct-mapped cache's simplicity. An <em>n-way set-associative</em> cache gives every set n places, and checks all n tags at once.
        This is a 2-way tag compare: <span data-show="e0 e1">two comparators</span> and <span data-show="mx">a multiplexer</span>. A fully associative cache compares every line, which is a CAM.</p>
        <p>More ways cost more comparators, a wider multiplexer on the hit path, and replacement state. True LRU for 2 ways is one bit per set;
        for 8 ways most designs use a cheaper approximation (tree pseudo-LRU).</p>`,
      scene: () => ({ root: wayLookup2(3, 8), inputs: { tag: 5, v0: 1, tag0: 2, d0: 0x11, v1: 1, tag1: 5, d1: 0x22 } }),
    },
    {
      title: 'A CPU that waits for memory',
      body: `
        <p>The single-cycle CPU with <span data-show="dm">this cache as its data memory</span>: <span data-show="isLoad">a load</span>, decoded from ResultSrc
        (the control field that selects the value written back), raises <code>re</code>, and a miss holds <span data-show="pc">the PC</span> and the
        <span data-show="rwg">register write</span> (<code>retire</code> = 0) until the line arrives. The instruction-set simulator steps only when an instruction retires, so it still checks every one.
        The cache costs about 10 000 NANDs of tag and data arrays, and the clock period does not change (103).</p>
        <p>An honest caveat: the "slow" main memory here is flip-flops too; its latency is modelled by the 4 wait cycles.</p>
        <div class="try">Run "Sum an array twice": 4 misses in the first pass, none in the second. Then try "Two arrays, one set".</div>`,
      scene: () => cpuScene({ source: csrc('reuse'), dcache: true, adder: 'ks', highlight: ['dm'] }),
      challenge: {
        kind: 'reach', goal: 'Run the program to the end (the result 960 is stored at 0x80).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).dmem[32] === 960 : false; } catch { return false; } },
        hints: [
          'The run is a couple of hundred cycles: pulsing by hand is slow.',
          'The CPU panel has a button that runs the program until it halts. Watch the misses in the first pass.',
        ],
        answer: '"Run to halt": 188 instructions in 220 cycles. 32 loads, 4 misses × 8 cycles. Hit rate 87.5 %, CPI 1.17.',
        solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
      },
    },
    {
      title: 'Write-back: dirty lines',
      body: `
        <p>Write-through sends every store to main memory. A <span data-show="dm"><strong>write-back</strong> cache</span> keeps the store in the line and marks it
        <strong>dirty</strong>; memory sees the line only when it is evicted. Stores now allocate on a miss as well (write-allocate), and a
        miss whose victim is dirty must write it back first: 12 cycles instead of 8. <span data-show="dm.fsm">The miss controller</span> is a 4-bit counter: 0–3 write the
        victim back, 4–7 wait, 8–11 fill, and a clean victim jumps from 0 to 5.</p>
        <p>The panel's memory view now shows the memory <em>as the program sees it</em>: main memory overlaid with the dirty lines, which are
        the only up-to-date copy. That is the coherence problem of <a href="#/c/multicore/0">chapter 24</a> in its simplest form.</p>
        <div class="try">Run "Update an array in place": 48 stores, all of them hits after the first pass's 4 misses. Open <span data-show="dm.ram"><code>dm</code> → <code>ram</code></span>: main memory is still all zero.</div>`,
      scene: () => cpuScene({ source: csrc('inplace'), dcache: 'wb', adder: 'ks', highlight: ['dm'] }),
      challenge: {
        kind: 'quiz', question: 'In "Update an array in place" (48 stores to 16 words), how many words reach main memory with each cache?',
        options: ['Write-through 48, write-back 0 (until the lines are evicted)', 'Both 48', 'Write-through 16, write-back 48', 'Both 0'],
        answer: 0,
        why: ['', 'The write-back cache keeps the stores in its dirty lines. Memory sees them only when a line is evicted.', 'That swaps the two policies: write-through is the one that writes memory on every store.', 'Write-through writes every store to memory at once: that is what the name means.'],
        explain: 'Measured in the tests: the write-through cache writes main memory on every store, 48 words; the write-back cache none during the run, because the four lines stay resident and dirty. Each line would cost 4 words when evicted, 16 in all, and only once.',
      },
    },
    {
      title: 'Two ways and an LRU bit',
      body: `
        <p>"Two arrays, one set" is the worst case for direct mapping: a[i] and b[i] share an index, so each access evicts the other, and every
        load misses. A <span data-show="dm"><strong>2-way set-associative</strong> cache</span> of the same size has half as many sets, but each holds two lines: both
        arrays fit. Both ways are compared at once (the 2-way tag compare of a few steps back), and
        <span data-show="dm.lru">one <strong>LRU</strong> bit per set</span>,
        flipped on every hit, names the way to evict next.</p>
        <p>Measured: 33 misses direct-mapped (32 loads and the final store), 9 with two ways; the run takes less than half the cycles.</p>
        <div class="try">Run "Two arrays, one set" here, then compare with the direct-mapped CPU two steps back.</div>`,
      scene: () => cpuScene({ source: csrc('pingpong'), dcache: 'wb2', adder: 'ks', highlight: ['dm'] }),
      challenge: {
        kind: 'reach', goal: 'Run the program to the end.',
        check: (st) => { try { return st.sim ? cpuState(st.sim).pc === assemble(csrc('pingpong')).labels.get('halt') : false; } catch { return false; } },
        hints: [
          'The program ends in a loop on itself at the label halt. The CPU panel can take it there for you.',
          'Use the panel\'s button that runs until the program halts, and count the misses: a and b now sit in different ways of one set.',
        ],
        answer: '"Run to halt". 9 misses: one per line of a and of b (4 + 4), and one for the final store, which allocates its line.',
        solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
      },
    },
    {
      title: 'Caching instructions too',
      body: `
        <p>Fetch needs a cache as much as loads do, and an <strong>instruction cache</strong> is simpler: nothing is ever written, so no dirty
        bits and no write-back. Here <span data-show="imem">8 lines of 4 instructions</span> sit in front of
        <span data-show="imem.rom">the instruction ROM</span>, which now plays the slow memory. Every fetch
        is an access; a miss stalls 8 cycles. While it does, the instruction on the bus is not valid, so its store or load is held back too.</p>
        <p>A loop that fits misses once per line and then always hits: the run takes exactly one cycle per instruction plus 8 per line.
        Real cores split the two caches (a Harvard L1) so that a fetch and a load never compete.</p>`,
      scene: () => cpuScene({ source: csrc('inplace'), icache: true, adder: 'ks', highlight: ['imem'] }),
      challenge: {
        kind: 'quiz', question: 'The program is 11 instructions. How many cycles does the instruction cache add to the whole run?',
        options: ['24: three lines, 8 cycles each', '88: every instruction misses once', '0: a loop always hits', '8: one miss'],
        answer: 0,
        why: ['', 'A miss brings in a whole line of 4 instructions, so the other three of that line hit.', 'Every line must come in once: its first fetch is a compulsory miss, loop or not.', 'The 11 instructions span three lines, and each is fetched on its own first use.'],
        explain: '11 instructions occupy three 4-word lines, each fetched once (8 cycles); every later fetch hits. The tests check exactly this: cycles = instructions + 8 × lines.',
      },
    },
    {
      title: 'A cache in the pipeline',
      body: `
        <p>In the pipelined CPU <span data-show="dm">the cache</span> sits in the M stage. A miss there must stop <em>everything</em>: the PC, all four pipeline
        registers, the flushes <span data-show="hz">the hazard unit</span> may be asking for, and the branch predictor's counters (which are not idempotent). One
        signal, the cache's <code>stall</code>, <span data-show="gPC gFD gFl1 gFl2 gV">gates every enable</span> for the 8 or 12 cycles of the miss, and W reports a retirement only when
        the freeze is over, so the instruction-set simulator still steps once per instruction.</p>
        <p>Freezing everything is a deliberate simplification: it is easy to get right and to check. Real pipelines keep going past a miss (a non-blocking
        cache: later instructions that hit, or do not touch memory, carry on while miss-status registers track the outstanding misses), at the cost of
        a scoreboard to stop an instruction that needs the missing data.</p>
        <p>A bug worth knowing: our first version let flushed bubbles reach the cache. A bubble's fields are not all zero, and one of them looked
        like a load, so it caused real misses that cost time but not correctness. The co-simulation passed; the miss count did not match the
        single-cycle CPU's. The fix is <span data-show="ldV">one AND gate</span>: only a <em>valid</em> instruction in M may access the cache.</p>
        <p>Measured with the 2-way write-back cache, "Two arrays, one set" runs 101 instructions in 207 cycles, 72 of them frozen (9 misses);
        with the direct-mapped write-through cache, 391 cycles, 256 frozen.</p>
        <div class="try">Run it and watch the pipeline diagram: during a miss every row repeats.</div>`,
      scene: () => cpuScene({ source: csrc('pingpong'), pipeline: true, dcache: 'wb2', adder: 'ks', highlight: ['dm'] }),
      challenge: {
        kind: 'quiz', question: 'Why must a miss in M freeze the F, D and E stages too, instead of letting them run on?',
        options: [
          'The instruction in E would move into M while M is still busy, and the hazard and forwarding logic assume one instruction per stage',
          'The instruction cache would miss as well',
          'The register file cannot be read during a miss',
          'It would not have to: only M needs to wait',
        ],
        answer: 0,
        why: ['', 'A data miss does nothing to fetch. The problem is that E has nowhere to send its instruction while M is occupied.', 'The register file is free. The stages cannot advance because M will not take the next instruction.', 'Then E would move into M and overwrite the stalled access. In order, the pipeline moves as one.'],
        explain: 'An in-order pipeline moves as a whole: if M holds, E must hold or overwrite it, and so on back to the PC. Out-of-order cores avoid this: other instructions continue around a missing load (non-blocking caches, a load queue).',
      },
    },
    {
      title: 'Average memory access time',
      body: `
        <p>AMAT = hit time + miss rate × miss penalty. A modern core: an L1 hit in 4 cycles, 5 % misses, and an L2 behind it that hits in 12
        cycles but itself misses 20 % of the time to DRAM at 250. Write-back caches (only dirty lines go to memory) dominate for exactly this
        reason: memory bandwidth is the scarce resource.</p>`,
      challenge: {
        kind: 'quiz', question: 'L1: 4-cycle hit, 5 % miss rate. L2: 12-cycle hit, 20 % local miss rate. DRAM: 250 cycles. What is the AMAT?',
        options: ['4.6 cycles', '7.1 cycles', '16.5 cycles', '266 cycles'], answer: 1,
        why: ['That charges an L1 miss only the L2 hit time, and forgets the 20 % of L2 accesses that go on to DRAM.', '', 'That sends every L1 miss straight to DRAM, as if there were no L2.', 'That adds the three latencies, as if every access went all the way to DRAM.'],
        explain: 'L2 AMAT = 12 + 0.2 × 250 = 62. L1 AMAT = 4 + 0.05 × 62 = 7.1 cycles. The DRAM latency of 250 cycles is diluted by two levels of hits to under twice the L1 hit time.',
      },
    },
  ],
};
