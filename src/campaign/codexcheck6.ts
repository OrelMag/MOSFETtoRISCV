// Check yourself questions for the entries of codexmore4.ts (see codexcheck.ts), group 6: Communication, chapters 39-44. Answers
// first: the quiz shuffles the options (ui/quiz.ts shuffleOrder). Numbers pinned by tests/content-codexcomm.test.ts. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK6: Record<string, Quiz[]> = {
  shannon: [
    {
      question: 'A voice channel is 3100 Hz wide with a 30 dB signal-to-noise ratio. What is the most it can carry with errors as rare as you like?',
      options: ['About 30.9 kb/s: B · log₂(1 + 1000)', 'About 6.2 kb/s: two symbols a hertz', 'About 93 kb/s: 30 bits a hertz', 'About 3.1 kb/s: one bit a hertz'],
      answer: 0,
      explain: 'Shannon: C = B · log₂(1 + SNR), with the SNR as a power ratio (30 dB is 1000). Nyquist alone says 6200 symbols a second, and the noise leaves √1001 = 31.6 levels of them distinguishable.',
      why: ['', 'That is Nyquist\'s symbol rate with two levels: it ignores that the noise would allow more levels.', 'Multiplying by the dB figure is not the formula: the SNR enters through its logarithm.', 'One bit a hertz is a spectral efficiency this channel beats nearly tenfold.'],
    },
    {
      question: 'Nyquist allows 2B symbols a second whatever the number of levels. Why not carry 1024 levels on the voice channel at 30 dB?',
      options: ['The noise leaves only √(1 + SNR) ≈ 31.6 levels distinguishable', 'Nyquist forbids more than 16 levels', 'More levels need more bandwidth, 2B each', 'A receiver cannot count that many'],
      answer: 0,
      explain: 'Setting 2B · log₂ M = B · log₂(1 + SNR) gives M = √(1 + SNR). More levels than that sit inside the noise, and the symbol error rate climbs.',
      why: ['', 'Nyquist bounds the symbol rate, not the number of levels.', 'Levels add no bandwidth; the symbol rate sets the bandwidth.', 'Counting is easy; telling adjacent levels apart through noise is not.'],
    },
  ],
  reflection: [
    {
      question: 'A 10 Ω driver with a 1.8 V swing drives a 50 Ω trace into an open CMOS pin. What does the pin see first?',
      options: ['3.00 V: 1.50 V is launched and an open end reflects with Γ = +1', '1.50 V: the launched wave', '1.80 V: the driver\'s swing', '0.90 V: half the swing'],
      answer: 0,
      explain: 'The driver and Z₀ divide the swing: 1.8 · 50 / 60 = 1.50 V. An open end has Γ = +1, so the incident and the reflected wave add: 3.00 V, above the final level until the echo returns.',
      why: ['', 'That is the wave on the line before it reaches the pin; the open pin doubles it.', 'The line is not yet at the driver\'s final level when the first wave arrives; that comes after the echoes settle.', 'Half the swing is what a series-terminated driver launches (R_s + R_driver = Z₀), not this one.'],
    },
    {
      question: 'Why does series termination choose R_s so that R_s + R_driver = Z₀?',
      options: ['The echo coming back then meets Z₀ at the driver (Γ = 0) and is absorbed', 'It halves the DC power of the line', 'It makes the far end look matched', 'It removes the need for any wave to travel'],
      answer: 0,
      explain: 'The far end is open and doubles the half-swing wave to the full swing; the echo reaches the driver, sees an impedance equal to the line\'s and does not reflect again. No DC current flows, but anything along the trace sees the half-swing step for a round trip.',
      why: ['', 'A series resistor in a line into an open end draws no DC power at all; halving is not its job.', 'The far end stays open: the doubling there is what completes the swing.', 'The wave still travels at about 6.67 ps/mm; termination only stops the echoes.'],
    },
  ],
  cdc: [
    {
      question: 'A 4-bit binary counter goes from 0111 to 1000 and each bit crosses to another clock through its own two-flop synchronizer. What can the receiver read?',
      options: ['Any of 16 words, including 1111, which the sender never sent', 'Only 0111 or 1000', 'Only 0111, 1000 or 0000', 'Nothing: the synchronizers hold the old value'],
      answer: 0,
      explain: 'Four bits change at once; each synchronized bit may take the old or new value, so any combination is possible. Gray coding makes a count change one bit at a time, so a mid-change sample is the old or the new value.',
      why: ['', 'That would need all the bits to resolve in the same cycle, which nothing guarantees across unrelated clocks.', 'Zero is not the result of any mixture of the old and new bits here.', 'Each synchronizer passes its bit on within a cycle or two; none holds back.'],
    },
    {
      question: 'A one-cycle pulse on a fast clock A must reach a clock B three times slower. Why does a plain two-flop synchronizer lose it, and what fixes that?',
      options: ['The pulse can end between two B edges; a toggle synchronizer turns each pulse into a level change', 'The synchronizer\'s flip-flops are too slow; use a faster flop', 'The pulse is too wide; shorten it', 'Metastability corrupts every pulse'],
      answer: 0,
      explain: 'A pulse shorter than the receiver\'s period may fall entirely between edges. Toggling a flip-flop on each pulse makes a level that stays changed until the next pulse; the receiver crosses the level and detects the change with an XOR (52 NANDs). Alternatively hold a level for three B periods.',
      why: ['', 'Speed of the flop is not the issue: the pulse is simply never sampled.', 'A shorter pulse is even more likely to fall between edges.', 'Metastability is a rare event the second flop absorbs; the lost pulse happens with perfectly healthy flops.'],
    },
  ],
  asyncfifo: [
    {
      question: 'Why does an asynchronous FIFO send Gray-coded pointers through its synchronizers rather than binary ones?',
      options: ['Only one bit changes per step, so a sample taken mid-change is the old pointer or the new one', 'Gray code needs fewer flip-flops', 'Binary pointers cannot address memory', 'It makes the pointers settle faster'],
      answer: 0,
      explain: 'A binary pointer going 0111 → 1000 changes four bits, and a sample taken mid-change can be any word. A Gray pointer sampled late is a pointer that is one step late, and the flags built from it are conservative.',
      why: ['', 'Gray and binary pointers have the same width.', 'The binary pointer is what addresses the memory; the Gray copy is only for crossing.', 'Neither code settles faster; the benefit is in what a wrong sample can be.'],
    },
    {
      question: 'The synchronized pointer is two edges old. What does that do to the empty and full flags?',
      options: ['Each stays up a little too long: late, never early, so no read hits an empty slot and no write a full one', 'Each falls early, and words can be lost', 'Nothing: the flags are computed before the crossing', 'The FIFO needs a handshake for each word'],
      answer: 0,
      explain: 'A word written now is not counted by the read side until it has crossed, so empty is late to fall; a slot freed now is not seen by the writer, so full is late to fall. Both errors only cost throughput, never correctness.',
      why: ['', 'Early flags would let a read take an empty slot; the delay of the pointers makes them late instead.', 'empty is computed on the read side from the synchronized write pointer, so the crossing delay does reach it.', 'The pointers cross continuously; the data itself never crosses a synchronizer.'],
    },
  ],
  uart: [
    {
      question: 'What are the two jobs of a UART\'s stop bit?',
      options: ['It returns the line to idle 1 so the next start is a falling edge, and it is the receiver\'s check (0 = framing error)', 'It carries parity and marks the byte boundary', 'It synchronizes the baud generators of the two ends', 'It tells the receiver how many data bits follow'],
      answer: 0,
      explain: 'The idle line is 1 and the start bit is 0, so the line must be 1 again before another start edge can be seen. A 0 at the stop sample means the sampling went wrong: a framing error, the usual sign of a wrong baud rate.',
      why: ['', 'Parity, when used, is its own bit before the stop; the stop bit carries no data.', 'Synchronization is done by the start edge on every frame, not by the stop bit.', 'The frame format is agreed in advance; nothing in the frame announces its length.'],
    },
    {
      question: 'A UART divides a 50 MHz clock by 27 with a 16× oversampling tick. What baud rate does it run?',
      options: ['115 741 baud, 0.47 % above 115 200', '115 200 baud exactly', '1 851 852 baud', '231 481 baud'],
      answer: 0,
      explain: 'baud = clock / (16 · divisor) = 50 000 000 / 432 = 115 740.7. An integer divisor cannot hit every rate; 0.47 % is well inside the roughly ±5 % a receiver tolerates.',
      why: ['', 'An integer divisor of 27 cannot give exactly 115 200; the nearest is 0.47 % high.', 'That omits the 16 ticks per bit: 50 MHz / 27.', 'That divides by 8 ticks a bit instead of 16.'],
    },
  ],
  spi: [
    {
      question: 'After 8 SCLK periods of a transfer between an SPI controller and a target, what do their two 8-bit shift registers hold?',
      options: ['Each holds the other\'s old byte', 'Both hold the controller\'s byte', 'Each holds its own byte unchanged', 'The target holds the controller\'s byte and the controller holds zeros'],
      answer: 0,
      explain: 'The registers are wired in a ring: MOSI from the controller\'s top bit to the target\'s input, MISO from the target\'s top bit back. Eight clocks rotate a full byte each way, so every transfer is an exchange; a write ignores what returns.',
      why: ['', 'The target\'s byte also travels: MISO carries it to the controller.', 'Every clock shifts both registers; none keeps its contents.', 'The controller receives whatever the target shifted out, which is not necessarily zero.'],
    },
    {
      question: 'Which SPI mode idles SCLK high and samples on the rising edge?',
      options: ['Mode 3 (CPOL = 1, CPHA = 1)', 'Mode 0 (CPOL = 0, CPHA = 0)', 'Mode 1 (CPOL = 0, CPHA = 1)', 'Mode 2 (CPOL = 1, CPHA = 0)'],
      answer: 0,
      explain: 'CPOL = 1 idles high, so the first edge is falling; CPHA = 1 makes that first edge change the data, and the second (rising) edge samples it. Modes 0 and 3 sample on the rising edge and differ only in the idle level.',
      why: ['', 'Mode 0 idles low and samples on the first, rising edge.', 'Mode 1 idles low and samples on the falling edge.', 'Mode 2 idles high but samples on the first edge, which is falling.'],
    },
  ],
  i2c: [
    {
      question: 'An I²C bus of 100 pF must meet Fast-mode\'s 300 ns rise time (30 % to 70 %). What is the largest pull-up resistor?',
      options: ['About 3541 Ω: 300 ns / (0.8473 · 100 pF)', 'About 11802 Ω', 'About 967 Ω', 'About 885 Ω'],
      answer: 0,
      explain: 'A rising edge on an open-drain wire is an RC charge; its 30 % to 70 % time is R · C · ln(0.7/0.3) = 0.8473 R C, so R ≤ t_r / (0.8473 C_b).',
      why: ['', 'That is the same bound for Standard-mode\'s 1000 ns, more than three times the time.', 'That is the lower bound at 3.3 V and 3 mA: (3.3 − 0.4) V / 3 mA, set by what the pad can sink.', 'That is the upper bound for Fast-mode at 400 pF, not 100 pF.'],
    },
    {
      question: 'Two I²C controllers start a frame together. At one address bit controller A sends 1 (lets go) while B sends 0. What happens?',
      options: ['A reads 0 on the wire, has lost, lets go and retries after the STOP; B continues undamaged', 'Both frames are corrupted and both retry', 'B detects the collision and aborts', 'The bus locks up until a timeout'],
      answer: 0,
      explain: 'The wire is the AND of what the controllers send. B sent a 0 and read 0, so it never noticed; A sent a 1 and read 0, so someone else is pulling and it backs off. Everything A sent before was identical to B\'s bits, so no data was damaged.',
      why: ['', 'The AND of a 1 and a 0 is exactly the 0 B sent: B\'s frame is intact.', 'B read what it sent, so it sees no difference and goes on.', 'The loser releases both wires at once, so the bus is free for the winner.'],
    },
  ],
};
