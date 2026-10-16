import { BOOT_SOURCE, LOAD_AT, LOAD_WORDS } from '../bus/programs';
import { FLASH_TIMES } from '../flash/model';
import { AXI_PORT, axiBus, DMA_ENGINE, busMemUnit } from '../lib/axi';
import { ramLeafState } from '../lib/bigmem';
import { findNode } from '../sim/flatten';
import { stats } from '../sim/stats';
import type { Stage } from '../view/stage';
import { BENCH_IMAGE, busBenchActions, busBenchScene, busBenchState, busComputerScene } from '../widgets/bus';
import type { Chapter } from './types';

const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands.toLocaleString('en-US').replace(/,/g, ' ');

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
  id: 'bus', num: 35, title: 'Buses and DMA', level: 'Memory in depth',
  blurb: 'A valid / ready handshake, five channels and an address decoder, two masters and an arbiter, a DMA engine that copies while the CPU runs, and a computer that boots from flash into RAM: every part in gates.',
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
        machine, the master port: ${nands(AXI_PORT)} NANDs.</p>
        <div class="try">Here a request port stands in for the CPU. Read RAM, then the flash. The panel shows every cycle: R for a read
        address raised, W for a write, ✓ for the answer, and who holds the bus.</div>`,
      scene: () => busBenchScene(),
      challenge: {
        kind: 'reach', goal: 'Read a word from RAM, then one from the flash, and compare what each cost.',
        check: (st) => { const t = busBenchState(st)?.txns ?? []; return t.some((x) => x.op === 'read' && x.addr < 0x10000000) && t.some((x) => x.op === 'read' && x.addr >>> 28 === 1); },
        answer: `RAM: 2 cycles (address, then data). The flash: ${FLASH_TIMES.read + 2} cycles for a word whose page is not in its buffer (a page read into the buffer first), 3 for the next word of the same page.`,
        solve: (st) => { const a = busBenchActions(st); a?.access(false, 0x40); a?.access(false, 0x10000000); st.refresh(); },
      },
    },
    {
      title: 'Five channels',
      body: `
        <p>The bus here has the shape of AXI-lite, the on-chip bus of most ARM and RISC-V systems: five channels, each with its own
        valid and ready. A write uses three: the address (AW), the data (W) and the response (B). A read uses two: the address (AR)
        and the data (R). Our masters raise AW and W together and our slaves take them together, which AXI allows. Real systems
        also let a master keep several transactions in flight; ours keeps one.</p>
        <p>The <strong>address decoder</strong> looks at the top four address bits: 0x0… is RAM, 0x1… the flash, 0x4… the DMA engine's
        registers. Any other address goes to a default slave that answers 0, so a stray pointer never hangs the bus (AXI would
        answer with an error and the CPU would trap). A slow slave just holds back valid: this RAM has 3 <strong>wait states</strong>.</p>`,
      scene: () => busBenchScene(3),
      challenge: {
        kind: 'quiz',
        question: 'A store to this RAM, with its 3 wait states: how many cycles from the CPU raising AW and W to the answer?',
        options: ['2', '3', '5', '8'],
        answer: 2,
        explain: 'The address and data are taken in the first cycle (the slave is idle and ready), then 3 wait states, then B in the fifth. Without wait states it would be 2.',
      },
    },
    {
      title: 'Two masters',
      body: `
        <p>A DMA engine is a second <strong>master</strong>: it starts transactions of its own. Two masters, one bus: the interconnect's
        <strong>arbiter</strong> (chapter 24's arbiterN, round robin) grants the bus to one requester, and the grant is held until
        that transaction's response: one transaction at a time. The other master's valid stays up meanwhile; it simply waits.</p>
        <p>The interconnect is the arbiter, the multiplexers that route the granted master's signals to the addressed slave and the
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
        answer: 'DMA: flash → RAM starts a copy of 16 words (four register writes); Clock 10 lets the DMA take the bus for its first read. A read now waits: the DMA holds the bus until the flash answers, a page read of 64 cycles. Afterwards the arbiter alternates between the two masters.',
        solve: (st) => { const a = busBenchActions(st); a?.dmaCopy(0x10000000, 0x100, 16); st.runCycles(3); a?.access(false, 0x40); st.refresh(); },
      },
    },
    {
      title: 'DMA',
      body: `
        <p>Copying a block with the CPU costs a load and a store per word, and the CPU does nothing else. A <strong>DMA engine</strong>
        does it on its own: four registers (source, destination, length, control) written by the CPU as ordinary stores to 0x4000_0000,
        then a state machine that reads a word, writes it, steps both addresses and counts down. When the count reaches 0 it raises
        <strong>irq</strong>, the CPU's external interrupt, until the CPU clears it. ${nands(DMA_ENGINE)} NANDs, two thirds of them in its four
        32-bit registers.</p>
        <p>It costs bus time: two transactions a word, and every one the CPU wants meanwhile waits for the bus. Its gain is that the CPU
        keeps running, and that a slow source (the flash's ${FLASH_TIMES.read}-cycle page reads) delays the DMA, not the program.</p>
        <div class="try">Copy, run until the interrupt, and watch RAM from 0x100 fill with the flash's words (0xF1A5_00nn).</div>`,
      scene: () => busBenchScene(),
      challenge: {
        kind: 'reach', goal: 'Have the DMA copy 16 words from the flash to RAM 0x100, and wait for its interrupt.',
        check: (st) => ramWord(st, 0x100) === BENCH_IMAGE[0] && ramWord(st, 0x13c) === BENCH_IMAGE[15],
        answer: 'DMA: flash → RAM writes source 0x1000_0000, destination 0x100, length 16 and 1 to control; Run until irq clocks until the copy is done. The first word waits for a page read, the other fifteen come from the page buffer.',
        solve: (st) => { const a = busBenchActions(st); a?.dmaCopy(0x10000000, 0x100, 16); a?.runUntilIrq(); st.refresh(); },
      },
    },
    {
      title: 'A computer on one bus',
      body: `
        <p>The system CPU of chapters 18 and 19, its memory moved onto the bus. In place of its data memory sits a memory unit
        (${nands(busMemUnit(7))} NANDs): instructions below 0x200 come from a boot ROM inside the CPU, any other address is fetched over the
        bus into an instruction register, and loads and stores go over the bus. The CPU waits (retire = 0) until both are done, and
        the decoder sees a NOP while an instruction is on its way. Console, LEDs and timer stay inside.</p>
        <p>At power-up the boot ROM programs the DMA to copy ${LOAD_WORDS} words from the flash to RAM at 0x${LOAD_AT.toString(16)}, waits for it, and
        jumps there. Every computer boots like this: a small ROM that knows how to fetch the real program from storage.</p>
        <pre class="code">${BOOT_SOURCE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
        <div class="try">Run, and watch the PC move from the boot ROM into RAM, the console print, and the LEDs count.</div>`,
      scene: () => busComputerScene(),
      challenge: {
        kind: 'quiz',
        question: 'The loaded program runs from RAM. Why does each of its instructions take at least two cycles, where the boot ROM\'s took one?',
        options: ['Each is fetched over the bus: an address handshake, then the data', 'RAM is slower than ROM by nature', 'The DMA is still copying', 'The decoder needs a cycle for the NOP'],
        answer: 0,
        explain: 'An instruction from RAM is a bus read like any load: the address one cycle, the word the next. A load or store from RAM code costs two more. Caches (chapter 21) are what lets a real CPU fetch at full speed from slow memory.',
      },
    },
  ],
};

