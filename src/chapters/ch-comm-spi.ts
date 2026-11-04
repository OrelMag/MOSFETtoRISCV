import { CLOCKS_PER_PHASE, I2C_MODES, I2cController, I2cTarget, WRITE, RISE_30_70, feasible, riseTime, rpMax, rpMin, VOL_MAX, lowCurrent, runBus } from '../comm/i2c';
import { edgeKind, modeNumber, SPI_MODES, SpiMaster } from '../comm/spi';
import { bigRam } from '../lib/bigmem';
import { decoder } from '../lib/combinational';
import { i2cBus, i2cController, i2cTarget, I2C_PAD } from '../lib/i2c';
import { spiDevice, spiMaster } from '../lib/spi';
import { stats } from '../sim/stats';
import { groupDigits } from '../sim/numfmt';
import { i2cArbScene, i2cFrameScene, pullupWidget, wiredScene } from '../widgets/i2c';
import { frameCompareWidget, spiChainWidget, spiModesWidget, spiScene, throughputWidget } from '../widgets/spi';
import type { Chapter } from './types';

const nf = (x: number, d = 2) => x.toFixed(d);
const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;
const thin = (n: number) => groupDigits(Math.round(n));
const hex = (x: number) => `0x${x.toString(16).toUpperCase().padStart(2, '0')}`;

// ---- numbers computed here; the ones typed in the text are pinned by tests/content-spi.test.ts

const N_SPI_MASTER = nands(spiMaster());
const N_SPI_MEM = nands(bigRam(8, 8));
const N_SPI_DEV = nands(spiDevice()) - N_SPI_MEM;
const N_I2C_CTL = nands(i2cController());
const N_I2C_TGT = nands(i2cTarget());
const T_PAD = stats(I2C_PAD).transistors;
const T_BUS = stats(i2cBus(1, [{ adr: 0x50 }])).transistors;

/** System clocks the master model spends on one byte (busy from the start edge). */
export const SPI_BYTE_CLOCKS = ((): number => {
  const m = new SpiMaster();
  const i = { rst: 0, start: 0, hold: 0, cpol: 0, cpha: 0, tx: 0xa5, miso: 0 };
  m.step({ ...i, rst: 1 });
  m.step({ ...i, start: 1 });
  let n = 0;
  while (m.busy) { m.step(i); n++; }
  return n;
})();
/** System clocks of one WRITE command (9 bit cells) on an idle bus. */
export const I2C_BYTE_CLOCKS = ((): number => {
  const c = new I2cController();
  const i = { rst: 0, go: 0, cmd: 0, din: 0, sda_i: 1, scl_i: 1 };
  c.step({ ...i, rst: 1 });
  c.step({ ...i, go: 1, cmd: WRITE, din: 0xff });
  let n = 1;
  while (!c.out.ready) { c.step({ ...i }); n++; }
  return n;
})();
/** Clocks from the first command to the controller's ready after the last, for START, address, pointer, data, STOP against a target. */
export const I2C_FRAME_CLOCKS = ((): number => {
  const c = new I2cController(), t = new I2cTarget();
  const script: [number, number][] = [[0, 0], [1, 0xa0], [1, 1], [1, 0xa7], [3, 0]];
  let k = 0, first = true, clocks = 0, done = 0;
  runBus([
    { step: (sda, scl) => { const rst = first ? 1 : 0; first = false; let g = 0, cmd = 0, din = 0; if (!rst && c.out.ready && k < script.length) { g = 1; [cmd, din] = script[k++]; } c.step({ rst, go: g, cmd, din, sda_i: sda, scl_i: scl }); if (!done && k === script.length && c.out.ready && !rst) done = clocks; clocks++; return c.out; } },
    { step: (sda, scl) => { t.step({ rst: 0, sda_i: sda, scl_i: scl, adr: 0x50, stretch: 0 }); return t.out; } },
  ], 400);
  return done;
})();

/** The first address bit (0 = A6) where two addresses differ, and who loses (the one that sends the 1). */
export const arbitrate = (a: number, b: number): { bit: number; loser: 'A' | 'B' } => {
  for (let j = 0; j < 7; j++) {
    const x = (a >> (6 - j)) & 1, y = (b >> (6 - j)) & 1;
    if (x !== y) return { bit: j, loser: x ? 'A' : 'B' };
  }
  return { bit: -1, loser: 'A' };
};
const ARB_A = 0x50, ARB_B = 0x52, ARB = arbitrate(ARB_A, ARB_B);
const BIT_NAME = (j: number) => `A${6 - j}`;

/** The mode that idles high and samples on the rising edge. */
export const MODE_HI_RISE = SPI_MODES.find((m) => m.cpol === 1 && edgeKind(m, m.cpha === 0 ? 0 : 1).sample && edgeKind(m, m.cpha === 0 ? 0 : 1).rising)!;
const FM = I2C_MODES[1];

export const chSpi: Chapter = {
  id: 'spi', num: 44, title: 'SPI and I²C', level: 'Communication',
  blurb: 'A shared clock, or many devices on two wires: SPI\'s modes, I²C at switch level with open drain, arbitration and clock stretching.',
  goals: [
    'say what a shared clock removes from a link (the start bit, the oscillator match, the sampling guess) and what it adds (a wire, a select per target, skew as the speed limit)',
    'derive which edge samples and which changes the data from CPOL and CPHA, and say what a device in the wrong mode reads',
    'build a wired-AND from open-drain stages and a pull-up, and compute the rise time, the static current and the legal resistor window from the bus capacitance',
    'follow an I²C frame (START, address, ACK, data, repeated START, STOP), clock stretching and arbitration bit by bit on the wires',
  ],
  builds: ['uart', 'clocks'],
  recap: {
    keep: [
      `A shared clock moves the sampling decision from the receiver's guess to the sender's wire. SPI sends SCLK beside the data: a byte is 8 clocks with no start or stop bit, every clock moves one bit each way (a shift register in a ring), and a target needs no oscillator. The costs are a wire for the clock, a chip select per target, and a speed limit set by the skew between SCLK and data, not by oscillator tolerance.`,
      `CPOL is SCLK's idle level and CPHA says whether the first edge samples (0) or changes the data (1). Of the 16 edges of a byte, 8 sample and 8 change; modes 0 and 3 sample on the rising edge, modes 1 and 2 on the falling edge. A device in the wrong mode samples while the line is changing.`,
      `A chip select per target costs a wire each (or a ${stats(decoder(3, true)).nands}-NAND 3-to-8 decoder with enable) and addresses any one of them in one byte; a daisy chain needs one select and 4 wires in all, and every update moves the whole chain's bits.`,
      `Open drain: a pad that can only pull a wire to ground (${T_PAD} transistors with its read-back buffer in this book), and a resistor that pulls it up. The wire is the AND of what the devices say, with no gate in it: a 1 is nobody pulling. Several pads cannot fight, so any number can share two wires: SDA and SCL.`,
      `The pull-up sets the speed: the wire rises as R C and the spec measures 30 % to 70 % (${nf(RISE_30_70, 4)} R C). Rp(max) = t<sub>r</sub> / (${nf(RISE_30_70, 4)} C<sub>b</sub>) for the mode's rise time (1000 ns, 300 ns, 120 ns), Rp(min) = (VDD − ${VOL_MAX} V) / I<sub>OL</sub> for the pad (3, 3, 20 mA). At 3.3 V and 200 pF the window for Fast-mode is ${Math.round(rpMin(FM, 3.3))} Ω to ${Math.round(rpMax(FM, 200e-12))} Ω.`,
      `An I²C frame: START (SDA falls while SCL is high), 7 address bits and R/W, a ninth clock for the ACK (the receiver pulls SDA low), data bytes the same way, STOP (SDA rises while SCL is high). Data change only while SCL is low. A repeated START changes direction without letting the bus go. A target holds SCL low to make the controller wait.`,
      `Arbitration: two controllers that start together send the same bits until they differ; the one that sent a 1 and reads a 0 has lost, lets go of both wires and tries again later. The wire carries the AND of both, which is the winner's bit, so nothing is corrupted. It works only because each controller compares the wire with its own bit as it sends.`,
    ],
    check: [
      {
        question: 'A mode 0 device (CPOL 0, CPHA 0) is wired to a master in mode 1 (CPOL 0, CPHA 1). What goes wrong?',
        options: ['The master changes MOSI on the edge the device samples on: every bit is read half a period early or late', 'Nothing: both idle low and sample on a rising edge', 'Only the clock polarity differs, so the bytes arrive inverted', 'The device cannot be selected'],
        answer: 0,
        explain: 'Both idle low, but mode 0 samples on the first (rising) edge and changes data on the falling one, while mode 1 uses that first rising edge to change the data and samples on the falling edge. The device reads the line at the moment the master is changing it.',
        why: ['', 'The idle level is the same, but the first edge means something different to each end: that is the whole content of CPHA.', 'CPOL is the same here. Inversion would need an inverter on the data, not a different clock phase.', 'Selection is the chip select, which does not depend on the mode.'],
      },
      {
        question: `A 3.3 V I²C bus has 200 pF of wiring and runs Fast-mode (300 ns rise time, 3 mA sink). Which pull-up is legal?`,
        options: [`${Math.round((rpMin(FM, 3.3) + rpMax(FM, 200e-12)) / 2)} Ω`, '100 Ω', '10 kΩ', '4.7 kΩ'],
        answer: 0,
        explain: `Rp must be at least (3.3 − ${VOL_MAX}) / 3 mA = ${Math.round(rpMin(FM, 3.3))} Ω so the pad can hold the wire at ${VOL_MAX} V, and at most 300 ns / (${nf(RISE_30_70, 4)} · 200 pF) = ${Math.round(rpMax(FM, 200e-12))} Ω so it rises in time. ${Math.round((rpMin(FM, 3.3) + rpMax(FM, 200e-12)) / 2)} Ω is inside the window.`,
        why: ['', `A 100 Ω pull-up would make the pad sink ${nf(lowCurrent(100, 3.3) * 1e3, 0)} mA: far over the 3 mA limit, and the low level would not reach ${VOL_MAX} V.`, `10 kΩ rises in ${nf(riseTime(10e3, 200e-12) * 1e9, 0)} ns, over the 300 ns limit.`, `4.7 kΩ gives ${nf(riseTime(4.7e3, 200e-12) * 1e9, 0)} ns, still over 300 ns.`],
      },
      {
        question: `Controllers A and B start together, sending the 7-bit addresses ${hex(ARB_A)} and ${hex(ARB_B)}. Which loses, and in which bit?`,
        options: [`${ARB.loser}, in address bit ${BIT_NAME(ARB.bit)}: it released the wire where the other pulled it low`, 'A, in bit A6: the lower address always loses', 'Both, and they must retry', 'Neither: both frames are corrupted'],
        answer: 0,
        explain: `${hex(ARB_A)} is ${ARB_A.toString(2).padStart(7, '0')} and ${hex(ARB_B)} is ${ARB_B.toString(2).padStart(7, '0')}: they first differ at ${BIT_NAME(ARB.bit)}. ${ARB.loser} sends a 1 (lets go), reads 0 (the other is pulling) and gives up; the other controller reads exactly the bit it sent and goes on. The lower address wins because it pulls low first.`,
        why: ['', 'The first differing bit decides, and it is not A6 here. The lower address does win, but because of the bit where the two first differ.', 'Only the one that reads back a different value than it sent gives up. The winner is unharmed.', 'The wire carries the AND of the two bits, which is the winner\'s bit: no bit is corrupted.'],
      },
    ],
  },
  steps: [
    {
      title: 'Send the clock too',
      body: `
        <p>A UART (<a href="#/c/uart/0">chapter 43</a>) sends data alone and makes the receiver guess when to look: it finds a start bit, counts its own clock and samples each bit in the middle of the period it expects. That costs a start and a stop bit on every character (2 of 10 bits in 8N1), a sampling counter in the receiver, and two oscillators that agree to within a few percent over the length of a frame.</p>
        <p><strong>Send the clock as well.</strong> The sender, which knows when each bit is on the wire, says so on a second wire. The receiver samples on the edge. It needs no clock of its own and guesses nothing, and the framing bits go: a byte is 8 clocks and 8 data bits.</p>
        <p>The price is paid in three places. <em>Wires</em>: SCLK beside the data, and since nothing marks the start of a message, the receiver needs a select line to know when to listen, one more per target. <em>Direction</em>: the clock comes from one end, the controller (the older name for the same role is master), and the other end follows it, so only the controller decides when anything happens. <em>Speed</em>: the limit is no longer oscillator tolerance but the skew between SCLK and the data at the receiver. The data must settle a setup time before the sampling edge and stay a hold time after it (chapter 8), and the two signals come from different drivers over wires of different length, so they arrive a fraction of a period apart. A UART link is tolerant of a few percent in either clock; an SPI link at tens of megahertz needs its two wires matched to a fraction of a nanosecond.</p>
        <p>SPI (<em>serial peripheral interface</em>) has no standard document. It is a convention from the microcontrollers Motorola built in the 1980s, copied everywhere with its details varying, which is why the third step is a table of modes. Four signals: SCLK (clock, from the controller), MOSI (controller out, target in), MISO (controller in, target out) and a chip select per target, active low. Both data wires run at once, so SPI is <em>full duplex</em> by construction: every clock moves one bit each way.</p>`,
      widget: frameCompareWidget,
      challenge: {
        kind: 'quiz',
        question: 'An SPI link between two boards works only at a reduced clock. What is the most likely cause of the limit?',
        options: ['Skew: SCLK and the data reach the receiver at different times and break setup or hold', 'The two ends have oscillators that differ by 2 %', 'The receiver cannot find the start bit', 'There are too few chip selects'],
        answer: 0,
        explain: 'SCLK is generated by the controller and the target has no oscillator to mismatch, and nothing is searched for. What can break is the arrival of the edge against the data it samples: a longer SCLK trace, a slower driver on MISO, a hold violation. A lower clock gives setup more margin.',
        why: ['', 'There is only one oscillator on the link: the controller\'s. The target is clocked by SCLK itself.', 'There is no start bit: the select line and the first clock edge begin the message.', 'The number of selects changes the wiring, not the speed.'],
      },
    },
    {
      title: 'SPI: a ring of shift registers',
      get body() {
        return `
        <p>Inside the <span data-show="master">controller</span> (${N_SPI_MASTER} NANDs) is an 8-bit shift register. Its top bit drives MOSI; its bottom input reads MISO. The <span data-show="mem0 mem1">target</span> has a shift register of its own, wired the other way: its input is MOSI, its top bit is MISO. Together they are a ring of 16 flip-flops with the clock running through both. After 8 clock periods each register holds the other's old byte: the two have <em>exchanged</em> a byte. A write is an exchange in which the controller ignores what comes back; a read is one in which the target ignores what it was sent.</p>
        <p>The scene is a controller and two 256-byte memories (${thin(N_SPI_MEM)} NANDs of storage each, ${thin(N_SPI_DEV)} NANDs of logic) on shared SCLK, MOSI and MISO, and a select each: <code>sel</code> chooses which select follows the controller's CS. The memories speak a subset of the command set of the common 25-series serial EEPROM and flash (real parts also need a write-enable command first and wrap a write within a page): one byte of command (<code>0x03</code> read, <code>0x02</code> write), one of address, then data bytes at the address, address + 1, … for as long as CS stays low. The controller holds CS across the bytes of a transaction (<code>hold</code>); when CS rises, the target abandons what it was doing and its counters reset.</p>
        <p>A read shows the duplex honestly. The controller sends command and address and gets back nothing (the target has not said anything yet); to read a byte it has to send one, usually zero. Reading three bytes is five exchanges, two of them empty on the return path. The target changes MISO on the falling edge so that the bit is steady at the rising edge where the controller samples it: it is a mode 0 device (mode 3 would need the last byte of a write committed when CS rises, as real parts do). One caveat of the drawing: a real target lets MISO float (Z) while its select is high, so that several targets can share the wire; the gate-level simulation here has no Z and ORs the two MISO lines instead. The switch-level version of the idea is the next three steps.</p>
        <p>One byte takes ${SPI_BYTE_CLOCKS} system clocks here: the SCLK edges come every second clock (16 edges, then a tail before CS may rise), so SCLK runs at a quarter of the system clock.</p>
        <div class="try">Press <strong>Write A5 5A 3C at 0x10</strong> with sel = 0, then <strong>Read 3 bytes from 0x10</strong>. Switch sel to 1 and read again: memory 1 returns 0, a different memory.</div>`;
      },
      scene: spiScene,
      tour: {
        label: 'Walk me through a byte',
        beats: [
          { title: 'Idle', reset: true, set: { sel: 0, tx: 0, start: 0, hold: 0 }, cycles: 2, expect: { cs0_n: 1, cs1_n: 1, sclk: 0, busy: 0 },
            say: '<p>Nothing selected: both chip selects are high ({v:cs0_n}, {v:cs1_n}), SCLK idles low ({v:sclk}) and the memories are held in reset by their selects.</p>' },
          { title: 'Start a byte', set: { tx: 0x02, start: 1, hold: 1 }, cycles: 1, expect: { busy: 1, cs0_n: 0, cs1_n: 1 },
            say: '<p>The controller loads <code>0x02</code> (the write command) into its shift register and pulls CS low: <code>cs0_n</code> = {v:cs0_n} for memory 0, while memory 1 still sees {v:cs1_n} and ignores the wires.</p>' },
          { title: 'Eight clocks', set: { start: 0 }, cycles: 18, expect: { busy: 1, cs0_n: 0 },
            say: '<p>Halfway through the byte. SCLK has toggled; each rising edge moves one bit of the command out of the controller\'s register, along MOSI, into memory 0\'s shift register. Each falling edge moves the memory\'s next output bit along MISO.</p>' },
          { title: 'The byte is done', cycles: 20, expect: { busy: 0, cs0_n: 0 },
            say: '<p>The byte is out and one has come back: <code>rx</code> = {v:rx} (the memory had nothing to say yet). CS stays low, because <code>hold</code> is still 1: memory 0 has counted 8 clock edges, taken the command, and waits for an address.</p>' },
          { title: 'CS rises', set: { hold: 0 }, cycles: 2, expect: { cs0_n: 1, cs1_n: 1 },
            say: '<p>Releasing <code>hold</code> raises both selects ({v:cs0_n}): the memory forgets the half-transaction. The next byte it sees will be a command again.</p>' },
        ],
      },
      more: {
        derive: `<p>The controller's registers: <code>busy</code>, a prescaler bit, a 5-bit edge counter (16 edges and a tail), the 8-bit shift register, a MOSI flip-flop, SCLK itself and <code>done</code>. CS is not a flip-flop: it is NOR(busy, hold). SCLK toggles on every second clock while busy; an edge is a <em>sample</em> edge when the counter's low bit equals CPHA, and a change edge when it does not. Samples shift MISO into the bottom of the register; change edges move the top bit to the MOSI flip-flop. That is the entire mode logic: an XNOR and an XOR on one counter bit and CPHA, and a mux for the idle level.</p>`,
        real: `<p>Real SPI peripherals add what this one leaves out: a prescaler register for the clock rate, LSB-first on some parts, word sizes other than 8, a tri-state MISO driver, and in controllers a FIFO and DMA so that a flash page moves without the CPU touching each byte. Serial flash and some ADCs also have dual or quad lanes: the same protocol with two or four data wires per direction.</p>`,
        pitfall: `<p>Treating CS as a data line. It is the framing: the target uses its edges to reset its bit counter. A glitch on CS between bytes aborts a transaction, and a controller that toggles CS after each byte of a multi-byte read gets the first byte again, or nothing.</p>`,
      },
      tries: [(st) => st.value('busy') === 1 || st.value('done') === 1],
      challenge: {
        kind: 'quiz',
        question: 'The controller sends a read command, the address and three dummy bytes. How many bytes of data come back, and how many exchanges were needed?',
        options: ['3 bytes in 5 exchanges: the first two returned bytes carry nothing', '5 bytes in 5 exchanges', '3 bytes in 3 exchanges', '5 bytes in 8 exchanges'],
        answer: 0,
        explain: 'Every exchange returns a byte, but the target starts answering only after it has seen the command and the address. The returns for those two bytes are empty. The three dummy bytes pay for the three data bytes.',
        why: ['', 'Only bytes sent after the address are answered.', 'The command and the address also cost an exchange each; they are sent before the data.', 'A byte is 8 clocks and one exchange: there is no extra step per byte.'],
      },
    },
    {
      title: 'Four modes',
      get body() {
        return `
        <p>Two choices make up an SPI mode. <strong>CPOL</strong> is the idle level of SCLK. <strong>CPHA</strong> says what the first edge after idle does: with CPHA = 0 it <em>samples</em> (the data had to be on the line before the edge, so a target presents bit 7 as soon as CS falls); with CPHA = 1 it <em>changes</em> the data (the first bit appears on the leading edge and is sampled on the second). A byte has 16 edges: 8 sample and 8 change, alternating. A mode is only which of the two comes first and whether the first edge goes up or down.</p>
        <div class="spi-scroll"><table class="spi-table"><thead><tr><th>Mode</th><th>CPOL / CPHA</th><th>SCLK idles</th><th>Samples on</th></tr></thead><tbody>
          ${SPI_MODES.map((m) => `<tr><th scope="row">${modeNumber(m)}</th><td>${m.cpol} / ${m.cpha}</td><td>${m.cpol ? 'high' : 'low'}</td><td>${edgeKind(m, m.cpha === 0 ? 0 : 1).rising ? 'rising' : 'falling'} edge, the ${m.cpha === 0 ? 'first' : 'second'}</td></tr>`).join('')}
        </tbody></table></div>
        <p>The numbering 0 to 3 (mode = 2·CPOL + CPHA) is the common usage. Modes 0 and 3 sample on the rising edge, modes 1 and 2 on the falling edge. Modes 0 and 3 differ only in the idle level, so many parts accept either and cannot tell them apart except by what the clock does between transactions (this book's memory is mode 0 only). The waveforms below are the outputs of the gate-level controller (${N_SPI_MASTER} NANDs) clocked once per system clock, against a peer that changes MISO on the edge the mode says. CPOL costs one mux input (the idle level), CPHA one XNOR and one XOR on the edge counter.</p>
        <p>Mismatched modes are the commonest SPI bug. A device that expects mode 0 on a master in mode 1 samples on the edge where the master has just changed the data: it reads the previous bit's value, or an unsettled one. The bytes come out shifted by one bit or garbled, and a slower clock does not help, because the error is in the edge, not the margin. The mode is a datasheet line next to the clock speed, and a controller usually has a mode register per target.</p>
        <div class="try">Set CPHA = 1 and watch the dashed marks (sampling edges) move from the first edge of each pair to the second, and the data lines shift half a period. Then flip CPOL: SCLK inverts, and nothing about the data moves.</div>`;
      },
      widget: spiModesWidget,
      challenge: {
        kind: 'quiz',
        question: 'A device idles SCLK high and samples on the rising edge. Which mode is it?',
        options: [`Mode ${modeNumber(MODE_HI_RISE)} (CPOL ${MODE_HI_RISE.cpol}, CPHA ${MODE_HI_RISE.cpha})`, 'Mode 0', 'Mode 2', 'Mode 1'],
        answer: 0,
        explain: 'Idling high means CPOL = 1, so the first edge is falling. A device that samples on the rising edge samples on the second one, which is CPHA = 1 (the first edge changes the data): CPOL 1, CPHA 1 is mode 3.',
        why: ['', 'Mode 0 idles low.', 'Mode 2 idles high, but its first edge, falling, samples: it samples on the falling edge.', 'Mode 1 idles low and samples on the falling edge.'],
      },
    },
    {
      title: 'Many devices: select, or chain',
      get body() {
        const dec3 = stats(decoder(3, true)).nands;
        return `
        <p>Four signals are cheap when there is one target. With more, two arrangements. <strong>A select per target</strong>: SCLK, MOSI and MISO shared (a bus), one CS wire each. The controller addresses any one target in one transaction, in any order; a target whose select is high must ignore the clock and let go of MISO. The cost is pins on the controller, or an external 1-of-n decoder to save them: a 3-to-8 decoder with an enable is ${dec3} NANDs in this book, and it adds a gate delay between the controller's address and the select.</p>
        <p><strong>A daisy chain</strong>: one shared CS and the clock, but each device's MISO wired to the next device's MOSI, and the last back to the controller. All the devices form one long shift register of 8n bits. A transaction moves n bytes through, one for each device, and CS rising latches them all at once (LED drivers and shift-register ICs work this way: a shift stage and a latch). The wiring is minimal and the cost is time: to change one device the controller sends all n bytes. It also asks more of each device, which must echo its input eight clocks later, and it is found only on parts designed for it.</p>
        <p>The tri-state output of an unselected device decides whether a shared MISO works at all. Two push-pull outputs on one wire fight when they disagree: a short through an NMOS and a PMOS, as in <a href="#/c/inverter/0">chapter 2</a>. A device that drives MISO only while its CS is low (a tri-state output stage, the pad of <a href="#/c/wire/0">chapter 41</a>) avoids the fight, and a part that forgets to is the classic cause of a bus that works with one device and fails with two. The two wires of the next step avoid the problem differently: nobody drives high at all.</p>
        <div class="try">Slide the number of devices from 1 to 8 and watch the wires and the bytes per update cross over.</div>`;
      },
      widget: spiChainWidget,
      challenge: {
        kind: 'quiz',
        question: 'Four identical devices are daisy-chained. The controller wants to change a register in the second one. How many bytes does the transaction move?',
        options: ['4, one for every device in the chain', '1', '2', '8'],
        answer: 0,
        explain: 'Every device is part of the one shift register. After 4 bytes the byte meant for device 2 has reached it, and the other three hold their own: a no-op for each, or the same value they already had.',
        why: ['', 'One byte would reach only the first device in the chain.', 'Two bytes would leave the last two devices with a partial shift, not their own byte.', 'Each device takes one byte of 8 bits. Eight bytes would go around the chain twice.'],
      },
    },
    {
      title: 'Two wires, any number of devices',
      get body() {
        return `
        <p>I²C (<em>inter-integrated circuit</em>, devised by Philips in 1982; the specification is NXP's UM10204) asks for fewer wires: two, however many devices. With no select line a device has to be addressed in the data. SDA carries the data both ways and SCL the clock, and both are wires that any device may hold low. They need the electrical trick this book has already shown: a wire that several outputs may share because none of them ever drives it high.</p>
        <p>Push-pull outputs (<a href="#/c/inverter/0">chapter 2</a>) do not share. Two of them disagreeing short the supply through an NMOS and a PMOS, and the solver reports it. An <strong>open-drain</strong> output has only the NMOS: it either pulls the wire to ground or lets go. A <strong>pull-up resistor</strong> from the wire to VDD gives the idle level. Now every combination is safe: any number of pads pulling low pull toward the same ground; if none pulls, the resistor wins. The wire is <strong>1 only if every device lets go</strong>, the AND of what the devices say (a <em>wired-AND</em>, built from the transistors of chapter 1 and the resistor of chapter 2 with no gate in the path). A 1 is no one pulling.</p>
        <p>The switch-level solver decides by strength (chapter 2): a transistor is strength 3, a resistor 1. Between a conducting pad and the pull-up the pad wins; with all pads off the resistor's 1 reaches the wire. The pad is ${T_PAD} transistors: the NMOS from the wire to ground, and a two-inverter buffer that reads the wire back, because a device must see what the wire is and not what it asked for. Everything in the next steps depends on that read-back.</p>
        <p>Two prices. <em>Static current</em>: while any device holds the wire low, the pull-up passes (VDD − VOL)/R straight to ground. <em>Speed</em>: the wire rises only as fast as the resistor can charge its capacitance, so a 1 takes far longer than a 0, which a pad drives hard. The next step puts numbers on both.</p>
        <div class="try">Set <code>a</code> = 0 with <code>b</code> = 1: the wire is 0. Then both 0, and open a pad to see the NMOS conduct. Then both 1.</div>`;
      },
      scene: wiredScene,
      tour: {
        label: 'Walk me through the wire',
        beats: [
          { title: 'Both let go', reset: true, set: { a: 1, b: 1 }, show: ['pa', 'pb', 'pu'], expect: { wire: 1 },
            say: '<p>Both stages say 1, which for an open-drain pad means "I am not pulling". Both NMOS are off, nothing connects the wire to ground, and the pull-up carries it to VDD: the wire reads {v:wire}.</p>' },
          { title: 'One pulls', set: { a: 0 }, show: ['pa'], expect: { wire: 0 },
            say: '<p>Stage a says 0: its inverter turns its NMOS on. A conducting transistor (strength 3) beats the resistor (strength 1) and the wire reads {v:wire}, whatever b says. A current (VDD − VOL)/R flows through the resistor and the transistor for as long as it lasts.</p>' },
          { title: 'Both pull', set: { b: 0 }, show: ['pa', 'pb'], expect: { wire: 0 },
            say: '<p>Both stages say 0. Two pull-downs in parallel pull to the same ground: no conflict, no short. The wire reads {v:wire}: the AND of 0 and 0.</p>' },
          { title: 'Only b pulls', set: { a: 1 }, show: ['pb'], expect: { wire: 0 },
            say: '<p>a lets go again; b alone holds the wire low. The wire is the AND of what they say, 1 · 0 = {v:wire}, with no AND gate between them.</p>' },
        ],
      },
      more: {
        derive: `<p>With the NMOS on, the resistor R drops VDD − VOL, where VOL is the transistor's residual drop. The current is (VDD − VOL)/R, and the NMOS must be large enough to sink it at VOL ≤ ${VOL_MAX} V; a wider pad lowers VOL, a bigger R lowers the current. At 3.3 V and 4.7 kΩ that is ${nf((3.3 - VOL_MAX) / 4.7e3 * 1e3, 2)} mA while the line is held low; while it is high, nothing flows, so a bus that is mostly high wastes little.</p>`,
        real: `<p>The same wired-AND is on interrupt lines (many sources, one open-drain INT wire), on reset lines, and on the backplanes of open-collector machines. An I²C pin on a microcontroller is the pad of this step, plus an input filter that rejects spikes shorter than 50 ns in Fast-mode and a Schmitt trigger input (<a href="#/c/clocks/0">chapter 42</a>).</p>`,
        pitfall: `<p>Counting on a microcontroller's internal pull-up. It is typically 20 to 50 kΩ: with 100 pF it rises in about ${nf(riseTime(30e3, 100e-12) * 1e9, 0)} ns, ${nf(riseTime(30e3, 100e-12) / I2C_MODES[0].trMax, 1)} times Standard-mode's budget and ${nf(riseTime(30e3, 100e-12) / FM.trMax, 0)} times Fast-mode's.</p>`,
      },
      tries: [(st) => st.value('wire') === 0],
      challenge: {
        kind: 'reach', goal: 'Make the wire 0 with stage b alone: a lets go, b pulls.',
        check: (st) => st.value('wire') === 0 && st.getInput('a') === 1 && st.getInput('b') === 0,
        hints: ['A stage says 0 to pull the wire low.', 'Leave a at 1 and set b to 0.'],
        answer: 'b = 0 turns b\'s NMOS on; a = 1 leaves a\'s off. The pull-up resistor loses to the one conducting transistor and the wire is 0.',
        solve: (st) => st.setInputs({ a: 1, b: 0 }),
      },
    },
    {
      title: 'What the pull-up costs',
      get body() {
        const closeAt = Math.round((FM.trMax / RISE_30_70) / rpMin(FM, 3.3) * 1e12);
        return `
        <p>A 1 on an open-drain wire is a capacitor charging through a resistor. The bus capacitance C<sub>b</sub> is the wiring plus the pin of every device, tens of picofarads for a board with a few chips; the wire follows V(t) = VDD(1 − e<sup>−t/RC</sup>). The specification measures a rising edge from 30 % to 70 % of VDD, a time of <strong>R C ln(0.7/0.3) = ${nf(RISE_30_70, 4)} R C</strong>.</p>
        <p>That sets one bound on the resistor. Each speed class has a rise-time limit: ${I2C_MODES.map((m) => `${m.name} (${m.fscl / 1e3} kHz) ${Math.round(m.trMax * 1e9)} ns`).join(', ')}. So <strong>R<sub>p</sub>(max) = t<sub>r</sub> / (${nf(RISE_30_70, 4)} C<sub>b</sub>)</strong>: at 100 pF Fast-mode needs a resistor of at most ${Math.round(rpMax(FM, 100e-12))} Ω, Standard-mode, with more than three times the time, allows ${Math.round(rpMax(I2C_MODES[0], 100e-12))} Ω.</p>
        <p>The other bound comes from the pad. While it pulls the wire low it must hold it below VOL = ${VOL_MAX} V against the current (VDD − ${VOL_MAX}) / R the resistor pushes through it, and the spec fixes how much current a pad has to sink: ${I2C_MODES.map((m) => `${m.iol * 1e3} mA`).join(', ')}. So <strong>R<sub>p</sub>(min) = (VDD − ${VOL_MAX} V) / I<sub>OL</sub></strong>: at 3.3 V, ${Math.round(rpMin(FM, 3.3))} Ω for Fast-mode. The two bounds make a window. When the bus is too slow the window closes and no resistor helps: the speed class must drop, or the pads must be stronger. At ${FM.cbMax * 1e12} pF and 3.3 V Fast-mode needs R ≥ ${Math.round(rpMin(FM, 3.3))} Ω and R ≤ ${Math.round(rpMax(FM, FM.cbMax))} Ω, which ${feasible(FM, FM.cbMax, 3.3) ? 'leaves a window' : 'no resistor satisfies'}; Fast-mode Plus, with 20 mA pads, ${feasible(I2C_MODES[2], FM.cbMax, 3.3) ? 'has one' : 'has none'}.</p>
        <p>Compare with a push-pull driver. A CMOS output drives the wire both ways with similar strength, a rise as quick as a fall (<a href="#/c/wire/0">chapter 41</a>), and draws no current when static. The open-drain bus gives up speed and idle-low power to be shareable: a line draws about C V² per cycle for the charge, plus the static current while it is low. That is why the faster I²C classes limit the load or use stronger pads, and why point-to-point links (chapter 46) leave open drain behind.</p>
        <div class="try">Pick Fast-mode at 3.3 V and drag the capacitance up: the window for R closes at ${closeAt} pF. Then switch to Fast-mode Plus.</div>`;
      },
      widget: pullupWidget,
      challenge: {
        kind: 'quiz',
        question: 'A 3.3 V Standard-mode bus (1000 ns rise-time limit, 400 pF maximum) has 300 pF. What is the largest pull-up resistor?',
        options: [`${Math.round(rpMax(I2C_MODES[0], 300e-12))} Ω: t<sub>r</sub> / (0.8473 · 300 pF)`, `${Math.round(I2C_MODES[0].trMax / 300e-12)} Ω: t<sub>r</sub> / C`, `${Math.round(rpMin(I2C_MODES[0], 3.3))} Ω`, 'Any value: it is a logic level'],
        answer: 0,
        explain: `The rise time between 30 % and 70 % of VDD is 0.8473 R C; setting it to 1000 ns with C = 300 pF gives R = ${Math.round(rpMax(I2C_MODES[0], 300e-12))} Ω.`,
        why: ['', 'That would be the time constant RC, not the 30 to 70 % rise time the spec limits.', `${Math.round(rpMin(I2C_MODES[0], 3.3))} Ω is the smallest resistor the pads can sink: the other end of the window.`, 'The resistor sets how fast the wire rises, and the spec limits that.'],
      },
    },
    {
      title: 'The I²C frame',
      get body() {
        return `
        <p>The scene is a <span data-show="c0">controller</span> (${thin(N_I2C_CTL)} NANDs) and a <span data-show="t0">target</span> (${thin(N_I2C_TGT)} NANDs: four 8-bit registers, the address pins, the START and STOP detector), each behind a pad per wire (<span data-show="ps0 pc0">SDA, SCL</span>) onto two rails with <span data-show="pus puc">one pull-up each</span>. Everything is solved at switch level, down to the transistors of every NAND: ${thin(T_BUS)} transistors, and every clock is a full solve of the circuit, so a frame of a few hundred clocks takes a while to run.</p>
        <p>The protocol (older texts call the roles master and slave; UM10204 uses controller and target). Data on SDA change only while SCL is low and are sampled while it is high. The two exceptions are the <strong>START</strong>, SDA falling while SCL is high, and the <strong>STOP</strong>, SDA rising while SCL is high: framing in the data, where SPI used a select wire. After a START the controller sends 9-clock bytes: eight data bits, MSB first, then a ninth clock in which the <em>receiver</em> pulls SDA low to say <strong>ACK</strong>; a 1 on that clock (nobody pulls) is a <strong>NACK</strong>. The first byte is a 7-bit address and the R/W bit (0 write, 1 read); the target that recognizes it ACKs and the rest of the frame belongs to it. In a read the roles swap: the target sends the byte and the controller ACKs it, or NACKs the last byte to say "no more".</p>
        <p>This target is a four-register sensor or tiny EEPROM. A write frame: START, <code>0x50</code> + W, register pointer, data, STOP; the pointer increments after each data byte. A read has to set the pointer first (a write with no data) and then turn the bus around without releasing it: a <strong>repeated START</strong> (a START not preceded by a STOP), <code>0x50</code> + R, then the bytes. The controller here is a byte engine with four commands, START, WRITE, READ and STOP; each bit takes four phases of ${CLOCKS_PER_PHASE} clocks: SCL low and SDA set, SCL released (and waited for until it really reads high), SCL high and SDA sampled, SCL pulled low. A byte is ${I2C_BYTE_CLOCKS} clocks, and a write frame of one data byte ${I2C_FRAME_CLOCKS}.</p>
        <p><strong>Clock stretching.</strong> SCL is open drain too, and the controller reads it back. A target that needs time holds SCL low after the controller has released it; the controller waits in its second phase until SCL reads high, and nothing else changes. Set <code>stretch0</code> (0 to 63) to hold SCL for that many clocks before the first data bit of a read; the first few clocks hide inside the controller's own low phase: the frame takes longer and its content is the same. (SMBus bounds a low SCL at 25 to 35 ms; I²C itself sets no bound, and a stuck target hangs the bus.)</p>
        <div class="try">Press <strong>Write 0xA7 to register 1</strong>, then <strong>Read register 1 back</strong> (the second shows a repeated START, Sr). Set <code>stretch0</code> = 40 and read again.</div>`;
      },
      scene: i2cFrameScene,
      tour: {
        label: 'Walk me through the start of a frame',
        beats: [
          { title: 'Idle bus', reset: true, set: { rst: 1, go0: 0, stretch0: 0 }, cycles: 4, expect: { sda: 1, scl: 1, ready0: 1 },
            say: '<p>Both wires are released and the resistors hold them high: SDA = {v:sda}, SCL = {v:scl}. The circuit was held in reset for four clocks (its flip-flops power up unknown at switch level).</p>' },
          { title: 'START', set: { rst: 0, go0: 1, cmd0: 0, din0: 0 }, cycles: 1, show: ['c0'], expect: { ready0: 0 },
            say: '<p>The controller takes command 0, START. It pulls SCL low for a phase, releases it, then pulls SDA low while SCL is high.</p>' },
          { title: 'SDA falls while SCL is high', set: { go0: 0 }, cycles: 8, expect: { ready0: 1, sda: 0, scl: 0 },
            say: '<p>Done after 8 more clocks: SDA = {v:sda}, SCL = {v:scl}. The target saw SDA fall with SCL high on two consecutive samples and now listens for an address.</p>' },
          { title: 'The address byte', set: { go0: 1, cmd0: 1, din0: 0xa0 }, cycles: 1, expect: { ready0: 0 },
            say: '<p>The controller sends <code>0xA0</code>: the address <code>0x50</code> followed by R/W = 0 (write). Nine bit cells follow, each of four phases of two clocks.</p>' },
          { title: 'Nine bit cells later', set: { go0: 0 }, cycles: 72, expect: { ready0: 1, ack0: 1 },
            say: '<p>The byte is out (<code>ready</code> = {v:ready0}). The ninth clock was the ACK slot: the controller released SDA, the target pulled it low, and the controller read it back through its pad: <code>ack</code> = {v:ack0}. A NACK would read 0.</p>' },
        ],
      },
      more: {
        derive: `<p>The target finds its events from two samples of each wire (this clock and the one before): a rising SCL is "SCL now, not SCL before", a START is SDA high then low with SCL high on both samples. It shares nothing of the controller's phase and recovers the bit boundaries from SCL alone. Its response is late by two clocks (a sample, then a state change), which is why the controller samples SDA at the <em>end</em> of the high phase and not at its start, and why the bit cell is ${CLOCKS_PER_PHASE * 4} clocks.</p>`,
        real: `<p>Real I²C controllers (a microcontroller peripheral, an FPGA core) do the same with a clock divider in place of the fixed phases, the spec's START-hold and STOP-setup times, and a shift register; the byte-level interface with START, WRITE, READ and STOP is how most drivers look. 10-bit addresses use a reserved first byte (<code>11110xx</code>) and a second byte; the addresses <code>0x00</code> to <code>0x07</code> and <code>0x78</code> to <code>0x7F</code> are reserved.</p>`,
        pitfall: `<p>Forgetting the repeated START: a register read needs the pointer set first, and a STOP between the pointer write and the read lets another controller take the bus in between (and some devices lose the pointer). The repeated START keeps the bus.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'During the ninth clock of an address byte the SDA wire stays high. What does that mean?',
        options: ['NACK: no target recognized the address (or it was busy)', 'ACK: the line is idle', 'The controller must send the address again as data', 'The target stretched the clock'],
        answer: 0,
        explain: 'ACK is an active pull-down by the receiver; the idle level is a 1, so silence is a NACK. An address nobody has gets exactly this: the controller reads SDA high on the ninth clock and abandons the frame with a STOP.',
        why: ['', 'ACK is a 0: the receiver pulls the wire down for the ninth clock. A high wire is no one pulling.', 'The frame is lost, not repaired: the controller decides what to do next.', 'Stretching is SCL held low, not SDA high.'],
      },
    },
    {
      title: 'Arbitration: two controllers at once',
      get body() {
        return `
        <p>Several controllers may share the bus (a multi-controller system), and two may start in the same moment. Neither can know the other is there. The wired-AND settles it, and the rule is local: <strong>each controller compares what it sends with what the wire says</strong>. If it sends a 1 (lets go) and the wire reads 0, someone else is pulling; it has lost, lets go of both wires, and waits for the bus to be free. The other controller never noticed anything: when it sent a 0 it read a 0, and the bit on the wire was its own.</p>
        <p>No data is damaged, because the AND of a 1 and a 0 is the winner's 0, and everything the loser did up to then was identical to what the winner did. The winner is the controller whose bits are lowest first: priority is by address, and the lower address, which pulls low sooner, wins. The loser retries after the STOP. The clocks are synchronized the same way: SCL is a wired-AND too, so the slower of two controllers' clocks sets the pace (each waits in its second phase until SCL really reads high).</p>
        <p>The scene is two <span data-show="c0 c1">controllers</span> on the same two wires, both told to send a write frame to different addresses, beginning in the same clock so that their START and first bits coincide. The addresses ${hex(ARB_A)} and ${hex(ARB_B)} first differ at ${BIT_NAME(ARB.bit)}, so ${ARB.loser} loses there. Choose the bit where the two addresses differ and watch what each sends against the wire: the top rows are each controller's own bit, the third is the bus, their AND. In the bit where the loser sends 1 and the bus is 0 it stops. The winner's frame goes on to its end.</p>
        <p>The idea is Ethernet's (<em>look while you talk and notice a collision</em>, chapter 48) with the loss taken out. Ethernet finds a collision after the fact, throws the frame away and backs off for a random time. Here the bits are compared as they are sent, the address is a priority, and the winner continues unharmed. It works only because a bit lasts long enough, on a short bus, for every controller to see the wire before the next edge, and because each sender reads its own bit back.</p>
        <div class="try">Choose <strong>${BIT_NAME(ARB.bit)}</strong> and press <strong>Start both, stop at the loss</strong>. Then <strong>A6</strong>, where controller 0 is the one that loses. Each run takes about a hundred clocks of switch-level solving.</div>`;
      },
      scene: i2cArbScene,
      more: {
        derive: `<p>With a controller sending bit b<sub>i</sub> and the wire w<sub>i</sub> = the AND over all controllers of their b<sub>i</sub>, a controller loses at the first i with b<sub>i</sub> = 1 and w<sub>i</sub> = 0. Two frames that agree up to bit i−1 put the same w on the wire up to there, so both stay in. The winner is the controller whose bit stream is lexicographically smallest: the one with the lowest address (and, for equal addresses, the lowest data).</p>`,
        real: `<p>CAN uses the same idea with its identifier as the priority; SMBus adds a bound on stretching and a clock-low timeout that tells everyone to reset. A multi-controller I²C design must also cope with a controller lost in the middle of a byte to a target (which is left waiting for clocks) and with two controllers whose frames are identical up to a STOP.</p>`,
        pitfall: `<p>Assuming arbitration prevents every conflict. Two controllers whose starts differ by more than a bit do not arbitrate: one sees a START in the middle of its own address and has to give up at once, and a controller that never reads back what it sends corrupts the bus.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'Why does the controller that loses arbitration leave no mark on the winner\'s frame?',
        options: ['The wire is the AND of the bits, so where the two differ it carries the winner\'s 0', 'The loser waits for the winner to finish before it starts', 'The target ignores the loser\'s frame', 'The pull-up resistor filters the loser\'s bit'],
        answer: 0,
        explain: 'Before the first differing bit the two senders put the same bit on the wire. At it, the one that sends 0 pulls the wire low and the other lets go: the wire is the 0, the winner\'s own bit, and it never sees anything unexpected.',
        why: ['', 'Neither waits: they started together. The loser finds out only when its own bit and the wire disagree.', 'The target has nothing to ignore: the wire carried exactly one frame, the winner\'s.', 'A resistor has no memory of who pulled: it is the AND of the transistors that matters.'],
      },
    },
    {
      title: 'Three ways to move a byte',
      get body() {
        return `
        <p>The three links of this track answer the same question differently; the table beside is the comparison, and its costs are measured on the blocks of this chapter. UART, chapter 43: two wires and a ground between two devices, 10 bits on the wire for 8 of data, no address and no clock; the receiver is a counter that samples in the middle of a bit, its cost listed there. SPI and I²C add the sender's clock, in different ways.</p>

        <p>The I²C controller is ${nf(N_I2C_CTL / N_SPI_MASTER, 1)} times the gates of the SPI master, and its target ${nf(N_I2C_TGT / N_SPI_DEV, 1)} times the SPI target's logic. The difference is the framing, the address compare, the START and STOP detection, the ACK handshake and arbitration, all of which SPI gets from a select wire. Each I²C pad costs ${T_PAD} transistors at either end, and the pull-ups, one per wire, cost nothing but the speed and current of the last two steps.</p>
        <p>Pick by what the system needs. A fast device with one target at a time (flash, a display, a radio): SPI. Many slow devices, little board area, a configuration or sensor bus (a temperature sensor, an EEPROM, a power controller, a camera's control port): I²C. Two chips that talk freely at a modest rate: UART. The next chapters are about what happens when the wire gets longer than a few centimetres: modulation (45), serial links at gigabits (46) and surviving errors (47). The idea that data and clock should share one wire so that nothing skews returns there as the <em>embedded clock</em>.</p>`;
      },
      widget: () => throughputWidget({ spiMaster: N_SPI_MASTER, spiTarget: N_SPI_DEV, i2cController: N_I2C_CTL, i2cTarget: N_I2C_TGT, spiClocks: SPI_BYTE_CLOCKS, i2cClocks: I2C_BYTE_CLOCKS }),
      challenge: {
        kind: 'quiz',
        question: 'A board has a temperature sensor, a real-time clock and a small EEPROM, each read a few times a second, and only two spare microcontroller pins. Which link?',
        options: ['I²C: three addressable devices on two wires', 'SPI: three selects and three more pins', 'UART: one device per port', 'None: three devices need three pairs'],
        answer: 0,
        explain: 'Three slow devices at different 7-bit addresses share SDA and SCL. SPI needs SCLK, MOSI, MISO and a select each. A UART talks to one peer.',
        why: ['', 'It needs SCLK, MOSI, MISO and a select each: six pins here.', 'A UART has no addressing: it joins exactly two devices.', 'The point of I²C is that they share the same two wires.'],
      },
    },
  ],
};
