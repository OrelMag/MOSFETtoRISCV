// The fuller texts of the Communication entries of chapters 39-44 (codexcomm.ts): limits, the line, clock crossing, the UART,
// SPI and I²C. Every number is the chapter's own, computed from comm/ and phys/ (tests/content-codexcomm.test.ts pins them
// to the models and to the chapter steps that print them). No DOM.

import type { CodexMore } from './codexmore';
import { numOf } from '../chapters/order';

export const MORE4: Record<string, CodexMore> = {
  shannon: {
    idea: `Two theorems bound every link in this track. <b>Nyquist</b> (1928): a channel of bandwidth B cannot carry more than 2B independent symbols a second; faster and the symbols run into each other. The bit rate is baud × log<sub>2</sub> M for M distinct levels, so more levels raise the rate with no more bandwidth, as long as the receiver can tell them apart. <b>Shannon</b> (1948) puts the noise in: with signal-to-noise power ratio SNR the channel carries at most C = B · log<sub>2</sub>(1 + SNR) bit/s with an error rate as low as you like, given a good enough code, and no more with any code. Setting 2B · log<sub>2</sub> M = C gives M = √(1 + SNR), the number of levels the noise leaves distinguishable.<br><br>The theorem is an existence proof. The distance between a real link and C is the SNR it needs beyond the minimum, and each later chapter spends part of it: QAM adds points until the SNR is used up, coding spends the rest (chapter ${numOf('errors')}). The ultimate floor, for any rate, is E<sub>b</sub>/N<sub>0</sub> = ln 2, −1.59 dB.`,
    example: {
      title: 'A 3100 Hz telephone channel',
      body: `<pre>Nyquist, 2 levels    2B = 6200 symbols/s × 1 bit   =  6.2 kb/s
Nyquist, 16 levels   6200 × 4 bits                 = 24.8 kb/s
Shannon at 30 dB     C = 3100 · log2(1 + 1000)     = 30.9 kb/s
levels the noise leaves   √(1 + 1000)              = 31.6</pre>Sixteen levels need an SNR of 16<sup>2</sup> − 1 = 255 (24.1 dB) before the noise leaves them all distinguishable; below that, Shannon is the lower of the two.`,
    },
    mistakes: [
      `Reading C as the rate of a particular modem: it is a bound, reached only with codes of unbounded length, and an uncoded 256-QAM link sits 9.2 dB above it (chapter ${numOf('modem')}).`,
      'Raising the symbol rate past 2B "with a better receiver": Nyquist is about independent symbols; with a flat noiseless channel you may add levels, not baud.',
      'Quoting SNR in decibels inside the formula: 30 dB is a power ratio of 1000, and log<sub>2</sub>(1 + SNR) uses the ratio.',
    ],
    chapters: [
      { chapter: 'telegraph', step: 4, label: 'Nyquist: symbols a second' },
      { chapter: 'telegraph', step: 5, label: 'Shannon: what noise leaves' },
      { chapter: 'modem', step: 5, label: 'Noise decides how many points' },
      { chapter: 'errors', step: 13, label: 'How far from Shannon' },
    ],
  },
  reflection: {
    idea: `On a board trace the signal cannot be at the far end the moment it leaves the near end: it travels at about 6.67 ps/mm on FR-4, and when the one-way delay exceeds about a sixth of the rise time the trace is a <b>line</b>, not a node. A driver does not see the far pin at first: it sees the line's characteristic impedance Z<sub>0</sub> (50 Ω here) and launches V · Z<sub>0</sub> / (Z<sub>0</sub> + R<sub>s</sub>). Wherever the wave meets an impedance R it leaves a reflected wave Γ times its size, Γ = (R − Z<sub>0</sub>) / (R + Z<sub>0</sub>): +1 at an open end, −1 at a short, 0 matched.<br><br>An open CMOS pin doubles the wave, and a low-impedance driver reflects it again with a negative Γ, so the pin rings: every round trip multiplies the echo by Γ<sub>far</sub> · Γ<sub>driver</sub>, and a receiver clocked while the first overshoot falls back through V<sub>IH</sub> sees extra edges. Fix one end. <b>Series</b> termination makes R<sub>s</sub> + R<sub>driver</sub> = Z<sub>0</sub>: half the swing launches, the open end doubles it, the echo is absorbed at the driver, no DC power, but anything along the trace sees a half-swing step for one round trip, so it suits point-to-point links. <b>Parallel</b> termination puts Z<sub>0</sub> to ground at the far end: no echo and a clean edge for every receiver, at the price of a DC path while the line is high and a lower final level.`,
    example: {
      title: 'A 15 cm trace, 10 Ω driver, 1.8 V swing',
      body: `<pre>launched       1.8 · 50 / (10 + 50)        = 1.50 V
far pin first   2 · 1.50 (open end, Γ = +1) = 3.00 V
Γ at the driver (10 − 50) / (10 + 50)       = −0.67
round trip      2 · 150 mm · 6.67 ps/mm     = 2.00 ns

series, R_s = 40 Ω: launched 1.8 · 50 / 100 = 0.90 V, open end doubles it to 1.80 V, echo absorbed
parallel 50 Ω: no echo; the high level falls to 1.50 V and the line draws 45 mW</pre>`,
    },
    mistakes: [
      'Terminating at the wrong end for the topology: a series resistor at the driver leaves a half-swing step on a stub or a multidrop trace, where only the far end sees the full edge.',
      'Matching with the nominal driver resistance: the output resistance moves with process and supply, so check the smallest series R that keeps the far pin above V<sub>IH</sub> (13 Ω for the chapter\'s trace and edge), not just the nominal sum.',
      'Calling a short trace a line because it is long in millimetres: against a slow enough edge it is a node, and the echoes overlap the edge that made them.',
    ],
    chapters: [
      { chapter: 'wire', step: 4, label: 'Reflections' },
      { chapter: 'wire', step: 5, label: 'Termination' },
      { chapter: 'serial', step: 6, label: 'The eye diagram' },
    ],
  },
  cdc: {
    idea: `Inside one clock domain the contract of the single-clock chapters holds by construction: static timing knows the phase between the launching and the capturing edge. Across two unrelated clocks that phase is whatever it is, so a change will sometimes land inside the receiver's setup/hold window and the flip-flop will go metastable (the <i>Metastability</i> entry has the failure rate). The crossing is therefore designed so that a single bad sample cannot propagate, and what you use depends on what crosses.<br><br><b>A level, one bit:</b> a two-flop synchronizer, 22 NANDs; the first flop may fail, the second samples it a period later; no logic between them and nothing else reads the first. It costs two edges of latency plus up to one for alignment. <b>An event:</b> a pulse may fall between two receiver edges and be lost, so a toggle synchronizer (52 NANDs) turns each pulse into a level change, crosses the level, and finds the change with an XOR; it cannot carry two events closer than a few receiver periods. A handshake removes that rule at the price of two crossings per transfer. <b>A word:</b> never bit by bit. The wires differ in delay, so a sample taken mid-change is the old word with an arbitrary subset of the changing bits flipped. Code the value so that it changes one bit at a time (Gray), or hold it steady behind a handshake, or put a FIFO between the domains.`,
    example: {
      title: 'Why not synchronize each bit of a counter',
      body: `<pre>binary 0111 → 1000: four bits change; any of 16 words can be sampled,
one of them 1111 = 15, seven away from the nearest word ever sent (8)
Gray g = b ⊕ (b ≫ 1):  0111 → 0100,  1000 → 1100:  one bit changes
bin→Gray 4 bits: 12 NANDs (one XOR level);  Gray→bin: 12 NANDs (a chain n − 1 deep)</pre>A sample taken mid-change of a Gray counter is the old value or the new one: a pointer read one step late is a pointer that is one step late, never a value that did not exist.`,
    },
    mistakes: [
      'Synchronizing a multi-bit bus bit by bit: the bits can resolve in different cycles and the receiver reads a value that was never sent.',
      'Passing a one-cycle pulse from a fast domain to a slow one with a plain synchronizer: it can end between two receiver edges. Hold a level for at least three receiver periods, or use the toggle form.',
      'Letting anything but the second flop read the first flop\'s output, or putting logic between the two: both defeat the settling time the structure exists to give.',
    ],
    lib: 'pulse_sync',
    compare: ['sync2'],
    chapters: [
      { chapter: 'clocks', step: 3, label: 'Two clocks are a different problem' },
      { chapter: 'clocks', step: 5, label: 'The two-flop synchronizer' },
      { chapter: 'clocks', step: 6, label: 'Passing one event' },
      { chapter: 'clocks', step: 7, label: 'A bus is not synchronized bit by bit' },
    ],
  },
  asyncfifo: {
    idea: `A FIFO between two clocks is the general answer to "a word has to cross". The memory itself is the data path: words are written at the write pointer on <i>wclk</i> and read through a multiplexer at the read pointer on <i>rclk</i>, so the oldest word is always on <i>rdata</i> and no data bit is ever synchronized. Only the <b>pointers</b> cross. Each side keeps a binary pointer with a lap bit (it addresses the memory) and a registered Gray copy; the Gray pointers cross through 2-flop synchronizers, so a pointer sampled mid-change is the old or the new pointer. <b>empty</b>, on the read side, is the read Gray pointer equal to the synchronized write pointer. <b>full</b>, on the write side, is the write Gray pointer equal to the synchronized read pointer with its top two bits inverted: the write pointer is exactly one lap ahead when that holds, because inverting the top two bits of a Gray code moves it half way round the cycle.<br><br>The synchronized pointer is two edges old, so a word written now is not counted by the read side until it has crossed (empty stays up a little too long), and a freed slot is not seen by the writer (full stays up a little too long). Both errors are conservative: a flag is late, never early, so no read takes an empty slot and no write lands on a full one. Throughput is one word per edge of the slower clock when the FIFO is neither full nor empty.`,
    example: {
      title: 'A 4 × 8 asynchronous FIFO, against the single-clock one',
      body: `<pre>single-clock FIFO, 4 words × 8 bits         757 NANDs
asynchronous FIFO, 4 words × 8 bits         998 NANDs  (+32 %)
  two 3-bit Gray synchronizers, 66 each     132 NANDs
  the rest: two pointers, the Gray logic
a word written on wclk is visible 2 rclk edges later; a freed slot, 2 wclk edges</pre>`,
    },
    mistakes: [
      'Comparing binary pointers across the boundary: a multi-bit binary pointer sampled mid-change can read as a value far from either; only the Gray copy may cross.',
      'Making the FIFO the exact depth the traffic needs: the pointer latency (two edges each way) shrinks the usable depth, so the flags go up before the memory is really full or empty.',
      'Taking <i>rdata</i> without the flag: when empty is up the word on <i>rdata</i> is stale, and the late flag means a word can be present before empty falls.',
    ],
    lib: 'afifo4x8',
    chapters: [
      { chapter: 'clocks', step: 7, label: 'A bus is not synchronized bit by bit' },
      { chapter: 'clocks', step: 8, label: 'An asynchronous FIFO' },
    ],
  },
  uart: {
    idea: `Two machines, one wire each way, and two clocks with no relation. A byte can still cross if the sender wraps it in a <b>frame</b> that gives the receiver one thing to align to. The line idles at 1; a <b>start bit</b> of 0 begins the frame (an unambiguous falling edge), eight data bits follow <b>least significant first</b> (a receiver shifting right ends with the byte in place), and a <b>stop bit</b> of 1 returns the line to idle and doubles as the check: a 0 where the stop should be is a <i>framing error</i>. The teleprinter of chapter 40 framed five-bit characters the same way and kept time with a cam where a UART uses a counter.<br><br>The transmitter is a 10-bit shift register loaded with {1, data, 0} and a tick counter; its output is registered, so it cannot glitch. The receiver synchronizes <i>rx</i> into its own clock, waits for a low sample, looks again 8 of the 16 ticks later (still low: a real start bit; high: a glitch, back to idle), then samples every 16 ticks, and reports the byte or a framing error at the stop sample. A sample drifts from mid-bit in proportion to the bits since the start edge, so the stop sample, the furthest, sets the limit: ±5.56 % for a continuous clock, and on the gates 5.55 % slower or 5.0 % faster, which is why the tolerance is a few percent where a clocked link needs parts per million. The baud rate is clock / (16 · divisor) with an integer divisor, which cannot hit every rate. A FIFO each way turns "one byte time to take each byte" into an average.`,
    example: {
      title: 'Baud rates, from the divider and the frame',
      body: `<pre>clock 1.8432 MHz = 16 × 115 200            divisor 1: exact
clock 50 MHz, divisor 27: 50e6 / (16 · 27)   = 115 741 baud, 0.47 % high
one bit at 115 200 baud                      = 8.68 µs; one byte = 86.8 µs
8N1: 8 data bits in 10 bit times             = 80 %
receiver 526 NANDs; 16-byte FIFO 2 803 NANDs = 77 % of the 7 307-NAND core</pre>The gates, searched at divisors 1 and 4, accept a sender 5.55 % slower and 4.9 % faster than the receiver.`,
    },
    mistakes: [
      'Configuring the two ends at the "same" baud from different clocks without checking the divisor error: 0.47 % is fine, but a 12 MHz clock at its nearest divisor (7) is 7.0 % slow, past what the sampling tolerates against a sender that is exact.',
      'Treating a framing error as line noise only: it is also what a wrong baud rate, a wrong frame format, and a break (a line held low longer than a frame) look like.',
      'Relying on one receive register at high baud: the CPU gets one byte time (86.8 µs at 115 200, 3.3 µs at 3 Mbaud) to take each byte, whatever else is running; the FIFO and its trigger level exist for this.',
    ],
    lib: 'uart_tx',
    compare: ['uart_rx'],
    chapters: [
      { chapter: 'telegraph', step: 3, label: 'Morse against Baudot' },
      { chapter: 'exchange', step: 7, label: 'Start-stop' },
      { chapter: 'uart', step: 0, label: 'One byte, no clock' },
      { chapter: 'uart', step: 2, label: 'The baud generator' },
      { chapter: 'uart', step: 3, label: 'Sampling in the middle' },
      { chapter: 'uart', step: 4, label: 'Errors: framing, false start, break, overrun' },
    ],
  },
  spi: {
    idea: `A UART sends data alone and makes the receiver guess when to look. SPI sends the clock too: the sender knows when each bit is on the wire and says so on a second wire, so the receiver samples on the edge, needs no clock of its own, and the start and stop bits disappear. The price is wires (SCLK beside the data, and a select line per target, because nothing marks the start of a message), and fixed roles: the <b>controller</b> makes the clock.<br><br>The controller holds an 8-bit shift register whose top bit drives <b>MOSI</b> and whose bottom reads <b>MISO</b>; the target holds one wired the other way. Together they are a ring of 16 flip-flops with the clock through both: after 8 periods each holds the other's old byte. Every transfer is an exchange; a write ignores what comes back and a read sends a byte, usually zero, to get one. The <b>mode</b> is two choices: CPOL, the idle level of SCLK, and CPHA, whether the first edge after idle samples (0) or changes the data (1). A byte has 16 edges, 8 sample and 8 change, alternating; mode = 2 · CPOL + CPHA, and modes 0 and 3 sample on the rising edge. Several targets are a select each on a shared bus (a target whose select is high lets go of MISO) or a daisy chain, where the devices form one 8n-bit shift register and the rising select latches all of them.`,
    example: {
      title: 'The four modes, and the cost of the controller',
      body: `<pre>mode  CPOL CPHA  idle  first edge  samples on
 0     0    0    low   rising      rising edge
 1     0    1    low   rising      falling edge
 2     1    0    high  falling     falling edge
 3     1    1    high  falling     rising edge</pre>The controller is 397 NANDs; CPOL costs one multiplexer input and CPHA one XNOR and one XOR on the edge counter. In the chapter's controller one byte takes 34 system clocks, SCLK at a quarter of the system clock. A read of three bytes from a 25-series memory is five exchanges: command, address, three data bytes, the first two returning nothing.`,
    },
    mistakes: [
      'Mismatched modes, the commonest SPI bug: a device that expects mode 0 on a controller in mode 1 samples just where the controller changes the data, so the bytes come out shifted by a bit or garbled, and a slower clock does not help because the error is in the edge, not the margin.',
      'Leaving MISO driven when the select is high: with several targets on one bus a target must let go (Z); the chapter\'s gate-level simulation has no Z and ORs the lines instead.',
      'Forgetting that every transfer exchanges: a read needs the controller to clock out something, and a daisy chain returns the bytes of n devices in the order they were shifted.',
    ],
    lib: 'spi_master',
    chapters: [
      { chapter: 'spi', step: 0, label: 'Send the clock too' },
      { chapter: 'spi', step: 1, label: 'SPI: a ring of shift registers' },
      { chapter: 'spi', step: 2, label: 'Four modes' },
      { chapter: 'spi', step: 3, label: 'Many devices: select, or chain' },
    ],
  },
  i2c: {
    idea: `Two wires however many devices, so no select line: a device is addressed in the data. SDA carries data both ways and SCL the clock, and both are wires any device may hold low. Push-pull outputs do not share a wire (two that disagree short the supply through an NMOS and a PMOS), so the pads are <b>open-drain</b>: an NMOS to ground and nothing to the supply, with one pull-up resistor per wire for the idle level. Any number of pads pulling low pull toward the same ground; if none pulls, the resistor wins. The wire is 1 only if every device lets go, the AND of what they say (a <i>wired-AND</i>), and each pad reads the wire back, because a device must see what the wire is and not what it asked for.<br><br>Data on SDA change only while SCL is low and are sampled while it is high; the two exceptions frame the transfer: <b>START</b> is SDA falling while SCL is high, <b>STOP</b> SDA rising while SCL is high. After a START the controller sends 9-clock bytes, eight bits most significant first and a ninth in which the receiver pulls SDA low to say <b>ACK</b>. <b>Arbitration</b> comes free of the wired-AND: each controller compares what it sends with what the wire reads, and one that sends a 1 where the wire reads 0 has lost, lets go of both wires and retries after the STOP. The winner never noticed and no data is damaged; the lower address wins. SCL is a wired-AND too, so the slowest controller sets the pace.<br><br>A 1 is a capacitor charging through a resistor, so the pull-up has two bounds. Fast: the rise time from 30 % to 70 % of V<sub>DD</sub> is 0.8473 · R · C<sub>b</sub>, so R<sub>p</sub> ≤ t<sub>r</sub> / (0.8473 · C<sub>b</sub>). Strong: while a pad holds the wire low, the resistor pushes (V<sub>DD</sub> − V<sub>OL</sub>) / R through it, and the specification fixes the current a pad must sink, so R<sub>p</sub> ≥ (V<sub>DD</sub> − 0.4 V) / I<sub>OL</sub>. When the bounds cross, no resistor works: the speed class must drop or the pads must be stronger.`,
    example: {
      title: 'The pull-up window at 3.3 V',
      body: `<pre>C_b = 100 pF, Fast-mode  (t_r ≤ 300 ns):   R_p ≤ 300 ns / (0.8473 · 100 pF) = 3541 Ω
C_b = 100 pF, Standard    (t_r ≤ 1000 ns):  R_p ≤ 11802 Ω
Fast-mode, I_OL = 3 mA:                     R_p ≥ (3.3 − 0.4) V / 3 mA      =  967 Ω
C_b = 400 pF, Fast-mode:                    R_p ≤ 885 Ω  &lt;  967 Ω: no resistor works
the window closes at 300 ns / (0.8473 · 967 Ω) = 366 pF</pre>Fast-mode Plus, with 20 mA pads, has a window at 400 pF. The chapter's controller is 659 NANDs, the target (four registers, address pins, START/STOP detector) 1 638, and a pad 5 transistors.`,
    },
    mistakes: [
      'Sizing the pull-up for speed only: a resistor small enough for the rise time can exceed what the pads must sink, and the wire never reaches V<sub>OL</sub>.',
      'Driving a 1 push-pull "to be faster": a second device holding the wire low then shorts the supply; on this bus a 1 is letting go.',
      'Expecting arbitration to lose data: the loser stops at the first bit where it sent 1 and read 0, and everything it sent before was identical to what the winner sent. It must retry the whole frame after the STOP.',
    ],
    lib: 'i2c_pad',
    chapters: [
      { chapter: 'spi', step: 4, label: 'Two wires, any number of devices' },
      { chapter: 'spi', step: 5, label: 'What the pull-up costs' },
      { chapter: 'spi', step: 6, label: 'The I²C frame' },
      { chapter: 'spi', step: 7, label: 'Arbitration: two controllers at once' },
    ],
  },
};
