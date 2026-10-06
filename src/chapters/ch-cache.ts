import { DRAM_CELL, SRAM_COLUMN, cachedMemory, eccChannel, sramArray, wayLookup2 } from '../lib';
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
  steps: [
    {
      title: 'Six transistors per bit',
      body: `
        <p>Our register file stores each bit in an enable flip-flop: 15 NANDs, <strong>60 transistors</strong>. A cache needs
        hundreds of thousands of bits, so real memories use the <strong>6T SRAM cell</strong>: two cross-coupled inverters (a loop
        that remembers, like the SR latch) and two access transistors controlled by the <em>word line</em>. Every cell in a column
        shares two <em>bit lines</em>, bl and bl̄.</p>
        <p>The cell has no clock, no enable gate and no multiplexer. It works because of <strong>transistor sizing</strong>, which the
        switch-level simulator now models: pull-down (strong) &gt; access (normal) &gt; pull-up (weak).</p>
        <ul>
          <li><strong>Read</strong>: precharge both bit lines high, release them (they keep their charge), raise one word line.
          The side storing 0 discharges its bit line.</li>
          <li><strong>Write</strong>: a strong driver pulls one bit line low. The access transistor overpowers the weak pull-up and the loop flips.</li>
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
        <p>A real SRAM is a grid. Each row of cells shares a <strong>word line</strong>, raised by a row decoder (the gate-level decoder
        of chapter 7, here running as its transistors); each column shares a bit-line pair with its own precharge, <strong>write driver</strong>
        and <strong>sense amplifier</strong>. One access reads or writes a whole row, one bit per column.</p>
        <p>The sense amplifier is a latch: while <code>sae</code> = 0 it follows the bit lines (unpowered, so it never drives them); when
        <code>sae</code> rises it isolates itself and latches the value, which it holds while the bit lines are precharged for the next access.
        In silicon it also <em>amplifies</em>: it fires when the bit lines differ by ~100 mV, long before a small cell could swing a long
        bit line fully. Our simulator has no analog voltages, so here the swing is full.</p>
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
        <p>Main memory goes further: <strong>one transistor and one capacitor</strong>. With the word line high, the bit line
        charges or discharges the capacitor. With it low, the storage node is isolated and keeps its charge. The simulator shows
        the stored value, not Z, because the net is capacitive.</p>
        <div class="try">Set bl = 1 with wl = 1, drop wl, then change bl: q does not follow until wl rises again.</div>`,
      scene: () => ({ root: DRAM_CELL, inputs: { wl: 1, bl: 1 } }),
      challenge: {
        kind: 'quiz', question: 'Why is DRAM so much denser than SRAM, and what does that cost?',
        options: [
          'Fewer transistors per bit; but the charge leaks (refresh), reads are destructive and slow, and it needs its own process',
          'It uses smaller transistors; there is no cost',
          'It stores two bits per cell',
          'It has no word lines',
        ],
        answer: 0,
        explain: '1T1C versus 6T, and the capacitor can be built vertically (trench or stacked). The price: refresh every ~64 ms, a sense amplifier per bit line, a destructive read followed by a restore, and a fabrication process incompatible with fast logic. That is why DRAM sits off-chip, tens of nanoseconds away.',
      },
    },
    {
      title: 'Leaks, refresh and sense amplifiers',
      body: '<p>The stored charge leaks through the off transistor and the junction, so every row must be read and rewritten periodically. A read only produces a small voltage on the bit line.</p>',
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
        caches. Encoding costs 76 NANDs here and decoding 280, which sits in the read path of every access.</p>
        <div class="try">Flip one bit (any bit of <code>flip</code>): dout stays 0x5A and <code>single</code> rises. Flip two: <code>double</code> rises and the data
        can no longer be trusted.</div>`,
      scene: () => ({ root: eccChannel(8), inputs: { d: 0x5a, flip: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the decoder report an uncorrectable error (double = 1).',
        check: (st) => st.value('double') === 1,
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
        <strong>index</strong> (2) that picks the line, and <strong>tag</strong> (the rest). The tag array stores the tag and a valid
        bit for each line. A hit means valid AND stored tag = address tag: one comparator.</p>
        <p>A load that misses raises <code>stall</code> for 8 cycles. A 3-bit counter waits out the memory latency (4 cycles), then copies
        the line one word per cycle and writes the tag on the last one. Stores are <em>write-through</em> (memory is always current)
        with <em>no write-allocate</em> (a store miss does not fetch the line).</p>
        <div class="try">Address 0x24 is a load (re = 1) and misses. Pulse the clock 8 times and watch the counter, the line fill and hit rise.</div>`,
      scene: () => ({ root: cachedMemory(6), inputs: { addr: 0x24, re: 1, we: 0, wd: 0, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Get a hit for the load at 0x24, then a hit at 0x2C without any further clock pulse.',
        check: (st) => st.value('hit') === 1 && st.getInput('addr') === 0x2c && st.getInput('re') === 1,
        answer: '8 pulses fetch the line 0x20–0x2F (spatial locality: four words for the price of one miss). Then set addr = 0x2C: same index, same tag, so it hits immediately.',
        solve: (st) => { st.runCycles(8); st.setInputs({ addr: 0x2c }); },
      },
    },
    {
      title: 'Exploring caches on real traces',
      body: `
        <p>These traces come from running each program on the golden model. Start with the matrix sums: identical work, very different
        miss rates. Row by row, each line fetched serves four consecutive words. Column by column, each access is 64 bytes past the previous one.
        With a 256-byte cache, the line is evicted before its neighbours are used.</p>
        <div class="try">Compare the two matrix sums. Then load "Vector add" at 512 bytes: direct-mapped, 2-way (three arrays per set, still thrashing), 4-way.</div>`,
      widget: () => cacheExplorer({ trace: 'colmajor' }),
      challenge: {
        kind: 'quiz', question: 'Column-major sum, 256-byte direct-mapped cache, 16-byte lines: 100 % misses. Which single change brings it down to 25 %?',
        options: ['Doubling the line size', 'Making it 4-way set-associative', 'A 1 KB cache (the whole matrix fits)', 'FIFO replacement'],
        answer: 2,
        explain: 'The explorer classifies them as conflict misses. Lines are 16 bytes and the stride is 64, so row i lands in set (4i + j/4) mod 16, and rows i and i + 4 share a set. 4-way does not help: with only 4 sets, all 16 rows of a column land in the same set. A 1 KB cache has 64 sets, so every row gets its own, and only the 64 compulsory misses remain. A fully associative 256-byte cache also reaches 25 %, because the 16 lines of one column fit exactly. Or swap the loops: the compiler optimization called loop interchange.',
      },
    },
    {
      title: 'The three Cs and associativity',
      body: `
        <p>Every miss is <strong>compulsory</strong> (the first touch of a line), <strong>capacity</strong> (the working set is bigger than the cache),
        or <strong>conflict</strong> (two lines map to the same set even though there is room elsewhere). Conflict misses are the price of a
        direct-mapped cache's simplicity. An <em>n-way set-associative</em> cache gives every set n places, and checks all n tags at once.
        This is a 2-way tag compare: two comparators and a multiplexer. A fully associative cache compares every line, which is a CAM.</p>
        <p>More ways cost more comparators, a wider multiplexer on the hit path, and replacement state. True LRU for 2 ways is one bit per set;
        for 8 ways most designs use a cheaper approximation (tree pseudo-LRU).</p>`,
      scene: () => ({ root: wayLookup2(3, 8), inputs: { tag: 5, v0: 1, tag0: 2, d0: 0x11, v1: 1, tag1: 5, d1: 0x22 } }),
    },
    {
      title: 'A CPU that waits for memory',
      body: `
        <p>The single-cycle CPU with this cache as its data memory: a load decoded from ResultSrc raises <code>re</code>, and a miss holds the PC and the
        register write (<code>retire</code> = 0) until the line arrives. The golden model steps only when an instruction retires, so it still checks every one.
        The cache costs about 10 000 NANDs of tag and data arrays, and the clock period does not change (103).</p>
        <p>An honest caveat: the "slow" main memory here is flip-flops too; its latency is modelled by the 4 wait cycles.</p>
        <div class="try">Run "Sum an array twice": 4 misses in the first pass, none in the second. Then try "Two arrays, one set".</div>`,
      scene: () => cpuScene({ source: csrc('reuse'), dcache: true, adder: 'ks', highlight: ['dm'] }),
      challenge: {
        kind: 'reach', goal: 'Run the program to the end (the result 960 is stored at 0x80).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).dmem[32] === 960 : false; } catch { return false; } },
        answer: '"Run to halt": 188 instructions in 220 cycles. 32 loads, 4 misses × 8 cycles. Hit rate 87.5 %, CPI 1.17.',
        solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
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
        explain: 'L2 AMAT = 12 + 0.2 × 250 = 62. L1 AMAT = 4 + 0.05 × 62 = 7.1 cycles. The DRAM latency of 250 cycles is diluted by two levels of hits to under twice the L1 hit time.',
      },
    },
  ],
};
