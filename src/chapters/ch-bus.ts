import { groupDigits } from '../sim/numfmt';
import { cardBootTime } from '../bus/cardboot';
import { BOOT_SOURCE, CARD_BOOT_SOURCE, CARD_FEED, LOAD_AT, LOAD_WORDS, SYSTEM_WORDS } from '../bus/programs';
import { deckWords } from '../cards/card';
import { accessCycles, CLOCK_NS, TIMING } from '../dram/timing';
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
import { numOf } from './order';

const nands = (d: Parameters<typeof stats>[0]) => groupDigits(stats(d).nands);

const fmtCycles = (ns: number) => groupDigits(Math.round(ns / CLOCK_NS));

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
  id: 'bus', num: numOf('bus'), title: 'Buses and DMA', level: 'Memory in depth',
  blurb: 'A valid / ready handshake, five channels and an address decoder, two masters and an arbiter, a DMA engine that copies while the CPU runs, a computer that boots from flash into RAM, or from a deck of punched cards, and one with a DRAM, a screen and a keyboard on the same bus: every part in gates.',
  goals: [
    'say on which edge a valid / ready transfer happens, and why the sender may not wait for ready',
    'count the cycles of a bus read or write, with wait states and a slow slave',
    'explain what the arbiter grants, and what one transaction at a time costs when a slave is slow',
    'program a DMA engine, and boot a computer from flash or cards into RAM',
  ],
  builds: ['io', 'cache', 'multicore', 'memctrl', 'flash'],
  recap: {
    keep: [
      'A transfer happens at the rising edge where <strong>valid</strong> and <strong>ready</strong> are both 1. The sender raises valid without waiting for ready; either side may stretch the wait.',
      'AXI-lite shape: a write uses AW, W and B, a read AR and R, each with its own handshake. Even a ready slave costs 2 cycles an access; with 3 wait states a store takes 5. Full AXI adds bursts (one address, up to 256 beats) and IDs (several transactions in flight, answered out of order).',
      `The interconnect is an arbiter (round robin), the multiplexers that route the granted master to the addressed slave, and a decoder on the top four address bits: ${nands(axiBus(2, [0, 1, 4, 15]))} NANDs for two masters and four slaves. The grant holds until the response, so a slow slave stalls the other master too.`,
      `A DMA engine is four registers at 0x4000_0000 and a read-then-write state machine: ${nands(DMA_ENGINE)} NANDs. Two bus transactions a word, irq when done, and the CPU runs meanwhile. Behind a write-back cache, clean before a DMA reads memory, invalidate before a DMA writes memory (and again after, if the CPU prefetches), fence before the kick (or snoop the DMA).`,
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
        explain: 'The new data sat in dirty lines; the DMA reads RAM, which still held the old. Before a transfer out of memory the driver writes the lines back (clean) and fences, so the data is in RAM before the MMIO store that kicks the engine. Before a transfer into memory the driver invalidates the buffer\'s lines, so no dirty line can later be evicted over the incoming data; after it, on a CPU that speculates or prefetches, it invalidates again, so the CPU does not read a line refilled meanwhile. A coherent interconnect snoops the DMA\'s accesses and makes both automatic.',
        why: ['', 'Invalidating is for the other direction, a DMA writing RAM. Here the stale copy is in RAM, and invalidating would throw the new data away.', 'Timing is not the problem: however slowly the DMA reads, RAM holds the old words until the cache writes them back.', 'The arbiter orders bus transactions. Stores that hit in a write-back cache never reach the bus until their lines are evicted or cleaned.'],
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
        <p>Why two wires and not one. With only valid, a sender could not tell whether the receiver had taken the data; with only ready, a receiver could not tell
        whether the data on the wires was meant for it. Each side states its own condition and nothing else, so neither needs to know the other's speed, and a slave
        can take one cycle or a thousand without the master changing. The price is a state machine at each end and a cycle of latency the old combinational memory did not have.</p>
        <div class="try">Here a request port stands in for the CPU. Read <span data-show="ram">RAM</span>, then <span data-show="flash">the flash</span>. The panel shows every cycle: R for a read
        address raised, W for a write, ✓ for the answer, and who holds the bus.</div>`,
      tour: {
        beats: [
          { title: 'RAM: the short way', reset: true, say: 'The port raises a read of 0x40. The decoder sees a top nibble of 0, the RAM is idle and takes the address at once, and the word comes back on the next edge: <code>done</code> = {v:done}, <code>rdata</code> = {v:rdata}. (The panel counts the request\'s own cycle too: 2.)', set: { req: 1, we: 0, addr: 0x40 }, cycles: 1, at: [], show: ['ram'], expect: { done: 1, rdata: 0 } },
          { title: 'Let go', say: 'The port drops <code>req</code>; <code>done</code> falls ({v:done}) and the bus is free.', set: { req: 0 }, cycles: 1, expect: { done: 0 } },
          { title: 'Flash: it has to look', say: `Address 0x1000_0000 goes to the flash. Its page buffer is empty, so the slave starts a page read and holds ready back. Ten clocks later <code>done</code> is still {v:done}.`, set: { req: 1, addr: 0x10000000 }, cycles: 10, show: ['flash'], expect: { done: 0 } },
          { title: 'The page arrives', say: `After ${FLASH_TIMES.read + 1} clocks in all the word comes back: <code>rdata</code> = {v:rdata}, the first word of the image. The page read is the whole cost; the handshake itself added the same two cycles as for RAM.`, cycles: FLASH_TIMES.read + 1 - 10, show: ['flash'], expect: { done: 1, rdata: BENCH_IMAGE[0] >>> 0 } },
          { title: 'Let go', say: 'Released again; the page now sits in the flash\'s buffer.', set: { req: 0 }, cycles: 1, expect: { done: 0 } },
          { title: 'The next word is cheap', say: 'The next word, 0x1000_0004, is in the buffer already: <code>rdata</code> = {v:rdata} after only 2 clocks (3 on the panel\'s count).', set: { req: 1, addr: 0x10000004 }, cycles: 2, show: ['flash'], expect: { done: 1, rdata: BENCH_IMAGE[1] >>> 0 } },
        ],
      },
      more: {
        derive: `<p>The rule fixes the timing: a transfer occurs at every rising edge where valid and ready are both 1, and a sender that has raised valid must hold it, with its data steady, until that edge.
          A read is two such transfers (address, then data), and a slave cannot answer in the cycle of the address because it has only just seen it, so the floor is two cycles.
          RAM: 2. The flash's first word: ${FLASH_TIMES.read} cycles of page read plus the 2 of the handshake = ${FLASH_TIMES.read + 2}. A later word of the same page: 3.</p>`,
        real: `<p>AXI's rules are the same in spirit: valid must not wait for ready, ready may wait for valid, and once valid is up it stays up with stable payload. APB, AHB, Wishbone, TileLink and AXI differ
          in channels, bursts and pipelining, not in this idea. Most CPUs reach their memory over such a bus; the flash here stands for anything that answers slowly, from a page of NAND to a peripheral over a bridge.</p>`,
        pitfall: `<p>Making valid depend on ready. If the sender waits to see ready before raising valid, and the receiver waits to see valid before raising ready, both wait for ever. The
          bench's port raises <code>req</code> and holds it until <code>done</code>, however long the flash takes.</p>`,
        numbers: `<table class="mini"><tr><th>access</th><th>cycles</th></tr>
          <tr><td>RAM, any word</td><td>2</td></tr>
          <tr><td>flash, first word of a page</td><td>${FLASH_TIMES.read + 2}</td></tr>
          <tr><td>flash, next word of the page</td><td>3</td></tr></table>`,
      },
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
        <p>The <span data-show="bus.dec"><strong>address decoder</strong></span> looks at the top four address bits: 0x0… is RAM, 0x1… the flash, 0x4… the DMA engine's
        registers. Any other address goes to a <span data-show="def">default slave</span> that answers 0, so a stray pointer never hangs the bus (AXI would
        answer with an error and the CPU would trap). A slow slave just holds back valid: on this step's bench <span data-show="ram">the RAM</span> is set to 3 <strong>wait states</strong>, so it answers 3 cycles late (the other steps' RAM has none: 2 cycles an access).</p>
        <p>Splitting the channels is what lets a bus be both simple and general. The address can be accepted while the data is still being found, a write's response is
        its own message (so the master learns that the store has landed, not just left), and each channel can be pipelined separately in a larger design. The cost is five
        handshakes' worth of wires and state per port; AXI-lite keeps them but drops bursts and IDs, which is why a register file hangs off it for a few gates.</p>`,
      tour: {
        beats: [
          { title: 'A store with wait states', reset: true, say: 'A store of 0xABCD to 0x100. AW and W go out together and the slave takes both in the first cycle. <code>done</code> (B) is {v:done}: the RAM now spends its 3 wait states.', set: { req: 1, we: 1, addr: 0x100, wdata: 0xabcd }, cycles: 1, at: [], show: ['ram'], expect: { done: 0 } },
          { title: 'The response', say: 'Three more clocks and B arrives: <code>done</code> = {v:done}. The panel counts 5 cycles for the store: the one that raises and hands over the address and data, the 3 wait states, and the answer.', cycles: 3, expect: { done: 1 } },
          { title: 'Let go', say: 'The port drops <code>req</code> and <code>we</code>.', set: { req: 0, we: 0 }, cycles: 1, expect: { done: 0 } },
          { title: 'A read pays too', say: 'The same word read back: wait states are the slave\'s, not the write\'s. After 4 clocks <code>rdata</code> = {v:rdata}.', set: { req: 1, addr: 0x100 }, cycles: 4, show: ['ram'], expect: { done: 1, rdata: 0xabcd } },
          { title: 'A stray pointer', say: 'Release. The next request is a read of 0x7000_0000, an address no slave decodes.', set: { req: 0 }, cycles: 1, expect: { done: 0 } },
          { title: 'Default slave answers', say: 'It answers after one clock, with zeros: <code>done</code> = {v:done}, <code>rdata</code> = {v:rdata}.', set: { req: 1, addr: 0x70000000 }, cycles: 1, show: ['bus', 'def'], expect: { done: 1, rdata: 0 } },
        ],
      },
      more: {
        derive: `<p>With w wait states a store costs 2 + w cycles on the panel's count: one for the address and data, w of waiting, one for the response. For w = 3 that is 5, which a quiz asks. Over a
          sequence of n independent accesses the bus does n·(2 + w) cycles because only one transaction is in flight. A burst of n words amortizes the address and the wait over the data beats; idealized,
          a slave with w wait states returns n words in about 1 + w + n cycles instead of n·(2 + w).</p>`,
        real: `<p>Full AXI sends one address for a <strong>burst</strong> of up to 256 data beats (AxLEN): INCR steps the address, WRAP wraps
          it inside a line so a cache fill can start at the word the CPU is waiting for, FIXED repeats it for a FIFO. One handshake on AR
          then buys a whole line on R. Each transaction also carries an <strong>ID</strong> (AxID): responses with the same ID come back in
          order, responses with different IDs in any order, so a master can keep many reads in flight and a fast slave need not wait for
          a slow one. The interconnect extends the IDs with the master's number to route the answers back. W has kept no ID since AXI4:
          write data follows the order of its addresses. Each extra field is wires on the channels and state in every slave: AXI-lite
          drops them for registers that move one word at a time.</p>`,
        pitfall: `<p>Treating the decoder's default as free error handling. An address that decodes to nothing returns 0 here and the CPU carries on with the wrong value. Real systems return a bus error and
          take a trap (the access-fault exceptions of the privileged ISA), because a silent zero turns a wild pointer into a quiet wrong answer.</p>`,
        numbers: `<table class="mini"><tr><th>wait states</th><th>store (cycles)</th><th>8 stores in a row</th></tr>
          ${[0, 1, 3, 7].map((w) => `<tr><td>${w}</td><td>${2 + w}</td><td>${8 * (2 + w)}</td></tr>`).join('')}</table>`,
      },
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
        <p>A <span data-show="dma">DMA engine</span> (direct memory access: hardware that copies blocks of memory without the CPU, built in the next step) is a second <strong>master</strong>: it starts transactions of its own. Two masters, one bus: the interconnect's
        <span data-show="bus.grant"><strong>arbiter</strong></span> (<a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>'s round-robin arbiter) grants the bus to one requester, and the grant is held until
        that transaction's response: one transaction at a time. The other master's valid stays up meanwhile; it simply waits.</p>
        <p><span data-show="bus">The interconnect</span> is the arbiter, the multiplexers that route the granted master's signals to the addressed slave and the
        slave's answer back, and the decoder: ${nands(axiBus(2, [0, 1, 4, 15]))} NANDs for two masters and four slaves.
        Bigger systems use a crossbar, where several pairs talk at once.</p>
        <p>One transaction at a time has a price: while the DMA waits for the flash's page read, it holds the bus, and the CPU waits
        too, for a RAM that is idle. Real interconnects split a transaction (the address phase frees the bus) or let several be in
        flight, so that a slow slave delays only those who use it.</p>
        <p>The arbiter decides who goes next, not how long they take. Round robin is fair between requesters that are ready at the same time, and it guarantees that
        neither master is starved; what it cannot do is shorten a transaction already granted. The longest wait one master can suffer is therefore the other's longest transaction, here
        a flash page read, and a real-time deadline has to be met against that number, not against the average.</p>
        <div class="try">Start the DMA copy, Clock 10, then Read: the CPU's R waits while the bus belongs to the DMA.</div>`,
      more: {
        derive: `<p>The worst-case wait for a CPU access is one complete DMA transaction: ${FLASH_TIMES.read + 2} cycles for a flash word whose page is not yet buffered, 3 for a later word, 2 for a RAM write. After it the
          grant passes to the CPU if it is requesting, because round robin moves the pointer past the master just served. So a CPU and a DMA both busy alternate, one transaction each, and the CPU
          gets at least every second slot.</p>`,
        real: `<p>Interconnects cut this wait in three ways. A <strong>crossbar</strong> gives each slave its own arbiter, so a CPU talking to RAM does not wait for a DMA talking to flash. <strong>Split transactions</strong>
          release the bus after the address and give it back for the data. <strong>Several transactions in flight</strong> (AXI IDs) let the master issue the next before the last returns.
          Quality-of-service bits let a display controller or a core outrank a bulk copy.</p>`,
        pitfall: `<p>Reading "round robin" as "the arbiter takes the bus back". It chooses between transactions only. In the scene the DMA's flash read is granted, and the CPU's valid stays up for the
          full page read behind it; only the next grant can go the other way.</p>`,
      },
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
        keeps running between the DMA's transactions instead of spending its own loads and stores on the copy. On this one-transaction bus a slow source (the flash's ${FLASH_TIMES.read}-cycle page reads) still stalls a CPU that needs the bus meanwhile; a crossbar or split transactions would remove that.</p>
        <p>The engine is a bus master with almost no logic of its own: it has no program, no decoder and no ALU beyond an address incrementer and a down counter. That is why it is cheap, and why
        it is the first thing a system adds after a CPU. The software side of the bargain is a protocol: write the registers, start it, then either poll the status or take the interrupt, and never touch the
        buffer in between.</p>
        <div class="try">Copy, run until the interrupt, and watch RAM from 0x100 fill with the flash's words (0xF1A5_00nn).</div>`,
      more: {
        derive: `<p>A copy of n words is 4 setup stores plus a read and a write per word: 4 + 2n transactions, all but the four on the DMA's own account. By the CPU, a copy costs a load and a store per word,
          each at least 2 bus cycles, plus the loop's instructions, and nothing else runs. The DMA's wall-clock time is longer than the sum of its transactions, because the first flash word adds the
          page read and the engine does one transaction at a time; the point is that the CPU is free during it.</p>`,
        real: `<p>The CPU here has no data cache, so RAM is the only copy. Put a write-back cache (<a href="#/c/cache/0">chapter ${numOf('cache')}</a>) in front of it
          and the DMA, which talks to RAM directly, sees two problems. Copying <em>out</em> of a buffer the CPU just wrote, it reads RAM
          while the new data still sits in dirty cache lines: the driver must <strong>clean</strong> (write back) those lines first.
          Copying <em>in</em>, it writes RAM under lines the cache still holds: the driver must <strong>invalidate</strong> them before the transfer, so no dirty line is later evicted over the incoming data, and again after it on a CPU that speculates or prefetches, so the CPU does not read a refilled stale line. Embedded systems do this in software around every transfer; bigger systems make the DMA's accesses
          <strong>coherent</strong>, snooping them against the caches as a second core's would be (<a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>).
          Either way, the stores that fill the buffer must reach memory before the store that starts the engine: on a CPU that
          reorders memory accesses, a <strong>fence</strong> goes before that MMIO kick.</p>`,
        pitfall: `<p>Starting the engine before the data is in memory, or reading the destination before the interrupt. Both look right in a quick test, because the copy is fast, and fail only under load. In the
          scene, RAM fills word by word while the copy runs; <code>irq</code>, or the done bit in the status register, is what says the last one has landed.</p>`,
        numbers: `<table class="mini"><tr><th>words</th><th>bus transactions</th></tr>
          ${[4, 16, 64, 256].map((n) => `<tr><td>${n}</td><td>${4 + 2 * n}</td></tr>`).join('')}</table>`,
      },
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
        <p>The system <span data-show="cpu">CPU</span> of chapters <a href="#/c/io/0">${numOf('io')}</a> and <a href="#/c/traps/0">${numOf('traps')}</a>, its memory moved onto the bus. In place of its data memory sits a
        <span data-show="cpu.dm">memory unit</span> (${nands(busMemUnit(7))} NANDs): instructions below 0x200 come from a boot ROM inside the CPU, any other address is fetched over the
        bus into an instruction register, and loads and stores go over the bus. The CPU waits (retire = 0) until both are done, and
        the decoder sees a NOP while an instruction is on its way. Console, LEDs and timer stay inside.</p>
        <p>At power-up the boot ROM programs <span data-show="dma">the DMA</span> to copy ${LOAD_WORDS} words from <span data-show="flash">the flash</span> to <span data-show="ram">RAM</span> at 0x${LOAD_AT.toString(16)}, waits for it, and
        jumps there. Most larger computers boot like this: a small ROM that knows how to fetch the real program from storage. (A microcontroller often skips the copy and runs straight from NOR flash.)</p>
        <pre class="code">${BOOT_SOURCE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
        <p>The design choice worth noticing is that the CPU did not change. Its decode, registers and ALU are chapter ${numOf('io')}'s; only the place the words come from moved, and the
        memory unit absorbs the difference by stalling the CPU (<code>retire</code> low, no state written) until the bus answers. That is the general trick of a system on a chip: keep the core unaware of
        what is behind its port, and put every piece of timing in the port.</p>
        <div class="try">Run, and watch the PC move from the boot ROM into RAM, the console print, and the LEDs count.</div>`,
      more: {
        derive: `<p>Cycles per instruction from RAM, no wait states: an instruction costs 2 for its fetch (address, word) and a third in which it executes; a load or store does its access in that cycle and the next, so 3 for an ALU instruction or a branch and 4 for a load or store.
          In the boot ROM the word arrives in the same cycle: 1 and 2. ALU code runs at about a third of the speed it had from the ROM,
          which is the factor a cache exists to win back.</p>`,
        real: `<p>Every machine has this ladder. A mask ROM in the SoC (the "boot ROM") is the only code that is there at power-up; it initializes just enough (clocks, a memory controller, a storage controller),
          loads the next stage from flash or a card, and often checks its signature before jumping. The chain continues (a first-stage loader, a second stage that trains the DRAM, then an operating-system loader), and each
          stage is larger and slower to fetch than the one that loaded it.</p>`,
        pitfall: `<p>Reading <code>retire</code> = 0 as a hang. The CPU is waiting for the bus, and in the scene it waits every instruction that runs from RAM. A real hang is a PC that stops
          changing with retire stuck low: a slave that never raises ready, which is why bus fabrics include time-outs.</p>`,
        numbers: `<table class="mini"><tr><th>instruction</th><th>boot ROM</th><th>from RAM</th></tr>
          <tr><td>ALU, branch</td><td>1</td><td>3</td></tr><tr><td>load, store</td><td>2</td><td>4</td></tr></table>`,
      },
      scene: () => busComputerScene(),
      tries: [(st) => (busComputerState(st)?.booted ?? -1) >= 0],
      challenge: {
        kind: 'quiz',
        question: 'The loaded program runs from RAM. Why does each of its instructions take at least three cycles, where the boot ROM\'s took one?',
        options: ['Each is fetched over the bus: an address handshake, then the data', 'RAM is slower than ROM by nature', 'The DMA is still copying', 'The decoder needs a cycle for the NOP'],
        answer: 0,
        why: [
          '',
          'The RAM answers as soon as the bus lets it. The extra cycles are the handshake: the address one cycle, the word the next.',
          'The boot ROM waits for the DMA to finish before it jumps into RAM: the copy is over.',
          'The NOP is what the decoder sees while the word is on its way: a consequence of the wait, not its cause.',
        ],
        explain: `An instruction from RAM is a bus read like any load: the address one cycle, the word the next, then the cycle that executes it. A load or store from RAM code costs one more. Caches (<a href="#/c/cache/0">chapter ${numOf('cache')}</a>) are what lets a real CPU fetch at full speed from slow memory.`,
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
        the next card to the station ${CARD_FEED} edges later.</p>
        <p>The boot ROM is ${CARD_BOOT_WORDS} instructions: poll STATUS, and while the hopper is not empty take each word and store it from
        0x${LOAD_AT.toString(16)} upward; when the deck is done, jump there.</p>
        <pre class="code">${CARD_BOOT_SOURCE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
        <p>The deck is ${CARD_DECK.cards.length} cards; the jump to 0x${LOAD_AT.toString(16)} comes at cycle ${CARD_BOOT.cycles},
        ${(CARD_BOOT.cycles / CARD_DECK.cards.length).toFixed(1)} a card, against ${(CARD_BOOT_0.cycles / CARD_DECK.cards.length).toFixed(1)} with no feed delay: the rest is
        ${CARD_BOOT.idlePolls} polls that found the station empty. A real reader took about 75 ms a card (800 a minute), millions of cycles of this CPU, which would simply poll longer.</p>
        <p>The point is the dependency chain: the loader must be in a memory that needs no loading, so the first thing a machine runs is always something
        built into it. Here that is the boot ROM; on the 1401 it was the Load key's hard-wired sequence.</p>
        <div class="try">Run, and watch the reader work through the deck while the PC stays in the boot ROM; then the PC jumps into RAM
        and the program from the cards prints and counts.</div>`,
      more: {
        derive: `<p>The loop reads STATUS (a bus load), tests the hopper bit, reads DATA (a second load, which takes the card), stores the word (a bus store) and loops: of its nine instructions three go over the bus, so with no feed delay
          it takes ${(CARD_BOOT_0.cycles / CARD_DECK.cards.length).toFixed(1)} cycles a card. The reader needs ${CARD_FEED} edges to present the next card, so the loop polls until it does; ${CARD_DECK.cards.length} cards in
          ${CARD_BOOT.cycles} cycles is ${(CARD_BOOT.cycles / CARD_DECK.cards.length).toFixed(1)} a card, and the difference is the ${CARD_BOOT.idlePolls} idle polls. A real reader at about 75 ms a card is ${fmtCycles(75e6)} of
          these cycles a card, so the same program would spend almost all of its time polling.</p>`,
        real: `<p>The 1401 and its relatives booted from cards, tape or disk the same way: a button that loads the first record into fixed locations and starts there. Modern machines add layers: a mask ROM, then a
          flash-resident first stage, then the operating system's loader. Whatever is first is read-only or hard-wired, because nothing else can be trusted to exist yet. Bootstrapping is also the origin of the word "reboot".</p>`,
        pitfall: `<p>Each card also carries a <strong>sequence number</strong> in columns 73–80 (10, 20, 30, …, so that a card can be slipped in
          between). A dropped deck is not lost: a card sorter, one column a pass, puts it back in order on those numbers. The loader never looks at them: it reads cards in the order they sit in the hopper, so a deck restacked by hand loads, and runs as nonsense. That is the usual way a boot fails.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>cycles / card</th></tr>
          <tr><td>loop alone, no feed delay</td><td>${(CARD_BOOT_0.cycles / CARD_DECK.cards.length).toFixed(1)}</td></tr>
          <tr><td>with the reader's ${CARD_FEED}-edge feed</td><td>${(CARD_BOOT.cycles / CARD_DECK.cards.length).toFixed(1)}</td></tr>
          <tr><td>a real reader, 75 ms</td><td>${fmtCycles(75e6)}</td></tr></table>`,
      },
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
        <a href="#/c/memctrl/0">chapter ${numOf('memctrl')}</a> behind its controller and a bus adapter (adapter and controller:
        ${nands(axiDram())} NANDs). A load costs 10 cycles on an open row, 14 on a closed bank, 18 when another row is open, more
        behind a refresh, against 2 for the on-chip RAM: the code stays in RAM, and this is the gap the caches of <a href="#/c/cache/0">chapter ${numOf('cache')}</a> close.</p>
        <p>At 0x5000_0000, a <span data-show="screen"><strong>screen</strong></span>: a ${SOC_SCREEN} × ${SOC_SCREEN} frame buffer, a byte a pixel (RGB332), built like the RAM in four
        byte lanes so that sb draws one pixel; a display reads it as <a href="#/c/pixels/0">chapter ${numOf('pixels')}</a>'s scan-out reads its frame. At 0x6000_0000, a
        <span data-show="keys kbd"><strong>keyboard</strong></span>: +4 says whether a key waits, and reading +0 <em>takes</em> it (the slave pulses ack, the acknowledge that drops the key, in the cycle after the read's
        handshake, ${nands(AXI_KEYS)} NANDs). A read with a side effect: such a register must never sit behind a cache, nor be read
        twice by a CPU that guesses ahead.</p>
        <p>The boot ROM now copies ${SYSTEM_WORDS} words from the flash. The program waits for a key, prints it, appends it to a line kept in
        DRAM and paints an 8 × 8 block of its colour on the screen; Enter prints the line back from DRAM, last key first.</p>
        <p>That is a whole computer, and the end of this level: every part of it runs on one clock, and a word crosses the bus in a few of its cycles. The next level, from <a href="#/c/message/0">Sending a message</a>, takes the wire out of the chip: what it costs to send a bit to another computer across a room or an ocean, where no clock is shared and nothing arrives unchanged.</p>
        <div class="try">Run, then type into the keyboard field (or Type hello⏎). Watch the blocks appear, Enter read the line back,
        and the DRAM counters: the line's words sit in one row, so after the first access nearly all are row hits.</div>`,
      more: {
        derive: `<p>The DRAM figures are the controller's cycles plus the bus's two: a hit ${accessCycles('hit', TIMING)} + 2 = ${accessCycles('hit', TIMING) + 2}, a miss ${accessCycles('miss', TIMING)} + 2 = ${accessCycles('miss', TIMING) + 2}, a conflict
          ${accessCycles('conflict', TIMING)} + 2 = ${accessCycles('conflict', TIMING) + 2}. On-chip RAM costs 2. The screen is the RAM's own structure (four byte lanes) with a different meaning for the addresses: a store to the frame
          buffer is an ordinary store whose side effect is a pixel. The keyboard is a read port: a handshake and a read register in front of the key queue.</p>`,
        real: `<p>The bus moves a word with byte strobes (one write-enable bit per byte); the controller moves 4-word lines. An adapter
          joins them: a load reads its word's line and keeps one word; a store writes the line with the DRAM's <strong>data mask</strong>
          (DDR's DM pins) set on every byte except its own strobed ones, so the DRAM leaves the rest of the line alone and even a byte
          store needs no read first. Real SoCs add the same kinds of slave and more (interrupt controllers, UARTs, SPI, a display engine), each behind a register block like these.</p>`,
        pitfall: `<p>Side effects behind caches and speculation. Reading the keyboard's +0 takes the key. A cache that fetches the line, a prefetcher that reads ahead, or a debugger that dumps
          memory all lose keys. Device registers are mapped uncached and non-speculative for this reason, and a driver reads each one exactly as often as it means to.</p>`,
        numbers: `<table class="mini"><tr><th>slave</th><th>address</th><th>load (cycles)</th></tr>
          <tr><td>on-chip RAM</td><td>0x0…</td><td>2</td></tr><tr><td>flash, buffered word</td><td>0x1…</td><td>3</td></tr>
          <tr><td>DRAM, open row</td><td>0x2…</td><td>${accessCycles('hit', TIMING) + 2}</td></tr><tr><td>DRAM, closed bank</td><td>0x2…</td><td>${accessCycles('miss', TIMING) + 2}</td></tr>
          <tr><td>DRAM, other row open</td><td>0x2…</td><td>${accessCycles('conflict', TIMING) + 2}</td></tr></table>`,
      },
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

