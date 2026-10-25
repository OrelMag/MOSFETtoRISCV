import { cardBootTime } from '../bus/cardboot';
import { BOOT_SOURCE, CARD_BOOT_SOURCE, CARD_FEED, LOAD_AT, LOAD_WORDS, SYSTEM_WORDS } from '../bus/programs';
import { deckWords } from '../cards/card';
import { FLASH_TIMES } from '../flash/model';
import { AXI_CARDS, AXI_KEYS, AXI_PORT, axiBus, axiDram, DMA_ENGINE, busMemUnit } from '../lib/axi';
import { CARD_DECK, SOC_SCREEN } from '../lib/soc';
import { assemble } from '../riscv/asm';
import { ramLeafState } from '../lib/bigmem';
import { findNode } from '../sim/flatten';
import { stats } from '../sim/stats';
import { netlistOf } from '../sim/types';
import type { Stage } from '../view/stage';
import { BENCH_IMAGE, busBenchActions, busBenchScene, busBenchState, busComputerActions, busComputerScene, busComputerState, cardComputerScene, systemComputerScene } from '../widgets/bus';
import type { Chapter } from './types';

const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands.toLocaleString('en-US').replace(/,/g, ' ');

/** The card boot, from the golden model (bus/cardboot.ts, pinned against the gates): with the reader's feed, and without. */
const CARD_BOOT = cardBootTime(deckWords(CARD_DECK), CARD_FEED), CARD_BOOT_0 = cardBootTime(deckWords(CARD_DECK), 0);
const CARD_BOOT_WORDS = assemble(CARD_BOOT_SOURCE).words.length;

/** The DMA engine's share in flip-flops (registers and single DFFs), from its instances. */
const DMA_REG_PCT = Math.round((100 * (netlistOf(DMA_ENGINE)?.instances ?? [])
  .filter((i) => /^(reg\d+|dff)$/.test(i.def.id)).reduce((s, i) => s + stats(i.def).nands, 0)) / stats(DMA_ENGINE).nands);

/** A RAM word of the bench's RAM (byte lanes). */
function ramWord(st: Stage, a: number): number {
  const sim = st.sim;
  if (!sim) return -1;
  const lanes = [0, 1, 2, 3].map((i) => ramLeafState(sim, findNode(sim.design.root, ['ram', `lane${i}`]) ?? undefined));
  if (!lanes.every(Boolean)) return -1;
  const i = a >>> 2;
  return (lanes[0]!.mem[i] | (lanes[1]!.mem[i] << 8) | (lanes[2]!.mem[i] << 16) | (lanes[3]!.mem[i] << 24)) >>> 0;
}

export const chBus: Chapter = {
  id: 'bus', num: 38, title: 'Buses and DMA', level: 'Memory in depth',
  blurb: 'A valid / ready handshake, five channels and an address decoder, two masters and an arbiter, a DMA engine that copies while the CPU runs, a computer that boots from flash into RAM, or from a deck of punched cards, and one with a DRAM, a screen and a keyboard on the same bus: every part in gates.',
  goals: [
    'say on which edge a valid / ready transfer happens, and why the sender may not wait for ready',
    'count the cycles of a bus read or write, with wait states and a slow slave',
    'explain what the arbiter grants, and what one transaction at a time costs when a slave is slow',
    'program a DMA engine, and boot a computer from flash or cards into RAM',
  ],
  builds: ['io', 'multicore', 'flash'],
  recap: {
    keep: [
      'A transfer happens at the rising edge where <strong>valid</strong> and <strong>ready</strong> are both 1. The sender raises valid without waiting for ready; either side may stretch the wait.',
      'AXI-lite shape: a write uses AW, W and B, a read AR and R, each with its own handshake. Even a ready slave costs 2 cycles an access; with 3 wait states a store takes 5. Full AXI adds bursts (one address, up to 256 beats) and IDs (several transactions in flight, answered out of order).',
      `The interconnect is an arbiter (round robin), the multiplexers that route the granted master to the addressed slave, and a decoder on the top four address bits: ${nands(axiBus(2, [0, 1, 4, 15]))} NANDs for two masters and four slaves. The grant holds until the response, so a slow slave stalls the other master too.`,
      `A DMA engine is four registers at 0x4000_0000 and a read-then-write state machine: ${nands(DMA_ENGINE)} NANDs. Two bus transactions a word, irq when done, and the CPU runs meanwhile. Behind a write-back cache, clean before a DMA reads memory, invalidate before the CPU reads what a DMA wrote, fence before the kick (or snoop the DMA).`,
      `Booting: a small ROM fetches the program from storage into RAM at 0x${LOAD_AT.toString(16)} and jumps there: ${LOAD_WORDS} words from flash by DMA, or ${CARD_DECK.cards.length} punched cards polled from a reader.`,
    ],
    practise: ['m_bus', 'm_dma', 'p_boot'],
    check: [
      {
        question: 'A sender raises valid in cycle 1; the receiver raises ready in cycle 3. When does the transfer happen?',
        options: ['At the rising edge that ends cycle 3, the first where both are 1', 'At the edge that ends cycle 1: valid is enough', 'The moment ready rises, inside cycle 3', 'Never: the sender must drop valid and try again'],
        answer: 0,
        explain: 'Both signals are sampled at the rising edge, and the transfer is the edge where both are 1. Meanwhile the sender holds valid and its data steady.',
        why: ['', 'Valid only says the data is there. Without ready the receiver may not be able to take it.', 'Nothing on the bus happens between edges: the handshake is synchronous, sampled at the rising edge.', 'Once raised, valid stays up until the transfer. Dropping it would let a polite pair miss each other for ever.'],
      },
      {
        question: 'The DMA engine is waiting for a page read from the flash. The CPU wants a word of RAM, which is idle. What happens on this interconnect?',
        options: [
          'The CPU waits: the grant stays with the DMA until the flash answers',
          'The arbiter takes the bus from the DMA, round robin',
          'The CPU reaches RAM at the same time, through another path',
          'The CPU\'s read is dropped and must be retried',
        ],
        answer: 0,
        explain: `One transaction at a time: the grant is held until that transaction's response, here up to a ${FLASH_TIMES.read}-cycle page read. Split transactions or a crossbar would let the CPU through.`,
        why: ['', 'Round robin decides who goes next, between transactions. It never takes the bus back in the middle of one.', 'That is a crossbar. This interconnect has one path, shared by both masters.', 'The CPU\'s valid simply stays up: a handshake never loses a request, it only waits.'],
      },
      {
        question: 'The CPU sets up the DMA engine with four stores and lets it copy 16 words from RAM to RAM. How many bus transactions in all?',
        options: ['36', '32', '20', '16'],
        answer: 0,
        explain: 'Four register writes from the CPU, then a read and a write for every word: 4 + 2 × 16 = 36. (Clearing the interrupt afterwards is one more store.)',
        why: ['', 'That is the copy alone. The four setup stores go over the bus too: the DMA\'s registers are a slave at 0x4000_0000.', 'That counts one transaction a word. The DMA reads each word into a register, then writes it: two.', 'That is one per word, and no setup. Each word is a read and a write.'],
      },
      {
        question: 'Give the CPU a write-back data cache. It fills a buffer with stores, then starts the DMA to copy the buffer to a device. The device receives old data. What was missing?',
        options: [
          'Cleaning the buffer\'s dirty lines to RAM (and a fence) before the store that starts the DMA',
          'Invalidating the buffer\'s lines after the DMA finishes',
          'A wait state on the DMA\'s reads',
          'Nothing: the arbiter orders the CPU\'s stores before the DMA\'s reads',
        ],
        answer: 0,
        explain: 'The new data sat in dirty lines; the DMA reads RAM, which still held the old. Before a transfer out of memory the driver writes the lines back (clean) and fences, so the data is in RAM before the MMIO store that kicks the engine. Before a transfer into memory it invalidates instead, so the CPU does not read a stale line. A coherent interconnect snoops the DMA\'s accesses and makes both automatic.',
        why: ['', 'Invalidation is for the other direction: after a DMA writes RAM, so the CPU drops its stale copies. Here the stale copy is in RAM, and invalidating would throw the new data away.', 'Timing is not the problem: however slowly the DMA reads, RAM holds the old words until the cache writes them back.', 'The arbiter orders bus transactions. Stores that hit in a write-back cache never reach the bus until their lines are evicted or cleaned.'],
      },
    ],
  },
  steps: [
    {
      title: 'A handshake',
      body: `
        <p>Until now the CPU's memory answered in the same cycle. A real chip has one memory port and many things behind it, some fast,
        some slow, some busy. A <strong>bus</strong> lets them talk without knowing each other's timing: the sender holds
        <strong>valid</strong> with its data, the receiver raises <strong>ready</strong> when it can take it, and the transfer happens on
        the rising edge where both are 1. Either side may wait; the sender may not wait for ready before raising valid, or two
        polite parties would wait for ever.</p>
        <p>A load is an address (one handshake), then data coming back (another). A slave answers the cycle after the address at
        the earliest, so even the fastest memory now costs <strong>two cycles</strong> an access. The CPU's side is a small state
        machine, <span data-show="cpu">the master port</span>: ${nands(AXI_PORT)} NANDs.</p>
        <div class="try">Here a request port stands in for the CPU. Read <span data-show="ram">RAM</span>, then <span data-show="flash">the flash</span>. The panel shows every cycle: R for a read
        address raised, W for a write, ✓ for the answer, and who holds the bus.</div>`,
      scene: () => busBenchScene(),
      challenge: {
        kind: 'reach', goal: 'Read a word from RAM, then one from the flash, and compare what each cost.',
        check: (st) => { const t = busBenchState(st)?.txns ?? []; return t.some((x) => x.op === 'read' && x.addr < 0x10000000) && t.some((x) => x.op === 'read' && x.addr >>> 28 === 1); },
        hints: [
          'The address picks the slave: the decoder looks only at its top four bits.',
          'RAM answers at 0x0…, the flash at 0x1…. Watch the ✓: the flash\'s first word has a page to read before it can answer.',
        ],
        answer: `RAM: 2 cycles (address, then data). The flash: ${FLASH_TIMES.read + 2} cycles for a word whose page is not in its buffer (a page read into the buffer first), 3 for the next word of the same page.`,
        solve: (st) => { const a = busBenchActions(st); a?.access(false, 0x40); a?.access(false, 0x10000000); st.refresh(); },
      },
    },
    {
      title: 'Five channels',
      body: `
        <p>The bus here has the shape of AXI-lite, the register-access subset of ARM's AXI (one word per transaction, no IDs): five
        channels, each with its own valid and ready. A write uses three: the address (AW), the data (W) and the response (B). A read
        uses two: the address (AR) and the data (R). Our masters raise AW and W together and our slaves take them together, which AXI
        allows. The main data paths of ARM SoCs use full AXI, and many RISC-V SoCs TileLink or AXI: both add bursts and several
        transactions in flight; ours keeps one.</p>
        <details class="deeper"><summary>Deeper: bursts and IDs</summary>
        <p>Full AXI sends one address for a <strong>burst</strong> of up to 256 data beats (AxLEN): INCR steps the address, WRAP wraps
        it inside a line so a cache fill can start at the word the CPU is waiting for, FIXED repeats it for a FIFO. One handshake on AR
        then buys a whole line on R. Each transaction also carries an <strong>ID</strong> (AxID): responses with the same ID come back in
        order, responses with different IDs in any order, so a master can keep many reads in flight and a fast slave need not wait for
        a slow one. The interconnect extends the IDs with the master's number to route the answers back. W has kept no ID since AXI4:
        write data follows the order of its addresses. Each extra field is wires on the channels and state in every slave: AXI-lite
        drops them for registers that move one word at a time.</p></details>
        <p>The <span data-show="bus.dec"><strong>address decoder</strong></span> looks at the top four address bits: 0x0… is RAM, 0x1… the flash, 0x4… the DMA engine's
        registers. Any other address goes to a <span data-show="def">default slave</span> that answers 0, so a stray pointer never hangs the bus (AXI would
        answer with an error and the CPU would trap). A slow slave just holds back valid: <span data-show="ram">this RAM</span> has 3 <strong>wait states</strong>.</p>`,
      scene: () => busBenchScene(3),
      challenge: {
        kind: 'quiz',
        question: 'A store to this RAM, with its 3 wait states: how many cycles from the CPU raising AW and W to the answer?',
        options: ['2', '3', '5', '8'],
        answer: 2,
        why: [
          'That is the RAM without wait states: the address and data taken in one cycle, the answer in the next.',
          'That counts the wait states but not the cycle in which the RAM takes the address and data, nor the answer.',
          '',
          'AW and W are taken together in the first cycle, then the 3 wait states hold back B once. The channels do not each wait.',
        ],
        explain: 'The address and data are taken in the first cycle (the slave is idle and ready), then 3 wait states, then B in the fifth. Without wait states it would be 2.',
      },
    },
    {
      title: 'Two masters',
      body: `
        <p>A <span data-show="dma">DMA engine</span> is a second <strong>master</strong>: it starts transactions of its own. Two masters, one bus: the interconnect's
        <span data-show="bus.grant"><strong>arbiter</strong></span> (<a href="#/c/multicore/0">chapter 27</a>'s round-robin arbiter) grants the bus to one requester, and the grant is held until
        that transaction's response: one transaction at a time. The other master's valid stays up meanwhile; it simply waits.</p>
        <p><span data-show="bus">The interconnect</span> is the arbiter, the multiplexers that route the granted master's signals to the addressed slave and the
        slave's answer back, and the decoder: ${nands(axiBus(2, [0, 1, 4, 15]))} NANDs for two masters and four slaves.
        Bigger systems use a crossbar, where several pairs talk at once.</p>
        <p>One transaction at a time has a price: while the DMA waits for the flash's page read, it holds the bus, and the CPU waits
        too, for a RAM that is idle. Real interconnects split a transaction (the address phase frees the bus) or let several be in
        flight, so that a slow slave delays only those who use it.</p>
        <div class="try">Start the DMA copy, Clock 10, then Read: the CPU's R waits while the bus belongs to the DMA.</div>`,
      scene: () => busBenchScene(),
      challenge: {
        kind: 'reach', goal: 'Start the DMA copy, then make a read that has to wait for the bus.',
        check: (st) => { const t = busBenchState(st)?.txns ?? []; const go = t.findIndex((x) => x.op === 'write' && x.addr === 0x4000000c); return go >= 0 && t.slice(go + 1).some((x) => x.op === 'read' && x.cycles > 2); },
        hints: [
          'The bus serves one transaction at a time, and the grant stays with its master until the response.',
          'Give the DMA a few clocks to start its first flash read before the CPU asks: that read holds the bus for a whole page read.',
        ],
        answer: 'DMA: flash → RAM starts a copy of 16 words (four register writes); Clock 10 lets the DMA take the bus for its first read. A read now waits: the DMA holds the bus until the flash answers, a page read of 64 cycles. Afterwards the arbiter alternates between the two masters.',
        solve: (st) => { const a = busBenchActions(st); a?.dmaCopy(0x10000000, 0x100, 16); st.runCycles(3); a?.access(false, 0x40); st.refresh(); },
      },
    },
    {
      title: 'DMA',
      body: `
        <p>Copying a block with the CPU costs a load and a store per word, and the CPU does nothing else. A <span data-show="dma"><strong>DMA engine</strong></span>
        does it on its own: four registers (source, destination, length, control) written by the CPU as ordinary stores to 0x4000_0000,
        then a state machine that reads a word, writes it, steps both addresses and counts down. When the count reaches 0 it raises
        <span data-show="pin:irq"><strong>irq</strong></span>, the CPU's external interrupt, until the CPU clears it. ${nands(DMA_ENGINE)} NANDs, ${DMA_REG_PCT} % of them flip-flops: source,
        destination, the 16-bit length, the word in flight, the read-back word, the state and the slave's two response flags. Most of the rest steps the addresses and
        multiplexes the registers.</p>
        <p>It costs bus time: two transactions a word, and every one the CPU wants meanwhile waits for the bus. Its gain is that the CPU
        keeps running, and that a slow source (the flash's ${FLASH_TIMES.read}-cycle page reads) delays the DMA, not the program.</p>
        <details class="deeper"><summary>Deeper: DMA and the caches</summary>
        <p>The CPU here has no data cache, so RAM is the only copy. Put a write-back cache (<a href="#/c/cache/0">chapter 22</a>) in front of it
        and the DMA, which talks to RAM directly, sees two problems. Copying <em>out</em> of a buffer the CPU just wrote, it reads RAM
        while the new data still sits in dirty cache lines: the driver must <strong>clean</strong> (write back) those lines first.
        Copying <em>in</em>, it writes RAM under lines the cache still holds: the driver must <strong>invalidate</strong> them, or the
        CPU reads the stale copy. Embedded systems do this in software around every transfer; bigger systems make the DMA's accesses
        <strong>coherent</strong>, snooping them against the caches as a second core's would be (<a href="#/c/multicore/0">chapter 27</a>).
        Either way, the stores that fill the buffer must reach memory before the store that starts the engine: on a CPU that
        reorders memory accesses, a <strong>fence</strong> goes before that MMIO kick.</p></details>
        <div class="try">Copy, run until the interrupt, and watch RAM from 0x100 fill with the flash's words (0xF1A5_00nn).</div>`,
      scene: () => busBenchScene(),
      challenge: {
        kind: 'reach', goal: 'Have the DMA copy 16 words from the flash to RAM 0x100, and wait for its interrupt.',
        check: (st) => ramWord(st, 0x100) === BENCH_IMAGE[0] && ramWord(st, 0x13c) === BENCH_IMAGE[15],
        hints: [
          'The DMA engine is set up with four stores: source, destination, length, and last the control register that starts it.',
          `After the setup it needs clocks, and more than 16 × 2: the first word alone waits ${FLASH_TIMES.read} cycles for the flash's page read.`,
        ],
        answer: 'DMA: flash → RAM writes source 0x1000_0000, destination 0x100, length 16 and 1 to control; Run until irq clocks until the copy is done. The first word waits for a page read, the other fifteen come from the page buffer.',
        solve: (st) => { const a = busBenchActions(st); a?.dmaCopy(0x10000000, 0x100, 16); a?.runUntilIrq(); st.refresh(); },
      },
    },
    {
      title: 'A computer on one bus',
      body: `
        <p>The system <span data-show="cpu">CPU</span> of chapters <a href="#/c/io/0">19</a> and <a href="#/c/traps/0">20</a>, its memory moved onto the bus. In place of its data memory sits a
        <span data-show="cpu.dm">memory unit</span> (${nands(busMemUnit(7))} NANDs): instructions below 0x200 come from a boot ROM inside the CPU, any other address is fetched over the
        bus into an instruction register, and loads and stores go over the bus. The CPU waits (retire = 0) until both are done, and
        the decoder sees a NOP while an instruction is on its way. Console, LEDs and timer stay inside.</p>
        <p>At power-up the boot ROM programs <span data-show="dma">the DMA</span> to copy ${LOAD_WORDS} words from <span data-show="flash">the flash</span> to <span data-show="ram">RAM</span> at 0x${LOAD_AT.toString(16)}, waits for it, and
        jumps there. Every computer boots like this: a small ROM that knows how to fetch the real program from storage.</p>
        <pre class="code">${BOOT_SOURCE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
        <div class="try">Run, and watch the PC move from the boot ROM into RAM, the console print, and the LEDs count.</div>`,
      scene: () => busComputerScene(),
      tries: [(st) => (busComputerState(st)?.booted ?? -1) >= 0],
      challenge: {
        kind: 'quiz',
        question: 'The loaded program runs from RAM. Why does each of its instructions take at least two cycles, where the boot ROM\'s took one?',
        options: ['Each is fetched over the bus: an address handshake, then the data', 'RAM is slower than ROM by nature', 'The DMA is still copying', 'The decoder needs a cycle for the NOP'],
        answer: 0,
        why: [
          '',
          'The RAM answers as soon as the bus lets it. The second cycle is the handshake: the address one cycle, the word the next.',
          'The boot ROM waits for the DMA to finish before it jumps into RAM: the copy is over.',
          'The NOP is what the decoder sees while the word is on its way: a consequence of the wait, not its cause.',
        ],
        explain: 'An instruction from RAM is a bus read like any load: the address one cycle, the word the next. A load or store from RAM code costs two more. Caches (<a href="#/c/cache/0">chapter 22</a>) are what lets a real CPU fetch at full speed from slow memory.',
      },
    },
    {
      title: 'Booting from cards',
      body: `
        <p>Before flash, the program came on <strong>punched cards</strong>. The IBM 1401's <strong>Load</strong> key was a loader in
        hardware: it read one card into memory locations 1–80 and branched to location 1. That first card held a few instructions that
        read the next cards, which read the rest: the program pulled itself up by its bootstraps, hence <em>booting</em>.</p>
        <p>Here a <span data-show="cards">card reader</span> stands in for the flash, at 0x7000_0000, the deck in its hopper (one word a card, punched in binary along
        row 9). +0 is STATUS (bit 0: a card waits at the read station, bit 1: the hopper is empty), +4 is DATA, and reading DATA
        <em>takes</em> the card, as reading the keyboard takes a key: <span data-show="cardport">the slave</span> pulses <code>next</code> (feed the next card) in the cycle after the read's
        handshake. ${nands(AXI_CARDS)} NANDs, nearly all of them its 32-bit read register and the status / data multiplexer. The reader brings
        the next card to the station ${CARD_FEED} edges later. A real reader took about 75 ms a card (800 a minute): millions of cycles of this
        CPU, which would simply poll longer.</p>
        <p>The boot ROM is ${CARD_BOOT_WORDS} instructions: poll STATUS, and while the hopper is not empty take each word and store it from
        0x${LOAD_AT.toString(16)} upward; when the deck is done, jump there.</p>
        <pre class="code">${CARD_BOOT_SOURCE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
        <p>The deck is ${CARD_DECK.cards.length} cards; the jump to 0x${LOAD_AT.toString(16)} comes at cycle ${CARD_BOOT.cycles},
        ${(CARD_BOOT.cycles / CARD_DECK.cards.length).toFixed(1)} a card. With no feed delay the loop alone would take
        ${(CARD_BOOT_0.cycles / CARD_DECK.cards.length).toFixed(1)} (three of its nine instructions go over the bus); the rest is
        ${CARD_BOOT.idlePolls} polls that found the station empty.</p>
        <details class="deeper"><summary>Deeper: sequence numbers</summary>
        <p>Each card also carries a <strong>sequence number</strong> in columns 73–80 (10, 20, 30, …, so that a card can be slipped in
        between). A dropped deck is not lost: a card sorter, one column a pass, puts it back in order. The loader cannot tell: an unsorted
        deck loads, and runs as nonsense.</p></details>
        <div class="try">Run, and watch the reader work through the deck while the PC stays in the boot ROM; then the PC jumps into RAM
        and the program from the cards prints and counts.</div>`,
      scene: () => cardComputerScene(),
      challenge: {
        kind: 'reach', goal: 'Boot the computer from the deck: run until the program on the cards prints.',
        check: (st) => (busComputerState(st)?.console ?? '').includes('CARDS'),
        hints: [
          'The boot ROM does all the work. The computer only needs clocks, and patience.',
          `Reading the deck takes ${CARD_BOOT.cycles} cycles before the program from the cards starts: keep it running past that.`,
        ],
        answer: `Run (or Run to output). The boot ROM reads the ${CARD_DECK.cards.length} cards into RAM at 0x${LOAD_AT.toString(16)}, waiting for the feed between them; at cycle ${CARD_BOOT.cycles} the hopper is empty and it jumps there, and the program prints CARDS, then counts on the LEDs.`,
        solve: (st) => { busComputerActions(st)?.run(4000, () => (busComputerState(st)?.console ?? '').endsWith('\n')); },
      },
    },
    {
      title: 'Everything on one bus',
      body: `
        <p>Three more slaves, and the computer has what a small system on a chip has. At 0x2000_0000, the <span data-show="dram"><strong>DRAM</strong></span> of
        <a href="#/c/memctrl/0">chapter 36</a> behind its controller and a bus adapter (adapter and controller:
        ${nands(axiDram())} NANDs). A load costs 10 cycles on an open row, 14 on a closed bank, 18 when another row is open, more
        behind a refresh, against 2 for the on-chip RAM: the code stays in RAM, and this is the gap the caches of <a href="#/c/cache/0">chapter 22</a> close.</p>
        <details class="deeper"><summary>Deeper: the adapter and the data mask</summary>
        <p>The bus moves a word with byte strobes; the controller moves 4-word lines. An adapter
        joins them: a load reads its word's line and keeps one word; a store writes the line with the DRAM's <strong>data mask</strong>
        (DDR's DM pins) set on every byte except its own strobed ones, so the DRAM leaves the rest of the line alone and even a byte
        store needs no read first.</p></details>
        <p>At 0x5000_0000, a <span data-show="screen"><strong>screen</strong></span>: a ${SOC_SCREEN} × ${SOC_SCREEN} frame buffer, a byte a pixel (RGB332), built like the RAM in four
        byte lanes so that sb draws one pixel; a display reads it as <a href="#/c/pixels/0">chapter 33</a>'s scan-out reads its frame. At 0x6000_0000, a
        <span data-show="keys kbd"><strong>keyboard</strong></span>: +4 says whether a key waits, and reading +0 <em>takes</em> it (the slave pulses ack, the acknowledge that drops the key, in the cycle after the read's
        handshake, ${nands(AXI_KEYS)} NANDs). A read with a side effect: such a register must never sit behind a cache, nor be read
        twice by a CPU that guesses ahead.</p>
        <p>The boot ROM now copies ${SYSTEM_WORDS} words from the flash. The program waits for a key, prints it, appends it to a line kept in
        DRAM and paints an 8 × 8 block of its colour on the screen; Enter prints the line back from DRAM, last key first.</p>
        <div class="try">Run, then type into the keyboard field (or Type hello⏎). Watch the blocks appear, Enter read the line back,
        and the DRAM counters: the line's words sit in one row, so after the first access nearly all are row hits.</div>`,
      scene: () => systemComputerScene(),
      challenge: {
        kind: 'reach', goal: 'Type a line, and have the computer print it back from DRAM.',
        check: (st) => /[^>\n]+\n[^>\n]+\n>/.test(busComputerState(st)?.console ?? ''),
        hints: [
          'The program echoes each key and keeps it in DRAM. The line comes back only once it is finished.',
          'Keys go in through the keyboard field while the computer runs; a line ends with Enter.',
        ],
        answer: 'Type a few keys and Enter (Type hello⏎ does it): each key is echoed, stored in DRAM and drawn; Enter makes the program read the words back from DRAM, last first, so hello comes back as olleh.',
        solve: (st) => { const a = busComputerActions(st); a?.type('hi\n'); a?.run(20000, () => /ih\n>/.test(busComputerState(st)?.console ?? '')); },
      },
    },
  ],
};

