import { counter, DFF, DFFE, D_LATCH, ram, register, SR_LATCH } from '../lib';
import { pack } from '../sim/values';
import { memGridPanel } from '../widgets/memgrid';
import { memSizePanel } from '../widgets/memsize';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

/** Value currently stored in word i of a RAM scene. */
function word(st: Stage, i: number): number {
  const n = st.rootCtx?.node.children?.get(`w${i}`);
  return n ? pack(st.rootCtx!.sim.getBits(n.ports.q)) : -1;
}

export const chLatches: Chapter = {
  id: 'latches', num: 8, title: 'Memory from feedback', level: 'Sequential logic',
  blurb: 'Loop a gate\'s output back to its input and it starts to remember.',
  steps: [
    {
      title: 'Two NANDs holding hands',
      body: `
        <p>Every circuit so far was <em>combinational</em>: outputs depend only on the current inputs. Now feed
        outputs back into inputs.</p>
        <p>Two cross-coupled NANDs form an <strong>SR latch</strong>. Its inputs are <em>active-low</em> (the bar over
        the name means "acts when 0"):</p>
        <ul><li>pull <code>s_n</code> to 0 → <strong>set</strong>: q becomes 1</li>
        <li>pull <code>r_n</code> to 0 → <strong>reset</strong>: q becomes 0</li>
        <li>both at 1 → <strong>hold</strong>: q keeps whatever it was. One bit of memory.</li></ul>
        <div class="try">Set the latch (pulse s_n to 0 and back to 1), then notice q stays 1 with both inputs at 1.</div>`,
      scene: () => ({ root: SR_LATCH, inputs: { s_n: 1, r_n: 1 } }),
      challenge: {
        kind: 'reach', goal: 'Store a 1: q = 1 with both inputs back at 1.',
        check: (st) => st.getInput('s_n') === 1 && st.getInput('r_n') === 1 && st.value('q') === 1,
        answer: 'Pulse s_n: set it to 0 (q becomes 1), then back to 1. The latch keeps q = 1.',
        solve: (st) => { st.setInputs({ r_n: 1, s_n: 0 }); st.setInputs({ s_n: 1 }); },
      },
    },
    {
      title: 'The forbidden input, and races',
      body: `
        <p>Pull <em>both</em> inputs low and both outputs go to 1, so q and q̄ are no longer opposites. Worse: release
        both at exactly the same moment and each NAND sees (1, 1), both switch to 0, then both see 0 and switch back…
        In a perfectly symmetric world the latch would oscillate forever.</p>
        <p>Real silicon is never perfectly symmetric. One gate is a hair faster and wins, but you cannot know which.
        This is <strong>metastability</strong>, and it is why designers avoid the forbidden input. The simulator detects
        the race and resolves it the way silicon does: arbitrarily.</p>`,
      scene: () => ({ root: SR_LATCH, inputs: { s_n: 0, r_n: 0 } }),
      actions: [
        { label: 'Release both at once', run: (st) => st.setInputs({ s_n: 1, r_n: 1 }) },
        { label: 'Pull both low', run: (st) => st.setInputs({ s_n: 0, r_n: 0 }) },
      ],
    },
    {
      title: 'The D latch: store what you are told',
      body: `
        <p>Avoid the forbidden input by construction: derive both set and reset from one data input <code>d</code>,
        gated by an enable <code>e</code>.</p>
        <ul><li><code>e = 1</code>: the latch is <strong>transparent</strong>, and q follows d.</li>
        <li><code>e = 0</code>: the latch is <strong>closed</strong>, and q holds the last value.</li></ul>
        <p>The SR latch is inside, as a box. Open it.</p>`,
      scene: () => ({ root: D_LATCH, inputs: { d: 1, e: 1 } }),
      challenge: {
        kind: 'reach', goal: 'Make the latch hold a 1 while d = 0.',
        check: (st) => st.getInput('d') === 0 && st.value('q') === 1,
        answer: 'd = 1 with e = 1 (transparent), then e = 0 (closed), then d = 0. q stays 1.',
        solve: (st) => { st.setInputs({ d: 1, e: 1 }); st.setInputs({ e: 0 }); st.setInputs({ d: 0 }); },
      },
    },
    {
      title: 'The flip-flop: act only on the edge',
      body: `
        <p>A transparent latch is awkward in a big circuit: while it is open, changes race straight through. We want
        a memory that samples its input at one precise instant.</p>
        <p>Chain two D latches with opposite enables: the <strong>master</strong> is open while the clock is low; the
        <strong>slave</strong> while it is high. At the moment the clock rises, the master closes (capturing d)
        and the slave opens (showing it). This is the <strong>edge-triggered D flip-flop</strong>.</p>
        <div class="try">Change d while the clock is low: q does not move. Press <strong>Pulse</strong>: q
        takes d's value at the rising edge. Open the <strong>Timing</strong> panel to see it over time.</div>`,
      scene: () => ({ root: DFF, inputs: { d: 1, clk: 0 } }),
    },
    {
      title: 'Load enable',
      body: `
        <p>Often we want a flip-flop to keep its value on most clock edges and only load a new one sometimes.
        Put a multiplexer in front: when <code>en = 0</code> it feeds q back into d, so the flip-flop reloads its
        own value. When <code>en = 1</code> it lets the new d through.</p>`,
      scene: () => ({ root: DFFE, inputs: { d: 1, en: 0, clk: 0 } }),
    },
  ],
};

export const chRegisters: Chapter = {
  id: 'registers', num: 9, title: 'Registers & counters', level: 'Sequential blocks',
  blurb: 'Store a whole word on every clock edge; count edges.',
  steps: [
    {
      title: 'A register is a row of flip-flops',
      body: `
        <p>Give each bit of a bus its own enable flip-flop, all sharing one clock and one enable, and you have a
        <strong>register</strong>: a word of memory. A processor keeps its working values in registers (RISC-V has 32
        of them).</p>
        <div class="try">Type a value into d, set en = 1, then Pulse. Change d again with en = 0 and Pulse: q keeps the old word.</div>`,
      scene: () => ({ root: register(4), inputs: { d: 0x5, en: 1, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Store 0xA in the register, then change d to something else.',
        check: (st) => st.value('q') === 0xa && st.getInput('d') !== 0xa,
        answer: 'd = 0xA, en = 1, Pulse; then set d to anything else (or en = 0 first).',
        solve: (st) => { st.setInputs({ d: 0xa, en: 1 }); st.pulse(); st.setInputs({ en: 0, d: 0 }); },
      },
    },
    {
      title: 'Wider words',
      body: `
        <p>An 8-bit register is the same picture with eight rows. Look at the cost in the Info tab: every bit of storage
        is 15 NANDs (60 transistors) here. Real memories use cleverer cells, a 6-transistor SRAM cell or even a single
        transistor and a capacitor (DRAM), which we will meet later.</p>`,
      scene: () => ({ root: register(8), inputs: { d: 0x2a, en: 1, clk: 0 } }),
    },
    {
      title: 'A counter',
      body: `
        <p>Feed a register's output through an <strong>incrementer</strong> (a chain of half adders that adds 1) and back into
        its input. Every clock edge, it loads its own value plus one: a <strong>counter</strong>.</p>
        <p>This loop of register → logic → register is the shape of every synchronous circuit, including a
        processor: the program counter is exactly this, plus the ability to jump.</p>
        <div class="try">Press <strong>Run</strong> to clock it continuously, and watch the <strong>Timing</strong> panel.</div>`,
      scene: () => ({ root: counter(4), inputs: { en: 1, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Stop the counter at exactly 9.',
        check: (st) => st.value('q') === 9 && st.getInput('en') === 0,
        answer: 'Pulse until q = 9, then set en = 0 so later clock edges change nothing.',
        solve: (st) => { st.setInputs({ en: 1 }); for (let i = 0; i < 32 && st.value('q') !== 9; i++) st.pulse(); st.setInputs({ en: 0 }); },
      },
    },
  ],
};

export const chMemory: Chapter = {
  id: 'memory', num: 10, title: 'Memory arrays', level: 'Memory',
  blurb: 'Many registers, one address: decoders write, multiplexers read.',
  steps: [
    {
      title: 'Four words, one address',
      body: `
        <p>A memory is a stack of registers plus two pieces of plumbing you already know:</p>
        <ul><li>The <strong>write path</strong>: a decoder with enable turns <code>addr</code> and <code>we</code> (write enable) into one
        word's load-enable. On the clock edge, only that word loads <code>din</code>.</li>
        <li>The <strong>read path</strong>: a multiplexer tree uses <code>addr</code> to pick one word for <code>dout</code>.</li></ul>
        <p>The panel at the bottom right shows every stored bit live.</p>`,
      scene: () => ({ root: ram(2, 4), inputs: { addr: 1, din: 0x9, we: 0, clk: 0 }, panels: [memGridPanel] }),
    },
    {
      title: 'Writing',
      body: `
        <p>To write: set <code>addr</code>, put the value on <code>din</code>, set <code>we = 1</code>, and <strong>Pulse</strong> the clock.
        The addressed row turns orange in the panel: it will be written on the next rising edge.</p>
        <div class="try">Write 0x2 to address 0 and 0x5 to address 3. Open <code>dec</code> while <code>we = 1</code> to see exactly one enable line high.</div>`,
      scene: () => ({ root: ram(2, 4), inputs: { addr: 0, din: 0x2, we: 1, clk: 0 }, panels: [memGridPanel], highlight: ['dec'] }),
      challenge: {
        kind: 'reach', goal: 'Store 0x2 at address 0 and 0x5 at address 3.',
        check: (st) => word(st, 0) === 0x2 && word(st, 3) === 0x5,
        answer: 'addr = 0, din = 0x2, we = 1, Pulse; then addr = 3, din = 0x5, Pulse.',
        solve: (st) => { st.setInputs({ addr: 0, din: 2, we: 1 }); st.pulse(); st.setInputs({ addr: 3, din: 5 }); st.pulse(); st.setInputs({ we: 0 }); },
      },
    },
    {
      title: 'Reading',
      body: `
        <p>Reading needs no clock. Change <code>addr</code> and <code>dout</code> follows immediately (after a few gate
        delays through the multiplexer tree). That is <em>asynchronous</em> read, like the processor's register
        file will use.</p>
        <p>Note that <code>we = 0</code> protects the contents: pulse the clock as often as you like.</p>`,
      scene: () => ({ root: ram(2, 4), inputs: { addr: 2, din: 0, we: 0, clk: 0 }, panels: [memGridPanel], highlight: ['rmux'] }),
    },
    {
      title: 'Scale it up',
      body: `
        <p>The same three parts scale to any size. Pick a size in the panel. The address grows one bit each time
        the number of words doubles, and so does the decoder and the depth of the mux tree.</p>
        <p>Watch the transistor count in the Info tab: a 64 × 16 memory built this way already needs about 80 000
        transistors. That is why real memories use dense custom cells, and why a 16 GB phone
        holds on the order of 10¹¹ transistors in memory alone.</p>`,
      scene: () => ({ root: ram(4, 8), inputs: { addr: 0, din: 0x42, we: 1, clk: 0 }, panels: [memSizePanel, memGridPanel] }),
      challenge: {
        kind: 'reach', goal: 'In a memory with at least 16 words, store 0x2A at address 13.',
        check: (st) => (st.rootCtx?.node.children?.size ?? 0) >= 18 && word(st, 13) === 0x2a,
        answer: 'With 16 words or more: addr = 13, din = 0x2A, we = 1, Pulse.',
        solve: (st) => { st.setInputs({ addr: 13, din: 0x2a, we: 1 }); st.pulse(); },
      },
    },
  ],
};
