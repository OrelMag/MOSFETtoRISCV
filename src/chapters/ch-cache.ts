import { sramArray } from '../lib/arrays';
import { cachedMemory, wayLookup2 } from '../lib/cache';
import { DRAM_CELL, SRAM_CELL, SRAM_COLUMN } from '../lib/cells';
import { eccChannel, hammingDec, hammingEnc } from '../lib/coding';
import { DFFE } from '../lib/sequential';
import { assemble } from '../riscv/asm';
import { CACHE_CPU_PROGRAMS, TRACE_PROGRAMS } from '../riscv/cprograms';
import { cpuState } from '../riscv/cosim';
import { ISS } from '../riscv/iss';
import { CELL_C, BITLINE_C } from '../lib/dram';
import { bigRam, kWords, ramLeafState } from '../lib/bigmem';
import { groupDigits } from '../sim/numfmt';
import type { ComponentDef } from '../sim/types';
import { MAT_REF, MAT_WORD, MB_BITS, matShape, matSizePanel } from '../widgets/matsize';
import { CacheModel, type CacheConfig } from '../sim/cachemodel';
import { TIMING } from '../dram/timing';
import { logicDepth, stats } from '../sim/stats';
import { findNode } from '../sim/flatten';
import type { Stage } from '../view/stage';
import { cacheExplorer, dramWidget, hierarchyWidget } from '../widgets/cache';
import { hierarchy3d } from '../widgets/hierarchy3d';
import { DEFAULT_HITS, amatCycles } from '../widgets/hierarchy3ddata';
import { withModel } from '../widgets/modelhost';
import { cpuScene } from '../widgets/cpupanel';
import type { Chapter } from './types';
import { numOf } from './order';

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

// Numbers the prose quotes, computed from the circuits and models rather than typed.
const ff = stats(DFFE).transistors;
const cell6 = stats(SRAM_CELL).transistors;
const cell1 = stats(DRAM_CELL).transistors;
const sramT = (n: number) => stats(sramArray(n, n)).transistors;
const pct = (x: number) => `${Math.round(x * 100)} %`;
/** Check bits of SEC-DED over k data bits: the smallest r with 2^r ≥ k + r + 1, plus the overall parity bit. */
const checkBits = (k: number) => { let r = 1; while (2 ** r < k + r + 1) r++; return r + 1; };
const eccCost = (k: number) => ({ enc: stats(hammingEnc(k)).nands, dec: stats(hammingDec(k)).nands });
/** Tag, index and offset widths of a cache (physical address bits pa). */
function split(size: number, line: number, ways: number, pa: number) {
  const off = Math.log2(line), idx = Math.log2(size / line / ways);
  return { off, idx, tag: pa - idx - off };
}
const traceCache = new Map<string, { addr: number; write: boolean }[]>();
function traceOf(id: string) {
  let t = traceCache.get(id);
  if (!t) {
    const iss = new ISS(assemble(TRACE_PROGRAMS.find((p) => p.id === id)!.source).words, { dmemWords: 1024 });
    iss.memTrace = [];
    for (let i = 0; i < 50000 && !iss.halted; i++) iss.step();
    traceCache.set(id, (t = iss.memTrace));
  }
  return t;
}
/** Miss percentage of a program's real memory trace through a cache. */
function missRate(trace: string, cfg: Partial<CacheConfig>): number {
  const m = new CacheModel({ size: 256, line: 16, ways: 1, replacement: 'lru', write: 'wb', ...cfg });
  for (const a of traceOf(trace)) m.access(a.addr, a.write);
  return (100 * m.stats.misses) / m.stats.accesses;
}
const fixed = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));

// "From an array to a megabyte": a 1M × 8 bigRam, its levels read off its own netlists, and the path to one address.
const MB_K = 20, MB_RAM = bigRam(MB_K, 8), MB_ADDR = 0xc0ffe;
const addrBits = (d: ComponentDef) => d.ports.find((p) => p.name === 'addr')!.width;
/** Each level above the gate-level banks: its words and how many banks it splits them into. */
const MB_LEVELS: { words: number; banks: number }[] = [];
let mbBottom: ComponentDef = MB_RAM;
for (;;) {
  const banks = mbBottom.netlist!().instances.filter((i) => /^bank\d+$/.test(i.name));
  if (!banks.length) break;
  MB_LEVELS.push({ words: 2 ** addrBits(mbBottom), banks: banks.length });
  mbBottom = banks[0].def;
}
const BANK_WORDS = 2 ** addrBits(mbBottom);
const MB_TOP_BITS = Math.log2(MB_LEVELS[0].banks);
const MB_SIDE = Math.round(Math.sqrt(MB_BITS));
const REF_MAT = matShape(Math.log2(MAT_REF), Math.log2(MAT_REF));
const MB_T = stats(MB_RAM).transistors;
/** The banks to open for MB_ADDR, the word at the bottom, and the address cut into the fields each level decodes. */
const MB_PATH = (() => {
  const banks: string[] = [], fields: string[] = [];
  let a = MB_ADDR, k = MB_K;
  for (const l of MB_LEVELS) {
    const b = Math.log2(l.banks), low = k - b;
    banks.push(`bank${a >> low}`);
    fields.push((a >> low).toString(2).padStart(b, '0'));
    a &= 2 ** low - 1; k = low;
  }
  fields.push(a.toString(2).padStart(k, '0'));
  return { banks, word: `w${a}`, fields: fields.join(' | ') };
})();
/** The byte at MB_ADDR, from the top bank's state in the scene's simulation (-1: unknown). */
function mbWord(st: Stage): number {
  const ctx = st.rootCtx;
  if (!ctx) return -1;
  const low = MB_K - MB_TOP_BITS;
  const s = ramLeafState(ctx.sim, ctx.node.children?.get(`bank${MB_ADDR >> low}`));
  const i = MB_ADDR & (2 ** low - 1);
  return !s || s.x[i] ? -1 : s.mem[i];
}
/** Average memory access time, outermost level last: each [hit time, local miss rate] over what lies below; mem is the last latency. */
function amat(levels: [number, number][], mem: number): number {
  return levels.reduceRight((below, [hit, miss]) => hit + miss * below, mem);
}

export const chCache: Chapter = {
  id: 'cache', num: numOf('cache'), title: 'Caches & the memory hierarchy', level: 'Memory',
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
      `A large memory is many mats, not one array: a word line's RC delay grows with the square of its length and a bit line's swing time with its cells. A megabyte in ${REF_MAT.mats} mats of ${MAT_REF} × ${MAT_REF} splits its ${MB_K} address bits ${REF_MAT.matBits} mat + ${REF_MAT.rowBits} row + ${REF_MAT.colBits} column; a global decoder enables one mat and global data lines bring its bits out.`,
      'SEC-DED: Hamming check bits at positions 1, 2, 4, … spell the position of one flipped bit, and one more parity bit tells one error from two. 8 data bits need 5 extra, 64 need 8: the 72-bit ECC word.',
      'Address = tag | index | word offset | byte offset. A hit is valid AND stored tag = address tag. Here a miss stalls 8 cycles (4 of latency, then 4 to copy the line); a dirty victim adds 4 to write it back first.',
      'Misses are compulsory, capacity or conflict. Ways remove conflict misses at the price of comparators, a wider hit multiplexer and replacement state: "Two arrays, one set" drops from 33 misses (direct-mapped write-back) to 9 with two ways.',
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
  parts: [['Memory cells', 6], ['How a cache works', 4], ['A CPU with a cache', 3], ['Fetch and the pipeline', 2], ['Average access time', 1]],
  steps: [
    {
      title: 'Six transistors per bit',
      body: `
        <p>The CPUs so far get their data in the same cycle they ask for it, because their data memory is tiny: a few dozen words of flip-flops next to the
        core. Real programs want megabytes or gigabytes, and a memory that large is far away and slow: an access takes on the order of 100 ns, a hundred cycles
        or more of a GHz core. With a load or store every few instructions, a CPU that waited for each one would spend nearly all its time waiting.</p>
        <p>What saves it is that programs are predictable in where they look. What was used is used again soon (a loop counter, the stack): <em>temporal
        locality</em>. What lies next to it is used next (an array walked in order, the next instruction): <em>spatial locality</em>. A <strong>cache</strong> is a
        small, fast memory beside the core holding copies of recently used blocks; a hit takes a cycle, and only a miss goes out to the big memory. This
        chapter builds one from the cell up, then measures what its misses cost.</p>
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
        <p>The ordering is not arbitrary. In a read, the access transistor and the pull-down of the side storing 0 form a divider, and the
        pull-down must win or the read would lift that node past the other inverter's threshold and flip the cell. In a write the access
        transistor must beat the cell's own pull-up, or the loop would push back. Pull-down &gt; access &gt; pull-up satisfies both at once.
        The price of dropping the clock and the enable is area spent on sizing; the gain is ${cell6} transistors a bit where the enable
        flip-flop needs ${ff}.</p>
        <div class="try">The cells power up unknown (X). Use the buttons, then open a cell to watch q and q̄.</div>`,
      scene: () => ({ root: SRAM_COLUMN, inputs: { pre_n: 1, w0: 0, w1: 0, wl0: 0, wl1: 0 } }),
      tour: {
        beats: [
          { title: 'Write a 1', set: { w1: 1, wl0: 1 }, show: ['c0'], expect: { bl: 1, blb: 0 },
            say: '<p>The strong driver w1 pulls bl̄ low ({b:blb}) while the word line wl0 connects cell 0 to it. The access transistor overpowers the weak pull-up on the side that held 1, and the loop flips: q = 1, q̄ = 0.</p>' },
          { title: 'Let go', set: { wl0: 0, w1: 0 }, show: ['c0'], expect: { bl: 1, blb: 0 },
            say: '<p>The word line drops and the driver lets go. The cell is isolated and keeps its 1 with no clock and no enable. The bit lines are undriven but hold their charge: bl̄ still reads {b:blb}.</p>' },
          { title: 'Write a 0 in cell 1', set: { w0: 1, wl1: 1 }, show: ['c1'], expect: { bl: 0, blb: 1 },
            say: '<p>The other driver pulls bl low while wl1 is up: cell 1 stores the opposite value, q = 0. The two cells share the same bit lines and never interfere, because only one word line is up at a time.</p>' },
          { title: 'Precharge', set: { wl1: 0, w0: 0, pre_n: 0 }, show: ['pre0', 'pre1'], expect: { bl: 1, blb: 1 },
            say: '<p>Both word lines are down. Precharge pulls both bit lines high ({b:bl} and {b:blb}), the neutral starting point for a read.</p>' },
          { title: 'Read cell 0', set: { pre_n: 1, wl0: 1 }, show: ['c0'], expect: { bl: 1, blb: 0 },
            say: '<p>Precharge released, wl0 up. Cell 0 holds q̄ = 0 and discharges bl̄ through its access transistor, so blb = {v:blb} while bl stays at {v:bl}. A sense circuit compares the two lines.</p>' },
          { title: 'Read cell 1', set: { wl0: 0, pre_n: 0 }, show: ['c1'], expect: { bl: 1, blb: 1 },
            say: '<p>Precharge again: the lines go back to 1 whatever the cell did to them.</p>' },
          { title: 'The other polarity', set: { pre_n: 1, wl1: 1 }, show: ['c1'], expect: { bl: 0, blb: 1 },
            say: '<p>Cell 1 stores 0, so this time bl is the line that falls. The value is the sign of the difference between the lines, not either level alone.</p>' },
        ],
      },
      more: {
        derive: `<p>Read of a cell storing 0 at q: bl is precharged high, the word line turns the access NMOS on, and the current flows through access and
          pull-down in series to ground. Node q sits between them at about V<sub>DD</sub> · R<sub>pd</sub> / (R<sub>pd</sub> + R<sub>acc</sub>). It must stay below the other
          inverter's trip point (about V<sub>DD</sub> / 2), so R<sub>pd</sub> &lt; R<sub>acc</sub>: the pull-down is wider than the access transistor.
          Write: bl is held at 0, the access NMOS must pull the node that stores 1 down against the PMOS pull-up, so R<sub>acc</sub> &lt; R<sub>pu</sub>.
          Together, W<sub>pd</sub> &gt; W<sub>acc</sub> &gt; W<sub>pu</sub>. The simulator models this as three strength levels instead of resistances.</p>`,
        numbers: `<table class="mini"><tr><th>Cell</th><th>Transistors a bit</th><th>For 1 Kbit</th></tr>
          <tr><td>Enable flip-flop (register file)</td><td>${ff}</td><td>${ff * 1024}</td></tr>
          <tr><td>6T SRAM cell</td><td>${cell6}</td><td>${cell6 * 1024}</td></tr>
          <tr><td>1T1C DRAM cell</td><td>${cell1}</td><td>${cell1 * 1024}</td></tr></table>`,
        real: `<p>Most last-level and L1 caches of production cores are 6T arrays (some L3s are eDRAM). Register files and low-voltage arrays often use an 8T cell: two more transistors form a
          separate read port, so a read cannot disturb the stored bit and the pull-down need not win a divider contest, at the price of area. Sense
          amplifiers fire on a difference of tens of millivolts rather than waiting for a full swing, which is most of the speed of a real array.</p>`,
        pitfall: `<p>Raising the word line while precharge is still on. The precharge devices hold both bit lines high, not the cell, so the read sees nothing of it. The
          buttons release precharge first; by hand, set pre_n back to 1 before wl0, and check that exactly one bit line falls.</p>`,
      },
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
        of <a href="#/c/routing/0">chapter ${numOf('routing')}</a>, here running as its transistors); <span data-show="col0 col1 col2 col3">each column</span> shares a bit-line pair with its own precharge,
        <span data-show="col0.wd"><strong>write driver</strong></span>
        and <span data-show="col0.sa"><strong>sense amplifier</strong></span>. One access reads or writes a whole row, one bit per column.</p>
        <p>The sense amplifier is a latch: while <code>sae</code> (sense amplifier enable) = 0 it follows the bit lines (unpowered, so it never drives them); when
        <code>sae</code> rises it isolates itself and latches the value, which it holds while the bit lines are precharged for the next access.
        In silicon it also <em>amplifies</em>: it fires when the bit lines differ by ~100 mV, long before a small cell could swing a long
        bit line fully. Here the swing is full; <a href="#/c/dram/0">chapter ${numOf('dram')}</a> opens a DRAM, where it is not.</p>
        <p>Cost of this 4×4: ${sramT(4)} transistors, of which the cells are ${cell6 * 16}. The periphery is shared per row and per column, so it amortizes:
        at 8×8 the cells are ${pct((cell6 * 64) / sramT(8))}, and in a real 32 KB array over 90 %. Sixteen bits of flip-flop registers would cost ${16 * ff}.</p>
        <p>The sequence is the cell's, one level up. A write needs the word line and the write driver at the same time; a read needs precharge, then the word line, then
        the sense amplifier enable, in that order. Reading right after a write without precharging in between returns what the write left on the bit lines, not what is
        stored. The shape matters as much as the size: a wide array has short bit lines but a long word line, a tall one the opposite, and real designs split large
        arrays into many small sub-arrays to keep both short.</p>
        <div class="try">Use the buttons: Precharge, set <code>din</code> and <code>addr</code>, Write; then Precharge and Read.</div>`,
      scene: () => ({ root: sramArray(4, 4), inputs: { addr: 0, wl: 0, pre_n: 1, we: 0, din: 0, sae: 0 } }),
      tour: {
        beats: [
          { title: 'Precharge', set: { addr: 2, din: 0xa, pre_n: 0 }, show: ['col0', 'col1', 'col2', 'col3'], expect: { dout: 0 },
            say: '<p>addr = 2 and din = 0xA are set. Precharge lifts every bit line; the sense amplifiers follow them and show dout = {v:dout}, which says nothing about the memory.</p>' },
          { title: 'Write', set: { pre_n: 1, we: 1, wl: 1 }, show: ['dec', 'col0', 'col1', 'col2', 'col3'], expect: { dout: 0xa },
            say: '<p>The decoder raises the word line of row 2 and the write drivers force the bit lines to din in all four columns at once. dout follows the lines: {v:dout}.</p>' },
          { title: 'Close', set: { wl: 0, we: 0 }, show: ['dec'], expect: { dout: 0xa },
            say: '<p>The word line drops: the four cells of row 2 are isolated with 0xA stored. The sense amplifiers still show the old bit lines.</p>' },
          { title: 'Precharge again', set: { pre_n: 0 }, show: ['col0', 'col1', 'col2', 'col3'], expect: { dout: 0 },
            say: '<p>Precharge wipes the bit lines, and dout drops to {v:dout}. The data is in the cells, not on the wires.</p>' },
          { title: 'Read: word line', set: { pre_n: 1, wl: 1 }, show: ['dec'], expect: { dout: 0xa },
            say: '<p>Row 2 is selected again and each cell pulls one of its two bit lines down. The amplifiers in follow mode already show {v:dout}.</p>' },
          { title: 'Read: latch', set: { sae: 1 }, show: ['col0', 'col1', 'col2', 'col3'], expect: { dout: 0xa },
            say: '<p>sae rises: the amplifiers isolate themselves and latch the difference. dout = {v:dout} now holds while the lines are precharged for the next access.</p>' },
        ],
      },
      more: {
        numbers: `<table class="mini"><tr><th>Array</th><th>Transistors</th><th>Cells</th><th>Share</th><th>As enable flip-flops</th></tr>
          ${[4, 8, 16].map((n) => `<tr><td>${n} × ${n}</td><td>${sramT(n)}</td><td>${cell6 * n * n}</td><td>${pct((cell6 * n * n) / sramT(n))}</td><td>${ff * n * n}</td></tr>`).join('')}</table>`,
        derive: `<p>Total = 6 R C for the cells + R decoder outputs and word-line drivers + C columns of precharge, write driver and sense amplifier. The cells grow as R C, the periphery as
          R + C, so the cell share rises with size: ${pct((cell6 * 16) / sramT(4))} at 4 × 4, ${pct((cell6 * 256) / sramT(16))} at 16 × 16, and tends to 1. Against flip-flops the array
          is ${(ff / cell6).toFixed(0)} times denser per bit before the periphery and still ${(16 * ff / sramT(4)).toFixed(1)} times at 4 × 4.</p>`,
        pitfall: `<p>Reading straight after a write. The write leaves the bit lines driven to the written value, so the amplifiers latch that and the read appears to work on any
          address. Precharge in between, and use a different address than the one just written to see the cells themselves.</p>`,
      },
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
      title: 'From an array to a megabyte',
      body: `
        <p>A megabyte is ${groupDigits(MB_BITS)} bits. As one square array that is ${MB_SIDE} cells a side: every word line crosses ${MB_SIDE} cells and every
        bit line carries ${MB_SIDE}. A word line is a distributed RC line, its resistance and its capacitance both growing with its length, so its delay grows
        with the <em>square</em> of the length: ${(MB_SIDE / MAT_REF).toFixed(1)} times the ${MAT_REF} cells of a modest row is about ${Math.round((MB_SIDE / MAT_REF) ** 2)} times slower.
        A bit line fails another way. The selected cell discharges it with a roughly constant current, so the time to reach the ~100 mV the sense amplifier needs
        grows with the line's capacitance, the cells on it: ${(MB_SIDE / MAT_REF).toFixed(0)} times longer.</p>
        <p>So nobody builds one array. The memory is cut into <strong>mats</strong> (sub-arrays) of a few hundred rows and columns, each the array of the last
        step with its own row decoder, precharge, column multiplexer and sense amplifiers. In mats of ${MAT_REF} × ${MAT_REF} a megabyte is ${REF_MAT.mats} of them,
        and the ${MB_K} address bits of a byte split three ways: ${REF_MAT.matBits} pick the mat, ${REF_MAT.rowBits} the row in it, ${REF_MAT.colBits} the ${MAT_WORD} columns
        out of ${MAT_REF}.</p>
        <p>Decoding happens in two levels. A global decoder enables one mat, and only that mat raises a local word line and swings its bit lines: a read
        charges ${MAT_REF} bit lines, not every column a chip-wide row would cross (the <em>divided word line</em>). The chosen mat's
        ${MAT_WORD} bits reach the pins on <em>global data lines</em>, usually laid out as an H-tree so that every mat is about the same wire length away.</p>
        <p>The memory on the stage is organized the same way. <span data-show="sa">The top ${MB_TOP_BITS} address bits</span> go to
        <span data-show="dec">a ${MB_TOP_BITS}-to-${MB_LEVELS[0].banks} decoder</span> that gives one bank its write enable, and
        <span data-show="rmux">a ${MB_LEVELS[0].banks}:1 multiplexer tree</span> brings that bank's byte back. Every bank is the same again,
        ${MB_LEVELS.length} levels of it (${MB_LEVELS.map((l) => kWords(l.words)).join(' → ')} words), down to banks of ${kWords(BANK_WORDS)} words built from gates:
        the RAM of <a href="#/c/memory/3">chapter ${numOf('memory')}</a>. Two differences from silicon. Where a real chip has a 6T cell, this one has an enable flip-flop, so it
        counts ${groupDigits(MB_T)} transistors, ${groupDigits(MB_BITS * ff)} of them in the flip-flops against ${groupDigits(MB_BITS * cell6)} for the same bits in 6T cells.
        And the multiplexer tree stands in for global data lines, which are a precharged bus that only the enabled mat drives.</p>
        <p>The panel cuts the megabyte into mats of any shape. Long rows make the word line slow, tall columns make the bit line slow, and both make each read
        swing more charge. Small mats repeat the decoder and the sense amplifiers so often that the cells lose their share of the area.</p>
        <div class="try">Store 0xA5 at address 0xC0FFE: set <code>addr</code>, <code>din</code> and <code>we</code>, then Pulse.</div>
        <div class="try">Open the banks that hold it, one level at a time, down to the flip-flops of word ${MB_PATH.word}.</div>`,
      scene: () => ({ root: MB_RAM, inputs: { addr: MB_ADDR, din: 0xa5, we: 0, clk: 0 }, autoClock: false, highlight: ['dec', 'rmux'], panels: [matSizePanel] }),
      tries: [
        (st) => mbWord(st) === 0xa5,
        (st) => st.path.join('.').startsWith(MB_PATH.banks.join('.')),
      ],
      tour: {
        beats: [
          { title: 'The bank', at: [], set: { addr: MB_ADDR, din: 0xa5, we: 1, clk: 0 }, show: ['sa', 'dec'], expect: { dout: 0 },
            say: `<p>Address 0xC0FFE. Its top ${MB_TOP_BITS} bits are 0x${(MB_ADDR >> (MB_K - MB_TOP_BITS)).toString(16).toUpperCase()}, so the decoder raises the write enable of ${MB_PATH.banks[0]} alone; the other bits go to every bank. dout = {v:dout}: nothing is stored there yet.</p>` },
          { title: 'Write', cycles: 1, show: [MB_PATH.banks[0]], expect: { dout: 0xa5 },
            say: '<p>One rising edge: the enabled bank stores the byte, and the multiplexer tree, steered by the same top bits, brings it back. dout = {v:dout} (0xA5).</p>' },
          { title: 'Same low bits, another bank', set: { we: 0, addr: MB_ADDR & (2 ** (MB_K - MB_TOP_BITS) - 1) }, show: ['rmux', 'bank0'], expect: { dout: 0 },
            say: '<p>Clear the top bits and the low bits stay the same: the address now falls in bank0, which holds nothing at that place. dout = {v:dout}.</p>' },
          { title: 'Down to the word', set: { addr: MB_ADDR }, at: MB_PATH.banks, show: [MB_PATH.word], expect: { dout: 0xa5 },
            say: `<p>Back at 0xC0FFE, opened bank by bank: ${MB_PATH.banks.join(' → ')}, each picked by the next address bits. Here are the gates: word ${MB_PATH.word} of a ${kWords(BANK_WORDS)}-word RAM, eight enable flip-flops holding 0xA5.</p>` },
        ],
      },
      more: {
        derive: `<p>A wire of length L has resistance r L and capacitance c L. Driven from one end, its Elmore delay is about r c L² / 2: double the row and the word line is four
          times slower. A bit line of R cells has capacitance R C<sub>cell</sub> + its wire; the cell sinks a current I, so the swing ΔV takes t = C ΔV / I, linear in R.
          The address bits always add up: for a mat of R rows and C columns read ${MAT_WORD} bits at a time, log₂(${groupDigits(MB_BITS)} / R C) mat bits + log₂ R row bits
          + log₂(C / ${MAT_WORD}) column bits = ${MB_K}.</p>`,
        numbers: `<table class="mini"><tr><th>Level</th><th>Banks</th><th>Bank size</th><th>Address bits it decodes</th></tr>
          ${MB_LEVELS.map((l) => `<tr><td>${kWords(l.words)} × 8</td><td>${l.banks}</td><td>${kWords(l.words / l.banks)} words</td><td>${Math.log2(l.banks)}</td></tr>`).join('')}
          <tr><td>${kWords(BANK_WORDS)} × 8 (gates)</td><td>${BANK_WORDS} words</td><td>8 flip-flops</td><td>${Math.log2(BANK_WORDS)}</td></tr></table>`,
        real: `<p>The divided word line was introduced by Mitsubishi in 1983 (Yoshimoto et al., a 64 Kbit CMOS SRAM); Hitachi's hierarchical word decoding (1990) took it to
          more levels for 4 Mbit parts. Large SRAMs also carry spare rows and columns in each mat. At test, fuses record the faulty addresses, and a comparator per spare (a small
          content-addressable memory) sends an access to the spare instead, which turns most dies with a few bad cells into good ones. Caches add the tag arrays and the way
          multiplexers of the next steps on top.</p>`,
        pitfall: `<p>Reading the cell share of the last step as the share of a whole memory. That figure is cells over one array with its own periphery; a real macro also
          spends area on global decoders, data lines, repair and power straps, so its share of the area is lower.</p>`,
      },
      challenge: {
        kind: 'reach', goal: `Store 0xA5 at address 0xC0FFE, then open the banks down to the ${kWords(BANK_WORDS)}-word bank of flip-flops that holds it.`,
        check: (st) => mbWord(st) === 0xa5 && st.path.join('.') === MB_PATH.banks.join('.'),
        hints: [
          'Write first: addr = 0xC0FFE, din = 0xA5, we = 1, then Pulse.',
          `Each level decodes the next address bits. At the top, the highest ${MB_TOP_BITS} bits of 0xC0FFE pick the bank to open.`,
        ],
        answer: `addr = 0xC0FFE, din = 0xA5, we = 1, Pulse. Then open ${MB_PATH.banks.join(', then ')}: 0xC0FFE = ${MB_PATH.fields}.`,
        solve: (st) => { st.goTo([]); st.setInputs({ addr: MB_ADDR, din: 0xa5, we: 1 }); st.pulse(); st.setInputs({ we: 0 }); st.goTo(MB_PATH.banks); },
      },
    },
    {
      title: 'One transistor per bit: DRAM',
      body: `
        <p>Main memory goes further: <strong><span data-show="a">one transistor</span> and one capacitor</strong>. With
        <span data-show="pin:wl">the word line</span> high, <span data-show="pin:bl">the bit line</span>
        charges or discharges the capacitor. With it low, <span data-show="pin:q">the storage node</span> is isolated and keeps its charge. The simulator shows
        the stored value, not Z, because the net is capacitive.</p>
        <p>That is ${cell1} transistor a bit against ${cell6} for SRAM, and the capacitor is stacked or buried above the silicon, so the cell takes a fraction of the area. The cost is
        in what the cell cannot do. Nothing restores the charge: it leaks away through the off transistor, so every row must be rewritten before it fades. And a read connects
        a tiny capacitor to a long bit line, so the cell loses its charge in the act of being read and must be written back. A DRAM is therefore a memory with a refresh
        schedule and a restore after every read, and its latency is much greater than an SRAM's.</p>
        <div class="try">Set bl = 1 with wl = 1, drop wl, then change bl: q does not follow until wl rises again.</div>`,
      scene: () => ({ root: DRAM_CELL, inputs: { wl: 1, bl: 1 } }),
      tour: {
        beats: [
          { title: 'Write a 0', set: { bl: 0 }, expect: { q: 0 },
            say: '<p>With the word line high the transistor conducts and the bit line drives the capacitor: q = {v:q}.</p>' },
          { title: 'Write a 1', set: { bl: 1 }, expect: { q: 1 },
            say: '<p>bl = 1 charges the capacitor again: q = {v:q}. The charge on it is the bit.</p>' },
          { title: 'Isolate', set: { wl: 0 }, expect: { q: 1 },
            say: '<p>The word line falls. The transistor is off and the capacitor holds q = {v:q}, with nothing driving it. In silicon this charge fades: the weakest cells within tens of milliseconds, so every row is refreshed each 64 ms (most cells would hold far longer); here the simulator holds it until the next write.</p>' },
          { title: 'The bit line moves', set: { bl: 0 }, expect: { q: 1 },
            say: '<p>bl swings to {v:bl} and q does not follow: the cell is isolated. This is how thousands of cells share one bit line, with only the selected row connected.</p>' },
          { title: 'Open again', set: { wl: 1 }, expect: { q: 0 },
            say: '<p>The word line rises, the bit line is at 0, and the capacitor discharges into it: q = {v:q}. The stored 1 was destroyed. A real read does the same to the cell, which is why the sense amplifier writes the value back.</p>' },
        ],
      },
      more: {
        derive: `<p>Charge sharing: a cell capacitor C<sub>c</sub> = ${CELL_C} fF at V<sub>c</sub> joined to a bit line of C<sub>b</sub> = ${BITLINE_C} fF precharged to V<sub>DD</sub> / 2 settles at
          (C<sub>c</sub> V<sub>c</sub> + C<sub>b</sub> V<sub>DD</sub> / 2) / (C<sub>c</sub> + C<sub>b</sub>). Reading a stored 1 moves the line by
          (V<sub>DD</sub> / 2) · C<sub>c</sub> / (C<sub>c</sub> + C<sub>b</sub>) = ${(100 * CELL_C / (CELL_C + BITLINE_C) / 2).toFixed(1)} % of V<sub>DD</sub>: ${(CELL_C / (CELL_C + BITLINE_C)).toFixed(2)} of the half swing. The ratio
          C<sub>c</sub> / C<sub>b</sub> sets how small the signal is, and why a sense amplifier is not optional. <a href="#/c/dram/0">Chapter ${numOf('dram')}</a> measures it on the array.</p>`,
        pitfall: `<p>Reading q as a permanent value. It is a charge: dropping wl only makes it last a while. Any model of DRAM needs a leak and a refresh; this scene advances no real time, so the cell looks permanent
          until the next write.</p>`,
        real: `<p>Modern DRAM cells are a transistor with a deep trench or a stacked capacitor of some tens of femtofarads, with every row refreshed each 64 ms. The array and its
          sense amplifiers are tuned for density and leakage rather than speed, and the process is not the one that makes fast logic: this is why DRAM is a separate chip.</p>`,
      },
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
      deep: true,
      body: `<p>The stored charge leaks through the off transistor and the junction, so every row must be read and rewritten periodically. A read only produces a small voltage on the bit line. <a href="#/c/dram/0">Chapter ${numOf('dram')}</a> builds the array, the precharge to VDD/2 and the sense amplifier at transistor level, with the charge sharing measured in millivolts.</p>
        <p>Refresh is a tax on every access. The controller must issue a refresh command every ${TIMING.tREFI} of our cycles, and each one keeps the bank busy for ${TIMING.tRFC}:
        a bank is unavailable ${pct(TIMING.tRFC / TIMING.tREFI)} of the time to a request that arrives at a random moment, and a request that collides with a refresh waits out
        the rest of it. The sense amplifier does double duty: it detects the small difference between the bit lines and, driving them to full levels, restores the cell
        it just read. Row by row, that is also the refresh.</p>`,
      widget: dramWidget,
      more: {
        derive: `<p>If every row must be visited within the retention time (64 ms), and a bank has N rows, the controller must refresh a row every 64 ms / N on average. One refresh command
          covers a group of rows, so in the DDR4-3200 model used here commands come tREFI = ${TIMING.tREFI} cycles apart, and each keeps the bank busy for tRFC = ${TIMING.tRFC} cycles. Overhead = tRFC / tREFI =
          ${TIMING.tRFC} / ${TIMING.tREFI} = ${(100 * TIMING.tRFC / TIMING.tREFI).toFixed(1)} %. Bigger chips have more rows to visit in the same 64 ms, so tRFC grows with density and
          refresh costs a larger share.</p>`,
        pitfall: `<p>Treating a read as free. Because the read empties the cell, the access is a read followed by a restore: the row cannot be precharged until it is rewritten (the
          row-active minimum, tRAS, of <a href="#/c/dram/0">chapter ${numOf('dram')}</a>). A model that charges only the read time makes DRAM look faster than it is.</p>`,
        real: `<p>Controllers hide refresh by issuing it per bank while others are busy, by postponing a few commands, and by running it in the shadow of idle time. Each cell is
          not equal: weak cells leak early, and server memory pairs refresh with ECC (the next step) to catch the few that lose their charge between visits.</p>`,
      },
    },
    {
      title: 'Errors and ECC',
      body: `
        <p>A cell can also flip: a weak DRAM cell leaks early, or a particle strike dumps charge into a node. One <strong>parity</strong> bit
        (an XOR tree) detects any single flip but cannot locate it. A <strong>Hamming code</strong> adds r check bits at positions 1, 2, 4, …:
        check bit 2ʲ covers every position with bit j set. On read, the recomputed checks (the <em>syndrome</em>) spell the position of a
        single flipped bit, which the decoder flips back. One more bit of overall parity tells one error from two: <strong>SEC-DED</strong>,
        single error correct, double error detect.</p>
        <p>8 data bits need ${checkBits(8)} extra bits (${8 + checkBits(8)} in all). For 64 bits it is ${checkBits(64)} extra bits, the ${64 + checkBits(64)}-bit words of ECC DIMMs and of most server
        caches. <span data-show="enc">Encoding</span> costs ${eccCost(8).enc} NANDs here and <span data-show="dec">decoding</span> ${eccCost(8).dec}, which sits in the read path of every access.</p>
        <p>The code works because the syndrome is an address. Number the stored bits from 1; check bit 2<sup>j</sup> is the parity of every position whose binary form has bit j set. Flip
        the bit at position p, and exactly the checks that cover p change: together they spell p in binary. With nothing flipped the syndrome is 0. Overall parity adds the second
        observation: a single flip makes it odd, two flips leave it even with a non-zero syndrome, and that combination is flagged as uncorrectable instead of being "fixed".</p>
        <div class="try">Flip one bit (any bit of <span data-show="upset"><code>flip</code></span>): dout stays 0x5A and <code>single</code> rises. Flip two: <code>double</code> rises and the data
        can no longer be trusted.</div>`,
      scene: () => ({ root: eccChannel(8), inputs: { d: 0x5a, flip: 0 } }),
      tour: {
        beats: [
          { title: 'Clean channel', show: ['enc', 'dec'], expect: { dout: 0x5a, single: 0, double: 0 },
            say: `<p>d = 0x5A (90) goes through the encoder, which adds ${checkBits(8)} check bits, then through the decoder. No bit is flipped: dout = {v:dout}, no error flags.</p>` },
          { title: 'One bit flips', set: { flip: 1 }, show: ['upset', 'dec'], expect: { dout: 0x5a, single: 1, double: 0 },
            say: '<p>flip = {b:flip} inverts one stored bit. The recomputed checks disagree in exactly the pattern that spells its position; the decoder inverts it back: dout is still {v:dout} and <code>single</code> = {v:single}.</p>' },
          { title: 'Two bits flip', set: { flip: 0b10010 }, show: ['upset', 'dec'], expect: { single: 0, double: 1 },
            say: '<p>Two flips: the syndrome is non-zero but the overall parity is even again, which no single flip can produce. <code>double</code> = {v:double}: the error is detected, and the data cannot be trusted.</p>' },
          { title: 'Three bits flip', set: { flip: 0b111 }, show: ['upset', 'dec'], expect: { dout: 0x5b, single: 1, double: 0 },
            say: '<p>Three flips look like one to the code: the overall parity is odd, so the decoder "corrects" a bit that was fine. dout = {v:dout} (91, not 90) is wrong with <code>single</code> = {v:single}. SEC-DED guarantees only what its name says.</p>' },
        ],
      },
      more: {
        numbers: `<table class="mini"><tr><th>Data bits</th><th>Check bits</th><th>Stored</th><th>Encoder NANDs</th><th>Decoder NANDs</th></tr>
          ${[8, 16, 32, 64].map((k) => `<tr><td>${k}</td><td>${checkBits(k)}</td><td>${k + checkBits(k)}</td><td>${eccCost(k).enc}</td><td>${eccCost(k).dec}</td></tr>`).join('')}</table>`,
        derive: `<p>r check bits give 2<sup>r</sup> syndromes. They must name any of the k + r stored positions or "no error": 2<sup>r</sup> ≥ k + r + 1. For k = 8, r = 4 gives 16 ≥ 13; one more bit
          for double detection makes ${checkBits(8)}. Overhead falls with width: ${checkBits(8)} / 8 = ${pct(checkBits(8) / 8)}, ${checkBits(64)} / 64 = ${pct(checkBits(64) / 64)}. That is why
          memory is protected per 64-bit word and not per byte.</p>`,
        pitfall: `<p>Reading "single = 1" as harmless. It means a bit was wrong and has been corrected on the way out; the cell in memory is still wrong until it is written back. A second
          flip in the same word before that happens is uncorrectable, which is why servers scrub memory: read, correct and rewrite every word in the background.</p>`,
        real: `<p>ECC DIMMs store 72 bits for each 64 data bits; on-die ECC inside DDR5 chips fixes single-bit cell errors before the controller sees them. Caches use SEC-DED on larger
          arrays and plain parity on small ones (parity on a write-through L1 is enough: a bad line is refetched). GPUs and automotive parts add it to register files.</p>`,
      },
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
        <em>local</em>: they reuse recent data (temporal locality) and use nearby addresses together (spatial locality).</p>
        <p>The mechanism is a ladder of trades. Each level is several times larger and several times slower than the one above it, because a bigger array has longer wires and
        a bigger decoder, and a cheaper cell is a slower one (SRAM, then DRAM, then flash). A level pays off only if it catches most of the requests that reach it: if 95 % of
        accesses hit in the first level, the processor sees that level's speed for 95 % of its accesses and the next level's speed, diluted, for the rest. Locality is what makes the hit
        rate high; without it the hierarchy would be pure overhead, and a program that jumps randomly through a large array shows exactly that.</p>`,
      widget: () => withModel(hierarchyWidget(), hierarchy3d()),
      more: {
        derive: `<p>Expected cost of an access is the sum over levels of (probability that the access gets that far) × (that level's time). With L1 hitting ${pct(1 - 0.05)}, a
          miss going to L2 which hits ${pct(1 - 0.2)} of the time, and DRAM behind it: ${amat([[4, 0.05], [12, 0.2]], 250).toFixed(1)} cycles on average, against 250 without caches. Halving the
          L1 miss rate (5 % to 2.5 %) gains ${(amat([[4, 0.05], [12, 0.2]], 250) - amat([[4, 0.025], [12, 0.2]], 250)).toFixed(1)} cycles; halving the DRAM latency gains
          ${(amat([[4, 0.05], [12, 0.2]], 250) - amat([[4, 0.05], [12, 0.2]], 125)).toFixed(1)}. The miss rate multiplies everything below it, so it is the lever that matters most. These are round numbers (L2 12 cycles, DRAM 250, no L3); the model above uses the table's own (L2 14, L3 64, DRAM 320), and with L1 / L2 / L3 hitting ${pct(DEFAULT_HITS.l1)} / ${pct(DEFAULT_HITS.l2)} / ${pct(DEFAULT_HITS.l3)} its sliders start at ${amatCycles(DEFAULT_HITS).toFixed(1)} cycles on average.</p>`,
        real: `<p>Typical numbers for a desktop core: L1 32 to 48 KB at 4 to 5 cycles, L2 256 KB to 2 MB at about 12 to 15, a shared L3 of tens of MB at 40 or more, DRAM at 200 or more
          cycles. Registers are the level above L1, and a hit in them costs nothing visible, which is why compilers work so hard to keep values there.</p>`,
        pitfall: `<p>Reading a cache's size as its speed-up. A hierarchy helps by the fraction of accesses it catches, not by its capacity: a 1 MB cache in front of a program that streams
          once through 1 GB catches no reuse: every line is fetched once, and only the hits within a line help.</p>`,
      },
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
        <p>Why the line is four words: a miss costs a fixed latency plus a transfer, and the latency dominates, so fetching the neighbours is almost free and often useful. Why the index
        is the low bits above the offset: consecutive lines then land in consecutive places, and a sweep through memory uses the whole cache before it wraps. The price of
        simplicity is that one address has exactly one place to go. Two addresses a cache-size apart (here 64 bytes) share a line and evict each other, whatever room the rest
        of the cache has.</p>
        <p>Overhead: this memory has ${split(64, 16, 1, 8).tag}-bit tags and a valid bit on each of 4 lines, ${pct(3 / 128)} of the 128 data bits in each line. Real caches pay more, about 6 to 8 % with their valid and dirty bits: their addresses are far longer than this memory's 8 bits, and their lines only a few times longer.</p>
        <div class="try">Address 0x24 is a load (read enable <code>re</code> = 1) and misses. Pulse the clock 8 times and watch the counter, the line fill and hit rise.</div>`,
      scene: () => ({ root: cachedMemory(6), inputs: { addr: 0x24, re: 1, we: 0, wd: 0, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Cold miss', show: ['tags', 'eq'], expect: { hit: 0, stall: 1 },
            say: '<p>Address 0x24 splits as tag 0, index 2, word 1, byte 0. Line 2 is invalid, so the comparator cannot match: hit = {v:hit}, and the cache raises stall = {v:stall}.</p>' },
          { title: 'Waiting for memory', cycles: 4, show: ['cnt', 'ram'], expect: { hit: 0, stall: 1 },
            say: '<p>Four clock edges: the counter is waiting out main memory\'s latency. Nothing has been written into the line yet, and stall is still {v:stall}.</p>' },
          { title: 'Filling the line', cycles: 4, show: ['data', 'tags'], expect: { hit: 1, stall: 0 },
            say: '<p>Four more edges copy one word each into the line, and the last one writes the tag. Now valid AND tag match: hit = {v:hit}, stall = {v:stall}. Eight cycles in all.</p>' },
          { title: 'Same line, no wait', set: { addr: 0x2c }, show: ['eq', 'data'], expect: { hit: 1, stall: 0 },
            say: '<p>0x2C is the fourth word of the same 16-byte line: same index, same tag. It hits at once, with no clock edge: spatial locality in one step.</p>' },
          { title: 'Another line', set: { addr: 0x04 }, show: ['tags', 'eq'], expect: { hit: 0, stall: 1 },
            say: '<p>0x04 has index 0, whose line has never been loaded: miss again, hit = {v:hit}. A different line costs the full eight cycles even though the cache has room.</p>' },
        ],
      },
      more: {
        derive: `<p>Address = tag | index | word offset | byte offset. For this cache: ${split(64, 16, 1, 8).off} offset bits (2 byte, 2 word), ${split(64, 16, 1, 8).idx} index bits, ${split(64, 16, 1, 8).tag} tag bits in 8.
          A cache of S bytes with L-byte lines and w ways has S / (L w) sets: index = log<sub>2</sub>(S / (L w)), offset = log<sub>2</sub> L, tag = the address bits left over.
          Miss time here is 4 (latency) + 4 (one word a cycle) = 8 cycles, so a program with miss rate m runs at CPI 1 + 8 m × (loads per instruction).</p>`,
        numbers: `<table class="mini"><tr><th>Cache (48-bit physical address)</th><th>Offset</th><th>Index</th><th>Tag</th></tr>
          ${[[32768, 64, 8], [32768, 64, 1], [1048576, 64, 16]].map(([s, l, w]) => { const x = split(s, l, w, 48); return `<tr><td>${s / 1024} KB, ${l} B lines, ${w === 1 ? 'direct-mapped' : w + '-way'}</td><td>${x.off}</td><td>${x.idx}</td><td>${x.tag}</td></tr>`; }).join('')}</table>`,
        pitfall: `<p>Comparing the tag without the valid bit. A line that has never been loaded holds zeros, and an address with tag 0 would "hit" on garbage. The valid bit costs one flip-flop a
          line and is part of the hit condition; after Reset every line is invalid, and the first access to each is a compulsory miss.</p>`,
        real: `<p>Direct-mapped caches survive where a short hit time matters more than the conflict misses, as in some small embedded cores. Desktop L1 data caches are typically 8- to 12-way; lines are 64 bytes.
          Tags are read in parallel with the data so that the compare overlaps the data array's access.</p>`,
      },
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
        <p>The point of real traces is that the miss rate is a property of a program and a cache together, not of either alone. The same loads in a different order, or the same
        order through a cache that is a power of two different in size, change the outcome by a factor of four or more. When a result surprises you, change one parameter at a time,
        and read the miss classes: a conflict miss is cured by ways, a capacity miss only by size or a better loop order, and a compulsory miss only by bigger lines or prefetching.</p>
        <div class="try">Compare the two matrix sums. Then load "Vector add" at 512 bytes: direct-mapped, 2-way (three arrays per set, still thrashing), 4-way.</div>`,
      widget: () => cacheExplorer({ trace: 'colmajor' }),
      more: {
        numbers: `<table class="mini"><tr><th>Miss rate, %</th><th>256 B direct</th><th>256 B 4-way</th><th>1 KB direct</th></tr>
          ${[['rowmajor', 'Row by row'], ['colmajor', 'Column by column'], ['vecadd', 'Vector add']].map(([id, n]) => `<tr><td>${n}</td>${[{}, { ways: 4 }, { size: 1024 }].map((c) => `<td>${fixed(missRate(id, c))}</td>`).join('')}</tr>`).join('')}</table>`,
        derive: `<p>Column by column with 16-byte lines: the stride is 64 bytes, four lines. A column touches 16 rows, so 16 distinct lines, in a 256-byte cache with 16 sets: line i of the
          column goes to set (4 i + j / 4) mod 16. Rows i and i + 4 share a set, so the column does not fit, each line is evicted before the next column reuses it, and every access misses.
          A 1 KB cache has 64 sets, each row gets its own, and only the first touch of each of the 64 lines misses: ${fixed(missRate('colmajor', { size: 1024 }))} %.</p>`,
        pitfall: `<p>Reading a low miss rate in row-major order as a property of the cache. The cache is the same in both orders; the loop order differs. Swapping the two loops (loop interchange) is
          a free fix in software, and compilers do it when they can prove it safe.</p>`,
      },
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
        for 8 ways most designs use a cheaper approximation (tree pseudo-LRU).</p>
        <p>How to tell the classes apart: compulsory misses are those an infinitely large cache would also take. Of the rest, capacity misses are those a fully associative cache of the same
        size would also take, and conflict misses are the remainder, the ones that exist only because of the mapping. That definition is exactly how the explorer of the last step
        classifies them, and it says what to do about each: bigger lines or prefetching, a bigger cache, more ways or a better placement of the data.</p>
        <p>The hit path is where associativity costs time. The tag comparison cannot start before the stored tags are read, and the hit signal then drives a multiplexer that picks the
        data: this lookup is ${stats(wayLookup2(3, 8)).nands} NANDs and ${logicDepth(wayLookup2(3, 8))} deep for two ways with 3-bit tags and 8-bit data.</p>`,
      scene: () => ({ root: wayLookup2(3, 8), inputs: { tag: 5, v0: 1, tag0: 2, d0: 0x11, v1: 1, tag1: 5, d1: 0x22 } }),
      tour: {
        beats: [
          { title: 'Way 1 matches', show: ['e0', 'e1', 'mx'], expect: { hit: 1, way: 1, data: 0x22 },
            say: '<p>The address tag is {v:tag}. Way 0 holds tag 2, way 1 holds tag 5. Both comparators work at once and way 1 matches: hit = {v:hit}, the multiplexer selects way {v:way} and data = {v:data}.</p>' },
          { title: 'Way 0 matches', set: { tag: 2 }, show: ['e0', 'mx'], expect: { hit: 1, way: 0, data: 0x11 },
            say: '<p>Tag 2 matches way 0 instead: the same logic, the multiplexer now selects way {v:way}, data = {v:data}. The set holds two lines that a direct-mapped cache could not hold at once.</p>' },
          { title: 'Neither matches', set: { tag: 7 }, show: ['e0', 'e1'], expect: { hit: 0 },
            say: '<p>Tag 7 is in neither way: hit = {v:hit}. This is a miss, and replacement now has to choose which of the two lines to evict (the LRU bit of a later step).</p>' },
          { title: 'Valid bit', set: { tag: 5, v1: 0 }, show: ['e1'], expect: { hit: 0 },
            say: '<p>Back to tag 5, but way 1 is marked invalid. Its stored tag still equals 5 and the hit is {v:hit}: the valid bit is part of the match.</p>' },
        ],
      },
      more: {
        derive: `<p>Hit = OR over ways of (valid AND stored tag = address tag). For w ways that is w comparators of t bits and a w-to-1 multiplexer of the data width; the multiplexer's select
          is the encoded way number. Sets halve each time the ways double (S / (L w) sets), so the index gets one bit shorter and the tag one bit longer: a 2-way cache of the same size
          has ${split(256, 16, 2, 8).idx} index bits and ${split(256, 16, 2, 8).tag} tag bits where a direct-mapped one has ${split(256, 16, 1, 8).idx} and ${split(256, 16, 1, 8).tag} (8-bit addresses, 256 bytes, 16-byte lines).</p>`,
        numbers: `<table class="mini"><tr><th>Ways</th><th>Sets (256 B, 16 B lines)</th><th>Comparators</th><th>Replacement state a set</th></tr>
          ${[1, 2, 4, 8, 16].map((w) => `<tr><td>${w === 16 ? '16 (fully associative)' : w}</td><td>${256 / 16 / w}</td><td>${w}</td><td>${w === 1 ? 'none' : w === 2 ? '1 bit (LRU)' : `${w - 1} bits (tree pseudo-LRU)`}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Assuming more ways always cut misses. Past a point, extra ways cost comparators and a slower hit for no gain: when a loop's conflicts are between 3 arrays, a 4-way cache
          removes them and an 8-way one pays more for the same hit rate. And a loop whose working set exceeds the cache misses at any associativity: that is a capacity miss.</p>`,
        real: `<p>L1 data caches are typically 8-way with 64-byte lines, L2 caches 8 to 16-way, last-level caches 12 to 16-way. Few designs go fully associative, but small structures
          do: a TLB (page-translation cache) of 32 to 64 entries is often a CAM, since a lookup there has to be both fast and conflict-free.</p>`,
      },
    },
    {
      title: 'A CPU that waits for memory',
      body: `
        <p>The single-cycle CPU with <span data-show="dm">this cache as its data memory</span>: <span data-show="isLoad">a load</span>, decoded from ResultSrc
        (the control field that selects the value written back), raises <code>re</code>, and a miss holds <span data-show="pc">the PC</span> and the
        <span data-show="rwg">register write</span> (<code>retire</code> = 0) until the line arrives. The instruction-set simulator steps only when an instruction retires, so it still checks every one.
        The cache costs about 10 000 NANDs of tag and data arrays, and the clock period does not change (103).</p>
        <p>An honest caveat: the "slow" main memory here is flip-flops too; its latency is modelled by the 4 wait cycles on a load miss only.
        A store writes it in its own cycle, so here write-through never stalls. A real memory cannot take a word every cycle: a write-through
        cache puts a <strong>write buffer</strong> in front of it (a few queued address / data pairs, drained when the bus is free, checked by
        loads that might want a queued word), and stalls only when the buffer is full. Bandwidth, not latency, is then the limit.</p>
        <p>Nothing else in the CPU knows about the cache. The stall is a single wire, <code>retire</code> low, and it does the work of freezing the PC and suppressing the register
        write; the instruction is simply executed again in the next cycle, with the same operands, until the data is there. That is the cheapest way to add variable latency to a
        single-cycle design, and it shows the price plainly: the CPU does nothing for eight cycles of a miss.</p>
        <div class="try">Run "Sum an array twice": 4 misses in the first pass, none in the second. Then try "Two arrays, one set".</div>`,
      scene: () => cpuScene({ source: csrc('reuse'), dcache: true, adder: 'ks', highlight: ['dm'] }),
      tour: {
        beats: [
          { title: 'Filling the array', reset: true, cycles: 16, show: ['pc'], expect: { retire: 1, pcOut: 0x10 },
            say: '<p>The first loop stores 16 words. Write-through with no allocate means a store never waits: retire stays {v:retire} on every cycle, and the PC, now at {v:pcOut}, advances each time.</p>' },
          { title: 'The first load misses', cycles: 37, show: ['dm', 'isLoad'], expect: { pcOut: 0x20, retire: 0, dhit: 0 },
            say: '<p>After 53 cycles the first <code>lw</code>, at address 0x20, reaches the cache. Nothing is in it: retire = {v:retire}, and the PC stays at {v:pcOut} while the line is fetched.</p>' },
          { title: 'Stalled', cycles: 4, show: ['pc', 'rwg'], expect: { pcOut: 0x20, retire: 0 },
            say: '<p>Four cycles later nothing has moved: the PC holds, the register write is suppressed (retire = {v:retire}), and the cache is still counting.</p>' },
          { title: 'The line arrives', cycles: 4, show: ['dm'], expect: { pcOut: 0x20, retire: 1, dhit: 1 },
            say: '<p>Eight cycles after the miss, the line is in and the load completes: dhit = {v:dhit}, retire = {v:retire}. The same instruction, at the same PC, finally retires.</p>' },
          { title: 'Three more words, free', cycles: 16, show: ['dm'], expect: { pcOut: 0x20, retire: 0, dhit: 0 },
            say: '<p>The next three loads (4, 8 and 12 bytes along) hit in the same line with no stall. The fifth load, 16 bytes along, crosses into the next line and misses again: retire = {v:retire}.</p>' },
        ],
      },
      more: {
        derive: `<p>Cycles = instructions + miss penalty × misses. For this program 188 instructions and 4 misses of 8 cycles: 188 + 32 = 220 cycles, CPI = 220 / 188 =
          ${(220 / 188).toFixed(2)}. The hit rate is 28 of 32 loads, ${pct(28 / 32)}. A longer penalty or a lower hit rate moves CPI by their product: a 100-cycle miss at the same
          rate would give CPI ${(1 + (4 * 100) / 188).toFixed(1)}. That is the argument for a second level of cache, and for continuing to execute around a miss.</p>`,
        pitfall: `<p>Counting only the stall. When retire is low the clock still ticks and the golden model does not step: the lock-step check compares the hardware with the model
          only on cycles where an instruction retires. A stall is a cycle, not an instruction, and it is what raises CPI above 1.</p>`,
        real: `<p>A real core hides most L1 misses: out-of-order execution keeps working on later instructions, and a non-blocking cache tracks several outstanding misses at once. A miss to DRAM still
          stops dependent work for a couple of hundred cycles, which is why prefetchers and large L2 and L3 caches exist.</p>`,
      },
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
        the only up-to-date copy. That is <span data-ahead="coherence">the coherence problem (several copies of one address disagreeing)</span> of <a href="#/c/multicore/0">chapter ${numOf('multicore')}</a> in its simplest form.</p>
        <div class="try">Run "Update an array in place": 48 stores, every one a hit, because each follows a load of the same word; the first pass's loads miss 4 times and bring the lines in. Open <span data-show="dm.ram"><code>dm</code> → <code>ram</code></span>: main memory is still all zero.</div>`,
      scene: () => cpuScene({ source: csrc('inplace'), dcache: 'wb', adder: 'ks', highlight: ['dm'] }),
      more: {
        derive: `<p>Write-through sends one word to memory per store; write-back sends a line (4 words) per dirty eviction. If a line is stored to n times between fill and eviction, the
          traffic is n words against 4, so write-back wins once n &gt; 4 and loses when a line is dirtied once (a streaming store: 4 words out for 1 changed). In "Update an array in place" every
          word is stored 3 times, so each line takes 12 stores and writes back 4 words: 48 words of write-through traffic become 16. The dirty bit costs one flip-flop a line; the
          miss penalty rises from 8 to 12 cycles when the victim is dirty.</p>`,
        pitfall: `<p>Forgetting that memory is stale. With write-back the cache holds the only current copy of a dirty line, so anything else that reads memory (a second core, a device that copies memory by itself, a
          debugger's memory view) sees old data unless it asks the cache. The panel's memory view overlays the dirty lines for this reason; open <code>dm.ram</code> and compare.</p>`,
        real: `<p>Almost every cache from L2 outward is write-back, and most L1s. A write-through L1 is used where simplicity or error handling matters (its lines are never the only copy, so parity
          is enough), with a write buffer in front of the next level. Multicore parts add a protocol that keeps the copies consistent, so that the dirty copy in one core's cache is found when another asks.</p>`,
      },
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
        load misses. A <span data-show="dm"><strong>2-way set-associative</strong> cache</span> of the same size has half as many sets, but each holds two lines: the line of a and the line of b in use now sit side by side. Both ways are compared at once (the 2-way tag compare of a few steps back), and
        <span data-show="dm.lru">one <strong>LRU</strong> bit per set</span>,
        set on every hit to point at the other way, names the way to evict next.</p>
        <p>Measured: 33 misses with the direct-mapped write-back cache one step back (32 loads and the final store, which allocates its line),
        32 with the write-through cache two steps back (its store miss fetches nothing), 9 with two ways; the run takes less than half the
        write-back one's cycles.</p>
        <div class="try">Run "Two arrays, one set" here, then compare with the direct-mapped CPUs one and two steps back.</div>`,
      scene: () => cpuScene({ source: csrc('pingpong'), dcache: 'wb2', adder: 'ks', highlight: ['dm'] }),
      more: {
        derive: `<p>The cache holds 4 lines of 16 bytes (64 bytes in all); b sits exactly 64 bytes above a. In the direct-mapped cache a[i] and b[i] have the same index, so with the loop
          loading a[i] then b[i], every load evicts the line the other will need next: 32 loads, 32 misses. With two ways each set keeps one line of a and one of b. Only the first touch of
          each line misses: 4 lines of a and 4 of b, and the final store's allocation: 9. Cycles drop with the misses: every miss is 8 cycles (12 if the victim is dirty), so 33 − 9 = ${33 - 9} fewer
          misses save at least ${(33 - 9) * 8} cycles.</p>`,
        pitfall: `<p>Reading "9 misses" as the cache working perfectly. All nine are compulsory (first touches of 4 lines of a, 4 of b and the result's line) and no associativity removes them; what the second way removed are the conflict misses. Give the program a third
          array in the same set and two ways thrash again, as the 2-way line of the explorer does for vector add.</p>`,
        real: `<p>LRU for two ways is one bit a set; for 8 ways exact LRU needs many bits and a reordering network on every hit, so real designs use tree pseudo-LRU (w − 1 bits) or random replacement,
          which loses little against LRU on most programs.</p>`,
      },
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
      deep: true,
      body: `
        <p>Fetch needs a cache as much as loads do, and an <strong>instruction cache</strong> is simpler: nothing is ever written, so no dirty
        bits and no write-back. Here <span data-show="imem">8 lines of 4 instructions</span> sit in front of
        <span data-show="imem.rom">the instruction ROM</span>, which now plays the slow memory. Every fetch
        is an access; a miss stalls 8 cycles. While it does, the instruction on the bus is not valid, so its store or load is held back too.</p>
        <p>A loop that fits misses once per line and then always hits: the run takes exactly one cycle per instruction plus 8 per line.
        Real cores split the two caches (a Harvard L1) so that a fetch and a load never compete.</p>`,
      scene: () => cpuScene({ source: csrc('inplace'), icache: true, adder: 'ks', highlight: ['imem'] }),
      more: {
        derive: `<p>Instruction fetch is the most local access there is: the next address is the previous plus 4, except at a taken branch. With 4-instruction lines, a straight run misses 1 fetch in 4 at
          most, and a loop that fits misses only on its first pass. Total cycles = instructions + 8 × (lines touched). This program has 11 instructions, which need ${Math.ceil(11 / 4)} lines of 4:
          ${Math.ceil(11 / 4)} × 8 = ${8 * Math.ceil(11 / 4)} cycles added to the run.</p>`,
        pitfall: `<p>Letting a miss fetch garbage into the pipeline. While the line arrives the instruction on the bus is not the one at the PC; the CPU must treat it as a bubble
          (here retire is held low and the store or load behind it is blocked). Executing it would be a wrong-path instruction with side effects.</p>`,
        real: `<p>Split L1 instruction and data caches are universal (separate instruction and data caches at L1, one unified memory from L2 down), usually 32 KB each. Instruction caches also feed a decoded-instruction
          cache or loop buffer on wide cores, and are prefetched sequentially: the next line is requested before the current one is finished.</p>`,
      },
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
        a table of pending results to stop an instruction that needs the missing data.</p>
        <p>A bug worth knowing: our first version let flushed bubbles reach the cache. A bubble's fields are not all zero, and one of them looked
        like a load, so it caused real misses that cost time but not correctness. The co-simulation passed; the miss count did not match the
        single-cycle CPU's. The fix is <span data-show="ldV">one AND gate</span>: only a <em>valid</em> instruction in M may access the cache.</p>
        <p>Measured with the 2-way write-back cache, "Two arrays, one set" runs 101 instructions in 207 cycles, 72 of them frozen (9 misses);
        with the direct-mapped write-through cache, 391 cycles, 256 frozen.</p>
        <div class="try">Run it and watch the pipeline diagram: during a miss every row repeats.</div>`,
      scene: () => cpuScene({ source: csrc('pingpong'), pipeline: true, dcache: 'wb2', adder: 'ks', highlight: ['dm'] }),
      more: {
        derive: `<p>With the whole pipeline frozen, cycles = instructions + frozen cycles + whatever else the pipeline loses. "Two arrays, one set": 101 instructions in 207 cycles, 72 of them frozen by 9
          misses (${72 / 9} cycles each): 101 + 72 = ${101 + 72}, and the other ${207 - 101 - 72} cycles are the pipeline filling and the bubbles after branches. With the direct-mapped write-through cache, 256
          frozen cycles from 32 misses: ${256 / 32} each.</p>`,
        pitfall: `<p>Letting a flushed bubble reach the cache. Its fields are leftovers, one of them can look like a load, and it causes a real miss that costs cycles without changing a result, so the
          co-simulation still passes. The cure is the AND with the valid bit; the symptom is a miss count above the single-cycle CPU's on the same program.</p>`,
        real: `<p>Non-blocking caches track outstanding misses in miss-status holding registers: a second miss to a line already being fetched merges with the first, and misses to different lines
          overlap. An in-order core with this stalls only when an instruction needs the missing register; an out-of-order one keeps executing independent instructions.</p>`,
      },
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
        explain: 'An in-order pipeline moves as a whole: if M holds, E must hold or overwrite it, and so on back to the PC. With a non-blocking cache even an in-order core avoids this: the missing load leaves M with its register marked pending, and the pipeline stalls only when an instruction uses that register (stall on use). Out-of-order cores go further: other instructions continue around a missing load (a load queue, many outstanding misses).',
      },
    },
    {
      title: 'Average memory access time',
      body: `
        <p>AMAT = hit time + miss rate × miss penalty. A modern core: an L1 hit in 4 cycles, 5 % misses, and an L2 behind it that hits in 12
        cycles but itself misses 20 % of the time to DRAM at 250.</p>
        <p>Latency is one cost; bandwidth is the other. A write-through cache sends every store down a level, a write-back cache only each dirty
        line once, when it is evicted. That is why write-back dominates from L2 outward (and in most L1s): with several cores sharing one
        memory bus, bandwidth is the scarce resource.</p>
        <p>Two more choices shape a real hierarchy. <strong>Inclusive</strong> levels keep a copy of everything above them in the level below
        (a request from another core that misses in L3 need not ask this core's L1), at the price of duplicated capacity; <strong>exclusive</strong> levels hold each line in one
        place only, so L2 + L3 capacity adds up, at the price of moving lines both ways on every miss. And <strong>prefetching</strong> fetches
        lines before they are asked for: a next-line or stride prefetcher spots a sequential sweep (the row-major sum, "Vector add") and turns
        its compulsory misses into hits, at the cost of bandwidth and, when it guesses wrong, of lines it evicts for nothing.</p>
        <p>Weigh the terms of the example: of its ${amat([[4, 0.05], [12, 0.2]], 250).toFixed(1)} cycles on average, the L1 hit accounts for 4, the L2 for ${(0.05 * 12).toFixed(1)}
        and DRAM for ${(0.05 * 0.2 * 250).toFixed(1)}. The slowest level adds only that much although it costs 250 cycles per access, because two caches stand between it and the processor; it is still the term that
        grows fastest when a miss rate worsens.</p>`,
      more: {
        derive: `<p>Local miss rates multiply on the way down. The fraction of all accesses that reach DRAM is 0.05 × 0.2 = ${pct(0.05 * 0.2)}, and each costs 250 cycles: 2.5 cycles an access
          on average. AMAT = L1 hit + m<sub>1</sub> (L2 hit + m<sub>2</sub> × DRAM) = 4 + 0.05 × (12 + 0.2 × 250) = ${amat([[4, 0.05], [12, 0.2]], 250).toFixed(1)}. Leave out L2 and it is
          4 + 0.05 × 250 = ${amat([[4, 0.05]], 250).toFixed(1)}: the second level is worth ${(amat([[4, 0.05]], 250) - amat([[4, 0.05], [12, 0.2]], 250)).toFixed(1)} cycles on every access.</p>`,
        numbers: `<table class="mini"><tr><th>L1 miss rate</th><th>L2 local miss rate</th><th>AMAT, cycles</th></tr>
          ${[[0.05, 0.2], [0.025, 0.2], [0.05, 0.1], [0.1, 0.2]].map(([m1, m2]) => `<tr><td>${+(m1 * 100).toFixed(1)} %</td><td>${+(m2 * 100).toFixed(1)} %</td><td>${amat([[4, m1], [12, m2]], 250).toFixed(1)}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Using a global miss rate where a local one is meant. "L2 misses 1 % of all accesses" and "L2 misses 20 % of the accesses it sees" describe the same cache; plug the wrong one into the
          formula and the answer is off by the L1 miss rate. The quiz's 20 % is local, and 5 % × 20 % = 1 % is the global rate to DRAM.</p>`,
        real: `<p>One more term hides in the L1 hit time: address translation. The site's CPUs use physical addresses only. An operating system gives every program its own <strong>virtual</strong> address space:
        memory is split into <strong>pages</strong> (4 KB), and a <strong>page table</strong> in memory maps each virtual page to a physical one,
        with permission bits (read, write, execute, user). RISC-V's Sv32 walks a two-level table; a missing or forbidden page traps (a page fault)
        and the OS fixes it, possibly loading the page from disk. Walking the table on every access would multiply memory traffic, so a
        <strong>TLB</strong> caches recent translations: a small, often fully associative cache of page-table entries, 32 to 64 in an L1 TLB.</p>
        <p>Translation sits on the path of every load. L1 caches overlap the two: they are <strong>virtually indexed, physically tagged</strong>.
        The index and offset come from the low 12 bits, which translation does not change, so the set is read while the TLB translates the upper
        bits, and the tag compare uses the physical page number. That caps an L1 at page size × ways: 4 KB × 8 ways = 32 KB, which is why so
        many L1 data caches are exactly 32 KB, 8-way.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'L1: 4-cycle hit, 5 % miss rate. L2: 12-cycle hit, 20 % local miss rate. DRAM: 250 cycles. What is the AMAT?',
        options: ['4.6 cycles', '7.1 cycles', '16.5 cycles', '266 cycles'], answer: 1,
        why: ['That charges an L1 miss only the L2 hit time, and forgets the 20 % of L2 accesses that go on to DRAM.', '', 'That sends every L1 miss straight to DRAM, as if there were no L2.', 'That adds the three latencies, as if every access went all the way to DRAM.'],
        explain: 'L2 AMAT = 12 + 0.2 × 250 = 62. L1 AMAT = 4 + 0.05 × 62 = 7.1 cycles. The DRAM latency of 250 cycles is diluted by two levels of hits to under twice the L1 hit time.',
      },
    },
  ],
};
